/**
 * SerialCLI - A class for communicating with devices via Web Serial API
 * Handles sending commands, receiving responses, and parsing multi-line data
 */

let serialAPI;
if(/Android/i.test(navigator.userAgent) && 'usb' in navigator) {
  const serialImport = await import("/lib/polyfill/serial.js");
  console.log("android phone with webusb")
  serialAPI = serialImport.serial;
}
else {
  serialAPI = navigator.serial;
}

export class SerialCLI {
  constructor(debug = false) { // Added debug parameter
    this.port = null;
    this.reader = null;
    this.writer = null;
    this.readBuffer = "";
    this.isReading = false;
    this.commandQueue = [];
    this.currentCommand = null;
    this.decoder = new TextDecoder();
    this.encoder = new TextEncoder();
    this.responseTimeout = 5000; // 5 seconds timeout for responses
    this.commandDelay = 100; // 100ms delay between commands
    this.debug = debug; // Initialize debug mode
  }

  /**
   * Enable or disable debug logging
   * @param {boolean} enabled - True to enable debug mode, false to disable
   */
  setDebug(enabled) {
    this.debug = enabled;
    if (this.debug) {
      console.log("SerialCLI Debug Mode Enabled");
    } else {
      console.log("SerialCLI Debug Mode Disabled");
    }
  }

  /**
   * Connect to a serial device
   * @param {number} baudRate - Baud rate to use (default: 115200)
   * @returns {Promise<boolean>} True if connected, false otherwise
   */
  async connect(baudRate = 115200) {
    if (!('serial' in navigator)) {
      console.error('Web Serial API not supported in this browser');
      return false;
    }

    try {
      this.port = await serialAPI.requestPort();
      await this.port.open({ baudRate });

      this.reader = this.port.readable.getReader();
      this.writer = this.port.writable.getWriter();

      if (this.debug) {
        console.log(`SerialCLI: Connected to port, baud rate ${baudRate}`);
      }

      this.startReading();
      return true; // Indicate successful connection
    } catch (error) {
      console.error("SerialCLI: Failed to connect", error);
      this.port = null; // Reset port on failure
      return false; // Indicate failed connection
    }
  }

  /**
   * Disconnect from the serial device
   */
  async disconnect() {
    if (this.reader) {
      try {
        this.isReading = false;
        await this.reader.cancel();
        // releaseLock() is handled implicitly by cancel() or closing the port
      } catch (error) {
        if (this.debug) console.error("SerialCLI: Error cancelling reader", error);
      } finally {
        this.reader = null;
      }
    }

    if (this.writer) {
        try {
            // Ensure writer is closed before releasing lock
            if (!this.writer.closed) {
                await this.writer.close();
            }
        } catch (error) {
            if (this.debug) console.error("SerialCLI: Error closing writer", error);
        } finally {
            try {
                this.writer.releaseLock();
            } catch(lockError) {
                // Ignore error if lock was already released
            }
            this.writer = null;
        }
    }


    if (this.port) {
      try {
        await this.port.close();
        if (this.debug) console.log("SerialCLI: Port closed");
      } catch (error) {
        if (this.debug) console.error("SerialCLI: Error closing port", error);
      } finally {
        this.port = null;
      }
    }
  }

  /**
   * Start reading data from the serial port
   * @private
   */
  startReading() {
    if (!this.reader) return;

    this.isReading = true;
    this.readLoop();
    if (this.debug) console.log("SerialCLI: Started reading loop");
  }

  /**
   * Main read loop for serial data
   * @private
   */
  async readLoop() {
    while (this.isReading && this.reader) {
      try {
        const { value, done } = await this.reader.read();
        if (done) {
          // Allow the serial port to be closed later.
          this.reader.releaseLock();
          if (this.debug) console.log("SerialCLI: Reader stream closed");
          break;
        }

        const textChunk = this.decoder.decode(value, { stream: true }); // Use stream option for potentially multi-byte chars split across chunks
        if (this.debug) {
          console.log("SerialCLI <<< RECV:", JSON.stringify(textChunk)); // Log received data
        }
        this.processIncomingData(textChunk);

      } catch (error) {
        console.error("SerialCLI: Error in read loop:", error);
        this.isReading = false; // Stop reading on error
        try {
          this.reader.releaseLock();
        } catch (lockError) {
           // Ignore lock release error if already released
        }
        this.reader = null;
        // Consider attempting to reconnect or notify the user
        break;
      }
    }

    // Redundant check, but safe
    if (this.isReading && this.port?.readable && !this.reader) {
        try {
          this.reader = this.port.readable.getReader();
          this.readLoop(); // Restart loop if needed and possible
          if (this.debug) console.log("SerialCLI: Restarted reading loop after temporary reader release");
        } catch(err) {
            console.error("SerialCLI: Failed to re-acquire reader", err);
            this.isReading = false;
        }
    } else if (!this.isReading && this.debug) {
         console.log("SerialCLI: Reading loop stopped.");
    }
  }

