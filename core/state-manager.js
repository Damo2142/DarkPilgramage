const fs = require('fs');
const path = require('path');

class StateManager {
  constructor(bus, config) {
    this.bus = bus;
    this.config = config;
    this._state = this._defaultState();
    this._snapshotTimer = null;
  }

  _defaultState() {
    return {
      session: {
        id: null,
        date: null,
        startTime: null,
        elapsedMs: 0,
        status: 'idle', // idle | prep | active | paused | ended
        aiTrustLevel: 'manual' // manual | assisted | autopilot
      },
      scene: {
        id: null,
        name: null,
        foundrySceneId: null,
        atmosphereProfile: 'default',
        weather: 'clear',
        timeOfDay: 'night',
        description: ''
      },
      players: {},
      npcs: {},
      story: {
        currentAct: null,
        beats: [],
        cluesDiscovered: [],
        decisions: []
      },
      atmosphere: {
        currentProfile: 'default',
        lights: {},
        audio: {
          ambient: null,
          music: null,
          volume: { ambient: 0.6, music: 0.3, effects: 0.8 }
        },
        activeEffects: []
      },
      combat: {
        active: false,
        round: 0,
        turnOrder: [],
        currentTurn: null
      },
      map: {
        id: null,
        name: null,
        image: null,
        gridSize: 70,
        width: 0,
        height: 0,
        zones: [],
        tokens: {}
      }
    };
  }

  /**
   * Get a value from state by dot-notation path
   * e.g., get('players.player1.dread.score')
   */
  get(dotPath) {
    if (!dotPath) return this._state;
    return dotPath.split('.').reduce((obj, key) => obj?.[key], this._state);
  }

  /**
   * Set a value in state by dot-notation path, dispatch change event
   */
  set(dotPath, value) {
    const keys = dotPath.split('.');
    const last = keys.pop();
    const target = keys.reduce((obj, key) => {
      if (obj[key] === undefined) obj[key] = {};
      return obj[key];
    }, this._state);

    const oldValue = target[last];
    target[last] = value;

    this.bus.dispatch('state:change', { path: dotPath, value, oldValue });
    return value;
  }

  /**
   * Deep merge an object into state at a given path
   */
  merge(dotPath, obj) {
    const current = this.get(dotPath) || {};
    const merged = { ...current, ...obj };
    this.set(dotPath, merged);
    return merged;
  }

  /**
   * Get full state snapshot
   */
  snapshot() {
    return JSON.parse(JSON.stringify(this._state));
  }

  /**
   * Load state from a session config file
   */
  loadSession(sessionConfig) {
    if (sessionConfig.players) {
      this._state.players = sessionConfig.players;
    }
    if (sessionConfig.npcs) {
      this._state.npcs = sessionConfig.npcs;
    }
    if (sessionConfig.story) {
      this._state.story = { ...this._state.story, ...sessionConfig.story };
    }
    if (sessionConfig.scene) {
      this._state.scene = { ...this._state.scene, ...sessionConfig.scene };
    }
    if (sessionConfig.atmosphere) {
      this._state.atmosphere = { ...this._state.atmosphere, ...sessionConfig.atmosphere };
    }

    this.bus.dispatch('state:session_loaded', { config: sessionConfig });
    console.log('[StateManager] Session config loaded');
  }

  /**
   * Start a new session
   */
  startSession() {
    const now = new Date();
    const sessionId = `session-${now.toISOString().slice(0, 10)}-${now.getTime().toString(36)}`;

    this.set('session.id', sessionId);
    this.set('session.date', now.toISOString().slice(0, 10));
    this.set('session.startTime', now.toISOString());
    this.set('session.status', 'active');

    // Start elapsed time tracking
    this._elapsedInterval = setInterval(() => {
      if (this.get('session.status') === 'active') {
        const start = new Date(this.get('session.startTime'));
        this._state.session.elapsedMs = Date.now() - start.getTime();
      }
    }, 1000);

    // Start periodic snapshots
    const snapshotInterval = this.config?.session?.stateSnapshotIntervalMs || 60000;
    this._snapshotTimer = setInterval(() => this._saveSnapshot(), snapshotInterval);

    this.bus.dispatch('session:started', { sessionId });
    console.log(`[StateManager] Session started: ${sessionId}`);
    return sessionId;
  }

  pauseSession() {
    this.set('session.status', 'paused');
    this.bus.dispatch('session:paused', {});
  }

  resumeSession() {
    this.set('session.status', 'active');
    this.bus.dispatch('session:resumed', {});
  }

  endSession() {
    this.set('session.status', 'ended');
    this._saveSnapshot();

    if (this._elapsedInterval) clearInterval(this._elapsedInterval);
    if (this._snapshotTimer) clearInterval(this._snapshotTimer);

    this.bus.dispatch('session:ended', {
      sessionId: this.get('session.id'),
      duration: this.get('session.elapsedMs')
    });
    console.log(`[StateManager] Session ended: ${this.get('session.id')}`);
  }

  /**
   * Add or update a player
   */
  setPlayer(playerId, playerData) {
    this.set(`players.${playerId}`, {
      name: playerData.name || playerId,
      character: playerData.character || {},
      dread: {
        score: 0,
        threshold: 'calm',
        activeEffects: [],
        lastCheck: null,
        ...(playerData.dread || {})
      },
      deviceId: playerData.deviceId || null,
      connected: false,
      ...(playerData)
    });
  }

  /**
   * Update player Dread score and calculate threshold
   */
  updateDread(playerId, newScore) {
    const clamped = Math.max(0, Math.min(100, newScore));
    let threshold = 'calm';
    if (clamped >= 80) threshold = 'broken';
    else if (clamped >= 60) threshold = 'terrified';
    else if (clamped >= 40) threshold = 'frightened';
    else if (clamped >= 20) threshold = 'uneasy';

    this.set(`players.${playerId}.dread.score`, clamped);
    this.set(`players.${playerId}.dread.threshold`, threshold);
    this.set(`players.${playerId}.dread.lastCheck`, Date.now());

    this.bus.dispatch('dread:update', {
      playerId,
      score: clamped,
      threshold,
      previous: this.get(`players.${playerId}.dread.score`)
    });

    return { score: clamped, threshold };
  }

  _saveSnapshot() {
    const sessionId = this.get('session.id');
    if (!sessionId) return;

    const logDir = this.config?.session?.logDir || './sessions';
    const sessionDir = path.join(logDir, this.get('session.date'));
    const snapshotDir = path.join(sessionDir, 'state-snapshots');

    try {
      fs.mkdirSync(snapshotDir, { recursive: true });
      const filename = `snapshot-${Date.now()}.json`;
      fs.writeFileSync(
        path.join(snapshotDir, filename),
        JSON.stringify(this.snapshot(), null, 2)
      );
    } catch (err) {
      console.error('[StateManager] Snapshot save failed:', err.message);
    }
  }
}

module.exports = StateManager;
