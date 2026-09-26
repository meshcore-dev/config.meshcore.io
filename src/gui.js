import { createApp, ref, reactive, onMounted, computed, watch } from '../lib/vue.esm-browser.js';
import { SerialCLI } from '../lib/serial-cli.js';
import { VanityKeyGenerator } from '../lib/vanity-key-generator.js';
import {
  ROOT_UID, isValidRegionName, regionDescendants, regionParentOptions,
  buildRegionCommands as diffRegions, validateRegions as checkRegions,
  ACL_ROLES, aclRole, setAclRole, isValidPubKey,
  buildAclCommands as diffAcl, validateAcl as checkAcl,
} from './config-model.js';


// Minimum firmware version required for each variable
const varMinVersion = {
  'owner.info': [1, 12, 0],
  'path.hash.mode': [1, 14, 0],
  'loop.detect': [1, 14, 0],
  // The firmware matches config names with memcmp(), so on <1.16 a read of
  // "flood.max.unscoped" is answered by the plain "flood.max" handler. These
  // have to be gated on the version rather than probed.
  'flood.max.unscoped': [1, 16, 0],
  'flood.max.advert': [1, 16, 0],
};

function parseFirmwareVersion(verString) {
  // e.g. "v1.13.0-295f67d (Build: 15-Feb-2026)" -> [1, 13, 0]
  const match = verString.match(/v?(\d+)\.(\d+)\.(\d+)/);
  if (!match) return [0, 0, 0];
  return [parseInt(match[1]), parseInt(match[2]), parseInt(match[3])];
}

function versionAtLeast(current, required) {
  for (let i = 0; i < 3; i++) {
    if (current[i] > required[i]) return true;
    if (current[i] < required[i]) return false;
  }
  return true;
}