  /**
   * Process incoming data from the serial port
   * @param {string} data - The data received from the serial port
   * @private
   */
  processIncomingData(data) {
    this.readBuffer += data;
    if (this.debug) console.log("SerialCLI: Buffer:", JSON.stringify(this.readBuffer));

    // Check if we're waiting for a response
    if (this.currentCommand) {
      this.checkForResponse();
    } else if (this.commandQueue.length > 0) {
      // If no current command but queue has items, try to execute next command
      // This should ideally only happen after a response is fully processed
      // or if the device sends unsolicited data.
       if (this.debug) console.log("SerialCLI: Received data while idle, buffer:", JSON.stringify(this.readBuffer));
       // Let's not automatically execute next command here, wait for command completion logic
    }
  }

  /**
   * Check if a complete response has been received
   * @private
   */
  checkForResponse() {
    if (!this.currentCommand) return;

    // Some commands (e.g. "get acl", "region load") print straight to the serial
    // port without the "  -> " reply marker, so there is nothing to match on.
    // For those we collect whatever arrives until the device goes quiet.
    if (this.currentCommand.mode === 'collect') {
      this.scheduleCollectFlush();
      return;
    }

    // --- Refined Response Parsing Logic ---
    // A typical interaction looks like:
    // 1. Send command: `my_command\r`
    // 2. Device echoes: `my_command\r\n` (optional, depends on device)
    // 3. Device processes and sends response: `  -> OK\r\n` or multi-line for log
    // We need to find the "->" marker *after* the potential echo.

    const { command, isLogCommand } = this.currentCommand;
    const commandWithCR = command + '\r'; // Command as sent
    const commandWithCRLF = command + '\r\n'; // Potential echo format

    // Find the end of the command echo (could be with or without \n)
    let echoEndIndex = this.readBuffer.indexOf(commandWithCRLF);
    if (echoEndIndex !== -1) {
      echoEndIndex += commandWithCRLF.length;
    } else {
      echoEndIndex = this.readBuffer.indexOf(commandWithCR);
      if (echoEndIndex !== -1) {
        echoEndIndex += commandWithCR.length;
      } else {
         // Command echo might not have arrived fully yet, or device doesn't echo
         // Let's proceed cautiously, but this might lead to issues if echo is partial
         echoEndIndex = 0; // Assume start of buffer if no echo found yet
         if (this.debug) console.log("SerialCLI: Command echo not found yet or device doesn't echo.");
      }
    }


    // Look for the response marker "->" *after* the potential echo
    const responseMarker = "  -> ";
    const responseStartIndex = this.readBuffer.indexOf(responseMarker, echoEndIndex);

    if (responseStartIndex === -1) {
      if (this.debug) console.log("SerialCLI: Response marker '->' not found after echo index", echoEndIndex);
      return; // Response marker not found yet
    }

    const responsePayloadStartIndex = responseStartIndex + responseMarker.length;

    // Find the end of the response (\r\n)
    // Search *after* the start of the response payload
    const newlineIndex = this.readBuffer.indexOf('\r\n', responsePayloadStartIndex);

    if (newlineIndex === -1) {
        if (this.debug) console.log("SerialCLI: Response newline not found after payload start index", responsePayloadStartIndex);
        return; // Full response line hasn't arrived
    }

    // Extract the response content
    const responseLine = this.readBuffer.substring(responsePayloadStartIndex, newlineIndex).trim();
    const consumedUntilIndex = newlineIndex + 2; // Include the \r\n

    if (this.debug) console.log(`SerialCLI: Found response line: "${responseLine}"`);

    // Special handling for log command which has multi-line response ending with EOF
    if (isLogCommand) {
        // For log, the first line might just be the confirmation, e.g., "-> OK" or similar.
        // The actual log data follows, ending with "   EOF\r\n"
        const eofMarker = "   EOF";
        // Look for EOF *after* the initial response line we just found
        const eofIndex = this.readBuffer.indexOf(eofMarker, consumedUntilIndex);

        if (eofIndex !== -1) {
            const eofNewlineIndex = this.readBuffer.indexOf('\r\n', eofIndex);
            if (eofNewlineIndex !== -1) {
                // Extract the log data between the first response line and the EOF marker
                const logData = this.readBuffer.substring(consumedUntilIndex, eofIndex).trim();
                const finalConsumedIndex = eofNewlineIndex + 2;
                if (this.debug) console.log(`SerialCLI: Log EOF found. Log data length: ${logData.length}`);

                this.readBuffer = this.readBuffer.substring(finalConsumedIndex); // Consume everything including EOF line
                this.completeCommand(logData); // Resolve with the extracted log data
            } else {
                 if (this.debug) console.log("SerialCLI: Log EOF marker found, but newline missing.");
            }
        } else {
            if (this.debug) console.log("SerialCLI: Log command response started, waiting for EOF.");
        }
    } else {
        // For standard commands, the single line is the response
        this.readBuffer = this.readBuffer.substring(consumedUntilIndex); // Consume the processed part
        this.completeCommand(responseLine); // Resolve with the single response line
    }

    if (this.debug) console.log("SerialCLI: Buffer after processing:", JSON.stringify(this.readBuffer));
  }


