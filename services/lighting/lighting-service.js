/**
 * Lighting Service — System A
 * Tracks in-game light sources, calculates per-token light levels,
 * applies combat penalties from darkness, integrates with Hubitat via atmosphere engine,
 * and adds weather impact on combat.
 */

class LightingService {
  constructor() {
    this.name = 'lighting';
    this.orchestrator = null;
    this.bus = null;
    this.state = null;

    // Light sources: id -> { id, name, position:{x,y}, brightRadius, dimRadius, fuelType, fuelMinutes, fuelRemaining, state, startTime }
    this.lightSources = new Map();

    // fuelType durations in minutes
    this.FUEL_DURATIONS = {
      candle: 60,
      torch: 360,
      lantern: 360,
      fireplace: Infinity,
      holy_symbol: Infinity
    };
  }

  async init(orchestrator) {
    this.orchestrator = orchestrator;
    this.bus = orchestrator.bus;
    this.state = orchestrator.state;
    this.config = orchestrator.config;

    // Load light sources from session config
    this._loadFromConfig(this.config);
  }

  async start() {
    this._setupRoutes();

    this.bus.subscribe('state:session_reset', () => {
      console.log('[Lighting] Session reset — reloading light sources');
      if (this._fuelInterval) clearInterval(this._fuelInterval);
      this.lightSources = new Map();
      this._loadFromConfig(this.config);
      this._syncToState();
    }, 'lighting');

    this.bus.subscribe('session:started', () => this._onSessionStart(), 'lighting');
    this.bus.subscribe('session:ended', () => this._onSessionEnd(), 'lighting');

    // Listen for timed events that affect lights (e.g. fireplace extinguish at 22:00)
    this.bus.subscribe('world:timed_event', (env) => this._onTimedEvent(env.data), 'lighting');

    // Recalculate on token move
    this.bus.subscribe('state:change', (env) => {
      if (env.data.path && env.data.path.startsWith('map.tokens.')) {
        this._recalculateAllTokenLights();
      }
    }, 'lighting');

    // Combat round — check weather impact
    this.bus.subscribe('combat:next_turn', () => this._checkWeatherCombatEffects(), 'lighting');
    this.bus.subscribe('combat:started', () => this._checkWeatherCombatEffects(), 'lighting');

    // Weather changes
    this.bus.subscribe('world:weather_change', (env) => {
      this._onWeatherChange(env.data);
    }, 'lighting');

    this._syncToState();
    console.log(`[Lighting] ${this.lightSources.size} light source(s) loaded`);
  }

  async stop() {
    if (this._fuelInterval) clearInterval(this._fuelInterval);
  }

