/**
 * Observation Service — System B
 * Tiered observation system for timed events and monster tells.
 *
 * Tier 1 — automatic: whispered to DM earbud
 * Tier 2 — passive perception filtered: sent privately to qualifying players
 * Tier 3 — active investigation: whispered to DM earbud as available check
 *
 * Monster tells: AI-generated or pre-configured warning signs before NPC actions
 */

class ObservationService {
  constructor() {
    this.name = 'observation';
    this.orchestrator = null;
    this.bus = null;
    this.state = null;

    // Registered observations keyed by timed event id
    this.observations = new Map(); // eventId -> observations[]

    // Monster tells keyed by NPC id
    this.monsterTells = new Map(); // npcId -> tells[]

    // Track which observations have been fired (prevent duplicates)
    this.firedObservations = new Set();
  }

  async init(orchestrator) {
    this.orchestrator = orchestrator;
    this.bus = orchestrator.bus;
    this.state = orchestrator.state;
    this.config = orchestrator.config;

    this._loadFromConfig(this.config);

    // Section 3 — Window perception intercepts
    try {
      const PerceptionIntercepts = require('./perception-intercepts');
      this.perceptionIntercepts = new PerceptionIntercepts(orchestrator, this.bus, this.state, this.config);
      this.perceptionIntercepts.init();
    } catch (err) {
      console.warn('[Observation] perception-intercepts init failed:', err.message);
    }
  }

  async start() {
    this.bus.subscribe('state:session_reset', () => {
      console.log('[Observation] Session reset — clearing fired observations');
      this.firedObservations = new Set();
    }, 'observation');

    // Listen for timed events to fire observations
    this.bus.subscribe('world:timed_event', (env) => {
      this._onTimedEvent(env.data);
    }, 'observation');

    // Listen for combat actions to fire monster tells
    this.bus.subscribe('combat:attack_result', (env) => {
      this._checkMonsterTell(env.data);
    }, 'observation');

    // Listen for NPC movement/action events
    this.bus.subscribe('world:npc_goal_timer', (env) => {
      this._checkMonsterTell(env.data);
    }, 'observation');

    // Wounds above threshold trigger tells
    this.bus.subscribe('wounds:updated', (env) => {
      this._checkWoundTell(env.data);
    }, 'observation');

    // Inline ambient observations from ambient-life and scene-population.
    // Payload variants:
    //   reference: { id }                    — look up registered observation
    //   inline:    { id, dc, text, ... }     — fire as Tier 2 directly
    // Optional filters: dcModifier, targetPlayer, nearCellarDoor, upstairsOnly
    this.bus.subscribe('observation:trigger', (env) => {
      this._onObservationTrigger(env.data || {});
    }, 'observation');

    this._setupRoutes();
    console.log(`[Observation] ${this.observations.size} event observation(s), ${this.monsterTells.size} monster tell set(s) loaded`);
  }

  async stop() {}