  /**
   * (Re)arm the quiet-period timer for a 'collect' mode command
   * @private
   */
  scheduleCollectFlush() {
    if (!this.currentCommand) return;
    clearTimeout(this.currentCommand.idleTimer);
    this.currentCommand.idleTimer = setTimeout(() => this.flushCollect(), this.currentCommand.idleMs);
  }

  /**
   * Resolve a 'collect' mode command with everything received since the echo
   * @private
   */
  flushCollect() {
    if (!this.currentCommand || this.currentCommand.mode !== 'collect') return;

    const { command } = this.currentCommand;
    let text = this.readBuffer;
    this.readBuffer = '';

    // Drop the command echo, so only the device's own output remains
    const echoIndex = text.indexOf(command + '\r');
    if (echoIndex !== -1) {
      text = text.substring(echoIndex + command.length + 1);
      if (text.startsWith('\n')) text = text.substring(1);
    }

    if (this.debug) console.log(`SerialCLI: Collected response for "${command}":`, JSON.stringify(text));
    this.completeCommand(text.replace(/\r\n/g, '\n').trim());
  }

  /**
   * Complete a command and resolve its promise with the response
   * @param {string} response - The response from the device
   * @private
   */
  completeCommand(response) {
    if (!this.currentCommand) return;

    clearTimeout(this.currentCommand.timeout);
    clearTimeout(this.currentCommand.idleTimer);
    const { resolve, command } = this.currentCommand;
    if (this.debug) console.log(`SerialCLI: Command "${command}" completed with response:`, response);

    this.currentCommand = null;
    resolve(response);

    // Schedule next command execution after a delay
    if (this.commandQueue.length > 0) {
      if (this.debug) console.log(`SerialCLI: Scheduling next command in ${this.commandDelay}ms`);
      setTimeout(() => this.executeNextCommand(), this.commandDelay);
    } else {
       if (this.debug) console.log("SerialCLI: Command queue empty.");
    }
  }

