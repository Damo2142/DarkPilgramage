/**
 * Ambient Life Service
 *
 * 1. Environmental ticks
 * 2. NPC autonomous movement
 * 3. Player proximity dwell triggers
 * 4. Katya performances
 * 5. Creature behavior engine (Tomas, Piotr, Gas Spore, Kamenný, Letavec, Corpse Candle,
 *    Vampire Spawn x2, Rat Swarms x2, Bat Swarm, Wolf Pack + Dire Wolf)
 * 6. Spontaneous encounter engine — Max evaluates, proposes, DM approves
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
      lastCircuitMinute: -1, midnightBreak: false, playerAloneOutside: false,
      wolfEventFired: false, wolfEventWindow: false
    };

    this._corpseCandleState = {
      appeared: false, circuiting: false, circuitStartReal: null
    };

    // Second floor — spawn positions from map
    this._vampireSpawnState = [
      { id: 'spawn-1', location: 'upper-hallway-west', active: true,
        alerted: false, hunting: false, lastMovedMinute: -1 },
      { id: 'spawn-2', location: 'lower-room-cluster', active: true,
        alerted: false, hunting: false, lastMovedMinute: -1 }
    ];

    this._ratSwarmState = {
      swarms: [
        { id: 'rats-1', location: 'cellar', active: true, lastAppearMinute: -1 },
        { id: 'rats-2', location: 'upper-floor', active: true, lastAppearMinute: -1 }
      ],
      commonRoomVisited: false,
      cooldownUntil: 0  // real timestamp
    };

    this._batState = {
      lastEventMinute: -1, triggered: false
    };

    this._wolfPackState = {
      direWolfAlive: true,
      wolves: [
        { id: 'wolf-1', alive: true, location: 'road-north' },
        { id: 'wolf-2', alive: true, location: 'treeline-west' },
        { id: 'wolf-3', alive: true, location: 'road-south' }
      ],
      lastHowlMinute: -1,
      scattered: false,
      playerOutside: false
    };

    // ── SPONTANEOUS ENCOUNTER ENGINE ─────────────────────────────
    this._encounterEngine = {
      threatBudget: 6,         // tokens available this session
      spentTokens: 0,
      lastEvalMinute: -1,
      evalIntervalMinutes: 10, // evaluate every 10 game minutes
      pendingProposal: null,   // proposal waiting for DM approval
      recentEncounters: [],    // last 3 encounter types to avoid repeating
      cooldownUntil: 0         // real timestamp
    };

    // Palette: creature → cost in threat tokens
    this._encounterPalette = {
      'rat-swarm':     { cost: 1, cr: '1/4', locations: ['cellar','common-room','upper-hallway','any'] },
      'bat-swarm':     { cost: 1, cr: '1/4', locations: ['common-room','upper-hallway','outside','attic'] },
      'wolf':          { cost: 1, cr: '1/2', locations: ['outside','road'] },
      'vampire-spawn': { cost: 2, cr: '5',   locations: ['upper-hallway','upper-room'] },
      'dire-wolf':     { cost: 2, cr: '1',   locations: ['outside','road'] }
    };
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

    this.bus.subscribe('combat:started', () => this._stopAll(), 'ambient-life');
    this.bus.subscribe('combat:ended', () => this._onSessionStart(), 'ambient-life');

    // DM override events
    this.bus.subscribe('creature:skeleton_taken', () => {
      this._kamennyState.skeletonTaken = true;
      this._whisperDM('Kamenný: skeleton taken. It steps between the thief and the door.', 1, 'story');
    }, 'ambient-life');

    this.bus.subscribe('creature:player_alone_outside', (data) => {
      this._letavecState.playerAloneOutside = true;
      this._wolfPackState.playerOutside = true;
      this._whisperDM('A player is alone outside — Letavec and wolf pack are aware.', 1, 'story');
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
      this._wolfPackState.wolves.forEach(w => w.location = 'fled');
      this._whisperDM('Dire wolf killed — pack scatters immediately. No more wolf activity tonight.', 1, 'story');
      this.bus.dispatch('ambient:environment', {
        text: 'The howling that has circled the inn all night cuts off suddenly. Then — silence from the forest.',
        tier: 'dread', timestamp: Date.now()
      });
    }, 'ambient-life');

    this.bus.subscribe('creature:player_upstairs', (data) => {
      this._vampireSpawnState.forEach(spawn => {
        if (!spawn.alerted) {
          spawn.alerted = true;
          this._whisperDM(
            `Vampire Spawn (${spawn.id}) is aware a player is on the upper floor. ` +
            'It will begin moving toward them. DC13 Perception: sound of movement behind a door.',
            2, 'story'
          );
        }
      });
    }, 'ambient-life');

    // Encounter approval from DM dashboard
    this.bus.subscribe('encounter:approved', () => this._executeProposedEncounter(), 'ambient-life');
    this.bus.subscribe('encounter:skipped', () => {
      if (this._encounterEngine.pendingProposal) {
        console.log('[AmbientLife] Encounter skipped: ' + this._encounterEngine.pendingProposal.creature);
        this._encounterEngine.pendingProposal = null;
        this._encounterEngine.cooldownUntil = Date.now() + 5 * 60 * 1000;
      }
    }, 'ambient-life');

    setTimeout(() => {
      const app = this.orchestrator.getService('dashboard')?.app;
      this._setupRoutes(app);
    }, 2000);

    console.log('[AmbientLife] Ready — creature engine + spontaneous encounters loaded');
  }

  async stop() { this._stopAll(); }

  getStatus() {
    return {
      status: 'ok',
      envTickActive: !!this._envTickInterval,
      creatureTickActive: !!this._creatureTickInterval,
      creatures: {
        tomas: this._tomasState.phase,
        piotr: this._piotrState.chainIntact ? 'chained' : 'FREE',
        gasSpore: this._gasSporeState.position,
        kamenný: 'circuit ' + this._kamennyState.circuitCount,
        letavec: this._letavecState.midnightBreak ? 'midnight-break' : 'circling',
        corpseCandle: this._corpseCandleState.appeared ? 'appeared' : 'waiting',
        vampireSpawn: this._vampireSpawnState.map(s => s.hunting ? 'HUNTING' : s.alerted ? 'alerted' : 'dormant'),
        wolves: this._wolfPackState.scattered ? 'scattered' : ('pack active (dire wolf ' + (this._wolfPackState.direWolfAlive ? 'alive' : 'dead') + ')'),
        ratSwarms: 'active'
      },
      encounterEngine: {
        threatBudget: this._encounterEngine.threatBudget,
        spentTokens: this._encounterEngine.spentTokens,
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

  _resetAllStates() {
    this._lastCreatureGameTime = null;
    this._playerDwellTimers = {};
    this._dwellCooldowns = {};
    this._npcMoveHistory = {};
    this._performanceIndex = 0;
    this._tomasState = { phase: 'normal', lastWhisperPhase: null, goalActivated: false, transformed: false };
    this._piotrState = { chainIntact: true, breakChance: 0, lastChainTestHour: -1 };
    this._gasSporeState = { position: 'east-wall', driftStage: 0, cellarVisits: 0, movedNotified: false };
    this._kamennyState = { lastCircuitTime: -1, skeletonTaken: false, circuitCount: 0 };
    this._letavecState = { lastCircuitMinute: -1, midnightBreak: false, playerAloneOutside: false, wolfEventFired: false, wolfEventWindow: false };
    this._corpseCandleState = { appeared: false, circuiting: false, circuitStartReal: null };
    this._vampireSpawnState.forEach(s => { s.alerted = false; s.hunting = false; s.lastMovedMinute = -1; });
    this._ratSwarmState.commonRoomVisited = false;
    this._ratSwarmState.cooldownUntil = 0;
    this._ratSwarmState.swarms.forEach(s => s.lastAppearMinute = -1);
    this._batState = { lastEventMinute: -1, triggered: false };
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
    this._whisperDM('Environment: ' + text, 5, 'atmosphere');
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
    this._npcMoveInterval = setTimeout(() => {
      this._fireNpcMove();
      this._scheduleNextNpcMove();
    }, intervalMs);
  }

  _fireNpcMove() {
    if (this.state.get('session.status') !== 'active') return;
    if (this.state.get('combat.active')) return;
    const npcs = this.config.npcs || {};
    const activeNpcs = Object.entries(npcs).filter(([, npc]) =>
      (npc.status === 'alive' || !npc.status) && npc.name
    );
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
    this.state.set('npcs.' + npcId + '.location', move.label);
    var npcName = npc.name || npcId;
    this._whisperDM(npcName + ' ' + move.action, 5, 'ambient');
    this.bus.dispatch('ambient:npc_move', { npcId: npcId, npcName: npcName, label: move.label, action: move.action, timestamp: Date.now() });
  }

  _getNpcMoveOptions(npcId) {
    var moves = {
      'marta': [
        { label: 'behind the bar', action: 'moves behind the bar, polishing glasses nervously.'},
        { label: 'by the fireplace', action: 'moves to the fireplace to add a log. Her hands tremble.'},
        { label: 'near the cellar door', action: 'walks toward the cellar door, hesitates, then stops.'},
        { label: 'serving tables', action: 'circles the room refilling mugs, avoiding the stranger\'s corner.'}
      ],
      'tomas': [
        { label: 'near the entry door', action: 'moves to the door and checks the latch again.'},
        { label: 'by the window', action: 'stands at the window, staring at the sky through the frost.'},
        { label: 'near the cellar door', action: 'drifts toward the cellar door, trying to look casual.'},
        { label: 'pacing by the wall', action: 'paces along the far wall, unable to sit still.'}
      ],
      'patron-farmer': [
        { label: 'table near the hearth', action: 'hasn\'t moved from his spot by the fire. Staring into the flames.'},
        { label: 'at the bar', action: 'shuffles to the bar and asks Marta for something stronger.'}
      ],
      'patron-merchant': [
        { label: 'table with his goods', action: 'reorganizes his merchant goods under the table for the fifth time.'},
        { label: 'at the bar', action: 'goes to the bar and orders another drink.'},
        { label: 'near the entry door', action: 'moves to the door and peers through the keyhole at the storm.'}
      ],
      'patron-pilgrim': [
        { label: 'corner table with candle', action: 'remains at his corner table, praying quietly.'},
        { label: 'near the cellar door', action: 'approaches the cellar door. Places his palm flat against it. Steps back.'}
      ],
      'patron-minstrel': [
        { label: 'by the hearth with lute', action: 'settles by the hearth and tunes her lute absently.'},
        { label: 'at the bar', action: 'leans against the bar, chatting with Marta in low tones.'},
        { label: 'wandering the room', action: 'strolls through the room, observing everyone with those sharp eyes.'}
      ]
    };
    return moves[npcId] || [];
  }

  // ═══════════════════════════════════════════════════════════════
  // 3. PLAYER PROXIMITY DWELL
  // ═══════════════════════════════════════════════════════════════

  _startDwellCheck() {
    this._dwellCheckInterval = setInterval(() => this._checkDwells(), 5000);
  }

  _checkDwells() {
    if (this.state.get('session.status') !== 'active') return;
    if (this.state.get('combat.active')) return;
    var tokens = this.state.get('map.tokens') || {};
    var gridSize = this.state.get('map.gridSize') || 70;
    var feetPerGrid = 5;
    var now = Date.now();
    var playerTokens = Object.entries(tokens).filter(function(e) { return e[1].type === 'pc'; });
    var npcTokens = Object.entries(tokens).filter(function(e) { return e[1].type === 'npc' && !e[1].hidden; });

    for (var pi = 0; pi < playerTokens.length; pi++) {
      var ptId = playerTokens[pi][0];
      var pt = playerTokens[pi][1];
      var playerId = pt.playerId || ptId;
      var nearestNpc = null;
      var nearestDist = Infinity;
      for (var ni = 0; ni < npcTokens.length; ni++) {
        var ntId = npcTokens[ni][0];
        var nt = npcTokens[ni][1];
        var dx = pt.x - nt.x;
        var dy = pt.y - nt.y;
        var distFeet = (Math.sqrt(dx * dx + dy * dy) / gridSize) * feetPerGrid;
        if (distFeet <= 10 && distFeet < nearestDist) { nearestDist = distFeet; nearestNpc = Object.assign({ tokenId: ntId }, nt); }
      }
      var existing = this._playerDwellTimers[playerId];
      if (nearestNpc) {
        var npcId = nearestNpc.actorSlug || nearestNpc.tokenId;
        if (existing && existing.nearNpcId === npcId) {
          if (!existing.triggered && (now - existing.startedAt) >= this._dwellThresholdMs) {
            var cooldownKey = playerId + '-' + npcId;
            if (this._dwellCooldowns[cooldownKey] && (now - this._dwellCooldowns[cooldownKey]) < 300000) { existing.triggered = true; continue; }
            existing.triggered = true;
            this._dwellCooldowns[cooldownKey] = now;
            this._fireDwellTrigger(playerId, npcId, nearestNpc);
          }
        } else {
          this._playerDwellTimers[playerId] = { nearNpcId: npcId, startedAt: now, triggered: false };
        }
      } else {
        delete this._playerDwellTimers[playerId];
      }
    }
    this._checkCellarProximity(playerTokens, gridSize, feetPerGrid, now);
  }

  _fireDwellTrigger(playerId, npcId, npcToken) {
    var npcName = npcToken.name || npcId;
    this._whisperDM(playerId + ' lingering near ' + npcName + ' — they may react.', 3, 'ambient');
    var genericReactions = {
      'marta': 'Marta glances at you and offers a nervous smile. "Can I get you something?"',
      'tomas': 'Tomas eyes you warily. His hand moves to his forearm.',
      'hooded-stranger': 'The stranger turns his head. Slowly. He looks directly at you.',
      'patron-farmer': 'Old Gregor looks up. "You see it too, don\'t you?"',
      'patron-merchant': '"Need something? Fair prices."',
      'patron-pilgrim': '"Sit, friend. There is safety in fellowship."',
      'patron-minstrel': 'Katya looks up with a knowing smile. "Curious about something?"'
    };
    var text = genericReactions[npcId] || (npcName + ' looks up and acknowledges your presence.');
    this.bus.dispatch('ambient:dwell_reaction', { npcId: npcId, npcName: npcToken.name || npcId, playerId: playerId, text: text, timestamp: Date.now() });
  }

  _checkCellarProximity(playerTokens, gridSize, feetPerGrid, now) {
    var cellarDoor = this.state.get('map.interestPoints.cellarDoor');
    if (!cellarDoor) return;
    for (var i = 0; i < playerTokens.length; i++) {
      var ptId = playerTokens[i][0];
      var pt = playerTokens[i][1];
      var playerId = pt.playerId || ptId;
      var dx = pt.x - cellarDoor.x;
      var dy = pt.y - cellarDoor.y;
      var distFeet = (Math.sqrt(dx * dx + dy * dy) / gridSize) * feetPerGrid;
      if (distFeet <= 10) {
        var cooldownKey = playerId + '-cellar';
        if (this._dwellCooldowns[cooldownKey] && (now - this._dwellCooldowns[cooldownKey]) < 600000) continue;
        this._dwellCooldowns[cooldownKey] = now;
        this._whisperDM(playerId + ' is at the cellar door. Vladislav will notice.', 2, 'story');
        this.bus.dispatch('ambient:cellar_interest', { playerId: playerId, timestamp: now });
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // 4. KATYA PERFORMANCES
  // ═══════════════════════════════════════════════════════════════

  _startPerformances() { this._scheduleNextPerformance(); }

  _scheduleNextPerformance() {
    var intervalMs = 480000 + Math.floor(Math.random() * 420000);
    this._performanceInterval = setTimeout(() => {
      this._firePerformance();
      this._scheduleNextPerformance();
    }, intervalMs);
  }

  _firePerformance() {
    if (this.state.get('session.status') !== 'active') return;
    if (this.state.get('combat.active')) return;
    var currentProfile = this.state.get('atmosphere.activeProfile') || '';
    if (currentProfile.includes('dread') || currentProfile.includes('terror') || currentProfile.includes('combat')) return;
    var katya = this.config.npcs && this.config.npcs['patron-minstrel'];
    if (!katya || !katya.performances) return;
    var tier = currentProfile.includes('tense') ? 'tavern_tense' : 'tavern_warm';
    var performances = katya.performances[tier];
    if (!performances || performances.length === 0) return;
    var perf = performances[this._performanceIndex % performances.length];
    this._performanceIndex++;
    this._whisperDM('Katya performs: ' + perf.title, 4, 'story');
    this.bus.dispatch('ambient:performance', {
      npcId: 'patron-minstrel', npcName: 'Katya',
      type: perf.type, title: perf.title, content: perf.content, timestamp: Date.now()
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // 5. CREATURE BEHAVIOR ENGINE
  // ═══════════════════════════════════════════════════════════════

  _startCreatureEngine() {
    this._creatureTickInterval = setInterval(() => this._creatureTick(), 10000);
    console.log('[AmbientLife] Creature engine started (12 creatures + encounter engine)');
  }

  _creatureTick() {
    if (this.state.get('session.status') !== 'active') return;
    if (this.state.get('combat.active')) return;

    var gtIso = this.state.get('world.gameTime');
    if (!gtIso) return;
    var gt = new Date(gtIso);
    if (isNaN(gt.getTime())) return;

    var h = gt.getUTCHours();
    var m = gt.getUTCMinutes();
    var gtKey = h + ':' + m;
    if (gtKey === this._lastCreatureGameTime) return;
    this._lastCreatureGameTime = gtKey;
    var totalMinutes = h * 60 + m;

    this._tickTomas(h, m, totalMinutes);
    this._tickPiotr(h, m, totalMinutes);
    this._tickGasSpore(h, m, totalMinutes);
    this._tickKamenny(h, m, totalMinutes);
    this._tickLetavec(h, m, totalMinutes);
    this._tickCorpseCandle(h, m, totalMinutes);
    this._tickVampireSpawn(h, m, totalMinutes);
    this._tickRatSwarms(h, m, totalMinutes);
    this._tickBats(h, m, totalMinutes);
    this._tickWolfPack(h, m, totalMinutes);
    this._tickSpontaneousEncounters(h, m, totalMinutes);
  }

  // ─── TOMAS ───────────────────────────────────────────────────

  _tickTomas(h, m, totalMinutes) {
    if (this._tomasState.transformed) return;
    if (totalMinutes >= 20 * 60 && this._tomasState.phase === 'normal') {
      this._tomasState.phase = 'anxious';
      this._whisperDM('TOMAS: Moon anxiety beginning. Stops eating. Keeps touching his forearm. DC14.', 2, 'story');
      this.bus.dispatch('creature:tomas_phase', { phase: 'anxious' });
      this.bus.dispatch('observation:trigger', { id: 'tomas-anxiety', dc: 14, text: 'Tomas has stopped eating. He keeps pressing his hand against his forearm through the sleeve.', targetPlayer: null });
    }
    if (totalMinutes >= 20 * 60 + 30 && this._tomasState.phase === 'anxious' && this._tomasState.lastWhisperPhase !== '20:30') {
      this._tomasState.lastWhisperPhase = '20:30';
      this._whisperDM('TOMAS: Visibly sweating. Hands shaking. Insists he is fine.', 2, 'story');
    }
    if (totalMinutes >= 21 * 60 && this._tomasState.phase === 'anxious') {
      this._tomasState.phase = 'desperate';
      this._whisperDM('TOMAS: Needs the cellar NOW. One hour before it stops mattering.', 1, 'story');
      this.bus.dispatch('creature:tomas_phase', { phase: 'desperate' });
      if (!this._tomasState.goalActivated) {
        this._tomasState.goalActivated = true;
        this.bus.dispatch('world:npc_goal_activated', { npcId: 'tomas', goalId: 'reach-cellar', goal: 'Reach cellar before 22:00' });
      }
    }
    if (totalMinutes >= 21 * 60 + 30 && this._tomasState.phase === 'desperate' && this._tomasState.lastWhisperPhase !== '21:30') {
      this._tomasState.lastWhisperPhase = '21:30';
      this._whisperDM('TOMAS [30 MIN]: Transforms wherever he is if he cannot reach cellar. CR3 werewolf. Room full of people.', 1, 'story');
    }
    if (totalMinutes >= 21 * 60 + 50 && this._tomasState.phase === 'desperate' && this._tomasState.lastWhisperPhase !== '21:50') {
      this._tomasState.lastWhisperPhase = '21:50';
      this._whisperDM('TOMAS [URGENT — 10 MIN]: Control almost gone. Shaking. Anyone within 10ft hears wrong breathing.', 1, 'story');
      this.bus.dispatch('observation:trigger', { id: 'tomas-breaking', dc: 10, text: 'Tomas is shaking. His breathing is ragged and too fast. Something is very wrong.', targetPlayer: null });
    }
    if (totalMinutes >= 22 * 60 && this._tomasState.phase === 'desperate') {
      this._tomasState.phase = 'transformed';
      this._tomasState.transformed = true;
      var inCellar = this.state.get('npcs.tomas.location') === 'cellar';
      if (inCellar) {
        this._whisperDM('TOMAS: Made it to cellar. Chain snaps taut. Not human sound. He is locked in.', 1, 'story');
        this.bus.dispatch('ambient:environment', { text: 'A chain snaps taut below. Then a sound that isn\'t human. Then silence.', tier: 'dread', timestamp: Date.now() });
      } else {
        this._whisperDM('TOMAS TRANSFORMS IN THE ROOM — CR3 werewolf. Everyone sees it. He will run for the door.', 1, 'story');
        this.bus.dispatch('creature:tomas_transform', { location: this.state.get('npcs.tomas.location') || 'common-room' });
        this.bus.dispatch('atmo:change', { profile: 'combat_chaos', reason: 'Tomas transforms', auto: true });
      }
    }
  }

  // ─── PIOTR ───────────────────────────────────────────────────

  _tickPiotr(h, m, totalMinutes) {
    if (!this._piotrState.chainIntact) return;
    if (h === this._piotrState.lastChainTestHour) return;
    this._piotrState.lastChainTestHour = h;
    this.bus.dispatch('observation:trigger', { id: 'piotr-chain-' + h, dc: 10, text: 'Chains below — taut and straining. Something testing its limits.', nearCellarDoor: true, dcModifier: -5 });
    if (totalMinutes >= 22 * 60) {
      this._piotrState.breakChance += 1;
      var roll = Math.random() * 100;
      if (roll < this._piotrState.breakChance) {
        this._piotrState.chainIntact = false;
        this._whisperDM('PIOTR CHAIN BREAK — ' + Math.round(this._piotrState.breakChance) + '% chance, rolled ' + Math.round(roll) + '. He is loose.', 1, 'story');
        this.bus.dispatch('creature:piotr_chain_break', { gameTime: h + ':' + m });
        this.bus.dispatch('ambient:environment', { text: 'A chain snaps below the floor. The silence that follows is complete.', tier: 'terror', timestamp: Date.now() });
        this.bus.dispatch('atmo:change', { profile: 'terror_mounting', reason: 'Piotr chain breaks', auto: true });
      }
    }
  }

  // ─── GAS SPORE ───────────────────────────────────────────────

  _tickGasSpore(h, m, totalMinutes) {
    var sessionStartMinutes = 17 * 60 + 30;
    var elapsed = totalMinutes >= sessionStartMinutes ? totalMinutes - sessionStartMinutes : totalMinutes + (24 * 60 - sessionStartMinutes);
    var newStage = Math.min(2, Math.floor(elapsed / 120));
    if (newStage > this._gasSporeState.driftStage) {
      this._gasSporeState.driftStage = newStage;
      var positions = ['against the east wall', 'near the center of the cellar', 'drifted toward the hearth-side wall'];
      this._gasSporeState.position = positions[newStage];
      this._whisperDM('Gas Spore drifted: now ' + this._gasSporeState.position + '. Players who return will notice.', 5, 'atmosphere');
    }
  }

  // ─── KAMENNÝ ─────────────────────────────────────────────────

  _tickKamenny(h, m, totalMinutes) {
    var circuitTimes = [19 * 60 + 30, 21 * 60 + 30, 23 * 60 + 30, 25 * 60 + 30, 27 * 60 + 30, 29 * 60 + 30];
    var normalizedTotal = totalMinutes < 17 * 60 ? totalMinutes + 24 * 60 : totalMinutes;
    for (var i = 0; i < circuitTimes.length; i++) {
      var ct = circuitTimes[i];
      var ctNorm = ct < 17 * 60 ? ct + 24 * 60 : ct;
      if (Math.abs(normalizedTotal - ctNorm) <= 2 && this._kamennyState.lastCircuitTime !== ct) {
        this._kamennyState.lastCircuitTime = ct;
        this._kamennyState.circuitCount++;
        var timeStr = (Math.floor(ct / 60) % 24) + ':' + (ct % 60 < 10 ? '0' : '') + (ct % 60);
        this._whisperDM('KAMENNÝ CIRCUIT #' + this._kamennyState.circuitCount + ' at ' + timeStr + '. Stone-on-stone sounds. ' + (this._kamennyState.skeletonTaken ? 'SKELETON TAKEN — looking for them.' : 'Passive unless disturbed.'), 2, 'story');
        this.bus.dispatch('ambient:environment', { text: 'Something heavy moves outside. Stone on stone — slow, deliberate, circling.', tier: 'dread', timestamp: Date.now() });
        this.bus.dispatch('observation:trigger', { id: 'kamenny-' + this._kamennyState.circuitCount, dc: 12, text: 'Something circling the inn. Too heavy for an animal. Too slow. Too deliberate.', targetPlayer: null });
        break;
      }
    }
  }

  // ─── LETAVEC ─────────────────────────────────────────────────

  _tickLetavec(h, m, totalMinutes) {
    var circuitPhase = totalMinutes % 13;
    if (circuitPhase <= 1 && totalMinutes !== this._letavecState.lastCircuitMinute) {
      this._letavecState.lastCircuitMinute = totalMinutes;
      var isLateNight = h >= 22 || h < 6;
      var isMidnight = h === 0 || (h === 23 && m >= 58);

      // Wolf vs Letavec event
      if (isLateNight && !this._letavecState.wolfEventFired && this._wolfPackState.direWolfAlive) {
        var eventWindow = totalMinutes >= 23 * 60 || totalMinutes < 3 * 60;
        if (eventWindow && Math.random() < 0.08) {
          this._fireWolfLetavecEvent(h, m);
        }
      }

      if (isMidnight && this._letavecState.playerAloneOutside && !this._letavecState.midnightBreak) {
        this._letavecState.midnightBreak = true;
        this._whisperDM('LETAVEC MIDNIGHT BREAK: Player alone outside. Broken circuit. Watching them. DC13 Perception: wingbeats overhead.', 1, 'story');
        this.bus.dispatch('creature:letavec_midnight_break', { gameTime: h + ':' + m });
        this.bus.dispatch('observation:trigger', { id: 'letavec-midnight', dc: 13, text: 'Wings above you. Too large for any bird. The sound circles and tightens.', targetPlayer: 'alone-outside' });
      } else if (isLateNight && Math.random() < 0.25) {
        this.bus.dispatch('observation:trigger', { id: 'letavec-wing-' + totalMinutes, dc: 13, text: 'Something large passes overhead. Slow enormous wingbeats. Then silence.', targetPlayer: null });
      }
    }
  }

  _fireWolfLetavecEvent(h, m) {
    this._letavecState.wolfEventFired = true;
    var aliveWolves = this._wolfPackState.wolves.filter(function(w) { return w.alive; });
    if (aliveWolves.length === 0) return;
    var victim = aliveWolves[Math.floor(Math.random() * aliveWolves.length)];
    victim.alive = false;

    this._whisperDM(
      'LETAVEC VS WOLF — The Letavec caught a pack wolf. Dead wolf incoming through a shutter. Cold air and snow pour in. Shutter is damaged. Horror DC12.',
      1, 'story'
    );

    var self = this;
    setTimeout(function() {
      self.bus.dispatch('ambient:environment', {
        text: 'Something slams through the shutters with an explosion of wood and glass. A wolf — dead, broken — skids across the floor. Cold air and snow pour through the ruined window. Outside, something enormous pulls away into the dark.',
        tier: 'terror', timestamp: Date.now()
      });
      self.bus.dispatch('atmo:change', { profile: 'terror_revelation', reason: 'Letavec throws wolf through window', auto: true });
      self.bus.dispatch('horror:check', { trigger: 'wolf-through-window', dc: 12, description: 'A dead wolf crashes through the shutters at impossible force.', targetAll: true });
      self.bus.dispatch('creature:letavec_wolf_event', { wolfId: victim.id, gameTime: h + ':' + m, windowBroken: true });
      self._whisperDM('Window broken — stays open all session. Cold air, storm noise. Vladislav did not flinch. He is the only one who didn\'t.', 1, 'story');
      self.bus.dispatch('horror:floor_raise', { amount: 15, reason: 'Letavec wolf event' });
    }, 3000);
  }

  // ─── CORPSE CANDLE ───────────────────────────────────────────

  _tickCorpseCandle(h, m, totalMinutes) {
    if (this._corpseCandleState.appeared) return;
    if (h === 0 && m <= 2) {
      this._corpseCandleState.appeared = true;
      var target = this._tomasState.transformed ? this._selectCorpseCandleTarget() : 'Tomas';
      this._whisperDM('CORPSE CANDLE — Midnight. Drifts toward ' + target + '. Room goes silent. Even Vladislav watches. DO NOT let players attack it — screams, DC14 Horror, madness on fail.', 1, 'story');
      this.bus.dispatch('creature:corpse_candle_appear', { target: target, gameTime: '00:00' });
      this.bus.dispatch('ambient:environment', { text: 'A pale light drifts through the wall. No one moves. No one speaks. It bobs gently, moving toward one of you.', tier: 'terror', timestamp: Date.now() });
      this.bus.dispatch('atmo:change', { profile: 'revelation_horror', reason: 'Corpse Candle appears', auto: true });
      this.bus.dispatch('horror:check', { trigger: 'corpse-candle', dc: 10, description: 'A deathlight circles the room.', targetAll: true });
      var timeScale = this.state.get('world.timeScale') || 1;
      var self = this;
      setTimeout(function() {
        self._whisperDM('Corpse Candle settled near ' + target + '. NPCs will not approach that person.', 2, 'story');
        self.bus.dispatch('creature:corpse_candle_settled', { target: target });
      }, 180000 / Math.max(1, timeScale));
    }
  }

  _selectCorpseCandleTarget() {
    var players = this.state.get('players') || {};
    var ids = Object.keys(players).filter(function(pid) { return players[pid] && players[pid].character && !players[pid].absent; });
    if (ids.length > 0) return (players[ids[0]].character && players[ids[0]].character.name) || 'a traveler';
    return 'one of the travelers';
  }

  // ─── VAMPIRE SPAWN ───────────────────────────────────────────

  _tickVampireSpawn(h, m, totalMinutes) {
    for (var si = 0; si < this._vampireSpawnState.length; si++) {
      var spawn = this._vampireSpawnState[si];
      if (!spawn.active) continue;
      if (spawn.alerted && totalMinutes !== spawn.lastMovedMinute && totalMinutes % 30 === 0) {
        spawn.lastMovedMinute = totalMinutes;
        var movements = [
          'has moved to a different room. A door closes — slowly.',
          'is in the hallway. Footsteps. Then nothing.',
          'is at the top of the stairs. If any player is upstairs they feel watched.',
          'has pressed itself against the wall beside a door. Waiting.'
        ];
        var movement = movements[Math.floor(Math.random() * movements.length)];
        this._whisperDM('Vampire Spawn (' + spawn.id + ') ' + movement, 3, 'story');
        this.bus.dispatch('observation:trigger', { id: 'spawn-move-' + spawn.id + '-' + totalMinutes, dc: 13, text: 'Something moves on the floor above. Deliberate footsteps. Not quite right.', upstairsOnly: true });
        if ((h >= 0 && h < 6) && !spawn.hunting) {
          spawn.hunting = true;
          this._whisperDM('Vampire Spawn (' + spawn.id + ') is now HUNTING. Will approach any player alone upstairs.', 1, 'story');
        }
      }
      if (spawn.hunting) {
        var upstairsPlayers = this._getUpstairsPlayers();
        if (upstairsPlayers.length === 1) {
          var cooldownKey = 'spawn-hunt-' + spawn.id;
          var now = Date.now();
          if (!this._dwellCooldowns[cooldownKey] || (now - this._dwellCooldowns[cooldownKey]) > 120000) {
            this._dwellCooldowns[cooldownKey] = now;
            this._whisperDM('VAMPIRE SPAWN HUNTING — ' + upstairsPlayers[0] + ' is alone upstairs. Spawn is closing in. DC15: breathing behind the door.', 1, 'story');
            this.bus.dispatch('observation:trigger', { id: 'spawn-hunt-' + totalMinutes, dc: 15, text: 'Behind the nearest door — breathing. Slow. Patient. Very close.', targetPlayer: upstairsPlayers[0] });
          }
        }
      }
    }
  }

  _getUpstairsPlayers() {
    var players = this.state.get('players') || {};
    return Object.keys(players).filter(function(pid) {
      var loc = players[pid] && players[pid].location || '';
      return loc.includes('upper') || loc.includes('upstairs') || loc.includes('room-');
    });
  }

  // ─── RAT SWARMS ──────────────────────────────────────────────

  _tickRatSwarms(h, m, totalMinutes) {
    if (this._ratSwarmState.cooldownUntil > Date.now()) return;
    var avgHorror = this._getAvgHorror();
    var intervalMinutes = avgHorror > 60 ? 20 : avgHorror > 30 ? 35 : 50;
    for (var i = 0; i < this._ratSwarmState.swarms.length; i++) {
      var swarm = this._ratSwarmState.swarms[i];
      if (totalMinutes - swarm.lastAppearMinute < intervalMinutes) continue;
      var locations = [
        { place: 'cellar', text: 'Scratching from below intensifies. Something with many legs.', dc: 8 },
        { place: 'common-room-wall', text: 'The wall moves. A tide of rats pours from a gap in the baseboard.', dc: 6 },
        { place: 'common-room-rafters', text: 'Small shapes drop from the rafters and scatter. Rats — dozens.', dc: 4 },
        { place: 'upper-hallway', text: 'Upstairs the floor seethes with movement. Rats, hundreds, streaming out.', dc: 10 },
        { place: 'behind-bar', text: 'Marta shrieks. Behind the bar a wave of rats surges up from below.', dc: 4 }
      ];
      var loc = locations[Math.floor(Math.random() * locations.length)];
      swarm.lastAppearMinute = totalMinutes;
      this._ratSwarmState.cooldownUntil = Date.now() + 5 * 60 * 1000;
      this.bus.dispatch('ambient:environment', { text: loc.text, tier: 'dread', timestamp: Date.now() });
      this._whisperDM('RAT SWARM at ' + loc.place + ' — CR 1/4. DC' + loc.dc + '.', 3, 'story');
      this.bus.dispatch('creature:rat_swarm_appear', { swarmId: swarm.id, location: loc.place, gameTime: h + ':' + m });
      this.bus.dispatch('observation:trigger', { id: 'rats-' + swarm.id + '-' + totalMinutes, dc: loc.dc, text: loc.text, targetPlayer: null });
      break;
    }
  }

  // ─── BAT SWARM ───────────────────────────────────────────────

  _tickBats(h, m, totalMinutes) {
    var isNight = h >= 20 || h < 6;
    if (!isNight) return;
    if (totalMinutes - this._batState.lastEventMinute < 60) return;
    if (Math.random() > 0.3) return;
    this._batState.lastEventMinute = totalMinutes;
    var batEvents = [
      'A window rattles and bats pour through — twenty, thirty, screaming through the room before finding the chimney.',
      'Something disturbs the attic. Hundreds of small shapes cascade down through a crack in the ceiling.',
      'The door bursts open in a gust — bats pour in with the wind, a black cloud, and are gone as suddenly.',
      'From upstairs — a door slams and bats flood down the staircase, a shrieking river of them.'
    ];
    var text = batEvents[Math.floor(Math.random() * batEvents.length)];
    this.bus.dispatch('ambient:environment', { text: text, tier: 'tense', timestamp: Date.now() });
    this._whisperDM('BAT SWARM — CR 1/4. Pure atmosphere unless attacked. Disperses in 1 round.', 4, 'story');
    this.bus.dispatch('creature:bat_swarm', { gameTime: h + ':' + m });
    this.bus.dispatch('horror:check', { trigger: 'bat-swarm', dc: 8, description: 'A swarm of bats erupts through the room.', targetAll: false });
  }

  // ─── WOLF PACK ───────────────────────────────────────────────

  _tickWolfPack(h, m, totalMinutes) {
    if (this._wolfPackState.scattered) return;
    var howlInterval = 30 + Math.floor(Math.random() * 15);
    if (totalMinutes - this._wolfPackState.lastHowlMinute >= howlInterval) {
      this._wolfPackState.lastHowlMinute = totalMinutes;
      var aliveCount = this._wolfPackState.wolves.filter(function(w) { return w.alive; }).length;
      if (aliveCount > 0) {
        var howls = [
          (aliveCount > 2 ? 'Three' : aliveCount > 1 ? 'Two' : 'One') + ' wolf' + (aliveCount !== 1 ? 's' : '') + ' howl from the treeline. Something larger answers from the road.',
          'A wolf howls to the north. Then from the south — answering. They are communicating, circling.',
          'The dire wolf — that bass rumble beneath the howl — calls from the road. The others answer from three directions.',
          'Close. Very close. A wolf just outside the wall, testing the building.'
        ];
        var text = howls[Math.floor(Math.random() * howls.length)];
        this.bus.dispatch('ambient:environment', { text: text, tier: 'tense', timestamp: Date.now() });
        this._whisperDM('Wolf pack howl — ' + aliveCount + ' wolves + dire wolf. ' + (this._wolfPackState.playerOutside ? 'PLAYER IS OUTSIDE — wolves aware.' : 'Circling, testing perimeter.'), 4, 'story');
        this.bus.dispatch('observation:trigger', { id: 'wolf-howl-' + totalMinutes, dc: 6, text: 'Wolves. Closer than they should be. And something larger.', targetPlayer: null });
      }
      if (this._wolfPackState.playerOutside) {
        this._whisperDM('WOLVES APPROACHING OUTSIDE PLAYER — will engage unless player retreats inside. Dire wolf watches.', 1, 'story');
        this.bus.dispatch('creature:wolves_approach', { gameTime: h + ':' + m });
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // 6. SPONTANEOUS ENCOUNTER ENGINE
  // ═══════════════════════════════════════════════════════════════

  _tickSpontaneousEncounters(h, m, totalMinutes) {
    var engine = this._encounterEngine;
    if (engine.pendingProposal) return;
    var tokensRemaining = engine.threatBudget - engine.spentTokens;
    if (tokensRemaining <= 0) return;
    if (engine.cooldownUntil > Date.now()) return;
    if (totalMinutes - engine.lastEvalMinute < engine.evalIntervalMinutes) return;
    engine.lastEvalMinute = totalMinutes;
    var avgHorror = this._getAvgHorror();
    if (avgHorror < 20) return;
    this._proposeEncounter(h, m, totalMinutes, avgHorror, tokensRemaining);
  }

  async _proposeEncounter(h, m, totalMinutes, avgHorror, tokensRemaining) {
    var aiEngine = this.orchestrator.getService('ai-engine');
    if (!aiEngine || !aiEngine.gemini || !aiEngine.gemini.available) {
      this._ruleBasedProposal(h, m, avgHorror, tokensRemaining);
      return;
    }

    var gameTime = (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
    var playerLocations = this._getPlayerLocationSummary();
    var recentActivity = this._encounterEngine.recentEncounters.slice(-3).join(', ') || 'none';
    var context = 'Game time: ' + gameTime + '\nHorror: ' + Math.round(avgHorror) + '/100\nTokens: ' + tokensRemaining + '\nPlayers: ' + playerLocations + '\nTomas: ' + this._tomasState.phase + '\nPiotr: ' + (this._piotrState.chainIntact ? 'chained' : 'FREE') + '\nRecent: ' + recentActivity + '\nAvailable: rat-swarm(1), bat-swarm(1), wolf(1), vampire-spawn(2), dire-wolf(2)';

    var systemPrompt = 'You are Max — 30 years of DM experience. You decide whether to deploy a spontaneous encounter. Be surgical. One creature, one location, one reason. Respond ONLY in JSON.';
    var userPrompt = context + '\n\nDeploy a creature encounter? JSON only:\n{"deploy":true/false,"creature":"...","location":"...","reason":"...","narrative":"...","dmNote":"..."}';

    try {
      var response = await aiEngine.gemini.generate(systemPrompt, userPrompt, { maxTokens: 200, temperature: 0.8 });
      if (!response) { this._ruleBasedProposal(h, m, avgHorror, tokensRemaining); return; }
      var clean = response.replace(/```json|```/g, '').trim();
      var proposal = JSON.parse(clean);
      if (!proposal.deploy) return;
      var paletteEntry = this._encounterPalette[proposal.creature];
      if (!paletteEntry || paletteEntry.cost > tokensRemaining) return;
      this._presentProposal({ creature: proposal.creature, location: proposal.location, reason: proposal.reason, narrative: proposal.narrative, dmNote: proposal.dmNote, cost: paletteEntry.cost, gameTime: gameTime });
    } catch (err) {
      console.log('[AmbientLife] Encounter engine parse error: ' + err.message);
      this._ruleBasedProposal(h, m, avgHorror, tokensRemaining);
    }
  }

  _ruleBasedProposal(h, m, avgHorror, tokensRemaining) {
    var gameTime = (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
    var proposal = null;
    if (avgHorror > 70 && tokensRemaining >= 2 && !this._vampireSpawnState[0].alerted) {
      proposal = { creature: 'vampire-spawn', location: 'top of stairs', reason: 'Horror high, upper floor unguarded', narrative: 'Something stands at the top of the stairs. It does not move when the fire flickers.', dmNote: 'Observation only unless provoked.', cost: 2 };
    } else if (avgHorror > 40 && tokensRemaining >= 1) {
      proposal = { creature: 'rat-swarm', location: 'common room floor', reason: 'Horror rising — rats reinforce decay', narrative: 'The floor moves. A tide of rats pours from the baseboards toward the cellar.', dmNote: 'CR 1/4. Atmosphere unless attacked.', cost: 1 };
    } else if ((h >= 21 || h < 4) && tokensRemaining >= 1) {
      proposal = { creature: 'bat-swarm', location: 'chimney', reason: 'Late night — bats add atmosphere', narrative: 'Bats cascade down the chimney in a screaming cloud, wheel through the room, and are gone.', dmNote: 'Pure atmosphere. 1 round.', cost: 1 };
    }
    if (proposal) { proposal.gameTime = gameTime; this._presentProposal(proposal); }
  }

  _presentProposal(proposal) {
    this._encounterEngine.pendingProposal = proposal;
    this._whisperDM(
      'ENCOUNTER PROPOSAL [' + proposal.cost + ' token' + (proposal.cost > 1 ? 's' : '') + ']\n' +
      'Creature: ' + proposal.creature + ' at ' + proposal.location + '\n' +
      'Why: ' + proposal.reason + '\n' +
      'Players see: "' + proposal.narrative + '"\n' +
      'Note: ' + proposal.dmNote,
      2, 'encounter'
    );
    this.bus.dispatch('encounter:proposal', proposal);
    console.log('[AmbientLife] Encounter proposed: ' + proposal.creature + ' at ' + proposal.location);
  }

  _executeProposedEncounter() {
    var proposal = this._encounterEngine.pendingProposal;
    if (!proposal) return;
    this._encounterEngine.pendingProposal = null;
    this._encounterEngine.spentTokens += proposal.cost;
    this._encounterEngine.recentEncounters.push(proposal.creature);
    if (this._encounterEngine.recentEncounters.length > 5) this._encounterEngine.recentEncounters.shift();
    this._encounterEngine.cooldownUntil = Date.now() + 10 * 60 * 1000;
    this.bus.dispatch('ambient:environment', { text: proposal.narrative, tier: 'dread', timestamp: Date.now() });
    this.bus.dispatch('creature:encounter_execute', { creature: proposal.creature, location: proposal.location, narrative: proposal.narrative, dmNote: proposal.dmNote, gameTime: proposal.gameTime });
    this._whisperDM('Encounter fired: ' + proposal.creature + ' at ' + proposal.location + '. ' + proposal.dmNote, 2, 'story');
    console.log('[AmbientLife] Encounter executed: ' + proposal.creature + ' (' + proposal.cost + ' token, ' + (this._encounterEngine.threatBudget - this._encounterEngine.spentTokens) + ' remaining)');
  }

  _getPlayerLocationSummary() {
    var players = this.state.get('players') || {};
    var parts = [];
    for (var pid in players) {
      var p = players[pid];
      if (p && p.character && !p.absent) {
        parts.push((p.character.name || pid) + ': ' + (this.state.get('players.' + pid + '.location') || 'common room'));
      }
    }
    return parts.join(', ') || 'all in common room';
  }

  // ═══════════════════════════════════════════════════════════════
  // SESSION TEST MODE + API ROUTES
  // ═══════════════════════════════════════════════════════════════

  _setupRoutes(app) {
    if (!app) return;

    var self = this;

    app.get('/api/session-test/status', function(req, res) {
      var gtIso = self.state.get('world.gameTime');
      var timeScale = self.state.get('world.timeScale') || 1;
      res.json(Object.assign({ active: timeScale >= 5, timeScale: timeScale, gameTime: gtIso || null }, self.getStatus()));
    });

    app.post('/api/session-test/start', function(req, res) {
      var scale = parseInt((req.body && req.body.scale) || 20);
      self.state.set('world.timeScale', scale);
      self._resetAllStates();
      self._whisperDM('SESSION TEST MODE — ' + scale + 'x compression. Creature engine reset. Watch: Tomas 20:00, Kamenný 19:30, Letavec circuits, Corpse Candle midnight.', 1, 'system');
      console.log('[AmbientLife] Session Test Mode: ' + scale + 'x');
      res.json({ ok: true, timeScale: scale });
    });

    app.post('/api/session-test/stop', function(req, res) {
      self.state.set('world.timeScale', 1);
      self._whisperDM('Session Test Mode ended. 1x.', 3, 'system');
      res.json({ ok: true, timeScale: 1 });
    });

    app.post('/api/encounter/approve', function(req, res) {
      self.bus.dispatch('encounter:approved', {});
      res.json({ ok: true });
    });

    app.post('/api/encounter/skip', function(req, res) {
      self.bus.dispatch('encounter:skipped', {});
      res.json({ ok: true });
    });

    app.get('/api/encounter/pending', function(req, res) {
      res.json({ proposal: self._encounterEngine.pendingProposal || null, tokensRemaining: self._encounterEngine.threatBudget - self._encounterEngine.spentTokens });
    });

    console.log('[AmbientLife] Routes registered');
  }

  // ═══════════════════════════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════════════════════════

  _whisperDM(text, priority, category) {
    this.bus.dispatch('dm:whisper', { text: text, priority: priority || 5, category: category || 'ambient' });
  }

  _getAvgHorror() {
    var players = this.state.get('players') || {};
    var total = 0, count = 0;
    for (var pid in players) {
      var p = players[pid];
      if (p && !p.absent && p.dread) {
        total += (p.dread.score || 0);
        count++;
      }
    }
    return count > 0 ? total / count : 0;
  }
}

module.exports = AmbientLifeService;
