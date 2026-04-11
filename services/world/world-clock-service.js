/**
 * World Clock Service
 * Manages game-time progression, timed events, environmental cues,
 * secrets/clues, NPC goals, branching paths, and discovery chains.
 * Session-agnostic — works with any campaign/session config.
 */

const fs = require('fs');
const path = require('path');

class WorldClockService {
  constructor() {
    this.name = 'world-clock';
    this.orchestrator = null;
    this.bus = null;
    this.state = null;

    // Clock state
    this.gameTime = null;        // Current game time (Date object)
    this.startGameTime = null;   // Game time when session started
    this.timeScale = 1;          // 1 = real-time, 10 = 10x speed, etc.
    this.paused = true;
    this._tickInterval = null;
    this._lastTick = null;

    // Registries
    this.timedEvents = [];       // { id, gameTime, event, data, fired, repeating, interval }
    this.environmentalCues = []; // { id, interval, lastFired, cues[], index }
    this.secrets = new Map();    // id -> { id, description, knownBy[], discoveredBy{}, discoveryMethods[], revealConsequences, revealed }
    this.npcGoals = new Map();   // npcId -> [{ id, goal, priority, conditions[], timer, status, actions[] }]
    this.branches = new Map();   // pathId -> { id, conditions[], active, convergeTo }
    this.discoveries = new Map();// id -> { id, clueChain[], currentStep, completed }
    this.clues = new Map();      // id -> { id, description, location, method, dc, revealsSecret, found, foundBy }

    // Weather system
    this.weather = {
      current: null,             // Current weather state { type, intensity, description }
      phases: [],                // Time-based weather phases from config
      lastTransition: null       // Timestamp of last weather change
    };

    // Beat atmosphere map — beat id -> atmosphere profile name
    this.beatAtmosphereMap = new Map();

    // Phase M — Campaign Continuity
    this.futureHooks = new Map();    // id -> { id, description, plantedAt, plantedInBeat, payoffCondition, payoffBeat, session, status, notes }
    this.reputation = new Map();     // factionId -> { id, name, score, history[], description }
    this.backstories = new Map();    // playerId -> { hooks[], themes[], connections[], integrated[] }

    // Journey System (between settlements)
    this.journey = {
      active: false,
      origin: null,
      destination: null,
      daysTraveled: 0,
      daysRemaining: 0,
      currentTerrain: 'mountain-road',
      currentWeather: 'clear',
      exhaustionLevels: {},
      campChoice: null,
      complications: []
    };

    // Journey configuration tables
    this.journeyConfig = {
      navigationDC: {
        'good-road': 8,
        'mountain-road': 12,
        'mountain-path': 12,
        'deep-forest': 15,
        'high-pass': 16
      },
      blizzardDCBonus: 4,
      milesPerDay: {
        'good-road': 24,
        'mountain-road': 14,
        'mountain-path': 14,
        'deep-forest': 10,
        'high-pass': 8
      },
      staminaDrain: {
        'no-armor': 5,
        'light': 10,
        'medium': 18,
        'heavy': 28
      },
      camp: {
        church: {
          safety: 'high', consecrated: true, restQuality: 'full',
          threats_blocked: ['letavec', 'strigoi', 'vrykolakas', 'aufhocker', 'nachtmahr']
        },
        inn: {
          safety: 'medium', restQuality: 'full',
          threats_blocked: ['letavec', 'wild-hunt'],
          threats_possible: ['nachtmahr', 'moroaica', 'doppelganger']
        },
        cave: {
          safety: 'medium', restQuality: 'full',
          threats_blocked: ['wild-hunt', 'letavec-partial'],
          threats_possible: ['aufhocker', 'hound-of-tindalos', 'nocni-letavec']
        },
        'open-camp': {
          safety: 'low', restQuality: 'full-if-undisturbed',
          threats_blocked: [],
          threats_possible: ['letavec', 'nachtmahr', 'aufhocker', 'wild-hunt', 'strigoi', 'neck-nearby']
        },
        monastery: {
          safety: 'medium-high', consecrated: true, restQuality: 'full',
          threats_blocked: ['letavec', 'strigoi', 'vrykolakas', 'wild-hunt'],
          threats_possible: ['hound-of-tindalos', 'nachtmahr']
        }
      }
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // JOURNEY SYSTEM
  // ═══════════════════════════════════════════════════════════════

  getJourneyState() {
    return { ...this.journey, config: this.journeyConfig };
  }

  startJourney(origin, destination, terrain) {
    this.journey = {
      active: true,
      origin,
      destination,
      daysTraveled: 0,
      daysRemaining: 1,
      currentTerrain: terrain || 'mountain-road',
      currentWeather: this.weather.current?.type || 'clear',
      exhaustionLevels: {},
      campChoice: null,
      complications: []
    };
    this.state.set('journey', this.journey);
    this.bus.dispatch('journey:started', { ...this.journey });
    return this.journey;
  }

  advanceJourney(phase, opts = {}) {
    if (!this.journey.active) return { error: 'No active journey' };
    const result = { phase, journey: this.journey };

    switch (phase) {
      case 'morning': {
        // Navigation check phase
        const dc = (this.journeyConfig.navigationDC[this.journey.currentTerrain] || 12)
          + (this.journey.currentWeather === 'blizzard' ? this.journeyConfig.blizzardDCBonus : 0);
        result.navigationDC = dc;
        result.terrain = this.journey.currentTerrain;
        if (opts.navCheck != null) {
          const success = opts.navCheck >= dc;
          const failBy = dc - opts.navCheck;
          if (!success && failBy >= 5) {
            this.journey.daysRemaining += 1;
            result.outcome = 'wrong-turn';
            result.note = 'Wrong turn — add one day, navigator gains 1 Exhaustion';
          } else if (!success) {
            result.outcome = 'half-progress';
            result.note = 'Half progress for the day';
          } else {
            result.outcome = 'success';
          }
        }
        this.bus.dispatch('journey:morning', result);
        break;
      }
      case 'afternoon': {
        result.note = 'Foraging and condition check phase';
        this.bus.dispatch('journey:afternoon', result);
        break;
      }
      case 'evening': {
        result.prompt = 'Choose camp: church | inn | cave | open-camp | monastery';
        if (opts.campChoice) {
          this.setCampChoice(opts.campChoice);
          result.camp = this.journeyConfig.camp[opts.campChoice];
        }
        this.bus.dispatch('journey:evening', result);
        break;
      }
      case 'night': {
        result.note = 'Night encounter check — weighted by active threats and camp choice';
        this.bus.dispatch('journey:night', result);
        break;
      }
      case 'arrived': {
        this.journey.active = false;
        result.note = `Arrived at ${this.journey.destination}`;
        this.bus.dispatch('journey:arrived', { ...this.journey });
        break;
      }
    }

    this.state.set('journey', this.journey);
    return result;
  }

  setCampChoice(choice) {
    this.journey.campChoice = choice;
    this.state.set('journey', this.journey);
    return this.journey;
  }

  addJourneyComplication(description) {
    this.journey.complications.push({ description, at: new Date().toISOString() });
    this.state.set('journey', this.journey);
  }

  endJourney() {
    const final = { ...this.journey };
    this.journey.active = false;
    this.state.set('journey', this.journey);
    this.bus.dispatch('journey:arrived', final);
    return final;
  }

  async init(orchestrator) {
    this.orchestrator = orchestrator;
    this.bus = orchestrator.bus;
    this.state = orchestrator.state;
    this.config = orchestrator.config;

    // Load world data from session config
    this._loadFromConfig(this.config);
    this._setupRoutes();
  }

  async start() {
    // Session lifecycle
    this.bus.subscribe('session:started', () => this._onSessionStart(), 'world-clock');
    this.bus.subscribe('session:paused', () => this._onSessionPause(), 'world-clock');
    this.bus.subscribe('session:resumed', () => this._onSessionResume(), 'world-clock');
    this.bus.subscribe('session:ended', () => this._onSessionEnd(), 'world-clock');

    // Full reset — reload everything from config
    this.bus.subscribe('state:session_reset', () => {
      console.log('[WorldClock] Session reset — reloading from config');
      if (this._tickInterval) clearInterval(this._tickInterval);
      this.timedEvents = [];
      this.environmentalCues = [];
      this.secrets = new Map();
      this.npcGoals = new Map();
      this.branches = new Map();
      this.discoveries = new Map();
      this.clues = new Map();
      this.weather = { current: null, phases: [], lastTransition: null };
      this.beatAtmosphereMap = new Map();
      this.futureHooks = new Map();
      this.reputation = new Map();
      this.backstories = new Map();
      this.paused = true;
      this._loadFromConfig(this.config);
    }, 'world-clock');

    // Scene changes can load new timed events
    this.bus.subscribe('state:change', (env) => {
      if (env.data.path === 'scene.id') {
        this._onSceneChange(env.data.value);
      }
    }, 'world-clock');

    // Story beat completions can trigger branching logic + atmosphere shifts
    this.bus.subscribe('story:beat', (env) => {
      this._evaluateBranches(env.data);
      this._evaluateNpcGoals(env.data);
      this._onBeatAtmosphere(env.data);
    }, 'world-clock');

    // Clue discovery
    this.bus.subscribe('clue:found', (env) => this._onClueFound(env.data), 'world-clock');

    // Secret reveal
    this.bus.subscribe('secret:reveal', (env) => this._onSecretReveal(env.data), 'world-clock');

    // Campaign continuity — check hooks on beat completion
    this.bus.subscribe('story:beat', (env) => {
      this._checkHookPayoffs(env.data);
      this._checkBackstoryOpportunities(env.data);
    }, 'world-clock');

    // Reputation changes from combat/NPC interactions
    this.bus.subscribe('campaign:reputation_event', (env) => {
      const { factionId, delta, reason } = env.data;
      if (factionId && delta) this.changeReputation(factionId, delta, reason);
    }, 'world-clock');

    console.log(`[WorldClock] Ready — ${this.timedEvents.length} timed events, ${this.secrets.size} secrets, ${this.clues.size} clues, ${this.futureHooks.size} hooks, ${this.reputation.size} factions`);
  }

  async stop() {
    if (this._tickInterval) clearInterval(this._tickInterval);
  }

  getStatus() {
    return {
      status: 'ok',
      gameTime: this.gameTime?.toISOString() || null,
      timeScale: this.timeScale,
      paused: this.paused,
      timedEvents: this.timedEvents.length,
      firedEvents: this.timedEvents.filter(e => e.fired).length,
      secrets: this.secrets.size,
      clues: this.clues.size,
      npcGoals: this.npcGoals.size,
      weather: this.weather.current?.type || 'clear',
      futureHooks: this.futureHooks.size,
      factions: this.reputation.size,
      backstories: this.backstories.size
    };
  }

  getFullState() {
    return {
      secrets: Object.fromEntries(
        Array.from(this.secrets.entries()).map(([id, s]) => [id, {
          id: s.id, description: s.description, revealed: s.revealed,
          discoveredBy: Object.keys(s.discoveredBy), knownBy: s.knownBy,
          linkedClues: s.linkedClues || []
        }])
      ),
      clues: Object.fromEntries(
        Array.from(this.clues.entries()).map(([id, c]) => [id, {
          id: c.id, description: c.description, found: c.found,
          foundBy: c.foundBy, location: c.location, dc: c.dc,
          revealsSecret: c.revealsSecret
        }])
      ),
      discoveries: Object.fromEntries(
        Array.from(this.discoveries.entries()).map(([id, d]) => [id, {
          id: d.id, description: d.description,
          clueChain: d.clueChain, currentStep: d.currentStep,
          completed: d.completed, revealsSecret: d.revealsSecret
        }])
      ),
      npcGoals: Object.fromEntries(Array.from(this.npcGoals.entries())),
      branches: Object.fromEntries(Array.from(this.branches.entries())),
      futureHooks: Object.fromEntries(
        Array.from(this.futureHooks.entries()).map(([id, h]) => [id, {
          id: h.id, description: h.description, status: h.status,
          payoffCondition: h.payoffCondition, session: h.session,
          linkedNpcs: h.linkedNpcs, notes: h.notes
        }])
      ),
      reputation: Object.fromEntries(
        Array.from(this.reputation.entries()).map(([id, r]) => [id, {
          id: r.id, name: r.name, score: r.score, tier: r.tier,
          regions: r.regions, recentChanges: r.history.slice(-5)
        }])
      ),
      backstories: Object.fromEntries(
        Array.from(this.backstories.entries()).map(([pid, bs]) => [pid, {
          summary: bs.summary, themes: bs.themes,
          activeHooks: bs.hooks.filter(h => h.status !== 'integrated').length,
          connections: bs.connections.length, integrated: bs.integrated.length
        }])
      )
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // CONFIG LOADING
  // ═══════════════════════════════════════════════════════════════

  _loadFromConfig(config) {
    const world = config.world || {};

    // World clock settings
    if (world.clock) {
      this.timeScale = world.clock.timeScale || 1;
      if (world.clock.startTime) {
        this.startGameTime = new Date(world.clock.startTime);
        this.gameTime = new Date(this.startGameTime);
      }
    }

    // Default game time if not set: October 1274, sunset
    if (!this.gameTime) {
      this.startGameTime = new Date('1274-10-15T17:30:00');
      this.gameTime = new Date(this.startGameTime);
    }

    // Timed events
    if (world.timedEvents) {
      for (const evt of world.timedEvents) {
        this.timedEvents.push({
          id: evt.id,
          gameTime: evt.gameTime ? new Date(evt.gameTime) : null,
          offsetMinutes: evt.offsetMinutes || null, // minutes after session start
          event: evt.event,
          data: evt.data || {},
          fired: false,
          repeating: evt.repeating || false,
          intervalMinutes: evt.intervalMinutes || null,
          condition: evt.condition || null // optional condition string
        });
      }
    }

    // Environmental cues
    if (world.environmentalCues) {
      for (const cue of world.environmentalCues) {
        this.environmentalCues.push({
          id: cue.id,
          intervalMinutes: cue.intervalMinutes || 15,
          lastFired: null,
          cues: cue.cues || [],
          index: 0,
          scene: cue.scene || null, // only fire in this scene
          random: cue.random || false
        });
      }
    }

    // Secrets
    if (world.secrets) {
      for (const s of world.secrets) {
        this.secrets.set(s.id, {
          id: s.id,
          description: s.description,
          knownBy: s.knownBy || [], // NPCs who know this
          discoveredBy: {}, // playerId -> timestamp
          discoveryMethods: s.discoveryMethods || [],
          revealConsequences: s.revealConsequences || null,
          revealed: false,
          linkedClues: s.linkedClues || [],
          linkedBeats: s.linkedBeats || []
        });
      }
    }

    // Clues
    if (world.clues) {
      for (const c of world.clues) {
        this.clues.set(c.id, {
          id: c.id,
          description: c.description,
          location: c.location || null,
          method: c.method || null, // 'investigation', 'perception', 'conversation', 'search'
          dc: c.dc || null,
          revealsSecret: c.revealsSecret || null,
          found: false,
          foundBy: null,
          foundAt: null,
          prerequisite: c.prerequisite || null, // clue id that must be found first
          readAloud: c.readAloud || null
        });
      }
    }

    // NPC goals
    if (config.npcs) {
      for (const [npcId, npc] of Object.entries(config.npcs)) {
        if (npc.goals) {
          this.npcGoals.set(npcId, npc.goals.map(g => ({
            id: g.id,
            goal: g.goal,
            priority: g.priority || 5,
            conditions: g.conditions || [],
            timerMinutes: g.timerMinutes || null,
            timerStarted: null,
            status: 'pending', // pending | active | completed | failed | blocked
            actions: g.actions || [],
            onComplete: g.onComplete || null,
            onFail: g.onFail || null
          })));
        }
      }
    }

    // Branching paths
    if (world.branches) {
      for (const b of world.branches) {
        this.branches.set(b.id, {
          id: b.id,
          description: b.description || '',
          conditions: b.conditions || [],
          active: false,
          convergeTo: b.convergeTo || null, // beat id where this branch merges back
          triggeredBy: b.triggeredBy || null, // what event triggers this branch
          effects: b.effects || [] // what happens when this branch activates
        });
      }
    }

    // Discovery chains
    if (world.discoveryChains) {
      for (const d of world.discoveryChains) {
        this.discoveries.set(d.id, {
          id: d.id,
          description: d.description || '',
          clueChain: d.clueChain || [], // ordered list of clue ids
          currentStep: 0,
          completed: false,
          revealsSecret: d.revealsSecret || null
        });
      }
    }

    // Weather phases
    if (world.weather) {
      this.weather.phases = (world.weather.phases || []).map(p => ({
        id: p.id,
        type: p.type,
        intensity: p.intensity || 1.0,
        description: p.description || '',
        startTime: p.startTime ? new Date(p.startTime) : null,
        offsetMinutes: p.offsetMinutes || null,
        atmosphereModifiers: p.atmosphereModifiers || null, // { flickerOverride, levelModifier, etc. }
        effects: p.effects || []
      }));
      // Set initial weather
      if (world.weather.initial) {
        this.weather.current = {
          type: world.weather.initial.type || 'clear',
          intensity: world.weather.initial.intensity || 1.0,
          description: world.weather.initial.description || ''
        };
      }
    }

    // Build beat -> atmosphere map from story beats
    if (config.story?.beats) {
      for (const beat of config.story.beats) {
        if (beat.atmosphere) {
          this.beatAtmosphereMap.set(beat.id, beat.atmosphere);
        }
      }
    }

    // Future hooks
    if (world.futureHooks) {
      for (const h of world.futureHooks) {
        this.futureHooks.set(h.id, {
          id: h.id,
          description: h.description,
          plantedAt: h.plantedAt || null,          // game time when planted
          plantedInBeat: h.plantedInBeat || null,  // beat id where planted
          payoffCondition: h.payoffCondition || null, // what triggers payoff
          payoffBeat: h.payoffBeat || null,         // beat where it pays off
          payoffSession: h.payoffSession || null,   // session number for payoff
          session: h.session || 0,                  // session when planted
          status: h.status || 'planted',            // planted | foreshadowed | ready | paid_off | abandoned
          notes: h.notes || '',
          linkedSecrets: h.linkedSecrets || [],
          linkedNpcs: h.linkedNpcs || []
        });
      }
    }

    // Reputation / factions
    if (world.factions) {
      for (const f of world.factions) {
        this.reputation.set(f.id, {
          id: f.id,
          name: f.name,
          description: f.description || '',
          score: f.initialScore || 0,           // -100 (hostile) to +100 (revered)
          tier: this._reputationTier(f.initialScore || 0),
          history: [],                           // { delta, reason, session, gameTime }
          regions: f.regions || [],              // where this faction operates
          allies: f.allies || [],                // other faction ids
          enemies: f.enemies || []
        });
      }
    }

    // Player backstories
    if (config.backstories) {
      for (const [playerId, bs] of Object.entries(config.backstories)) {
        this.backstories.set(playerId, {
          hooks: bs.hooks || [],                 // story hooks from backstory: { id, description, status }
          themes: bs.themes || [],               // recurring themes: 'loss', 'redemption', etc.
          connections: bs.connections || [],      // NPC/location connections: { type, targetId, description }
          integrated: [],                        // hooks that have been woven into play: { hookId, beatId, gameTime }
          summary: bs.summary || ''              // brief backstory summary for AI context
        });
      }
    }

    // Store in state for dashboard access
    this._syncToState();
  }

  _syncToState() {
    this.state.set('world.gameTime', this.gameTime?.toISOString() || null);
    this.state.set('world.timeScale', this.timeScale);
    this.state.set('world.paused', this.paused);

    // Secrets summary for dashboard
    const secretsSummary = {};
    for (const [id, s] of this.secrets) {
      secretsSummary[id] = {
        id: s.id,
        description: s.description,
        revealed: s.revealed,
        discoveredBy: Object.keys(s.discoveredBy),
        knownBy: s.knownBy
      };
    }
    this.state.set('world.secrets', secretsSummary);

    // Clues summary
    const cluesSummary = {};
    for (const [id, c] of this.clues) {
      cluesSummary[id] = {
        id: c.id,
        description: c.description,
        found: c.found,
        foundBy: c.foundBy,
        location: c.location
      };
    }
    this.state.set('world.clues', cluesSummary);

    // NPC goals summary
    const goalsSummary = {};
    for (const [npcId, goals] of this.npcGoals) {
      goalsSummary[npcId] = goals.map(g => ({
        id: g.id,
        goal: g.goal,
        priority: g.priority,
        status: g.status
      }));
    }
    this.state.set('world.npcGoals', goalsSummary);

    // Discovery chains
    const discoverySummary = {};
    for (const [id, d] of this.discoveries) {
      discoverySummary[id] = {
        id: d.id,
        description: d.description,
        progress: d.currentStep + '/' + d.clueChain.length,
        completed: d.completed
      };
    }
    this.state.set('world.discoveries', discoverySummary);

    // Weather state
    this.state.set('world.weather', this.weather.current || { type: 'clear', intensity: 0, description: '' });

    // Future hooks
    const hooksSummary = {};
    for (const [id, h] of this.futureHooks) {
      hooksSummary[id] = {
        id: h.id, description: h.description, status: h.status,
        payoffCondition: h.payoffCondition, session: h.session
      };
    }
    this.state.set('world.futureHooks', hooksSummary);

    // Reputation
    const repSummary = {};
    for (const [id, r] of this.reputation) {
      repSummary[id] = {
        id: r.id, name: r.name, score: r.score, tier: r.tier
      };
    }
    this.state.set('world.reputation', repSummary);

    // Backstories
    const bsSummary = {};
    for (const [playerId, bs] of this.backstories) {
      bsSummary[playerId] = {
        hooks: bs.hooks.length,
        integrated: bs.integrated.length,
        themes: bs.themes
      };
    }
    this.state.set('world.backstories', bsSummary);
  }

  // ═══════════════════════════════════════════════════════════════
  // CLOCK ENGINE
  // ═══════════════════════════════════════════════════════════════

  _onSessionStart() {
    this.paused = false;
    this._lastTick = Date.now();
    this._startTicking();

    // Resolve offset-based timed events
    for (const evt of this.timedEvents) {
      if (evt.offsetMinutes != null && !evt.gameTime) {
        evt.gameTime = new Date(this.gameTime.getTime() + evt.offsetMinutes * 60000);
      }
    }

    // Resolve offset-based weather phases
    for (const phase of this.weather.phases) {
      if (phase.offsetMinutes != null && !phase.startTime) {
        phase.startTime = new Date(this.gameTime.getTime() + phase.offsetMinutes * 60000);
      }
    }

    this.bus.dispatch('world:clock_started', {
      gameTime: this.gameTime.toISOString(),
      timeScale: this.timeScale
    });
  }

  _onSessionPause() {
    this.paused = true;
    this._syncToState();
  }

  _onSessionResume() {
    this.paused = false;
    this._lastTick = Date.now();
  }

  _onSessionEnd() {
    this.paused = true;
    if (this._tickInterval) clearInterval(this._tickInterval);
    this._syncToState();
  }

  _startTicking() {
    if (this._tickInterval) clearInterval(this._tickInterval);

    // Tick every second
    this._tickInterval = setInterval(() => {
      if (this.paused) return;

      const now = Date.now();
      const realElapsed = now - this._lastTick;
      this._lastTick = now;

      // Advance game time by elapsed * timeScale
      const gameElapsed = realElapsed * this.timeScale;
      this.gameTime = new Date(this.gameTime.getTime() + gameElapsed);

      // Check timed events
      this._checkTimedEvents();

      // Check environmental cues
      this._checkEnvironmentalCues();

      // Check NPC goal timers
      this._checkNpcGoalTimers();

      // Check weather transitions
      this._checkWeather();

      // Broadcast time update every 10 seconds (not every tick)
      if (now % 10000 < 1100) {
        this.state.set('world.gameTime', this.gameTime.toISOString());
        this.bus.dispatch('world:time_update', {
          gameTime: this.gameTime.toISOString(),
          timeScale: this.timeScale,
          formatted: this._formatGameTime()
        });
      }
    }, 1000);
  }

  _checkTimedEvents() {
    for (const evt of this.timedEvents) {
      if (evt.fired && !evt.repeating) continue;
      if (!evt.gameTime) continue;

      // Check condition if present
      if (evt.condition && !this._evaluateCondition(evt.condition)) continue;

      if (this.gameTime >= evt.gameTime) {
        evt.fired = true;

        // Fire the event
        this.bus.dispatch('world:timed_event', {
          id: evt.id,
          event: evt.event,
          data: evt.data,
          gameTime: this.gameTime.toISOString()
        });

        // Also dispatch the actual event type
        if (evt.event) {
          this.bus.dispatch(evt.event, { ...evt.data, _timedEvent: evt.id });
        }

        // If the event carries an atmosphere profile, trigger the change (Feature 45)
        if (evt.data.profile) {
          this.bus.dispatch('atmo:change', {
            profile: evt.data.profile,
            reason: `Timed event: ${evt.data.description || evt.id}`,
            auto: true,
            source: 'timed_event'
          });
        }

        // Whisper to DM
        this.bus.dispatch('dm:whisper', {
          text: `[${this._formatGameTime()}] Event: ${evt.data.description || evt.id}`,
          priority: 3,
          category: 'story'
        });

        console.log(`[WorldClock] Timed event fired: ${evt.id} at ${this._formatGameTime()}`);

        // Handle repeating events
        if (evt.repeating && evt.intervalMinutes) {
          evt.gameTime = new Date(evt.gameTime.getTime() + evt.intervalMinutes * 60000);
          evt.fired = false;
        }
      }
    }
  }

  _checkEnvironmentalCues() {
    const currentScene = this.state.get('scene.id');

    for (const cue of this.environmentalCues) {
      if (cue.cues.length === 0) continue;
      if (cue.scene && cue.scene !== currentScene) continue;

      const intervalMs = cue.intervalMinutes * 60000 / this.timeScale; // Adjust for time scale
      const now = Date.now();

      if (!cue.lastFired || (now - cue.lastFired) >= intervalMs) {
        cue.lastFired = now;

        // Pick cue text
        let text;
        if (cue.random) {
          text = cue.cues[Math.floor(Math.random() * cue.cues.length)];
        } else {
          text = cue.cues[cue.index % cue.cues.length];
          cue.index++;
        }

        this.bus.dispatch('dm:whisper', {
          text: text,
          priority: 5,
          category: 'atmosphere'
        });

        this.bus.dispatch('world:environmental_cue', {
          id: cue.id,
          text: text,
          gameTime: this.gameTime.toISOString()
        });
      }
    }
  }

  _checkNpcGoalTimers() {
    for (const [npcId, goals] of this.npcGoals) {
      for (const goal of goals) {
        if (goal.status !== 'active' || !goal.timerMinutes || !goal.timerStarted) continue;

        const elapsed = (Date.now() - goal.timerStarted) / 60000;
        if (elapsed >= goal.timerMinutes) {
          // Timer expired — NPC acts
          this.bus.dispatch('world:npc_goal_timer', {
            npcId,
            goalId: goal.id,
            goal: goal.goal,
            actions: goal.actions
          });

          this.bus.dispatch('dm:whisper', {
            text: `${npcId} goal timer expired: "${goal.goal}" — NPC will act now`,
            priority: 2,
            category: 'story'
          });

          goal.timerStarted = null; // Reset so it doesn't fire again
        }
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // SECRETS & CLUES
  // ═══════════════════════════════════════════════════════════════

  _onClueFound(data) {
    const { clueId, playerId } = data;
    const clue = this.clues.get(clueId);
    if (!clue) return;

    // Check prerequisite
    if (clue.prerequisite) {
      const prereq = this.clues.get(clue.prerequisite);
      if (prereq && !prereq.found) {
        this.bus.dispatch('dm:whisper', {
          text: `Clue "${clue.description}" has prerequisite "${prereq.description}" — not yet found`,
          priority: 3,
          category: 'story'
        });
        return;
      }
    }

    clue.found = true;
    clue.foundBy = playerId;
    clue.foundAt = this.gameTime?.toISOString();

    // Advance discovery chains
    for (const [id, chain] of this.discoveries) {
      const stepClueId = chain.clueChain[chain.currentStep];
      if (stepClueId === clueId) {
        chain.currentStep++;
        if (chain.currentStep >= chain.clueChain.length) {
          chain.completed = true;
          if (chain.revealsSecret) {
            this._onSecretReveal({ secretId: chain.revealsSecret, playerId, method: 'discovery_chain' });
          }
          this.bus.dispatch('world:discovery_complete', { chainId: id, playerId });
        } else {
          this.bus.dispatch('world:discovery_progress', {
            chainId: id,
            step: chain.currentStep,
            total: chain.clueChain.length
          });
        }
      }
    }

    // Check if clue reveals a secret directly
    if (clue.revealsSecret) {
      const secret = this.secrets.get(clue.revealsSecret);
      if (secret && !secret.revealed) {
        secret.discoveredBy[playerId] = Date.now();
        // Don't fully reveal yet — just mark that this player has a piece
        this.bus.dispatch('dm:whisper', {
          text: `${playerId} found clue toward secret: "${secret.description}"`,
          priority: 3,
          category: 'story'
        });
      }
    }

    // Read-aloud for the DM
    if (clue.readAloud) {
      this.bus.dispatch('dm:whisper', {
        text: `READ ALOUD: ${clue.readAloud}`,
        priority: 2,
        category: 'story'
      });
    }

    this.bus.dispatch('world:clue_found', { clueId, clue, playerId });
    this._syncToState();
  }

  _onSecretReveal(data) {
    const { secretId, playerId, method } = data;
    const secret = this.secrets.get(secretId);
    if (!secret) return;

    secret.revealed = true;
    if (playerId) {
      secret.discoveredBy[playerId] = Date.now();
    }

    this.bus.dispatch('world:secret_revealed', {
      secretId,
      description: secret.description,
      playerId,
      method,
      consequences: secret.revealConsequences
    });

    // Whisper consequences to DM
    if (secret.revealConsequences) {
      this.bus.dispatch('dm:whisper', {
        text: `SECRET REVEALED: "${secret.description}" — ${secret.revealConsequences}`,
        priority: 1,
        category: 'story'
      });
    }

    // Check if any beats should trigger
    for (const beatId of secret.linkedBeats) {
      this.bus.dispatch('story:mark_beat', { beatId, status: 'completed' });
    }

    this._syncToState();
  }

  /**
   * Check what a player knows — returns list of discovered secrets
   */
  getPlayerKnowledge(playerId) {
    const known = [];
    for (const [id, secret] of this.secrets) {
      if (secret.discoveredBy[playerId]) {
        known.push({ id, description: secret.description, when: secret.discoveredBy[playerId] });
      }
    }
    const foundClues = [];
    for (const [id, clue] of this.clues) {
      if (clue.found && clue.foundBy === playerId) {
        foundClues.push({ id, description: clue.description });
      }
    }
    return { secrets: known, clues: foundClues };
  }

  /**
   * Check what is NOT yet known — for AI information control
   */
  getUnrevealedSecrets() {
    const unrevealed = [];
    for (const [id, secret] of this.secrets) {
      if (!secret.revealed) {
        unrevealed.push({
          id,
          description: secret.description,
          knownBy: secret.knownBy,
          discoveryMethods: secret.discoveryMethods,
          partiallyDiscoveredBy: Object.keys(secret.discoveredBy)
        });
      }
    }
    return unrevealed;
  }

  // ═══════════════════════════════════════════════════════════════
  // NPC GOALS
  // ═══════════════════════════════════════════════════════════════

  activateNpcGoal(npcId, goalId) {
    const goals = this.npcGoals.get(npcId);
    if (!goals) return;
    const goal = goals.find(g => g.id === goalId);
    if (!goal) return;

    goal.status = 'active';
    if (goal.timerMinutes) {
      goal.timerStarted = Date.now();
    }

    this.bus.dispatch('world:npc_goal_activated', { npcId, goalId, goal: goal.goal });
    this.bus.dispatch('dm:whisper', {
      text: `NPC goal activated: ${npcId} — "${goal.goal}"`,
      priority: 3,
      category: 'story'
    });
    this._syncToState();
  }

  completeNpcGoal(npcId, goalId) {
    const goals = this.npcGoals.get(npcId);
    if (!goals) return;
    const goal = goals.find(g => g.id === goalId);
    if (!goal) return;

    goal.status = 'completed';
    if (goal.onComplete) {
      this.bus.dispatch(goal.onComplete.event, goal.onComplete.data || {});
    }

    this.bus.dispatch('world:npc_goal_completed', { npcId, goalId });
    this._syncToState();
  }

  failNpcGoal(npcId, goalId) {
    const goals = this.npcGoals.get(npcId);
    if (!goals) return;
    const goal = goals.find(g => g.id === goalId);
    if (!goal) return;

    goal.status = 'failed';
    if (goal.onFail) {
      this.bus.dispatch(goal.onFail.event, goal.onFail.data || {});
    }

    this.bus.dispatch('world:npc_goal_failed', { npcId, goalId });
    this._syncToState();
  }

  // ═══════════════════════════════════════════════════════════════
  // BRANCHING PATHS
  // ═══════════════════════════════════════════════════════════════

  _evaluateBranches(beatData) {
    for (const [id, branch] of this.branches) {
      if (branch.active) continue;

      // Check if this beat triggers the branch
      if (branch.triggeredBy === beatData.beatId) {
        // Check all conditions
        const conditionsMet = branch.conditions.every(c => this._evaluateCondition(c));
        if (conditionsMet) {
          branch.active = true;
          this.bus.dispatch('world:branch_activated', { branchId: id, description: branch.description });
          this.bus.dispatch('dm:whisper', {
            text: `Story branch activated: "${branch.description}"`,
            priority: 2,
            category: 'story'
          });

          // Execute branch effects
          for (const effect of branch.effects) {
            if (effect.event) {
              this.bus.dispatch(effect.event, effect.data || {});
            }
          }
        }
      }
    }
    this._syncToState();
  }

  _evaluateNpcGoals(beatData) {
    // When a beat completes, check if any NPC goals should activate
    for (const [npcId, goals] of this.npcGoals) {
      for (const goal of goals) {
        if (goal.status !== 'pending') continue;
        for (const cond of goal.conditions) {
          if (cond.type === 'beat_completed' && cond.beatId === beatData.beatId) {
            this.activateNpcGoal(npcId, goal.id);
          }
        }
      }
    }
  }

  _evaluateCondition(condition) {
    if (typeof condition === 'string') {
      // Simple string conditions: "beat:investigation:completed", "secret:cellar_coffin:revealed"
      const parts = condition.split(':');
      if (parts[0] === 'beat') {
        const beats = this.state.get('story.beats') || [];
        const beat = beats.find(b => b.id === parts[1]);
        return beat && beat.status === (parts[2] || 'completed');
      }
      if (parts[0] === 'secret') {
        const secret = this.secrets.get(parts[1]);
        return secret && (parts[2] === 'revealed' ? secret.revealed : !secret.revealed);
      }
      if (parts[0] === 'clue') {
        const clue = this.clues.get(parts[1]);
        return clue && clue.found;
      }
      if (parts[0] === 'time') {
        // "time:after:20:00" or "time:before:06:00"
        const hours = parseInt(parts[2]);
        const mins = parseInt(parts[3] || 0);
        const targetMinutes = hours * 60 + mins;
        const currentMinutes = this.gameTime.getHours() * 60 + this.gameTime.getMinutes();
        return parts[1] === 'after' ? currentMinutes >= targetMinutes : currentMinutes < targetMinutes;
      }
      if (parts[0] === 'npc') {
        // "npc:tomas:status:alive"
        const npc = this.state.get(`npcs.${parts[1]}`);
        return npc && npc[parts[2]] === parts[3];
      }
    }

    if (typeof condition === 'object') {
      if (condition.type === 'beat_completed') {
        const beats = this.state.get('story.beats') || [];
        const beat = beats.find(b => b.id === condition.beatId);
        return beat && beat.status === 'completed';
      }
      if (condition.type === 'secret_revealed') {
        const secret = this.secrets.get(condition.secretId);
        return secret && secret.revealed;
      }
      if (condition.type === 'clue_found') {
        const clue = this.clues.get(condition.clueId);
        return clue && clue.found;
      }
      if (condition.type === 'time_after') {
        const target = new Date(condition.gameTime);
        return this.gameTime >= target;
      }
    }

    return false;
  }

  // ═══════════════════════════════════════════════════════════════
  // BEAT-LINKED ATMOSPHERE (Feature 42)
  // ═══════════════════════════════════════════════════════════════

  _onBeatAtmosphere(beatData) {
    if (beatData.status !== 'completed') return;

    const profileName = this.beatAtmosphereMap.get(beatData.beatId);
    if (!profileName) return;

    console.log(`[WorldClock] Beat "${beatData.beatId}" completed → atmosphere: ${profileName}`);
    this.bus.dispatch('atmo:change', {
      profile: profileName,
      reason: `Beat completed: ${beatData.name || beatData.beatId}`,
      auto: true,
      source: 'beat'
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // WEATHER SYSTEM (Feature 44)
  // ═══════════════════════════════════════════════════════════════

  _checkWeather() {
    if (this.weather.phases.length === 0) return;

    // Find the latest applicable weather phase
    let activePhase = null;
    for (const phase of this.weather.phases) {
      if (!phase.startTime) continue;
      if (this.gameTime >= phase.startTime) {
        activePhase = phase;
      }
    }

    if (!activePhase) return;
    if (this.weather.current && this.weather.current._phaseId === activePhase.id) return;

    // Weather is changing
    const previous = this.weather.current;
    this.weather.current = {
      _phaseId: activePhase.id,
      type: activePhase.type,
      intensity: activePhase.intensity,
      description: activePhase.description
    };
    this.weather.lastTransition = Date.now();

    console.log(`[WorldClock] Weather: ${previous?.type || 'none'} → ${activePhase.type} (${activePhase.description})`);

    this.bus.dispatch('world:weather_change', {
      previous: previous?.type || null,
      current: activePhase.type,
      intensity: activePhase.intensity,
      description: activePhase.description,
      gameTime: this.gameTime.toISOString()
    });

    this.bus.dispatch('dm:whisper', {
      text: `Weather: ${activePhase.description}`,
      priority: 4,
      category: 'atmosphere'
    });

    // Apply atmosphere modifiers if configured
    if (activePhase.atmosphereModifiers) {
      this.bus.dispatch('atmo:weather_modifier', {
        weather: activePhase.type,
        intensity: activePhase.intensity,
        modifiers: activePhase.atmosphereModifiers
      });
    }

    // Fire any weather-specific effects
    for (const effect of activePhase.effects) {
      if (effect.event) {
        this.bus.dispatch(effect.event, effect.data || {});
      }
    }

    this._syncToState();
  }

  _onSceneChange(sceneId) {
    // Reset environmental cue timers for new scene
    for (const cue of this.environmentalCues) {
      cue.lastFired = null;
      cue.index = 0;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // UTILITY
  // ═══════════════════════════════════════════════════════════════

  _formatGameTime() {
    if (!this.gameTime) return '--:--';
    const h = this.gameTime.getHours().toString().padStart(2, '0');
    const m = this.gameTime.getMinutes().toString().padStart(2, '0');
    return `${h}:${m}`;
  }

  getFormattedGameTime() {
    if (!this.gameTime) return { time: '--:--', date: '', period: '' };
    const h = this.gameTime.getHours();
    const m = this.gameTime.getMinutes().toString().padStart(2, '0');
    const period = h < 6 ? 'night' : h < 12 ? 'morning' : h < 17 ? 'afternoon' : h < 20 ? 'evening' : 'night';
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const date = `${months[this.gameTime.getMonth()]} ${this.gameTime.getDate()}, ${this.gameTime.getFullYear()}`;
    return {
      time: `${h.toString().padStart(2,'0')}:${m}`,
      date,
      period,
      hours: h,
      minutes: parseInt(m)
    };
  }

  setTimeScale(scale) {
    this.timeScale = Math.max(0, Math.min(60, scale)); // 0x to 60x
    this.state.set('world.timeScale', this.timeScale);
    this.bus.dispatch('world:timescale_changed', { timeScale: this.timeScale });
  }

  advanceTime(minutes) {
    this.gameTime = new Date(this.gameTime.getTime() + minutes * 60000);
    this._checkTimedEvents();
    this._syncToState();
    this.bus.dispatch('world:time_advanced', {
      minutes,
      gameTime: this.gameTime.toISOString(),
      formatted: this._formatGameTime()
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // API ROUTES
  // ═══════════════════════════════════════════════════════════════

  // ═══════════════════════════════════════════════════════════════
  // PHASE M — CAMPAIGN CONTINUITY
  // ═══════════════════════════════════════════════════════════════

  _reputationTier(score) {
    if (score >= 80) return 'revered';
    if (score >= 50) return 'honored';
    if (score >= 20) return 'friendly';
    if (score >= -20) return 'neutral';
    if (score >= -50) return 'unfriendly';
    if (score >= -80) return 'hostile';
    return 'hated';
  }

  // --- Future Hooks ---

  plantHook(hookData) {
    const id = hookData.id || `hook-${Date.now()}`;
    const hook = {
      id,
      description: hookData.description,
      plantedAt: this.gameTime?.toISOString() || null,
      plantedInBeat: hookData.beatId || null,
      payoffCondition: hookData.payoffCondition || null,
      payoffBeat: hookData.payoffBeat || null,
      payoffSession: hookData.payoffSession || null,
      session: hookData.session || 0,
      status: 'planted',
      notes: hookData.notes || '',
      linkedSecrets: hookData.linkedSecrets || [],
      linkedNpcs: hookData.linkedNpcs || []
    };
    this.futureHooks.set(id, hook);
    this._syncToState();

    this.bus.dispatch('campaign:hook_planted', { hook });
    this.bus.dispatch('dm:whisper', {
      text: `Hook planted: ${hook.description}`,
      priority: 4, category: 'story'
    });
    console.log(`[WorldClock] Future hook planted: ${id} — ${hook.description}`);
    return hook;
  }

  updateHookStatus(hookId, status, notes) {
    const hook = this.futureHooks.get(hookId);
    if (!hook) return null;
    const previous = hook.status;
    hook.status = status;
    if (notes) hook.notes = notes;
    this._syncToState();

    this.bus.dispatch('campaign:hook_updated', { hookId, previous, status });
    if (status === 'paid_off') {
      this.bus.dispatch('dm:whisper', {
        text: `Hook paid off: ${hook.description}`,
        priority: 3, category: 'story'
      });
    }
    return hook;
  }

  getReadyHooks() {
    // Hooks that are planted/foreshadowed and could pay off this session
    return Array.from(this.futureHooks.values()).filter(h =>
      (h.status === 'planted' || h.status === 'foreshadowed' || h.status === 'ready')
    );
  }

  // --- Reputation ---

  changeReputation(factionId, delta, reason) {
    const faction = this.reputation.get(factionId);
    if (!faction) return null;

    const oldScore = faction.score;
    const oldTier = faction.tier;
    faction.score = Math.max(-100, Math.min(100, faction.score + delta));
    faction.tier = this._reputationTier(faction.score);
    faction.history.push({
      delta,
      reason,
      session: this.state.get('session.id') || 0,
      gameTime: this.gameTime?.toISOString() || null,
      timestamp: new Date().toISOString()
    });

    this._syncToState();

    const tierChanged = oldTier !== faction.tier;
    this.bus.dispatch('campaign:reputation_change', {
      factionId, factionName: faction.name,
      oldScore, newScore: faction.score,
      delta, reason, tier: faction.tier, tierChanged
    });

    if (tierChanged) {
      this.bus.dispatch('dm:whisper', {
        text: `Reputation with ${faction.name}: ${oldTier} → ${faction.tier} (${faction.score})`,
        priority: 3, category: 'story'
      });
    }

    console.log(`[WorldClock] Reputation ${factionId}: ${oldScore} → ${faction.score} (${reason})`);
    return faction;
  }

  getReputationSummary() {
    return Array.from(this.reputation.values()).map(r => ({
      id: r.id, name: r.name, score: r.score, tier: r.tier,
      regions: r.regions, recentChanges: r.history.slice(-5)
    }));
  }

  // --- Player Backstory Integration ---

  addBackstory(playerId, backstoryData) {
    const bs = this.backstories.get(playerId) || {
      hooks: [], themes: [], connections: [], integrated: [], summary: ''
    };
    if (backstoryData.hooks) bs.hooks.push(...backstoryData.hooks);
    if (backstoryData.themes) bs.themes.push(...backstoryData.themes);
    if (backstoryData.connections) bs.connections.push(...backstoryData.connections);
    if (backstoryData.summary) bs.summary = backstoryData.summary;
    this.backstories.set(playerId, bs);
    this._syncToState();
    return bs;
  }

  markBackstoryIntegrated(playerId, hookId, beatId) {
    const bs = this.backstories.get(playerId);
    if (!bs) return null;
    bs.integrated.push({
      hookId, beatId,
      gameTime: this.gameTime?.toISOString() || null,
      timestamp: new Date().toISOString()
    });
    // Mark the hook as used
    const hook = bs.hooks.find(h => h.id === hookId);
    if (hook) hook.status = 'integrated';
    this._syncToState();

    this.bus.dispatch('campaign:backstory_integrated', { playerId, hookId, beatId });
    return bs;
  }

  getBackstoryContext(playerId) {
    const bs = this.backstories.get(playerId);
    if (!bs) return null;
    return {
      summary: bs.summary,
      activeHooks: bs.hooks.filter(h => h.status !== 'integrated'),
      themes: bs.themes,
      connections: bs.connections,
      integratedCount: bs.integrated.length
    };
  }

  _checkHookPayoffs(beatData) {
    // When a beat completes, check if any hooks reference it as payoff
    if (!beatData?.beatId) return;
    for (const [id, hook] of this.futureHooks) {
      if (hook.status === 'planted' || hook.status === 'foreshadowed' || hook.status === 'ready') {
        if (hook.payoffBeat === beatData.beatId) {
          this.updateHookStatus(id, 'paid_off', `Paid off at beat: ${beatData.beatId}`);
        }
      }
    }
  }

  _checkBackstoryOpportunities(beatData) {
    // Whisper to DM when a beat has potential backstory tie-ins
    if (!beatData?.beatId) return;
    for (const [playerId, bs] of this.backstories) {
      for (const hook of bs.hooks) {
        if (hook.status === 'integrated') continue;
        // Check if hook's trigger matches this beat or related themes
        if (hook.triggerBeat === beatData.beatId || hook.triggerCondition === beatData.beatId) {
          const playerName = this.state.get(`players.${playerId}.character.name`) || playerId;
          this.bus.dispatch('dm:whisper', {
            text: `Backstory opportunity for ${playerName}: ${hook.description}`,
            priority: 3, category: 'story'
          });
        }
      }
    }
  }

  getAllBackstoryHooks() {
    // Get all un-integrated backstory hooks across all players for AI to weave in
    const hooks = [];
    for (const [playerId, bs] of this.backstories) {
      for (const hook of bs.hooks) {
        if (hook.status !== 'integrated') {
          hooks.push({ playerId, ...hook });
        }
      }
    }
    return hooks;
  }

  _setupRoutes() {
    const app = this.orchestrator.getService('dashboard')?.app;
    if (!app) return;

    // GET /api/world — full world state
    app.get('/api/world', (req, res) => {
      res.json({
        clock: this.getFormattedGameTime(),
        timeScale: this.timeScale,
        paused: this.paused,
        weather: this.weather.current || { type: 'clear', intensity: 0 },
        timedEvents: this.timedEvents.map(e => ({
          id: e.id, fired: e.fired, gameTime: e.gameTime?.toISOString(),
          description: e.data?.description || e.id
        })),
        secrets: Array.from(this.secrets.values()).map(s => ({
          id: s.id, description: s.description, revealed: s.revealed,
          discoveredBy: Object.keys(s.discoveredBy), knownBy: s.knownBy
        })),
        clues: Array.from(this.clues.values()).map(c => ({
          id: c.id, description: c.description, found: c.found,
          foundBy: c.foundBy, location: c.location, dc: c.dc
        })),
        npcGoals: Object.fromEntries(
          Array.from(this.npcGoals.entries()).map(([npcId, goals]) => [
            npcId, goals.map(g => ({ id: g.id, goal: g.goal, priority: g.priority, status: g.status }))
          ])
        ),
        discoveries: Array.from(this.discoveries.values()).map(d => ({
          id: d.id, description: d.description,
          progress: `${d.currentStep}/${d.clueChain.length}`, completed: d.completed
        })),
        branches: Array.from(this.branches.values()).map(b => ({
          id: b.id, description: b.description, active: b.active
        })),
        futureHooks: Array.from(this.futureHooks.values()).map(h => ({
          id: h.id, description: h.description, status: h.status,
          payoffCondition: h.payoffCondition, session: h.session, notes: h.notes
        })),
        reputation: Array.from(this.reputation.values()).map(r => ({
          id: r.id, name: r.name, score: r.score, tier: r.tier
        })),
        backstories: Object.fromEntries(
          Array.from(this.backstories.entries()).map(([pid, bs]) => [pid, {
            themes: bs.themes,
            activeHooks: bs.hooks.filter(h => h.status !== 'integrated').length
          }])
        )
      });
    });

    // POST /api/world/time-scale — set time scale
    app.post('/api/world/time-scale', (req, res) => {
      this.setTimeScale(req.body.scale);
      res.json({ timeScale: this.timeScale });
    });

    // POST /api/world/advance-time — jump forward N minutes
    app.post('/api/world/advance-time', (req, res) => {
      const minutes = parseInt(req.body.minutes) || 0;
      if (minutes <= 0) return res.status(400).json({ error: 'minutes must be > 0' });
      this.advanceTime(minutes);
      res.json({ gameTime: this.gameTime.toISOString(), formatted: this._formatGameTime() });
    });

    // POST /api/world/clue — mark a clue as found
    app.post('/api/world/clue', (req, res) => {
      const { clueId, playerId } = req.body;
      this.bus.dispatch('clue:found', { clueId, playerId });
      res.json({ ok: true });
    });

    // POST /api/world/secret — reveal a secret
    app.post('/api/world/secret', (req, res) => {
      const { secretId, playerId, method } = req.body;
      this.bus.dispatch('secret:reveal', { secretId, playerId, method });
      res.json({ ok: true });
    });

    // POST /api/world/npc-goal — activate/complete/fail an NPC goal
    app.post('/api/world/npc-goal', (req, res) => {
      const { npcId, goalId, action } = req.body;
      if (action === 'activate') this.activateNpcGoal(npcId, goalId);
      else if (action === 'complete') this.completeNpcGoal(npcId, goalId);
      else if (action === 'fail') this.failNpcGoal(npcId, goalId);
      else return res.status(400).json({ error: 'action must be activate/complete/fail' });
      res.json({ ok: true });
    });

    // GET /api/world/player-knowledge/:playerId — what does this player know
    app.get('/api/world/player-knowledge/:playerId', (req, res) => {
      res.json(this.getPlayerKnowledge(req.params.playerId));
    });

    // GET /api/world/unrevealed — what hasn't been discovered yet (for AI)
    app.get('/api/world/unrevealed', (req, res) => {
      res.json(this.getUnrevealedSecrets());
    });

    // POST /api/world/add-secret — add a secret mid-session (AI or DM)
    app.post('/api/world/add-secret', (req, res) => {
      const s = req.body;
      if (!s.id || !s.description) return res.status(400).json({ error: 'id and description required' });
      this.secrets.set(s.id, {
        id: s.id, description: s.description, knownBy: s.knownBy || [],
        discoveredBy: {}, discoveryMethods: s.discoveryMethods || [],
        revealConsequences: s.revealConsequences || null, revealed: false,
        linkedClues: s.linkedClues || [], linkedBeats: s.linkedBeats || []
      });
      this._syncToState();
      res.json({ ok: true, secretId: s.id });
    });

    // POST /api/world/add-clue — add a clue mid-session (AI or DM)
    app.post('/api/world/add-clue', (req, res) => {
      const c = req.body;
      if (!c.id || !c.description) return res.status(400).json({ error: 'id and description required' });
      this.clues.set(c.id, {
        id: c.id, description: c.description, location: c.location || null,
        method: c.method || null, dc: c.dc || null, revealsSecret: c.revealsSecret || null,
        found: false, foundBy: null, foundAt: null, prerequisite: c.prerequisite || null,
        readAloud: c.readAloud || null
      });
      this._syncToState();
      res.json({ ok: true, clueId: c.id });
    });

    // POST /api/world/weather — manually set weather
    app.post('/api/world/weather', (req, res) => {
      const { type, intensity, description } = req.body;
      if (!type) return res.status(400).json({ error: 'type required' });
      const previous = this.weather.current?.type;
      this.weather.current = {
        type,
        intensity: intensity || 1.0,
        description: description || type
      };
      this.weather.lastTransition = Date.now();
      this.bus.dispatch('world:weather_change', {
        previous,
        current: type,
        intensity: this.weather.current.intensity,
        description: this.weather.current.description,
        manual: true
      });
      this._syncToState();
      res.json({ ok: true, weather: this.weather.current });
    });

    // ── Phase M: Future Hooks ──

    // GET /api/world/hooks — all future hooks
    app.get('/api/world/hooks', (req, res) => {
      res.json(Array.from(this.futureHooks.values()));
    });

    // GET /api/world/hooks/ready — hooks ready to pay off
    app.get('/api/world/hooks/ready', (req, res) => {
      res.json(this.getReadyHooks());
    });

    // POST /api/world/hooks — plant a new hook
    app.post('/api/world/hooks', (req, res) => {
      const { description, payoffCondition, payoffBeat, payoffSession, beatId, notes, linkedSecrets, linkedNpcs } = req.body;
      if (!description) return res.status(400).json({ error: 'description required' });
      const hook = this.plantHook({ description, payoffCondition, payoffBeat, payoffSession, beatId, notes, linkedSecrets, linkedNpcs });
      res.json({ ok: true, hook });
    });

    // PUT /api/world/hooks/:id — update hook status
    app.put('/api/world/hooks/:id', (req, res) => {
      const { status, notes } = req.body;
      if (!status) return res.status(400).json({ error: 'status required (planted/foreshadowed/ready/paid_off/abandoned)' });
      const hook = this.updateHookStatus(req.params.id, status, notes);
      if (!hook) return res.status(404).json({ error: 'hook not found' });
      res.json({ ok: true, hook });
    });

    // ── Phase M: Reputation ──

    // GET /api/world/reputation — all faction reputations
    app.get('/api/world/reputation', (req, res) => {
      res.json(this.getReputationSummary());
    });

    // POST /api/world/reputation — change faction reputation
    app.post('/api/world/reputation', (req, res) => {
      const { factionId, delta, reason } = req.body;
      if (!factionId || delta == null) return res.status(400).json({ error: 'factionId and delta required' });
      const faction = this.changeReputation(factionId, delta, reason || 'manual adjustment');
      if (!faction) return res.status(404).json({ error: 'faction not found' });
      res.json({ ok: true, faction: { id: faction.id, name: faction.name, score: faction.score, tier: faction.tier } });
    });

    // POST /api/world/reputation/add-faction — add faction mid-session
    app.post('/api/world/reputation/add-faction', (req, res) => {
      const f = req.body;
      if (!f.id || !f.name) return res.status(400).json({ error: 'id and name required' });
      this.reputation.set(f.id, {
        id: f.id, name: f.name, description: f.description || '',
        score: f.initialScore || 0, tier: this._reputationTier(f.initialScore || 0),
        history: [], regions: f.regions || [], allies: f.allies || [], enemies: f.enemies || []
      });
      this._syncToState();
      res.json({ ok: true, factionId: f.id });
    });

    // ── Phase M: Backstories ──

    // GET /api/world/backstories — all player backstory data
    app.get('/api/world/backstories', (req, res) => {
      const result = {};
      for (const [pid, bs] of this.backstories) {
        result[pid] = {
          summary: bs.summary, themes: bs.themes,
          hooks: bs.hooks, connections: bs.connections,
          integrated: bs.integrated
        };
      }
      res.json(result);
    });

    // GET /api/world/backstories/hooks — all un-integrated backstory hooks (for AI)
    app.get('/api/world/backstories/hooks', (req, res) => {
      res.json(this.getAllBackstoryHooks());
    });

    // POST /api/world/backstories/:playerId — add/update player backstory
    app.post('/api/world/backstories/:playerId', (req, res) => {
      const bs = this.addBackstory(req.params.playerId, req.body);
      res.json({ ok: true, backstory: bs });
    });

    // POST /api/world/backstories/:playerId/integrate — mark a hook as woven in
    app.post('/api/world/backstories/:playerId/integrate', (req, res) => {
      const { hookId, beatId } = req.body;
      if (!hookId) return res.status(400).json({ error: 'hookId required' });
      const bs = this.markBackstoryIntegrated(req.params.playerId, hookId, beatId);
      if (!bs) return res.status(404).json({ error: 'player backstory not found' });
      res.json({ ok: true });
    });

    // ── Journey System ──

    // GET /api/world/journey — current journey state
    app.get('/api/world/journey', (req, res) => {
      res.json(this.getJourneyState());
    });

    // POST /api/world/journey/start — begin a journey
    app.post('/api/world/journey/start', (req, res) => {
      const { origin, destination, terrain } = req.body;
      if (!origin || !destination) return res.status(400).json({ error: 'origin and destination required' });
      const j = this.startJourney(origin, destination, terrain);
      res.json({ ok: true, journey: j });
    });

    // POST /api/world/journey/advance — advance journey by one phase
    app.post('/api/world/journey/advance', (req, res) => {
      const { phase, navCheck, campChoice } = req.body;
      const result = this.advanceJourney(phase, { navCheck, campChoice });
      res.json({ ok: true, result });
    });

    // POST /api/world/journey/camp — set camp choice for the night
    app.post('/api/world/journey/camp', (req, res) => {
      const { choice } = req.body;
      const result = this.setCampChoice(choice);
      res.json({ ok: true, journey: result });
    });

    // POST /api/world/journey/complication — log a complication
    app.post('/api/world/journey/complication', (req, res) => {
      const { description } = req.body;
      this.addJourneyComplication(description);
      res.json({ ok: true });
    });

    // POST /api/world/journey/encounter — manually trigger an encounter
    app.post('/api/world/journey/encounter', (req, res) => {
      const { creatureId, description } = req.body;
      this.bus.dispatch('journey:encounter', { creatureId, description, journey: this.getJourneyState() });
      res.json({ ok: true });
    });

    // POST /api/world/journey/end — end the journey (arrived)
    app.post('/api/world/journey/end', (req, res) => {
      const j = this.endJourney();
      res.json({ ok: true, journey: j });
    });

    // POST /api/world/add-timed-event — add a timed event mid-session
    app.post('/api/world/add-timed-event', (req, res) => {
      const evt = req.body;
      if (!evt.id) return res.status(400).json({ error: 'id required' });
      const newEvt = {
        id: evt.id,
        gameTime: evt.gameTime ? new Date(evt.gameTime) : null,
        offsetMinutes: evt.offsetMinutes || null,
        event: evt.event, data: evt.data || {},
        fired: false, repeating: evt.repeating || false,
        intervalMinutes: evt.intervalMinutes || null,
        condition: evt.condition || null
      };
      // Resolve offset if clock is running
      if (newEvt.offsetMinutes != null && !newEvt.gameTime && this.gameTime) {
        newEvt.gameTime = new Date(this.gameTime.getTime() + newEvt.offsetMinutes * 60000);
      }
      this.timedEvents.push(newEvt);
      res.json({ ok: true, eventId: evt.id });
    });
  }
}

module.exports = WorldClockService;