  /**
   * Execute the next command in the queue
   * @private
   */
  async executeNextCommand() {
    // Prevent starting a new command if one is already in progress
    if (this.currentCommand) {
        if (this.debug) console.log("SerialCLI: executeNextCommand called, but a command is already active.");
        return;
    }
    if (this.commandQueue.length === 0) {
        if (this.debug) console.log("SerialCLI: executeNextCommand called, but queue is empty.");
        return;
    }
    if (!this.writer) {
        console.error("SerialCLI: Cannot execute command, writer is not available.");
        // Reject the command? Or just log and wait? Let's reject.
        const nextCmd = this.commandQueue.shift();
        nextCmd.reject(new Error("Serial writer not available"));
        // Check if more commands need rejecting or if we should stop.
        if (this.commandQueue.length > 0) {
           setTimeout(() => this.executeNextCommand(), this.commandDelay); // Process next potential rejection
        }
        return;
    }


    this.currentCommand = this.commandQueue.shift();
    const { command, reject } = this.currentCommand;

    if (this.debug) console.log(`SerialCLI: Executing command: "${command}"`);

    // Set response timeout
    this.currentCommand.timeout = setTimeout(() => {
      if (this.currentCommand && this.currentCommand.command === command) { // Ensure it's still the same command
        const timeoutMsg = `Command timeout: ${command}`;
        console.error("SerialCLI:", timeoutMsg);
        clearTimeout(this.currentCommand.idleTimer);
        reject(new Error(timeoutMsg));
        this.currentCommand = null; // Clear current command on timeout

        // Try the next command after a delay
        if (this.commandQueue.length > 0) {
           if (this.debug) console.log("SerialCLI: Scheduling next command after timeout.");
           setTimeout(() => this.executeNextCommand(), this.commandDelay);
        }
      }
    }, this.currentCommand.timeoutMs || this.responseTimeout);

    try {
      const dataToSend = this.encoder.encode(command + '\r');
      if (this.debug) {
        console.log("SerialCLI >>> SEND:", JSON.stringify(command + '\\r')); // Log data being sent
      }
      await this.writer.write(dataToSend);
      // A collect-mode command may produce no output at all (empty reply), so
      // start the quiet-period timer right away rather than on first byte.
      if (this.currentCommand?.mode === 'collect') this.scheduleCollectFlush();
    } catch (error) {
      console.error(`SerialCLI: Error writing command "${command}":`, error);
      clearTimeout(this.currentCommand.timeout);
      clearTimeout(this.currentCommand.idleTimer);
      reject(error);
      this.currentCommand = null; // Clear current command on write error

      // Try the next command after a delay
      if (this.commandQueue.length > 0) {
         if (this.debug) console.log("SerialCLI: Scheduling next command after write error.");
         setTimeout(() => this.executeNextCommand(), this.commandDelay);
      }
    }
  }

  /**
   * Send a command to the device
   * @param {string} command - The command to send
   * @param {boolean|{isLogCommand?: boolean, mode?: 'line'|'collect', idleMs?: number}} [options]
   *   Pass `true` (or `{ isLogCommand: true }`) for multi-line responses ending in EOF.
   *   Pass `{ mode: 'collect' }` for commands that print without the "  -> " marker;
   *   the response is then everything received until the device is idle for `idleMs`.
   * @returns {Promise<string>} The device's response
   */
  sendCommand(command, options = false) {
    if (!this.port || !this.writer) {
      const errorMsg = 'Serial connection not open or writer unavailable';
      console.error("SerialCLI:", errorMsg);
      return Promise.reject(new Error(errorMsg));
    }

    const opts = typeof options === 'boolean' ? { isLogCommand: options } : (options || {});
    const isLogCommand = !!opts.isLogCommand;
    const mode = opts.mode || 'line';
    const idleMs = opts.idleMs || 400;
    const timeoutMs = opts.timeoutMs || this.responseTimeout;

    return new Promise((resolve, reject) => {
      this.commandQueue.push({ command, resolve, reject, isLogCommand, mode, idleMs, timeoutMs });
      if (this.debug) console.log(`SerialCLI: Queued command: "${command}". Queue length: ${this.commandQueue.length}`);

      // If no current command is active, start execution immediately
      if (!this.currentCommand) {
         if (this.debug) console.log("SerialCLI: Triggering command execution from sendCommand.");
         this.executeNextCommand();
      }
    });
  }

  // ============= CONVENIENCE METHODS =============

  /**
   * Get the device firmware version
   * @returns {Promise<string>} Version information
   */
  async getVersion() {
    return this.sendCommand('ver');
  }

  /**
   * Get the current clock time
   * @returns {Promise<string>} Current time
   */
  async getClock() {
    return this.sendCommand('clock');
  }

  /**
   * Set the time (in epoch seconds)
   * @param {number} seconds - Epoch seconds
   * @returns {Promise<string>} Response from device
   */
  async setTime(seconds) {
    // Ensure seconds is a valid number
    if (typeof seconds !== 'number' || !Number.isInteger(seconds) || seconds < 0) {
        return Promise.reject(new Error("Invalid time value. Must be a non-negative integer."));
    }
    return this.sendCommand(`time ${seconds}`);
  }

  /**
   * Reboot the device
   * @returns {Promise<string>} Response from device (Note: response might not be received if reboot is immediate)
   */
  async reboot() {
    // Don't necessarily expect a standard response format for reboot
    // Consider adding a short delay after sending if needed by the calling code
    return this.sendCommand('reboot');
  }

