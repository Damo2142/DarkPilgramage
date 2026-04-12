/**
 * Ambient Life Service
 * Keeps the world alive between major story beats:
 *
 * 1. Environmental ticks — wind, fire, cellar sounds, wolves
 *    Frequency scales with horror score (calm = every 3-5 min, terror = every 1-2 min)
 *
 * 2. NPC autonomous movement — NPCs shift positions on the map
 *    (Marta to fireplace, Tomas to window, Katya moves seats)
 *
 * 3. Player proximity dwell — when a player token lingers near
 *    an NPC or location of interest for 30+ seconds, trigger
 *    an interaction prompt or atmospheric description
 *
 * 4. Katya performances — timed storytelling events
 *
 * 5. CREATURE BEHAVIOR ENGINE — runtime state machines for Session 0 creatures:
 *    Tomas (werewolf escalation), Piotr (chain tests), Gas Spore (drift),
 *    Kamenný (inn circuit), Noční Letavec (13-min circuit), Corpse Candle (midnight)
 */

class AmbientLifeService {
  constructor() {
    this.name = 'ambient-life';
    this.orchestrator = null;
    this.bus = null;
    this.state = null;

    // Environmental tick timer
    this._envTickInterval = null;
    this._lastEnvTick = 0;

    // NPC movement timer
    this._npcMoveInterval = null;
    this._lastNpcMove = 0;
    this._npcMoveHistory = {};

    // Proximity dwell tracking
    this._dwellCheckInterval = null;
    this._playerDwellTimers = {};
    this._dwellThresholdMs = 30000;
    this._dwellCooldowns = {};

    // Katya performance timer
    this._performanceInterval = null;
    this._lastPerformance = 0;
    this._performanceIndex = 0;

    // ── CREATURE ENGINE ──────────────────────────────────────────
    this._creatureTickInterval = null;
    this._lastCreatureGameTime = null; // ISO string of last processed game time

    this._tomasState = {
      phase: 'normal',       // normal | anxious | desperate | transformed
      lastWhisperPhase: null,
      goalActivated: false,
      transformed: false
    };

    this._piotrState = {
      chainIntact: true,
      breakChance: 0,         // cumulative %, starts at 0, +1% per hour after 22:00
      lastChainTestHour: -1,  // game hour of last test
      soundFired: false
    };

    this._gasSporeState = {
      position: 'east-wall',  // east-wall | center | near-hearth
      driftStage: 0,          // 0, 1, 2 — how far it has drifted
      cellarVisits: 0,        // how many times players visited cellar
      movedNotified: false
    };

    this._kamennyState = {
      lastCircuitGameHour: -1,  // game hour when last circuit completed
      skeletonTaken: false,
      circuitCount: 0
    };

    this._letavecState = {
      lastCircuitGameMinute: -1,  // game minute (0-779 over 13hrs) of last circuit
      circuitInterval: 13,        // minutes
      midnightBreak: false,
      playerAloneOutside: false
    };

    this._corpseCandleState = {
      appeared: false,
      circuiting: false,
      circuitStartReal: null,   // real timestamp when circuit began
      circuitDurationMs: 180000 // 3 real minutes (scaled)
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
      this._resetCreatureStates();
      this._playerDwellTimers = {};
      this._dwellCooldowns = {};
      this._npcMoveHistory = {};
      this._performanceIndex = 0;
    }, 'ambient-life');

    // Pause ambient during combat
    this.bus.subscribe('combat:started', () => this._stopAll(), 'ambient-life');
    this.bus.subscribe('combat:ended', () => this._onSessionStart(), 'ambient-life');

    // Creature state overrides from DM
    this.bus.subscribe('creature:skeleton_taken', () => {
      this._kamennyState.skeletonTaken = true;
      this._whisperDM('Kamenný: skeleton has been taken. It will step between the player and the door.', 1, 'story');
    }, 'ambient-life');

    this.bus.subscribe('creature:player_alone_outside', (data) => {
      this._letavecState.playerAloneOutside = true;
      this._whisperDM(`Letavec: ${data?.playerId || 'a player'} is alone outside. After midnight it will break pattern.`, 1, 'story');
    }, 'ambient-life');

    this.bus.subscribe('creature:cellar_visit', () => {
      this._gasSporeState.cellarVisits++;
      if (this._gasSporeState.cellarVisits === 2 && !this._gasSporeState.movedNotified) {
        this._gasSporeState.movedNotified = true;
        this._whisperDM('Gas Spore: players visiting cellar a second time will notice it has drifted closer to the hearth-side wall. It moved while they were gone.', 3, 'story');
      }
    }, 'ambient-life');

    // Routes registered after a brief delay so dashboard is fully up
    setTimeout(() => {
      const app = this.orchestrator.getService('dashboard')?.app;
      this.setupTestModeRoutes(app);
    }, 2000);

