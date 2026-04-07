/**
 * stamina-service.js — Stamina & Fatigue System
 * Tracks per-player stamina with states: fresh/winded/exhausted/spent/collapsed.
 * Drains based on combat actions, armor, and wound state.
 * Recovery via rest, catch breath, and healing.
 */

// Stamina states by percentage of max
const STAMINA_STATES = {
  FRESH: 'fresh',         // 75-100%
  WINDED: 'winded',       // 50-75%
  EXHAUSTED: 'exhausted', // 25-50%
  SPENT: 'spent',         // 1-25%
  COLLAPSED: 'collapsed'  // 0
};

// Action stamina costs
const ACTION_COSTS = {
  single_attack: 8,
  multiattack: 14,
  dash: 12,
  leveled_spell: 6, // per spell level
  cantrip: 4,
  dodge: 3,
  disengage: 6,
  hold: 2
};

// Armor drain per round
const ARMOR_DRAIN = {
  none: 0, light: 1, medium: 3, heavy: 6, shield: 2
};

// Wound drain per round per wounded limb
const WOUND_DRAIN = {
  0: 0, 1: 2, 2: 5, 3: 10, 4: 15
};

// Monster stamina profiles
const MONSTER_PROFILES = {
  normal: 'normal',
  endless: 'endless',
  double: 'double',
  none: 'none'
};

class StaminaService {
  constructor() {
    this.name = 'stamina';
    this.orchestrator = null;
  }

  async init(orchestrator) {
    this.orchestrator = orchestrator;
    this.bus = orchestrator.bus;
    this.state = orchestrator.state;
    this.config = orchestrator.config;
  }

  async start() {
    this._setupEventListeners();
    this._setupRoutes();
    this._initAllPlayers();
    console.log('[Stamina] Ready');

    // Delayed re-init: other services may not have loaded character data yet
    setTimeout(() => {
      console.log('[PLAYERS]', JSON.stringify(Object.keys(this.state.get('players') || {})));
      this._initAllPlayers();
    }, 2000);
  }

  async stop() {}

  getStatus() {
    const players = this.state.get('players') || {};
    let tracked = 0;
    for (const p of Object.values(players)) {
      if (p.stamina) tracked++;
    }
    return { status: 'running', playersTracked: tracked };
  }

  // ═══════════════════════════════════════════════════════════════
  // INITIALIZATION
  // ═══════════════════════════════════════════════════════════════

  _initAllPlayers() {
    const players = this.state.get('players') || {};
    const ids = Object.keys(players);
    console.log(`[Stamina] Scanning ${ids.length} player(s) for stamina init: ${ids.join(', ') || '(none)'}`);
    let inited = 0;
    for (const [playerId, player] of Object.entries(players)) {
      const hasChar = player.character && Object.keys(player.character).length > 0;
      if (!hasChar) {
        console.log(`[Stamina]   ${playerId}: no character data, skipping`);
        continue;
      }
      this._initStamina(playerId);
      const stam = this.state.get(`players.${playerId}.stamina`);
      if (stam) {
        inited++;
        this.bus.dispatch('stamina:updated', {
          playerId, current: stam.current, max: stam.max, state: stam.state, reason: 'init'
        });
        console.log('[STAMINA-INIT]', playerId, stam);
      } else {
        console.warn(`[Stamina]   ${playerId}: character found but stamina init failed`);
      }
    }
    console.log(`[Stamina] Initialized stamina for ${inited} player(s)`);
  }