  /**
   * Erase filesystem (factory reset)
   * @returns {Promise<string>} Response from device
   */
  async erase() {
    return this.sendCommand('erase');
  }

  /**
   * Force device to send an advertisement
   * @returns {Promise<string>} Response from device
   */
  async sendAdvert() {
    return this.sendCommand('advert');
  }

  /**
   * Start OTA update
   * @returns {Promise<string>} Response from device
   */
  async startOTA() {
    // Might need specific node name from prefs? The C++ code suggests yes.
    // This JS version doesn't store prefs, so we send the basic command.
    // Consider adding a parameter if the node name is needed.
    return this.sendCommand('start ota');
  }

  /**
   * Get a variable value
   * @param {string} variable - The variable name (e.g., 'name', 'lat', 'tx')
   * @returns {Promise<string>} Raw variable value string from device (e.g., "> MyNode", "> 10", "> 433.125")
   */
  async getVariable(variable) {
    return this.sendCommand(`get ${variable}`);
  }

  /**
   * Set a variable value
   * @param {string} variable - The variable name
   * @param {string|number|boolean} value - The value to set
   * @returns {Promise<string>} Response from device (usually "OK" or an error)
   */
  async setVariable(variable, value) {
    // Convert boolean 'true'/'false' to 'on'/'off' if appropriate for specific vars later
    return this.sendCommand(`set ${variable} ${value}`);
  }

  /**
   * Set admin password
   * @param {string} password - Admin password
   * @returns {Promise<string>} Response from device
   */
  async setPassword(password) {
    // Basic validation: ensure password is a non-empty string
    if (typeof password !== 'string' || password.length === 0) {
        return Promise.reject(new Error("Password cannot be empty."));
    }
     // Potentially add checks for invalid characters if needed
    return this.sendCommand(`password ${password}`);
  }

  /**
   * Retrieve log data
   * @returns {Promise<string>} Log contents (multi-line string)
   */
  async getLog() {
    // The device dumps the file straight to the port before its "   EOF" reply,
    // so there is no marker to parse - collect until it goes quiet.
    return this.sendCommand('log', { mode: 'collect', idleMs: 800, timeoutMs: 60000 });
  }

  /**
   * Start logging
   * @returns {Promise<string>} Response from device
   */
  async startLogging() {
    return this.sendCommand('log start');
  }

  /**
   * Stop logging
   * @returns {Promise<string>} Response from device
   */
  async stopLogging() {
    return this.sendCommand('log stop');
  }

  /**
   * Erase the log file
   * @returns {Promise<string>} Response from device
   */
  async eraseLog() {
    return this.sendCommand('log erase');
  }

  /**
   * Parse response from getVariable commands, removing the "> " prefix and attempting type conversion.
   * @param {string} response - The raw response string from a getVariable command (e.g., "> MyNode", "> 10", "> on")
   * @returns {string|number|boolean|null} The parsed value, or null if parsing fails or response format is unexpected.
   */
  parseVariableResponse(response) {
    if (typeof response !== 'string' || !response.startsWith('> ')) {
        if(this.debug) console.warn(`SerialCLI: Unexpected format for parseVariableResponse: "${response}"`);
        return null; // Or return the original response? Returning null indicates parsing issue.
    }

    const value = response.substring(2).trim(); // Remove "> " and trim whitespace

    // Check for empty value after prefix removal
    if (value === '') {
        return ''; // Return empty string if that was the actual value
    }

    // Try to parse as number (integer or float)
    // Updated regex to handle negative numbers and ensure it's the *entire* string
    if (/^-?\d+(\.\d+)?$/.test(value)) {
      return Number(value); // Use Number() to handle both int and float
    }

    // Handle boolean 'on'/'off' (case-insensitive)
    if (value.toLowerCase() === 'on') return true;
    if (value.toLowerCase() === 'off') return false;

    // Return as string for all other cases
    return value;
  }

  // ============= SPECIFIC VARIABLE GETTERS/SETTERS (using parseVariableResponse) =============

  async getRole() {
    const response = await this.getVariable('role');
    return this.parseVariableResponse(response);
  }

  async getPubKey() {
    const response = await this.getVariable('public.key');
    return this.parseVariableResponse(response);
  }

  async getName() {
    const response = await this.getVariable('name');
    return this.parseVariableResponse(response);
  }