    console.log('[AmbientLife] Ready — creature engine loaded');
  }

  async stop() {
    this._stopAll();
  }

  getStatus() {
    return {
      status: 'ok',
      envTickActive: !!this._envTickInterval,
      npcMoveActive: !!this._npcMoveInterval,
      dwellCheckActive: !!this._dwellCheckInterval,
      creatureTickActive: !!this._creatureTickInterval,
      trackedDwells: Object.keys(this._playerDwellTimers).length,
      creatures: {
        tomas: this._tomasState.phase,
        piotr: this._piotrState.chainIntact ? 'chained' : 'FREE',
        gasSpore: this._gasSporeState.position,
        kamenný: `circuit ${this._kamennyState.circuitCount}`,
        letavec: this._letavecState.midnightBreak ? 'midnight-break' : 'circling',
        corpseCandle: this._corpseCandleState.appeared ? 'appeared' : 'waiting'
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

  _onSessionPause() {
    this._stopAll();
  }

  _onSessionEnd() {
    this._stopAll();
  }

  _stopAll() {
    if (this._envTickInterval) { clearTimeout(this._envTickInterval); this._envTickInterval = null; }
    if (this._npcMoveInterval) { clearTimeout(this._npcMoveInterval); this._npcMoveInterval = null; }
    if (this._dwellCheckInterval) { clearInterval(this._dwellCheckInterval); this._dwellCheckInterval = null; }
    if (this._performanceInterval) { clearTimeout(this._performanceInterval); this._performanceInterval = null; }
    if (this._creatureTickInterval) { clearInterval(this._creatureTickInterval); this._creatureTickInterval = null; }
  }

  _resetCreatureStates() {
    this._lastCreatureGameTime = null;
    this._tomasState = { phase: 'normal', lastWhisperPhase: null, goalActivated: false, transformed: false };
    this._piotrState = { chainIntact: true, breakChance: 0, lastChainTestHour: -1, soundFired: false };
    this._gasSporeState = { position: 'east-wall', driftStage: 0, cellarVisits: 0, movedNotified: false };
    this._kamennyState = { lastCircuitGameHour: -1, skeletonTaken: false, circuitCount: 0 };
    this._letavecState = { lastCircuitGameMinute: -1, circuitInterval: 13, midnightBreak: false, playerAloneOutside: false };
    this._corpseCandleState = { appeared: false, circuiting: false, circuitStartReal: null, circuitDurationMs: 180000 };
  }

  // ═══════════════════════════════════════════════════════════════
  // 1. ENVIRONMENTAL TICKS
  // ═══════════════════════════════════════════════════════════════

  _startEnvTicks() {
    this._scheduleNextEnvTick();
  }

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
      text,
      tier: avgHorror < 20 ? 'calm' : avgHorror < 50 ? 'tense' : avgHorror < 80 ? 'dread' : 'terror',
      timestamp: Date.now()
    });

    console.log(`[AmbientLife] Env tick (horror ${Math.round(avgHorror)}): ${text.substring(0, 60)}`);
  }

  get _envCuesCalm() { return [
    'A log shifts in the fireplace, sending sparks up the chimney.',
    'Wind moans around the eaves. The shutters creak but hold.',
    'The fire pops. Shadows jump and settle.',
    'Rain drums steadily on the roof. A comforting, ordinary sound.',
    'A draft stirs the candle flames. They lean, then right themselves.',
    'The tavern sign outside creaks on its chains: back and forth, back and forth.',
    'Somewhere in the walls, a mouse scratches. Normal sounds of an old building.',
    'The fire burns low. Marta adds another log without being asked.'
  ]; }

  get _envCuesTense() { return [
    'A sudden gust rattles the shutters violently. Then silence.',
    'The fire dims for a moment — as if something drew the air from the room.',
    'A wolf howls in the distance. Then another, closer. Then silence.',
    'The floorboards creak overhead. There is no one upstairs.',
    'A candle goes out near the cellar door. No one was near it.',
    'The wind changes direction. Now it sounds like breathing.',
    'A branch scrapes against the window like fingernails on glass.',
    'Something thumps against the outside wall. Once. Nothing follows.',
    'The temperature drops. You can see your breath for a moment.',
    'The fire spits a blue flame. Old wood, probably. Probably.'
  ]; }

  get _envCuesDread() { return [
    'A sound from below the floor. Soft. Rhythmic. Like something dragging itself.',
    'Every candle in the room dims simultaneously, then slowly brightens.',
    'A wolf howls directly outside the door. It does not sound like a wolf.',
    'The walls groan. The entire building shifts, settles. Old foundations.',
    'A cold spot drifts through the room. It passes through you like a memory.',
    'Scratching from the cellar. Louder now. More deliberate.',
    'The fire goes out. Just for a heartbeat. Then returns as if nothing happened.',
    'A smell rises from beneath the floor. Copper. Earth. Something sweet and rotten.',
    'The shutters bang open. The storm outside is white and howling. They slam shut.',
    'You hear something that sounds like whispering from the walls themselves.'
  ]; }

  get _envCuesTerror() { return [
    'The scratching from below has stopped. The silence is worse.',
    'Every shadow in the room seems to lean toward the cellar door.',
    'The fire burns red. Not orange — red. The heat feels wrong.',
    'A handprint appears in the frost on the window. From the outside. Five long fingers.',
    'The floor vibrates. A low, subsonic hum you feel in your teeth.',
    'All the candles go out at once. In the darkness, something breathes.',
    'A crack runs up the wall from the cellar door. It was not there before.',
    'The wind screams. It sounds like a name. Your name.',
    'Blood seeps from between the floorboards near the cellar. Slowly. Steadily.',
    'The cellar door rattles in its frame. Something wants out.'
  ]; }

  // ═══════════════════════════════════════════════════════════════
  // 2. NPC AUTONOMOUS MOVEMENT
  // ═══════════════════════════════════════════════════════════════

  _startNpcMovement() {
    this._scheduleNextNpcMove();
  }

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

    const mapService = this.orchestrator.getService('map');
    if (mapService) {
      const tokens = this.state.get('map.tokens') || {};
      const npcTokenId = Object.keys(tokens).find(tid => {
        const tok = tokens[tid];
        return tok.actorSlug === npcId || tok.name === npc.name ||
               tid === npcId || tid === `npc-${npcId}`;
      });
      if (npcTokenId && move.x != null && move.y != null) {
        mapService._moveToken(npcTokenId, move.x, move.y, { force: true });
      }
    }

    this.state.set(`npcs.${npcId}.location`, move.label);
    const npcName = npc.name || npcId;
    this._whisperDM(`${npcName} ${move.action}`, 5, 'ambient');
    this.bus.dispatch('ambient:npc_move', {
      npcId, npcName, label: move.label, action: move.action,
      x: move.x, y: move.y, timestamp: Date.now()
    });

    console.log(`[AmbientLife] NPC move: ${npcName} → ${move.label}`);
  }

  _getNpcMoveOptions(npcId) {
    const moves = {
      'marta': [
        { label: 'behind the bar', action: 'moves behind the bar, polishing glasses nervously.', x: null, y: null },
        { label: 'by the fireplace', action: 'moves to the fireplace to add a log. Her hands tremble.', x: null, y: null },
        { label: 'near the cellar door', action: 'walks toward the cellar door, hesitates, then stops a few feet away.', x: null, y: null },
        { label: 'serving tables', action: 'circles the room refilling mugs, avoiding the stranger\'s corner.', x: null, y: null }
      ],
      'tomas': [
        { label: 'near the entry door', action: 'moves to the door and checks the latch again.', x: null, y: null },
        { label: 'by the window', action: 'stands at the window, staring at the sky through the frost.', x: null, y: null },
        { label: 'near the cellar door', action: 'drifts toward the cellar door, trying to look casual about it.', x: null, y: null },
        { label: 'pacing by the wall', action: 'paces along the far wall, unable to sit still.', x: null, y: null }
      ],
      'patron-farmer': [
        { label: 'table near the hearth', action: 'hasn\'t moved from his spot by the fire. Staring into the flames.', x: null, y: null },
        { label: 'at the bar', action: 'shuffles to the bar and asks Marta for something stronger.', x: null, y: null },
        { label: 'by the fireplace', action: 'moves closer to the fire, as if the warmth might help.', x: null, y: null }
      ],
      'patron-merchant': [
        { label: 'table with his goods', action: 'reorganizes his merchant goods under the table for the fifth time.', x: null, y: null },
        { label: 'at the bar', action: 'goes to the bar and orders another drink.', x: null, y: null },
        { label: 'near the entry door', action: 'moves to the door and peers through the keyhole at the storm.', x: null, y: null }
      ],
      'patron-pilgrim': [
        { label: 'corner table with candle', action: 'remains at his corner table, praying quietly.', x: null, y: null },
        { label: 'by the fireplace', action: 'moves to the hearth, still praying, and kneels before the fire.', x: null, y: null },
        { label: 'near the cellar door', action: 'approaches the cellar door. Places his palm flat against it. Whispers a prayer. Steps back.', x: null, y: null }
      ],
      'patron-minstrel': [
        { label: 'by the hearth with lute', action: 'settles by the hearth and tunes her lute absently.', x: null, y: null },
        { label: 'at the bar', action: 'leans against the bar, chatting with Marta in low tones.', x: null, y: null },
        { label: 'wandering the room', action: 'strolls through the room, observing everyone with those sharp eyes.', x: null, y: null },
        { label: 'near a player', action: 'sits down near the closest traveler with a curious expression.', x: null, y: null }
      ]
    };
    return moves[npcId] || [];
  }

  // ═══════════════════════════════════════════════════════════════
  // 3. PLAYER PROXIMITY DWELL TRIGGERS
  // ═══════════════════════════════════════════════════════════════

  _startDwellCheck() {
    this._dwellCheckInterval = setInterval(() => this._checkDwells(), 5000);
  }

  _checkDwells() {
    if (this.state.get('session.status') !== 'active') return;
    if (this.state.get('combat.active')) return;

    const tokens = this.state.get('map.tokens') || {};
    const gridSize = this.state.get('map.gridSize') || 70;
    const feetPerGrid = 5;
    const now = Date.now();

    const playerTokens = Object.entries(tokens).filter(([, t]) => t.type === 'pc');
    const npcTokens = Object.entries(tokens).filter(([, t]) => t.type === 'npc' && !t.hidden);

    for (const [ptId, pt] of playerTokens) {
      const playerId = pt.playerId || ptId;
      let nearestNpc = null;
      let nearestDist = Infinity;

      for (const [ntId, nt] of npcTokens) {
        const dx = pt.x - nt.x;
        const dy = pt.y - nt.y;
        const distFeet = (Math.sqrt(dx * dx + dy * dy) / gridSize) * feetPerGrid;
        if (distFeet <= 10 && distFeet < nearestDist) {
          nearestDist = distFeet;
          nearestNpc = { tokenId: ntId, ...nt };
        }
      }

      const existing = this._playerDwellTimers[playerId];

      if (nearestNpc) {
        const npcId = nearestNpc.actorSlug || nearestNpc.tokenId;
        if (existing && existing.nearNpcId === npcId) {
          if (!existing.triggered && (now - existing.startedAt) >= this._dwellThresholdMs) {
            const cooldownKey = `${playerId}-${npcId}`;
            if (this._dwellCooldowns[cooldownKey] && (now - this._dwellCooldowns[cooldownKey]) < 300000) {
              existing.triggered = true;
              continue;
            }
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
    const npcName = npcToken.name || npcId;
    const npcs = this.config.npcs || {};
    const npcConfig = npcs[npcId] || npcs[npcToken.actorSlug] || {};

    this._whisperDM(`${playerId} has been lingering near ${npcName}. ${npcName} might notice and react.`, 3, 'ambient');

    const aiEngine = this.orchestrator.getService('ai-engine');
    if (aiEngine?.gemini?.available) {
      const disposition = npcConfig.disposition || 'neutral';
      const prompt = `${npcName} (${disposition}) notices a traveler standing near them for a while. Generate ONE brief reaction — either a look, gesture, or short question. Under 20 words. Start with the NPC name.`;
      aiEngine.gemini.generate(
        'You write brief NPC reactions in a gothic horror tavern. One sentence only.',
        prompt,
        { maxTokens: 60, temperature: 0.9 }
      ).then(response => {
        if (response) {
          this.bus.dispatch('ambient:dwell_reaction', { npcId, npcName, playerId, text: response.trim(), timestamp: Date.now() });
          this._whisperDM(`Proximity — ${npcName}: ${response.trim()}`, 4, 'ambient');
        }
      }).catch(() => {});
    }

    const genericReactions = {
      'marta': 'Marta glances at you and offers a nervous smile. "Can I get you something?"',
      'tomas': 'Tomas eyes you warily. His hand moves to his forearm.',
      'hooded-stranger': 'The stranger turns his head. Slowly. He looks directly at you.',
      'patron-farmer': 'Old Gregor looks up from his untouched stew. "You see it too, don\'t you?"',
      'patron-merchant': 'Henryk clutches his goods closer. "Need something? I\'ve got goods. Fair prices."',
      'patron-pilgrim': 'Brother Aldric opens his eyes from prayer. "Sit, friend. There is safety in fellowship."',
      'patron-minstrel': 'Katya looks up with a knowing smile. "Curious about something? I collect stories."'
    };

    const fallback = genericReactions[npcId] || `${npcName} looks up and acknowledges your presence.`;
    this.bus.dispatch('ambient:dwell_reaction', { npcId, npcName, playerId, text: fallback, timestamp: Date.now() });

    console.log(`[AmbientLife] Dwell trigger: ${playerId} near ${npcName}`);
  }

  _checkCellarProximity(playerTokens, gridSize, feetPerGrid, now) {
    const cellarDoor = this.state.get('map.interestPoints.cellarDoor');
    if (!cellarDoor) return;

    for (const [ptId, pt] of playerTokens) {
      const playerId = pt.playerId || ptId;
      const dx = pt.x - cellarDoor.x;
      const dy = pt.y - cellarDoor.y;
      const distFeet = (Math.sqrt(dx * dx + dy * dy) / gridSize) * feetPerGrid;

      if (distFeet <= 10) {
        const cooldownKey = `${playerId}-cellar`;
        if (this._dwellCooldowns[cooldownKey] && (now - this._dwellCooldowns[cooldownKey]) < 600000) continue;
        this._dwellCooldowns[cooldownKey] = now;
        this._whisperDM(`${playerId} is examining the cellar door area. Vladislav will notice.`, 2, 'story');
        this.bus.dispatch('ambient:cellar_interest', { playerId, timestamp: now });
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // 4. KATYA PERFORMANCES
  // ═══════════════════════════════════════════════════════════════

  _startPerformances() {
    this._scheduleNextPerformance();
  }

  _scheduleNextPerformance() {
    const intervalMs = 480000 + Math.floor(Math.random() * 420000);
    this._performanceInterval = setTimeout(() => {
      this._firePerformance();
      this._scheduleNextPerformance();
    }, intervalMs);
  }

  _firePerformance() {
    if (this.state.get('session.status') !== 'active') return;
    if (this.state.get('combat.active')) return;

    const currentProfile = this.state.get('atmosphere.activeProfile') || '';
    if (currentProfile.includes('dread') || currentProfile.includes('terror') ||
        currentProfile.includes('combat') || currentProfile.includes('revelation')) return;

    const katya = this.config.npcs?.['patron-minstrel'];
    if (!katya?.performances) return;

    const tier = currentProfile.includes('tense') ? 'tavern_tense' : 'tavern_warm';
    const performances = katya.performances[tier];
    if (!performances || performances.length === 0) return;

    const perf = performances[this._performanceIndex % performances.length];
    this._performanceIndex++;

    this._whisperDM(`Katya performs: ${perf.title}`, 4, 'story');
    this.bus.dispatch('ambient:performance', {
      npcId: 'patron-minstrel', npcName: 'Katya',
      type: perf.type, title: perf.title, content: perf.content,
      timestamp: Date.now()
    });
    this.bus.dispatch('npc:approved', {
      id: `perf-${Date.now()}`, npc: 'Katya', npcId: 'patron-minstrel',
      text: perf.content, autoApproved: true
    });

    console.log(`[AmbientLife] Katya performs: ${perf.title}`);
  }

  // ═══════════════════════════════════════════════════════════════
  // 5. CREATURE BEHAVIOR ENGINE
  // ═══════════════════════════════════════════════════════════════

  _startCreatureEngine() {
    // Tick every 10 real seconds — reads game time from world clock
    this._creatureTickInterval = setInterval(() => this._creatureTick(), 10000);
    console.log('[AmbientLife] Creature behavior engine started');
  }

  _creatureTick() {
    if (this.state.get('session.status') !== 'active') return;
    if (this.state.get('combat.active')) return;

    const worldService = this.orchestrator.getService('world-clock');
    if (!worldService) return;
    const gtIso = this.state.get('world.gameTime');
    if (!gtIso) return;

    const gt = new Date(gtIso);
    if (isNaN(gt.getTime())) return;

    const h = gt.getUTCHours();
    const m = gt.getUTCMinutes();
    const gtKey = `${h}:${m}`;

    // Skip if game time hasn't advanced since last tick
    if (gtKey === this._lastCreatureGameTime) return;
    this._lastCreatureGameTime = gtKey;

    const totalMinutes = h * 60 + m; // minutes since midnight

    this._tickTomas(h, m, totalMinutes);
    this._tickPiotr(h, m, totalMinutes);
    this._tickGasSpore(h, m, totalMinutes);
    this._tickKamenny(h, m, totalMinutes);
    this._tickLetavec(h, m, totalMinutes);
    this._tickCorpseCandle(h, m, totalMinutes);
  }

  // ─── TOMAS — Werewolf Escalation ────────────────────────────

  _tickTomas(h, m, totalMinutes) {
    if (this._tomasState.transformed) return;

    // 20:00 — anxiety begins
    if (totalMinutes >= 20 * 60 && this._tomasState.phase === 'normal') {
      this._tomasState.phase = 'anxious';
      this._whisperDM(
        'TOMAS: Moon anxiety beginning. He stops eating. His jaw is tight. ' +
        'DC14 Perception: he keeps touching his forearm through his sleeve.',
        2, 'story'
      );
      this.bus.dispatch('creature:tomas_phase', { phase: 'anxious', gameTime: `${h}:${m}` });
      this.bus.dispatch('observation:trigger', {
        id: 'tomas-anxiety', dc: 14,
        text: 'Tomas has stopped eating. His jaw is set. He keeps pressing his hand against his forearm.',
        targetPlayer: null
      });
    }

    // 20:30 — visibly suffering
    if (totalMinutes >= 20 * 60 + 30 && this._tomasState.phase === 'anxious' &&
        this._tomasState.lastWhisperPhase !== '20:30') {
      this._tomasState.lastWhisperPhase = '20:30';
      this._whisperDM(
        'TOMAS: Sweating. Hands shaking. He\'s working very hard to hold still. ' +
        'If spoken to he will insist he is fine. He is not fine.',
        2, 'story'
      );
    }

    // 21:00 — desperate for cellar
    if (totalMinutes >= 21 * 60 && this._tomasState.phase === 'anxious') {
      this._tomasState.phase = 'desperate';
      this._whisperDM(
        'TOMAS: He needs the cellar. NOW. He will try to excuse himself. ' +
        'If the cellar is blocked or inaccessible he has maybe 60 minutes before it doesn\'t matter.',
        1, 'story'
      );
      this.bus.dispatch('creature:tomas_phase', { phase: 'desperate', gameTime: `${h}:${m}` });
      if (!this._tomasState.goalActivated) {
        this._tomasState.goalActivated = true;
        this.bus.dispatch('world:npc_goal_activated', {
          npcId: 'tomas', goalId: 'reach-cellar',
          goal: 'Reach cellar and chain himself before moonrise at 22:00'
        });
      }
    }

    // 21:30 — last warning
    if (totalMinutes >= 21 * 60 + 30 && this._tomasState.phase === 'desperate' &&
        this._tomasState.lastWhisperPhase !== '21:30') {
      this._tomasState.lastWhisperPhase = '21:30';
      this._whisperDM(
        'TOMAS [30 MIN WARNING]: If he cannot reach the cellar in the next 30 minutes ' +
        'he will transform wherever he is. CR3 werewolf. Room full of people. ' +
        'Marta knows. She is watching him.',
        1, 'story'
      );
    }

    // 21:50 — urgent
    if (totalMinutes >= 21 * 60 + 50 && this._tomasState.phase === 'desperate' &&
        this._tomasState.lastWhisperPhase !== '21:50') {
      this._tomasState.lastWhisperPhase = '21:50';
      this._whisperDM(
        'TOMAS [URGENT — 10 MIN]: His control is almost gone. He is shaking. ' +
        'Anyone within 10 feet can hear something wrong with his breathing.',
        1, 'story'
      );
      this.bus.dispatch('observation:trigger', {
        id: 'tomas-breaking', dc: 10,
        text: 'Tomas is shaking. His breathing has changed — ragged, too fast, too deep. Something is very wrong with him.',
        targetPlayer: null
      });
    }

    // 22:00 — transformation
    if (totalMinutes >= 22 * 60 && this._tomasState.phase === 'desperate') {
      this._tomasState.phase = 'transformed';
      this._tomasState.transformed = true;
      const inCellar = this.state.get('npcs.tomas.location') === 'cellar';

      if (inCellar) {
        this._whisperDM(
          'TOMAS: He made it to the cellar. You hear the chain in the cellar snap taut. ' +
          'Then silence. Then a sound that isn\'t human. He\'s locked in. It\'s okay. For now.',
          1, 'story'
        );
        this.bus.dispatch('ambient:environment', {
          text: 'A chain snaps taut somewhere below you. Then a sound that isn\'t human echoes through the floorboards. Then silence.',
          tier: 'dread', timestamp: Date.now()
        });
      } else {
        this._whisperDM(
          'TOMAS TRANSFORMS — He did not reach the cellar. CR3 werewolf. ' +
          'Everyone in the room sees it. He has no control. This is a combat encounter. ' +
          'His goal is escape — he will run for the door if he can.',
          1, 'story'
        );
        this.bus.dispatch('creature:tomas_transform', {
          location: this.state.get('npcs.tomas.location') || 'common-room',
          gameTime: `${h}:${m}`
        });
        this.bus.dispatch('atmo:change', { profile: 'combat_chaos', reason: 'Tomas transforms', auto: true });
      }

      this.bus.dispatch('creature:tomas_phase', {
        phase: 'transformed', inCellar, gameTime: `${h}:${m}`
      });
    }
  }

  // ─── PIOTR — Chain Tests ─────────────────────────────────────

  _tickPiotr(h, m, totalMinutes) {
    if (!this._piotrState.chainIntact) return;

    // Hourly chain sound (audible DC10 near cellar door)
    if (h !== this._piotrState.lastChainTestHour) {
      this._piotrState.lastChainTestHour = h;

      // Chain sound event
      this.bus.dispatch('observation:trigger', {
        id: `piotr-chain-${h}`,
        dc: 10,
        text: 'A sound from below — chains, taut and straining. Something testing its limits.',
        nearCellarDoor: true,
        dcModifier: -5  // easier near cellar door
      });

      // After 22:00, accumulate break chance
      if (totalMinutes >= 22 * 60) {
        this._piotrState.breakChance += 1; // +1% per hour

        // Roll against break chance
        const roll = Math.random() * 100;
        if (roll < this._piotrState.breakChance) {
          this._piotrState.chainIntact = false;
          this._whisperDM(
            `PIOTR CHAIN BREAK — The chain has failed (${Math.round(this._piotrState.breakChance)}% chance, rolled ${Math.round(roll)}). ` +
            'Piotr is loose in the cellar. He will not hurt Marta. Everyone else is fair game.',
            1, 'story'
          );
          this.bus.dispatch('creature:piotr_chain_break', { gameTime: `${h}:${m}` });
          this.bus.dispatch('ambient:environment', {
            text: 'A chain snaps below the floor. The silence that follows is complete.',
            tier: 'terror', timestamp: Date.now()
          });
          this.bus.dispatch('atmo:change', { profile: 'terror_mounting', reason: 'Piotr chain breaks', auto: true });
        } else {
          this._whisperDM(
            `Piotr chain test: ${Math.round(this._piotrState.breakChance)}% chance, rolled ${Math.round(roll)} — held. ` +
            `Next test at ${h + 1}:00.`,
            5, 'atmosphere'
          );
        }
      }
    }
  }

  // ─── GAS SPORE — Cellar Drift ────────────────────────────────

  _tickGasSpore(h, m, totalMinutes) {
    // Drifts toward warmth — one stage every ~2 game hours
    // Stage 0: east-wall | Stage 1: center | Stage 2: near-hearth-wall
    const stageTimes = [0, 2 * 60, 4 * 60]; // minutes after session start (17:30)
    const sessionStartMinutes = 17 * 60 + 30;
    const elapsed = totalMinutes >= sessionStartMinutes
      ? totalMinutes - sessionStartMinutes
      : totalMinutes + (24 * 60 - sessionStartMinutes); // handle midnight wrap

    const newStage = stageTimes.filter(t => elapsed >= t).length - 1;

    if (newStage > this._gasSporeState.driftStage) {
      this._gasSporeState.driftStage = newStage;
      const positions = ['against the east wall', 'near the center of the cellar', 'drifted toward the hearth-side wall'];
      this._gasSporeState.position = positions[newStage] || this._gasSporeState.position;

      // Only whisper DM — players discover this by visiting
      this._whisperDM(
        `Gas Spore has drifted: now ${this._gasSporeState.position}. ` +
        'Players who visited before and return will notice it moved. Piotr calls it "the eye."',
        5, 'atmosphere'
      );

      this.bus.dispatch('creature:gas_spore_move', {
        position: this._gasSporeState.position, stage: newStage, gameTime: `${h}:${m}`
      });
    }
  }

  // ─── KAMENNÝ — Inn Circuit ───────────────────────────────────

  _tickKamenny(h, m, totalMinutes) {
    // Circuits the inn every 2 game hours
    // Circuit times: 19:30, 21:30, 23:30, 01:30, 03:30, 05:30
    const circuitMinutes = [19 * 60 + 30, 21 * 60 + 30, 23 * 60 + 30, 25 * 60 + 30, 27 * 60 + 30, 29 * 60 + 30];
    // normalize past midnight
    const normalizedTotal = totalMinutes < 17 * 60 ? totalMinutes + 24 * 60 : totalMinutes;

    for (let i = 0; i < circuitMinutes.length; i++) {
      const ct = circuitMinutes[i];
      const ctNorm = ct < 17 * 60 ? ct + 24 * 60 : ct;

      // Within 2 minutes of circuit time and haven't fired this one
      if (Math.abs(normalizedTotal - ctNorm) <= 2 && this._kamennyState.lastCircuitGameHour !== ct) {
        this._kamennyState.lastCircuitGameHour = ct;
        this._kamennyState.circuitCount++;

        const circuitHour = Math.floor(ct / 60) % 24;
        const circuitMin = ct % 60;
        const timeStr = `${circuitHour.toString().padStart(2,'0')}:${circuitMin.toString().padStart(2,'0')}`;

        this._whisperDM(
          `KAMENNÝ CIRCUIT #${this._kamennyState.circuitCount} at ${timeStr}: ` +
          'It is moving around the inn now. Anyone outside will see it. ' +
          'Stone scraping sounds audible through the walls if listening. ' +
          (this._kamennyState.skeletonTaken
            ? 'Skeleton was taken — it is looking for the one who took it.'
            : 'Passive — will not engage unless skeleton is disturbed.'),
          2, 'story'
        );

        this.bus.dispatch('ambient:environment', {
          text: 'Something heavy moves outside. The sound is stone on stone — slow, deliberate, circling.',
          tier: 'dread', timestamp: Date.now()
        });

        this.bus.dispatch('creature:kamenny_circuit', {
          count: this._kamennyState.circuitCount,
          skeletonTaken: this._kamennyState.skeletonTaken,
          gameTime: timeStr
        });

        // Sound observation
        this.bus.dispatch('observation:trigger', {
          id: `kamenny-circuit-${this._kamennyState.circuitCount}`,
          dc: 12,
          text: 'Something is moving outside the inn. The sound is wrong for an animal — too heavy, too deliberate, too slow.',
          targetPlayer: null
        });

        break;
      }
    }
  }

  // ─── LETAVEC — 13-Minute Circuit ────────────────────────────

  _tickLetavec(h, m, totalMinutes) {
    // Circuits every 13 game minutes — track via total game minutes modulo 13
    const circuitPhase = totalMinutes % 13;

    // Fire at the start of each new circuit (when phase crosses 0)
    if (circuitPhase <= 1 && totalMinutes !== this._letavecState.lastCircuitGameMinute) {
      this._letavecState.lastCircuitGameMinute = totalMinutes;

      // After midnight: check if player alone outside
      const isMidnight = totalMinutes >= 24 * 60 || totalMinutes < 6 * 60;

      if (isMidnight && this._letavecState.playerAloneOutside && !this._letavecState.midnightBreak) {
        this._letavecState.midnightBreak = true;
        this._whisperDM(
          'LETAVEC MIDNIGHT BREAK: A player is alone outside after midnight. ' +
          'It has broken its circuit pattern. It knows. It is watching them specifically now. ' +
          'DC13 Perception to hear wingbeats directly overhead.',
          1, 'story'
        );
        this.bus.dispatch('creature:letavec_midnight_break', { gameTime: `${h}:${m}` });
        this.bus.dispatch('observation:trigger', {
          id: 'letavec-midnight',
          dc: 13,
          text: 'Wings above you. Too large for any bird. The sound circles, tightens. Something is very interested in you specifically.',
          targetPlayer: 'alone-outside'
        });
      } else {
        // Regular circuit — whisper DM only, not players
        if (h >= 5) { // dawn approach
          this._whisperDM(
            `Letavec completing circuit at ${h}:${m.toString().padStart(2,'0')} — tracks will be visible in snow at dawn. DC12 Survival.`,
            5, 'atmosphere'
          );
        } else {
          // Occasional wing sound during deep night
          const nightHour = h >= 22 || h < 6;
          if (nightHour && Math.random() < 0.3) {
            this.bus.dispatch('observation:trigger', {
              id: `letavec-wing-${totalMinutes}`,
              dc: 13,
              text: 'Something large passes overhead. The wingbeats are slow and enormous. Then silence.',
              targetPlayer: null
            });
          }
        }
      }

      this.bus.dispatch('creature:letavec_circuit', {
        totalMinutes, gameTime: `${h}:${m}`, midnightBreak: this._letavecState.midnightBreak
      });
    }
  }

  // ─── CORPSE CANDLE — Midnight Appearance ────────────────────

  _tickCorpseCandle(h, m, totalMinutes) {
    if (this._corpseCandleState.appeared) return;

    // Appears at exactly midnight (0:00 = totalMinutes 0 or 1440)
    const isMidnight = (totalMinutes === 0 || totalMinutes >= 23 * 60 + 58);

    if (isMidnight) {
      this._corpseCandleState.appeared = true;
      this._corpseCandleState.circuiting = true;
      this._corpseCandleState.circuitStartReal = Date.now();

      // Determine target — default Tomas unless he's already transformed/gone
      const target = this._tomasState.transformed
        ? this._selectCorpseCandleTarget()
        : 'Tomas';

      this._whisperDM(
        `CORPSE CANDLE — Midnight. It drifts in through the wall or beneath the door. ` +
        `It is heading for ${target}. The room will go silent — even Vladislav is watching it. ` +
        'Nobody attacks it. If attacked: DC14 Horror save, madness on fail, it screams.',
        1, 'story'
      );

      this.bus.dispatch('creature:corpse_candle_appear', {
        target, gameTime: '00:00'
      });

      // Atmosphere — full room sees this
      this.bus.dispatch('ambient:environment', {
        text: 'A pale light drifts through the wall. No one moves. No one speaks. It bobs gently, moving toward one of you.',
        tier: 'terror', timestamp: Date.now()
      });

      this.bus.dispatch('atmo:change', {
        profile: 'revelation_horror', reason: 'Corpse Candle appears', auto: true
      });

      // Horror check for all players
      this.bus.dispatch('horror:check', {
        trigger: 'corpse-candle',
        dc: 10,
        description: 'A deathlight circles the room. It knows something none of you do.',
        targetAll: true
      });

      // Schedule circuit completion (3 real minutes)
      const timeScale = this.state.get('world.timeScale') || 1;
      const realDuration = this._corpseCandleState.circuitDurationMs / Math.max(1, timeScale);

      setTimeout(() => {
        this._corpseCandleState.circuiting = false;
        this._whisperDM(
          `Corpse Candle has completed its circuit and settled near ${target}. ` +
          'It will hover there for the rest of the session — or until that person\'s fate changes. ' +
          'NPCs who can see it will not approach that person.',
          2, 'story'
        );
        this.bus.dispatch('creature:corpse_candle_settled', { target });
      }, realDuration);

      console.log(`[AmbientLife] Corpse Candle appeared at midnight — targeting ${target}`);
    }
  }

  _selectCorpseCandleTarget() {
    // Fallback target selection if Tomas is gone
    const players = this.state.get('players') || {};
    const playerIds = Object.keys(players).filter(pid => {
      const p = players[pid];
      return p.character && !p.absent;
    });
    if (playerIds.length > 0) {
      return players[playerIds[0]]?.character?.name || 'the nearest traveler';
    }
    return 'one of the travelers';
  }

  // ═══════════════════════════════════════════════════════════════
  // SESSION TEST MODE
  // ═══════════════════════════════════════════════════════════════

  setupTestModeRoutes(app) {
    if (!app) return;

    // GET /api/session-test/status
    app.get('/api/session-test/status', (req, res) => {
      const worldService = this.orchestrator.getService('world-clock');
      const timeScale = worldService?.timeScale || 1;
      const gtIso = this.state.get('world.gameTime');
      res.json({
        active: timeScale >= 5,
        timeScale,
        gameTime: gtIso || null,
        creatures: this.getStatus().creatures
      });
    });

    // POST /api/session-test/start — compression
    app.post('/api/session-test/start', (req, res) => {
      const scale = parseInt(req.body?.scale) || 20;
      const worldService = this.orchestrator.getService('world-clock');
      if (!worldService) return res.status(503).json({ error: 'world service unavailable' });

      if (typeof worldService.setTimeScale === 'function') {
        worldService.setTimeScale(scale);
      } else {
        worldService.timeScale = scale;
      }
      this._resetCreatureStates();

      this._whisperDM(
        `SESSION TEST MODE ACTIVE — ${scale}x time compression. ` +
        'Creature engine reset. All timed events will fire at compressed rate.',
        1, 'system'
      );

      console.log(`[AmbientLife] Session Test Mode started at ${scale}x`);
      res.json({ ok: true, timeScale: scale });
    });

    // POST /api/session-test/stop — back to real time
    app.post('/api/session-test/stop', (req, res) => {
      const worldService = this.orchestrator.getService('world-clock');
      if (!worldService) return res.status(503).json({ error: 'world service unavailable' });

      if (typeof worldService.setTimeScale === 'function') {
        worldService.setTimeScale(1);
      } else {
        worldService.timeScale = 1;
      }
      this._whisperDM('Session Test Mode ended. Time scale restored to 1x.', 3, 'system');
      console.log('[AmbientLife] Session Test Mode stopped');
      res.json({ ok: true, timeScale: 1 });
    });

    console.log('[AmbientLife] Session Test Mode routes registered');
  }

  // ═══════════════════════════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════════════════════════

  _whisperDM(text, priority, category) {
    this.bus.dispatch('dm:whisper', { text, priority: priority || 5, category: category || 'ambient' });
  }

  _getAvgHorror() {
    const players = this.state.get('players') || {};
    let total = 0, count = 0;
    for (const p of Object.values(players)) {
      if (p && !p.absent && p.dread) {
        total += (p.dread.score || 0);
        count++;
      }
    }
    return count > 0 ? total / count : 0;
  }
}

module.exports = AmbientLifeService;
