/**
 * Voice Service — Phase G
 * Features 33-36: Alexa Echo TTS, per-NPC SSML voice profiles,
 * directional horror sounds, multi-room Echo output.
 *
 * Uses Amazon Alexa API directly via browser cookie auth.
 * Requires ALEXA_COOKIE and ALEXA_CSRF in .env (from alexa.amazon.com session).
 *
 * Ambient audio: atmosphere profile changes trigger ambient sounds on primary Echo.
 * Directional horror: random distant sounds from other Echoes based on horror level.
 */

const fs = require('fs');
const path = require('path');

// Echo device registry — serial, type, friendly name
const ECHO_DEVICES = {
  office_dot:    { serial: 'G090LF1174731565', type: 'A3S5BH2HU6VAYF', name: "David's Office Dot" },
  kitchen_echo:  { serial: 'G090P30882320A8J', type: 'A7WXQPH584YP',   name: "David's Kitchen Echo" },
  dining_room:   { serial: 'GR741P04538603GS', type: 'A1MR3F8QRZNAXI', name: 'Dining Room' },
  living_room:   { serial: 'GR741P04537500VD', type: 'A1MR3F8QRZNAXI', name: 'Living Room' },
  echo_auto:     { serial: 'G0W0SW089422F2GH', type: 'A303PJF6ISQ7IC', name: "David's Echo Auto" }
};

const CUSTOMER_ID = 'AFOPFN6YDLJ6R';

class VoiceService {
  constructor() {
    this.name = 'voice';
    this.orchestrator = null;
    this._speechQueue = [];
    this._speaking = false;
    this._enabled = false;
    this._cookie = null;
    this._csrf = null;
  }