  async setName(name) {
    if (typeof name !== 'string') return Promise.reject(new Error("Name must be a string."));
    // Add validation for length or characters based on device limits if known
    return this.setVariable('name', name);
  }

  async getLatitude() {
    const response = await this.getVariable('lat');
    return this.parseVariableResponse(response);
  }

  async setLatitude(lat) {
    if (typeof lat !== 'number') return Promise.reject(new Error("Latitude must be a number."));
    // Add validation for range (-90 to 90) if needed
    return this.setVariable('lat', lat);
  }

  async getLongitude() {
    const response = await this.getVariable('lon');
    return this.parseVariableResponse(response);
  }

  async setLongitude(lon) {
    if (typeof lon !== 'number') return Promise.reject(new Error("Longitude must be a number."));
     // Add validation for range (-180 to 180) if needed
    return this.setVariable('lon', lon);
  }

  async getRadioConfig() {
    const response = await this.getVariable('radio');
    const parsed = this.parseVariableResponse(response);
    if (typeof parsed === 'string') {
      const parts = parsed.split(',');
      if (parts.length === 4) {
        return {
          freq: parseFloat(parts[0]) || null,
          bw: parseFloat(parts[1]) || null,
          sf: parseInt(parts[2], 10) || null,
          cr: parseInt(parts[3], 10) || null
        };
      }
    }
    if (this.debug) console.warn("SerialCLI: Could not parse radio config response:", response);
    return null; // Indicate parsing failure
  }

  async setRadioConfig(freq, bw, sf, cr) {
     // Add validation for types and ranges if necessary
    if (typeof freq !== 'number' || typeof bw !== 'number' || typeof sf !== 'number' || typeof cr !== 'number') {
        return Promise.reject(new Error("Invalid radio parameters. All must be numbers."));
    }
    return this.setVariable('radio', `${freq},${bw},${sf},${cr}`);
  }

  async getTxPower() {
    const response = await this.getVariable('tx');
    return this.parseVariableResponse(response);
  }

  async setTxPower(power) {
    if (typeof power !== 'number') return Promise.reject(new Error("TX Power must be a number."));
    // Add validation for range based on device capabilities if known (e.g., 1-30)
    return this.setVariable('tx', power);
  }

  async getAirtimeFactor() {
    const response = await this.getVariable('af');
    return this.parseVariableResponse(response);
  }

  async setAirtimeFactor(factor) {
     if (typeof factor !== 'number') return Promise.reject(new Error("Airtime factor must be a number."));
     // Add validation for range (e.g., 0-9)
    return this.setVariable('af', factor);
  }

  async getRepeat() {
    const response = await this.getVariable('repeat');
    return this.parseVariableResponse(response); // Should return true/false
  }

  async setRepeat(enabled) {
    if (typeof enabled !== 'boolean') return Promise.reject(new Error("Repeat value must be boolean (true/false)."));
    return this.setVariable('repeat', enabled ? 'on' : 'off');
  }

  // Note: 'allow.read.only' is not in the C++ code provided, assuming it might exist elsewhere or is hypothetical.
  // If it exists and uses 'on'/'off', the pattern is the same as 'setRepeat'.
  // async getAllowReadOnly() { ... }
  // async setAllowReadOnly(enabled) { ... }

  async getAdvertInterval() {
    // C++ stores as interval/2, retrieves as interval*2 (minutes)
    const response = await this.getVariable('advert.interval');
    return this.parseVariableResponse(response);
  }

  async setAdvertInterval(minutes) {
    if (typeof minutes !== 'number' || !Number.isInteger(minutes)) return Promise.reject(new Error("Advert interval must be an integer (minutes)."));
    // Add validation based on C++ code (min 60, max 240, or 0 for off)
    if (minutes !== 0 && (minutes < 60 || minutes > 240)) {
        return Promise.reject(new Error("Advert interval must be 0 (off) or between 60 and 240 minutes."));
    }
    return this.setVariable('advert.interval', minutes);
  }

  // Note: 'flood.advert.interval' is not in the C++ code provided.
  // async getFloodAdvertInterval() { ... }
  // async setFloodAdvertInterval(hours) { ... }

  async getGuestPassword() {
    const response = await this.getVariable('guest.password');
    return this.parseVariableResponse(response);
  }

  async setGuestPassword(password) {
    if (typeof password !== 'string') return Promise.reject(new Error("Guest password must be a string."));
    // Consider adding length/character validation
    return this.setVariable('guest.password', password);
  }

