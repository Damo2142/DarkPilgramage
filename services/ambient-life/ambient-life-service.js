/**
 * Ambient Life Service
 *
 * 1. Environmental ticks
 * 2. NPC autonomous movement
 * 3. Player proximity dwell triggers
 * 4. Katya performances
 * 5. Creature behavior engine — 12 creatures with state machines
 * 6. Spontaneous encounter engine — Max evaluates, proposes, DM approves
 * 7. Creature token management — Max places, moves, and removes tokens on the map
 */

class AmbientLifeService {
  constructor() {
    this.name = 'ambient-life';
    this.orchestrator = null;
    this.bus = null;
    this.state = null;

    this._envTickInterval = null;
    this._npcMoveInterval = null;
    this._npcMoveHistory = {};
    this._dwellCheckInterval = null;
    this._playerDwellTimers = {};
    this._dwellThresholdMs = 30000;
    this._dwellCooldowns = {};
    this._performanceInterval = null;
    this._performanceIndex = 0;
    this._creatureTickInterval = null;
    this._lastCreatureGameTime = null;

    // ── CREATURE STATES ──────────────────────────────────────────

    this._tomasState = {
      phase: 'normal', lastWhisperPhase: null, goalActivated: false, transformed: false
    };
    // Task 6 (session0-polish follow-up) — Vladislav awareness phase machine
    this._vladislavState = {
      awarenessPhase: 'neutral',
      lastAnnouncedPhase: null,
      tokenMovedToWindow: false
    };
    this._piotrState = {
      chainIntact: true, breakChance: 0, lastChainTestHour: -1
    };
    this._gasSporeState = {
      position: 'east-wall', driftStage: 0, cellarVisits: 0, movedNotified: false
    };
    this._kamennyState = {
      lastCircuitTime: -1, skeletonTaken: false, circuitCount: 0
    };
    this._letavecState = {
      lastCircuitMinute: -1, midnightBreak: false, playerAloneOutside: false, wolfEventFired: false
    };
    this._corpseCandleState = {
      appeared: false
    };
    this._vampireSpawnState = [
      { id: 'spawn-1', location: 'upper-hallway-west', active: true, alerted: false, hunting: false, lastMovedMinute: -1, tokenId: null },
      { id: 'spawn-2', location: 'lower-room-cluster', active: true, alerted: false, hunting: false, lastMovedMinute: -1, tokenId: null }
    ];
    this._ratSwarmState = {
      swarms: [
        { id: 'rats-1', lastAppearMinute: -1 },
        { id: 'rats-2', lastAppearMinute: -1 }
      ],
      cooldownUntil: 0
    };
    this._batState = { lastEventMinute: -1 };
    this._wolfPackState = {
      direWolfAlive: true,
      wolves: [
        { id: 'wolf-1', alive: true, location: 'road-north' },
        { id: 'wolf-2', alive: true, location: 'treeline-west' },
        { id: 'wolf-3', alive: true, location: 'road-south' }
      ],
      lastHowlMinute: -1, scattered: false, playerOutside: false
    };

    // ── SPONTANEOUS ENCOUNTER ENGINE ─────────────────────────────
    this._encounterEngine = {
      threatBudget: 6,
      spentTokens: 0,
      lastEvalMinute: -1,
      evalIntervalMinutes: 10,
      pendingProposal: null,
      recentEncounters: [],
      cooldownUntil: 0
    };
    this._encounterPalette = {
      'rat-swarm':     { cost: 1, cr: '1/4', hp: 22, ac: 10 },
      'bat-swarm':     { cost: 1, cr: '1/4', hp: 22, ac: 12 },
      'wolf':          { cost: 1, cr: '1/2', hp: 11, ac: 13 },
      'vampire-spawn': { cost: 2, cr: '5',   hp: 82, ac: 15 },
      'dire-wolf':     { cost: 2, cr: '1',   hp: 37, ac: 14 }
    };

    // ── CREATURE TOKEN REGISTRY ──────────────────────────────────
    // tokenId → { creature, location, placed }
    this._creatureTokens = new Map();

    // ── NECRONOMICON PAGE (artifact NPC) ─────────────────────────
    // Once a carrier is set, _tickNecronomiconPage runs each game-hour
    // and attempts to escalate influence via passive Wisdom saves.
    // Threshold effects fire at 25/50/75/100. Page config lives at
    // config/npcs/necronomicon-page.json — loaded lazily on first need.
    this._pageState = {
      carrierId: null,
      influence: 0,
      lastHourTicked: -1,
      thresholdsFired: new Set(),
      dreamDelivered: false
    };
    this._pageConfig = null; // loaded on demand
  }

  async init(orchestrator) {
    this.orchestrator = orchestrator;
    this.bus = orchestrator.bus;
    this.state = orchestrator.state;
    this.config = orchestrator.config;
  }

  async start() {
    this.bus.subscribe('session:started', () => this._onSessionStart(), 'ambient-life');
    this.bus.subscribe('session:ended', () => this._onSessionEnd(), 'ambient-life');
    this.bus.subscribe('session:paused', () => this._onSessionPause(), 'ambient-life');
    this.bus.subscribe('session:resumed', () => this._onSessionStart(), 'ambient-life');

    this.bus.subscribe('state:session_reset', () => {
      this._stopAll();
      this._resetAllStates();
    }, 'ambient-life');

    this.bus.subscribe('combat:started', () => this._stopForCombat(), 'ambient-life');
    this.bus.subscribe('combat:ended', () => this._resumeFromCombat(), 'ambient-life');

    // DM overrides
    this.bus.subscribe('creature:skeleton_taken', () => {
      this._kamennyState.skeletonTaken = true;
      this._whisperDM('Kamenný: skeleton taken. It steps between the thief and the door.', 1, 'story');
    }, 'ambient-life');

    this.bus.subscribe('creature:player_alone_outside', (data) => {
      this._letavecState.playerAloneOutside = true;
      this._wolfPackState.playerOutside = true;
      this._whisperDM('Player alone outside — Letavec and wolf pack are aware.', 1, 'story');
    }, 'ambient-life');

    this.bus.subscribe('creature:cellar_visit', () => {
      this._gasSporeState.cellarVisits++;
      if (this._gasSporeState.cellarVisits === 2 && !this._gasSporeState.movedNotified) {
        this._gasSporeState.movedNotified = true;
        this._whisperDM('Gas Spore: has drifted since their last visit. They will notice if they look.', 3, 'story');
      }
    }, 'ambient-life');

    this.bus.subscribe('creature:dire_wolf_killed', () => {
      this._wolfPackState.direWolfAlive = false;
      this._wolfPackState.scattered = true;
      this._wolfPackState.wolves.forEach(w => { w.alive = false; this._removeCreatureToken(`token-${w.id}`); });
      this._removeCreatureToken('token-dire-wolf');
      this._whisperDM('Dire wolf dead — pack scatters. All wolf tokens removed. No more wolf activity tonight.', 1, 'story');
      this.bus.dispatch('ambient:environment', { text: 'The howling that has circled the inn all night cuts off suddenly. Silence from the forest.', tier: 'dread', timestamp: Date.now() });
    }, 'ambient-life');

    this.bus.subscribe('creature:player_upstairs', (data) => {
      this._vampireSpawnState.forEach(spawn => {
        if (!spawn.alerted) {
          spawn.alerted = true;
          // Place spawn token hidden on upper floor
          if (!spawn.tokenId) {
            spawn.tokenId = this._placeCreatureToken(`token-${spawn.id}`, {
              name: 'Vampire Spawn',
              actorSlug: 'vampire-spawn',
              location: spawn.location,
              hidden: true,
              hp: { current: 82, max: 82 },
              ac: 15,
              image: 'vampire-spawn.webp'
            });
          }
          this._whisperDM(`Vampire Spawn (${spawn.id}) alerted — token placed hidden on upper floor. DC13 to hear movement.`, 2, 'story');
        }
      });
    }, 'ambient-life');

    // ── NECRONOMICON PAGE — carrier lifecycle ──
    this.bus.subscribe('artifact:page_carrier_set', (env) => {
      const playerId = env?.data?.playerId;
      if (!playerId) return;
      this._pageState.carrierId = playerId;
      this._pageState.lastHourTicked = -1; // re-arm tick on next hour
      this._whisperDM(`Necronomicon page carrier: ${playerId}. Influence tracking begins (current ${this._pageState.influence}).`, 3, 'story');
    }, 'ambient-life');

    this.bus.subscribe('artifact:page_dropped', () => {
      this._whisperDM(`Necronomicon page dropped. Influence frozen at ${this._pageState.influence}.`, 3, 'story');
      this._pageState.carrierId = null;
    }, 'ambient-life');

    // Long rest — surface an opportunity for the DM to prompt a save
    // at the table (carrier rolls; +10 influence reduction on success).
    this.bus.subscribe('session:long_rest', () => {
      if (!this._pageState.carrierId) return;
      this.bus.dispatch('artifact:page_save_opportunity', {
        carrierId: this._pageState.carrierId,
        currentInfluence: this._pageState.influence,
        saveDC: this._currentPageSaveDC()
      });
      this._whisperDM(
        `Long rest — Necronomicon page save opportunity for ${this._pageState.carrierId}. ` +
        `Current influence ${this._pageState.influence}, DC ${this._currentPageSaveDC()} Wisdom. ` +
        `On success: -10 influence.`,
        2, 'story'
      );
      // First long rest with the page: deliver the library-with-no-walls dream.
      if (!this._pageState.dreamDelivered) {
        const cfg = this._loadPageConfig();
        if (cfg?.dreamText) {
          this.bus.dispatch('player:perception_flash', {
            playerId: this._pageState.carrierId,
            description: cfg.dreamText,
            margin: 0,
            waypoint: 'necronomicon-page:dream'
          });
          this._whisperDM(`Page dream delivered to ${this._pageState.carrierId}.`, 3, 'story');
          this._pageState.dreamDelivered = true;
        }
      }
    }, 'ambient-life');

    // Encounter approval
    this.bus.subscribe('encounter:approved', () => this._executeProposedEncounter(), 'ambient-life');
    this.bus.subscribe('encounter:skipped', () => {
      if (this._encounterEngine.pendingProposal) {
        console.log(`[AmbientLife] Encounter skipped: ${this._encounterEngine.pendingProposal.creature}`);
        this._encounterEngine.pendingProposal = null;
        this._encounterEngine.cooldownUntil = Date.now() + 5 * 60 * 1000;
      }
    }, 'ambient-life');

    setTimeout(() => {
      const app = this.orchestrator.getService('dashboard')?.app;
      this._setupRoutes(app);
    }, 2000);

    console.log('[AmbientLife] Ready — 12 creatures, token management, spontaneous encounters');
  }

  async stop() { this._stopAll(); }