  getStatus() {
    return {
      status: 'ok',
      observations: this.observations.size,
      monsterTells: this.monsterTells.size,
      firedCount: this.firedObservations.size
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // CONFIG LOADING
  // ═══════════════════════════════════════════════════════════════

  _loadFromConfig(config) {
    // Load observations from session config
    const obs = config.observations || config.world?.observations;
    if (obs && Array.isArray(obs)) {
      for (const o of obs) {
        const eventId = o.eventId || o.gameTime;
        if (!this.observations.has(eventId)) {
          this.observations.set(eventId, []);
        }
        this.observations.get(eventId).push(...(o.items || [o]));
      }
    }

    // Load monster tells
    const tells = config.monsterTells || config.world?.monsterTells;
    if (tells) {
      for (const [npcId, tellList] of Object.entries(tells)) {
        this.monsterTells.set(npcId, Array.isArray(tellList) ? tellList : [tellList]);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // PASSIVE PERCEPTION CALCULATION
  // ═══════════════════════════════════════════════════════════════

  /**
   * Get passive perception for a player.
   * PP = 10 + WIS mod + proficiency (if proficient in Perception)
   */
  _getPassivePerception(playerId) {
    const player = this.state.get(`players.${playerId}`);
    if (!player?.character) return 10;

    const char = player.character;

    // Direct skill modifier if available
    const percSkill = char.skills?.perception || char.skills?.Perception;
    if (percSkill && typeof percSkill.modifier === 'number') {
      return 10 + percSkill.modifier;
    }

    // Fallback: WIS mod + proficiency
    const wisMod = char.abilities?.wis?.modifier || char.abilities?.Wis?.modifier || 0;
    const profBonus = char.proficiencyBonus || 2;
    const isProficient = percSkill?.proficiency === 'proficiency' || percSkill?.proficiency === 'expertise';

    return 10 + wisMod + (isProficient ? profBonus : 0);
  }

  /**
   * Get all players who meet a DC check with passive perception
   */
  _getQualifyingPlayers(dc) {
    const players = this.state.get('players') || {};
    const qualifying = [];

    for (const [playerId, player] of Object.entries(players)) {
      if (!player.character) continue;
      const pp = this._getPassivePerception(playerId);
      if (pp >= dc) {
        qualifying.push({ playerId, pp, charName: player.character.name || playerId });
      }
    }

    return qualifying;
  }

  // ═══════════════════════════════════════════════════════════════
  // OBSERVATION PROCESSING
  // ═══════════════════════════════════════════════════════════════

  _onTimedEvent(data) {
    const eventId = data.id;
    if (!eventId) return;

    // Check if this event has observations attached
    const eventObs = this.observations.get(eventId);
    if (eventObs && eventObs.length > 0) {
      for (const obs of eventObs) {
        this._fireObservation(obs, eventId);
      }
    }
  }

  _fireObservation(obs, eventId) {
    const obsKey = `${eventId}-${obs.id || obs.tier}-${obs.dc || 0}`;
    if (this.firedObservations.has(obsKey)) return;
    this.firedObservations.add(obsKey);

    const tier = obs.tier || 1;

    switch (tier) {
      case 1:
        this._fireTier1(obs);
        break;
      case 2:
        this._fireTier2(obs);
        break;
      case 3:
        this._fireTier3(obs);
        break;
    }
  }

  /**
   * Tier 1 — automatic: whisper to DM earbud
   */
  _fireTier1(obs) {
    const suggest = obs.suggest || '';
    const text = suggest
      ? `Surface now: ${obs.text} — suggest: "${suggest}"`
      : `Surface now: ${obs.text}`;

    this.bus.dispatch('dm:whisper', {
      text,
      priority: 3,
      category: 'observation'
    });

    console.log(`[Observation] Tier 1: ${obs.text.substring(0, 60)}...`);
  }

  /**
   * Tier 2 — passive perception filtered: private message to qualifying players
   * Appears as italic fade-in, disappears after 45 seconds, no history
   */
  _fireTier2(obs) {
    const dc = obs.dc || 10;
    let qualifying = this._getQualifyingPlayers(dc);

    // targetPlayer filter — restrict to a single player (used by spawn-hunt etc.)
    if (obs.targetPlayer) {
      qualifying = qualifying.filter(q => q.playerId === obs.targetPlayer);
    }

    if (qualifying.length === 0) {
      console.log(`[Observation] Tier 2 DC${dc}: no players qualify${obs.targetPlayer ? ' (target=' + obs.targetPlayer + ')' : ''}`);
      return;
    }

    for (const { playerId, pp, charName } of qualifying) {
      // Send private observation to player's Chromebook
      this.bus.dispatch('dm:private_message', {
        playerId,
        text: obs.text,
        durationMs: 45000,
        style: 'observation', // Client renders as italic fade-in
        linkedSecret: obs.linkedSecret || null
      });

      console.log(`[Observation] Tier 2 DC${dc}: ${charName} (PP ${pp}) sees: ${obs.text.substring(0, 50)}...`);
    }

    // Also whisper to DM who saw it
    const names = qualifying.map(q => q.charName).join(', ');
    this.bus.dispatch('dm:whisper', {
      text: `Observation DC${dc} seen by: ${names} — "${obs.text.substring(0, 80)}"`,
      priority: 4,
      category: 'observation'
    });
  }

  /**
   * Tier 3 — active investigation: whisper to DM with available check info
   */
  _fireTier3(obs) {
    const dc = obs.dc || 12;
    const suggest = obs.suggest || '';
    const text = suggest
      ? `Available check: ${obs.text} — DC ${dc} — suggest: "${suggest}"`
      : `Available check: ${obs.text} — DC ${dc}`;

    this.bus.dispatch('dm:whisper', {
      text,
      priority: 3,
      category: 'observation'
    });

    console.log(`[Observation] Tier 3 DC${dc}: ${obs.text.substring(0, 60)}...`);
  }

  // ═══════════════════════════════════════════════════════════════
  // MONSTER TELLS
  // ═══════════════════════════════════════════════════════════════

  _checkMonsterTell(data) {
    const npcId = data.npcId || data.attackerId;
    if (!npcId) return;

    const tells = this.monsterTells.get(npcId);
    if (!tells || tells.length === 0) return;

    // Pick a relevant tell based on action type
    const actionType = data.actionType || data.action || 'general';
    const matchingTells = tells.filter(t =>
      !t.actionType || t.actionType === actionType || t.actionType === 'general'
    );

    if (matchingTells.length === 0) return;

    const tell = matchingTells[Math.floor(Math.random() * matchingTells.length)];

    this.bus.dispatch('dm:whisper', {
      text: `Tell available: ${tell.text} — surface it or let it pass`,
      priority: 2,
      category: 'monster-tell'
    });

    console.log(`[Observation] Monster tell (${npcId}): ${tell.text.substring(0, 60)}...`);
  }

  _checkWoundTell(data) {
    // If a significant wound is dealt, check for monster tells
    if (data.severity && data.severity >= 3) {
      const npcId = data.attackerId || data.sourceNpc;
      if (npcId) {
        this._checkMonsterTell({ npcId, actionType: 'wound' });
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // MANUAL OBSERVATION TRIGGER
  // ═══════════════════════════════════════════════════════════════

  /**
   * Fire an observation manually (from DM dashboard or AI)
   */
  fireManualObservation(obs) {
    this._fireObservation(obs, `manual-${Date.now()}`);
  }

  /**
   * Handle an `observation:trigger` event from ambient-life / scene-population.
   *
   * Reference form: { id }                    — look up a config-registered observation
   * Inline form:    { id, dc, text, ... }     — fire as Tier 2 directly
   *
   * Inline filters honored:
   *   dcModifier      — flat numeric adjustment to the base DC
   *   targetPlayer    — restrict to a single playerId
   *
   * Inline filters logged but NOT yet position-aware (TODO: integrate with map zones):
   *   nearCellarDoor  — should restrict to players adjacent to cellar door
   *   upstairsOnly    — should restrict to players on the upper floor
   */
  _onObservationTrigger(d) {
    if (!d || !d.id) return;

    // Reference path: { id } only — look up registered observation
    if (!d.text && this.observations.has(d.id)) {
      const eventObs = this.observations.get(d.id);
      for (const obs of eventObs) this._fireObservation(obs, d.id);
      return;
    }

    // Inline path requires text
    if (!d.text) {
      console.log(`[Observation] observation:trigger id=${d.id} — no text and no registered observation`);
      return;
    }

    // Dedup by id (ambient-life ids are time-keyed so each tick is unique)
    if (this.firedObservations.has(d.id)) return;
    this.firedObservations.add(d.id);

    const baseDc = (d.dc || 10) + (d.dcModifier || 0);
    const obs = {
      id: d.id,
      tier: d.tier || 2,
      dc: baseDc,
      text: d.text,
      suggest: d.suggest,
      linkedSecret: d.linkedSecret,
      targetPlayer: d.targetPlayer
    };

    if (d.nearCellarDoor || d.upstairsOnly) {
      console.log(`[Observation] position filter requested but not yet enforced: ${d.nearCellarDoor ? 'nearCellarDoor ' : ''}${d.upstairsOnly ? 'upstairsOnly' : ''} (id=${d.id})`);
    }

    switch (obs.tier) {
      case 1: this._fireTier1(obs); break;
      case 3: this._fireTier3(obs); break;
      default: this._fireTier2(obs);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // API ROUTES
  // ═══════════════════════════════════════════════════════════════

  _setupRoutes() {
    const app = this.orchestrator.getService('dashboard')?.app;
    if (!app) return;

    // GET /api/observations — all registered observations
    app.get('/api/observations', (req, res) => {
      const all = [];
      for (const [eventId, obsList] of this.observations) {
        for (const obs of obsList) {
          all.push({ eventId, ...obs, fired: this.firedObservations.has(`${eventId}-${obs.id || obs.tier}-${obs.dc || 0}`) });
        }
      }
      res.json({ observations: all, fired: this.firedObservations.size });
    });

    // POST /api/observations/fire — manually fire an observation
    app.post('/api/observations/fire', (req, res) => {
      const { tier, dc, text, suggest, linkedSecret } = req.body;
      if (!text) return res.status(400).json({ error: 'text required' });
      this.fireManualObservation({ tier: tier || 1, dc: dc || 10, text, suggest, linkedSecret });
      res.json({ ok: true });
    });

    // GET /api/observations/pp — passive perception for all players
    app.get('/api/observations/pp', (req, res) => {
      const players = this.state.get('players') || {};
      const result = {};
      for (const playerId of Object.keys(players)) {
        result[playerId] = {
          pp: this._getPassivePerception(playerId),
          charName: players[playerId]?.character?.name || playerId
        };
      }
      res.json(result);
    });

    // GET /api/observations/tells — all monster tells
    app.get('/api/observations/tells', (req, res) => {
      const tells = {};
      for (const [npcId, tellList] of this.monsterTells) {
        tells[npcId] = tellList;
      }
      res.json(tells);
    });

    // POST /api/debug/perception-flash — direct perception flash for testing
    // body: { playerId, description?, margin? }
    app.post('/api/debug/perception-flash', (req, res) => {
      const { playerId, description, margin } = req.body || {};
      if (!playerId) return res.status(400).json({ error: 'playerId required' });
      this.bus.dispatch('player:perception_flash', {
        playerId,
        description: description || 'Something large passed by. You are sure of it.',
        margin: typeof margin === 'number' ? margin : 5,
        waypoint: 'debug'
      });
      res.json({ ok: true, playerId });
    });

    // POST /api/debug/observation-trigger — dispatch observation:trigger for testing
    // body: { id, dc, text, dcModifier?, targetPlayer?, tier? }
    app.post('/api/debug/observation-trigger', (req, res) => {
      const d = req.body || {};
      if (!d.id) return res.status(400).json({ error: 'id required' });
      this.bus.dispatch('observation:trigger', d);
      res.json({ ok: true, dispatched: d });
    });

    // POST /api/debug/npc-speak — dispatch literal NPC dialogue for testing
    // Fires npc:approved → voice-service → ElevenLabs → room speaker
    // body: { npcId, text, private?: boolean, toPlayerId?: string }
    app.post('/api/debug/npc-speak', (req, res) => {
      const { npcId, text, private: isPrivate, toPlayerId } = req.body || {};
      if (!npcId || !text) return res.status(400).json({ error: 'npcId and text required' });
      const npcState = this.state.get(`npcs.${npcId}`) || {};
      const patron = this.config && this.config[npcId];
      const npcName = npcState.name || (patron && patron.name) || npcId;
      const voiceCode = npcState.voiceCode || (patron && patron.voiceCode);
      this.bus.dispatch('npc:approved', {
        id: 'debug-' + Date.now(),
        npc: npcName,
        npcId,
        text,
        voiceCode,
        voiceProfile: npcState.voiceProfile || null,
        autoApproved: true,
        _private: !!isPrivate,
        _sourcePlayerId: toPlayerId || null
      });
      res.json({ ok: true, npcId, npc: npcName, text, routed: isPrivate ? ('player:' + (toPlayerId || 'unspecified')) : 'room-speaker' });
    });
  }
}

module.exports = ObservationService;