  async getRxDelay() {
    const response = await this.getVariable('rxdelay');
    return this.parseVariableResponse(response);
  }

  async setRxDelay(delay) {
    if (typeof delay !== 'number' || delay < 0) return Promise.reject(new Error("RX Delay must be a non-negative number."));
     // Add validation for range (e.g., 0-20)
    return this.setVariable('rxdelay', delay);
  }

  async getTxDelay() {
    const response = await this.getVariable('txdelay');
    return this.parseVariableResponse(response);
  }

  async setTxDelay(delay) {
    if (typeof delay !== 'number' || delay < 0) return Promise.reject(new Error("TX Delay factor must be a non-negative number."));
    // Add validation for range (e.g., 0-2)
    return this.setVariable('txdelay', delay);
  }

  async getDirectTxDelay() {
    const response = await this.getVariable('direct.txdelay');
    return this.parseVariableResponse(response);
  }

  async setDirectTxDelay(delay) {
    if (typeof delay !== 'number' || delay < 0) return Promise.reject(new Error("Direct TX Delay factor must be a non-negative number."));
     // Add validation for range (e.g., 0-2)
    return this.setVariable('direct.txdelay', delay);
  }

  async getFloodMax() {
    const response = await this.getVariable('flood.max');
    return this.parseVariableResponse(response);
  }

  async setFloodMax(max) {
    if (typeof max !== 'number' || !Number.isInteger(max) || max < 0 || max > 64) {
        return Promise.reject(new Error("Flood Max must be an integer between 0 and 64."));
    }
    return this.setVariable('flood.max', max);
  }

  // ============= STATS =============
  //
  // The three stats commands are serial-only and reply with a single line of
  // JSON, e.g. {"battery_mv":4012,"uptime_secs":4545,"errors":0,"queue_len":0}

  /**
   * Parse one stats reply. Returns null for firmware that does not know the
   * command, or that answers in a non-JSON format.
   */
  parseStatsReply(reply) {
    const text = String(reply ?? '').trim();
    if (!text.startsWith('{')) return null;
    try {
      return JSON.parse(text);
    } catch (e) {
      if (this.debug) console.warn('SerialCLI: unparseable stats reply', text);
      return null;
    }
  }

  /**
   * Read core, radio and packet statistics.
   * @returns {Promise<{core: object|null, radio: object|null, packets: object|null}>}
   */
  async getStats() {
    const core = this.parseStatsReply(await this.sendCommand('stats-core'));
    const radio = this.parseStatsReply(await this.sendCommand('stats-radio'));
    const packets = this.parseStatsReply(await this.sendCommand('stats-packets'));
    return { core, radio, packets };
  }

  // ============= REGIONS =============
  //
  // The device prints the region tree as an indented list, one line per region,
  // where the indent is the depth, a trailing "^" marks the home region and a
  // trailing " F" means flood is allowed:
  //
  //   * F
  //    EU^ F
  //     DE
  //
  // The reply buffer on the device is 160 bytes, so large trees get truncated.

  /** Longest region tree the device's reply buffer can hold */
  static get REGION_REPLY_LIMIT() { return 160; }

  /**
   * Read the region tree.
   * @returns {Promise<{supported: boolean, truncated: boolean, regions: Array, home: string|null}>}
   */
  async getRegions() {
    const reply = await this.sendCommand('region');
    return this.parseRegionTree(reply);
  }

  /**
   * Parse the output of the `region` command
   * @param {string} reply
   */
  parseRegionTree(reply) {
    const text = String(reply ?? '');
    if (!text || /^(Unknown command|Err - \?\?)/i.test(text)) {
      return { supported: false, truncated: false, regions: [], home: null };
    }

    const regions = [];
    const parentAtDepth = [];
    let home = null;

    for (const rawLine of text.split('\n')) {
      if (!rawLine.trim()) continue;
      const depth = rawLine.length - rawLine.replace(/^ +/, '').length;
      let name = rawLine.trim();

      let flood = false;
      if (name.endsWith(' F')) { flood = true; name = name.slice(0, -2).trimEnd(); }

      let isHome = false;
      if (name.endsWith('^')) { isHome = true; name = name.slice(0, -1); }

      if (!name) continue;
      if (isHome) home = name;

      parentAtDepth[depth] = name;
      regions.push({
        name,
        parent: depth === 0 ? null : (parentAtDepth[depth - 1] ?? '*'),
        depth,
        flood,
      });
    }

    // The device silently stops writing once the 160-byte reply buffer is full,
    // which cuts the last line mid-name.
    const truncated = text.length >= SerialCLI.REGION_REPLY_LIMIT - 4;

    return { supported: regions.length > 0, truncated, regions, home };
  }

