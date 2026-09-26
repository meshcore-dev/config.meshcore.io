# config.meshcore.dev

Web-based configuration tool for MeshCore Repeater, Room Server and Sensor nodes via USB serial (Web Serial API).

## Features

- **USB Serial connection** to MeshCore nodes using the Web Serial API
- **Read/write all configuration variables** including radio, routing, advertising and advanced settings
- **Region management** - browse the region tree, add, rename, re-parent, enable/disable flood and delete regions, and set the home and default region
- **Access control** - view the node's access list, add or remove nodes and change their roles
- **Export/Import** configuration as JSON files for backup and cloning, including regions and the access list
- **Vanity key generator** - generate custom public key prefixes using multi-core Web Workers
- **CLI console** with command auto-complete and history

## Requirements

- A modern browser with [Web Serial API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API) support (Chrome, Edge, Opera)
- HTTPS or localhost (required by Web Serial API)
- A MeshCore repeater/room server/ sensor node connected via USB

## Usage

1. Serve the files over HTTPS or localhost, e.g.:
   ```
   python3 -m http.server 8000
   ```
2. Open `http://localhost:8000` in your browser
3. Click **Connect** and select the serial port of your MeshCore device
4. View and modify settings, then click **Save settings**

## Configuration Sections

| Section | Description |
|---------|-------------|
| **Info & Actions** | Device info, export/import, console, OTA, reboot |
| **Name & Location** | Node name (with byte counter), coordinates, interactive map |
| **Access** | Guest password, admin password |
| **Access control** | Per-node access list: public keys and their roles (read only / read-write / admin) |
| **Regions** | Region tree, flood permission per region, home region and default region |
| **Room Server** | Repeat toggle, read-only mode (room servers only) |
| **Radio** | Frequency, bandwidth, SF, CR, TX power, duty cycle, presets |
| **Advertising** | Advert interval, flood advert interval, flood max (total / unscoped / adverts) |
| **Owner Info** | Free-text owner information (with byte counter, 119 byte limit) |
| **Advanced** | Loop detection, path hash mode, interference threshold, AGC reset, TX/RX delays, multi-ACKs, CAD, RX boosted gain, ADC multiplier |

## Project Structure

```
index.html          Main application
src/gui.js          Vue 3 application logic
src/config-model.js Region tree / access list diffing and validation
lib/serial-cli.js   Web Serial API communication layer
lib/vanity-key-generator.js   Multi-core vanity key generation
lib/vanity-key-worker.js      Web Worker for key brute-forcing
lib/ed25519-vanity.js         Minimal ed25519 arithmetic for the key search
lib/vue.esm-browser.js        Vue 3 runtime
lib/beer.min.js     Beer CSS UI framework
lib/leaflet.js      Leaflet mapping library
css/style.css       Application styles
```

## Notes

### Regions

Region edits are collected in the UI and applied by the global **Save settings**
button as a sequence of `region put` / `region remove` / `region allowf` /
`region denyf` commands, finishing with `region save`.

Because the firmware stores the home and default region by internal id, renaming
either of them drops the pointer - the tool re-issues `region home` /
`region default` automatically when that happens.

The device returns its region tree in a 160-byte reply buffer. If the tree is
large enough to be truncated, region editing is disabled rather than risk
deleting regions that were never shown. Use the console (`region`) in that case.

### Access control

Roles map to the low two bits of the firmware's permission byte: 1 read only,
2 read-write, 3 admin. Removing a node sends `setperm <key> 0`, which is how the
firmware deletes an entry. The device writes the access list to flash about 5
seconds after the last change, so the tool waits before allowing a reboot.

### Vanity keys

MeshCore derives the public key straight from the first 32 bytes of the stored
64-byte private key, so the scalar does not have to be the SHA-512 expansion of
a seed. The generator exploits that: it starts from one random clamped scalar
and walks the curve by repeatedly adding 8G (one point addition per candidate
instead of a full scalar multiplication), recovering affine coordinates for a
whole batch with a single modular inversion. That runs at roughly 550k keys/sec
per core, so an 8-character prefix is practical.

## License

MIT License - see [LICENSE](LICENSE)