  async init(orchestrator) {
    this.orchestrator = orchestrator;
    this.bus = orchestrator.bus;
    this.state = orchestrator.state;
    this.config = orchestrator.config;

    this.primaryDevice = this.config.voice?.primaryDevice || 'living_room';
    this.surroundDevices = this.config.voice?.surroundDevices || [];
    this.defaultVolume = this.config.voice?.defaultVolume || 60;

    // ElevenLabs voice palette — read from process.env (with config fallback)
    const cfgPalette = (this.config.voice && this.config.voice.palette) || {};
    this.voicePalette = {
      MAX: process.env.MAX_VOICE_ID || cfgPalette.MAX || '',
      M1:  process.env.VOICE_M1     || cfgPalette.M1  || '',
      M2:  process.env.VOICE_M2     || cfgPalette.M2  || '',
      M3:  process.env.VOICE_M3     || cfgPalette.M3  || '',
      F1:  process.env.VOICE_F1     || cfgPalette.F1  || '',
      F2:  process.env.VOICE_F2     || cfgPalette.F2  || '',
      F3:  process.env.VOICE_F3     || cfgPalette.F3  || ''
    };
    // ElevenLabs health state
    this.elevenLabsHealth = {
      status: 'UNKNOWN',
      lastCheckedAt: null,
      lastError: null,
      voiceIdsConfigured: 0,
      voiceIdsTotal: 7
    };
    this.elevenLabsHealth.voiceIdsConfigured = Object.values(this.voicePalette).filter(v => v && v.length).length;

    // NPC voice profiles — SSML prosody settings
    this.voiceProfiles = {
      innkeeper_marta: {
        rate: '95%', pitch: '+2st', volume: 'medium',
        prefix: '<amazon:effect name="whispered">', suffix: '</amazon:effect>'
      },
      trapper_tomas: {
        rate: '110%', pitch: '-3st', volume: 'loud',
        prefix: '', suffix: ''
      },
      stranger_hooded: {
        rate: '85%', pitch: '-5st', volume: 'soft',
        prefix: '', suffix: ''
      },
      spurt: {
        rate: '130%', pitch: '+5st', volume: 'x-loud',
        prefix: '', suffix: ''
      },
      patron_henryk: {
        rate: '90%', pitch: '-1st', volume: 'medium',
        prefix: '', suffix: ''
      },
      patron_aldric: {
        rate: '95%', pitch: '+0st', volume: 'medium',
        prefix: '', suffix: ''
      },
      patron_katya: {
        rate: '100%', pitch: '+3st', volume: 'medium',
        prefix: '', suffix: ''
      },
      patron_gregor: {
        rate: '80%', pitch: '-4st', volume: 'soft',
        prefix: '', suffix: ''
      },
      narrator: {
        rate: '90%', pitch: '-2st', volume: 'medium',
        prefix: '', suffix: ''
      }
    };

    // Directional horror — sounds that come from OTHER Echoes to create immersion
    // Grouped by horror level threshold (plays from random non-primary devices)
    this.directionalSounds = {
      low: [  // horror 1-3: subtle distant sounds
        { effect: 'wind', weight: 3 },
        { effect: 'door_creak', weight: 2 },
        { effect: 'footsteps', weight: 1 }
      ],
      mid: [  // horror 4-6: unsettling sounds from other rooms
        { effect: 'wolf_howl', weight: 2 },
        { effect: 'chains', weight: 2 },
        { effect: 'door_creak', weight: 2 },
        { effect: 'footsteps', weight: 3 },
        { effect: 'wind', weight: 1 }
      ],
      high: [ // horror 7-10: terrifying sounds everywhere
        { effect: 'wolf_howl', weight: 2 },
        { effect: 'scream', weight: 1 },
        { effect: 'chains', weight: 3 },
        { effect: 'glass_break', weight: 1 },
        { effect: 'heartbeat', weight: 2 },
        { effect: 'thunder', weight: 1 }
      ]
    };

    this._directionalInterval = null;
    this._currentHorrorLevel = 0;

    // Sound effects for Echo TTS — narrated descriptions (soundbank URLs don't work via behaviors API)
    // Real audio plays through browser (ElevenLabs MP3s). Echo narrates for directional horror.
    this.soundEffects = {
      thunder:       { text: 'Thunder crashes.', voice: 'narrator' },
      wolf_howl:     { text: 'A wolf howls in the distance.', voice: 'narrator' },
      door_creak:    { text: 'A door creaks open.', voice: 'narrator' },
      glass_break:   { text: 'Glass shatters.', voice: 'narrator' },
      scream:        { text: 'A scream echoes through the halls.', voice: 'narrator' },
      footsteps:     { text: 'Footsteps. Slow. Deliberate.', voice: 'narrator' },
      wind:          { text: 'The wind howls.', voice: 'narrator' },
      fire_crackling:{ text: 'The fire crackles.', voice: 'narrator' },
      chains:        { text: 'Chains rattle and drag across stone.', voice: 'narrator' },
      heartbeat:     { text: 'A heartbeat. Growing louder.', voice: 'narrator' },
      whisper:       { text: 'Something whispers your name.', voice: 'stranger_hooded' },
      breathing:     { text: 'Heavy breathing. Right behind you.', voice: 'narrator' },
      scratching:    { text: 'Something scratches at the wall. From inside.', voice: 'narrator' },
      bell:          { text: 'A distant bell tolls.', voice: 'narrator' },
      growl:         { text: 'A deep growl from the darkness.', voice: 'narrator' },
      rats:          { text: 'Rats. Scurrying in the walls.', voice: 'narrator' },
      bats:          { text: 'A rush of wings overhead.', voice: 'narrator' },
      sword_clash:   { text: 'Steel rings against steel.', voice: 'narrator' },
      splash:        { text: 'Something falls into deep water.', voice: 'narrator' }
    };
  }