  /**
   * Read the default region ("default scope"). Returns null when unset (<null>),
   * or undefined when the firmware does not support the command.
   */
  async getRegionDefault() {
    const reply = await this.sendCommand('region default');
    return this.parseRegionScope(reply, 'default scope is');
  }

  /** Read the home region. Returns "*" when unset. */
  async getRegionHome() {
    const reply = await this.sendCommand('region home');
    return this.parseRegionScope(reply, 'home is');
  }

  /**
   * Pull the region name out of a " default scope is X" / " home is X" reply.
   * @returns {string|null|undefined} name, null for <null>/*, undefined if unsupported
   */
  parseRegionScope(reply, label) {
    const text = String(reply ?? '').trim();
    const idx = text.toLowerCase().indexOf(label.toLowerCase());
    if (idx === -1) return undefined;
    const value = text.substring(idx + label.length).trim();
    if (!value || value === '<null>' || value === '*') return null;
    return value;
  }

  async setRegionDefault(name) {
    return this.sendCommand(`region default ${name || '<null>'}`);
  }

  async setRegionHome(name) {
    return this.sendCommand(`region home ${name || '*'}`);
  }

  /** Create a region, or re-parent an existing one. Resets it to flood-allowed. */
  async putRegion(name, parent) {
    return this.sendCommand(`region put ${name}${parent && parent !== '*' ? ` ${parent}` : ''}`);
  }

  /** Remove a region. Fails with "Err - not empty" while it still has children. */
  async removeRegion(name) {
    return this.sendCommand(`region remove ${name}`);
  }

  async setRegionFlood(name, allowed) {
    return this.sendCommand(`region ${allowed ? 'allowf' : 'denyf'} ${name}`);
  }

  /** Persist the region table to flash */
  async saveRegions() {
    return this.sendCommand('region save');
  }

  // NOTE: `region load` is deliberately not wrapped here. It does not reload
  // anything - it puts the device into a modal bulk-import state where every
  // following line is read as a region in an indented tree, until a blank line
  // commits it. Sending it without following that protocol swallows subsequent
  // commands, and the committing blank line replaces the whole region table.

  // ============= ACCESS CONTROL LIST =============
  //
  // "get acl" is serial-only and prints directly, with no "  -> " reply marker:
  //
  //   ACL:
  //   03 <64 hex chars>
  //   01 <64 hex chars>
  //
  // The low 2 bits of the permission byte are the role.

  static get PERM_ROLE_MASK() { return 3; }
  static get PERM_GUEST() { return 0; }
  static get PERM_READ_ONLY() { return 1; }
  static get PERM_READ_WRITE() { return 2; }
  static get PERM_ADMIN() { return 3; }

  /**
   * Read the access control list.
   * @returns {Promise<{supported: boolean, clients: Array<{pubkey: string, perms: number}>}>}
   */
  async getAcl() {
    const reply = await this.sendCommand('get acl', { mode: 'collect' });
    return this.parseAcl(reply);
  }

  /**
   * Parse the output of `get acl`
   * @param {string} reply
   */
  parseAcl(reply) {
    const text = String(reply ?? '');
    // Firmware without ACL support falls through to the generic "??: acl" reply
    if (/\?\?:/.test(text) || /Unknown command/i.test(text)) {
      return { supported: false, clients: [] };
    }

    const clients = [];
    for (const line of text.split('\n')) {
      const m = line.trim().match(/^([0-9a-f]{1,2})\s+([0-9a-f]{64})$/i);
      if (m) clients.push({ pubkey: m[2].toLowerCase(), perms: parseInt(m[1], 16) });
    }

    return { supported: /^\s*ACL:/im.test(text), clients };
  }

  /**
   * Set a client's permissions. Permission 0 (guest) removes them from the list.
   * Adding or changing requires the complete 64-char public key.
   * @param {string} pubkey - hex public key
   * @param {number} perms - permission byte
   */
  async setPerm(pubkey, perms) {
    return this.sendCommand(`setperm ${pubkey} ${perms}`);
  }
}