  getStatus() {
    const sources = Array.from(this.lightSources.values());
    return {
      status: 'ok',
      totalSources: sources.length,
      litSources: sources.filter(s => s.state === 'lit').length,
      extinguishedSources: sources.filter(s => s.state === 'extinguished').length
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // CONFIG LOADING
  // ═══════════════════════════════════════════════════════════════

  _loadFromConfig(config) {
    const lightConfig = config.lightSources || config.world?.lightSources;
    if (lightConfig && Array.isArray(lightConfig)) {
      for (const ls of lightConfig) {
        this._addLightSource(ls);
      }
    }
  }

  _addLightSource(def) {
    const fuelMinutes = def.fuelMinutes || this.FUEL_DURATIONS[def.fuelType] || 360;
    const source = {
      id: def.id || `light-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: def.name || def.id || 'Light',
      position: def.position || { x: 0, y: 0 },
      brightRadius: def.brightRadius || 20,   // feet
      dimRadius: def.dimRadius || 40,          // feet
      fuelType: def.fuelType || 'torch',
      fuelMinutes: fuelMinutes,
      fuelRemaining: def.fuelRemaining != null ? def.fuelRemaining : fuelMinutes,
      state: def.state || 'lit',               // lit | extinguished | guttering
      startTime: def.startTime || null,        // game time string when lit
      permanent: fuelMinutes === Infinity,
      canExtinguish: def.canExtinguish !== false,
      linkedEvent: def.linkedEvent || null      // timed event that controls this source
    };
    this.lightSources.set(source.id, source);
    return source;
  }

  // ═══════════════════════════════════════════════════════════════
  // SESSION LIFECYCLE
  // ═══════════════════════════════════════════════════════════════

  _onSessionStart() {
    // Start fuel consumption ticker (every 10 seconds of real time)
    this._fuelInterval = setInterval(() => this._tickFuel(), 10000);
    this._recalculateAllTokenLights();
    this._syncToState();
  }

  _onSessionEnd() {
    if (this._fuelInterval) {
      clearInterval(this._fuelInterval);
      this._fuelInterval = null;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // FUEL CONSUMPTION
  // ═══════════════════════════════════════════════════════════════

  _tickFuel() {
    const timeScale = this.state.get('world.timeScale') || 1;
    // 10 real seconds * timeScale = game seconds elapsed
    const gameMinutesElapsed = (10 * timeScale) / 60;

    let changed = false;
    for (const [id, source] of this.lightSources) {
      if (source.state !== 'lit' || source.permanent) continue;

      source.fuelRemaining -= gameMinutesElapsed;

      // Guttering at 10% fuel
      if (source.fuelRemaining <= source.fuelMinutes * 0.1 && source.state === 'lit') {
        source.state = 'guttering';
        changed = true;
        this.bus.dispatch('light:guttering', {
          id: source.id,
          name: source.name,
          fuelRemaining: Math.max(0, source.fuelRemaining)
        });
        this.bus.dispatch('dm:whisper', {
          text: `${source.name} is guttering — less than 10% fuel remaining.`,
          priority: 4,
          category: 'atmosphere'
        });
      }

      // Extinguished at 0 fuel
      if (source.fuelRemaining <= 0) {
        source.fuelRemaining = 0;
        this._extinguishSource(source, 'fuel exhausted');
        changed = true;
      }
    }

    if (changed) {
      this._recalculateAllTokenLights();
      this._syncToState();
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // LIGHT SOURCE CONTROL
  // ═══════════════════════════════════════════════════════════════

  _extinguishSource(source, reason) {
    if (source.state === 'extinguished') return;
    source.state = 'extinguished';
    source.fuelRemaining = Math.max(0, source.fuelRemaining);

    this.bus.dispatch('light:extinguished', {
      id: source.id,
      name: source.name,
      reason: reason || 'manual'
    });

    this.bus.dispatch('dm:whisper', {
      text: `Light extinguished: ${source.name} — ${reason || 'manual'}`,
      priority: 3,
      category: 'atmosphere'
    });

    // If fireplace, trigger Hubitat ambient dim
    if (source.fuelType === 'fireplace') {
      this._fireplaceDimHubitat(reason);
    }

    this._recalculateAllTokenLights();
    this._syncToState();
  }

  _relightSource(sourceId) {
    const source = this.lightSources.get(sourceId);
    if (!source) return null;
    if (source.fuelRemaining <= 0 && !source.permanent) return null;

    source.state = 'lit';
    this.bus.dispatch('light:lit', {
      id: source.id,
      name: source.name
    });

    // If fireplace, restore Hubitat ambient
    if (source.fuelType === 'fireplace') {
      this._fireplaceRestoreHubitat();
    }

    this._recalculateAllTokenLights();
    this._syncToState();
    return source;
  }

  _fireplaceDimHubitat(reason) {
    // Hubitat ambient bulbs (880, 881, 649, 582) dim to 10% over 30 seconds
    const ambientDevices = this.config.lightDevices?.ambient || [880, 881, 649, 582];
    this.bus.dispatch('atmo:light', {
      command: 'setLevel',
      devices: ambientDevices,
      value: 10
    });

    // Also fire a player effect for atmosphere
    this.bus.dispatch('player:horror_effect', {
      playerId: 'all',
      type: 'atmo_tint',
      payload: { color: 'rgba(0,0,0,0.3)' },
      durationMs: 0
    });

    if (reason) {
      this.bus.dispatch('dm:whisper', {
        text: reason,
        priority: 2,
        category: 'atmosphere'
      });
    }
  }

  _fireplaceRestoreHubitat() {
    // Restore atmosphere profile lighting
    const currentProfile = this.state.get('atmosphere.currentProfile');
    if (currentProfile) {
      this.bus.dispatch('atmo:change', {
        profile: currentProfile,
        reason: 'Fireplace re-lit — restoring atmosphere',
        auto: true
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // LIGHT LEVEL CALCULATION
  // ═══════════════════════════════════════════════════════════════

  /**
   * Calculate light level at a given position (in map grid units).
   * Returns 'bright', 'dim', or 'dark'.
   */
  getLightLevelAt(x, y, gridSize) {
    gridSize = gridSize || this.state.get('map.gridSize') || 70;
    const feetPerGrid = 5; // standard D&D 5ft grid

    let bestLevel = 'dark';

    for (const [, source] of this.lightSources) {
      if (source.state === 'extinguished') continue;

      const dx = (x - source.position.x) * feetPerGrid;
      const dy = (y - source.position.y) * feetPerGrid;
      const distFeet = Math.sqrt(dx * dx + dy * dy);

      // Guttering sources have halved radii
      const brightR = source.state === 'guttering' ? source.brightRadius / 2 : source.brightRadius;
      const dimR = source.state === 'guttering' ? source.dimRadius / 2 : source.dimRadius;

      if (distFeet <= brightR) {
        bestLevel = 'bright';
        break; // Can't get brighter
      } else if (distFeet <= dimR && bestLevel !== 'bright') {
        bestLevel = 'dim';
      }
    }

    return bestLevel;
  }

  /**
   * Calculate light level for a specific token, considering darkvision.
   * Returns { rawLevel, effectiveLevel, hasDarkvision, darkvisionRange }
   */
  getTokenLightLevel(tokenId) {
    const tokens = this.state.get('map.tokens') || {};
    const token = tokens[tokenId];
    if (!token) return { rawLevel: 'dark', effectiveLevel: 'dark', hasDarkvision: false };

    const rawLevel = this.getLightLevelAt(token.x, token.y);

    // Check for darkvision from character data
    let darkvisionRange = 0;
    const players = this.state.get('players') || {};
    for (const [playerId, player] of Object.entries(players)) {
      const charName = player.character?.name || '';
      if (charName.toLowerCase() === (token.name || '').toLowerCase() || playerId === tokenId) {
        // Check senses for darkvision — senses can be string, array, or object
        const senses = player.character?.senses || '';
        const sensesStr = typeof senses === 'string' ? senses :
                          Array.isArray(senses) ? senses.join(', ') :
                          JSON.stringify(senses);
        const dvMatch = sensesStr.match(/darkvision\s+(\d+)/i);
        if (dvMatch) {
          darkvisionRange = parseInt(dvMatch[1]);
        }
        // Races with darkvision
        const race = (player.character?.race || '').toLowerCase();
        if (!darkvisionRange && ['elf', 'half-elf', 'dwarf', 'gnome', 'half-orc', 'tiefling', 'drow'].some(r => race.includes(r))) {
          darkvisionRange = 60;
        }
        break;
      }
    }

    // Check NPC actor data for special senses
    const actorSlug = token.actorSlug;
    if (actorSlug) {
      const mapService = this.orchestrator.getService('map');
      if (mapService) {
        const actor = mapService.customActors?.get(actorSlug);
        const actorSenses = actor?.senses || '';
        const actorSensesStr = typeof actorSenses === 'string' ? actorSenses :
                               Array.isArray(actorSenses) ? actorSenses.join(', ') :
                               JSON.stringify(actorSenses);
        if (actorSensesStr) {
          const blindsight = actorSensesStr.match(/blindsight\s+(\d+)/i);
          if (blindsight) {
            return {
              rawLevel,
              effectiveLevel: 'bright',
              hasDarkvision: true,
              darkvisionRange: parseInt(blindsight[1]),
              blindsight: true
            };
          }
          const dvMatch = actorSensesStr.match(/darkvision\s+(\d+)/i);
          if (dvMatch) {
            darkvisionRange = parseInt(dvMatch[1]);
          }
        }
      }
    }

    // Apply darkvision
    let effectiveLevel = rawLevel;
    if (darkvisionRange > 0 && rawLevel === 'dark') {
      effectiveLevel = 'dim'; // Darkvision treats darkness as dim
    }

    return {
      rawLevel,
      effectiveLevel,
      hasDarkvision: darkvisionRange > 0,
      darkvisionRange
    };
  }

  /**
   * Get combat penalties for a token based on lighting.
   * Returns { attackDisadvantage, perceptionAutoFail, reason }
   */
  getCombatPenalties(tokenId) {
    const lightInfo = this.getTokenLightLevel(tokenId);
    const penalties = {
      attackDisadvantage: false,
      perceptionAutoFail: false,
      reason: null,
      lightLevel: lightInfo.effectiveLevel
    };

    if (lightInfo.blindsight) {
      penalties.reason = 'Blindsight — unaffected by darkness';
      return penalties;
    }

    if (lightInfo.effectiveLevel === 'dim' && !lightInfo.hasDarkvision) {
      penalties.attackDisadvantage = true;
      penalties.reason = 'Dim light without darkvision — disadvantage on attacks';
    } else if (lightInfo.effectiveLevel === 'dark') {
      penalties.attackDisadvantage = true;
      penalties.perceptionAutoFail = true;
      penalties.reason = 'Darkness — disadvantage on attacks, perception auto-fails';
    }

    return penalties;
  }

  /**
   * Recalculate light levels for all tokens and update state
   */
  _recalculateAllTokenLights() {
    const tokens = this.state.get('map.tokens') || {};
    const lightLevels = {};

    for (const tokenId of Object.keys(tokens)) {
      const info = this.getTokenLightLevel(tokenId);
      lightLevels[tokenId] = {
        rawLevel: info.rawLevel,
        effectiveLevel: info.effectiveLevel,
        hasDarkvision: info.hasDarkvision,
        darkvisionRange: info.darkvisionRange || 0,
        blindsight: info.blindsight || false
      };
    }

    this.state.set('lighting.tokenLevels', lightLevels);
    this.bus.dispatch('light:updated', { tokenLevels: lightLevels });
  }

  // ═══════════════════════════════════════════════════════════════
  // VLADISLAV SPECIAL HANDLING
  // ═══════════════════════════════════════════════════════════════

  _checkVladislavDarkness(attackerId, targetId) {
    const tokens = this.state.get('map.tokens') || {};
    const attacker = tokens[attackerId];
    const target = tokens[targetId];

    if (!attacker || !target) return;

    // Check if target is Vladislav and someone tried to use darkness
    const isVladislav = (target.name || '').toLowerCase().includes('vladislav') ||
                        target.actorSlug === 'vladislav';

    if (isVladislav) {
      const attackerLight = this.getTokenLightLevel(attackerId);
      if (attackerLight.rawLevel === 'dark') {
        // First time whisper
        const whispered = this.state.get('lighting.vladislavDarknessWhispered');
        if (!whispered) {
          this.bus.dispatch('dm:whisper', {
            text: 'Vladislav sees you perfectly. Darkness is his element. He has blindsight 60ft — he is completely unaffected.',
            priority: 1,
            category: 'story'
          });
          this.state.set('lighting.vladislavDarknessWhispered', true);
        }
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // WEATHER COMBAT EFFECTS
  // ═══════════════════════════════════════════════════════════════

  _onWeatherChange(data) {
    this.state.set('lighting.weather', {
      type: data.current || data.type,
      intensity: data.intensity || 0,
      description: data.description || ''
    });
    this._syncToState();
  }

  _checkWeatherCombatEffects() {
    const weather = this.state.get('world.weather') || this.state.get('lighting.weather') || {};
    const combatActive = this.state.get('combat.active');
    if (!combatActive) return;

    const isStorm = weather.type === 'blizzard' || weather.type === 'storm';
    const intensity = weather.intensity || 0;

    if (!isStorm || intensity < 0.5) return;

    // Storm peak (22:00-04:00): ranged attacks through windows/open doors at disadvantage
    const gameTimeStr = this.state.get('world.gameTime');
    if (gameTimeStr) {
      const gameTime = new Date(gameTimeStr);
      const hour = gameTime.getHours();
      const isPeak = hour >= 22 || hour < 4;

      if (isPeak) {
        this.bus.dispatch('dm:whisper', {
          text: 'STORM PEAK: Ranged attacks through windows or open doors at disadvantage. Perception near open windows at disadvantage. Open doors have 50% chance to extinguish nearest candle or torch.',
          priority: 3,
          category: 'combat'
        });

        // 50% chance to extinguish a candle or torch near open doors
        if (Math.random() < 0.5) {
          for (const [, source] of this.lightSources) {
            if (source.state === 'lit' && (source.fuelType === 'candle' || source.fuelType === 'torch')) {
              this._extinguishSource(source, 'Wind from the storm blows it out');
              break;
            }
          }
        }
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // TIMED EVENT INTEGRATION
  // ═══════════════════════════════════════════════════════════════

  _onTimedEvent(data) {
    // Handle fire_dies_completely event at 22:00
    if (data.id === 'fire_dies_completely' || data.event === 'light:extinguish') {
      const sourceId = data.data?.lightSourceId || data.lightSourceId;
      if (sourceId) {
        const source = this.lightSources.get(sourceId);
        if (source) {
          this._extinguishSource(source, data.data?.reason || 'something draws the warmth from the room');
        }
      } else {
        // If no specific source, extinguish fireplace
        for (const [, source] of this.lightSources) {
          if (source.fuelType === 'fireplace' && source.state !== 'extinguished') {
            this._extinguishSource(source, data.data?.reason || data.data?.text || 'something draws the warmth from the room');
            break;
          }
        }
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // STATE SYNC
  // ═══════════════════════════════════════════════════════════════

  _syncToState() {
    const sources = {};
    for (const [id, s] of this.lightSources) {
      sources[id] = {
        id: s.id,
        name: s.name,
        position: s.position,
        brightRadius: s.brightRadius,
        dimRadius: s.dimRadius,
        fuelType: s.fuelType,
        fuelMinutes: s.fuelMinutes,
        fuelRemaining: Math.max(0, Math.round(s.fuelRemaining * 10) / 10),
        fuelPercent: s.permanent ? 100 : Math.max(0, Math.round((s.fuelRemaining / s.fuelMinutes) * 100)),
        state: s.state,
        permanent: s.permanent,
        canExtinguish: s.canExtinguish
      };
    }
    this.state.set('lighting.sources', sources);

    // Weather icon data
    const weather = this.state.get('world.weather') || {};
    this.state.set('lighting.weather', {
      type: weather.type || 'clear',
      intensity: weather.intensity || 0,
      icon: this._getWeatherIcon(weather.type)
    });
  }

  _getWeatherIcon(type) {
    const icons = {
      clear: '☀',
      cloudy: '☁',
      rain: '🌧',
      storm: '⛈',
      blizzard: '❄',
      fog: '🌫',
      snow: '🌨'
    };
    return icons[type] || '☀';
  }

  // ═══════════════════════════════════════════════════════════════
  // API ROUTES
  // ═══════════════════════════════════════════════════════════════

  _setupRoutes() {
    const app = this.orchestrator.getService('dashboard')?.app;
    if (!app) {
      console.warn('[Lighting] Dashboard not available — routes not registered');
      return;
    }
    this._registerRoutes(app);
  }

  _registerRoutes(app) {
    // GET /api/lighting — all light sources
    app.get('/api/lighting', (req, res) => {
      const sources = Array.from(this.lightSources.values()).map(s => ({
        id: s.id, name: s.name, position: s.position,
        brightRadius: s.brightRadius, dimRadius: s.dimRadius,
        fuelType: s.fuelType, fuelMinutes: s.fuelMinutes,
        fuelRemaining: Math.max(0, Math.round(s.fuelRemaining * 10) / 10),
        fuelPercent: s.permanent ? 100 : Math.max(0, Math.round((s.fuelRemaining / s.fuelMinutes) * 100)),
        state: s.state, permanent: s.permanent
      }));
      res.json({ sources });
    });

    // POST /api/lighting/toggle — toggle a light source on/off
    app.post('/api/lighting/toggle', (req, res) => {
      const { sourceId } = req.body;
      const source = this.lightSources.get(sourceId);
      if (!source) return res.status(404).json({ error: 'Light source not found' });

      if (source.state === 'extinguished') {
        const result = this._relightSource(sourceId);
        if (!result) return res.status(400).json({ error: 'Cannot relight — no fuel remaining' });
        res.json({ ok: true, state: 'lit' });
      } else {
        this._extinguishSource(source, 'manual');
        res.json({ ok: true, state: 'extinguished' });
      }
    });

    // POST /api/lighting/add — add a new light source
    app.post('/api/lighting/add', (req, res) => {
      const { name, position, brightRadius, dimRadius, fuelType, state } = req.body;
      if (!name) return res.status(400).json({ error: 'name required' });
      const source = this._addLightSource({
        name, position: position || { x: 0, y: 0 },
        brightRadius: brightRadius || 20, dimRadius: dimRadius || 40,
        fuelType: fuelType || 'torch', state: state || 'lit'
      });
      this._recalculateAllTokenLights();
      this._syncToState();
      res.json({ ok: true, source: { id: source.id, name: source.name, state: source.state } });
    });

    // POST /api/lighting/remove — remove a light source
    app.post('/api/lighting/remove', (req, res) => {
      const { sourceId } = req.body;
      if (!this.lightSources.has(sourceId)) return res.status(404).json({ error: 'not found' });
      this.lightSources.delete(sourceId);
      this._recalculateAllTokenLights();
      this._syncToState();
      res.json({ ok: true });
    });

    // GET /api/lighting/token/:tokenId — get light level for specific token
    app.get('/api/lighting/token/:tokenId', (req, res) => {
      const info = this.getTokenLightLevel(req.params.tokenId);
      const penalties = this.getCombatPenalties(req.params.tokenId);
      res.json({ ...info, penalties });
    });

    // GET /api/lighting/combat-penalties/:tokenId — combat penalties for token
    app.get('/api/lighting/combat-penalties/:tokenId', (req, res) => {
      res.json(this.getCombatPenalties(req.params.tokenId));
    });
  }
}

module.exports = LightingService;