  getStatus() {
    return {
      status: 'ok',
      creatureTickActive: !!this._creatureTickInterval,
      activeCreatureTokens: this._creatureTokens.size,
      creatures: {
        tomas: this._tomasState.phase,
        piotr: this._piotrState.chainIntact ? 'chained' : 'FREE',
        gasSpore: this._gasSporeState.position,
        kamenný: `circuit ${this._kamennyState.circuitCount}`,
        letavec: this._letavecState.midnightBreak ? 'midnight-break' : 'circling',
        corpseCandle: this._corpseCandleState.appeared ? 'appeared' : 'waiting',
        vampireSpawn: this._vampireSpawnState.map(s => s.hunting ? 'HUNTING' : s.alerted ? 'alerted' : 'dormant').join(', '),
        wolves: this._wolfPackState.scattered ? 'scattered' : `pack active (dire wolf ${this._wolfPackState.direWolfAlive ? 'alive' : 'dead'})`
      },
      encounterEngine: {
        tokensRemaining: this._encounterEngine.threatBudget - this._encounterEngine.spentTokens,
        pendingProposal: this._encounterEngine.pendingProposal?.creature || null
      }
    };
  }

  _onSessionStart() {
    this._stopAll();
    this._startEnvTicks();
    this._startNpcMovement();
    this._startDwellCheck();
    this._startPerformances();
    this._startCreatureEngine();
  }

  _onSessionPause() { this._stopAll(); }
  _onSessionEnd() { this._stopAll(); }

  _stopAll() {
    if (this._envTickInterval) { clearTimeout(this._envTickInterval); this._envTickInterval = null; }
    if (this._npcMoveInterval) { clearTimeout(this._npcMoveInterval); this._npcMoveInterval = null; }
    if (this._dwellCheckInterval) { clearInterval(this._dwellCheckInterval); this._dwellCheckInterval = null; }
    if (this._performanceInterval) { clearTimeout(this._performanceInterval); this._performanceInterval = null; }
    if (this._creatureTickInterval) { clearInterval(this._creatureTickInterval); this._creatureTickInterval = null; }
  }

  // Combat pause scope: only stop environmental and creature ticks.
  // NPC autonomous movement, player proximity dwell, and Katya performances
  // continue running so the world stays alive during combat.
  _stopForCombat() {
    if (this._envTickInterval) { clearTimeout(this._envTickInterval); this._envTickInterval = null; }
    if (this._creatureTickInterval) { clearInterval(this._creatureTickInterval); this._creatureTickInterval = null; }
    console.log('[AmbientLife] Combat started — env tick + creature tick paused (dwell/npc-move/performance still running)');
  }

  _resumeFromCombat() {
    if (!this._envTickInterval) this._startEnvTicks();
    if (!this._creatureTickInterval) this._startCreatureEngine();
    console.log('[AmbientLife] Combat ended — env tick + creature tick resumed');
  }

  _resetAllStates() {
    // Remove all creature tokens from map
    for (const [tokenId] of this._creatureTokens) this._removeCreatureToken(tokenId);
    this._creatureTokens.clear();

    this._lastCreatureGameTime = null;
    this._playerDwellTimers = {};
    this._dwellCooldowns = {};
    this._npcMoveHistory = {};
    this._performanceIndex = 0;
    this._tomasState = { phase: 'normal', lastWhisperPhase: null, goalActivated: false, transformed: false };
    this._piotrState = { chainIntact: true, breakChance: 0, lastChainTestHour: -1 };
    this._gasSporeState = { position: 'east-wall', driftStage: 0, cellarVisits: 0, movedNotified: false };
    this._kamennyState = { lastCircuitTime: -1, skeletonTaken: false, circuitCount: 0 };
    this._letavecState = { lastCircuitMinute: -1, midnightBreak: false, playerAloneOutside: false, wolfEventFired: false };
    this._corpseCandleState = { appeared: false };
    this._vampireSpawnState.forEach(s => { s.alerted = false; s.hunting = false; s.lastMovedMinute = -1; s.tokenId = null; });
    this._ratSwarmState.cooldownUntil = 0;
    this._ratSwarmState.swarms.forEach(s => s.lastAppearMinute = -1);
    this._batState = { lastEventMinute: -1 };
    this._wolfPackState.scattered = false;
    this._wolfPackState.direWolfAlive = true;
    this._wolfPackState.playerOutside = false;
    this._wolfPackState.lastHowlMinute = -1;
    this._wolfPackState.wolves.forEach(w => { w.alive = true; });
    this._encounterEngine.spentTokens = 0;
    this._encounterEngine.pendingProposal = null;
    this._encounterEngine.recentEncounters = [];
    this._encounterEngine.lastEvalMinute = -1;
    this._encounterEngine.cooldownUntil = 0;
    this._pageState = { carrierId: null, influence: 0, lastHourTicked: -1, thresholdsFired: new Set(), dreamDelivered: false };
  }

  // ═══════════════════════════════════════════════════════════════
  // 7. CREATURE TOKEN MANAGEMENT
  // ═══════════════════════════════════════════════════════════════

  /**
   * Named positions in the Pallid Hart — pixel coords at gridSize 70.
   * These are approximate defaults. DM can drag tokens if they land slightly off.
   * Ground floor map is the active map during Session 0.
   */
  _getMapPosition(locationName) {
    const positions = {
      // Ground floor — common room
      'common-room-center':   { x: 700,  y: 490 },
      'common-room-north':    { x: 700,  y: 280 },
      'common-room-south':    { x: 700,  y: 700 },
      'near-fireplace':       { x: 175,  y: 385 },
      'behind-bar':           { x: 1050, y: 385 },
      'near-cellar-door':     { x: 420,  y: 560 },
      'entry-door':           { x: 700,  y: 770 },
      'window-east':          { x: 1155, y: 490 },
      'hooded-corner':        { x: 1085, y: 210 },
      // Cellar (treated as below ground floor — place near cellar door)
      'cellar':               { x: 350,  y: 630 },
      'cellar-center':        { x: 350,  y: 630 },
      // Upper floor
      'upper-hallway-west':   { x: 245,  y: 350 },
      'upper-hallway-east':   { x: 840,  y: 350 },
      'upper-hallway-center': { x: 525,  y: 350 },
      'upper-stairs-top':     { x: 175,  y: 595 },
      'lower-room-cluster':   { x: 595,  y: 630 },
      'top-of-stairs':        { x: 175,  y: 595 },
      // Shed / exterior (placed at edge of map)
      'shed':                 { x: 140,  y: 700 },
      'outside':              { x: 700,  y: 910 },
      'road-north':           { x: 700,  y: 910 },
      'road-south':           { x: 700,  y: 910 },
      'treeline-west':        { x: 105,  y: 490 }
    };

    // Fuzzy match — try contains
    const key = Object.keys(positions).find(k =>
      k === locationName || locationName?.toLowerCase().includes(k) || k.includes(locationName?.toLowerCase())
    );
    return positions[key] || positions['common-room-center'];
  }

  /**
   * Place a creature token on the map.
   * Returns the tokenId placed.
   */
  _placeCreatureToken(tokenId, config) {
    const { x, y } = this._getMapPosition(config.location || 'common-room-center');

    const token = {
      tokenId,
      actorSlug: config.actorSlug || tokenId,
      name: config.name || tokenId,
      type: 'npc',
      x,
      y,
      image: config.image || `${config.actorSlug || tokenId}.webp`,
      visible: !config.hidden,
      hidden: config.hidden || false,
      hp: config.hp || { current: 10, max: 10 },
      ac: config.ac || 10,
      nameRevealedToPlayers: false,
      publicName: config.publicName || '',
      creatureToken: true  // flag so we know Max placed this
    };

    this.state.set(`map.tokens.${tokenId}`, token);
    this.bus.dispatch('map:token_added', { tokenId, token });
    this._creatureTokens.set(tokenId, { creature: config.actorSlug, location: config.location, placed: Date.now() });

    console.log(`[AmbientLife] Token placed: ${tokenId} at (${x}, ${y}) hidden=${token.hidden}`);
    return tokenId;
  }

  /**
   * Move an existing creature token to a named location.
   */
  _moveCreatureToken(tokenId, locationName) {
    const mapService = this.orchestrator.getService('map');
    if (!mapService) return;
    const { x, y } = this._getMapPosition(locationName);
    mapService._moveToken(tokenId, x, y, { force: true });
    const entry = this._creatureTokens.get(tokenId);
    if (entry) entry.location = locationName;
    console.log(`[AmbientLife] Token moved: ${tokenId} → ${locationName} (${x}, ${y})`);
  }

  /**
   * Make a hidden creature token visible to players.
   */
  _revealCreatureToken(tokenId) {
    const token = this.state.get(`map.tokens.${tokenId}`);
    if (!token) return;
    token.hidden = false;
    token.visible = true;
    this.state.set(`map.tokens.${tokenId}`, token);
    this.bus.dispatch('map:token_visibility_changed', { tokenId, hidden: false, visible: true });
    console.log(`[AmbientLife] Token revealed: ${tokenId}`);
  }

  /**
   * Remove a creature token from the map.
   */
  _removeCreatureToken(tokenId) {
    const tokens = this.state.get('map.tokens') || {};
    if (!tokens[tokenId]) return;
    delete tokens[tokenId];
    this.state.set('map.tokens', tokens);
    this.bus.dispatch('map:token_removed', { tokenId });
    this._creatureTokens.delete(tokenId);
    console.log(`[AmbientLife] Token removed: ${tokenId}`);
  }

  // ═══════════════════════════════════════════════════════════════
  // 1. ENVIRONMENTAL TICKS
  // ═══════════════════════════════════════════════════════════════

  _startEnvTicks() { this._scheduleNextEnvTick(); }

  _scheduleNextEnvTick() {
    const avgHorror = this._getAvgHorror();
    const scale = 1 - (avgHorror / 200);
    const minMs = Math.floor(180000 * scale);
    const maxMs = Math.floor(300000 * scale);
    const intervalMs = minMs + Math.floor(Math.random() * (maxMs - minMs));
    this._envTickInterval = setTimeout(() => {
      this._fireEnvTick();
      this._scheduleNextEnvTick();
    }, intervalMs);
  }

  _fireEnvTick() {
    if (this.state.get('session.status') !== 'active') return;
    if (this.state.get('combat.active')) return;
    const avgHorror = this._getAvgHorror();
    let pool;
    if (avgHorror < 20) pool = this._envCuesCalm;
    else if (avgHorror < 50) pool = this._envCuesTense;
    else if (avgHorror < 80) pool = this._envCuesDread;
    else pool = this._envCuesTerror;
    const text = pool[Math.floor(Math.random() * pool.length)];
    this._whisperDM(`Environment: ${text}`, 5, 'atmosphere');
    this.bus.dispatch('ambient:environment', {
      text, tier: avgHorror < 20 ? 'calm' : avgHorror < 50 ? 'tense' : avgHorror < 80 ? 'dread' : 'terror',
      timestamp: Date.now()
    });
  }

