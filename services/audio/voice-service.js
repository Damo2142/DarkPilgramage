/**
 * Voice Service — FIX-D
 *
 * Echo/Alexa TTS has been removed entirely. This service is now a thin
 * dispatcher that turns voice events into ElevenLabs TTS calls and emits
 * routed audio events the dashboard browser plays via Web Audio API
 * setSinkId on the configured output devices.
 *
 * Channels (strict, no mixing):
 *
 *   max:audio          → DM earbud sink only (Max whispers, ElevenLabs)
 *   max:audio:speak    → DM earbud sink only (Web Speech API fallback)
 *   npc:audio          → Room speaker sink only (public NPC dialogue)
 *   npc:audio:player   → Specific player Chromebook only (private NPC)
 *   sound:play         → Room speaker sink (SFX, ambient, atmosphere)
 *
 * No Echo, no Alexa cookie, no SSML, no behaviors API. Web Audio API
 * playback in the browser is the only output path.
 */

const fs = require('fs');
const path = require('path');

const ELEVENLABS_TTS_URL = (voiceId) =>
  `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`;
const ELEVENLABS_MODEL = 'eleven_turbo_v2_5';
const ELEVENLABS_SETTINGS = { stability: 0.75, similarity_boost: 0.80, style: 0.20 };

class VoiceService {
  constructor() {
    this.name = 'voice';
    this.orchestrator = null;
    this._enabled = true;
    this._maxPaused = false;
    this._maxPausedUntil = 0;
    this._maxVolume = 0.7;
  }

  async init(orchestrator) {
    this.orchestrator = orchestrator;
    this.bus = orchestrator.bus;
    this.state = orchestrator.state;
    this.config = orchestrator.config;

    // ElevenLabs voice palette — read from process.env (with config fallback).
    // Voice codes M1..M3 / F1..F3 are referenced by NPCs in session-0.json
    // via their `voiceCode` field.
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
    this.elevenLabsHealth = {
      status: 'UNKNOWN',
      lastCheckedAt: null,
      lastError: null,
      voiceIdsConfigured: Object.values(this.voicePalette).filter(v => v && v.length).length,
      voiceIdsTotal: 7
    };

    // Cache directories for generated MP3s
    this.maxCacheDir = path.join(__dirname, '..', '..', 'assets', 'sounds', 'max');
    this.npcCacheDir = path.join(__dirname, '..', '..', 'assets', 'sounds', 'npc');
    try { fs.mkdirSync(this.maxCacheDir, { recursive: true }); } catch (e) {}
    try { fs.mkdirSync(this.npcCacheDir, { recursive: true }); } catch (e) {}
  }

  async start() {
    this._subscribeEvents();

    // ElevenLabs health check (real TTS endpoint, FIX-B4)
    this.checkElevenLabsHealth(true).then(h => {
      console.log('[VoiceService] ElevenLabs ' + h.status +
        ' (' + this.elevenLabsHealth.voiceIdsConfigured + '/' + this.elevenLabsHealth.voiceIdsTotal + ' voice IDs configured)' +
        (h.lastError ? ' — ' + h.lastError : ''));
    }).catch(() => {});
    if (!this._healthInterval) {
      this._healthInterval = setInterval(() => this.checkElevenLabsHealth(true).catch(() => {}), 5 * 60 * 1000);
    }

    console.log('[VoiceService] Ready — Web Audio mode (no Echo/Alexa). ' +
      'Max → DM earbud, NPC public → Room speaker, NPC private → player Chromebook.');
  }

  stop() {
    if (this._healthInterval) { clearInterval(this._healthInterval); this._healthInterval = null; }
  }

  // ── Status ─────────────────────────────────────────────────────────

  getStatus() {
    return {
      status: this._enabled ? 'running' : 'disabled',
      mode: 'web-audio',
      voicePalette: this.voicePaletteStatus(),
      elevenLabs: this.elevenLabsHealth,
      maxPaused: this.isMaxPaused(),
      maxPausedUntil: this._maxPausedUntil || 0,
      maxVolume: this._maxVolume
    };
  }

  voicePaletteStatus() {
    const result = {};
    for (const [k, v] of Object.entries(this.voicePalette || {})) {
      result[k] = { configured: !!(v && v.length), preview: v ? (v.slice(0, 6) + '…') : '' };
    }
    return result;
  }

  // ── ElevenLabs health ──────────────────────────────────────────────