  async start() {
    this._cookie = process.env.ALEXA_COOKIE;
    this._csrf = process.env.ALEXA_CSRF;

    if (!this._cookie || !this._csrf) {
      console.warn('[VoiceService] No ALEXA_COOKIE or ALEXA_CSRF in .env — Echo voice disabled');
      console.log('[VoiceService] To enable: log into alexa.amazon.com, get cookie and csrf token');
      console.log('[VoiceService] Add to .env: ALEXA_COOKIE="..." and ALEXA_CSRF="..."');
      this._subscribeEvents();
      // Still check ElevenLabs even if Alexa is offline — Max + NPC voice may still work
      this.checkElevenLabsHealth().then(h => {
        console.log('[VoiceService] ElevenLabs health: ' + h.status +
          ' (' + this.elevenLabsHealth.voiceIdsConfigured + '/' + this.elevenLabsHealth.voiceIdsTotal + ' voice IDs configured)' +
          (h.lastError ? ' — ' + h.lastError : ''));
      }).catch(() => {});
      return;
    }

    // Test connection
    try {
      const ok = await this._testConnection();
      if (ok) {
        this._enabled = true;
        console.log(`[VoiceService] Connected to Alexa — ${Object.keys(ECHO_DEVICES).length} devices configured`);
        console.log(`[VoiceService] Primary device: ${this.primaryDevice} (${ECHO_DEVICES[this.primaryDevice]?.name || 'unknown'})`);
      } else {
        console.warn('[VoiceService] Alexa connection test failed — cookie may be expired');
        console.log('[VoiceService] Refresh cookie from alexa.amazon.com');
      }
    } catch (err) {
      console.error('[VoiceService] Startup error:', err.message);
    }

    this._subscribeEvents();

    // Fire ElevenLabs health check on startup (non-blocking) and refresh hourly
    this.checkElevenLabsHealth().then(h => {
      console.log('[VoiceService] ElevenLabs health: ' + h.status +
        ' (' + this.elevenLabsHealth.voiceIdsConfigured + '/' + this.elevenLabsHealth.voiceIdsTotal + ' voice IDs configured)' +
        (h.lastError ? ' — ' + h.lastError : ''));
    }).catch(() => {});
    if (!this._healthInterval) {
      // FIX-B4 — refresh every 5 minutes (was hourly).
      // The internal throttle in checkElevenLabsHealth still rate-limits to 1/min.
      this._healthInterval = setInterval(() => this.checkElevenLabsHealth(true).catch(() => {}), 5 * 60 * 1000);
    }

    // Broadcast device list
    this.bus.dispatch('voice:devices', {
      devices: Object.entries(ECHO_DEVICES).map(([key, d]) => ({
        name: d.name,
        serial: d.serial,
        family: 'ECHO',
        key,
        online: true
      }))
    });
  }

  async _testConnection() {
    try {
      const res = await fetch('https://alexa.amazon.com/api/devices-v2/device?cached=false', {
        headers: {
          'Cookie': this._cookie,
          'csrf': this._csrf
        },
        signal: AbortSignal.timeout(10000)
      });
      console.log(`[VoiceService] Connection test: ${res.status}`);
      return res.status === 200;
    } catch (err) {
      console.error(`[VoiceService] Connection test error: ${err.message}`);
      return false;
    }
  }

  _subscribeEvents() {
    this.bus.subscribe('npc:approved', (env) => {
      this._onNpcDialogue(env.data);
    }, 'voice-service');

    this.bus.subscribe('codm:read_aloud', (env) => {
      this._speakNarration(env.data.text);
    }, 'voice-service');

    this.bus.subscribe('audio:sfx', (env) => {
      this._playSoundEffect(env.data);
    }, 'voice-service');

    this.bus.subscribe('audio:directional', (env) => {
      this._playDirectional(env.data);
    }, 'voice-service');

    this.bus.subscribe('audio:volume', (env) => {
      this._setVolume(env.data);
    }, 'voice-service');

    this.bus.subscribe('voice:speak', (env) => {
      const { text, profile, device, useElevenLabs } = env.data;
      // Section 8 — Max voice via ElevenLabs
      if (profile === 'max' || useElevenLabs) {
        this._speakMaxElevenLabs(text, device || 'earbud');
      } else {
        this.speak(text, profile || 'narrator', device);
      }
    }, 'voice-service');

    // Section 6 — voice/audio enable/disable from session mode transitions
    this.bus.subscribe('voice:enable', (env) => {
      this._enabled = !!env.data?.enabled;
      if (!this._enabled) this._speechQueue = [];
    }, 'voice-service');

    this.bus.subscribe('voice:list_devices', () => {
      this.bus.dispatch('voice:devices', {
        devices: Object.entries(ECHO_DEVICES).map(([key, d]) => ({
          name: d.name,
          serial: d.serial,
          family: 'ECHO',
          key,
          online: true
        }))
      });
    }, 'voice-service');

    // Atmosphere profile changes → ambient audio + directional horror
    this.bus.subscribe('atmo:profile_active', (env) => {
      this._onAtmosphereChange(env.data);
    }, 'voice-service');

    // Session lifecycle
    this.bus.subscribe('session:ended', () => {
      this._stopDirectional();
    }, 'voice-service');
  }

  stop() {
    this._speechQueue = [];
    this._speaking = false;
    this._stopDirectional();
  }

  // ── Ambient & Directional Audio ───────────────────────────────────