  get _envCuesCalm() { return [
    'A log shifts in the fireplace, sending sparks up the chimney.',
    'Wind moans around the eaves. The shutters creak but hold.',
    'The fire pops. Shadows jump and settle.',
    'A draft stirs the candle flames. They lean, then right themselves.',
    'Somewhere in the walls, a mouse scratches. Normal sounds of an old building.',
    'The fire burns low. Marta adds another log without being asked.'
  ]; }

  get _envCuesTense() { return [
    'A sudden gust rattles the shutters violently. Then silence.',
    'The fire dims for a moment — as if something drew the air from the room.',
    'A wolf howls in the distance. Then another, closer. Then silence.',
    'The floorboards creak overhead. There is no one upstairs.',
    'A candle goes out near the cellar door. No one was near it.',
    'Something thumps against the outside wall. Once. Nothing follows.',
    'The temperature drops. You can see your breath for a moment.',
    'The fire spits a blue flame. Old wood, probably. Probably.'
  ]; }

  get _envCuesDread() { return [
    'A sound from below the floor. Soft. Rhythmic. Like something dragging itself.',
    'Every candle in the room dims simultaneously, then slowly brightens.',
    'A wolf howls directly outside the door. It does not sound like a wolf.',
    'A cold spot drifts through the room. It passes through you like a memory.',
    'Scratching from the cellar. Louder now. More deliberate.',
    'A smell rises from beneath the floor. Copper. Earth. Something sweet and rotten.',
    'The shutters bang open. The storm outside is white and howling. They slam shut.',
    'You hear something that sounds like whispering from the walls themselves.'
  ]; }

  get _envCuesTerror() { return [
    'The scratching from below has stopped. The silence is worse.',
    'Every shadow in the room seems to lean toward the cellar door.',
    'The fire burns red. Not orange — red. The heat feels wrong.',
    'A handprint appears in the frost on the window. From the outside. Five long fingers.',
    'All the candles go out at once. In the darkness, something breathes.',
    'The wind screams. It sounds like a name. Your name.',
    'Blood seeps from between the floorboards near the cellar. Slowly. Steadily.',
    'The cellar door rattles in its frame. Something wants out.'
  ]; }

  // ═══════════════════════════════════════════════════════════════
  // 2. NPC AUTONOMOUS MOVEMENT
  // ═══════════════════════════════════════════════════════════════

  _startNpcMovement() { this._scheduleNextNpcMove(); }

  _scheduleNextNpcMove() {
    const intervalMs = 300000 + Math.floor(Math.random() * 180000);
    this._npcMoveInterval = setTimeout(() => { this._fireNpcMove(); this._scheduleNextNpcMove(); }, intervalMs);
  }

  _fireNpcMove() {
    if (this.state.get('session.status') !== 'active') return;
    // NPC movement continues during combat (non-combatant NPCs keep living)
    const npcs = this.config.npcs || {};
    const activeNpcs = Object.entries(npcs).filter(([, npc]) => (npc.status === 'alive' || !npc.status) && npc.name);
    if (activeNpcs.length === 0) return;
    const [npcId, npc] = activeNpcs[Math.floor(Math.random() * activeNpcs.length)];
    if (npcId === 'hooded-stranger') return;
    const moves = this._getNpcMoveOptions(npcId);
    if (moves.length === 0) return;
    const lastPos = this._npcMoveHistory[npcId];
    const available = moves.filter(m => m.label !== lastPos);
    if (available.length === 0) return;
    const move = available[Math.floor(Math.random() * available.length)];
    this._npcMoveHistory[npcId] = move.label;
    this.state.set(`npcs.${npcId}.location`, move.label);
    const npcName = npc.name || npcId;
    this._whisperDM(`${npcName} ${move.action}`, 5, 'ambient');

    // Actually move the NPC's map token so the DM sees the movement on the
    // battlemap — previously only the text `location` label was updated.
    if (typeof move.x === 'number' && typeof move.y === 'number') {
      const mapService = this.orchestrator.getService('map');
      const token = this.state.get(`map.tokens.${npcId}`);
      if (mapService && token) {
        try {
          mapService._moveToken(npcId, move.x, move.y, { force: true });
        } catch (e) {
          console.warn(`[AmbientLife] NPC token move failed for ${npcId}: ${e.message}`);
        }
      }
    }

    this.bus.dispatch('ambient:npc_move', { npcId, npcName, label: move.label, action: move.action, timestamp: Date.now() });
  }

  _getNpcMoveOptions(npcId) {
    // Coordinates mirror _getMapPosition anchors for the Pallid Hart ground
    // floor (gridSize 70). Each move updates both the narrative location
    // label AND the actual map token x/y — see _fireNpcMove.
    const moves = {
      'marta': [
        { label: 'behind the bar', action: 'moves behind the bar, polishing glasses nervously.', x: 1050, y: 385 },
        { label: 'by the fireplace', action: 'moves to the fireplace to add a log. Her hands tremble.', x: 175, y: 385 },
        { label: 'near the cellar door', action: 'walks toward the cellar door, hesitates, then stops.', x: 420, y: 560 },
        { label: 'serving tables', action: 'circles the room refilling mugs, avoiding the stranger\'s corner.', x: 700, y: 490 }
      ],
      'tomas': [
        { label: 'near the entry door', action: 'moves to the door and checks the latch again.', x: 700, y: 770 },
        { label: 'by the window', action: 'stands at the window, staring at the sky through the frost.', x: 1155, y: 490 },
        { label: 'near the cellar door', action: 'drifts toward the cellar door, trying to look casual.', x: 420, y: 560 },
        { label: 'pacing by the wall', action: 'paces along the far wall, unable to sit still.', x: 700, y: 280 }
      ],
      'patron-farmer': [
        { label: 'table near the hearth', action: 'hasn\'t moved from his spot by the fire. Staring into the flames.', x: 245, y: 385 },
        { label: 'at the bar', action: 'shuffles to the bar and asks Marta for something stronger.', x: 980, y: 385 }
      ],
      'patron-merchant': [
        { label: 'table with his goods', action: 'reorganizes his merchant goods under the table for the fifth time.', x: 700, y: 700 },
        { label: 'at the bar', action: 'goes to the bar and orders another drink.', x: 980, y: 385 },
        { label: 'near the entry door', action: 'moves to the door and peers through the keyhole at the storm.', x: 700, y: 770 }
      ],
      'patron-pilgrim': [
        { label: 'corner table with candle', action: 'remains at his corner table, praying quietly.', x: 315, y: 210 },
        { label: 'near the cellar door', action: 'approaches the cellar door. Places his palm flat against it. Steps back.', x: 420, y: 560 }
      ],
      'patron-minstrel': [
        { label: 'by the hearth with lute', action: 'settles by the hearth and tunes her lute absently.', x: 175, y: 385 },
        { label: 'at the bar', action: 'leans against the bar, chatting with Marta in low tones.', x: 980, y: 385 },
        { label: 'wandering the room', action: 'strolls through the room, observing everyone with those sharp eyes.', x: 700, y: 490 }
      ]
    };
    return moves[npcId] || [];
  }

  // ═══════════════════════════════════════════════════════════════
  // 3. PLAYER PROXIMITY DWELL
  // ═══════════════════════════════════════════════════════════════

  _startDwellCheck() { this._dwellCheckInterval = setInterval(() => this._checkDwells(), 5000); }

  _checkDwells() {
    if (this.state.get('session.status') !== 'active') return;
    // Player proximity dwell continues during combat
    const tokens = this.state.get('map.tokens') || {};
    const gridSize = this.state.get('map.gridSize') || 70;
    const feetPerGrid = 5;
    const now = Date.now();
    const playerTokens = Object.entries(tokens).filter(([, t]) => t.type === 'pc');
    const npcTokens = Object.entries(tokens).filter(([, t]) => t.type === 'npc' && !t.hidden);

    for (const [ptId, pt] of playerTokens) {
      const playerId = pt.playerId || ptId;
      let nearestNpc = null, nearestDist = Infinity;
      for (const [ntId, nt] of npcTokens) {
        const dx = pt.x - nt.x, dy = pt.y - nt.y;
        const distFeet = (Math.sqrt(dx * dx + dy * dy) / gridSize) * feetPerGrid;
        if (distFeet <= 10 && distFeet < nearestDist) { nearestDist = distFeet; nearestNpc = { tokenId: ntId, ...nt }; }
      }
      const existing = this._playerDwellTimers[playerId];
      if (nearestNpc) {
        const npcId = nearestNpc.actorSlug || nearestNpc.tokenId;
        if (existing && existing.nearNpcId === npcId) {
          if (!existing.triggered && (now - existing.startedAt) >= this._dwellThresholdMs) {
            const ck = `${playerId}-${npcId}`;
            if (this._dwellCooldowns[ck] && (now - this._dwellCooldowns[ck]) < 300000) { existing.triggered = true; continue; }
            existing.triggered = true;
            this._dwellCooldowns[ck] = now;
            this._fireDwellTrigger(playerId, npcId, nearestNpc);
          }
        } else {
          this._playerDwellTimers[playerId] = { nearNpcId: npcId, startedAt: now, triggered: false };
        }
      } else { delete this._playerDwellTimers[playerId]; }
    }
    this._checkCellarProximity(playerTokens, gridSize, feetPerGrid, now);
  }

  _fireDwellTrigger(playerId, npcId, npcToken) {
    const npcName = npcToken.name || npcId;
    this._whisperDM(`${playerId} lingering near ${npcName} — they may react.`, 3, 'ambient');
    const genericReactions = {
      'marta': 'Marta glances at you and offers a nervous smile. "Can I get you something?"',
      'tomas': 'Tomas eyes you warily. His hand moves to his forearm.',
      'hooded-stranger': 'The stranger turns his head. Slowly. He looks directly at you.',
      'patron-farmer': 'Old Gregor looks up. "You see it too, don\'t you?"',
      'patron-merchant': '"Need something? Fair prices."',
      'patron-pilgrim': '"Sit, friend. There is safety in fellowship."',
      'patron-minstrel': 'Katya looks up with a knowing smile. "Curious about something?"'
    };
    const text = genericReactions[npcId] || `${npcName} looks up and acknowledges your presence.`;
    this.bus.dispatch('ambient:dwell_reaction', { npcId, npcName, playerId, text, timestamp: Date.now() });
  }

