/**
 * Sound Service — ElevenLabs SFX Integration
 * Generates and caches horror sound effects as MP3 files.
 * Serves them via Express for browser audio playback.
 * Pre-generates a library of core sounds on first run.
 */

const fs = require('fs');
const path = require('path');

const SOUNDS_DIR = path.join(__dirname, '..', '..', 'assets', 'sounds');

// Core sound library — pre-generated on first run
const CORE_SOUNDS = {
  // One-shot effects
  thunder:        { prompt: 'Loud thunder crack and rolling rumble, stormy night', duration: 6 },
  wolf_howl:      { prompt: 'Single wolf howling in the distance on a cold mountain night', duration: 8 },
  door_creak:     { prompt: 'Old heavy wooden door creaking open slowly in a stone corridor', duration: 4 },
  glass_break:    { prompt: 'Glass window shattering violently', duration: 3 },
  scream:         { prompt: 'Distant terrified scream echoing through stone halls, horror', duration: 4 },
  footsteps:      { prompt: 'Slow deliberate footsteps on old wooden floorboards, creepy', duration: 6 },
  wind:           { prompt: 'Howling wind through cracks in old stone walls, eerie', duration: 8 },
  chains:         { prompt: 'Heavy iron chains dragging and rattling across stone dungeon floor', duration: 5 },
  heartbeat:      { prompt: 'Deep slow heartbeat getting progressively louder and faster, tension', duration: 8 },
  bell:           { prompt: 'Single distant church bell toll, somber and echoing', duration: 6 },
  whisper:        { prompt: 'Unintelligible sinister whisper, multiple overlapping voices, horror', duration: 4 },
  breathing:      { prompt: 'Heavy ragged breathing in darkness, close and menacing', duration: 5 },
  scratching:     { prompt: 'Something scratching and clawing at wood from inside a wall', duration: 5 },
  sword_clash:    { prompt: 'Medieval sword clashing against sword, combat, steel ringing', duration: 3 },
  arrow:          { prompt: 'Arrow whistling through the air and hitting wood with a thunk', duration: 2 },
  bone_crack:     { prompt: 'Sickening bone crack and snap, horror', duration: 2 },
  growl:          { prompt: 'Deep guttural monster growl, low and threatening, horror', duration: 4 },
  splash:         { prompt: 'Something heavy falling into deep water, underground cave splash', duration: 3 },
  rats:           { prompt: 'Rats squeaking and scurrying across stone floor, many of them', duration: 5 },
  bats:           { prompt: 'Swarm of bats taking flight in a cave, flapping and screeching', duration: 4 },

  // Ambient loops (names match atmosphere profile audio.ambient values)
  fireplace_crackling:        { prompt: 'Warm fireplace crackling and popping in a medieval tavern, cozy', duration: 15, loop: true },
  fire_crackling:             { prompt: 'Fireplace crackling and popping, warm ambience', duration: 15, loop: true },
  rain:                       { prompt: 'Heavy rain falling on a stone roof with occasional thunder', duration: 20, loop: true },
  wind_ambient:               { prompt: 'Persistent eerie wind howling outside an old building at night', duration: 15, loop: true },
  wind_low:                   { prompt: 'Low quiet wind blowing through rafters, subtle atmospheric', duration: 15, loop: true },
  wind_howling_fire_low:      { prompt: 'Wind howling outside with low fire crackling inside, medieval tavern at night', duration: 15, loop: true },
  wind_heavy_creaking:        { prompt: 'Heavy wind with old wooden timbers creaking and groaning', duration: 15, loop: true },
  tavern_ambient:             { prompt: 'Medieval tavern ambience, quiet murmur of conversation, fire crackling, cups clinking', duration: 20, loop: true },
  dungeon_drip:               { prompt: 'Dungeon ambience, water dripping, distant echoes, stone chamber', duration: 15, loop: true },
  night_forest:               { prompt: 'Dark forest at night, owls hooting, branches creaking, distant wolves', duration: 20, loop: true },
  storm:                      { prompt: 'Violent thunderstorm with heavy rain, strong wind, frequent thunder', duration: 20, loop: true },
  heartbeat_loop:             { prompt: 'Steady anxious heartbeat, tense atmospheric horror', duration: 10, loop: true },
  heartbeat_slow:             { prompt: 'Slow deep heartbeat, ominous and steady, horror ambience', duration: 12, loop: true },
  heartbeat_fast:             { prompt: 'Fast racing heartbeat, panic and tension, horror', duration: 10, loop: true },
  deep_drone_heartbeat:       { prompt: 'Deep ominous drone with heartbeat pulse underneath, dark ambient horror', duration: 15, loop: true },
  dissonant_drone_scratching: { prompt: 'Dissonant droning with scratching sounds, disturbing horror ambient', duration: 15, loop: true },
  combat_tension:             { prompt: 'Tense combat atmosphere, pounding drums, metallic tension, battle imminent', duration: 15, loop: true },
  birds_morning:              { prompt: 'Morning birds singing, dawn, peaceful countryside', duration: 15, loop: true },
  silence_tense:              { prompt: 'Near silence with very faint distant wind, oppressive quiet', duration: 10, loop: true }
};

class SoundService {
  constructor() {
    this.name = 'sound';
    this.orchestrator = null;
    this._apiKey = null;
    this._enabled = false;
    this._generating = false;
    this._generationQueue = [];
  }