  _onAtmosphereChange(data) {
    const { profile, horrorLevel, audio } = data;
    this._currentHorrorLevel = horrorLevel || 0;

    console.log(`[VoiceService] Atmosphere: ${profile} (horror ${this._currentHorrorLevel})`);

    // Ambient audio handled by browser (dashboard SoundBoard) — dispatch event
    if (audio?.ambient) {
      this.bus.dispatch('sound:ambient', { name: audio.ambient, horrorLevel: this._currentHorrorLevel });
    } else {
      this.bus.dispatch('sound:ambient', { name: null });
    }

    // Start/adjust directional horror from other Echo devices based on horror level
    if (this._currentHorrorLevel > 0) {
      this._startDirectional(this._currentHorrorLevel);
    } else {
      this._stopDirectional();
    }
  }

  _startDirectional(horrorLevel) {
    this._stopDirectional();
    if (!this._enabled) return;

    // Get non-primary devices for directional sounds
    const otherDevices = Object.entries(ECHO_DEVICES)
      .filter(([key]) => key !== this.primaryDevice && key !== 'echo_auto')
      .map(([key, d]) => ({ key, ...d }));

    if (otherDevices.length === 0) return;

    // Pick sound pool based on horror level
    let pool;
    if (horrorLevel <= 3) pool = this.directionalSounds.low;
    else if (horrorLevel <= 6) pool = this.directionalSounds.mid;
    else pool = this.directionalSounds.high;

    // Interval: higher horror = more frequent (60s at low, 20s at high)
    const intervalMs = Math.max(20000, 70000 - (horrorLevel * 6000));

    console.log(`[VoiceService] Directional horror: level ${horrorLevel}, every ${Math.round(intervalMs/1000)}s, ${otherDevices.length} devices`);

    this._directionalInterval = setInterval(() => {
      if (!this._enabled) return;

      // Random chance to skip (keeps it unpredictable)
      if (Math.random() > 0.7) return;

      // Weighted random sound selection
      const chosen = this._weightedRandom(pool);
      if (!chosen) return;

      // Random device
      const device = otherDevices[Math.floor(Math.random() * otherDevices.length)];

      const effect = this.soundEffects[chosen.effect];
      if (!effect) return;

      console.log(`[VoiceService] Directional: ${chosen.effect} from ${device.name}`);
      this._alexaSpeak(device, this._buildEffectSSML(effect), true);
    }, intervalMs);
  }

  _stopDirectional() {
    if (this._directionalInterval) {
      clearInterval(this._directionalInterval);
      this._directionalInterval = null;
    }
  }

  _weightedRandom(pool) {
    const totalWeight = pool.reduce((sum, item) => sum + item.weight, 0);
    let roll = Math.random() * totalWeight;
    for (const item of pool) {
      roll -= item.weight;
      if (roll <= 0) return item;
    }
    return pool[pool.length - 1];
  }

  getStatus() {
    return {
      status: this._enabled ? 'running' : 'disabled',
      alexaConnected: this._enabled,
      primaryDevice: this.primaryDevice,
      surroundDevices: this.surroundDevices,
      devices: Object.keys(ECHO_DEVICES),
      profileCount: Object.keys(this.voiceProfiles).length,
      queueLength: this._speechQueue.length,
      speaking: this._speaking,
      soundEffects: Object.keys(this.soundEffects),
      ambientMode: 'browser',
      directionalActive: !!this._directionalInterval,
      horrorLevel: this._currentHorrorLevel,
      voicePalette: this.voicePaletteStatus(),
      elevenLabs: this.elevenLabsHealth
    };
  }

  voicePaletteStatus() {
    const result = {};
    for (const [k, v] of Object.entries(this.voicePalette || {})) {
      result[k] = { configured: !!(v && v.length), preview: v ? (v.slice(0, 6) + '…') : '' };
    }
    return result;
  }

