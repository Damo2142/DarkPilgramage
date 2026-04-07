/**
 * Horror Service — System C
 * Tracks per-player horror scores (0-100), character arc profiles,
 * and delivers private horror threshold effects to player Chromebooks.
 *
 * Horror is never shown as a number to the player.
 * DM dashboard shows color shift only (green → amber → deep red).
 */

class HorrorService {
  constructor() {
    this.name = 'horror';
    this.orchestrator = null;
    this.bus = null;
    this.state = null;

    // Horror scores per player (0-100)
    this.horrorScores = {};

    // Arc profiles per player (AI-generated on character load)
    this.arcProfiles = {};

    // Barry-specific hardcoded seeds
    this.barrySeeds = {
      'gregor_body_puncture': {
        text: 'You know what made these marks. You do not know how you know.',
        bypassPP: true
      },
      'vladislav_uses_name': {
        dmWhisper: 'Vladislav just used Barry\'s full name. He has not been introduced. Surface this or let it sit.'
      },
      'barry_handles_stakes': {
        text: 'Nine stakes. You packed nine specifically. You did not count them when you packed. Your hands knew.'
      },
      'barry_beats_2130_dc15': {
        additionalText: 'Something older than memory tells you this creature is what your family was made to hunt.'
      }
    };

    // Horror increase events
    this.HORROR_TRIGGERS = {
      'vladislav_feeds': 20,
      'discover_piotr_cellar': 25,
      'tomas_transforming': 20,
      'devastating_hit': 10,
      'party_member_shock': 15,
      'cellar_scratching': 5,
      'vladislav_threatens': 15,
      'death_save_fail': 20
    };

    // Threshold messages (delivered privately to player)
    this.THRESHOLDS = [
      { score: 20, text: 'You keep thinking about the sound from the cellar.' },
      { score: 40, text: 'You cannot stop watching him.' },
      { score: 60, text: 'Your hands are not entirely steady.' },
      { score: 80, text: null, mechanic: 'wis_save_dc14' },
      { score: 100, text: 'Something in you has simply had enough.', mechanic: 'frightened' }
    ];

    // Track which thresholds have been triggered per player
    this.triggeredThresholds = {};

    // Track watchFor behaviors per player
    this.watchForTracking = {};
  }

  async init(orchestrator) {
    this.orchestrator = orchestrator;
    this.bus = orchestrator.bus;
    this.state = orchestrator.state;
    this.config = orchestrator.config;

    // Initialize horror scores from state or config
    const players = this.state.get('players') || {};
    for (const playerId of Object.keys(players)) {
      this.horrorScores[playerId] = players[playerId]?.horror || 0;
      this.triggeredThresholds[playerId] = new Set();
    }
  }

  async start() {
    // Horror trigger events
    this.bus.subscribe('horror:trigger', (env) => {
      this._onHorrorTrigger(env.data);
    }, 'horror');

    // Vladislav feeding
    this.bus.subscribe('world:timed_event', (env) => {
      if (env.data.id === 'gregor_collapse') {
        this._triggerForAllPlayers('vladislav_feeds');
      }
    }, 'horror');

    // Combat damage — devastating hit
    this.bus.subscribe('combat:attack_result', (env) => {
      const data = env.data;
      if (data.damage >= 15 && data.targetType === 'pc') {
        this._addHorror(data.targetId, this.HORROR_TRIGGERS['devastating_hit'], 'devastating hit');
      }
    }, 'horror');

    // Shock events
    this.bus.subscribe('combat:shock_failed', (env) => {
      // Other players watching get horror increase
      const shockedId = env.data.playerId;
      const players = this.state.get('players') || {};
      for (const playerId of Object.keys(players)) {
        if (playerId !== shockedId) {
          this._addHorror(playerId, this.HORROR_TRIGGERS['party_member_shock'], `watching ${shockedId} go into shock`);
        }
      }
    }, 'horror');

    // Death save failure
    this.bus.subscribe('combat:death_save', (env) => {
      if (!env.data.success) {
        this._addHorror(env.data.playerId, this.HORROR_TRIGGERS['death_save_fail'], 'failed death save');
      }
    }, 'horror');

    // Cellar scratching (repeating event)
    this.bus.subscribe('world:environmental_cue', (env) => {
      if (env.data.text && env.data.text.toLowerCase().includes('scratch')) {
        this._triggerForAllPlayers('cellar_scratching', 5);
      }
    }, 'horror');

    // Rest reduces horror
    this.bus.subscribe('session:long_rest', () => {
      for (const playerId of Object.keys(this.horrorScores)) {
        this._addHorror(playerId, -10, 'long rest');
      }
    }, 'horror');

    // Character sheet load — generate arc profiles
    this.bus.subscribe('characters:imported', () => this._generateArcProfiles(), 'horror');
    this.bus.subscribe('characters:reloaded', () => this._generateArcProfiles(), 'horror');

    // Transcript monitoring for watchFor behaviors
    this.bus.subscribe('transcript:segment', (env) => {
      this._checkWatchFor(env.data);
    }, 'horror');

    // Barry-specific event checks
    this.bus.subscribe('clue:found', (env) => {
      this._checkBarrySeeds(env.data);
    }, 'horror');

    this._setupRoutes();
    this._syncToState();
    this._generateArcProfiles(); // Generate on startup if characters loaded

    console.log(`[Horror] Initialized for ${Object.keys(this.horrorScores).length} player(s)`);
  }