createApp({
  setup() {
    const app = window.app = reactive({
      connecting: false,
      connected: false,
      locked: true,
      showAdvanced: localStorage.getItem('show.advanced') === '1',
      busy: '',
      presets: [],
      map: null,
      marker: null,
      device: {
        version: '',
        clock: '',
        password: '',
        prvKey: '',
        importPrvKey: '',
        pubKey: '',
        role: '',
        vars: {
          name: '',
          repeat: false,
          'allow.read.only': false,
          radio: { freq: 0, sf: 0, cr: 0, bw: 0 },
          tx: 0,
          af: 0,
          'rxdelay': 0,
          'txdelay': 0,
          'direct.txdelay': 0,
          'flood.max': 0,
          'flood.max.unscoped': 0,
          'flood.max.advert': 0,
          'flood.advert.interval': 0,
          'advert.interval': 0,
          'guest.password': '',
          lat: 0,
          lon: 0,
          'int.thresh': 0,
          'agc.reset.interval': 0,
          'multi.acks': 0,
          'owner.info': '',
          'path.hash.mode': 0,
          'loop.detect': 'off',
          cad: false,
          'radio.rxgain': false,
          'adc.multiplier': 0,
        },
        varsDevice: {}
      },
    });

    const fwVersion = computed(() => parseFirmwareVersion(app.device.version));

    const supportsVar = (key) => {
      const req = varMinVersion[key];
      if (!req) return true;
      return versionAtLeast(fwVersion.value, req);
    };

    // True once the device has actually answered a `get` for this key. Vars the
    // firmware or board does not implement never make it into varsDevice.
    const hasVar = (key) => key in app.device.varsDevice;

    const mapDialog = ref();

    const dutyCycle = computed({
      get: () => {
        const af = Number(app.device.vars.af) || 0;
        return Math.round(100 / (af + 1));
      },
      set: (val) => {
        const dc = Number(val);
        if (dc >= 1 && dc <= 50) {
          app.device.vars.af = ((100 / dc) - 1).toFixed(1);
        }
      }
    });

    const utf8Encoder = new TextEncoder();

    const ownerInfoBytes = computed(() => {
      const text = String(app.device.vars['owner.info'] || '');
      return utf8Encoder.encode(text.replace(/\n/g, '|')).length;
    });

    const nameMaxBytes = computed(() => {
      const lat = Number(app.device.vars.lat);
      const lon = Number(app.device.vars.lon);
      return (lat !== 0 || lon !== 0) ? 24 : 32;
    });

    const nameBytes = computed(() => {
      return utf8Encoder.encode(String(app.device.vars.name || '')).length;
    });

    const onNameInput = (e) => {
      const text = e.target.value;
      if (utf8Encoder.encode(text).length <= nameMaxBytes.value) {
        app.device.vars.name = text;
      } else {
        e.target.value = app.device.vars.name;
      }
    };

    const onOwnerInfoInput = (e) => {
      const text = e.target.value;
      const encoded = utf8Encoder.encode(text.replace(/\n/g, '|'));
      if (encoded.length <= 119) {
        app.device.vars['owner.info'] = text;
      } else {
        e.target.value = app.device.vars['owner.info'];
      }
    };

    app.preset = computed(() => {
      const radio = app.device.vars.radio;

      for(const preset of app.presets) {
        if(
          Number(preset.frequency) == radio.freq &&
          Number(preset.spreading_factor) == radio.sf &&
          Number(preset.bandwidth) == radio.bw &&
          Number(preset.coding_rate) == radio.cr
        ) { return preset }
      }

      return app.presets[0];
    });

    const snackbar = reactive({
      text: '',
      class: '',
      icon: '',
    });

    // Beer CSS centres a tooltip on its trigger, so any trigger within half a
    // tooltip's width of a viewport edge gets clipped. Nudge them back into
    // view on hover. The `translate` property composes with the `transform`
    // Beer uses for positioning, so this does not fight its own rules.
    const TOOLTIP_MARGIN = 8;

    const clampTooltip = (tip) => {
      tip.style.translate = '';
      const rect = tip.getBoundingClientRect();
      if (!rect.width) return;

      // The width is read from layout and the centre from the rendered box:
      // both are unaffected by the scale Beer animates through, so this is
      // correct even while the show transition is still running.
      const width = tip.offsetWidth;
      const centre = rect.left + rect.width / 2;
      const viewport = document.documentElement.clientWidth;

      const left = centre - width / 2;
      const right = centre + width / 2;

      let dx = 0;
      if (left < TOOLTIP_MARGIN) dx = TOOLTIP_MARGIN - left;
      else if (right > viewport - TOOLTIP_MARGIN) dx = (viewport - TOOLTIP_MARGIN) - right;

      if (dx) tip.style.translate = `${Math.round(dx)}px 0`;
    };

    const onTooltipHover = (e) => {
      if (!(e.target instanceof Element)) return;
      for (let el = e.target; el && el !== document.body; el = el.parentElement) {
        const tip = el.querySelector(':scope > .tooltip');
        if (tip) clampTooltip(tip);
      }
    };

    onMounted(() => {
      document.addEventListener('pointerover', onTooltipHover, { passive: true });
      document.addEventListener('focusin', onTooltipHover, { passive: true });
    });

    const initMap = () => {
      app.map = L.map('map', {
        maxBounds: [
          [-90, -180], // top left
          [90, 200], // bottom right
        ],
      });

      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; <a href="http://www.openstreetmap.org/copyright">OpenStreetMap</a>'
      }).addTo(app.map);

      const icon = L.icon({
        iconUrl: `https://map.meshcore.dev/img/node_types/2.svg`,
        iconSize: [32, 32],
      });

      app.marker = L.marker([0, 0], { icon }).addTo(app.map);

      app.map.on('click', (e) => {
        app.marker.setLatLng(e.latlng)
      })
    }

    const showMap = () => {
      const vars = app.device.vars;
      if(!app.map) initMap();
      app.map.setView([vars.lat, vars.lon], 2);
      app.marker.setLatLng(L.latLng(vars.lat, vars.lon));
      mapDialog.value.show();
    }

    const requestLocation = () => {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          app.marker.setLatLng(L.latLng(pos.coords.latitude, pos.coords.longitude));
          app.map.setView([pos.coords.latitude, pos.coords.longitude], 7);
        },
        () => {
          alert('Failed to retrieve location. If you denied the permission, you will need to allow it manually in site settings.')
        }
      );
    }

    const setMapLatLon = () => {
      const pos = app.marker.getLatLng();
      console.log(pos);
      app.device.vars.lat = pos.lat.toFixed(5);
      app.device.vars.lon = pos.lng.toFixed(5);
      mapDialog.value.close();
    }

    const showMessage = (text, icon, displayMs) => {
      snackbar.class = 'active';
      snackbar.text = text;
      snackbar.icon = icon || '';

      setTimeout(() => {
        snackbar.icon = '';
        snackbar.text = '';
        snackbar.class = '';
      }, displayMs || 2000);
    }

    const getPresets = async () => {
      const res = await fetch('https://api.meshcore.nz/api/v1/config');
      app.presets = (await res.json()).config.suggested_radio_settings.entries;
      app.presets.unshift({
        title: 'Custom'
      })
    }

    const setRadioPreset = (presetIndex) => {
      const preset = app.presets[presetIndex];
      const radio = app.device.vars.radio;
      console.log(preset);
      if(!preset.frequency) return;

      radio.freq = preset.frequency;
      radio.sf = preset.spreading_factor;
      radio.bw = preset.bandwidth;
      radio.cr = preset.coding_rate;

      if(preset.network_settings) {
        app.device.vars['path.hash.mode'] = preset.network_settings.path_hash_size - 1;
      }
    }

    const radioKeys = ['freq', 'bw', 'sf', 'cr'];
    const cli = window.cli = new SerialCLI(true);

    // ============================ REGIONS ============================
    //
    // Regions form a tree rooted at the "*" wildcard. Rows are tracked by a
    // client-side uid rather than by name, so a rename automatically carries
    // the children (and the home/default pointers) with it.

    let uidCounter = 0;
    const nextUid = () => `u${++uidCounter}`;

    const regions = reactive({
      supported: false,
      supportsDefault: false,
      truncated: false,
      list: [],          // [{ uid, name, parentUid, flood }], root first
      homeUid: ROOT_UID,
      defaultUid: '',    // '' == <null>
    });

    // What the device reported, kept for diffing on save
    const regionsDevice = reactive({ list: [], homeUid: ROOT_UID, defaultUid: '' });

    const regionByUid = (uid) => regions.list.find((r) => r.uid === uid);
    const regionName = (uid) => regionByUid(uid)?.name;
    const regionParents = (uid) => regionParentOptions(regions.list, uid);

    const regionsEditable = computed(() => regions.supported && !regions.truncated);

    /** Regions that can be picked as the default scope (the '*' root cannot) */
    const regionChoices = computed(() => regions.list.filter((r) => r.uid !== ROOT_UID));

    const loadRegions = async () => {
      let tree;
      try {
        tree = await cli.getRegions();
      } catch (e) {
        console.warn('Could not read regions', e);
        regions.supported = false;
        return;
      }

      regions.supported = tree.supported;
      regions.truncated = tree.truncated;
      if (!tree.supported) {
        regions.list = [];
        regionsDevice.list = [];
        return;
      }

      const uidByName = new Map();
      const list = tree.regions.map((r) => {
        const uid = r.depth === 0 ? ROOT_UID : nextUid();
        uidByName.set(r.name, uid);
        return { uid, name: r.name, parentName: r.parent, flood: r.flood };
      });
      for (const r of list) {
        r.parentUid = r.parentName === null ? null : (uidByName.get(r.parentName) ?? ROOT_UID);
        delete r.parentName;
      }

      regions.list = list;
      regions.homeUid = tree.home ? (uidByName.get(tree.home) ?? ROOT_UID) : ROOT_UID;

      let def;
      try {
        def = await cli.getRegionDefault();
      } catch (e) {
        console.warn('Could not read default region', e);
      }
      regions.supportsDefault = def !== undefined;
      regions.defaultUid = def ? (uidByName.get(def) ?? '') : '';

      regionsDevice.list = list.map((r) => ({ ...r }));
      regionsDevice.homeUid = regions.homeUid;
      regionsDevice.defaultUid = regions.defaultUid;
    };

    const addRegion = () => {
      regions.list.push({ uid: nextUid(), name: '', parentUid: ROOT_UID, flood: true });
    };

    const deleteRegion = (uid) => {
      const region = regionByUid(uid);
      if (!region) return;
      const descendants = regionDescendants(regions.list, uid);
      if (descendants.length && !confirm(
        `"${region.name}" has ${descendants.length} sub-region(s): ` +
        `${descendants.map((r) => r.name).join(', ')}.\n\nDelete them as well?`
      )) return;

      const doomed = new Set([uid, ...descendants.map((r) => r.uid)]);
      regions.list = regions.list.filter((r) => !doomed.has(r.uid));
      if (doomed.has(regions.homeUid)) regions.homeUid = ROOT_UID;
      if (doomed.has(regions.defaultUid)) regions.defaultUid = '';
    };

    const buildRegionCommands = () =>
      (regionsEditable.value ? diffRegions(regions, regionsDevice) : []);

    const regionsChanged = computed(() => buildRegionCommands().length > 0);

    const validateRegions = () =>
      (regionsEditable.value ? checkRegions(regions.list) : null);

    // ======================= ACCESS CONTROL LIST =======================

    const acl = reactive({ supported: false, list: [] });  // [{ uid, pubkey, perms }]
    const aclDevice = reactive({ list: [] });

    const loadAcl = async () => {
      let res;
      try {
        res = await cli.getAcl();
      } catch (e) {
        console.warn('Could not read ACL', e);
        acl.supported = false;
        return;
      }
      acl.supported = res.supported;
      acl.list = res.clients.map((c) => ({ uid: nextUid(), pubkey: c.pubkey, perms: c.perms }));
      aclDevice.list = acl.list.map((c) => ({ ...c }));
    };

    const addAclEntry = () => {
      acl.list.push({ uid: nextUid(), pubkey: '', perms: 2 });
    };

    const deleteAclEntry = (uid) => {
      acl.list = acl.list.filter((c) => c.uid !== uid);
    };

    const buildAclCommands = () =>
      (acl.supported ? diffAcl(acl.list, aclDevice.list) : []);

    const aclChanged = computed(() => buildAclCommands().length > 0);

    const validateAcl = () => (acl.supported ? checkAcl(acl.list) : null);

    const getData = async() => {
      app.busy = 'Reading configuration...';
      const vars = app.device.vars;
      const varsDevice = app.device.varsDevice;

      app.device.version = await cli.getVersion();
      app.device.clock = await cli.getClock();
      app.device.role = await cli.getRole();
      app.device.pubKey = await cli.getPubKey();

      try {
        const prvKeyResponse = await cli.getVariable('prv.key');
        const prvKey = cli.parseVariableResponse(prvKeyResponse);
        if (prvKey) app.device.prvKey = prvKey;
      } catch (e) {
        console.warn('Could not read prv.key', e);
      }

      for(const key of Object.keys(vars)) {
        if (!supportsVar(key)) {
          console.log(`Skipping ${key}: requires newer firmware`);
          continue;
        }
        const response = await cli.getVariable(key);
        let value = cli.parseVariableResponse(response);
        if(value === null) {
          // empty response like ">" with no value - treat as empty string for string vars
          if(typeof vars[key] === 'string' && response && response.startsWith('>')) {
            value = '';
          } else {
            console.warn(`Unsupported variable: ${key}, response: ${response}`);
            continue;
          }
        }
        if(key === 'radio') {
          const radioKeys = ['freq', 'bw', 'sf', 'cr'];
          const radioValues = String(value).split(',');
          value = Object.fromEntries(radioKeys.map((key, i) => [key, radioValues[i]]));
          value.bw = value.bw.replace('.0', '');
          value.freq = Number(value.freq).toFixed(3);
          value.sf = String(value.sf);
          value.cr = String(value.cr);
        }
        if(key === 'owner.info') {
          value = String(value).replace(/\|/g, '\n');
        }
        // round float values to 1 decimal to compensate for firmware float imprecision
        if(['rxdelay', 'txdelay', 'direct.txdelay'].includes(key) && typeof value === 'number') {
          value = Math.round(value * 10) / 10;
        }
        if(['lat', 'lon'].includes(key) && typeof value === 'number') {
          value = Math.round(value * 100000) / 100000;
        }
        // loop.detect: parser converts "off" to boolean false, keep as string
        if(key === 'loop.detect') {
          if(value === false) value = 'off';
          else value = String(value);
        }
        // multi.acks: ensure string to match checkbox true-value/false-value
        if(key === 'multi.acks') {
          value = String(Number(value));
        }
        // fix for initial value of advert.interval. it's only set to 2 temporarily and will be set to 0 later
        if(key === 'advert.interval' && value == 2) {
          value = 0;
        }
        vars[key] = value;
        varsDevice[key] = typeof value === 'object' ? { ...value } : value;
      }

      await loadRegions();
      await loadAcl();
      app.busy = '';
    }

    // The firmware defers the ACL write by LAZY_CONTACTS_WRITE_DELAY (5s), so
    // give it a margin before anything can reboot the device out from under it.
    const ACL_WRITE_DELAY_MS = 6000;

    const setData = async() => {
      const vars = app.device.vars;
      const varsDevice = app.device.varsDevice;
      const rebootKeys = new Set(['radio', 'prv.key']);

      const invalid = validateRegions() || validateAcl();
      if (invalid) {
        alert(`Cannot save:\n\n${invalid}`);
        return;
      }

      app.locked = true;
      app.busy = 'Saving configuration...';
      try {
        let needsReboot = false;
        for(const key of Object.keys(vars)) {
          if (!supportsVar(key)) continue;

          let value = vars[key];

          if(JSON.stringify(vars[key]) === JSON.stringify(varsDevice[key])) {
            continue;
          }

          if(!(key in varsDevice)) {
            continue;
          }

          if(rebootKeys.has(key)) needsReboot = true;

          if(['repeat', 'allow.read.only', 'cad', 'radio.rxgain'].includes(key)) {
            value = value ? 'on' : 'off';
          }

          if(key === 'owner.info') {
            value = value.replace(/\n/g, '|');
          }

          if(key === 'radio') {
            value = `${vars.radio.freq},${vars.radio.bw + '.0'},${vars.radio.sf},${vars.radio.cr}`
          }
          console.log('saving', key, ':', value);

          await cli.setVariable(key, value);
        }
        if(app.device.importPrvKey) {
          await cli.setVariable('prv.key', app.device.importPrvKey);
          app.device.importPrvKey = '';
          needsReboot = true;
        }
        if(app.device.password) {
          await cli.sendCommand(`password ${app.device.password}`);
          app.device.password = '';
        }

        const regionCmds = buildRegionCommands();
        if (regionCmds.length) {
          app.busy = 'Saving regions...';
          for (const cmd of regionCmds) {
            const reply = await cli.sendCommand(cmd);
            console.log('region:', cmd, '->', reply);
            if (/^err/i.test(reply)) throw new Error(`"${cmd}" failed: ${reply}`);
          }
        }

        const aclCmds = buildAclCommands();
        if (aclCmds.length) {
          app.busy = 'Saving access list...';
          for (const cmd of aclCmds) {
            const reply = await cli.sendCommand(cmd);
            console.log('acl:', cmd, '->', reply);
            if (/^err/i.test(reply)) throw new Error(`"${cmd}" failed: ${reply}`);
          }
          // The firmware writes the ACL lazily, ~5s after the last change.
          app.busy = 'Waiting for the device to write the access list...';
          await new Promise((resolve) => setTimeout(resolve, ACL_WRITE_DELAY_MS));
        }

        app.busy = 'Reading configuration...';
        await getData();
        if(needsReboot) {
          if(confirm('Settings saved. Some changes require a reboot to take effect.\n\nReboot now?')) {
            cli.reboot();
            disconnect();
            return;
          }
        }
        showMessage('Data successfully saved.', 'check_circle')
      }
      catch(err) {
        // Region and ACL edits are applied one command at a time, so a failure
        // partway through leaves the device ahead of the UI. Re-read it, or the
        // next save would replay commands that have already landed.
        try {
          app.busy = 'Re-reading configuration...';
          await getData();
        } catch (readErr) {
          console.warn('Could not re-read configuration after a failed save', readErr);
        }
        alert(`Cannot save: ${err.message}`);
      }
      finally {
        app.busy = '';
        app.locked = false;
      }
    }

    const vanityDialog = ref();
    const vanityGenerator = new VanityKeyGenerator();
    const vanity = reactive({
      phase: 'input',
      prefix: '',
      cores: VanityKeyGenerator.numCores,
      attempts: 0,
      progress: 0,
      elapsed: '',
      estimatedTime: '',
      keysPerSec: '0',
      resultPubKey: '',
      resultPrvKey: '',
      _startTime: 0,
      _timer: null,
    });

    // Conservative keys/sec per core. Measured ~550k/core in Chromium on the
    // incremental point-addition search with batched modular inversion.
    const KEYS_PER_SEC_PER_CORE = 500000;

    watch(() => vanity.prefix, (val) => {
      if (val.length > 0) {
        vanity.estimatedTime = VanityKeyGenerator.estimateTime(
          val.length,
          vanity.cores * KEYS_PER_SEC_PER_CORE
        );
      }
    });

    watch(() => app.showAdvanced, (val) => {
      localStorage.setItem('show.advanced', val ? '1' : '0');
    });

    const openVanityDialog = () => {
      vanity.phase = 'input';
      vanity.prefix = '';
      vanity.attempts = 0;
      vanity.progress = 0;
      vanity.resultPubKey = '';
      vanity.resultPrvKey = '';
      vanityDialog.value.show();
    };

    const closeVanityDialog = () => {
      if (vanity.phase === 'generating') {
        vanityGenerator.cancel();
        clearInterval(vanity._timer);
      }
      vanityDialog.value.close();
    };

    const startVanityGen = async () => {
      const prefix = vanity.prefix.toLowerCase();
      vanity.phase = 'generating';
      vanity.attempts = 0;
      vanity.progress = 0;
      vanity._startTime = Date.now();

      vanity._timer = setInterval(() => {
        const elapsed = (Date.now() - vanity._startTime) / 1000;
        if (elapsed < 60) vanity.elapsed = `${Math.floor(elapsed)}s`;
        else if (elapsed < 3600) vanity.elapsed = `${Math.floor(elapsed / 60)}m ${Math.floor(elapsed % 60)}s`;
        else vanity.elapsed = `${Math.floor(elapsed / 3600)}h ${Math.floor((elapsed % 3600) / 60)}m`;

        // Update progress bar and speed
        const expected = Math.pow(16, prefix.length);
        vanity.progress = Math.min(99, (vanity.attempts / expected) * 100);
        vanity.keysPerSec = elapsed > 0 ? Math.round(vanity.attempts / elapsed).toLocaleString() : '0';
      }, 500);

      vanityGenerator.onProgress = (attempts) => {
        vanity.attempts = attempts;
      };

      try {
        const result = await vanityGenerator.generate(prefix);
        clearInterval(vanity._timer);
        vanity.attempts = result.attempts;
        vanity.progress = 100;
        vanity.resultPubKey = result.pubKey;
        vanity.resultPrvKey = result.privKey;
        vanity.phase = 'result';
      } catch (err) {
        clearInterval(vanity._timer);
        if (err.message !== 'Cancelled') {
          alert(`Generation failed: ${err.message}`);
        }
        vanity.phase = 'input';
      }
    };

    const cancelVanityGen = () => {
      vanityGenerator.cancel();
      clearInterval(vanity._timer);
      vanity.phase = 'input';
    };

    const applyVanityKey = () => {
      app.device.importPrvKey = vanity.resultPrvKey;
      app.device.pubKey = vanity.resultPubKey;
      vanityDialog.value.close();
      showMessage('Vanity key applied. Save to write to device.', 'key');
    };

    // ============================ STATS ============================

    // Typical single-cell Li-ion open-circuit discharge curve, (mV, %),
    // interpolated linearly between points.
    const LIION_CURVE = [
      [4200, 100], [4100, 90], [4000, 80], [3900, 65], [3800, 50],
      [3700, 30], [3600, 15], [3500, 8], [3400, 3], [3300, 0],
    ];

    /**
     * Battery percentage from millivolts, or null when the reading cannot be a
     * Li-ion cell (USB-powered boards report 0 or ~5 V).
     */
    const batteryPercent = (mv) => {
      if (!(mv > 2500 && mv < 4500)) return null;
      if (mv >= LIION_CURVE[0][0]) return 100;
      const last = LIION_CURVE[LIION_CURVE.length - 1];
      if (mv <= last[0]) return 0;
      for (let i = 1; i < LIION_CURVE.length; i++) {
        const [hiMv, hiPct] = LIION_CURVE[i - 1];
        const [loMv, loPct] = LIION_CURVE[i];
        if (mv >= loMv) {
          return Math.round(loPct + (hiPct - loPct) * (mv - loMv) / (hiMv - loMv));
        }
      }
      return 0;
    };

    /** "0 days 1h 15m 45s", matching the official app */
    const formatDuration = (secs) => {
      const n = Math.max(0, Math.floor(Number(secs) || 0));
      const days = Math.floor(n / 86400);
      const h = Math.floor((n % 86400) / 3600);
      const m = Math.floor((n % 3600) / 60);
      const sec = n % 60;
      return `${days} day${days === 1 ? '' : 's'} ${h}h ${m}m ${sec}s`;
    };

    const statsDialog = ref();
    const stats = reactive({
      loading: false,
      error: '',
      fetchedAt: '',
      core: null,
      radio: null,
      packets: null,
    });

    const statsRows = computed(() => {
      const { core, radio, packets } = stats;
      const rows = [];
      const num = (v) => (v === undefined || v === null ? '—' : String(v));

      if (core) {
        const volts = (core.battery_mv / 1000).toFixed(2);
        const pct = batteryPercent(core.battery_mv);
        rows.push({ label: 'Battery', lines: [pct === null ? `${volts} V` : `${pct}% / ${volts} V`] });
        rows.push({ label: 'Uptime', lines: [formatDuration(core.uptime_secs)] });
      }
      if (radio) {
        rows.push({ label: 'Total Airtime', lines: [
          `TX: ${formatDuration(radio.tx_air_secs)}`,
          `RX: ${formatDuration(radio.rx_air_secs)}`,
        ] });
        rows.push({ label: 'Last RSSI', lines: [`${num(radio.last_rssi)} dBm`] });
        rows.push({ label: 'Last SNR', lines: [`${num(radio.last_snr)} dB`] });
        rows.push({ label: 'Noise Floor', lines: [`${num(radio.noise_floor)} dBm`] });
      }
      if (packets) {
        rows.push({ label: 'Packets Sent', lines: [
          `Total: ${num(packets.sent)}, Flood: ${num(packets.flood_tx)}, Direct: ${num(packets.direct_tx)}`,
        ] });
        rows.push({ label: 'Packets Received', lines: [
          `Total: ${num(packets.recv)}, Flood: ${num(packets.flood_rx)}, Direct: ${num(packets.direct_rx)}`,
        ] });
        rows.push({ label: 'Received Packet Errors', lines: [num(packets.recv_errors)] });
      }
      if (core) {
        rows.push({ label: 'Queue Length', lines: [`TX Queue: ${num(core.queue_len)}`] });
        rows.push({ label: 'Error Flags', lines: [num(core.errors)] });
      }
      return rows;
    });

    const refreshStats = async () => {
      if (stats.loading) return;
      stats.loading = true;
      stats.error = '';
      try {
        const res = await cli.getStats();
        stats.core = res.core;
        stats.radio = res.radio;
        stats.packets = res.packets;
        stats.fetchedAt = new Date().toLocaleTimeString();
        if (!res.core && !res.radio && !res.packets) {
          stats.error = 'This firmware does not report stats over the CLI.';
        }
      } catch (err) {
        stats.error = `Could not read stats: ${err.message}`;
      } finally {
        stats.loading = false;
      }
    };

    const openStats = () => {
      statsDialog.value.show();
      refreshStats();
    };

    const reboot = async() => {
      if(!confirm('Are you sure to reboot the device?')) return;
      cli.reboot();
      disconnect();
    }

    const erase = async() => {
      if(!confirm(
        'Are you sure to factory reset the device?\n'+
        'You will loose the identity and all settings.\n'+
        'This cannot be undone!'
      )) { return }

      await cli.erase();
      cli.reboot();
      disconnect();
    }

    const startOTA = async() => {
      const reply = await cli.startOTA();
      if(reply.startsWith('Started: http')) {
        window.open(reply.replace('Started: ', ''));
      }
      else {
        showMessage(`Device replied: ${reply}`, 'info');
        disconnect();
      }
    }

    const hasChanges = computed(() => {
      const vars = app.device.vars;
      const varsDevice = app.device.varsDevice;
      for (const key of Object.keys(vars)) {
        if (!(key in varsDevice)) continue;
        if (JSON.stringify(vars[key]) !== JSON.stringify(varsDevice[key])) return true;
      }
      return !!app.device.password || !!app.device.importPrvKey
        || regionsChanged.value || aclChanged.value;
    });

    /**
     * Load a region tree from an exported config. Regions the device already
     * has keep their uid so the save diff stays minimal instead of recreating
     * everything.
     */
    const importRegions = (imported) => {
      const uidByDeviceName = new Map(regionsDevice.list.map((r) => [r.name, r.uid]));
      const uidByName = new Map([['*', ROOT_UID]]);

      const list = (imported.list || []).map((r) => {
        const name = String(r.name ?? '');
        const uid = name === '*' ? ROOT_UID : (uidByDeviceName.get(name) ?? nextUid());
        uidByName.set(name, uid);
        return { uid, name, _parent: r.parent, flood: !!r.flood };
      });

      // An exported tree always carries its root; synthesise one if it does not
      if (!list.some((r) => r.uid === ROOT_UID)) {
        list.unshift({ uid: ROOT_UID, name: '*', _parent: null, flood: true });
      }

      for (const r of list) {
        r.parentUid = r.uid === ROOT_UID
          ? null
          : (r._parent == null ? ROOT_UID : (uidByName.get(String(r._parent)) ?? ROOT_UID));
        delete r._parent;
      }

      regions.list = list;
      regions.homeUid = imported.home && imported.home !== '*'
        ? (uidByName.get(String(imported.home)) ?? ROOT_UID)
        : ROOT_UID;
      regions.defaultUid = imported.default
        ? (uidByName.get(String(imported.default)) ?? '')
        : '';
    };

    const importAcl = (imported) => {
      const uidByPubKey = new Map(aclDevice.list.map((c) => [c.pubkey, c.uid]));
      acl.list = (Array.isArray(imported) ? imported : []).map((c) => {
        const pubkey = String(c.pubkey ?? '').trim().toLowerCase();
        return {
          uid: uidByPubKey.get(pubkey) ?? nextUid(),
          pubkey,
          perms: Number(c.perms) || SerialCLI.PERM_READ_WRITE,
        };
      });
    };

    const exportConfig = async () => {
      const vars = app.device.vars;
      const varsDevice = app.device.varsDevice;
      const plainVars = {};
      for (const key of Object.keys(vars)) {
        if (!(key in varsDevice)) continue;
        if (!supportsVar(key)) continue;
        const val = vars[key];
        plainVars[key] = typeof val === 'object' && val !== null ? { ...val } : val;
      }
      try {
        const prvKeyResponse = await cli.getVariable('prv.key');
        const prvKey = cli.parseVariableResponse(prvKeyResponse);
        if (prvKey) plainVars['prv.key'] = prvKey;
      } catch (e) {
        console.warn('Could not read prv.key', e);
      }
      const data = { vars: plainVars };

      if (regionsEditable.value) {
        data.regions = {
          default: regionName(regions.defaultUid) || null,
          home: regionName(regions.homeUid) || '*',
          list: regions.list.map((r) => ({
            name: r.name,
            parent: r.parentUid === null ? null : (regionName(r.parentUid) || '*'),
            flood: r.flood,
          })),
        };
      }

      if (acl.supported) {
        data.acl = acl.list.map((c) => ({ pubkey: c.pubkey, perms: c.perms }));
      }

      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const safeName = (s) => (s || '').replace(/[^a-zA-Z0-9_-]/g, '_');
      a.download = `config-${safeName(app.device.role) || 'unknown'}-${safeName(app.device.vars.name) || 'noname'}.json`;
      a.click();
      URL.revokeObjectURL(url);
      showMessage('Configuration exported.', 'download');
    };

    const importConfig = () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json';
      input.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        try {
          const text = await file.text();
          const data = JSON.parse(text);
          if (!data.vars) {
            alert('Invalid config file: missing vars.');
            return;
          }
          const vars = app.device.vars;
          for (const key of Object.keys(vars)) {
            if (key in data.vars && supportsVar(key)) {
              vars[key] = typeof data.vars[key] === 'object'
                ? { ...data.vars[key] }
                : data.vars[key];
            }
          }
          if (data.vars['prv.key']) {
            app.device.importPrvKey = data.vars['prv.key'];
          }

          const skipped = [];
          if (data.regions) {
            if (regionsEditable.value) importRegions(data.regions);
            else skipped.push('regions');
          }
          if (data.acl) {
            if (acl.supported) importAcl(data.acl);
            else skipped.push('access list');
          }

          showMessage(
            skipped.length
              ? `Configuration imported (${skipped.join(' and ')} skipped, not supported by this device).`
              : 'Configuration imported.',
            'upload'
          );
        } catch (err) {
          alert(`Import failed: ${err.message}`);
        }
      };
      input.click();
    };

    const copyPrvKey = async () => {
      if (!confirm(
        'WARNING: Your private key is a secret that uniquely identifies this device.\n\n' +
        'Never share it publicly. Anyone with this key can impersonate your node.\n\n' +
        'Copy to clipboard?'
      )) return;
      try {
        await navigator.clipboard.writeText(app.device.prvKey);
        showMessage('Private key copied to clipboard.', 'content_copy');
      } catch (e) {
        alert('Failed to copy to clipboard.');
      }
    };

    const sendAdvert = async() => {
      const reply = await cli.sendAdvert();
      showMessage(`Device replied: ${reply}`, 'info');
    }

    const connect = async() => {
      app.connecting = true;
      try {
        await cli.connect();
        await cli.setTime((Date.now() / 1000) | 0);
        showMessage('Time sync: OK');
        await getData();
        app.connected = true;
        app.locked = false;
      }
      catch(err) {
        alert(`Cannot connect: ${err.message}`);
      }
      finally {
        app.connecting = false;
      }
      await getPresets();
      console.log(app);
    }

    const disconnect = async() => {
      await cli.disconnect();
      app.connecting = app.connected = false;
      app.locked = true;
    }

    // Commands accepted by the current MeshCore CommonCLI, plus the
    // repeater / room-server extras. Used for console auto-complete.
    const consoleCommands = [
      // device / session
      'ver', 'board', 'reboot', 'clkreboot', 'poweroff', 'shutdown',
      'clock', 'clock sync', 'time', 'start ota', 'erase',
      'advert', 'advert.zerohop', 'password',
      'neighbors', 'neighbor.remove', 'discover.neighbors',
      'clear stats', 'stats-core', 'stats-radio', 'stats-packets',
      'log', 'log start', 'log stop', 'log erase',
      'tempradio', 'powersaving', 'powersaving on', 'powersaving off',
      // identity & access
      'get public.key', 'get prv.key', 'set prv.key', 'get role',
      'get acl', 'setperm',
      'get guest.password', 'set guest.password',
      'get allow.read.only', 'set allow.read.only',
      // node
      'get name', 'set name', 'get lat', 'set lat', 'get lon', 'set lon',
      'get owner.info', 'set owner.info',
      'get repeat', 'set repeat',
      // radio
      'get radio', 'set radio', 'get freq', 'set freq', 'get tx', 'set tx',
      'get af', 'set af', 'get dutycycle', 'set dutycycle',
      'get cad', 'set cad', 'get int.thresh', 'set int.thresh',
      'get radio.rxgain', 'set radio.rxgain',
      'get rxdelay', 'set rxdelay',
      'get txdelay', 'set txdelay', 'get direct.txdelay', 'set direct.txdelay',
      'get agc.reset.interval', 'set agc.reset.interval',
      'get path.hash.mode', 'set path.hash.mode',
      'get multi.acks', 'set multi.acks',
      'get extra.sf', 'set extra.sf',
      'get adc.multiplier', 'set adc.multiplier',
      // routing & advertising
      'get advert.interval', 'set advert.interval',
      'get flood.advert.interval', 'set flood.advert.interval',
      'get flood.max', 'set flood.max',
      'get flood.max.unscoped', 'set flood.max.unscoped',
      'get flood.max.advert', 'set flood.max.advert',
      'get loop.detect', 'set loop.detect',
      // regions
      'region', 'region def', 'region load', 'region save',
      'region put', 'region remove', 'region get', 'region list',
      'region allowf', 'region denyf',
      'region home', 'region default',
      // gps
      'gps', 'gps on', 'gps off', 'gps sync', 'gps setloc', 'gps advert',
      // sensors
      'sensor list', 'sensor get', 'sensor set',
      // bridge
      'get bridge.type', 'get bridge.enabled', 'set bridge.enabled',
      'get bridge.delay', 'set bridge.delay',
      'get bridge.source', 'set bridge.source',
      'get bridge.baud', 'set bridge.baud',
      'get bridge.channel', 'set bridge.channel',
      'get bridge.secret', 'set bridge.secret',
      // power / platform
      'get bootloader.ver',
      'get pwrmgt.support', 'get pwrmgt.source',
      'get pwrmgt.bootreason', 'get pwrmgt.bootmv',
    ];

    const consoleSuggestion = ref('');

    const consoleDialog = ref();
    const consoleOutput = ref();
    const consoleCmdInput = ref();
    const consoleLog = reactive([]);
    const consoleCmd = ref('');
    const consoleBusy = ref(false);
    const consoleHistory = reactive([]);
    const consoleHistoryIndex = ref(-1);

    const openConsole = () => {
      consoleDialog.value.show();
      setTimeout(() => consoleCmdInput.value?.focus(), 100);
    };

    const consoleFocus = () => {
      if (!window.getSelection().toString()) {
        consoleCmdInput.value?.focus();
      }
    };

    const consoleCopy = async () => {
      const selected = window.getSelection().toString();
      if (selected) {
        try {
          await navigator.clipboard.writeText(selected);
          showMessage('Copied to clipboard', 'content_copy');
        } catch (e) {}
      }
    };

    const scrollConsole = () => {
      setTimeout(() => {
        if (consoleOutput.value) {
          consoleOutput.value.scrollTop = consoleOutput.value.scrollHeight;
        }
      }, 10);
    };

    // `region load` does not read anything back - it puts the device into a modal
    // bulk-import state where every following line is a region in an indented
    // tree, and a blank line commits the lot. While that is active the console
    // has to allow an empty submission, otherwise there is no way back out.
    const regionLoadMode = ref(false);

    const consoleSendOptions = (cmd) => {
      // In load mode only the terminating blank line produces a reply
      if (regionLoadMode.value) return cmd ? { mode: 'collect', idleMs: 150 } : undefined;
      // These print straight to the port with no "  -> " marker
      if (/^region\s+load$/i.test(cmd)) return { mode: 'collect' };
      if (/^get\s+acl$/i.test(cmd)) return { mode: 'collect' };
      if (/^log$/i.test(cmd)) return { mode: 'collect', idleMs: 800, timeoutMs: 60000 };
      return undefined;
    };

    const sendConsoleCmd = async () => {
      if (consoleBusy.value) return;
      const cmd = consoleCmd.value.trim();
      if (!cmd && !regionLoadMode.value) return;

      if (cmd) {
        consoleHistory.unshift(cmd);
        if (consoleHistory.length > 50) consoleHistory.pop();
      }
      consoleHistoryIndex.value = -1;

      consoleLog.push({ type: 'cmd', text: `> ${cmd}` });
      consoleCmd.value = '';
      consoleBusy.value = true;
      scrollConsole();

      try {
        const reply = await cli.sendCommand(cmd, consoleSendOptions(cmd));
        if (reply) consoleLog.push({ type: 'reply', text: reply });

        if (regionLoadMode.value) {
          if (!cmd) regionLoadMode.value = false;   // blank line committed the tree
        } else if (/^region\s+load$/i.test(cmd)) {
          regionLoadMode.value = true;
          consoleLog.push({
            type: 'reply',
            text: 'Region load started. Enter one region per line, indented by depth '
              + '(e.g. " EU F", "  DE"). Submit an empty line to commit and exit. '
              + 'Regions you do not list are dropped, and the home and default '
              + 'regions are reset.',
          });
        }
      } catch (err) {
        consoleLog.push({ type: 'error', text: `Error: ${err.message}` });
      }

      consoleBusy.value = false;
      scrollConsole();
      consoleCmdInput.value?.focus();
    };

    const updateConsoleSuggestion = () => {
      const input = consoleCmd.value.toLowerCase();
      if (!input) { consoleSuggestion.value = ''; return; }
      const match = consoleCommands.find(c => c.startsWith(input) && c !== input);
      consoleSuggestion.value = match ? match.slice(input.length) : '';
    };

    const consoleTab = () => {
      const input = consoleCmd.value.toLowerCase();
      if (!input) return;
      const match = consoleCommands.find(c => c.startsWith(input) && c !== input);
      if (match) {
        consoleCmd.value = match;
        consoleSuggestion.value = '';
      }
    };

    watch(consoleCmd, updateConsoleSuggestion);

    const consoleHistoryUp = () => {
      if (consoleHistory.length === 0) return;
      if (consoleHistoryIndex.value < consoleHistory.length - 1) {
        consoleHistoryIndex.value++;
        consoleCmd.value = consoleHistory[consoleHistoryIndex.value];
      }
    };

    const consoleHistoryDown = () => {
      if (consoleHistoryIndex.value > 0) {
        consoleHistoryIndex.value--;
        consoleCmd.value = consoleHistory[consoleHistoryIndex.value];
      } else {
        consoleHistoryIndex.value = -1;
        consoleCmd.value = '';
      }
    };

    return {
      app, connect, disconnect,
      reboot, erase, sendAdvert, startOTA,
      statsDialog, stats, statsRows, openStats, refreshStats,
      setData, snackbar, showMessage, setRadioPreset,
      mapDialog, showMap, setMapLatLon, requestLocation,
      dutyCycle, ownerInfoBytes, onOwnerInfoInput,
      hasChanges, exportConfig, importConfig, copyPrvKey,
      nameBytes, nameMaxBytes, onNameInput,
      vanityDialog, vanity,
      openVanityDialog, closeVanityDialog, startVanityGen, cancelVanityGen, applyVanityKey,
      regions, regionsEditable, regionsChanged, regionChoices, addRegion, deleteRegion,
      regionParents, isValidRegionName, ROOT_UID,
      acl, aclChanged, ACL_ROLES, aclRole, setAclRole, isValidPubKey,
      addAclEntry, deleteAclEntry,
      consoleDialog, consoleOutput, consoleCmdInput, consoleLog, consoleCmd, consoleBusy,
      openConsole, sendConsoleCmd, consoleHistoryUp, consoleHistoryDown, regionLoadMode,
      consoleFocus, consoleCopy, consoleTab, consoleSuggestion,
      supportsVar, hasVar
    }
  },
}).mount('#app');
