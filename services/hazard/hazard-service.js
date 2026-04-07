/**
 * Hazard Service — System E
 * Environmental hazards, per-NPC reputation, and session continuity.
 *
 * Hazard zones: fire, cold, fall — auto-damage on enter, DM warning on adjacent.
 * NPC standing: per-NPC -10 to +10 trust, colors AI dialogue.
 * Session continuity: save/restore wounds, equipment, horror, reputation, stamina.
 */

class HazardService {
  constructor() {
    this.name = 'hazard';
    this.orchestrator = null;
    this.bus = null;
    this.state = null;

    // Hazard zones: id -> definition
    this.hazards = new Map();

    // Per-NPC standing: npcId -> { standing, history[] }
    this.npcStandings = new Map();

    // Session 0 reputation triggers (event -> reputation changes)
    this.reputationTriggers = new Map();
  }

  async init(orchestrator) {
    this.orchestrator = orchestrator;
    this.bus = orchestrator.bus;
    this.state = orchestrator.state;
    this.config = orchestrator.config;

    this._loadFromConfig(this.config);
  }

  async start() {
    this.bus.subscribe('state:session_reset', () => {
      console.log('[Hazard] Session reset — reloading hazards and standings');
      this.hazards = new Map();
      this.npcStandings = new Map();
      this.reputationTriggers = new Map();
      this._loadFromConfig(this.config);
      this._syncToState();
    }, 'hazard');

    // Token movement — check hazard proximity/entry
    this.bus.subscribe('state:change', (env) => {
      if (env.data.path && env.data.path.match(/^map\.tokens\.\w+$/)) {
        this._checkTokenHazards(env.data);
      }
    }, 'hazard');

    // Combat push/forced movement
    this.bus.subscribe('combat:forced_movement', (env) => {
      this._onForcedMovement(env.data);
    }, 'hazard');

    // Session end — save state
    this.bus.subscribe('session:ended', () => this._onSessionEnd(), 'hazard');
    this.bus.subscribe('session:started', () => this._onSessionStart(), 'hazard');

    // Reputation event triggers
    this.bus.subscribe('story:beat', (env) => this._checkReputationTriggers(env.data), 'hazard');
    this.bus.subscribe('world:secret_revealed', (env) => this._checkReputationTriggers(env.data), 'hazard');
    this.bus.subscribe('npc:interaction', (env) => this._onNpcInteraction(env.data), 'hazard');

    this._setupRoutes();
    this._syncToState();

    console.log(`[Hazard] ${this.hazards.size} hazard(s), ${this.npcStandings.size} NPC standing(s) loaded`);
  }

  async stop() {}