  async stop() {}

  getStatus() {
    return {
      status: 'ok',
      players: Object.keys(this.horrorScores).length,
      arcProfiles: Object.keys(this.arcProfiles).length,
      horrorScores: { ...this.horrorScores }
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // HORROR SCORE MANAGEMENT
  // ═══════════════════════════════════════════════════════════════

  _addHorror(playerId, amount, reason) {
    if (!this.horrorScores.hasOwnProperty(playerId)) {
      this.horrorScores[playerId] = 0;
      this.triggeredThresholds[playerId] = new Set();
    }

    const oldScore = this.horrorScores[playerId];
    this.horrorScores[playerId] = Math.max(0, Math.min(100, oldScore + amount));
    const newScore = this.horrorScores[playerId];

    if (oldScore === newScore) return;

    console.log(`[Horror] ${playerId}: ${oldScore} → ${newScore} (${reason})`);

    // Store in state
    this.state.set(`players.${playerId}.horror`, newScore);

    // Dispatch event
    this.bus.dispatch('horror:updated', {
      playerId,
      oldScore,
      newScore,
      delta: amount,
      reason
    });

    // Check thresholds
    if (newScore > oldScore) {
      this._checkThresholds(playerId, oldScore, newScore);
    }

    this._syncToState();
  }

  _onHorrorTrigger(data) {
    const { playerId, triggerId, amount, reason } = data;
    if (playerId) {
      const delta = amount || this.HORROR_TRIGGERS[triggerId] || 10;
      this._addHorror(playerId, delta, reason || triggerId);
    } else if (triggerId) {
      this._triggerForAllPlayers(triggerId, amount);
    }
  }

  _triggerForAllPlayers(triggerId, overrideAmount) {
    const amount = overrideAmount || this.HORROR_TRIGGERS[triggerId] || 10;
    const players = this.state.get('players') || {};
    for (const playerId of Object.keys(players)) {
      this._addHorror(playerId, amount, triggerId);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // THRESHOLD EFFECTS
  // ═══════════════════════════════════════════════════════════════

  _checkThresholds(playerId, oldScore, newScore) {
    for (const threshold of this.THRESHOLDS) {
      if (newScore >= threshold.score && oldScore < threshold.score) {
        const key = `${playerId}-${threshold.score}`;
        if (this.triggeredThresholds[playerId]?.has(key)) continue;
        if (!this.triggeredThresholds[playerId]) this.triggeredThresholds[playerId] = new Set();
        this.triggeredThresholds[playerId].add(key);

        if (threshold.mechanic === 'wis_save_dc14') {
          // WIS save DC14 to approach horror source
          this.bus.dispatch('dm:whisper', {
            text: `${playerId} horror at ${newScore} — WIS save DC14 required to approach the horror source. On fail: "Your feet do not move when you tell them to."`,
            priority: 2,
            category: 'horror'
          });
          // Send private message
          this.bus.dispatch('dm:private_message', {
            playerId,
            text: 'Your feet do not move when you tell them to.',
            durationMs: 45000,
            style: 'observation'
          });
        } else if (threshold.mechanic === 'frightened') {
          // Frightened condition
          this.bus.dispatch('dm:whisper', {
            text: `${playerId} horror at 100 — FRIGHTENED of horror source for session remainder. Apply frightened condition.`,
            priority: 1,
            category: 'horror'
          });
          this.bus.dispatch('dm:private_message', {
            playerId,
            text: threshold.text,
            durationMs: 45000,
            style: 'observation'
          });
        } else if (threshold.text) {
          // Standard threshold — private observation
          this.bus.dispatch('dm:private_message', {
            playerId,
            text: threshold.text,
            durationMs: 45000,
            style: 'observation'
          });
        }

        console.log(`[Horror] Threshold ${threshold.score} triggered for ${playerId}`);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // CHARACTER ARC PROFILES
  // ═══════════════════════════════════════════════════════════════

  async _generateArcProfiles() {
    const players = this.state.get('players') || {};
    const aiEngine = this.orchestrator.getService('ai-engine');

    for (const [playerId, player] of Object.entries(players)) {
      if (!player.character) continue;
      if (this.arcProfiles[playerId]) continue; // Already generated

      try {
        if (aiEngine?.gemini?.available) {
          const char = player.character;
          const prompt = `Analyze this D&D 5e character and generate a psychological arc profile:

Name: ${char.name}
Race: ${char.race}
Class: ${char.class}
Background: ${char.background || 'unknown'}
Alignment: ${char.alignment || 'unknown'}
Traits: ${char.traits || 'none'}
Ideals: ${char.ideals || 'none'}
Bonds: ${char.bonds || 'none'}
Flaws: ${char.flaws || 'none'}

Respond in JSON only:
{
  "hiddenInstinct": "a psychological pattern this character would exhibit under extreme stress",
  "npcReactionTrigger": "what NPC behavior would most affect this character emotionally",
  "sessionZeroSeed": "a single evocative detail or moment that would plant a personal story seed",
  "watchFor": ["behavior1", "behavior2"]
}`;

          const response = await aiEngine.gemini.generate(
            'You are a D&D character psychologist. Respond only with valid JSON.',
            prompt,
            { maxTokens: 300, temperature: 0.9 }
          );

          // Try to parse JSON from response
          const jsonMatch = response.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const profile = JSON.parse(jsonMatch[0]);
            this.arcProfiles[playerId] = profile;
            this.state.set(`players.${playerId}.arcProfile`, profile);

            // Set up watchFor tracking
            if (profile.watchFor) {
              this.watchForTracking[playerId] = profile.watchFor.map(w => w.toLowerCase());
            }

            console.log(`[Horror] Arc profile generated for ${char.name}: ${profile.hiddenInstinct?.substring(0, 50)}...`);
          }
        }
      } catch (e) {
        console.warn(`[Horror] Arc profile generation failed for ${playerId}: ${e.message}`);
      }

      // Barry-specific hardcoded arc additions
      if (this._isBarry(playerId)) {
        this.arcProfiles[playerId] = {
          ...this.arcProfiles[playerId],
          barrySpecific: true,
          hiddenInstinct: this.arcProfiles[playerId]?.hiddenInstinct || 'Hunter blood calling — reaches for stakes before conscious thought',
          watchFor: [...(this.arcProfiles[playerId]?.watchFor || []), 'stakes', 'holy water', 'mirror', 'manacles', 'frascht', 'family', 'patron']
        };
        this.watchForTracking[playerId] = (this.arcProfiles[playerId].watchFor || []).map(w => w.toLowerCase());
        this.state.set(`players.${playerId}.arcProfile`, this.arcProfiles[playerId]);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // BARRY-SPECIFIC SEEDS
  // ═══════════════════════════════════════════════════════════════

  _isBarry(playerId) {
    const char = this.state.get(`players.${playerId}.character`);
    if (!char) return false;
    const name = (char.name || '').toLowerCase();
    return name.includes('barry') || name.includes('frascht') || playerId === 'jerome';
  }

  _checkBarrySeeds(data) {
    const { clueId, playerId } = data;

    // Barry examines Gregor's body
    if (clueId === 'gregor_body_puncture' || clueId === 'cellar_bodies') {
      const barryId = this._findBarryId();
      if (barryId) {
        const seed = this.barrySeeds['gregor_body_puncture'];
        this.bus.dispatch('dm:private_message', {
          playerId: barryId,
          text: seed.text,
          durationMs: 45000,
          style: 'observation'
        });
      }
    }
  }

  _findBarryId() {
    const players = this.state.get('players') || {};
    for (const [playerId, player] of Object.entries(players)) {
      if (this._isBarry(playerId)) return playerId;
    }
    return null;
  }

  /**
   * Fire a Barry-specific seed by key
   */
  fireBarrySeed(seedKey) {
    const barryId = this._findBarryId();
    if (!barryId) return;

    const seed = this.barrySeeds[seedKey];
    if (!seed) return;

    if (seed.text) {
      this.bus.dispatch('dm:private_message', {
        playerId: barryId,
        text: seed.text,
        durationMs: 45000,
        style: 'observation'
      });
    }

    if (seed.dmWhisper) {
      this.bus.dispatch('dm:whisper', {
        text: seed.dmWhisper,
        priority: 2,
        category: 'story'
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // TRANSCRIPT MONITORING (watchFor behaviors)
  // ═══════════════════════════════════════════════════════════════

  _checkWatchFor(data) {
    const text = (data.text || '').toLowerCase();
    if (text.length < 3) return;

    for (const [playerId, watchWords] of Object.entries(this.watchForTracking)) {
      for (const word of watchWords) {
        if (text.includes(word)) {
          this._onWatchForDetected(playerId, word, text);
          break; // Only one per segment per player
        }
      }
    }
  }

  _onWatchForDetected(playerId, trigger, context) {
    const char = this.state.get(`players.${playerId}.character`);
    const charName = char?.name || playerId;

    // Generate a private first-person thought (under 15 words)
    // Use pre-built responses for common triggers, AI for others
    const quickThoughts = {
      'stakes': 'The wood feels right in your hands. It always has.',
      'holy water': 'You check the seal again. You always check the seal.',
      'mirror': 'You angle the mirror without thinking. Habit. Whose habit?',
      'manacles': 'Cold iron. You know exactly how much force they hold.',
      'frascht': 'That name. Something stirs when you hear it. Something old.',
      'family': 'You do not think about family. You never think about family.',
      'patron': 'The voice in your head is very quiet right now. Too quiet.'
    };

    const thought = quickThoughts[trigger];
    if (thought) {
      this.bus.dispatch('dm:private_message', {
        playerId,
        text: thought,
        durationMs: 45000,
        style: 'observation'
      });
      console.log(`[Horror] WatchFor "${trigger}" detected for ${charName}: sent thought`);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // STATE SYNC
  // ═══════════════════════════════════════════════════════════════

  _syncToState() {
    // Store horror scores with color for dashboard
    const horrorDisplay = {};
    for (const [playerId, score] of Object.entries(this.horrorScores)) {
      horrorDisplay[playerId] = {
        score,
        color: this._scoreToColor(score),
        tier: this._scoreTier(score)
      };
    }
    this.state.set('horror', horrorDisplay);
  }

  _scoreToColor(score) {
    if (score < 20) return '#4a8c4a';     // green
    if (score < 40) return '#7a8c3a';     // yellow-green
    if (score < 60) return '#c89040';     // amber
    if (score < 80) return '#c85030';     // orange-red
    return '#8a1a1a';                      // deep red
  }

  _scoreTier(score) {
    if (score < 20) return 'calm';
    if (score < 40) return 'uneasy';
    if (score < 60) return 'anxious';
    if (score < 80) return 'terrified';
    return 'breaking';
  }

  // ═══════════════════════════════════════════════════════════════
  // API ROUTES
  // ═══════════════════════════════════════════════════════════════

  _setupRoutes() {
    const app = this.orchestrator.getService('dashboard')?.app;
    if (!app) return;

    // GET /api/horror — all horror scores
    app.get('/api/horror', (req, res) => {
      const display = {};
      for (const [playerId, score] of Object.entries(this.horrorScores)) {
        display[playerId] = {
          score,
          color: this._scoreToColor(score),
          tier: this._scoreTier(score)
        };
      }
      res.json(display);
    });

    // POST /api/horror/trigger — trigger horror event
    app.post('/api/horror/trigger', (req, res) => {
      const { playerId, triggerId, amount, reason } = req.body;
      if (playerId) {
        this._addHorror(playerId, amount || this.HORROR_TRIGGERS[triggerId] || 10, reason || triggerId || 'manual');
      } else if (triggerId) {
        this._triggerForAllPlayers(triggerId, amount);
      } else {
        return res.status(400).json({ error: 'playerId or triggerId required' });
      }
      res.json({ ok: true, scores: this.horrorScores });
    });

    // POST /api/horror/set — manually set horror score
    app.post('/api/horror/set', (req, res) => {
      const { playerId, score } = req.body;
      if (!playerId || score == null) return res.status(400).json({ error: 'playerId and score required' });
      this.horrorScores[playerId] = Math.max(0, Math.min(100, score));
      this.state.set(`players.${playerId}.horror`, this.horrorScores[playerId]);
      this._syncToState();
      res.json({ ok: true, score: this.horrorScores[playerId] });
    });

    // GET /api/horror/arcs — character arc profiles
    app.get('/api/horror/arcs', (req, res) => {
      res.json(this.arcProfiles);
    });

    // POST /api/horror/barry-seed — fire a Barry-specific seed
    app.post('/api/horror/barry-seed', (req, res) => {
      const { seedKey } = req.body;
      if (!seedKey) return res.status(400).json({ error: 'seedKey required' });
      this.fireBarrySeed(seedKey);
      res.json({ ok: true });
    });
  }
}

module.exports = HorrorService;
