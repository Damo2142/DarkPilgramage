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

    // Scene changes can load new timed events
    this.bus.subscribe('state:change', (env) => {
      if (env.data.path === 'scene.id') {
        this._onSceneChange(env.data.value);
      }
    }, 'world-clock');

    // Story beat completions can trigger branching logic
    this.bus.subscribe('story:beat', (env) => {
      this._evaluateBranches(env.data);
      this._evaluateNpcGoals(env.data);
    }, 'world-clock');

    // Clue discovery
    this.bus.subscribe('clue:found', (env) => this._onClueFound(env.data), 'world-clock');

    // Secret reveal
    this.bus.subscribe('secret:reveal', (env) => this._onSecretReveal(env.data), 'world-clock');

    console.log(`[WorldClock] Ready — ${this.timedEvents.length} timed events, ${this.secrets.size} secrets, ${this.clues.size} clues`);
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
      npcGoals: this.npcGoals.size
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
      branches: Object.fromEntries(Array.from(this.branches.entries()))
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

  _setupRoutes() {
    const app = this.orchestrator.getService('dashboard')?.app;
    if (!app) return;

    // GET /api/world — full world state
    app.get('/api/world', (req, res) => {
      res.json({
        clock: this.getFormattedGameTime(),
        timeScale: this.timeScale,
        paused: this.paused,
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
        }))
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