  async init(orchestrator) {
    this.orchestrator = orchestrator;
    this.bus = orchestrator.bus;
    this.state = orchestrator.state;
    this.config = orchestrator.config;

    // Ensure sounds directory exists
    if (!fs.existsSync(SOUNDS_DIR)) {
      fs.mkdirSync(SOUNDS_DIR, { recursive: true });
    }
  }

  async start() {
    this._apiKey = process.env.ELEVENLABS_API_KEY;

    if (!this._apiKey) {
      console.warn('[SoundService] No ELEVENLABS_API_KEY in .env — sound generation disabled');
      console.log('[SoundService] Sign up at elevenlabs.io and add ELEVENLABS_API_KEY to .env');
      console.log(`[SoundService] ${this._countCachedSounds()} cached sounds available for playback`);
    } else {
      this._enabled = true;
      console.log(`[SoundService] ElevenLabs connected — ${this._countCachedSounds()} cached sounds`);
    }

    this._subscribeEvents();

    // Pre-generate missing core sounds in background
    if (this._enabled) {
      this._pregenerate();
    }
  }

  _subscribeEvents() {
    // Generate a custom sound on demand
    this.bus.subscribe('sound:generate', async (env) => {
      const { prompt, name, duration, loop } = env.data;
      if (!prompt || !name) return;
      await this.generate(name, prompt, duration, loop);
    }, 'sound-service');

    // List available sounds
    this.bus.subscribe('sound:list', () => {
      this.bus.dispatch('sound:library', { sounds: this.listSounds() });
    }, 'sound-service');
  }

  stop() {
    this._generationQueue = [];
  }

  getStatus() {
    return {
      status: this._enabled ? 'running' : 'disabled',
      elevenLabsConnected: this._enabled,
      cachedSounds: this._countCachedSounds(),
      coreSoundsTotal: Object.keys(CORE_SOUNDS).length,
      generating: this._generating,
      queueLength: this._generationQueue.length
    };
  }

  // ── Public API ─────────────────────────────────────────────────────

  listSounds() {
    const sounds = [];
    try {
      const files = fs.readdirSync(SOUNDS_DIR).filter(f => f.endsWith('.mp3'));
      for (const file of files) {
        const name = file.replace('.mp3', '');
        const core = CORE_SOUNDS[name];
        sounds.push({
          name,
          file: `/sounds/${file}`,
          isLoop: core?.loop || false,
          isCore: !!core,
          prompt: core?.prompt || null
        });
      }
    } catch (e) {
      // empty
    }

    // Also list missing core sounds
    for (const [name, def] of Object.entries(CORE_SOUNDS)) {
      if (!sounds.find(s => s.name === name)) {
        sounds.push({
          name,
          file: null,
          isLoop: def.loop || false,
          isCore: true,
          prompt: def.prompt,
          missing: true
        });
      }
    }

    return sounds;
  }

  async generate(name, prompt, duration, loop) {
    if (!this._enabled) {
      console.warn('[SoundService] Cannot generate — no API key');
      return null;
    }

    const filePath = path.join(SOUNDS_DIR, `${name}.mp3`);

    // Check cache
    if (fs.existsSync(filePath)) {
      console.log(`[SoundService] ${name} already cached`);
      return `/sounds/${name}.mp3`;
    }

    console.log(`[SoundService] Generating: ${name} — "${prompt}" (${duration || 'auto'}s${loop ? ', loop' : ''})`);

    try {
      const body = {
        text: prompt,
        prompt_influence: 0.4
      };
      if (duration) body.duration_seconds = duration;
      if (loop) body.loop = true;

      const res = await fetch('https://api.elevenlabs.io/v1/sound-generation', {
        method: 'POST',
        headers: {
          'xi-api-key': this._apiKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60000)
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        console.error(`[SoundService] ElevenLabs ${res.status}: ${errText.slice(0, 200)}`);
        return null;
      }

      const buffer = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(filePath, buffer);
      console.log(`[SoundService] Cached: ${name}.mp3 (${Math.round(buffer.length / 1024)}KB)`);

      this.bus.dispatch('sound:generated', { name, file: `/sounds/${name}.mp3` });
      return `/sounds/${name}.mp3`;

    } catch (err) {
      console.error(`[SoundService] Generation failed for ${name}: ${err.message}`);
      return null;
    }
  }

  // ── Pre-generation ────────────────────────────────────────────────

  async _pregenerate() {
    const missing = [];
    for (const [name, def] of Object.entries(CORE_SOUNDS)) {
      const filePath = path.join(SOUNDS_DIR, `${name}.mp3`);
      if (!fs.existsSync(filePath)) {
        missing.push({ name, ...def });
      }
    }

    if (missing.length === 0) {
      console.log(`[SoundService] All ${Object.keys(CORE_SOUNDS).length} core sounds cached`);
      return;
    }

    console.log(`[SoundService] Pre-generating ${missing.length} missing core sounds...`);
    this._generating = true;

    for (const sound of missing) {
      await this.generate(sound.name, sound.prompt, sound.duration, sound.loop);
      // Small delay between requests to avoid rate limits
      await new Promise(r => setTimeout(r, 2000));
    }

    this._generating = false;
    console.log(`[SoundService] Pre-generation complete — ${this._countCachedSounds()} sounds cached`);
  }

  _countCachedSounds() {
    try {
      return fs.readdirSync(SOUNDS_DIR).filter(f => f.endsWith('.mp3')).length;
    } catch (e) {
      return 0;
    }
  }
}

module.exports = SoundService;