  /**
   * FIX-B4 — Real ElevenLabs health check.
   *
   * Uses the SAME endpoint and authentication that Max uses for TTS
   * (POST /v1/text-to-speech/{voiceId}/stream with xi-api-key header).
   * If THIS specific call succeeds, Max will work; if it fails, the
   * error code is the actual one Max would hit. No more divergence
   * between health-check 401 and Max 200.
   *
   * The check is rate-limited to once every 60s by default; the auto-
   * refresh interval in start() is 5 minutes (FIX-B4 spec).
   */
  async checkElevenLabsHealth(force = false) {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    const voiceId = process.env.MAX_VOICE_ID;
    const now = Date.now();

    // Per-instance throttle: don't probe more than once per minute unless forced
    if (!force && this._lastHealthAt && (now - this._lastHealthAt) < 60 * 1000) {
      return this.elevenLabsHealth;
    }
    this._lastHealthAt = now;
    this.elevenLabsHealth.lastCheckedAt = new Date().toISOString();

    if (!apiKey) {
      this.elevenLabsHealth.status = 'NO_KEY';
      this.elevenLabsHealth.lastError = 'ELEVENLABS_API_KEY not set in environment';
      if (this.bus) this.bus.dispatch('elevenlabs:health', this.elevenLabsHealth);
      return this.elevenLabsHealth;
    }
    if (!voiceId) {
      this.elevenLabsHealth.status = 'NO_VOICE_ID';
      this.elevenLabsHealth.lastError = 'MAX_VOICE_ID not set in environment';
      if (this.bus) this.bus.dispatch('elevenlabs:health', this.elevenLabsHealth);
      return this.elevenLabsHealth;
    }

    try {
      const fetchFn = global.fetch || require('node-fetch');
      // Same path Max uses — minimal text + same model + same voice settings
      const resp = await fetchFn(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`, {
        method: 'POST',
        headers: {
          'Accept': 'audio/mpeg',
          'Content-Type': 'application/json',
          'xi-api-key': apiKey
        },
        body: JSON.stringify({
          text: '.', // single character — minimum billable
          model_id: 'eleven_turbo_v2_5',
          voice_settings: { stability: 0.75, similarity_boost: 0.80, style: 0.20 }
        })
      });

      if (resp.status === 200 || resp.status === 206) {
        this.elevenLabsHealth.status = 'ONLINE';
        this.elevenLabsHealth.lastError = null;
        // Drain body so the connection cleans up cleanly
        try { await resp.arrayBuffer(); } catch (e) {}
      } else if (resp.status === 401) {
        this.elevenLabsHealth.status = 'INVALID_KEY';
        this.elevenLabsHealth.lastError = '401 — key invalid or revoked (same call path Max uses)';
      } else if (resp.status === 422) {
        // 422 = unprocessable. Means key is valid + voice ID is valid; just complaining about the request.
        // For health-check purposes that means "would work for Max" — mark ONLINE.
        this.elevenLabsHealth.status = 'ONLINE';
        this.elevenLabsHealth.lastError = null;
      } else if (resp.status === 429) {
        this.elevenLabsHealth.status = 'RATE_LIMITED';
        this.elevenLabsHealth.lastError = '429 — rate limited (key is valid, just throttled)';
      } else {
        let body = '';
        try { body = (await resp.text()).slice(0, 200); } catch (e) {}
        this.elevenLabsHealth.status = 'ERROR';
        this.elevenLabsHealth.lastError = 'HTTP ' + resp.status + (body ? ' — ' + body : '');
      }
    } catch (e) {
      this.elevenLabsHealth.status = 'NETWORK_ERROR';
      this.elevenLabsHealth.lastError = e.message;
    }
    if (this.bus) this.bus.dispatch('elevenlabs:health', this.elevenLabsHealth);
    return this.elevenLabsHealth;
  }

  // ── Public API ─────────────────────────────────────────────────────

  _resolveDevice(deviceName) {
    if (!deviceName) return ECHO_DEVICES[this.primaryDevice];
    // Direct key match
    if (ECHO_DEVICES[deviceName]) return ECHO_DEVICES[deviceName];
    // Serial match
    for (const d of Object.values(ECHO_DEVICES)) {
      if (d.serial === deviceName) return d;
    }
    // Fuzzy name match
    const lower = deviceName.toLowerCase();
    for (const [key, d] of Object.entries(ECHO_DEVICES)) {
      if (d.name.toLowerCase().includes(lower) || key.includes(lower)) return d;
    }
    return ECHO_DEVICES[this.primaryDevice];
  }

  // Section 8 — Max voice via ElevenLabs (streamed to earbud channel)
  // Falls back to Echo TTS if ElevenLabs unavailable, MAX_VOICE_ID empty, or call fails.
  async _speakMaxElevenLabs(text, deviceName) {
    if (!text) return;
    const t0 = Date.now();
    const apiKey = process.env.ELEVENLABS_API_KEY;
    const voiceId = process.env.MAX_VOICE_ID;

    // Decision: skip ElevenLabs immediately if missing key or voice ID — no failed-call delay
    if (!apiKey || !voiceId) {
      console.log('[VoiceService] Max: ElevenLabs unavailable, falling back to Echo TTS');
      this.speak(text, 'narrator', deviceName || 'earbud');
      return;
    }

    try {
      const fetchFn = global.fetch || require('node-fetch');
      const resp = await fetchFn(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`, {
        method: 'POST',
        headers: {
          'Accept': 'audio/mpeg',
          'Content-Type': 'application/json',
          'xi-api-key': apiKey
        },
        body: JSON.stringify({
          text,
          model_id: 'eleven_turbo_v2_5',
          voice_settings: { stability: 0.75, similarity_boost: 0.80, style: 0.20 }
        })
      });

      if (!resp.ok) {
        console.warn(`[VoiceService] Max ElevenLabs failed (${resp.status}), falling back to Echo TTS`);
        this.speak(text, 'narrator', deviceName || 'earbud');
        return;
      }

      const buf = await resp.arrayBuffer();
      const fs = require('fs');
      const path = require('path');
      const cacheDir = path.join(__dirname, '..', '..', 'assets', 'sounds', 'max');
      try { fs.mkdirSync(cacheDir, { recursive: true }); } catch (e) {}
      const filename = `max-${Date.now()}.mp3`;
      const filepath = path.join(cacheDir, filename);
      fs.writeFileSync(filepath, Buffer.from(buf));

      const latency = Date.now() - t0;
      console.log(`[VoiceService] Max ElevenLabs success (${latency}ms): ${text.slice(0, 60)}`);

      // Dispatch sound:play event so dashboard browser plays it through earbud channel
      this.bus.dispatch('sound:play', {
        url: `/assets/sounds/max/${filename}`,
        device: 'earbud',
        priority: 'high',
        source: 'max'
      });

      // Latency log for FINAL_BUILD_NOTES
      this.bus.dispatch('max:latency', { latencyMs: latency, text: text.slice(0, 60) });

      // If latency exceeded 4s also fall back to Echo for next response (handled in halQuery)
    } catch (err) {
      console.error('[VoiceService] Max ElevenLabs error:', err.message);
      this.speak(text, 'narrator', deviceName || 'earbud');
    }
  }