  getStatus() {
    return {
      status: 'ok',
      hazards: this.hazards.size,
      npcStandings: this.npcStandings.size,
      activeHazards: Array.from(this.hazards.values()).filter(h => h.active).length
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // CONFIG LOADING
  // ═══════════════════════════════════════════════════════════════

  _loadFromConfig(config) {
    // Load hazards from config
    const hazardConfig = config.hazards || config.world?.hazards;
    if (hazardConfig && Array.isArray(hazardConfig)) {
      for (const h of hazardConfig) {
        this.hazards.set(h.id, {
          id: h.id,
          type: h.type || 'generic',     // fire, cold, fall, generic
          name: h.name || h.id,
          position: h.position || { x: 0, y: 0 },
          radius: h.radius || 1,          // in grid squares
          active: h.active !== false,
          damage: h.damage || '1d6',
          damageType: h.damageType || 'bludgeoning',
          saveType: h.saveType || 'DEX',
          saveDC: h.saveDC || 12,
          description: h.description || '',
          deactivateEvent: h.deactivateEvent || null
        });
      }
    }

    // Load NPC standings
    const npcConfig = config.npcs || {};
    for (const [npcId, npc] of Object.entries(npcConfig)) {
      this.npcStandings.set(npcId, {
        standing: 0,
        name: npc.name || npcId,
        history: []
      });
    }

    // Load reputation triggers from config
    const triggers = config.reputationTriggers || config.world?.reputationTriggers;
    if (triggers && Array.isArray(triggers)) {
      for (const t of triggers) {
        this.reputationTriggers.set(t.id, t);
      }
    }

    // Hazard deactivation on timed events
    this.bus?.subscribe('world:timed_event', (env) => {
      const eventId = env.data.id;
      for (const [, hazard] of this.hazards) {
        if (hazard.deactivateEvent === eventId) {
          hazard.active = false;
          console.log(`[Hazard] ${hazard.name} deactivated by event ${eventId}`);
          this._syncToState();
        }
      }
    }, 'hazard');
  }

  // ═══════════════════════════════════════════════════════════════
  // HAZARD ZONE CHECKS
  // ═══════════════════════════════════════════════════════════════

  _checkTokenHazards(stateChange) {
    const tokenPath = stateChange.path;
    const tokenData = stateChange.value;
    if (!tokenData || !tokenData.x || !tokenData.y) return;

    const tokenId = tokenPath.replace('map.tokens.', '');

    for (const [, hazard] of this.hazards) {
      if (!hazard.active) continue;

      const dx = Math.abs(tokenData.x - hazard.position.x);
      const dy = Math.abs(tokenData.y - hazard.position.y);
      const dist = Math.sqrt(dx * dx + dy * dy);

      // Adjacent warning (within radius + 1)
      if (dist <= hazard.radius + 1 && dist > hazard.radius) {
        this.bus.dispatch('hazard:warning', {
          tokenId,
          hazardId: hazard.id,
          hazardType: hazard.type,
          hazardName: hazard.name
        });
        this.bus.dispatch('dm:whisper', {
          text: `Warning: ${tokenId} approaching ${hazard.name} (${hazard.type}, ${hazard.damage} ${hazard.damageType}, ${hazard.saveType} DC${hazard.saveDC})`,
          priority: 3,
          category: 'hazard'
        });
      }

      // In hazard zone
      if (dist <= hazard.radius) {
        this._applyHazardDamage(tokenId, hazard);
      }
    }
  }

  _onForcedMovement(data) {
    const { tokenId, targetX, targetY } = data;
    if (!tokenId || targetX == null || targetY == null) return;

    for (const [, hazard] of this.hazards) {
      if (!hazard.active) continue;

      const dx = Math.abs(targetX - hazard.position.x);
      const dy = Math.abs(targetY - hazard.position.y);
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist <= hazard.radius) {
        this._applyHazardDamage(tokenId, hazard);
      }
    }
  }

  _applyHazardDamage(tokenId, hazard) {
    // Roll damage
    const damage = this._rollDice(hazard.damage);

    this.bus.dispatch('hazard:damage', {
      tokenId,
      hazardId: hazard.id,
      damage,
      damageType: hazard.damageType,
      saveType: hazard.saveType,
      saveDC: hazard.saveDC
    });

    // Apply HP damage via hp:update
    this.bus.dispatch('hp:update', {
      playerId: tokenId,
      delta: -damage,
      source: `hazard:${hazard.name}`
    });

    this.bus.dispatch('dm:whisper', {
      text: `${tokenId} takes ${damage} ${hazard.damageType} damage from ${hazard.name}!`,
      priority: 2,
      category: 'hazard'
    });

    console.log(`[Hazard] ${tokenId} takes ${damage} ${hazard.damageType} from ${hazard.name}`);
  }

  _rollDice(notation) {
    // Simple dice roller: "1d6", "2d6", "1d6+2"
    const match = notation.match(/(\d+)d(\d+)(?:\+(\d+))?/);
    if (!match) return parseInt(notation) || 0;

    const [, count, sides, bonus] = match;
    let total = 0;
    for (let i = 0; i < parseInt(count); i++) {
      total += Math.floor(Math.random() * parseInt(sides)) + 1;
    }
    return total + (parseInt(bonus) || 0);
  }

  // ═══════════════════════════════════════════════════════════════
  // NPC STANDING
  // ═══════════════════════════════════════════════════════════════

  changeNpcStanding(npcId, delta, reason) {
    let standing = this.npcStandings.get(npcId);
    if (!standing) {
      standing = { standing: 0, name: npcId, history: [] };
      this.npcStandings.set(npcId, standing);
    }

    const old = standing.standing;
    standing.standing = Math.max(-10, Math.min(10, standing.standing + delta));
    standing.history.push({
      delta, reason,
      timestamp: new Date().toISOString(),
      gameTime: this.state.get('world.gameTime')
    });

    this.bus.dispatch('npc:standing_change', {
      npcId,
      npcName: standing.name,
      oldStanding: old,
      newStanding: standing.standing,
      delta,
      reason
    });

    if (Math.abs(delta) >= 3) {
      this.bus.dispatch('dm:whisper', {
        text: `${standing.name} trust: ${old} → ${standing.standing} (${reason})`,
        priority: 3,
        category: 'reputation'
      });
    }

    this._syncToState();
    console.log(`[Hazard] NPC standing ${npcId}: ${old} → ${standing.standing} (${reason})`);
    return standing;
  }

  _onNpcInteraction(data) {
    const { npcId, type, delta, reason } = data;
    if (npcId && delta) {
      this.changeNpcStanding(npcId, delta, reason || type || 'interaction');
    }
  }

  _checkReputationTriggers(data) {
    for (const [, trigger] of this.reputationTriggers) {
      if (trigger.eventId === data.beatId || trigger.eventId === data.secretId) {
        if (trigger.npcStanding) {
          for (const [npcId, delta] of Object.entries(trigger.npcStanding)) {
            this.changeNpcStanding(npcId, delta, trigger.reason || trigger.id);
          }
        }
        if (trigger.factionReputation) {
          for (const [factionId, delta] of Object.entries(trigger.factionReputation)) {
            this.bus.dispatch('campaign:reputation_event', {
              factionId,
              delta,
              reason: trigger.reason || trigger.id
            });
          }
        }
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // SESSION CONTINUITY
  // ═══════════════════════════════════════════════════════════════

  _onSessionEnd() {
    // Compile all state for save
    const saveData = {
      timestamp: new Date().toISOString(),
      gameTime: this.state.get('world.gameTime'),
      players: {},
      npcStandings: {},
      hazards: {}
    };

    // Save per-player state
    const players = this.state.get('players') || {};
    for (const [playerId, player] of Object.entries(players)) {
      saveData.players[playerId] = {
        wounds: player.wounds || {},
        horror: player.horror || 0,
        stamina: player.stamina || {},
        equipment: player.equipment || {},
        character: {
          hp: player.character?.hp || {},
          spellSlots: player.character?.spellSlots || {}
        }
      };
    }

    // Save NPC standings
    for (const [npcId, standing] of this.npcStandings) {
      saveData.npcStandings[npcId] = {
        standing: standing.standing,
        name: standing.name,
        recentHistory: standing.history.slice(-5)
      };
    }

    // Save hazard states
    for (const [id, hazard] of this.hazards) {
      saveData.hazards[id] = { active: hazard.active };
    }

    // Store in state for state-manager to persist
    this.state.set('session.continuity', saveData);

    // Prompt DM about long rest
    this.bus.dispatch('dm:whisper', {
      text: 'Session ended. Did a long rest occur before next session? (Default: Yes after 5 seconds)',
      priority: 1,
      category: 'session'
    });

    // Auto-default to long rest after 5 seconds
    this._longRestTimeout = setTimeout(() => {
      this._applyLongRest();
    }, 5000);

    // Listen for explicit choice
    this.bus.subscribe('session:long_rest_choice', (env) => {
      if (this._longRestTimeout) {
        clearTimeout(this._longRestTimeout);
        this._longRestTimeout = null;
      }
      if (env.data.longRest) {
        this._applyLongRest();
      }
    }, 'hazard');

    // Generate AI session summary
    this._generateSessionSummary();

    console.log('[Hazard] Session continuity data saved');
  }

  _onSessionStart() {
    // Restore continuity data if available
    const continuity = this.state.get('session.continuity');
    if (!continuity) return;

    // Restore NPC standings
    if (continuity.npcStandings) {
      for (const [npcId, data] of Object.entries(continuity.npcStandings)) {
        const standing = this.npcStandings.get(npcId);
        if (standing) {
          standing.standing = data.standing;
        }
      }
    }

    // Restore hazard states
    if (continuity.hazards) {
      for (const [id, data] of Object.entries(continuity.hazards)) {
        const hazard = this.hazards.get(id);
        if (hazard) {
          hazard.active = data.active;
        }
      }
    }

    this._syncToState();
    console.log('[Hazard] Session continuity data restored');
  }

  _applyLongRest() {
    const players = this.state.get('players') || {};

    for (const playerId of Object.keys(players)) {
      // Horror -10
      const horror = this.state.get(`players.${playerId}.horror`) || 0;
      this.state.set(`players.${playerId}.horror`, Math.max(0, horror - 10));

      // Wounds downgrade one tier
      const wounds = this.state.get(`players.${playerId}.wounds`) || {};
      for (const [limb, tier] of Object.entries(wounds)) {
        if (tier > 0) {
          this.state.set(`players.${playerId}.wounds.${limb}`, tier - 1);
        }
      }

      // Equipment: restore one tier (non-broken items)
      const equipment = this.state.get(`players.${playerId}.equipment`) || {};
      if (equipment.equipped) {
        for (const [itemId, item] of Object.entries(equipment.equipped)) {
          if (item.condition > 0 && item.condition < 4) { // Not broken
            this.state.set(`players.${playerId}.equipment.equipped.${itemId}.condition`, item.condition - 1);
          }
        }
      }
    }

    this.bus.dispatch('session:long_rest', {});
    console.log('[Hazard] Long rest applied — horror -10, wounds downgrade, equipment repair');
  }

  async _generateSessionSummary() {
    const aiEngine = this.orchestrator.getService('ai-engine');
    if (!aiEngine?.gemini?.available) return;

    try {
      const stateSnapshot = this.state.snapshot();
      const prompt = `Generate a brief session summary (3-4 sentences) for a D&D session:
Scene: ${stateSnapshot.scene?.name || 'unknown'}
Players: ${Object.keys(stateSnapshot.players || {}).join(', ')}
Game time: ${stateSnapshot.world?.gameTime || 'unknown'}
Generate a narrative summary of what happened. Keep it atmospheric and gothic.`;

      const response = await aiEngine.gemini.generate(
        'You write gothic horror D&D session summaries. Keep them atmospheric and brief.',
        prompt,
        { maxTokens: 200, temperature: 0.8 }
      );

      if (response) {
        // Save to campaign service
        const campaign = this.orchestrator.getService('campaign');
        if (campaign?.addTimelineEntry) {
          campaign.addTimelineEntry({
            title: 'Session Summary',
            description: response.trim(),
            type: 'session_end',
            tags: ['summary']
          });
        }
        console.log(`[Hazard] Session summary generated`);
      }
    } catch (e) {
      console.warn(`[Hazard] Session summary generation failed: ${e.message}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // STATE SYNC
  // ═══════════════════════════════════════════════════════════════

  _syncToState() {
    // Hazards
    const hazardState = {};
    for (const [id, h] of this.hazards) {
      hazardState[id] = {
        id: h.id, type: h.type, name: h.name,
        position: h.position, radius: h.radius,
        active: h.active, damage: h.damage,
        damageType: h.damageType, saveDC: h.saveDC
      };
    }
    this.state.set('hazards', hazardState);

    // NPC standings
    const standings = {};
    for (const [npcId, s] of this.npcStandings) {
      standings[npcId] = {
        standing: s.standing,
        name: s.name,
        recentChanges: s.history.slice(-3)
      };
    }
    this.state.set('npcStandings', standings);
  }

  // ═══════════════════════════════════════════════════════════════
  // API ROUTES
  // ═══════════════════════════════════════════════════════════════

  _setupRoutes() {
    const app = this.orchestrator.getService('dashboard')?.app;
    if (!app) return;

    // GET /api/hazards — all hazard zones
    app.get('/api/hazards', (req, res) => {
      res.json(Array.from(this.hazards.values()));
    });

    // POST /api/hazards/toggle — toggle hazard active state
    app.post('/api/hazards/toggle', (req, res) => {
      const { hazardId } = req.body;
      const hazard = this.hazards.get(hazardId);
      if (!hazard) return res.status(404).json({ error: 'Hazard not found' });
      hazard.active = !hazard.active;
      this._syncToState();
      res.json({ ok: true, active: hazard.active });
    });

    // POST /api/hazards/add — add a hazard zone
    app.post('/api/hazards/add', (req, res) => {
      const h = req.body;
      if (!h.id || !h.type) return res.status(400).json({ error: 'id and type required' });
      this.hazards.set(h.id, {
        id: h.id, type: h.type, name: h.name || h.id,
        position: h.position || { x: 0, y: 0 },
        radius: h.radius || 1, active: h.active !== false,
        damage: h.damage || '1d6', damageType: h.damageType || 'bludgeoning',
        saveType: h.saveType || 'DEX', saveDC: h.saveDC || 12,
        description: h.description || '', deactivateEvent: h.deactivateEvent || null
      });
      this._syncToState();
      res.json({ ok: true });
    });

    // GET /api/npc-standings — all NPC standings
    app.get('/api/npc-standings', (req, res) => {
      const result = {};
      for (const [npcId, s] of this.npcStandings) {
        result[npcId] = { standing: s.standing, name: s.name, history: s.history.slice(-5) };
      }
      res.json(result);
    });

    // POST /api/npc-standings — change NPC standing
    app.post('/api/npc-standings', (req, res) => {
      const { npcId, delta, reason } = req.body;
      if (!npcId || delta == null) return res.status(400).json({ error: 'npcId and delta required' });
      const result = this.changeNpcStanding(npcId, delta, reason || 'manual');
      res.json({ ok: true, standing: result.standing });
    });

    // POST /api/session/long-rest — explicitly set long rest choice
    app.post('/api/session/long-rest', (req, res) => {
      const { longRest } = req.body;
      this.bus.dispatch('session:long_rest_choice', { longRest: longRest !== false });
      res.json({ ok: true });
    });
  }
}

module.exports = HazardService;