  async checkElevenLabsHealth(force = false) {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    const voiceId = process.env.MAX_VOICE_ID;
    const now = Date.now();
    if (!force && this._lastHealthAt && (now - this._lastHealthAt) < 60 * 1000) {
      return this.elevenLabsHealth;
    }
    this._lastHealthAt = now;
    this.elevenLabsHealth.lastCheckedAt = new Date().toISOString();

    if (!apiKey) {
      this.elevenLabsHealth.status = 'NO_KEY';
      this.elevenLabsHealth.lastError = 'ELEVENLABS_API_KEY not set in environment';
      this._dispatchHealth();
      return this.elevenLabsHealth;
    }
    if (!voiceId) {
      this.elevenLabsHealth.status = 'NO_VOICE_ID';
      this.elevenLabsHealth.lastError = 'MAX_VOICE_ID not set in environment';
      this._dispatchHealth();
      return this.elevenLabsHealth;
    }

    try {
      const fetchFn = global.fetch || require('node-fetch');
      const resp = await fetchFn(ELEVENLABS_TTS_URL(voiceId), {
        method: 'POST',
        headers: {
          'Accept': 'audio/mpeg',
          'Content-Type': 'application/json',
          'xi-api-key': apiKey
        },
        body: JSON.stringify({
          text: '.',
          model_id: ELEVENLABS_MODEL,
          voice_settings: ELEVENLABS_SETTINGS
        })
      });
      if (resp.status === 200 || resp.status === 206 || resp.status === 422) {
        this.elevenLabsHealth.status = 'ONLINE';
        this.elevenLabsHealth.lastError = null;
        try { await resp.arrayBuffer(); } catch (e) {}
      } else if (resp.status === 401) {
        this.elevenLabsHealth.status = 'INVALID_KEY';
        this.elevenLabsHealth.lastError = '401 — key invalid or revoked';
      } else if (resp.status === 429) {
        this.elevenLabsHealth.status = 'RATE_LIMITED';
        this.elevenLabsHealth.lastError = '429 — rate limited';
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
    this._dispatchHealth();
    return this.elevenLabsHealth;
  }

  _dispatchHealth() {
    if (this.bus) this.bus.dispatch('elevenlabs:health', this.elevenLabsHealth);
  }

  // ── Pause / volume control ─────────────────────────────────────────

  pauseMax(durationMs) {
    this._maxPaused = true;
    this._maxPausedUntil = Date.now() + (durationMs || 5 * 60 * 1000);
    if (this.bus) this.bus.dispatch('max:paused', { until: this._maxPausedUntil });
    console.log('[VoiceService] Max paused for ' + Math.round((durationMs || 300000) / 1000) + 's');
  }
  resumeMax() {
    this._maxPaused = false;
    this._maxPausedUntil = 0;
    if (this.bus) this.bus.dispatch('max:resumed', { at: Date.now() });
    console.log('[VoiceService] Max resumed');
  }
  isMaxPaused() {
    if (this._maxPaused && this._maxPausedUntil > Date.now()) return true;
    if (this._maxPaused) {
      this._maxPaused = false;
      if (this.bus) this.bus.dispatch('max:resumed', { at: Date.now() });
    }
    return false;
  }

  // ── Event subscriptions ────────────────────────────────────────────

  _subscribeEvents() {
    // FIX-C1 — strict channel separation enforced here.
    this.bus.subscribe('voice:speak', (env) => {
      const { text, profile, useElevenLabs } = env.data || {};
      if (!text) return;
      if (profile === 'max' || profile === 'hal' || useElevenLabs) {
        // Max → DM earbud only
        this._speakMax(text);
      } else {
        // Anything else from voice:speak with no profile is treated as
        // narrator/room-speaker output. NPC dialogue should come via
        // npc:approved instead.
        this._speakRoom(text, profile || 'narrator');
      }
    }, 'voice-service');

    this.bus.subscribe('npc:approved', (env) => {
      this._onNpcDialogue(env.data || {});
    }, 'voice-service');

    this.bus.subscribe('codm:read_aloud', (env) => {
      const text = env.data && env.data.text;
      if (text) this._speakRoom(text, 'narrator');
    }, 'voice-service');

    this.bus.subscribe('voice:enable', (env) => {
      this._enabled = !!(env.data && env.data.enabled);
    }, 'voice-service');

    this.bus.subscribe('voice:list_devices', () => {
      // No physical Echo devices anymore — list the logical channels
      this.bus.dispatch('voice:devices', {
        devices: [
          { key: 'room',   name: 'Room Speaker (PC)',     family: 'browser', online: true },
          { key: 'earbud', name: 'DM Earbud (PC)',        family: 'browser', online: true },
          { key: 'player', name: 'Player Chromebook',     family: 'browser', online: true }
        ]
      });
    }, 'voice-service');

    this.bus.subscribe('atmo:profile_active', (env) => {
      this._onAtmosphereChange(env.data || {});
    }, 'voice-service');

    this.bus.subscribe('audio:directional', (env) => {
      // Old directional path used Echo devices in other rooms. Without those
      // we still want the SFX to play — route to the room speaker via the
      // existing browser sound:play handler.
      const { effect, text, profile } = env.data || {};
      if (effect && this.bus) this.bus.dispatch('sound:play', { name: effect, channel: 'room' });
      if (text) this._speakRoom(text, profile || 'narrator');
    }, 'voice-service');

    this.bus.subscribe('audio:sfx', (env) => {
      const { effect } = env.data || {};
      if (effect && this.bus) this.bus.dispatch('sound:play', { name: effect, channel: 'room' });
    }, 'voice-service');

    this.bus.subscribe('audio:volume', (env) => {
      // Forwarded to the dashboard browser via wildcard broadcast — no Alexa command
      const { volume, channel } = env.data || {};
      if (this.bus) this.bus.dispatch('audio:volume_changed', { volume, channel });
    }, 'voice-service');

    this.bus.subscribe('session:ended', () => {
      // No directional Echo loop to stop anymore
    }, 'voice-service');
  }

  // ── NPC dialogue ───────────────────────────────────────────────────

  _onNpcDialogue(data) {
    const { text, npc, npcId } = data || {};
    if (!text) return;

    // Private NPC dialogue: route to the requesting player only.
    // The browser audio path uses npc:audio:player; comm-router still
    // dispatches the existing player:npc_speech for the text overlay.
    if (data._private && data._sourcePlayerId) {
      this._speakPlayerPrivate(text, npc || npcId || 'NPC', data._sourcePlayerId, this._npcVoiceId(data));
      return;
    }

    // Public NPC dialogue → room speaker
    this._speakNpcPublic(text, npc || npcId || 'NPC', this._npcVoiceId(data));
  }

  /**
   * Resolve an ElevenLabs voice id for an NPC dialogue payload.
   * Looks up the NPC's voiceCode (M1..F3) in the configured palette.
   * Returns the MAX_VOICE_ID as a last resort so audio still plays.
   */
  _npcVoiceId(data) {
    if (!data) return this.voicePalette.MAX || '';
    const npcId = data.npcId;
    let voiceCode = data.voiceCode;
    if (!voiceCode && npcId) {
      // Look up the NPC in state.npcs first, then config root
      const npcState = this.state && this.state.get(`npcs.${npcId}`);
      const npcCfg = (this.config && (this.config.npcs && this.config.npcs[npcId]) || (this.config && this.config[npcId])) || null;
      voiceCode = (npcState && npcState.voiceCode) || (npcCfg && npcCfg.voiceCode) || null;
    }
    if (voiceCode && this.voicePalette[voiceCode]) return this.voicePalette[voiceCode];
    return this.voicePalette.M2 || this.voicePalette.M1 || this.voicePalette.MAX || '';
  }

  // ── Room speaker (PC) ──────────────────────────────────────────────

  async _speakRoom(text, profile) {
    if (!text) return;
    // Generate via ElevenLabs (using narrator voice = M2 fallback) and
    // dispatch npc:audio with channel='room' so the dashboard plays it
    // on the room speaker sink.
    const voiceId = this.voicePalette.M2 || this.voicePalette.M1 || this.voicePalette.MAX || '';
    const url = await this._elevenLabsToFile(text, voiceId, this.npcCacheDir, 'narr');
    if (url) {
      this.bus.dispatch('npc:audio', { url, text, channel: 'room', source: profile || 'narrator' });
    } else {
      // Silent fallback — no audio, just the text overlay
      this.bus.dispatch('npc:audio:speak', { text, channel: 'room', fallback: true });
    }
  }

  async _speakNpcPublic(text, npcName, voiceId) {
    if (!text) return;
    if (!voiceId) {
      this.bus.dispatch('npc:audio:speak', { text, channel: 'room', fallback: true, npc: npcName });
      return;
    }
    const url = await this._elevenLabsToFile(text, voiceId, this.npcCacheDir, 'npc');
    if (url) {
      this.bus.dispatch('npc:audio', { url, text, channel: 'room', npc: npcName });
    } else {
      this.bus.dispatch('npc:audio:speak', { text, channel: 'room', fallback: true, npc: npcName });
    }
  }

  // ── DM earbud (PC) ─────────────────────────────────────────────────

  async _speakMax(text) {
    if (!text) return;
    if (this.isMaxPaused()) {
      console.log('[VoiceService] Max paused — dropping speech: ' + text.slice(0, 60));
      return;
    }
    const apiKey = process.env.ELEVENLABS_API_KEY;
    const voiceId = process.env.MAX_VOICE_ID || this.voicePalette.MAX;
    if (!apiKey || !voiceId) {
      console.log('[VoiceService] Max: ElevenLabs unavailable, dispatching browser-TTS fallback to earbud');
      this.bus.dispatch('max:audio:speak', { text, fallback: true });
      return;
    }
    const t0 = Date.now();
    try {
      const fetchFn = global.fetch || require('node-fetch');
      const resp = await fetchFn(ELEVENLABS_TTS_URL(voiceId), {
        method: 'POST',
        headers: {
          'Accept': 'audio/mpeg',
          'Content-Type': 'application/json',
          'xi-api-key': apiKey
        },
        body: JSON.stringify({ text, model_id: ELEVENLABS_MODEL, voice_settings: ELEVENLABS_SETTINGS })
      });
      if (!resp.ok) {
        console.warn('[VoiceService] Max ElevenLabs failed (' + resp.status + '), browser-TTS fallback to earbud');
        this.bus.dispatch('max:audio:speak', { text, fallback: true });
        return;
      }
      const buf = await resp.arrayBuffer();
      const filename = 'max-' + Date.now() + '.mp3';
      fs.writeFileSync(path.join(this.maxCacheDir, filename), Buffer.from(buf));
      const latency = Date.now() - t0;
      console.log('[VoiceService] Max ElevenLabs success (' + latency + 'ms): ' + text.slice(0, 60));
      this.bus.dispatch('max:audio', {
        url: '/assets/sounds/max/' + filename,
        text,
        priority: 'high',
        source: 'max',
        latencyMs: latency
      });
      this.bus.dispatch('max:latency', { latencyMs: latency, text: text.slice(0, 60) });
    } catch (err) {
      console.error('[VoiceService] Max ElevenLabs error: ' + err.message);
      this.bus.dispatch('max:audio:speak', { text, fallback: true, error: err.message });
    }
  }

  // ── Player Chromebook (private NPC dialogue, narrator whispers) ────

  async _speakPlayerPrivate(text, npcName, playerId, voiceId) {
    if (!text || !playerId) return;
    if (!voiceId) {
      this.bus.dispatch('npc:audio:player', {
        playerId, npc: npcName, text, fallback: true
      });
      return;
    }
    const url = await this._elevenLabsToFile(text, voiceId, this.npcCacheDir, 'priv');
    if (url) {
      this.bus.dispatch('npc:audio:player', { playerId, npc: npcName, text, url });
    } else {
      this.bus.dispatch('npc:audio:player', { playerId, npc: npcName, text, fallback: true });
    }
  }

  // ── ElevenLabs file generator ──────────────────────────────────────

  async _elevenLabsToFile(text, voiceId, cacheDir, prefix) {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey || !voiceId) return null;
    try {
      const fetchFn = global.fetch || require('node-fetch');
      const resp = await fetchFn(ELEVENLABS_TTS_URL(voiceId), {
        method: 'POST',
        headers: {
          'Accept': 'audio/mpeg',
          'Content-Type': 'application/json',
          'xi-api-key': apiKey
        },
        body: JSON.stringify({ text, model_id: ELEVENLABS_MODEL, voice_settings: ELEVENLABS_SETTINGS })
      });
      if (!resp.ok) {
        console.warn('[VoiceService] TTS failed (' + resp.status + ') for ' + (prefix || 'voice') + ': ' + text.slice(0, 60));
        return null;
      }
      const buf = await resp.arrayBuffer();
      const filename = (prefix || 'voice') + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6) + '.mp3';
      fs.writeFileSync(path.join(cacheDir, filename), Buffer.from(buf));
      const url = '/assets/sounds/' + path.basename(cacheDir) + '/' + filename;
      return url;
    } catch (err) {
      console.error('[VoiceService] TTS error: ' + err.message);
      return null;
    }
  }

  // ── Atmosphere ─────────────────────────────────────────────────────

  _onAtmosphereChange(data) {
    const { audio } = data;
    if (audio && audio.ambient) {
      // sound-service still owns the ambient loop; route to room speaker
      this.bus.dispatch('sound:ambient', { name: audio.ambient, channel: 'room' });
    } else {
      this.bus.dispatch('sound:ambient', { name: null });
    }
  }
}

module.exports = VoiceService;