  async speak(text, profileName, deviceName) {
    if (!this._enabled) return;

    const device = this._resolveDevice(deviceName);
    if (!device) return;

    const ssml = this._buildSSML(text, profileName);

    this._speechQueue.push({ text: ssml, isSSML: !!this.voiceProfiles[profileName], device });
    if (!this._speaking) {
      await this._processQueue();
    }
  }

  _buildEffectSSML(effect) {
    return this._buildSSML(effect.text, effect.voice || 'narrator');
  }

  async playSfx(effectName, deviceName) {
    if (!this._enabled) return;

    const effect = this.soundEffects[effectName];
    if (!effect) return;

    const device = this._resolveDevice(deviceName);
    if (!device) return;

    await this._alexaSpeak(device, this._buildEffectSSML(effect), true);
  }

  async playSfxAll(effectName) {
    if (!this._enabled) return;

    const effect = this.soundEffects[effectName];
    if (!effect) return;

    const ssml = this._buildEffectSSML(effect);
    const promises = Object.values(ECHO_DEVICES).map(d => this._alexaSpeak(d, ssml, true));
    await Promise.allSettled(promises);
  }

  // ── Event handlers ─────────────────────────────────────────────────

  _onNpcDialogue(data) {
    const { text, voiceProfile, npc } = data;
    if (!text) return;
    const profile = voiceProfile || 'narrator';
    const announcement = npc ? `${npc} says: ${text}` : text;
    this.speak(announcement, profile);
  }

  _speakNarration(text) {
    if (!text) return;
    this.speak(text, 'narrator');
  }

  _playSoundEffect(data) {
    const { effect, device, surround } = data;
    if (surround) {
      this.playSfxAll(effect);
    } else {
      this.playSfx(effect, device);
    }
  }