  _initStamina(playerId) {
    const existing = this.state.get(`players.${playerId}.stamina`);
    if (existing && existing.max > 0 && existing.current >= 0) return;

    const char = this.state.get(`players.${playerId}.character`);
    if (!char || !char.abilities) return;

    const conScore = char.abilities?.con?.score || 10;
    const conMod = Math.floor((conScore - 10) / 2);
    const max = 50 + (conMod * 10);

    const stam = { max, current: max, state: STAMINA_STATES.FRESH, conMod };
    this.state.set(`players.${playerId}.stamina`, stam);

    this.bus.dispatch('stamina:updated', {
      playerId, current: stam.current, max: stam.max, state: stam.state, reason: 'character_loaded'
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // CORE METHODS
  // ═══════════════════════════════════════════════════════════════

  getStamina(playerId) {
    return this.state.get(`players.${playerId}.stamina`) || null;
  }

  /**
   * Drain stamina by amount. Returns new stamina state.
   */
  drain(playerId, amount, reason) {
    const stam = this.state.get(`players.${playerId}.stamina`);
    if (!stam) return null;

    const oldState = stam.state;
    stam.current = Math.max(0, stam.current - amount);
    stam.state = this._calcState(stam.current, stam.max);
    this.state.set(`players.${playerId}.stamina`, stam);

    if (stam.state !== oldState) {
      this.bus.dispatch('stamina:tier_change', {
        playerId, state: stam.state, oldState, current: stam.current, max: stam.max,
        charName: this.state.get(`players.${playerId}.character.name`) || playerId
      });
    }

    this.bus.dispatch('stamina:updated', {
      playerId, current: stam.current, max: stam.max, state: stam.state, reason
    });

    return stam;
  }

  /**
   * Recover stamina by amount.
   */
  recover(playerId, amount, reason) {
    const stam = this.state.get(`players.${playerId}.stamina`);
    if (!stam) return null;

    const oldState = stam.state;
    stam.current = Math.min(stam.max, stam.current + amount);
    stam.state = this._calcState(stam.current, stam.max);
    this.state.set(`players.${playerId}.stamina`, stam);

    if (stam.state !== oldState) {
      this.bus.dispatch('stamina:tier_change', {
        playerId, state: stam.state, oldState, current: stam.current, max: stam.max,
        charName: this.state.get(`players.${playerId}.character.name`) || playerId
      });
    }

    this.bus.dispatch('stamina:updated', {
      playerId, current: stam.current, max: stam.max, state: stam.state, reason
    });

    return stam;
  }

  /**
   * Catch your breath — full action in combat: +25% of max
   */
  catchBreath(playerId) {
    const stam = this.state.get(`players.${playerId}.stamina`);
    if (!stam) return null;
    return this.recover(playerId, Math.floor(stam.max * 0.25), 'catch_breath');
  }

  /**
   * Second Wind: +20% stamina on top of HP recovery
   */
  secondWind(playerId) {
    const stam = this.state.get(`players.${playerId}.stamina`);
    if (!stam) return null;
    return this.recover(playerId, Math.floor(stam.max * 0.20), 'second_wind');
  }

  /**
   * Healing Word / Aid: +15% stamina on top of HP
   */
  healingBoost(playerId) {
    const stam = this.state.get(`players.${playerId}.stamina`);
    if (!stam) return null;
    return this.recover(playerId, Math.floor(stam.max * 0.15), 'healing_boost');
  }

  /**
   * Short rest: CON mod × 5 per hour
   */
  shortRest(playerId, hours = 1) {
    const stam = this.state.get(`players.${playerId}.stamina`);
    if (!stam) return null;
    const amount = Math.max(5, stam.conMod * 5) * hours;
    return this.recover(playerId, amount, 'short_rest');
  }

  /**
   * Long rest: full recovery
   */
  longRest(playerId) {
    const stam = this.state.get(`players.${playerId}.stamina`);
    if (!stam) return null;
    stam.current = stam.max;
    stam.state = STAMINA_STATES.FRESH;
    this.state.set(`players.${playerId}.stamina`, stam);
    this.bus.dispatch('stamina:updated', {
      playerId, current: stam.current, max: stam.max, state: stam.state, reason: 'long_rest'
    });
    return stam;
  }

  /**
   * Forced state set (DM override)
   */
  setStaminaState(playerId, targetState) {
    const stam = this.state.get(`players.${playerId}.stamina`);
    if (!stam) return null;

    const stateThresholds = {
      fresh: 0.80, winded: 0.60, exhausted: 0.35, spent: 0.12, collapsed: 0
    };
    stam.current = Math.round(stam.max * (stateThresholds[targetState] || 0.80));
    if (targetState === 'collapsed') stam.current = 0;
    stam.state = targetState;
    this.state.set(`players.${playerId}.stamina`, stam);

    this.bus.dispatch('stamina:updated', {
      playerId, current: stam.current, max: stam.max, state: stam.state, reason: 'dm_override'
    });
    return stam;
  }

  // ═══════════════════════════════════════════════════════════════
  // COMBAT ROUND DRAIN
  // ═══════════════════════════════════════════════════════════════

  /**
   * Calculate total stamina drain for a combat round.
   * Called at end of each combatant's turn.
   */
  calcRoundDrain(playerId, actionType, spellLevel = 0) {
    const char = this.state.get(`players.${playerId}.character`);
    if (!char) return 0;

    let drain = 0;

    // Action cost
    if (actionType === 'leveled_spell' && spellLevel > 0) {
      drain += ACTION_COSTS.leveled_spell * spellLevel;
    } else {
      drain += ACTION_COSTS[actionType] || ACTION_COSTS.hold;
    }

    // Armor drain
    const armorType = this._getArmorType(char);
    drain += ARMOR_DRAIN[armorType] || 0;

    // Shield drain
    const hasShield = (char.inventory || []).some(i => i.equipped && i.acType === 'shield');
    if (hasShield) drain += ARMOR_DRAIN.shield;

    // Wound drain
    const wounds = this.state.get(`players.${playerId}.wounds`) || {};
    for (const [, tier] of Object.entries(wounds)) {
      drain += WOUND_DRAIN[tier] || 0;
    }

    return drain;
  }

  /**
   * Apply combat round drain.
   */
  applyCombatDrain(playerId, actionType, spellLevel = 0) {
    const drain = this.calcRoundDrain(playerId, actionType, spellLevel);
    if (drain > 0) {
      return this.drain(playerId, drain, `combat_${actionType}`);
    }
    return this.getStamina(playerId);
  }

  // ═══════════════════════════════════════════════════════════════
  // NPC STAMINA
  // ═══════════════════════════════════════════════════════════════

  initNpcStamina(npcId, conScore, profile = 'normal') {
    if (profile === 'none' || profile === 'endless') return;

    const conMod = Math.floor((conScore - 10) / 2);
    let max = 50 + (conMod * 10);
    if (profile === 'double') max *= 2;

    this.state.set(`npcs.${npcId}.stamina`, {
      max, current: max, state: STAMINA_STATES.FRESH, conMod, profile
    });
  }

  drainNpc(npcId, amount, reason) {
    const stam = this.state.get(`npcs.${npcId}.stamina`);
    if (!stam || stam.profile === 'endless') return null;

    stam.current = Math.max(0, stam.current - amount);
    stam.state = this._calcState(stam.current, stam.max);
    this.state.set(`npcs.${npcId}.stamina`, stam);
    return stam;
  }

  // ═══════════════════════════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════════════════════════

  /**
   * Resolve a playerId — accepts exact key, or case-insensitive name match
   */
  _resolvePlayerId(input) {
    const players = this.state.get('players') || {};
    // Exact match first
    if (players[input]) return input;
    // Case-insensitive name search
    const lower = input.toLowerCase();
    for (const [id, p] of Object.entries(players)) {
      const charName = (p.character?.name || '').toLowerCase();
      const playerName = (p.name || '').toLowerCase();
      if (charName.includes(lower) || playerName.includes(lower) || id.toLowerCase() === lower) {
        return id;
      }
    }
    return input; // fallback to original
  }

  _calcState(current, max) {
    if (current <= 0) return STAMINA_STATES.COLLAPSED;
    const pct = current / max;
    if (pct >= 0.75) return STAMINA_STATES.FRESH;
    if (pct >= 0.50) return STAMINA_STATES.WINDED;
    if (pct >= 0.25) return STAMINA_STATES.EXHAUSTED;
    return STAMINA_STATES.SPENT;
  }

  _getArmorType(char) {
    const equipped = (char.inventory || []).filter(i => i.equipped);
    const armor = equipped.find(i => i.acType && i.acType !== 'shield');
    if (!armor) return 'none';
    return armor.acType || 'none';
  }

  // ═══════════════════════════════════════════════════════════════
  // EVENT LISTENERS
  // ═══════════════════════════════════════════════════════════════

  _setupEventListeners() {
    // Init stamina when characters load or sync
    this.bus.subscribe('characters:loaded', () => this._initAllPlayers(), 'stamina');
    this.bus.subscribe('characters:reloaded', () => this._initAllPlayers(), 'stamina');
    this.bus.subscribe('characters:ddb_synced', () => this._initAllPlayers(), 'stamina');
    this.bus.subscribe('characters:imported', () => this._initAllPlayers(), 'stamina');

    // HP changes may indicate a new character or updated stats
    this.bus.subscribe('hp:update', (env) => {
      const playerId = env.data?.playerId;
      if (playerId) this._initStamina(playerId);
    }, 'stamina');

    // Combat turn end → drain stamina for the combatant who just acted
    this.bus.subscribe('combat:next_turn', (env) => {
      const combat = this.state.get('combat');
      if (!combat?.active) return;
      // The turn just ended for the PREVIOUS combatant
      // We apply a default 'hold' drain; specific actions override via explicit calls
      const prev = env.data.combatant;
      if (prev && prev.type === 'pc') {
        const stam = this.getStamina(prev.id);
        if (stam && !stam._drainedThisTurn) {
          // Default drain if no specific action was recorded
          this.applyCombatDrain(prev.id, 'hold');
        }
        // Reset flag
        if (stam) {
          stam._drainedThisTurn = false;
          this.state.set(`players.${prev.id}.stamina._drainedThisTurn`, false);
        }
      }
    }, 'stamina');

    // Player attack → drain for attack action
    this.bus.subscribe('player:roll', (env) => {
      const { playerId, rollType } = env.data;
      if (!playerId || rollType !== 'attack') return;
      const stam = this.getStamina(playerId);
      if (!stam) return;
      this.applyCombatDrain(playerId, 'single_attack');
      this.state.set(`players.${playerId}.stamina._drainedThisTurn`, true);
    }, 'stamina');

    // Spell cast → drain for spell action
    this.bus.subscribe('player:roll', (env) => {
      const { playerId, rollType, spellLevel } = env.data;
      if (!playerId || rollType !== 'spell') return;
      const stam = this.getStamina(playerId);
      if (!stam) return;
      const level = spellLevel || 0;
      this.applyCombatDrain(playerId, level > 0 ? 'leveled_spell' : 'cantrip', level);
      this.state.set(`players.${playerId}.stamina._drainedThisTurn`, true);
    }, 'stamina-spells');

    // Bleeding drain: 4 extra stamina per round
    this.bus.subscribe('combat:bleeding_tick', (env) => {
      const { playerId } = env.data;
      if (playerId) this.drain(playerId, 4, 'bleeding');
    }, 'stamina');

    // Massive damage shock → immediate 20 drain on successful save
    this.bus.subscribe('combat:shock_save_passed', (env) => {
      const { playerId } = env.data;
      if (playerId) this.drain(playerId, 20, 'shock_adrenaline');
    }, 'stamina');
  }

  // ═══════════════════════════════════════════════════════════════
  // ROUTES
  // ═══════════════════════════════════════════════════════════════

  _setupRoutes() {
    const app = this.orchestrator.getService('dashboard')?.app;
    if (!app) {
      console.error('[Stamina] Dashboard app not available — routes NOT registered');
      return;
    }
    console.log('[Stamina] Registering API routes on dashboard app');

    app.get('/api/stamina/:playerId', (req, res) => {
      const id = this._resolvePlayerId(req.params.playerId);
      const stam = this.getStamina(id);
      if (!stam) return res.status(404).json({ error: 'No stamina data', resolvedId: id });
      res.json(stam);
    });

    app.put('/api/stamina/:playerId', (req, res) => {
      const id = this._resolvePlayerId(req.params.playerId);
      const { delta, action, spellLevel, targetState } = req.body;
      if (targetState) {
        const result = this.setStaminaState(id, targetState);
        return res.json({ ok: !!result, stamina: result });
      }
      if (action) {
        const result = this.applyCombatDrain(id, action, spellLevel || 0);
        return res.json({ ok: !!result, stamina: result });
      }
      if (typeof delta === 'number') {
        const result = delta < 0
          ? this.drain(id, Math.abs(delta), 'manual')
          : this.recover(id, delta, 'manual');
        return res.json({ ok: !!result, stamina: result });
      }
      res.status(400).json({ error: 'delta, action, or targetState required' });
    });

    app.post('/api/stamina/:playerId/catch-breath', (req, res) => {
      const id = this._resolvePlayerId(req.params.playerId);
      const result = this.catchBreath(id);
      res.json({ ok: !!result, stamina: result });
    });

    app.post('/api/stamina/:playerId/short-rest', (req, res) => {
      const id = this._resolvePlayerId(req.params.playerId);
      const hours = req.body.hours || 1;
      const result = this.shortRest(id, hours);
      res.json({ ok: !!result, stamina: result });
    });

    app.post('/api/stamina/:playerId/long-rest', (req, res) => {
      const id = this._resolvePlayerId(req.params.playerId);
      const result = this.longRest(id);
      res.json({ ok: !!result, stamina: result });
    });
  }
}

module.exports = StaminaService;
