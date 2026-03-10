/**
 * combat-service.js — Initiative & Combat Tracker
 * Build 8: Turn-order tracker, initiative rolling, conditions, HP tracking
 * Mounts routes on dashboard service's Express app.
 */

const D20_CONDITIONS = [
  'blinded', 'charmed', 'deafened', 'frightened', 'grappled',
  'incapacitated', 'invisible', 'paralyzed', 'petrified', 'poisoned',
  'prone', 'restrained', 'stunned', 'unconscious', 'exhaustion',
  'concentrating'
];

class CombatService {
  constructor() {
    this.name = 'combat';
    this.orchestrator = null;
  }

  async init(orchestrator) {
    this.orchestrator = orchestrator;
    this.bus = orchestrator.bus;
    this.state = orchestrator.state;
    this.config = orchestrator.config;
  }

  async start() {
    this._setupRoutes();
    this._setupEventListeners();
    console.log('[CombatService] Ready');
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  _rollD20() {
    return Math.floor(Math.random() * 20) + 1;
  }

  _getInitMod(combatant) {
    // PC: look up character data in state
    if (combatant.type === 'pc') {
      const charData = this.state.get(`players.${combatant.id}.character`);
      if (charData?.initiative !== undefined) return charData.initiative;
      if (charData?.abilities?.dex?.modifier !== undefined) return charData.abilities.dex.modifier;
      return 0;
    }
    // NPC: check actor data from map service custom actors, or use dexterity score
    const mapSvc = this.orchestrator.getService('map');
    if (mapSvc && combatant.actorSlug) {
      const actor = mapSvc.customActors?.get(combatant.actorSlug);
      if (actor) {
        if (actor.dexterity !== undefined) return Math.floor((actor.dexterity - 10) / 2);
      }
    }
    // Fallback: use dexterity from combatant data if present
    if (combatant.dexMod !== undefined) return combatant.dexMod;
    if (combatant.dexterity !== undefined) return Math.floor((combatant.dexterity - 10) / 2);
    return 0;
  }

  _getCombatState() {
    return this.state.get('combat') || { active: false, round: 0, turnOrder: [], currentTurn: null };
  }

  _setCombatState(combat) {
    this.state.set('combat', combat);
  }

  _broadcastCombat(eventName, extra = {}) {
    const combat = this._getCombatState();
    this.bus.dispatch(eventName, { combat, ...extra });
  }

  // ── Core Combat Methods ────────────────────────────────────────────────

  /**
   * Start combat with a list of combatant IDs (tokens on the map)
   * body: { combatantIds: ['vladislav', 'player1', ...], manualInit: { vladislav: 15 } }
   */
  startCombat(combatantIds, manualInit = {}) {
    const tokens = this.state.get('map.tokens') || {};
    const combatants = [];

    for (const id of combatantIds) {
      const token = tokens[id];
      if (!token) continue;

      const initMod = this._getInitMod({ ...token, id });
      const roll = this._rollD20();
      const manualVal = manualInit[id];
      const total = manualVal !== undefined ? manualVal : roll + initMod;

      combatants.push({
        id,
        name: token.name || id,
        type: token.type || 'npc',
        initiative: total,
        initRoll: roll,
        initMod,
        hp: { ...(token.hp || { current: 10, max: 10 }) },
        ac: token.ac || 10,
        conditions: [],
        actorSlug: token.actorSlug || token.slug || null,
        isAlive: true,
        deathSaves: { successes: 0, failures: 0 }
      });
    }

    // Sort: highest initiative first; on tie, higher DEX mod wins; still tied, alphabetical
    combatants.sort((a, b) => {
      if (b.initiative !== a.initiative) return b.initiative - a.initiative;
      if (b.initMod !== a.initMod) return b.initMod - a.initMod;
      return a.name.localeCompare(b.name);
    });

    const combat = {
      active: true,
      round: 1,
      turnOrder: combatants,
      currentTurn: combatants.length > 0 ? 0 : null,
      turnHistory: []
    };

    this._setCombatState(combat);
    this._broadcastCombat('combat:started');
    console.log(`[CombatService] Combat started with ${combatants.length} combatants. Round 1.`);
    return combat;
  }

  endCombat() {
    const combat = {
      active: false,
      round: 0,
      turnOrder: [],
      currentTurn: null,
      turnHistory: []
    };
    this._setCombatState(combat);
    this._broadcastCombat('combat:ended');
    console.log('[CombatService] Combat ended.');
    return combat;
  }

  nextTurn() {
    const combat = this._getCombatState();
    if (!combat.active || combat.turnOrder.length === 0) return combat;

    // Record turn in history
    const currentCombatant = combat.turnOrder[combat.currentTurn];
    if (currentCombatant) {
      if (!combat.turnHistory) combat.turnHistory = [];
      combat.turnHistory.push({
        round: combat.round,
        combatantId: currentCombatant.id,
        timestamp: Date.now()
      });

      // Process end-of-turn condition effects (e.g., exhaustion)
      // Future: decay durations, etc.
    }

    // Advance to next alive combatant
    let nextIdx = (combat.currentTurn + 1) % combat.turnOrder.length;
    let loopGuard = 0;
    while (loopGuard < combat.turnOrder.length) {
      if (combat.turnOrder[nextIdx].isAlive) break;
      nextIdx = (nextIdx + 1) % combat.turnOrder.length;
      loopGuard++;
    }

    // Check if we wrapped around to a new round
    if (nextIdx <= combat.currentTurn) {
      combat.round++;
      console.log(`[CombatService] Round ${combat.round}`);
    }

    combat.currentTurn = nextIdx;
    this._setCombatState(combat);
    this._broadcastCombat('combat:next_turn', {
      combatant: combat.turnOrder[nextIdx],
      round: combat.round
    });
    return combat;
  }

  prevTurn() {
    const combat = this._getCombatState();
    if (!combat.active || combat.turnOrder.length === 0) return combat;

    let prevIdx = (combat.currentTurn - 1 + combat.turnOrder.length) % combat.turnOrder.length;
    let loopGuard = 0;
    while (loopGuard < combat.turnOrder.length) {
      if (combat.turnOrder[prevIdx].isAlive) break;
      prevIdx = (prevIdx - 1 + combat.turnOrder.length) % combat.turnOrder.length;
      loopGuard++;
    }

    // Check if we went back a round
    if (prevIdx >= combat.currentTurn && combat.round > 1) {
      combat.round--;
    }

    combat.currentTurn = prevIdx;
    this._setCombatState(combat);
    this._broadcastCombat('combat:prev_turn', { combatant: combat.turnOrder[prevIdx], round: combat.round });
    return combat;
  }

  /**
   * Modify HP for a combatant
   * delta: positive = healing, negative = damage
   */
  modifyHp(combatantId, delta) {
    const combat = this._getCombatState();
    const c = combat.turnOrder.find(x => x.id === combatantId);
    if (!c) return null;

    const oldHp = c.hp.current;
    c.hp.current = Math.max(0, Math.min(c.hp.max, c.hp.current + delta));

    // Mark as dead/unconscious at 0 HP
    if (c.hp.current === 0 && oldHp > 0) {
      if (c.type === 'pc') {
        // PCs go unconscious, not dead
        if (!c.conditions.includes('unconscious')) c.conditions.push('unconscious');
        c.deathSaves = { successes: 0, failures: 0 };
      } else {
        // NPCs die at 0
        c.isAlive = false;
      }
    }

    // Revive if healed from 0
    if (c.hp.current > 0 && oldHp === 0) {
      c.isAlive = true;
      c.conditions = c.conditions.filter(x => x !== 'unconscious');
      c.deathSaves = { successes: 0, failures: 0 };
    }

    this._setCombatState(combat);

    // Sync HP to map token
    const token = this.state.get(`map.tokens.${combatantId}`);
    if (token) {
      this.state.set(`map.tokens.${combatantId}.hp`, { ...c.hp });
    }

    // Sync HP to player state if PC
    if (c.type === 'pc') {
      this.state.set(`players.${combatantId}.character.hp.current`, c.hp.current);
      this.bus.dispatch('hp:update', { playerId: combatantId, current: c.hp.current, max: c.hp.max });
    }

    this._broadcastCombat('combat:hp_changed', {
      combatantId, oldHp, newHp: c.hp.current, delta
    });

    return c;
  }

  /**
   * Update initiative value for a combatant and re-sort
   */
  setInitiative(combatantId, value) {
    const combat = this._getCombatState();
    const c = combat.turnOrder.find(x => x.id === combatantId);
    if (!c) return null;

    c.initiative = value;

    // Remember current combatant
    const currentId = combat.turnOrder[combat.currentTurn]?.id;

    // Re-sort
    combat.turnOrder.sort((a, b) => {
      if (b.initiative !== a.initiative) return b.initiative - a.initiative;
      if (b.initMod !== a.initMod) return b.initMod - a.initMod;
      return a.name.localeCompare(b.name);
    });

    // Restore currentTurn pointer
    combat.currentTurn = combat.turnOrder.findIndex(x => x.id === currentId);
    if (combat.currentTurn === -1) combat.currentTurn = 0;

    this._setCombatState(combat);
    this._broadcastCombat('combat:initiative_changed', { combatantId, initiative: value });
    return combat;
  }

  /**
   * Add or remove a condition on a combatant
   */
  toggleCondition(combatantId, condition) {
    const combat = this._getCombatState();
    const c = combat.turnOrder.find(x => x.id === combatantId);
    if (!c) return null;

    const idx = c.conditions.indexOf(condition);
    if (idx >= 0) {
      c.conditions.splice(idx, 1);
    } else {
      c.conditions.push(condition);
    }

    this._setCombatState(combat);
    this._broadcastCombat('combat:condition_changed', { combatantId, conditions: c.conditions, toggled: condition });
    return c;
  }

  /**
   * Add a combatant mid-combat (e.g., reinforcements)
   */
  addCombatant(tokenId, initiative) {
    const combat = this._getCombatState();
    if (!combat.active) return null;

    const token = this.state.get(`map.tokens.${tokenId}`);
    if (!token) return null;

    // Check if already in combat
    if (combat.turnOrder.some(x => x.id === tokenId)) return null;

    const initMod = this._getInitMod({ ...token, id: tokenId });
    const roll = this._rollD20();
    const total = initiative !== undefined ? initiative : roll + initMod;

    const combatant = {
      id: tokenId,
      name: token.name || tokenId,
      type: token.type || 'npc',
      initiative: total,
      initRoll: roll,
      initMod,
      hp: { ...(token.hp || { current: 10, max: 10 }) },
      ac: token.ac || 10,
      conditions: [],
      actorSlug: token.actorSlug || token.slug || null,
      isAlive: true,
      deathSaves: { successes: 0, failures: 0 }
    };

    // Remember current combatant
    const currentId = combat.turnOrder[combat.currentTurn]?.id;

    combat.turnOrder.push(combatant);
    combat.turnOrder.sort((a, b) => {
      if (b.initiative !== a.initiative) return b.initiative - a.initiative;
      if (b.initMod !== a.initMod) return b.initMod - a.initMod;
      return a.name.localeCompare(b.name);
    });

    // Restore currentTurn pointer
    combat.currentTurn = combat.turnOrder.findIndex(x => x.id === currentId);
    if (combat.currentTurn === -1) combat.currentTurn = 0;

    this._setCombatState(combat);
    this._broadcastCombat('combat:combatant_added', { combatant });
    return combatant;
  }

  /**
   * Remove a combatant from the turn order
   */
  removeCombatant(combatantId) {
    const combat = this._getCombatState();
    const idx = combat.turnOrder.findIndex(x => x.id === combatantId);
    if (idx === -1) return null;

    const currentId = combat.turnOrder[combat.currentTurn]?.id;
    combat.turnOrder.splice(idx, 1);

    if (combat.turnOrder.length === 0) {
      return this.endCombat();
    }

    // Restore currentTurn pointer
    if (combatantId === currentId) {
      combat.currentTurn = Math.min(combat.currentTurn, combat.turnOrder.length - 1);
    } else {
      combat.currentTurn = combat.turnOrder.findIndex(x => x.id === currentId);
      if (combat.currentTurn === -1) combat.currentTurn = 0;
    }

    this._setCombatState(combat);
    this._broadcastCombat('combat:combatant_removed', { combatantId });
    return combat;
  }

  /**
   * Death save for a PC at 0 HP
   * result: 'success' | 'failure' | 'crit_success' | 'crit_failure'
   */
  deathSave(combatantId, result) {
    const combat = this._getCombatState();
    const c = combat.turnOrder.find(x => x.id === combatantId);
    if (!c || c.type !== 'pc' || c.hp.current > 0) return null;

    if (result === 'crit_success') {
      // Nat 20: regain 1 HP, wake up
      c.hp.current = 1;
      c.isAlive = true;
      c.conditions = c.conditions.filter(x => x !== 'unconscious');
      c.deathSaves = { successes: 0, failures: 0 };
    } else if (result === 'crit_failure') {
      // Nat 1: two failures
      c.deathSaves.failures = Math.min(3, c.deathSaves.failures + 2);
    } else if (result === 'success') {
      c.deathSaves.successes = Math.min(3, c.deathSaves.successes + 1);
    } else if (result === 'failure') {
      c.deathSaves.failures = Math.min(3, c.deathSaves.failures + 1);
    }

    // Check stabilized or dead
    if (c.deathSaves.successes >= 3) {
      // Stabilized
      c.deathSaves = { successes: 3, failures: c.deathSaves.failures };
    }
    if (c.deathSaves.failures >= 3) {
      // Dead
      c.isAlive = false;
      c.conditions.push('dead');
    }

    this._setCombatState(combat);

    // Sync HP if revived
    if (c.hp.current > 0) {
      this.state.set(`players.${combatantId}.character.hp.current`, c.hp.current);
      this.bus.dispatch('hp:update', { playerId: combatantId, current: c.hp.current, max: c.hp.max });
    }

    this._broadcastCombat('combat:death_save', { combatantId, result, deathSaves: c.deathSaves });
    return c;
  }

  // ── Attack Processing ─────────────────────────────────────────────────

  /**
   * Parse attack bonus and damage from an action description
   * Handles: "Melee Weapon Attack: +9 to hit... Hit: 8 (1d8 + 4) bludgeoning damage"
   */
  _parseAction(desc) {
    const atkMatch = desc.match(/([+-]\d+)\s*to hit/);
    const dmgMatch = desc.match(/Hit:.*?\((\d+)d(\d+)\s*([+-]\s*\d+)?\)\s*(\w+)/);
    if (!atkMatch || !dmgMatch) return null;
    return {
      toHit: parseInt(atkMatch[1]),
      diceCount: parseInt(dmgMatch[1]),
      diceSize: parseInt(dmgMatch[2]),
      dmgMod: dmgMatch[3] ? parseInt(dmgMatch[3].replace(/\s/g, '')) : 0,
      dmgType: dmgMatch[4]
    };
  }

  /**
   * Roll dice for an NPC action (server-side)
   */
  rollNpcAction(combatantId, actionIndex) {
    const combat = this._getCombatState();
    const c = combat.turnOrder.find(x => x.id === combatantId);
    if (!c || !c.actorSlug) return null;

    const mapSvc = this.orchestrator.getService('map');
    const actor = mapSvc?.customActors?.get(c.actorSlug) || mapSvc?.srdMonsters?.get(c.actorSlug);
    if (!actor?.actions?.[actionIndex]) return null;

    const action = actor.actions[actionIndex];
    const parsed = this._parseAction(action.desc);
    if (!parsed) return { error: 'Cannot parse action', action: action.name, desc: action.desc };

    const d20 = this._rollD20();
    const crit = d20 === 20;
    const miss = d20 === 1;
    const attackRoll = d20 + parsed.toHit;

    const diceCount = crit ? parsed.diceCount * 2 : parsed.diceCount;
    const rolls = Array.from({ length: diceCount }, () => Math.floor(Math.random() * parsed.diceSize) + 1);
    const damage = rolls.reduce((s, r) => s + r, 0) + parsed.dmgMod;

    return {
      combatantId,
      combatantName: c.name,
      actionName: action.name,
      d20,
      toHitBonus: parsed.toHit,
      attackRoll,
      crit,
      fumble: miss,
      damage: Math.max(1, damage),
      damageRolls: rolls,
      dmgMod: parsed.dmgMod,
      dmgType: parsed.dmgType
    };
  }

  /**
   * Process an attack: check hit vs AC, apply damage if hit
   */
  processAttack(attackerId, targetId, attackRoll, damage, damageType, crit = false) {
    const combat = this._getCombatState();
    const attacker = combat.turnOrder.find(x => x.id === attackerId);
    const target = combat.turnOrder.find(x => x.id === targetId);
    if (!attacker || !target) return null;

    const hit = crit || attackRoll >= target.ac;
    let appliedDamage = 0;
    if (hit) {
      appliedDamage = damage;
      this.modifyHp(targetId, -damage);
    }

    const result = {
      attackerId,
      attackerName: attacker.name,
      targetId,
      targetName: target.name,
      attackRoll,
      targetAC: target.ac,
      hit,
      crit,
      damage: appliedDamage,
      damageType: damageType || 'untyped',
      targetHpAfter: this._getCombatState().turnOrder.find(x => x.id === targetId)?.hp
    };

    this.bus.dispatch('combat:attack_result', { ...result, combat: this._getCombatState() });
    return result;
  }

  /**
   * Extract form restriction from action name, e.g. "(Vampire Form Only)" -> ["vampire"]
   */
  _parseFormRestriction(name) {
    const match = name.match(/\(([^)]*form[^)]*)\)/i);
    if (!match) return null;
    const text = match[1].toLowerCase();
    const forms = [];
    if (text.includes('vampire')) forms.push('vampire');
    if (text.includes('bat')) forms.push('bat');
    if (text.includes('wolf')) forms.push('wolf');
    if (text.includes('mist')) forms.push('mist');
    if (text.includes('hybrid')) forms.push('hybrid');
    if (text.includes('humanoid') || text.includes('human')) forms.push('humanoid');
    return forms.length > 0 ? forms : null;
  }

  /**
   * Detect available forms from an actor's abilities and actions
   */
  _detectForms(actor) {
    const forms = new Set();
    const allEntries = [
      ...(actor.actions || []),
      ...(actor.legendary_actions || []),
      ...(actor.special_abilities || [])
    ];
    for (const entry of allEntries) {
      const restriction = this._parseFormRestriction(entry.name);
      if (restriction) restriction.forEach(f => forms.add(f));
      // Also check for Shapechanger ability to detect forms from description
      if (entry.name === 'Shapechanger' && entry.desc) {
        const desc = entry.desc.toLowerCase();
        if (desc.includes('bat')) forms.add('bat');
        if (desc.includes('wolf') && !desc.includes('werewolf')) forms.add('wolf');
        if (desc.includes('mist')) forms.add('mist');
        if (desc.includes('hybrid')) forms.add('hybrid');
        if (desc.includes('humanoid') || desc.includes('human form')) forms.add('humanoid');
        if (desc.includes('vampire')) forms.add('vampire');
      }
    }
    return forms.size > 0 ? Array.from(forms) : null;
  }

  /**
   * Get available actions for a combatant (from actor data)
   * Returns actions, legendary actions, special abilities, and form info
   */
  getActions(combatantId) {
    const combat = this._getCombatState();
    const c = combat.turnOrder.find(x => x.id === combatantId);
    if (!c || !c.actorSlug) return { actions: [], legendaryActions: [], specialAbilities: [], forms: null };

    const mapSvc = this.orchestrator.getService('map');
    const actor = mapSvc?.customActors?.get(c.actorSlug) || mapSvc?.srdMonsters?.get(c.actorSlug);
    if (!actor) return { actions: [], legendaryActions: [], specialAbilities: [], forms: null };

    const mapAction = (a, i) => {
      const parsed = this._parseAction(a.desc);
      return {
        index: i,
        name: a.name,
        desc: a.desc,
        canRoll: !!parsed,
        toHit: parsed?.toHit,
        damageDice: parsed ? `${parsed.diceCount}d${parsed.diceSize}${parsed.dmgMod >= 0 ? '+' : ''}${parsed.dmgMod}` : null,
        dmgType: parsed?.dmgType,
        formRestriction: this._parseFormRestriction(a.name)
      };
    };

    return {
      actions: (actor.actions || []).map(mapAction),
      legendaryActions: (actor.legendary_actions || []).map(mapAction),
      specialAbilities: (actor.special_abilities || []).map((a, i) => ({
        index: i, name: a.name, desc: a.desc,
        formRestriction: this._parseFormRestriction(a.name)
      })),
      forms: this._detectForms(actor)
    };
  }

  // ── Routes ─────────────────────────────────────────────────────────────

  _setupRoutes() {
    const dashboard = this.orchestrator.getService('dashboard');
    if (!dashboard?.app) {
      console.warn('[CombatService] Dashboard not available for route mounting');
      return;
    }
    const app = dashboard.app;

    // GET /api/combat — current combat state
    app.get('/api/combat', (req, res) => {
      res.json(this._getCombatState());
    });

    // GET /api/combat/conditions — list all available conditions
    app.get('/api/combat/conditions', (req, res) => {
      res.json(D20_CONDITIONS);
    });

    // POST /api/combat/start — start combat
    // body: { combatantIds: ['id1','id2'], manualInit: { id1: 15 } }
    app.post('/api/combat/start', (req, res) => {
      const { combatantIds, manualInit } = req.body || {};
      if (!Array.isArray(combatantIds) || combatantIds.length === 0) {
        return res.status(400).json({ error: 'combatantIds array required' });
      }
      const tokens = this.state.get('map.tokens') || {};
      const combat = this.startCombat(combatantIds, manualInit || {});
      res.json(combat);
    });

    // POST /api/combat/end — end combat
    app.post('/api/combat/end', (req, res) => {
      const combat = this.endCombat();
      res.json(combat);
    });

    // POST /api/combat/next — advance to next turn
    app.post('/api/combat/next', (req, res) => {
      const combat = this.nextTurn();
      res.json(combat);
    });

    // POST /api/combat/prev — go back one turn
    app.post('/api/combat/prev', (req, res) => {
      const combat = this.prevTurn();
      res.json(combat);
    });

    // POST /api/combat/hp — modify combatant HP
    // body: { combatantId, delta }
    app.post('/api/combat/hp', (req, res) => {
      const { combatantId, delta } = req.body || {};
      if (!combatantId || typeof delta !== 'number') {
        return res.status(400).json({ error: 'combatantId and delta required' });
      }
      const result = this.modifyHp(combatantId, delta);
      if (!result) return res.status(404).json({ error: 'Combatant not found' });
      res.json(result);
    });

    // POST /api/combat/initiative — set initiative for a combatant
    // body: { combatantId, initiative }
    app.post('/api/combat/initiative', (req, res) => {
      const { combatantId, initiative } = req.body || {};
      if (!combatantId || typeof initiative !== 'number') {
        return res.status(400).json({ error: 'combatantId and initiative required' });
      }
      const result = this.setInitiative(combatantId, initiative);
      if (!result) return res.status(404).json({ error: 'Combatant not found' });
      res.json(result);
    });

    // POST /api/combat/condition — toggle a condition
    // body: { combatantId, condition }
    app.post('/api/combat/condition', (req, res) => {
      const { combatantId, condition } = req.body || {};
      if (!combatantId || !condition) {
        return res.status(400).json({ error: 'combatantId and condition required' });
      }
      if (!D20_CONDITIONS.includes(condition)) {
        return res.status(400).json({ error: `Unknown condition: ${condition}. Valid: ${D20_CONDITIONS.join(', ')}` });
      }
      const result = this.toggleCondition(combatantId, condition);
      if (!result) return res.status(404).json({ error: 'Combatant not found' });
      res.json(result);
    });

    // POST /api/combat/add — add combatant mid-combat
    // body: { tokenId, initiative? }
    app.post('/api/combat/add', (req, res) => {
      const { tokenId, initiative } = req.body || {};
      if (!tokenId) return res.status(400).json({ error: 'tokenId required' });
      const result = this.addCombatant(tokenId, initiative);
      if (!result) return res.status(404).json({ error: 'Token not found or already in combat' });
      res.json(result);
    });

    // POST /api/combat/remove — remove combatant from combat
    // body: { combatantId }
    app.post('/api/combat/remove', (req, res) => {
      const { combatantId } = req.body || {};
      if (!combatantId) return res.status(400).json({ error: 'combatantId required' });
      const result = this.removeCombatant(combatantId);
      if (!result) return res.status(404).json({ error: 'Combatant not found' });
      res.json(result);
    });

    // POST /api/combat/death-save — death saving throw for a PC
    // body: { combatantId, result: 'success'|'failure'|'crit_success'|'crit_failure' }
    app.post('/api/combat/death-save', (req, res) => {
      const { combatantId, result } = req.body || {};
      if (!combatantId || !result) return res.status(400).json({ error: 'combatantId and result required' });
      const validResults = ['success', 'failure', 'crit_success', 'crit_failure'];
      if (!validResults.includes(result)) return res.status(400).json({ error: `result must be one of: ${validResults.join(', ')}` });
      const c = this.deathSave(combatantId, result);
      if (!c) return res.status(404).json({ error: 'Combatant not found or not at 0 HP' });
      res.json(c);
    });

    // NOTE: attack, npc-roll, and actions routes are registered in
    // dashboard-service.js to ensure they're available before server.listen().
  }

  // ── Event Listeners ────────────────────────────────────────────────────

  _setupEventListeners() {
    // When HP changes externally (e.g., player bridge), sync into combat tracker
    this.bus.subscribe('hp:update', (env) => {
      const combat = this._getCombatState();
      if (!combat.active) return;
      const { playerId, current, max } = env.data;
      const c = combat.turnOrder.find(x => x.id === playerId);
      if (c) {
        c.hp.current = current;
        if (max) c.hp.max = max;
        this._setCombatState(combat);
      }
    }, 'combat');

    // When a token is removed from the map, remove from combat
    this.bus.subscribe('map:token_removed', (env) => {
      const combat = this._getCombatState();
      if (!combat.active) return;
      const { tokenId } = env.data;
      if (combat.turnOrder.some(x => x.id === tokenId)) {
        this.removeCombatant(tokenId);
      }
    }, 'combat');
  }

  async stop() {
    console.log('[CombatService] Stopped');
  }

  getStatus() {
    const combat = this._getCombatState();
    return {
      status: 'running',
      combatActive: combat.active,
      round: combat.round,
      combatants: combat.turnOrder?.length || 0,
      currentTurn: combat.currentTurn
    };
  }
}

module.exports = CombatService;