  _playDirectional(data) {
    const { effect, text, device, profile } = data;
    if (effect) this.playSfx(effect, device);
    if (text) this.speak(text, profile || 'narrator', device);
  }

  _setVolume(data) {
    if (!this._enabled) return;
    const { volume, device } = data;
    const dev = this._resolveDevice(device);
    if (!dev) return;
    this._alexaCommand(dev, 'volume', volume);
  }

  // ── SSML generation ────────────────────────────────────────────────

  _buildSSML(text, profileName) {
    const profile = this.voiceProfiles[profileName];
    if (!profile) return text;

    const parts = [];
    parts.push('<speak>');
    if (profile.prefix) parts.push(profile.prefix);
    parts.push(`<prosody rate="${profile.rate}" pitch="${profile.pitch}" volume="${profile.volume}">`);
    parts.push(this._escapeSSML(text));
    parts.push('</prosody>');
    if (profile.suffix) parts.push(profile.suffix);
    parts.push('</speak>');
    return parts.join('');
  }

  _escapeSSML(text) {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  // ── Speech queue ───────────────────────────────────────────────────

  async _processQueue() {
    if (this._speaking || this._speechQueue.length === 0) return;
    this._speaking = true;

    while (this._speechQueue.length > 0) {
      const item = this._speechQueue.shift();
      try {
        await this._alexaSpeak(item.device, item.text, item.isSSML);

        // Estimate speech duration — ~150ms per word, min 2s
        const plainText = item.text.replace(/<[^>]*>/g, '');
        const wordCount = plainText.split(/\s+/).length;
        const waitMs = Math.max(2000, wordCount * 150);
        await this._sleep(waitMs);
      } catch (err) {
        console.error(`[VoiceService] Speech failed on ${item.device.name}: ${err.message}`);
      }
    }

    this._speaking = false;
  }

  // ── Alexa API ──────────────────────────────────────────────────────

  async _alexaSpeak(device, text, isSSML) {
    const operationPayload = {
      deviceType: device.type,
      deviceSerialNumber: device.serial,
      locale: 'en-US',
      customerId: CUSTOMER_ID
    };

    // Use SSML or plain text
    if (isSSML || text.startsWith('<speak>')) {
      operationPayload.textToSpeak = text;
    } else {
      operationPayload.textToSpeak = text;
    }

    const node = {
      '@type': 'com.amazon.alexa.behaviors.model.OpaquePayloadOperationNode',
      type: 'Alexa.Speak',
      operationPayload
    };

    const sequence = {
      '@type': 'com.amazon.alexa.behaviors.model.Sequence',
      startNode: node
    };

    const body = {
      behaviorId: 'PREVIEW',
      sequenceJson: JSON.stringify(sequence),
      status: 'ENABLED'
    };

    try {
      const res = await fetch('https://alexa.amazon.com/api/behaviors/preview', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cookie': this._cookie,
          'csrf': this._csrf
        },
        body: JSON.stringify(body)
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        console.error(`[VoiceService] Alexa API ${res.status}: ${errText.slice(0, 200)}`);
        if (res.status === 401) {
          console.error('[VoiceService] Cookie expired — update ALEXA_COOKIE and ALEXA_CSRF in .env');
          this._enabled = false;
        }
      }
    } catch (err) {
      console.error(`[VoiceService] Alexa request failed: ${err.message}`);
    }
  }

  async _alexaCommand(device, command, value) {
    // Volume control via device commands API
    if (command === 'volume') {
      const body = {
        behaviorId: 'PREVIEW',
        sequenceJson: JSON.stringify({
          '@type': 'com.amazon.alexa.behaviors.model.Sequence',
          startNode: {
            '@type': 'com.amazon.alexa.behaviors.model.OpaquePayloadOperationNode',
            type: 'Alexa.DeviceControls.Volume',
            operationPayload: {
              deviceType: device.type,
              deviceSerialNumber: device.serial,
              locale: 'en-US',
              customerId: CUSTOMER_ID,
              value: value
            }
          }
        }),
        status: 'ENABLED'
      };

      try {
        await fetch('https://alexa.amazon.com/api/behaviors/preview', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Cookie': this._cookie,
            'csrf': this._csrf
          },
          body: JSON.stringify(body)
        });
      } catch (err) {
        console.error(`[VoiceService] Volume command failed: ${err.message}`);
      }
    }
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = VoiceService;