  _checkCellarProximity(playerTokens, gridSize, feetPerGrid, now) {
    const cellarDoor = this.state.get('map.interestPoints.cellarDoor');
    if (!cellarDoor) return;
    for (const [ptId, pt] of playerTokens) {
      const playerId = pt.playerId || ptId;
      const dx = pt.x - cellarDoor.x, dy = pt.y - cellarDoor.y;
      const distFeet = (Math.sqrt(dx * dx + dy * dy) / gridSize) * feetPerGrid;
      if (distFeet <= 10) {
        const ck = `${playerId}-cellar`;
        if (this._dwellCooldowns[ck] && (now - this._dwellCooldowns[ck]) < 600000) continue;
        this._dwellCooldowns[ck] = now;
        this._whisperDM(`${playerId} is at the cellar door. Vladislav will notice.`, 2, 'story');
        this.bus.dispatch('ambient:cellar_interest', { playerId, timestamp: now });
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // 4. KATYA PERFORMANCES
  // ═══════════════════════════════════════════════════════════════

  _startPerformances() { this._scheduleNextPerformance(); }

  _scheduleNextPerformance() {
    const intervalMs = 480000 + Math.floor(Math.random() * 420000);
    this._performanceInterval = setTimeout(() => { this._firePerformance(); this._scheduleNextPerformance(); }, intervalMs);
  }

  _firePerformance() {
    if (this.state.get('session.status') !== 'active') return;
    if (this.state.get('combat.active')) return;
    const currentProfile = this.state.get('atmosphere.activeProfile') || '';
    if (currentProfile.includes('dread') || currentProfile.includes('terror') || currentProfile.includes('combat')) return;
    const katya = this.config.npcs?.['patron-minstrel'];
    if (!katya?.performances) return;
    const tier = currentProfile.includes('tense') ? 'tavern_tense' : 'tavern_warm';
    const performances = katya.performances[tier];
    if (!performances || performances.length === 0) return;
    const perf = performances[this._performanceIndex % performances.length];
    this._performanceIndex++;
    this._whisperDM(`Katya performs: ${perf.title}`, 4, 'story');
    this.bus.dispatch('ambient:performance', { npcId: 'patron-minstrel', npcName: 'Katya', type: perf.type, title: perf.title, content: perf.content, timestamp: Date.now() });
    // Route the actual performance text to the room speaker via the NPC
    // speech pipeline (comm-router → voice-service → ElevenLabs → npc:audio).
    if (perf.content) {
      this.bus.dispatch('npc:scripted_speech', {
        npcId: 'patron-minstrel',
        npc: 'Katya Voss',
        text: perf.content,
        languageId: 'common',
        narratorTranslation: null
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // 5. CREATURE BEHAVIOR ENGINE
  // ═══════════════════════════════════════════════════════════════

  _startCreatureEngine() {
    this._creatureTickInterval = setInterval(() => this._creatureTick(), 10000);
    console.log('[AmbientLife] Creature engine started');
  }

  _creatureTick() {
    if (this.state.get('session.status') !== 'active') return;
    if (this.state.get('combat.active')) return;
    const worldService = this.orchestrator.getService('world');
    if (!worldService?.gameTime) return;
    const gt = worldService.gameTime;
    const gtKey = `${gt.getHours()}:${gt.getMinutes()}`;
    if (gtKey === this._lastCreatureGameTime) return;
    this._lastCreatureGameTime = gtKey;
    const h = gt.getHours(), m = gt.getMinutes();
    const totalMinutes = h * 60 + m;

    this._tickTomas(h, m, totalMinutes);
    this._tickVladislavAwareness(h, m, totalMinutes);
    this._tickPiotr(h, m, totalMinutes);
    this._tickGasSpore(h, m, totalMinutes);
    this._tickKamenny(h, m, totalMinutes);
    this._tickLetavec(h, m, totalMinutes);
    this._tickCorpseCandle(h, m, totalMinutes);
    this._tickVampireSpawn(h, m, totalMinutes);
    this._tickRatSwarms(h, m, totalMinutes);
    this._tickBats(h, m, totalMinutes);
    this._tickWolfPack(h, m, totalMinutes);
    this._tickNecronomiconPage(h, m, totalMinutes);
    this._tickSpontaneousEncounters(h, m, totalMinutes, worldService);
  }

  // ─── TOMAS ───────────────────────────────────────────────────

  _tickTomas(h, m, totalMinutes) {
    if (this._tomasState.transformed) return;
    if (totalMinutes >= 20 * 60 && this._tomasState.phase === 'normal') {
      this._tomasState.phase = 'anxious';
      this._whisperDM('TOMAS: Moon anxiety beginning. Stops eating. Keeps touching his forearm. DC14 Perception.', 2, 'story');
      this.bus.dispatch('observation:trigger', { id: 'tomas-anxiety', dc: 14, text: 'Tomas has stopped eating. He keeps pressing his hand against his forearm through the sleeve.' });
    }
    if (totalMinutes >= 20 * 60 + 30 && this._tomasState.phase === 'anxious' && this._tomasState.lastWhisperPhase !== '20:30') {
      this._tomasState.lastWhisperPhase = '20:30';
      this._whisperDM('TOMAS: Visibly sweating. Hands shaking. Insists he is fine.', 2, 'story');
    }
    if (totalMinutes >= 21 * 60 && this._tomasState.phase === 'anxious') {
      this._tomasState.phase = 'desperate';
      this._whisperDM('TOMAS: Needs the cellar NOW. One hour before it stops mattering.', 1, 'story');
      if (!this._tomasState.goalActivated) {
        this._tomasState.goalActivated = true;
        this.bus.dispatch('world:npc_goal_activated', { npcId: 'tomas', goalId: 'reach-cellar', goal: 'Reach cellar before 22:00' });
      }
    }
    if (totalMinutes >= 21 * 60 + 30 && this._tomasState.phase === 'desperate' && this._tomasState.lastWhisperPhase !== '21:30') {
      this._tomasState.lastWhisperPhase = '21:30';
      this._whisperDM('TOMAS [30 MIN]: If he cannot reach the cellar he transforms wherever he is. CR3 werewolf. Room full of people.', 1, 'story');
    }
    if (totalMinutes >= 21 * 60 + 50 && this._tomasState.phase === 'desperate' && this._tomasState.lastWhisperPhase !== '21:50') {
      this._tomasState.lastWhisperPhase = '21:50';
      this._whisperDM('TOMAS [URGENT — 10 MIN]: Control almost gone. Anyone within 10ft hears something wrong.', 1, 'story');
      this.bus.dispatch('observation:trigger', { id: 'tomas-breaking', dc: 10, text: 'Tomas is shaking. His breathing is ragged and too fast.' });
    }
    if (totalMinutes >= 22 * 60 && this._tomasState.phase === 'desperate') {
      this._tomasState.phase = 'transformed';
      this._tomasState.transformed = true;
      const inCellar = this.state.get('npcs.tomas.location') === 'cellar';
      if (inCellar) {
        this._whisperDM('TOMAS: Made it. Chain snaps taut. A sound that isn\'t human. He\'s locked in.', 1, 'story');
        this.bus.dispatch('ambient:environment', { text: 'A chain snaps taut somewhere below you. Then a sound that isn\'t human. Then silence.', tier: 'dread', timestamp: Date.now() });
      } else {
        this._whisperDM('⚠️ TOMAS TRANSFORMS IN THE ROOM. CR3 werewolf. He will run for the door.', 1, 'story');
        this.bus.dispatch('creature:tomas_transform', { location: this.state.get('npcs.tomas.location') || 'common-room' });
        this.bus.dispatch('atmo:change', { profile: 'terror_peak', reason: 'Tomas transforms', auto: true });
        // Place werewolf token where Tomas was
        const tomasToken = this._findNpcToken('tomas');
        if (tomasToken) {
          this._placeCreatureToken('token-werewolf-tomas', {
            name: 'Werewolf', actorSlug: 'werewolf', location: 'common-room-center',
            hidden: false, hp: { current: 58, max: 58 }, ac: 11, image: 'werewolf.webp'
          });
        }
      }
    }
  }

  // ─── VLADISLAV AWARENESS ─────────────────────────────────────

  /**
   * Task 6 (session0-polish follow-up) — per-tick advancement of
   * Vladislav's awareness phase. Transitions driven by world-clock
   * time plus flags set elsewhere (Dominik arrival, recognition at 21:15).
   *
   * Schedule:
   *   17:30-18:00 → neutral
   *   18:00-20:00 → unease
   *   20:00+ (or Dominik arrived flag) → sharpened_unease
   *   21:00 → window_watch (also moves his token to the east window)
   *   21:15+ (or recognition flag) → recognition then calculating
   *   22:00+ → reactive
   *   06:00+ → departure
   *
   * On each phase change, sets state.npcs.hooded-stranger.awarenessPhase,
   * dispatches creature:vladislav_phase_change, and whispers the DM earbud.
   */
  _tickVladislavAwareness(h, m, totalMinutes) {
    const ORDER = ['neutral', 'unease', 'sharpened_unease', 'window_watch',
                   'recognition', 'calculating', 'reactive', 'departure'];
    const current = this._vladislavState.awarenessPhase || 'neutral';
    const idx = (p) => ORDER.indexOf(p);
    const postMidnight = (h >= 0 && h < 12);   // Oct 16 morning

    // Compute the "time-appropriate" phase for the current tick.
    let target = current;   // default: no change

    if (postMidnight && current !== 'departure' && h >= 6) {
      // Dawn — advance to departure regardless of prior phase
      target = 'departure';
    } else if (postMidnight) {
      // Past midnight but before dawn — keep current phase (should be reactive
      // by now, don't regress if the tick hits a low totalMinutes value).
    } else if (totalMinutes >= 22 * 60) {
      target = 'reactive';
    } else if (this.state.get('flags.vladislav_knows_about_dominik') === true) {
      target = totalMinutes >= 21 * 60 + 20 ? 'calculating' : 'recognition';
    } else if (totalMinutes >= 21 * 60) {
      target = 'window_watch';
    } else if (totalMinutes >= 20 * 60 || this.state.get('flags.dominik_arrived') === true) {
      target = 'sharpened_unease';
    } else if (totalMinutes >= 18 * 60) {
      target = 'unease';
    } else {
      target = 'neutral';
    }

    // Ratchet forward — never regress
    if (idx(target) <= idx(current)) return;

    const prev = current;
    this._vladislavState.awarenessPhase = target;
    this.state.set('npcs.hooded-stranger.awarenessPhase', target);

    this._whisperDM(
      `VLADISLAV: awareness ${prev} → ${target} (at ${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}).`,
      2, 'story'
    );
    this.bus.dispatch('creature:vladislav_phase_change', {
      from: prev, to: target,
      gameTime: `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`
    });

    // Side effect on window_watch entry: move his token to the east window.
    // Phase 5 fragment carries the east window as (window-east) at (22,8)
    // grid coordinates on the ground floor = (22*140+70, 8*140+70) = (3150, 1190).
    // Actual map uses hooded-stranger start at (4100, 700); the east window
    // on pallidhearfloor1 is at approximately (4900, 1260) — the right edge.
    if (target === 'window_watch' && !this._vladislavState.tokenMovedToWindow) {
      this._vladislavState.tokenMovedToWindow = true;
      const windowX = 4700, windowY = 1260;
      const entry = this._findNpcToken('hooded-stranger');
      if (entry) {
        const [tokenId, tok] = entry;
        this.state.set(`map.tokens.${tokenId}.x`, windowX);
        this.state.set(`map.tokens.${tokenId}.y`, windowY);
        this.bus.dispatch('map:token_moved', {
          tokenId, x: windowX, y: windowY,
          oldX: tok.x, oldY: tok.y,
          reason: 'ambient-life-phase-change'
        });
      }
    }
  }

  // ─── PIOTR ───────────────────────────────────────────────────

  _tickPiotr(h, m, totalMinutes) {
    if (!this._piotrState.chainIntact) return;
    if (h === this._piotrState.lastChainTestHour) return;
    this._piotrState.lastChainTestHour = h;
    this.bus.dispatch('observation:trigger', { id: `piotr-chain-${h}`, dc: 10, text: 'A sound from below — chains, taut and straining. Something testing its limits.', nearCellarDoor: true, dcModifier: -5 });
    if (totalMinutes >= 22 * 60) {
      this._piotrState.breakChance += 1;
      const roll = Math.random() * 100;
      if (roll < this._piotrState.breakChance) {
        this._piotrState.chainIntact = false;
        this._whisperDM(`⚠️ PIOTR CHAIN BREAK — ${Math.round(this._piotrState.breakChance)}% chance, rolled ${Math.round(roll)}. Loose in the cellar.`, 1, 'story');
        this.bus.dispatch('creature:piotr_chain_break', { gameTime: `${h}:${m}` });
        this.bus.dispatch('ambient:environment', { text: 'A chain snaps below the floor. The silence that follows is complete.', tier: 'terror', timestamp: Date.now() });
        this.bus.dispatch('atmo:change', { profile: 'dread_rising', reason: 'Piotr chain breaks', auto: true });
        // Place Piotr token near cellar door
        this._placeCreatureToken('token-piotr-loose', {
          name: 'Piotr', actorSlug: 'vampire-spawn', location: 'near-cellar-door',
          hidden: true, hp: { current: 82, max: 82 }, ac: 15, image: 'vampire-spawn.webp'
        });
      }
    }
  }

  // ─── GAS SPORE ───────────────────────────────────────────────

  _tickGasSpore(h, m, totalMinutes) {
    const sessionStartMinutes = 17 * 60 + 30;
    const elapsed = totalMinutes >= sessionStartMinutes ? totalMinutes - sessionStartMinutes : totalMinutes + (24 * 60 - sessionStartMinutes);
    const newStage = Math.min(2, Math.floor(elapsed / 120));
    if (newStage > this._gasSporeState.driftStage) {
      this._gasSporeState.driftStage = newStage;
      const positions = ['against the east wall', 'near the center of the cellar', 'drifted toward the hearth-side wall'];
      this._gasSporeState.position = positions[newStage];
      this._whisperDM(`Gas Spore drifted: now ${this._gasSporeState.position}. Players who return will notice.`, 5, 'atmosphere');
    }
  }

  // ─── KAMENNÝ ─────────────────────────────────────────────────

  _tickKamenny(h, m, totalMinutes) {
    const circuitTimes = [19 * 60 + 30, 21 * 60 + 30, 23 * 60 + 30, 25 * 60 + 30, 27 * 60 + 30, 29 * 60 + 30];
    const normalizedTotal = totalMinutes < 17 * 60 ? totalMinutes + 24 * 60 : totalMinutes;
    for (const ct of circuitTimes) {
      const ctNorm = ct < 17 * 60 ? ct + 24 * 60 : ct;
      if (Math.abs(normalizedTotal - ctNorm) <= 2 && this._kamennyState.lastCircuitTime !== ct) {
        this._kamennyState.lastCircuitTime = ct;
        this._kamennyState.circuitCount++;
        const timeStr = `${Math.floor(ct / 60) % 24}:${(ct % 60).toString().padStart(2, '0')}`;
        this._whisperDM(`KAMENNÝ CIRCUIT #${this._kamennyState.circuitCount} at ${timeStr}. Stone-on-stone through the walls. ${this._kamennyState.skeletonTaken ? '⚠️ SKELETON TAKEN — hunting.' : 'Passive.'}`, 2, 'story');
        this.bus.dispatch('ambient:environment', { text: 'Something heavy moves outside. Stone on stone — slow, deliberate, circling.', tier: 'dread', timestamp: Date.now() });
        this.bus.dispatch('observation:trigger', { id: `kamenny-${this._kamennyState.circuitCount}`, dc: 12, text: 'Something is circling the inn. Too heavy for an animal. Too slow. Too deliberate.' });
        break;
      }
    }
  }

  // ─── LETAVEC ─────────────────────────────────────────────────

  _tickLetavec(h, m, totalMinutes) {
    const circuitPhase = totalMinutes % 13;
    if (circuitPhase > 1 || totalMinutes === this._letavecState.lastCircuitMinute) return;
    this._letavecState.lastCircuitMinute = totalMinutes;
    const isLateNight = h >= 22 || h < 6;
    const isMidnight = h === 0 || (h === 23 && m >= 58);

    // Wolf vs Letavec event
    if (isLateNight && !this._letavecState.wolfEventFired && this._wolfPackState.direWolfAlive) {
      const inWindow = totalMinutes >= 23 * 60 || totalMinutes < 3 * 60;
      if (inWindow && Math.random() < 0.08) this._fireWolfLetavecEvent(h, m);
    }

    if (isMidnight && this._letavecState.playerAloneOutside && !this._letavecState.midnightBreak) {
      this._letavecState.midnightBreak = true;
      this._whisperDM('⚠️ LETAVEC MIDNIGHT BREAK: Player alone outside. It has broken circuit. DC13 Perception: wingbeats overhead.', 1, 'story');
      this.bus.dispatch('observation:trigger', { id: 'letavec-midnight', dc: 13, text: 'Wings above you. Too large for any bird. The sound circles and tightens. Something is specifically interested in you.' });
    } else if (isLateNight && Math.random() < 0.25) {
      this.bus.dispatch('observation:trigger', { id: `letavec-wing-${totalMinutes}`, dc: 13, text: 'Something large passes overhead. The wingbeats are slow and enormous. Then silence.' });
    }

    // Addition 2 — telepathy scan. Each Letavec circuit, every chosen
    // target makes a Wisdom save. The save flash is delivered via the
    // existing combat:save_required infra (Build 6); the DM rolls at the
    // table, then resolves outcome via POST /api/telepathy/resolve which
    // dispatches telepathy:touch with the appropriate style.
    this._fireLetavecTelepathyScan();
  }

  _fireLetavecTelepathyScan() {
    const letavecConfig = this._loadCreatureConfig('nocni-letavec');
    if (!letavecConfig?.telepathy) return;

    const players = this.state.get('players') || {};
    // Per spec: only chosen targets are scanned. The list is hardcoded
    // to match the Session 0 selection — Spurt's id is held as
    // 'spurt-ai-pc' for the future AI-controlled-PC slot, and 'jerome'
    // covers Barry (absent S0 — won't fire until he joins, but listed
    // so the scan triggers correctly when he arrives). If a listed
    // playerId isn't in state.players or is absent, the entry skips.
    const chosenTargets = ['kim', 'nick', 'jen', 'ed', 'jerome', 'spurt-ai-pc'];
    for (const playerId of chosenTargets) {
      const playerState = players[playerId];
      if (!playerState || playerState.absent) continue;

      this.bus.dispatch('combat:save_required', {
        playerId,
        saveType: 'Wisdom',
        cause: letavecConfig.telepathy.onSaveSuccess.chromebookText
      });

      this._whisperDM(
        `LETAVEC TELEPATHY — ${playerId} must make DC ${letavecConfig.telepathy.saveDC} Wisdom save. ` +
        `On success: gold flash "${letavecConfig.telepathy.onSaveSuccess.chromebookText}". ` +
        `On fail: silent text "${letavecConfig.telepathy.onSaveFailure.chromebookText}". ` +
        `To deliver result: POST /api/telepathy/resolve {playerId, source:"letavec", saved:true/false}`,
        2, 'story'
      );
    }
  }

  _loadCreatureConfig(slug) {
    if (!slug) return null;
    if (!this._creatureConfigCache) this._creatureConfigCache = new Map();
    if (this._creatureConfigCache.has(slug)) return this._creatureConfigCache.get(slug);
    let cfg = null;
    try {
      const fs = require('fs');
      const path = require('path');
      for (const dir of ['creatures', 'actors', 'npcs']) {
        const p = path.join(__dirname, '..', '..', 'config', dir, `${slug}.json`);
        if (fs.existsSync(p)) { cfg = JSON.parse(fs.readFileSync(p, 'utf8')); break; }
      }
    } catch (e) {
      console.warn(`[AmbientLife] _loadCreatureConfig(${slug}) failed: ${e.message}`);
    }
    this._creatureConfigCache.set(slug, cfg);
    return cfg;
  }

  _fireWolfLetavecEvent(h, m) {
    this._letavecState.wolfEventFired = true;
    const aliveWolves = this._wolfPackState.wolves.filter(w => w.alive);
    if (aliveWolves.length === 0) return;
    const victim = aliveWolves[Math.floor(Math.random() * aliveWolves.length)];
    victim.alive = false;
    this._removeCreatureToken(`token-${victim.id}`);

    this._whisperDM('⚠️ LETAVEC VS WOLF — Dead wolf through the shutter in 3 seconds. Cold air in. Horror DC12. Window stays broken all session.', 1, 'story');

    setTimeout(() => {
      this.bus.dispatch('ambient:environment', {
        text: 'Something slams through the shutters with an explosion of wood. A wolf — dead, broken — skids across the floor and stops against a table. Cold air and snow pour through the ruined window. Outside, for just a moment, something enormous pulls away into the dark.',
        tier: 'terror', timestamp: Date.now()
      });
      this.bus.dispatch('atmo:change', { profile: 'revelation', reason: 'Letavec throws wolf through window', auto: true });
      this.bus.dispatch('horror:trigger', { triggerId: 'wolf-through-window', amount: 15, reason: 'Dead wolf through the shutters' });
      this.bus.dispatch('horror:floor_raise', { amount: 15, reason: 'Broken window — Letavec' });
      this.bus.dispatch('creature:letavec_wolf_event', { wolfId: victim.id, gameTime: `${h}:${m}`, windowBroken: true });
      this._whisperDM('Window broken and stays open. Cold, storm noise, snow drifting in all session. Vladislav did not flinch.', 1, 'story');

      // Place dead wolf token as object
      this._placeCreatureToken('token-dead-wolf', {
        name: 'Dead Wolf', actorSlug: 'dead-wolf', location: 'common-room-center',
        hidden: false, hp: { current: 0, max: 11 }, ac: 13, image: 'wolf.webp'
      });
    }, 3000);
  }

  // ─── CORPSE CANDLE ───────────────────────────────────────────

  _tickCorpseCandle(h, m, totalMinutes) {
    if (this._corpseCandleState.appeared) return;
    if (!(h === 0 && m <= 2)) return;
    this._corpseCandleState.appeared = true;
    const target = this._tomasState.transformed ? this._selectCorpseCandleTarget() : 'Tomas';
    this._whisperDM(`⚠️ CORPSE CANDLE — Midnight. Drifts toward ${target}. Even Vladislav watches. DO NOT let players attack it.`, 1, 'story');
    this.bus.dispatch('creature:corpse_candle_appear', { target, gameTime: '00:00' });
    this.bus.dispatch('ambient:environment', { text: 'A pale light drifts through the wall. No one moves. No one speaks. It bobs gently, moving toward one of you.', tier: 'terror', timestamp: Date.now() });
    this.bus.dispatch('atmo:change', { profile: 'revelation', reason: 'Corpse Candle appears', auto: true });
    this.bus.dispatch('horror:trigger', { triggerId: 'corpse-candle', amount: 20, reason: 'Corpse Candle appears at midnight' });

    // Place Corpse Candle token — visible, near target
    this._placeCreatureToken('token-corpse-candle', {
      name: 'Corpse Candle', actorSlug: 'corpse-candle', location: 'common-room-north',
      hidden: false, hp: { current: 1, max: 1 }, ac: 20, image: 'corpse-candle.webp'
    });

    const timeScale = this.state.get('world.timeScale') || 1;
    setTimeout(() => {
      this._whisperDM(`Corpse Candle settled near ${target}. NPCs will not approach that person.`, 2, 'story');
      this.bus.dispatch('creature:corpse_candle_settled', { target });
      // Move token to target location
      this._moveCreatureToken('token-corpse-candle', 'common-room-center');
    }, 180000 / Math.max(1, timeScale));
  }

  _selectCorpseCandleTarget() {
    const players = this.state.get('players') || {};
    const ids = Object.keys(players).filter(pid => players[pid]?.character && !players[pid]?.absent);
    if (ids.length > 0) return players[ids[0]]?.character?.name || 'a traveler';
    return 'one of the travelers';
  }

  // ─── VAMPIRE SPAWN ───────────────────────────────────────────

  _tickVampireSpawn(h, m, totalMinutes) {
    for (const spawn of this._vampireSpawnState) {
      if (!spawn.active) continue;
      if (!spawn.alerted) continue;

      // Move every 30 game minutes
      if (totalMinutes % 30 !== 0 || totalMinutes === spawn.lastMovedMinute) continue;
      spawn.lastMovedMinute = totalMinutes;

      const upperLocations = ['upper-hallway-west', 'upper-hallway-east', 'top-of-stairs', 'upper-hallway-center'];
      const newLoc = upperLocations[Math.floor(Math.random() * upperLocations.length)];
      spawn.location = newLoc;

      // Move existing token or place new one
      if (spawn.tokenId) {
        this._moveCreatureToken(spawn.tokenId, newLoc);
      }

      this._whisperDM(`Vampire Spawn (${spawn.id}) → ${newLoc}. Token moved. DC13 Perception: movement behind a door.`, 3, 'story');
      this.bus.dispatch('observation:trigger', { id: `spawn-move-${spawn.id}-${totalMinutes}`, dc: 13, text: 'Something moves on the floor above. Footsteps. Deliberate. Not quite right.', upstairsOnly: true });

      // After midnight — hunting mode
      if ((h >= 0 && h < 6) && !spawn.hunting) {
        spawn.hunting = true;
        if (spawn.tokenId) this._revealCreatureToken(spawn.tokenId);
        this._whisperDM(`Vampire Spawn (${spawn.id}) HUNTING — token now visible on DM map. Will approach any player alone upstairs.`, 1, 'story');
      }

      // Hunting — player alone upstairs
      if (spawn.hunting) {
        const upstairsPlayers = this._getUpstairsPlayers();
        if (upstairsPlayers.length === 1) {
          const ck = `spawn-hunt-${spawn.id}`;
          const now = Date.now();
          if (!this._dwellCooldowns[ck] || (now - this._dwellCooldowns[ck]) > 120000) {
            this._dwellCooldowns[ck] = now;
            this._whisperDM(`⚠️ VAMPIRE SPAWN HUNTING — ${upstairsPlayers[0]} alone upstairs. Spawn closing in. DC15: breathing behind the door.`, 1, 'story');
            this.bus.dispatch('observation:trigger', { id: `spawn-hunt-${totalMinutes}`, dc: 15, text: 'Behind the nearest door — breathing. Slow. Patient. Very close.', targetPlayer: upstairsPlayers[0] });
          }
        }
      }
    }
  }

  _getUpstairsPlayers() {
    const players = this.state.get('players') || {};
    return Object.keys(players).filter(pid => {
      const loc = this.state.get(`players.${pid}.location`) || '';
      return loc.includes('upper') || loc.includes('upstairs') || loc.includes('room-');
    });
  }

  // ─── RAT SWARMS ──────────────────────────────────────────────

  _tickRatSwarms(h, m, totalMinutes) {
    if (this._ratSwarmState.cooldownUntil > Date.now()) return;
    const avgHorror = this._getAvgHorror();
    const intervalMinutes = avgHorror > 60 ? 20 : avgHorror > 30 ? 35 : 50;

    for (const swarm of this._ratSwarmState.swarms) {
      if (totalMinutes - swarm.lastAppearMinute < intervalMinutes) continue;

      const locations = [
        { place: 'near-cellar-door', text: 'Scratching from below intensifies. Something with many legs.', dc: 8, env: false },
        { place: 'common-room-south', text: 'A tide of rats pours from a gap in the baseboard and crosses the floor toward the cellar.', dc: 6, env: true },
        { place: 'common-room-center', text: 'Small shapes drop from the rafters and scatter. Rats — dozens of them — pour across the tables and floor.', dc: 4, env: true },
        { place: 'upper-hallway-center', text: 'The floor above seethes with movement. Rats stream out of a room and down the hallway.', dc: 10, env: false },
        { place: 'behind-bar', text: 'Marta shrieks. Behind the bar a wave of rats surges up from below and scatters across the floor.', dc: 4, env: true }
      ];

      const loc = locations[Math.floor(Math.random() * locations.length)];
      swarm.lastAppearMinute = totalMinutes;
      this._ratSwarmState.cooldownUntil = Date.now() + 5 * 60 * 1000;

      if (loc.env) {
        this.bus.dispatch('ambient:environment', { text: loc.text, tier: 'dread', timestamp: Date.now() });
      }
      this._whisperDM(`RAT SWARM at ${loc.place} — CR 1/4. Can attack if cornered or horror > 50.`, 3, 'story');

      // Place token — auto-remove after 2 minutes
      const ratTokenId = `token-rats-${swarm.id}-${totalMinutes}`;
      this._placeCreatureToken(ratTokenId, {
        name: 'Swarm of Rats', actorSlug: 'rat-swarm', location: loc.place,
        hidden: false, hp: { current: 24, max: 24 }, ac: 10, image: 'swarm-of-rats.webp'
      });

      this.bus.dispatch('observation:trigger', { id: `rats-${swarm.id}-${totalMinutes}`, dc: loc.dc, text: loc.text });

      // Rats disperse after 3 real minutes unless in combat
      setTimeout(() => {
        if (!this.state.get('combat.active')) {
          this._removeCreatureToken(ratTokenId);
          this._whisperDM('Rat swarm dispersed.', 5, 'atmosphere');
        }
      }, 3 * 60 * 1000);

      break; // one swarm at a time
    }
  }

  // ─── BAT SWARM ───────────────────────────────────────────────

  _tickBats(h, m, totalMinutes) {
    const isNight = h >= 20 || h < 6;
    if (!isNight) return;
    if (totalMinutes - this._batState.lastEventMinute < 60) return;
    if (Math.random() > 0.3) return;
    this._batState.lastEventMinute = totalMinutes;

    const batEvents = [
      { text: 'A window rattles and a mass of bats pours through the gap — twenty, thirty of them, screaming and wheeling through the room before finding the chimney.', loc: 'common-room-north' },
      { text: 'Small shapes cascade down through a crack in the ceiling boards and scatter. A swarm of bats erupts through the room.', loc: 'common-room-center' },
      { text: 'The door bursts open in a gust — bats pour in with the wind, a black cloud of them, and are gone as suddenly as they arrived.', loc: 'entry-door' },
      { text: 'From upstairs — a door slams and bats flood down the staircase, a shrieking river of them, parting around the people in the room.', loc: 'upper-stairs-top' }
    ];

    const evt = batEvents[Math.floor(Math.random() * batEvents.length)];
    this.bus.dispatch('ambient:environment', { text: evt.text, tier: 'tense', timestamp: Date.now() });
    this._whisperDM('BAT SWARM — CR 1/4. Disperses in 1 round unless attacked.', 4, 'story');

    const batTokenId = `token-bats-${totalMinutes}`;
    this._placeCreatureToken(batTokenId, {
      name: 'Swarm of Bats', actorSlug: 'bat-swarm', location: evt.loc,
      hidden: false, hp: { current: 22, max: 22 }, ac: 12, image: 'swarm-of-bats.webp'
    });

    this.bus.dispatch('horror:trigger', { triggerId: 'bat-swarm', amount: 5, reason: 'Bat swarm erupts' });

    // Bats gone in 1 minute real time
    setTimeout(() => {
      this._removeCreatureToken(batTokenId);
    }, 60000);
  }

  // ─── WOLF PACK ───────────────────────────────────────────────

  _tickWolfPack(h, m, totalMinutes) {
    if (this._wolfPackState.scattered) return;
    const howlInterval = 30 + Math.floor(Math.random() * 15);
    if (totalMinutes - this._wolfPackState.lastHowlMinute < howlInterval) return;
    this._wolfPackState.lastHowlMinute = totalMinutes;

    const aliveWolves = this._wolfPackState.wolves.filter(w => w.alive).length;
    if (aliveWolves === 0 && !this._wolfPackState.direWolfAlive) return;

    const howls = [
      `${aliveWolves > 1 ? 'Wolves' : 'A wolf'} howl from the treeline. The deeper voice of something larger answers from the road.`,
      'A wolf howls to the north. Then from the south — answering. They are circling.',
      'The dire wolf — you can hear it from here, that bass rumble beneath the howl — calls from the road. The others answer.',
      'Close. Very close. A wolf is just outside the wall, testing the building.'
    ];

    this.bus.dispatch('ambient:environment', { text: howls[Math.floor(Math.random() * howls.length)], tier: 'tense', timestamp: Date.now() });
    this._whisperDM(`Wolf pack howl — ${aliveWolves} wolves + ${this._wolfPackState.direWolfAlive ? 'dire wolf alive' : 'dire wolf DEAD'}. ${this._wolfPackState.playerOutside ? '⚠️ PLAYER IS OUTSIDE.' : ''}`, 4, 'story');
    this.bus.dispatch('observation:trigger', { id: `wolf-howl-${totalMinutes}`, dc: 6, text: 'Wolves. Closer than they should be. And something larger.' });

    if (this._wolfPackState.playerOutside) {
      this._whisperDM('⚠️ WOLVES APPROACHING — player must retreat inside immediately or face the pack.', 1, 'story');
      this.bus.dispatch('creature:wolves_approach', { gameTime: `${h}:${m}` });

      // Place wolf tokens near entry if player is outside
      if (!this._creatureTokens.has('token-dire-wolf')) {
        this._placeCreatureToken('token-dire-wolf', {
          name: 'Dire Wolf', actorSlug: 'dire-wolf', location: 'outside',
          hidden: false, hp: { current: 37, max: 37 }, ac: 14, image: 'dire-wolf.webp'
        });
        this._wolfPackState.wolves.filter(w => w.alive).forEach((w, i) => {
          if (!this._creatureTokens.has(`token-${w.id}`)) {
            this._placeCreatureToken(`token-${w.id}`, {
              name: `Wolf`, actorSlug: 'wolf', location: i === 0 ? 'road-north' : i === 1 ? 'treeline-west' : 'road-south',
              hidden: false, hp: { current: 11, max: 11 }, ac: 13, image: 'wolf.webp'
            });
          }
        });
      }
    }
  }

  // ─── NECRONOMICON PAGE ───────────────────────────────────────
  //
  // Influence escalates once per game-hour while a carrier is set.
  // Each tick: the carrier makes a passive Wisdom save vs the current
  // DC (13 / 15 at 50+ / 17 at 75+). Fail = +5 influence.
  //
  // When influence crosses a threshold (25/50/75/100), the matching
  // effect fires: chromebook flash to the carrier, Max whisper to the
  // DM, and a horror bump for the carrier. Each threshold fires at
  // most once per session (tracked in thresholdsFired).
  //
  // Long-rest save opportunities are dispatched as
  // `artifact:page_save_opportunity` for the DM to prompt at the table.

  _loadPageConfig() {
    if (this._pageConfig) return this._pageConfig;
    try {
      const fs = require('fs');
      const path = require('path');
      const p = path.join(__dirname, '..', '..', 'config', 'npcs', 'necronomicon-page.json');
      if (fs.existsSync(p)) {
        this._pageConfig = JSON.parse(fs.readFileSync(p, 'utf8'));
      }
    } catch (e) {
      console.warn('[AmbientLife] Could not load necronomicon-page.json:', e.message);
    }
    return this._pageConfig;
  }

  _currentPageSaveDC() {
    if (this._pageState.influence >= 75) return 17;
    if (this._pageState.influence >= 50) return 15;
    return 13;
  }

  _carrierWisModifier() {
    const carrierId = this._pageState.carrierId;
    if (!carrierId) return 0;
    const ch = this.state.get(`players.${carrierId}.character`) || {};
    const mod = ch.abilities?.wis?.modifier;
    return Number.isFinite(mod) ? mod : 0;
  }

  _tickNecronomiconPage(h, m, totalMinutes) {
    if (!this._pageState.carrierId) return;
    if (h === this._pageState.lastHourTicked) return;
    this._pageState.lastHourTicked = h;

    const cfg = this._loadPageConfig();
    if (!cfg) return; // can't tick without config

    // Passive WIS save (10 + WIS mod) vs current DC
    const dc = this._currentPageSaveDC();
    const passive = 10 + this._carrierWisModifier();
    const saved = passive >= dc;

    if (!saved) {
      this._pageState.influence = Math.min(100, this._pageState.influence + 5);
    }

    // Walk thresholds in order — fire any newly crossed
    const thresholds = cfg.thresholdEffects || {};
    const sorted = Object.keys(thresholds).map(Number).sort((a, b) => a - b);
    for (const t of sorted) {
      if (this._pageState.thresholdsFired.has(t)) continue;
      if (this._pageState.influence < t) continue;
      const effect = thresholds[t];

      // Chromebook text → carrier only
      if (effect.chromebookText) {
        this.bus.dispatch('player:perception_flash', {
          playerId: this._pageState.carrierId,
          description: effect.chromebookText,
          margin: 0,
          waypoint: `necronomicon-page:${t}`
        });
      }

      // Max whisper to DM
      if (effect.maxWhisper) {
        this._whisperDM(`PAGE @ ${t}: ${effect.maxWhisper}`, 1, 'story');
      }

      // Horror bump for carrier specifically
      if (effect.horrorDelta && Number(effect.horrorDelta) !== 0) {
        this.bus.dispatch('horror:trigger', {
          playerId: this._pageState.carrierId,
          triggerId: `necronomicon-page-${t}`,
          amount: Number(effect.horrorDelta),
          reason: `Necronomicon page threshold ${t}`
        });
      }

      this._pageState.thresholdsFired.add(t);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // 6. SPONTANEOUS ENCOUNTER ENGINE
  // ═══════════════════════════════════════════════════════════════

  _tickSpontaneousEncounters(h, m, totalMinutes, worldService) {
    const engine = this._encounterEngine;
    if (engine.pendingProposal) return;
    const tokensRemaining = engine.threatBudget - engine.spentTokens;
    if (tokensRemaining <= 0) return;
    if (engine.cooldownUntil > Date.now()) return;
    if (totalMinutes - engine.lastEvalMinute < engine.evalIntervalMinutes) return;
    engine.lastEvalMinute = totalMinutes;
    const avgHorror = this._getAvgHorror();
    if (avgHorror < 20) return;
    this._proposeEncounter(h, m, totalMinutes, avgHorror, tokensRemaining);
  }

  async _proposeEncounter(h, m, totalMinutes, avgHorror, tokensRemaining) {
    const aiEngine = this.orchestrator.getService('ai-engine');
    if (!aiEngine?.gemini?.available) { this._ruleBasedProposal(h, m, avgHorror, tokensRemaining); return; }

    const gameTime = `${h.toString().padStart(2,'0')}:${m.toString().padStart(2,'0')}`;
    const context = `Game time: ${gameTime} | Horror: ${Math.round(avgHorror)}/100 | Tokens remaining: ${tokensRemaining}
Player locations: ${this._getPlayerLocationSummary()}
Tomas: ${this._tomasState.phase} | Piotr chain: ${this._piotrState.chainIntact ? 'intact' : 'BROKEN'}
Recent encounters: ${this._encounterEngine.recentEncounters.slice(-3).join(', ') || 'none'}
Available: rat-swarm (1 token, CR 1/4), bat-swarm (1 token, CR 1/4), wolf (1 token, CR 1/2), vampire-spawn (2 tokens, CR 5), dire-wolf (2 tokens, CR 1)`;

    try {
      const response = await aiEngine.gemini.generate(
        'You are Max, 30-year DM veteran. Decide whether to deploy a creature encounter. Be surgical — not every evaluation needs a creature. Respond ONLY in valid JSON, no markdown.',
        `${context}\n\nShould you deploy a spontaneous encounter right now? Respond with JSON only:\n{"deploy":true/false,"creature":"rat-swarm|bat-swarm|wolf|vampire-spawn|dire-wolf","location":"specific room or area","reason":"one sentence","narrative":"what players experience — one atmospheric sentence","dmNote":"one sentence for DM"}`,
        { maxTokens: 200, temperature: 0.8 }
      );
      if (!response) { this._ruleBasedProposal(h, m, avgHorror, tokensRemaining); return; }
      const clean = response.replace(/```json|```/g, '').trim();
      const proposal = JSON.parse(clean);
      if (!proposal.deploy) return;
      const paletteEntry = this._encounterPalette[proposal.creature];
      if (!paletteEntry || paletteEntry.cost > tokensRemaining) return;
      this._presentProposal({ ...proposal, cost: paletteEntry.cost, gameTime, stats: paletteEntry });
    } catch (err) {
      console.log(`[AmbientLife] Encounter eval error: ${err.message}`);
      this._ruleBasedProposal(h, m, avgHorror, tokensRemaining);
    }
  }

  _ruleBasedProposal(h, m, avgHorror, tokensRemaining) {
    const gameTime = `${h.toString().padStart(2,'0')}:${m.toString().padStart(2,'0')}`;
    let proposal = null;
    if (avgHorror > 70 && tokensRemaining >= 2 && !this._vampireSpawnState[0].alerted) {
      proposal = { creature: 'vampire-spawn', location: 'top-of-stairs', reason: 'Horror high, upper floor unguarded', narrative: 'Something stands at the top of the stairs. It does not move when the fire flickers.', dmNote: 'Spawn is observing — not yet hunting.', cost: 2 };
    } else if (avgHorror > 40 && tokensRemaining >= 1) {
      proposal = { creature: 'rat-swarm', location: 'common-room-center', reason: 'Rats reinforce decay and wrongness', narrative: 'The floor moves. A tide of rats pours from the baseboards and streams toward the cellar.', dmNote: 'Pure atmosphere unless cornered.', cost: 1 };
    } else if ((h >= 21 || h < 4) && tokensRemaining >= 1) {
      proposal = { creature: 'bat-swarm', location: 'common-room-north', reason: 'Late night atmosphere', narrative: 'Bats cascade down the chimney in a screaming cloud, wheel through the room, and are gone.', dmNote: 'Gone in 1 round.', cost: 1 };
    }
    if (proposal) this._presentProposal({ ...proposal, gameTime, stats: this._encounterPalette[proposal.creature] });
  }

  _presentProposal(proposal) {
    this._encounterEngine.pendingProposal = proposal;
    this._whisperDM(
      `⚡ ENCOUNTER PROPOSAL [${proposal.cost} token${proposal.cost > 1 ? 's' : ''}]\n` +
      `${proposal.creature} @ ${proposal.location}\n` +
      `Why: ${proposal.reason}\n` +
      `Players see: "${proposal.narrative}"\n` +
      `DM note: ${proposal.dmNote}\n` +
      `→ APPROVE: POST /api/encounter/approve  |  SKIP: POST /api/encounter/skip`,
      2, 'encounter'
    );
    this.bus.dispatch('encounter:proposal', proposal);
    console.log(`[AmbientLife] Encounter proposed: ${proposal.creature} @ ${proposal.location}`);
  }

  _executeProposedEncounter() {
    const proposal = this._encounterEngine.pendingProposal;
    if (!proposal) return;
    this._encounterEngine.pendingProposal = null;
    this._encounterEngine.spentTokens += proposal.cost;
    this._encounterEngine.recentEncounters.push(proposal.creature);
    if (this._encounterEngine.recentEncounters.length > 5) this._encounterEngine.recentEncounters.shift();
    this._encounterEngine.cooldownUntil = Date.now() + 10 * 60 * 1000;

    this.bus.dispatch('ambient:environment', { text: proposal.narrative, tier: 'dread', timestamp: Date.now() });

    // Place token for the approved encounter
    const tokenId = `token-encounter-${Date.now()}`;
    const stats = proposal.stats || this._encounterPalette[proposal.creature] || { hp: 10, ac: 10 };
    this._placeCreatureToken(tokenId, {
      name: this._creatureName(proposal.creature),
      actorSlug: proposal.creature,
      location: proposal.location,
      hidden: false,
      hp: { current: stats.hp, max: stats.hp },
      ac: stats.ac,
      image: `${proposal.creature}.webp`
    });

    this.bus.dispatch('creature:encounter_execute', { creature: proposal.creature, location: proposal.location, tokenId, gameTime: proposal.gameTime });
    this._whisperDM(`Encounter fired: ${proposal.creature} @ ${proposal.location}. Token placed. ${this._encounterEngine.threatBudget - this._encounterEngine.spentTokens} tokens remaining.`, 2, 'story');
    console.log(`[AmbientLife] Encounter executed: ${proposal.creature} (${proposal.cost} token spent)`);
  }

  _creatureName(slug) {
    const names = { 'rat-swarm': 'Swarm of Rats', 'bat-swarm': 'Swarm of Bats', 'wolf': 'Wolf', 'dire-wolf': 'Dire Wolf', 'vampire-spawn': 'Vampire Spawn' };
    return names[slug] || slug;
  }

  _getPlayerLocationSummary() {
    const players = this.state.get('players') || {};
    return Object.entries(players)
      .filter(([, p]) => p.character && !p.absent)
      .map(([pid, p]) => `${p.character?.name || pid}: ${this.state.get(`players.${pid}.location`) || 'common room'}`)
      .join(', ') || 'all in common room';
  }

  _findNpcToken(actorSlug) {
    const tokens = this.state.get('map.tokens') || {};
    return Object.entries(tokens).find(([, t]) => t.actorSlug === actorSlug || t.name?.toLowerCase().includes(actorSlug));
  }

  // ═══════════════════════════════════════════════════════════════
  // ROUTES — Session Test Mode + Encounter Approval
  // ═══════════════════════════════════════════════════════════════

  _setupRoutes(app) {
    if (!app) return;

    app.get('/api/session-test/status', (req, res) => {
      const ws = this.orchestrator.getService('world');
      res.json({ active: (ws?.timeScale || 1) >= 10, timeScale: ws?.timeScale || 1, gameTime: ws?.getFormattedGameTime() || null, ...this.getStatus() });
    });

    app.post('/api/session-test/start', (req, res) => {
      const scale = parseInt(req.body?.scale) || 20;
      const ws = this.orchestrator.getService('world');
      if (!ws) return res.status(503).json({ error: 'world service unavailable' });
      ws.setTimeScale(scale);
      this._resetAllStates();
      this._whisperDM(`SESSION TEST MODE — ${scale}x. Creature engine reset. Watch: Tomas 20:00, Kamenný 19:30, Letavec circuits, Spawns upstairs, Corpse Candle midnight.`, 1, 'system');
      res.json({ ok: true, timeScale: scale });
    });

    app.post('/api/session-test/stop', (req, res) => {
      const ws = this.orchestrator.getService('world');
      if (!ws) return res.status(503).json({ error: 'world service unavailable' });
      ws.setTimeScale(1);
      this._whisperDM('Session Test Mode ended. 1x.', 3, 'system');
      res.json({ ok: true, timeScale: 1 });
    });

    app.post('/api/session-test/jump', (req, res) => {
      const { hour, minute } = req.body;
      if (hour == null) return res.status(400).json({ error: 'hour required' });
      const ws = this.orchestrator.getService('world');
      if (!ws?.gameTime) return res.status(503).json({ error: 'world clock not running' });
      const current = ws.gameTime;
      let currentTotal = current.getHours() * 60 + current.getMinutes();
      let targetTotal = parseInt(hour) * 60 + (parseInt(minute) || 0);
      if (targetTotal <= currentTotal) targetTotal += 24 * 60;
      ws.advanceTime(targetTotal - currentTotal);
      res.json({ ok: true, jumped: targetTotal - currentTotal, gameTime: ws.getFormattedGameTime() });
    });

    app.post('/api/encounter/approve', (req, res) => {
      this.bus.dispatch('encounter:approved', {});
      res.json({ ok: true, executed: this._encounterEngine.recentEncounters.slice(-1)[0] || null });
    });

    app.post('/api/encounter/skip', (req, res) => {
      this.bus.dispatch('encounter:skipped', {});
      res.json({ ok: true });
    });

    app.get('/api/encounter/pending', (req, res) => {
      res.json({ proposal: this._encounterEngine.pendingProposal, tokensRemaining: this._encounterEngine.threatBudget - this._encounterEngine.spentTokens });
    });

    app.post('/api/encounter/add-budget', (req, res) => {
      const amount = parseInt(req.body?.amount) || 1;
      this._encounterEngine.threatBudget += amount;
      res.json({ ok: true, threatBudget: this._encounterEngine.threatBudget, tokensRemaining: this._encounterEngine.threatBudget - this._encounterEngine.spentTokens });
    });

    // Place a creature token manually from DM dashboard
    app.post('/api/creature/place', (req, res) => {
      const { creature, location, hidden } = req.body;
      if (!creature) return res.status(400).json({ error: 'creature required' });
      const stats = this._encounterPalette[creature] || { hp: 10, ac: 10 };
      const tokenId = `token-manual-${creature}-${Date.now()}`;
      this._placeCreatureToken(tokenId, {
        name: this._creatureName(creature), actorSlug: creature,
        location: location || 'common-room-center',
        hidden: hidden || false,
        hp: { current: stats.hp, max: stats.hp }, ac: stats.ac,
        image: `${creature}.webp`
      });
      res.json({ ok: true, tokenId });
    });

    // Remove a creature token manually
    app.delete('/api/creature/token/:tokenId', (req, res) => {
      this._removeCreatureToken(req.params.tokenId);
      res.json({ ok: true });
    });

    // List all active creature tokens
    app.get('/api/creature/tokens', (req, res) => {
      res.json(Array.from(this._creatureTokens.entries()).map(([id, data]) => ({ tokenId: id, ...data })));
    });

    // ── Necronomicon page state inspector ──
    app.get('/api/artifact/necronomicon-page', (req, res) => {
      res.json({
        carrier: this._pageState.carrierId,
        influence: this._pageState.influence,
        thresholdsFired: Array.from(this._pageState.thresholdsFired),
        currentSaveDC: this._currentPageSaveDC()
      });
    });

    // ── Set the page carrier (e.g. when a player searches and finds it) ──
    app.post('/api/artifact/page-carrier', (req, res) => {
      const playerId = req.body?.playerId;
      if (!playerId) return res.status(400).json({ error: 'playerId required' });
      this.bus.dispatch('artifact:page_carrier_set', { playerId });
      res.json({ ok: true, carrier: playerId, influence: this._pageState.influence });
    });

    // ── Drop the page (carrier puts it down, hands it off, etc.) ──
    app.post('/api/artifact/page-drop', (req, res) => {
      this.bus.dispatch('artifact:page_dropped', {});
      res.json({ ok: true });
    });

    // ── Apply long-rest save result from the table ──
    // Body: { saved: boolean }. On save: -10 influence (but not below 0).
    app.post('/api/artifact/page-rest-save', (req, res) => {
      const saved = req.body?.saved === true;
      if (saved) {
        this._pageState.influence = Math.max(0, this._pageState.influence - 10);
        this._whisperDM(`Page save SUCCEEDED. Influence ${this._pageState.influence}.`, 2, 'story');
      } else {
        this._whisperDM(`Page save FAILED. Influence holds at ${this._pageState.influence}.`, 2, 'story');
      }
      res.json({ ok: true, influence: this._pageState.influence });
    });

    // ── Addition 2 — telepathy save resolver ──
    // DM rolls the Wisdom save at the table after the player gets the
    // initial save flash, then POSTs the outcome here. We load the
    // source's telepathy block and dispatch telepathy:touch with the
    // appropriate style (gold-flash / silent / null).
    //
    // Body: { playerId, source: 'vladislav'|'letavec'|'page', saved: bool }
    app.post('/api/telepathy/resolve', (req, res) => {
      const { playerId, source, saved } = req.body || {};
      if (!playerId || !source) return res.status(400).json({ error: 'playerId and source required' });

      // Vladislav's stat block lives in config/actors/, not config/npcs/.
      const configMap = {
        'vladislav': 'config/actors/vladislav.json',
        'letavec':   'config/creatures/nocni-letavec.json',
        'page':      'config/npcs/necronomicon-page.json'
      };
      const relPath = configMap[source];
      if (!relPath) return res.status(400).json({ error: `Unknown source: ${source}` });

      let telepathy;
      try {
        const fs = require('fs');
        const path = require('path');
        const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', relPath), 'utf8'));
        telepathy = cfg.telepathy;
      } catch (e) {
        return res.status(404).json({ error: `Config not found for source: ${source}` });
      }
      if (!telepathy) return res.status(400).json({ error: `Source ${source} has no telepathy block` });

      if (saved) {
        // Resisted — gold-flash chromebook + DM whisper
        this.bus.dispatch('telepathy:touch', {
          playerId,
          style: 'gold-flash',
          text: telepathy.onSaveSuccess?.chromebookText || ''
        });
        this._whisperDM(telepathy.onSaveSuccess?.dmWhisper || '', 2, 'story');
        // Necronomicon page: also bump no-influence-this-hour record
        if (source === 'page' && this._pageState) {
          this._pageState.lastHourTicked = new Date().getHours();
        }
      } else {
        const fail = telepathy.onSaveFailure || {};
        if (fail.mode === 'planted-thought') {
          const templates = Array.isArray(fail.thoughtTemplates) ? fail.thoughtTemplates : [];
          const text = templates.length
            ? templates[Math.floor(Math.random() * templates.length)]
            : '';
          this.bus.dispatch('telepathy:touch', { playerId, style: 'silent', text });
          // Page-specific: planted thought = +5 influence
          if (source === 'page' && this._pageState) {
            this._pageState.influence = Math.min(100, this._pageState.influence + 5);
          }
        } else if (fail.chromebookStyle === 'silent' && fail.chromebookText) {
          this.bus.dispatch('telepathy:touch', { playerId, style: 'silent', text: fail.chromebookText });
        } else {
          // Information-mode: nothing visible to the player
          this.bus.dispatch('telepathy:touch', { playerId, style: null, text: null });
        }
        this._whisperDM(fail.dmWhisper || '', 1, 'story');
      }

      res.json({ ok: true, playerId, source, saved: !!saved });
    });

    console.log('[AmbientLife] Routes registered');
  }

  // ═══════════════════════════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════════════════════════

  _whisperDM(text, priority, category) {
    this.bus.dispatch('dm:whisper', { text, priority: priority || 5, category: category || 'ambient' });
  }

  _getAvgHorror() {
    const horrorService = this.orchestrator?.getService('horror');
    const scores = horrorService?.horrorScores || {};
    const vals = Object.values(scores);
    return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  }
}

module.exports = AmbientLifeService;
