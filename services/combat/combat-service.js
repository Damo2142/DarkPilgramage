/**
 * combat-service.js — Initiative & Combat Tracker
 * Build 8: Turn-order tracker, initiative rolling, conditions, HP tracking
 * Mounts routes on dashboard service's Express app.
 *
 * Phase 1 (session0-polish): delegates NPC turn decisions to npc-tactics.js
 * when the NPC has a map position. npc-tactics returns a decision carrying
 * target, action, movement path, and detected opportunity-attack triggers.
 * Fallback to the existing AI / basic path remains unchanged.
 */

const NpcTactics = require('./npc-tactics');

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
   * Resolve a flexible identifier to a map token.
   * Accepts: exact token ID, player ID, character name, NPC name, or actor slug.
   * Returns { tokenId, token } or null.
   */
  _resolveToken(input) {
    const tokens = this.state.get('map.tokens') || {};
    const lower = (input || '').toLowerCase();

    // 1. Exact token ID match
    if (tokens[input]) return { tokenId: input, token: tokens[input] };

    // 2. Search by actor slug, name, or partial match
    for (const [tokenId, token] of Object.entries(tokens)) {
      const slug = (token.actorSlug || '').toLowerCase();
      const name = (token.name || '').toLowerCase();
      if (slug === lower || name === lower || tokenId.toLowerCase().startsWith(lower)) {
        return { tokenId, token };
      }
    }

    // 3. Check player IDs — player may not have a token yet, create from character data
    const players = this.state.get('players') || {};
    if (players[lower] || players[input]) {
      const playerId = players[lower] ? lower : input;
      const player = players[playerId];
      const charName = player?.character?.name || playerId;

      // Try to find token by character name
      for (const [tokenId, token] of Object.entries(tokens)) {
        if ((token.name || '').toLowerCase() === charName.toLowerCase()) {
          return { tokenId, token };
        }
      }

      // No token found — build a virtual combatant from character data
      if (player?.character) {
        const char = player.character;
        const virtualToken = {
          name: char.name || playerId,
          type: 'pc',
          hp: char.hp || { current: 20, max: 20 },
          ac: char.ac || 10,
          actorSlug: playerId,
          _virtual: true
        };
        return { tokenId: playerId, token: virtualToken };
      }
    }

    // 4. Search NPC config from session data
    const npcs = this.state.get('npcs') || {};
    if (npcs[lower] || npcs[input]) {
      const npcId = npcs[lower] ? lower : input;
      const npc = npcs[npcId];
      const npcName = (npc?.name || '').toLowerCase();
      const npcTrueName = (npc?.trueIdentity || npc?.trueName || '').toLowerCase();
      for (const [tokenId, token] of Object.entries(tokens)) {
        const tName = (token.name || '').toLowerCase();
        if (tName === npcName || tName === npcTrueName ||
            tName.includes(npcName) || npcName.includes(tName) ||
            npcTrueName.includes(tName) || tName.includes(npcTrueName.split(' (')[0])) {
          return { tokenId, token };
        }
      }
    }

    // 5. Fuzzy partial match on token names
    for (const [tokenId, token] of Object.entries(tokens)) {
      const tName = (token.name || '').toLowerCase();
      if (tName.includes(lower) || lower.includes(tName.split(' ')[0])) {
        return { tokenId, token };
      }
    }

    return null;
  }

  /**
   * Start combat with a list of combatant identifiers.
   * Accepts any mix of: token IDs, player IDs, character names, NPC names, actor slugs.
   * body: { combatantIds: ['vladislav', 'jerome', 'Tomas Birkov', ...], manualInit: { vladislav: 15 } }
   */
  startCombat(combatantIds, manualInit = {}) {
    const tokens = this.state.get('map.tokens') || {};
    const combatants = [];

    for (const id of combatantIds) {
      const resolved = this._resolveToken(id);
      if (!resolved) {
        console.warn(`[CombatService] Could not resolve combatant: "${id}" — skipping`);
        continue;
      }
      const { tokenId, token } = resolved;

      // Skip absent players — they cannot enter combat
      const playerState = this.state.get('players.' + tokenId);
      if (playerState?.absent || playerState?.notYetArrived) {
        console.log(`[CombatService] Skipping absent/not-yet-arrived player: ${tokenId}`);
        continue;
      }

      const initMod = this._getInitMod({ ...token, id: tokenId });
      const roll = this._rollD20();
      const manualVal = manualInit[id] || manualInit[tokenId];
      const total = manualVal !== undefined ? manualVal : roll + initMod;

      // Pull immunities/resistances from actor config so processAttack can
      // enforce them (werewolf: nonmagical weapons, vampire: poison, etc.)
      const actorSlug = token.actorSlug || token.slug || null;
      let immunities = null, resistances = null;
      if (actorSlug) {
        const mapSvc = this.orchestrator.getService('map');
        const actor = mapSvc?.customActors?.get(actorSlug) || mapSvc?.srdMonsters?.find(m => m.slug === actorSlug);
        if (actor) {
          immunities = actor.immunities || null;
          resistances = actor.resistances || null;
        }
      }

      combatants.push({
        id: tokenId,
        name: token.name || tokenId,
        type: token.type || 'npc',
        initiative: total,
        initRoll: roll,
        initMod,
        hp: this._resolveCombatantHp(token),
        ac: this._resolveCombatantAc(token),
        conditions: [],
        actorSlug,
        immunities,
        resistances,
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
    this.bus.dispatch('dm:whisper', {
      text: 'Combat begins.',
      priority: 1, category: 'combat'
    });
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
    this.bus.dispatch('dm:whisper', {
      text: 'Combat ends.',
      priority: 1, category: 'combat'
    });
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
      // Phase 1 (session0-polish) — reset per-round reaction tracking at
      // the start of each new round so OoA / Shield / etc. become available
      // again. Combatants without the flag are unaffected.
      for (const c of combat.turnOrder) {
        if (c._reactionUsedThisRound) c._reactionUsedThisRound = false;
      }
    }

    combat.currentTurn = nextIdx;
    this._setCombatState(combat);
    this._broadcastCombat('combat:next_turn', {
      combatant: combat.turnOrder[nextIdx],
      round: combat.round
    });
    const upcomingNext = combat.turnOrder[nextIdx];
    if (upcomingNext && upcomingNext.name) {
      this.bus.dispatch('dm:whisper', {
        text: `${upcomingNext.name}'s turn.`,
        priority: 1, category: 'combat'
      });
    }

    // NPC turn execution is owned by the combat:next_turn bus subscriber
    // (_npcTacticalAI → _executeNpcCombatAction → processAttack) so the
    // wound system, hit-location narration, and trust-level gate fire
    // consistently. Previously a setTimeout here also ran _autoNpcTurn,
    // which raced the bus subscriber: two target selections per turn, two
    // damage applications, and a mismatch where the announcement named
    // one PC while the wound landed on another.

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
    const upcomingPrev = combat.turnOrder[prevIdx];
    if (upcomingPrev && upcomingPrev.name) {
      this.bus.dispatch('dm:whisper', {
        text: `${upcomingPrev.name}'s turn.`,
        priority: 1, category: 'combat'
      });
    }
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

    // ── Gas Spore Death Burst ──
    // If a Gas Spore takes 10+ damage in one hit OR drops to 0, fire Death Burst
    const damage = delta < 0 ? -delta : 0;
    const isGasSpore = (c.id === 'gas-spore' || c.creatureId === 'gas-spore' || (c.name || '').toLowerCase().includes('gas spore'));
    if (isGasSpore && damage > 0 && (damage >= 10 || c.hp.current === 0)) {
      this._triggerGasSporeDeathBurst(combatantId, c);
    }

    // Mark as dead/unconscious at 0 HP
    if (c.hp.current === 0 && oldHp > 0) {
      if (c.type === 'pc') {
        // PCs go unconscious, not dead
        if (!c.conditions.includes('unconscious')) c.conditions.push('unconscious');
        c.deathSaves = { successes: 0, failures: 0 };
      } else {
        // NPCs die at 0
        c.isAlive = false;
        // Persist death flag outside combat state so scene re-population
        // (which may fire after map activation wipes map.tokens) doesn't
        // resurrect the corpse at full HP.
        this.state.set(`npcs.${combatantId}.dead`, true);
      }
      this.bus.dispatch('dm:whisper', {
        text: `${c.name} is down.`,
        priority: 1, category: 'combat'
      });
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
   * Gas Spore Death Burst — 20ft radius necrotic explosion + spore infection
   */
  _triggerGasSporeDeathBurst(sporeId, sporeCombatant) {
    const sporeToken = this.state.get(`map.tokens.${sporeId}`);
    if (!sporeToken) {
      // Fire AOE without position
      this.bus.dispatch('combat:aoe', { source: sporeId, radius: 20, damage: '10d10', damageType: 'necrotic', saveType: 'CON', saveDC: 15 });
      this.bus.dispatch('dm:whisper', {
        text: 'Gas Spore Death Burst — 10d10 necrotic in 20ft, DC15 CON save, failed save = spore infection',
        priority: 1, category: 'combat'
      });
      return;
    }

    const map = this.state.get('map') || {};
    const tokens = map.tokens || {};
    const gs = map.gridSize || 70;
    const radiusPx = 20 * (gs / 5); // 20ft in pixels assuming 5ft per square
    const targets = [];
    for (const [tid, tok] of Object.entries(tokens)) {
      if (tid === sporeId) continue;
      const dx = (tok.x || 0) - (sporeToken.x || 0);
      const dy = (tok.y || 0) - (sporeToken.y || 0);
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist <= radiusPx) targets.push({ id: tid, name: tok.name || tid, dist });
    }

    // Fire AOE event for visualization
    this.bus.dispatch('combat:aoe', {
      source: sporeId,
      origin: { x: sporeToken.x, y: sporeToken.y },
      radius: 20,
      damage: '10d10',
      damageType: 'necrotic',
      saveType: 'CON',
      saveDC: 15,
      targets: targets.map(t => t.id)
    });

    // For each target, mark spore infection eligibility
    for (const t of targets) {
      this.state.set(`players.${t.id}.sporeInfection`, {
        eligibleSinceGameTime: this.state.get('world.gameTime') || new Date().toISOString(),
        saveDC: 15,
        narrativeStage: 0
      });
    }

    // Build 6 — notify any PC target they must make a Constitution save.
    // Player-bridge turns this into a gold-border flash + "CONSTITUTION SAVE"
    // label on their Chromebook. DC is NOT sent — only the save type and
    // a narrative cause.
    const playersState = this.state.get('players') || {};
    for (const t of targets) {
      if (!playersState[t.id]) continue; // only PCs
      this.bus.dispatch('combat:save_required', {
        playerId: t.id,
        saveType: 'Constitution',
        cause: 'Something in the dark ruptures. A cloud of dust and spore billows outward.'
      });
    }

    this.bus.dispatch('dm:whisper', {
      text: `Gas Spore Death Burst — ${targets.length} targets in blast (${targets.map(t => t.name).join(', ')}) — CON save DC15 — failure = 10d10 necrotic AND spore infection`,
      priority: 1, category: 'combat'
    });

    // AI gothic description for HAL panel
    this.bus.dispatch('hal:event', {
      type: 'death-burst',
      description: 'The thing in the dark bursts. Not into pieces. Into a cloud of dust and spore that fills the air with a sweet rotten smell. The walls weep with necrotic mist. Whatever it touches is no longer entirely yours.'
    });
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
    const wasAdded = idx < 0; // adding vs removing
    // Addition 8 — condition immunity check on ADD path only. Removal is
    // always allowed (the condition is somehow on the token — let the DM
    // clear it). Applies to both actor configs and SRD creature configs via
    // the shared _creatureConfigFor helper.
    if (wasAdded) {
      const cfg = this._creatureConfigFor(c.actorSlug);
      const imms = (cfg && cfg.immunities && cfg.immunities.conditions) || [];
      if (imms.map(s => String(s).toLowerCase()).includes(String(condition).toLowerCase())) {
        this.bus.dispatch('dm:whisper', {
          text: `${c.name} is immune to ${condition} — condition not applied.`,
          priority: 2, category: 'combat'
        });
        return c;
      }
    }
    if (idx >= 0) {
      c.conditions.splice(idx, 1);
    } else {
      c.conditions.push(condition);
    }

    this._setCombatState(combat);
    this._syncConditionsToToken(combatantId, c.conditions);
    this._broadcastCombat('combat:condition_changed', { combatantId, conditions: c.conditions, toggled: condition });
    if (wasAdded) {
      this.bus.dispatch('dm:whisper', {
        text: `${c.name} is now ${condition}.`,
        priority: 1, category: 'combat'
      });
    }
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
    this.bus.dispatch('dm:whisper', {
      text: `${c.name} rolls a death save.`,
      priority: 1, category: 'combat'
    });
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
    const actor = mapSvc?.customActors?.get(c.actorSlug) || mapSvc?.srdMonsters?.find(m => m.slug === c.actorSlug);
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
  processAttack(attackerId, targetId, attackRoll, damage, damageType, crit = false, weaponName = null, magical = false, silvered = false) {
    const combat = this._getCombatState();
    const attacker = combat.turnOrder.find(x => x.id === attackerId);
    const target = combat.turnOrder.find(x => x.id === targetId);
    if (!attacker || !target) return null;

    const hit = crit || attackRoll >= target.ac;
    let appliedDamage = 0;
    let immunityReason = null;
    if (hit) {
      appliedDamage = damage;

      // ── Damage immunity / resistance from actor config ────────────
      // NPC immunities live on the actor json (config/actors/<slug>.json)
      // and get merged onto the combatant as `combatant.immunities` when the
      // combatant is spawned from a token. Check three things:
      //   1. damage_types list (e.g. poison) — hard immunity
      //   2. nonmagical_weapons true — physical attacks need magical=true
      //      (silver satisfies this if silver_bypasses is true and the
      //      attack is silvered)
      //   3. resistances.damage_types — halve damage
      const imm = target.immunities || (target.actor && target.actor.immunities) || null;
      const res = target.resistances || (target.actor && target.actor.resistances) || null;
      const dType = (damageType || '').toLowerCase();
      const isPhysical = ['slashing', 'piercing', 'bludgeoning'].includes(dType);
      if (imm) {
        if (Array.isArray(imm.damage_types) && imm.damage_types.map(s => s.toLowerCase()).includes(dType)) {
          appliedDamage = 0;
          immunityReason = `${target.name} is immune to ${dType} damage.`;
        } else if (imm.nonmagical_weapons && isPhysical && !magical && !(imm.silver_bypasses && silvered)) {
          appliedDamage = 0;
          immunityReason = `${target.name} is immune to nonmagical ${dType} — ${weaponName || 'this weapon'} has no effect.`;
        }
      }
      if (appliedDamage > 0 && res && Array.isArray(res.damage_types) && res.damage_types.map(s => s.toLowerCase()).includes(dType)) {
        const halved = Math.floor(appliedDamage / 2);
        this.bus.dispatch('dm:whisper', {
          text: `${target.name} resists ${dType}: ${appliedDamage} → ${halved}`,
          priority: 2, category: 'combat'
        });
        appliedDamage = halved;
      }
      if (immunityReason) {
        this.bus.dispatch('dm:whisper', { text: immunityReason, priority: 1, category: 'combat' });
      }

      // Addition 3 — Rage resistance (Bear Totem: all damage except psychic)
      if (target.type === 'pc') {
        const targetAbilities = this.state.get('players.' + targetId + '.abilities');
        if (targetAbilities && targetAbilities.rage_active && damageType !== 'psychic') {
          const halved = Math.floor(appliedDamage / 2);
          this.bus.dispatch('dm:whisper', {
            text: `${target.name} raging (Bear Totem) — ${damageType || 'physical'} damage halved: ${appliedDamage} → ${halved}`,
            priority: 1, category: 'combat'
          });
          appliedDamage = halved;
        }
      }
      if (appliedDamage > 0) this.modifyHp(targetId, -appliedDamage);
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
      immunityReason: immunityReason || null,
      targetHpAfter: this._getCombatState().turnOrder.find(x => x.id === targetId)?.hp
    };

    this.bus.dispatch('combat:attack_result', { ...result, combat: this._getCombatState() });

    // ── Hit Location, Bleeding, Massive Damage, Morale ──
    if (hit && appliedDamage > 0 && target) {
      this._processHitLocation(attackerId, targetId, appliedDamage, damageType, crit, weaponName);
      this._checkMassiveDamage(targetId, appliedDamage);
      this._checkMorale(targetId, combat);
    }

    return result;
  }

  // ── Hit Location System ─────────────────────────────────────────────
  _rollD6() { return Math.floor(Math.random() * 6) + 1; }
  _rollD4() { return Math.floor(Math.random() * 4) + 1; }

  _processHitLocation(attackerId, targetId, damage, damageType, crit, weaponName = null) {
    const combat = this._getCombatState();
    const target = combat.turnOrder.find(x => x.id === targetId);
    if (!target) return;
    const attacker = combat.turnOrder.find(x => x.id === attackerId);
    const attackerName = attacker ? attacker.name : (attackerId || 'someone');

    const currentHp = target.hp.current + damage; // HP before this hit was applied
    const pct = damage / currentHp;

    let severity;
    if (pct < 0.25) severity = 'graze';
    else if (pct <= 0.50) severity = 'wound';
    else severity = 'devastating';

    // Graze = narrative only
    if (severity === 'graze') {
      this.bus.dispatch('combat:hit_location', {
        attackerId, attackerName, targetId, targetName: target.name, damage, severity,
        location: null, consequence: null, damageType, weaponName
      });
      return;
    }

    // Roll hit location
    const locRoll = this._rollD6();
    const locations = ['head', 'torso', 'leftArm', 'rightArm', 'leftLeg', 'rightLeg'];
    const location = locations[locRoll - 1];

    // Devastating hits spike party dread
    if (severity === 'devastating' && target.type === 'pc') {
      const players = this.state.get('players') || {};
      for (const pid of Object.keys(players)) {
        const currentDread = this.state.get(`players.${pid}.dread.score`) || 0;
        this.state.updateDread(pid, Math.min(100, currentDread + 15));
      }
    }

    // Build consequence description
    const consequence = this._getHitConsequence(location, severity, target);

    // Dispatch for AI narration and DM whisper
    this.bus.dispatch('combat:hit_location', {
      attackerId, attackerName, targetId, targetName: target.name,
      damage, severity, location, consequence, damageType, weaponName
    });

    // Whisper mechanical effect to DM — include WHO + WEAPON so the DM
    // (and Max's narration) know who took what wound from whom with what.
    const weaponClause = weaponName ? ` with ${weaponName}` : '';
    this.bus.dispatch('dm:whisper', {
      text: `${severity.toUpperCase()} hit on ${target.name}'s ${location} from ${attackerName}${weaponClause}. ${consequence.mechanical}`,
      priority: 2, category: 'combat'
    });

    // Apply wound to character wound state if PC
    if (target.type === 'pc') {
      const wounds = this.state.get(`players.${targetId}.wounds`) || {};
      const currentTier = wounds[location] || 0;
      const newTier = Math.min(4, currentTier + (severity === 'devastating' ? 2 : 1));
      wounds[location] = newTier;
      this.state.set(`players.${targetId}.wounds`, wounds);
      this.bus.dispatch('wounds:updated', { playerId: targetId, wounds, location });
    }

    // Devastating torso/limb hits may cause bleeding
    if (severity === 'devastating' && location !== 'head') {
      this._startBleeding(targetId, location);
    }
  }

  _getHitConsequence(location, severity, target) {
    const consequences = {
      head: {
        wound: { mechanical: 'WIS save DC12 or Disoriented (next action wasted)', save: 'wis', dc: 12 },
        devastating: { mechanical: 'Stunned until end of next turn. WIS save DC15 or attacks random target.', save: 'wis', dc: 15, condition: 'stunned' }
      },
      torso: {
        wound: { mechanical: 'CON save DC12 or lose concentration + bonus action', save: 'con', dc: 12 },
        devastating: { mechanical: 'CON save DC15 or Incapacitated until end of next turn. Begin Bleeding.', save: 'con', dc: 15, condition: 'incapacitated', bleeding: true }
      },
      leftArm: {
        wound: { mechanical: 'Shield AC halved this round', effect: 'shield_halved' },
        devastating: { mechanical: 'Shield arm useless this combat. Shield dropped.', effect: 'shield_lost' }
      },
      rightArm: {
        wound: { mechanical: 'Disadvantage on attacks this round. DEX save DC12 or drop weapon.', save: 'dex', dc: 12 },
        devastating: { mechanical: 'Cannot attack with that arm this combat. Weapon dropped.', effect: 'arm_disabled' }
      },
      leftLeg: {
        wound: { mechanical: 'Speed halved until end of next turn', effect: 'speed_halved' },
        devastating: { mechanical: 'Speed 0 until bandaged or healed. Begin Bleeding.', effect: 'speed_zero', bleeding: true }
      },
      rightLeg: {
        wound: { mechanical: 'Speed halved until end of next turn', effect: 'speed_halved' },
        devastating: { mechanical: 'Speed 0 until bandaged or healed. Begin Bleeding.', effect: 'speed_zero', bleeding: true }
      }
    };

    return consequences[location]?.[severity] || { mechanical: 'No specific consequence' };
  }

  // ── Bleeding System ─────────────────────────────────────────────────

  _startBleeding(combatantId, location) {
    const combat = this._getCombatState();
    const c = combat.turnOrder.find(x => x.id === combatantId);
    if (!c) return;

    if (!c._bleeding) c._bleeding = [];
    if (!c._bleeding.includes(location)) {
      c._bleeding.push(location);
    }
    if (!c.conditions.includes('bleeding')) {
      c.conditions.push('bleeding');
    }
    this._setCombatState(combat);

    this.bus.dispatch('combat:bleeding_started', {
      combatantId, combatantName: c.name, location
    });
    this.bus.dispatch('dm:whisper', {
      text: `${c.name} is BLEEDING from ${location}. Medicine DC10 to stop (DC8 with help). Costs 1 healer's kit charge.`,
      priority: 2, category: 'combat'
    });
  }

  _processBleedingTick(combatant) {
    if (!combatant._bleeding || combatant._bleeding.length === 0) return;

    const d4 = this._rollD4();
    this.modifyHp(combatant.id, -d4);

    this.bus.dispatch('combat:bleeding_tick', {
      playerId: combatant.id, combatantName: combatant.name,
      damage: d4, locations: combatant._bleeding
    });
    this.bus.dispatch('dm:whisper', {
      text: `${combatant.name} takes ${d4} bleeding damage. Still bleeding from: ${combatant._bleeding.join(', ')}`,
      priority: 3, category: 'combat'
    });
  }

  stopBleeding(combatantId, location) {
    const combat = this._getCombatState();
    const c = combat.turnOrder.find(x => x.id === combatantId);
    if (!c || !c._bleeding) return null;

    if (location) {
      c._bleeding = c._bleeding.filter(l => l !== location);
    } else {
      c._bleeding = []; // stop all bleeding
    }

    if (c._bleeding.length === 0) {
      c.conditions = c.conditions.filter(x => x !== 'bleeding');
    }

    this._setCombatState(combat);
    this.bus.dispatch('combat:bleeding_stopped', {
      combatantId, combatantName: c.name, location: location || 'all'
    });
    return c;
  }

  // ── Massive Damage Shock ────────────────────────────────────────────

  _checkMassiveDamage(targetId, damage) {
    const combat = this._getCombatState();
    const target = combat.turnOrder.find(x => x.id === targetId);
    if (!target || target.hp.current <= 0) return; // already at 0, death saves handle it

    const hpBeforeHit = target.hp.current + damage;
    const threshold = hpBeforeHit * 0.5;
    if (damage < threshold) return;

    // Check immunity
    const npcState = this.state.get(`npcs.${targetId}`);
    if (npcState?.shockImmune) return; // Undead, Vladislav

    // Calculate DC: 10 + 1 per 10% above 50% threshold
    const pctAbove = ((damage / hpBeforeHit) - 0.5) * 100;
    const dc = Math.min(18, 10 + Math.floor(pctAbove / 10));

    // Check advantage (werewolf etc)
    const hasAdvantage = npcState?.shockAdvantage || false;
    const hasDisadvantage = npcState?.shockDisadvantage || false;

    this.bus.dispatch('combat:massive_damage', {
      targetId, targetName: target.name, damage, hpBefore: hpBeforeHit,
      dc, hasAdvantage, hasDisadvantage, type: target.type
    });

    this.bus.dispatch('dm:whisper', {
      text: `MASSIVE HIT — ${target.name} needs CON save DC${dc} or goes into shock.${hasAdvantage ? ' (advantage)' : ''}`,
      priority: 1, category: 'combat'
    });
  }

  /**
   * DM clicks Pass or Fail for shock save
   */
  resolveShockSave(combatantId, passed) {
    const combat = this._getCombatState();
    const c = combat.turnOrder.find(x => x.id === combatantId);
    if (!c) return null;

    if (passed) {
      // Loses next bonus action, stamina drain
      this.bus.dispatch('combat:shock_save_passed', {
        playerId: combatantId, combatantName: c.name
      });
      this.bus.dispatch('dm:whisper', {
        text: `${c.name} takes the blow and stays on their feet — barely. Lost bonus action.`,
        priority: 2, category: 'combat'
      });
    } else {
      // Falls unconscious from shock for 1d4 rounds (not dying)
      const rounds = this._rollD4();
      if (!c.conditions.includes('shocked')) c.conditions.push('shocked');
      c._shockRoundsLeft = rounds;

      this._setCombatState(combat);
      this._syncConditionsToToken(combatantId, c.conditions);

      // Start bleeding from torso/limb automatically
      this._startBleeding(combatantId, 'torso');

      this.bus.dispatch('combat:shock_failed', {
        playerId: combatantId, combatantName: c.name, rounds
      });
      this.bus.dispatch('dm:whisper', {
        text: `${c.name} goes into SHOCK — unconscious ${rounds} rounds. Medicine DC8 to rouse. Bleeding started.`,
        priority: 1, category: 'combat'
      });
    }
    return c;
  }

  /**
   * Rouse a shocked combatant (Medicine DC8 by another character)
   */
  rouseFromShock(combatantId) {
    const combat = this._getCombatState();
    const c = combat.turnOrder.find(x => x.id === combatantId);
    if (!c) return null;

    c.conditions = c.conditions.filter(x => x !== 'shocked');
    delete c._shockRoundsLeft;
    this._setCombatState(combat);
    this._syncConditionsToToken(combatantId, c.conditions);

    // Immediately gains Exhausted stamina state
    const staminaSvc = this.orchestrator.getService('stamina');
    if (staminaSvc) staminaSvc.setStaminaState(combatantId, 'exhausted');

    this.bus.dispatch('dm:whisper', {
      text: `${c.name} roused from shock. Immediately exhausted.`,
      priority: 2, category: 'combat'
    });
    return c;
  }

  // ── Enemy Morale ────────────────────────────────────────────────────

  _checkMorale(targetId, combat) {
    // Only check morale for NPCs after they take damage
    const c = combat.turnOrder.find(x => x.id === targetId);
    if (!c || c.type !== 'npc' || !c.isAlive) return;

    const npcState = this.state.get(`npcs.${targetId}`) || {};
    const profile = npcState.moraleProfile || 'normal';
    if (profile === 'fearless') return;

    // INT check — only INT 6+ considers fleeing
    const mapSvc = this.orchestrator.getService('map');
    const actor = c.actorSlug ? (mapSvc?.customActors?.get(c.actorSlug) || mapSvc?.srdMonsters?.find(m => m.slug === c.actorSlug)) : null;
    const intScore = actor?.intelligence || 10;
    if (intScore < 6) return;

    const hpPct = c.hp.current / c.hp.max;
    const threshold = profile === 'cowardly' ? 0.75 : profile === 'disciplined' ? 0.25 : 0.50;
    if (hpPct > threshold) return;

    // Check if ally dropped this combat
    const allyDropped = combat.turnOrder.some(x =>
      x.type === 'npc' && x.id !== targetId && !x.isAlive
    );

    // Check outnumbered
    const aliveNpcs = combat.turnOrder.filter(x => x.type === 'npc' && x.isAlive).length;
    const alivePcs = combat.turnOrder.filter(x => x.type === 'pc' && x.isAlive).length;
    const outnumbered = alivePcs >= aliveNpcs * 2;

    if (hpPct <= threshold || allyDropped || outnumbered) {
      // WIS save DC12
      const wisScore = actor?.wisdom || 10;
      const wisMod = Math.floor((wisScore - 10) / 2);
      const d20 = this._rollD20();
      let roll = d20 + wisMod;

      // Disciplined get advantage
      if (profile === 'disciplined') {
        const d20b = this._rollD20();
        roll = Math.max(d20 + wisMod, d20b + wisMod);
      }

      const fled = roll < 12;

      if (fled) {
        this.bus.dispatch('combat:morale_break', {
          combatantId: targetId, combatantName: c.name,
          reason: hpPct <= threshold ? 'wounded' : allyDropped ? 'ally_fallen' : 'outnumbered',
          roll, dc: 12
        });
        this.bus.dispatch('dm:whisper', {
          text: `MORALE BREAK: ${c.name} fails WIS save (${roll} vs DC12) — will Disengage and flee!`,
          priority: 2, category: 'combat'
        });
      }
    }
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
    const actor = mapSvc?.customActors?.get(c.actorSlug) || mapSvc?.srdMonsters?.find(m => m.slug === c.actorSlug);
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

  async _executeNpcCombatAction(combatant, decision) {
    const rollResult = this.rollNpcAction(combatant.id, decision.actionIndex);
    if (!rollResult || rollResult.error) {
      // Pre-attack failure — surface it so the DM knows the NPC turn fizzled
      // rather than being silent.
      this.bus.dispatch('dm:whisper', {
        text: `[COMBAT] ${combatant.name} turn skipped — could not roll action (${rollResult?.error || 'no action parsed'}).`,
        priority: 1, category: 'combat', source: 'combat-service'
      });
      return;
    }

    if (!decision.targetId) {
      this.bus.dispatch('dm:whisper', {
        text: `[COMBAT] ${combatant.name} uses ${rollResult.actionName} — no target selected.`,
        priority: 1, category: 'combat', source: 'combat-service'
      });
      return;
    }

    const result = this.processAttack(
      combatant.id, decision.targetId,
      rollResult.attackRoll, rollResult.damage,
      rollResult.dmgType, rollResult.crit,
      rollResult.actionName
    );
    if (!result) {
      this.bus.dispatch('dm:whisper', {
        text: `[COMBAT] ${combatant.name} attack failed — target ${decision.targetId} not found in combat.`,
        priority: 1, category: 'combat', source: 'combat-service'
      });
      return;
    }

    // Whisper every NPC attack to the DM earbud. Before this, _executeNpcCombatAction
    // only console.log'd — so auto-combat was silent on the earbud after commit
    // a5ef09b removed the setTimeout → _autoNpcTurn path (which had been the
    // whisper-producing path).
    const attackerToHit = rollResult.toHitBonus ?? 0;
    const hitMiss = result.hit ? (result.crit ? 'CRIT HIT' : 'HIT') : 'MISS';
    const damageFragment = result.hit
      ? ` — ${result.damage} ${result.damageType || 'damage'} applied`
      : '';
    this.bus.dispatch('dm:whisper', {
      text:
        `[COMBAT] ${combatant.name} → ${result.targetName} with ${rollResult.actionName || 'attack'} ` +
        `— rolled ${rollResult.d20 ?? '?'} + ${attackerToHit >= 0 ? '+' : ''}${attackerToHit} = ${result.attackRoll} ` +
        `vs AC ${result.targetAC} — ${hitMiss}${damageFragment}`,
      priority: 1, category: 'combat', source: 'combat-service'
    });

    console.log(`[CombatService] ${combatant.name} attacks ${result.targetName}: ${hitMiss} (${rollResult.attackRoll} vs AC ${result.targetAC})${result.hit ? `, ${result.damage} ${result.damageType}` : ''}`);
  }

  // ── Build 7 — auto-combat for non-PC combatants ─────────────────
  //
  // Fires ~1500ms after combat:next_turn broadcasts a non-PC turn. INT-
  // tiered target selection: random / nearest-ish / lowest-HP / highest-
  // threat. Attack uses the creature's first action from its config (or a
  // sensible fallback), rolls d20+bonus vs target AC, and applies damage
  // through modifyHp — same path player attacks take in Build 5.
  //
  // Spurt (PC, AI-controlled by spurt-agent.js) is deliberately not
  // handled here — spurt-agent already subscribes to combat:next_turn
  // and owns his decisions.

  _autoNpcTurn(combatant) {
    if (!combatant) return;
    if (combatant.type === 'pc') return; // spurt-agent handles PCs

    const intelligence = Number.isFinite(combatant.int)
      ? combatant.int
      : (combatant.stats?.int ?? this._creatureIntFromConfig(combatant.actorSlug) ?? 5);

    const combat = this._getCombatState();
    const turnOrder = combat.turnOrder || [];

    // Valid targets: alive PCs (NPC-on-NPC combat isn't modelled here).
    const targets = turnOrder.filter(c =>
      c && c.id !== combatant.id && c.type === 'pc' && c.hp?.current > 0
    );
    if (targets.length === 0) {
      this.bus.dispatch('dm:whisper', {
        text: `${combatant.name}: no valid targets. Holds action.`,
        priority: 1, category: 'combat'
      });
      return;
    }

    let target;
    if (intelligence <= 3) {
      target = targets[Math.floor(Math.random() * targets.length)];
    } else if (intelligence <= 7) {
      // "Nearest" — without a real distance map, use first in turn order
      target = targets[0];
    } else if (intelligence <= 11) {
      target = targets.reduce((a, b) => (a.hp.current < b.hp.current ? a : b));
    } else {
      // Highest level/CR = highest threat
      target = targets.reduce((a, b) => {
        const av = Number(a.level || a.cr || 1);
        const bv = Number(b.level || b.cr || 1);
        return av > bv ? a : b;
      });
    }

    const action = this._creatureActionFromConfig(combatant.actorSlug) || {
      name: 'Attack',
      attackBonus: Math.max(2, Math.floor((intelligence - 10) / 2) + 2),
      damage: '1d6',
      damageType: 'bludgeoning'
    };

    const attackRoll = Math.floor(Math.random() * 20) + 1;
    const attackBonus = Number.isFinite(action.attackBonus) ? action.attackBonus : 3;
    const total = attackRoll + attackBonus;
    const targetAC = target.ac || 10;
    const crit = attackRoll === 20;
    const hit = total >= targetAC || crit;

    if (hit) {
      const rolled = this._rollDiceExpression(action.damage || '1d6');
      const totalDamage = crit ? rolled * 2 : rolled;

      // Apply via the same path player attacks take in Build 5
      this.modifyHp(target.id, -Math.abs(totalDamage));

      this.bus.dispatch('dm:whisper', {
        text:
          `${combatant.name} uses ${action.name} on ${target.name} — ` +
          `rolled ${attackRoll} + ${attackBonus} = ${total} vs AC ${targetAC} — ` +
          `${crit ? 'CRITICAL HIT' : 'HIT'} — ${totalDamage} ${action.damageType || 'damage'}.`,
        priority: 1, category: 'combat'
      });
    } else {
      this.bus.dispatch('dm:whisper', {
        text:
          `${combatant.name} uses ${action.name} on ${target.name} — ` +
          `rolled ${attackRoll} + ${attackBonus} = ${total} vs AC ${targetAC} — MISS.`,
        priority: 1, category: 'combat'
      });
    }
  }

  // Resolve HP for a combatant. Strategy: look up the actor config's authoritative
  // max (via hit_points / hp.max / srd-monsters). If token.hp.max matches that
  // authoritative max, the token is carrying mid-combat HP — use token.hp.current.
  // Otherwise the token has the 10/10 default and we seed from the actor config.
  // Fixes F3 (Vladislav 10/10 instead of 144/144).
  _resolveCombatantHp(token) {
    const authoritativeMax = this._resolveAuthoritativeHpMax(token);
    if (authoritativeMax && Number.isFinite(authoritativeMax)) {
      const tokHp = token && token.hp;
      if (tokHp && Number.isFinite(tokHp.max) && tokHp.max === authoritativeMax && Number.isFinite(tokHp.current)) {
        return { current: tokHp.current, max: authoritativeMax };
      }
      return { current: authoritativeMax, max: authoritativeMax };
    }
    if (token && token.hp && Number.isFinite(token.hp.max) && Number.isFinite(token.hp.current)) {
      return { current: token.hp.current, max: token.hp.max };
    }
    return { current: 10, max: 10 };
  }

  _resolveAuthoritativeHpMax(token) {
    const slug = token && (token.actorSlug || token.slug);
    if (!slug) return null;
    const cfg = this._creatureConfigFor(slug);
    if (cfg) {
      if (cfg.hp && Number.isFinite(cfg.hp.max)) return cfg.hp.max;
      if (Number.isFinite(cfg.hit_points)) return cfg.hit_points;
    }
    try {
      const mapSvc = this.orchestrator.getService('map');
      // Guard against falsy slug matching SRD entries with undefined id via
      // `undefined === undefined` — the whole branch is already behind `!slug`
      // returning null above, but keep the explicit guard for defense.
      if (slug) {
        const srd = mapSvc?.srdMonsters?.find(m => m && ((m.slug && m.slug === slug) || (m.id && m.id === slug)));
        if (srd && Number.isFinite(srd.hit_points)) return srd.hit_points;
      }
    } catch (e) {}
    return null;
  }

  _resolveCombatantAc(token) {
    const slug = token && (token.actorSlug || token.slug);
    const cfg = slug ? this._creatureConfigFor(slug) : null;
    if (cfg) {
      if (Number.isFinite(cfg.ac)) return cfg.ac;
      if (Number.isFinite(cfg.armor_class)) return cfg.armor_class;
    }
    // Only consult the SRD monster table when we actually have a slug —
    // `find(m.id === undefined)` silently matches the first SRD entry whose
    // id is missing, which poisoned PC AC with aboleth's 17.
    if (slug) {
      try {
        const mapSvc = this.orchestrator.getService('map');
        const srd = mapSvc?.srdMonsters?.find(m => m && ((m.slug && m.slug === slug) || (m.id && m.id === slug)));
        if (srd && Number.isFinite(srd.armor_class)) return srd.armor_class;
      } catch (e) {}
    }
    if (token && Number.isFinite(token.ac) && token.ac > 0) return token.ac;
    return 10;
  }

  _creatureConfigFor(actorSlug) {
    if (!actorSlug) return null;
    // Cache per-instance so we don't re-read disk every turn
    if (!this._creatureConfigCache) this._creatureConfigCache = new Map();
    if (this._creatureConfigCache.has(actorSlug)) return this._creatureConfigCache.get(actorSlug);
    let cfg = null;
    try {
      const fs = require('fs');
      const path = require('path');
      for (const dir of ['creatures', 'actors']) {
        const p = path.join(__dirname, '..', '..', 'config', dir, `${actorSlug}.json`);
        if (fs.existsSync(p)) { cfg = JSON.parse(fs.readFileSync(p, 'utf8')); break; }
      }
    } catch (e) { /* keep null */ }
    this._creatureConfigCache.set(actorSlug, cfg);
    return cfg;
  }

  _creatureIntFromConfig(actorSlug) {
    const cfg = this._creatureConfigFor(actorSlug);
    if (!cfg) return null;
    if (Number.isFinite(cfg.intelligence)) return cfg.intelligence;
    if (cfg.abilities?.int?.score != null) return cfg.abilities.int.score;
    return null;
  }

  _creatureActionFromConfig(actorSlug) {
    const cfg = this._creatureConfigFor(actorSlug);
    if (!cfg) return null;
    const actions = Array.isArray(cfg.actions) ? cfg.actions : [];
    const first = actions.find(a => a && (a.name && (a.attackBonus != null || a.damage)));
    if (!first) return null;
    // Normalize common shapes: DDB-style "+9 to hit ... 7 (1d6+4)" vs simple config
    let attackBonus = first.attackBonus;
    if (attackBonus == null && typeof first.desc === 'string') {
      const m = first.desc.match(/\+(\d+)\s*to\s*hit/i);
      if (m) attackBonus = parseInt(m[1], 10);
    }
    let damage = first.damage;
    if (!damage && typeof first.desc === 'string') {
      const m = first.desc.match(/\((\d+d\d+(?:\s*\+\s*\d+)?)\)/);
      if (m) damage = m[1].replace(/\s+/g, '');
    }
    return {
      name: first.name || 'Attack',
      attackBonus: Number.isFinite(attackBonus) ? attackBonus : 3,
      damage: damage || '1d6',
      damageType: first.damageType || 'bludgeoning'
    };
  }

  _rollDiceExpression(expr) {
    // Handles "1d6", "2d6+3", "1d8-1" — returns int total, min 1.
    const m = String(expr || '').match(/(\d+)\s*d\s*(\d+)\s*([+-]\s*\d+)?/i);
    if (!m) return 1;
    const count = parseInt(m[1], 10) || 1;
    const sides = parseInt(m[2], 10) || 6;
    const bonus = m[3] ? parseInt(m[3].replace(/\s+/g, ''), 10) : 0;
    let total = 0;
    for (let i = 0; i < count; i++) total += Math.floor(Math.random() * sides) + 1;
    return Math.max(1, total + bonus);
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

    // Addition 5 — POST /api/combat/add-combatant
    // DM-side button on dm-ref Tools/Combat tab to add any token to
    // an active fight mid-combat. Rolls initiative, inserts at the
    // correct slot (with currentTurn pointer-shift like Addition 4).
    app.post('/api/combat/add-combatant', (req, res) => {
      const combat = this._getCombatState();
      if (!combat.active) return res.status(400).json({ error: 'No active combat' });

      const { name, tokenId } = req.body || {};
      if (!name && !tokenId) return res.status(400).json({ error: 'name or tokenId required' });

      // Use _resolveToken for the full 5-level fallback: exact ID, actor
      // slug, player ID with virtual token, NPC config, fuzzy partial match.
      // The old inline search only checked map.tokens and missed NPCs that
      // were in config/actors but not yet placed on the map.
      const resolved = this._resolveToken(name || tokenId);
      if (!resolved) {
        return res.status(404).json({ error: `Not found: "${name || tokenId}". Try the full name or token ID.` });
      }

      const [tid, token] = [resolved.tokenId, resolved.token];
      if ((combat.turnOrder || []).some(c => c && c.id === tid)) {
        return res.status(400).json({ error: `${token.name} is already in combat` });
      }

      const initMod = this._getInitMod({ ...token, id: tid });
      const initRoll = this._rollD20();
      const initiative = initRoll + initMod;

      const newCombatant = {
        id: tid,
        name: token.name || tid,
        type: token.type || 'npc',
        initiative,
        initRoll,
        initMod,
        hp: token.hp || { current: 10, max: 10 },
        ac: token.ac || 10,
        actorSlug: token.actorSlug,
        conditions: [],
        deathSaves: { successes: 0, failures: 0 },
        isAlive: true
      };

      if (!combat.turnOrder) combat.turnOrder = [];
      const insertAt = combat.turnOrder.findIndex(c => (c?.initiative ?? -Infinity) < initiative);
      if (insertAt === -1) {
        combat.turnOrder.push(newCombatant);
      } else {
        combat.turnOrder.splice(insertAt, 0, newCombatant);
        // Same pointer-shift as Addition 4 so the active turn doesn't change identity
        if (insertAt <= combat.currentTurn) combat.currentTurn += 1;
      }

      this._setCombatState(combat);
      this._broadcastCombat('combat:combatant_added', { combatant: newCombatant });
      this.bus.dispatch('dm:whisper', {
        text: `${token.name} added to combat — initiative ${initiative}.`,
        priority: 1, category: 'combat'
      });

      res.json({ ok: true, name: token.name, initiative, tokenId: tid });
    });

    // GET /api/combat/search?q=tom — typeahead for Add to Combat. Returns
    // names from map tokens, NPC config, player characters, and actor files.
    app.get('/api/combat/search', (req, res) => {
      const q = (req.query.q || '').toLowerCase().trim();
      if (!q) return res.json([]);
      const results = [];
      const seen = new Set();
      const tokens = this.state.get('map.tokens') || {};
      for (const [tid, t] of Object.entries(tokens)) {
        const name = t.name || tid;
        if (name.toLowerCase().includes(q) || tid.toLowerCase().includes(q) ||
            (t.actorSlug || '').toLowerCase().includes(q)) {
          if (!seen.has(tid)) { seen.add(tid); results.push({ id: tid, name, type: t.type || 'npc' }); }
        }
      }
      const players = this.state.get('players') || {};
      for (const [pid, p] of Object.entries(players)) {
        const cn = p.character?.name || pid;
        if ((cn.toLowerCase().includes(q) || pid.includes(q)) && !seen.has(pid)) {
          seen.add(pid); results.push({ id: pid, name: cn, type: 'pc' });
        }
      }
      const npcs = this.state.get('npcs') || {};
      for (const [nid, n] of Object.entries(npcs)) {
        const nn = n.name || nid;
        if ((nn.toLowerCase().includes(q) || nid.includes(q)) && !seen.has(nid)) {
          seen.add(nid); results.push({ id: nid, name: nn, type: 'npc' });
        }
      }
      res.json(results.slice(0, 10));
    });

    // Addition 3 — POST /api/combat/initiate
    // DM confirms a player-initiated combat. Reads combat.pendingInitiation
    // (set by combat:player_initiated subscriber when the comm-router
    // detected an attack declaration), or accepts an explicit targetId
    // in the body. Starts combat with: the initiating player + the
    // target + any NPC whose config has combatJoins:true.
    app.post('/api/combat/initiate', (req, res) => {
      const pending = this.state.get('combat.pendingInitiation') || null;
      const targetId = req.body?.targetId || pending?.targetId;
      const initiatorId = req.body?.playerId || pending?.initiatedBy;
      if (!targetId) return res.status(400).json({ error: 'targetId required (or call after combat:player_initiated)' });

      const tokens = this.state.get('map.tokens') || {};
      const combatantIds = [];

      // Initiating player goes in first if known
      if (initiatorId && tokens[initiatorId]) combatantIds.push(initiatorId);

      // Target
      if (tokens[targetId]) combatantIds.push(targetId);

      // Auto-joiners — any NPC config with combatJoins:true. Tomas may
      // gate further with combatJoinsCondition (only-when-transformed),
      // checked via _tomasState if the actorSlug is tomas.
      const sessionNpcs = (this.config && this.config.npcs) || {};
      const ambient = this.orchestrator.getService('ambient-life');
      for (const [npcId, npc] of Object.entries(sessionNpcs)) {
        if (npc?.combatJoins !== true) continue;
        if (npc.combatJoinsCondition === 'only-when-transformed') {
          // Tomas-specific gate — only joins if his ambient state has him transformed
          const tomasTransformed = ambient && ambient._tomasState && ambient._tomasState.transformed;
          if (npcId === 'tomas' && !tomasTransformed) continue;
        }
        // Find a token for this NPC by actorSlug or id
        const npcTokenId = Object.keys(tokens).find(tid =>
          tokens[tid].actorSlug === npcId || tid === npcId
        );
        if (npcTokenId && !combatantIds.includes(npcTokenId)) combatantIds.push(npcTokenId);
      }

      // Clear staged initiation
      this.state.set('combat.pendingInitiation', null);

      if (!combatantIds.length) {
        return res.status(400).json({ error: 'no resolvable combatants' });
      }

      const combat = this.startCombat(combatantIds, {});
      res.json({ ok: true, targetId, initiatorId, combatantIds, combat });
    });

    // PHASE 6 — POST /api/combat/start-scene — start combat with present
    // PCs + NPCs whose config has combatJoins:true (conditions met).
    // Does NOT add every visible token — Piotr in the cellar, patrons,
    // gas spore, and other bystanders stay out unless the DM explicitly
    // adds them mid-combat via /api/combat/add-combatant.
    // Optional body.combatantIds overrides the auto-selection entirely.
    app.post('/api/combat/start-scene', (req, res) => {
      const tokens = this.state.get('map.tokens') || {};
      const players = this.state.get('players') || {};

      // If the DM sent an explicit list, use it directly
      if (req.body?.combatantIds && Array.isArray(req.body.combatantIds) && req.body.combatantIds.length) {
        const combat = this.startCombat(req.body.combatantIds, req.body.manualInit || {});
        return res.json({ ok: true, combat, combatantIds: req.body.combatantIds });
      }

      const ids = [];
      // All present PCs (not absent, not hidden, has a token on the map)
      for (const [tid, t] of Object.entries(tokens)) {
        if (!t || t.hidden) continue;
        if (t.type === 'pc') {
          const ps = players[tid];
          if (ps?.absent || ps?.notYetArrived) continue;
          ids.push(tid);
        }
      }
      // NPCs with combatJoins:true + conditions met (same logic as /initiate)
      const sessionNpcs = (this.config && this.config.npcs) || {};
      const ambient = this.orchestrator.getService('ambient-life');
      for (const [npcId, npc] of Object.entries(sessionNpcs)) {
        if (npc?.combatJoins !== true) continue;
        if (npc.combatJoinsCondition === 'only-when-transformed') {
          const tomasTransformed = ambient && ambient._tomasState && ambient._tomasState.transformed;
          if (npcId === 'tomas' && !tomasTransformed) continue;
        }
        const npcTokenId = Object.keys(tokens).find(tid =>
          tokens[tid].actorSlug === npcId || tid === npcId
        );
        if (npcTokenId && !ids.includes(npcTokenId)) ids.push(npcTokenId);
      }

      if (!ids.length) return res.status(400).json({ error: 'no eligible combatants — use body.combatantIds to override' });
      const combat = this.startCombat(ids, req.body?.manualInit || {});
      res.json({ ok: true, combat, combatantIds: ids, autoSelected: true });
    });

    // POST /api/combat/end — end combat
    app.post('/api/combat/end', (req, res) => {
      const combat = this.endCombat();
      res.json(combat);
    });

    // Phase 1 (session0-polish) — POST /api/combat/override-npc-turn
    // DM-provided decision: skip the tactical AI for this NPC and execute
    // the given action/target directly. Body: { combatantId, actionIndex,
    // targetId, skipMovement? }. If skipMovement is false/absent and a
    // movePath is provided, apply it before attacking.
    app.post('/api/combat/override-npc-turn', async (req, res) => {
      const { combatantId, actionIndex, targetId, movePath } = req.body || {};
      if (!combatantId || typeof actionIndex !== 'number' || !targetId) {
        return res.status(400).json({ error: 'combatantId, actionIndex, targetId required' });
      }
      const combat = this._getCombatState();
      const c = combat.turnOrder.find(x => x.id === combatantId);
      if (!c) return res.status(404).json({ error: 'combatant not in turn order' });
      if (Array.isArray(movePath) && movePath.length > 0) {
        this._applyNpcMovement(c, { movePath, triggersOoaFrom: [], reasoning: 'DM override move' });
      }
      await this._executeNpcCombatAction(c, { actionIndex, targetId });
      res.json({ ok: true });
    });

    // Phase 1 (session0-polish) — flag toggle for positional tactics.
    // Use during live session if the tactical brain misbehaves: POST with
    // { useTacticalPositioning: false } to revert to the AI/basic path.
    app.post('/api/combat/set-flag', (req, res) => {
      const { useTacticalPositioning } = req.body || {};
      if (typeof useTacticalPositioning !== 'boolean') {
        return res.status(400).json({ error: 'useTacticalPositioning must be boolean' });
      }
      this.state.set('combat.useTacticalPositioning', useTacticalPositioning);
      res.json({ useTacticalPositioning });
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

    // POST /api/combat/condition-duration — add condition with auto-expiry
    app.post('/api/combat/condition-duration', (req, res) => {
      const { combatantId, condition, rounds } = req.body || {};
      if (!combatantId || !condition || !rounds) return res.status(400).json({ error: 'combatantId, condition, and rounds required' });
      const result = this.addConditionWithDuration(combatantId, condition, rounds);
      if (!result) return res.status(404).json({ error: 'Combatant not found' });
      res.json(result);
    });

    // POST /api/combat/npc-execute — DM approves an NPC combat action suggestion
    app.post('/api/combat/npc-execute', async (req, res) => {
      const { combatantId, actionIndex, targetId } = req.body || {};
      const combat = this._getCombatState();
      const c = combat.turnOrder.find(x => x.id === combatantId);
      if (!c) return res.status(404).json({ error: 'Combatant not found' });
      await this._executeNpcCombatAction(c, { actionIndex, targetId });
      res.json({ ok: true });
    });

    // GET /api/combat/loot/:combatantId — generate loot for a defeated NPC
    app.get('/api/combat/loot/:combatantId', async (req, res) => {
      const combat = this._getCombatState();
      const c = combat.turnOrder.find(x => x.id === req.params.combatantId);
      if (!c) return res.status(404).json({ error: 'Combatant not found' });
      const loot = await this._generateLoot(c);
      res.json(loot);
    });

    // POST /api/combat/shock-save — DM resolves massive damage shock save
    app.post('/api/combat/shock-save', (req, res) => {
      const { combatantId, passed } = req.body || {};
      if (!combatantId || passed === undefined) return res.status(400).json({ error: 'combatantId and passed required' });
      const result = this.resolveShockSave(combatantId, passed);
      if (!result) return res.status(404).json({ error: 'Combatant not found' });
      res.json({ ok: true, result });
    });

    // POST /api/combat/rouse — rouse a shocked combatant
    app.post('/api/combat/rouse', (req, res) => {
      const { combatantId } = req.body || {};
      if (!combatantId) return res.status(400).json({ error: 'combatantId required' });
      const result = this.rouseFromShock(combatantId);
      if (!result) return res.status(404).json({ error: 'Combatant not found' });
      res.json({ ok: true });
    });

    // POST /api/combat/stop-bleeding — stop bleeding on a combatant
    app.post('/api/combat/stop-bleeding', (req, res) => {
      const { combatantId, location } = req.body || {};
      if (!combatantId) return res.status(400).json({ error: 'combatantId required' });
      const result = this.stopBleeding(combatantId, location);
      if (!result) return res.status(404).json({ error: 'Combatant not found or not bleeding' });
      res.json({ ok: true });
    });

    // NOTE: attack, npc-roll, and actions routes are registered in
    // dashboard-service.js to ensure they're available before server.listen().
  }

  // ── NPC Tactical AI (Feature 52) ──────────────────────────────────────

  async _npcTacticalAI(combatant, combat) {
    // Phase 1 (session0-polish) — try npc-tactics first for position-aware
    // decisions. Falls through to the existing AI path if npc-tactics can't
    // decide (no map position, no reachable target, etc.). Controlled by
    // state.combat.useTacticalPositioning — defaults to true, DM can
    // disable via POST /api/combat/set-flag for safety during a session.
    const useTactical = this.state.get('combat.useTacticalPositioning');
    if (useTactical !== false) {
      try {
        const decision = await this._tryPositionalDecide(combatant, combat);
        if (decision) {
          // Apply movement along the chosen path; dispatch OoA detections.
          if (decision.movePath && decision.movePath.length > 0) {
            this._applyNpcMovement(combatant, decision);
          }
          return {
            actionIndex: decision.actionIndex,
            targetId: decision.targetId,
            reasoning: decision.reasoning
          };
        }
      } catch (err) {
        console.error('[CombatService] positional tactics threw for ' + combatant.name + ':', err.message);
      }
    }

    const aiEngine = this.orchestrator.getService('ai-engine');
    if (!aiEngine?.gemini?.available) {
      // No AI — fall back to basic tactics
      return this._basicNpcTactics(combatant, combat);
    }

    const actions = this.getActions(combatant.id);
    if (!actions.actions.length) return null;

    // Build combat context for AI
    const allies = combat.turnOrder.filter(c => c.type === 'npc' && c.isAlive && c.id !== combatant.id);
    const enemies = combat.turnOrder.filter(c => c.type === 'pc' && c.isAlive);
    const context = {
      self: { name: combatant.name, hp: combatant.hp, ac: combatant.ac, conditions: combatant.conditions },
      allies: allies.map(a => ({ name: a.name, hp: a.hp, conditions: a.conditions })),
      enemies: enemies.map(e => ({ name: e.name, hp: e.hp, ac: e.ac, conditions: e.conditions })),
      actions: actions.actions.filter(a => a.canRoll).map(a => ({ index: a.index, name: a.name, toHit: a.toHit, damage: a.damageDice, type: a.dmgType })),
      round: combat.round,
      specialAbilities: actions.specialAbilities.map(a => a.name)
    };

    try {
      const prompt = `You are the tactical brain for ${combatant.name} in D&D 5e combat.
Current state: ${JSON.stringify(context)}

Pick the BEST action. Consider:
- Who is in reach or line of sight (prefer closest reachable target)
- Use conditions/abilities strategically
- Protect allies if possible
- If badly wounded, consider defensive play
- Do not automatically pile onto the lowest-HP enemy; consider position and threat

Respond with JSON only: { "actionIndex": <number>, "targetId": "<enemy id>", "reasoning": "<brief tactical note>" }
Available targets: ${enemies.map(e => `"${e.name}" (id: check turnOrder)`).join(', ')}`;

      const result = await aiEngine.gemini.generateJSON(
        'You are a D&D 5e combat tactician. Respond with valid JSON only.',
        prompt,
        { maxTokens: 800, temperature: 0.7 }
      );

      console.log('[CombatService] AI tactical result for ' + combatant.name + ':', JSON.stringify(result));
      if (result?.actionIndex !== undefined) {
        // Validate the AI picked a rollable action — Multiattack/saves-only
        // actions (canRoll === false) can't be executed via rollNpcAction.
        const picked = actions.actions[result.actionIndex];
        if (!picked || !picked.canRoll) {
          console.warn('[CombatService] AI picked unrollable action #' + result.actionIndex + ' (' + (picked?.name || 'missing') + ') — falling back to basic tactics');
        } else {
          // Resolve targetId: exact id match → name match → fallback picker.
          // The AI often returns a character name ("Zarina Firethorn") or
          // a map token id ("hooded-stranger"); match either, otherwise
          // fall back to the 30/70 picker so a missing match doesn't
          // retarget the AI's intent onto a random combatant.
          let targetId = result.targetId;
          if (targetId && !combat.turnOrder.find(c => c.id === targetId)) {
            const lower = String(targetId).toLowerCase();
            const byName = combat.turnOrder.find(c => c.type === 'pc' && c.isAlive && (c.name || '').toLowerCase() === lower);
            const byPartial = byName || combat.turnOrder.find(c => c.type === 'pc' && c.isAlive && (c.name || '').toLowerCase().includes(lower));
            if (byPartial) targetId = byPartial.id;
            else targetId = null;
          }
          if (!targetId) {
            targetId = this._pickTarget(combatant, enemies)?.id;
          }
          return {
            actionIndex: result.actionIndex,
            targetId,
            reasoning: result.reasoning || 'AI tactical decision'
          };
        }
      } else {
        console.warn('[CombatService] AI tactical returned no actionIndex — falling back for ' + combatant.name);
      }
    } catch (err) {
      console.error('[CombatService] AI tactics error:', err.message);
    }

    const basic = this._basicNpcTactics(combatant, combat);
    console.log('[CombatService] basicNpcTactics for ' + combatant.name + ':', JSON.stringify(basic));
    return basic;
  }

  // ── Phase 1 (session0-polish) — positional tactics bridge ────────────

  /**
   * Call npc-tactics.decide() with the right slice of state.
   * Returns a decision { actionIndex, targetId, movePath, triggersOoaFrom,
   * disadvantage, tier, reasoning } or null to fall through.
   */
  async _tryPositionalDecide(combatant, combat) {
    const mapSvc = this.orchestrator.getService('map');
    if (!mapSvc) return null;
    const allTokens = this.state.get('map.tokens') || {};
    const selfTok = allTokens[combatant.id];
    if (!selfTok) return null;
    // Determine which map the combatant is on
    const mapId = mapSvc.playerMapAssignment?.[combatant.id] || mapSvc.activeMapId;
    const mapDef = mapSvc.maps.get(mapId);
    if (!mapDef) return null;

    // Filter to tokens on the same map as the combatant (PCs have
    // playerMapAssignment; NPCs default to activeMapId).
    const tokensOnMap = {};
    for (const [tid, tok] of Object.entries(allTokens)) {
      const tokMap = mapSvc.playerMapAssignment?.[tid] || mapSvc.activeMapId;
      if (tokMap === mapId) tokensOnMap[tid] = tok;
    }

    const actions = this.getActions(combatant.id);
    if (!actions?.actions?.length) return null;

    // Resolve INT score and tier override from actor config
    const actorSlug = combatant.actorSlug || selfTok.actorSlug;
    const actorCfg = actorSlug
      ? (mapSvc.customActors?.get(actorSlug) || mapSvc.srdMonsters?.find(m => m.slug === actorSlug))
      : null;
    const intScore = Number.isFinite(combatant.int)
      ? combatant.int
      : (actorCfg?.intelligence ?? 10);
    const intTierOverride = actorCfg?.int_tier || actorCfg?.int_tier_when_revealed || null;
    const speedFt = actorCfg?.speed?.walk || 30;

    // Attach the raw actor.actions array so npc-tactics.decide() can read
    // attack_bonus / damage_bonus / damage_dice for scoring. getActions
    // returns a UI-mapped shape without those fields.
    const actionsWithRaw = { ...actions, raw: actorCfg?.actions || [] };

    // Build reactionUsed set from combat state (each combatant's
    // reactionUsedThisRound flag; falsy means reaction available).
    const reactionUsedByHostiles = new Set();
    for (const c of combat.turnOrder) {
      if (c.type !== 'pc') continue;
      if (c._reactionUsedThisRound) reactionUsedByHostiles.add(c.id);
    }

    // _pathBlockedByWall is a closure over mapSvc — bind it so npc-tactics
    // can call with the standard signature.
    const pathBlockedFn = (x1, y1, x2, y2, walls) => mapSvc._pathBlockedByWall(x1, y1, x2, y2, walls);

    return NpcTactics.decide({
      combatant, combat, actions: actionsWithRaw, mapDef, tokensOnMap,
      intTierOverride, intScore, speedFt,
      pathBlockedFn, reactionUsedByHostiles
    });
  }

  /**
   * Apply the chosen movement path. Dispatches map:token_moved for each
   * step, then the final position. Detects + whispers opportunity attacks
   * that fired along the path (execution of OoA damage is deferred to
   * Phase 2 — for Phase 1 we detect and surface to the DM).
   */
  _applyNpcMovement(combatant, decision) {
    const mapSvc = this.orchestrator.getService('map');
    if (!mapSvc || !decision.movePath || decision.movePath.length === 0) return;

    const tokens = this.state.get('map.tokens') || {};
    const selfTok = tokens[combatant.id];
    if (!selfTok) return;

    // Just snap to end position — a series of per-cell moves would be
    // visually busy and the player-bridge map only renders current
    // positions, not interpolated paths.
    const finalStep = decision.movePath[decision.movePath.length - 1];
    const updated = { ...selfTok, x: finalStep.x, y: finalStep.y };
    this.state.set(`map.tokens.${combatant.id}`, updated);
    this.bus.dispatch('map:token_moved', {
      tokenId: combatant.id,
      x: finalStep.x, y: finalStep.y,
      reason: 'combat-tactical'
    });

    // Whisper OoA detections. Actual damage resolution is a Phase 2
    // concern — Dave runs these by hand until that plumbing lands.
    if (decision.triggersOoaFrom && decision.triggersOoaFrom.length > 0) {
      for (const hostileId of decision.triggersOoaFrom) {
        const hostile = (this._getCombatState().turnOrder || []).find(c => c.id === hostileId);
        if (!hostile) continue;
        // Mark reaction used — prevents the same PC from getting OoA on
        // a later NPC's move in the same round.
        hostile._reactionUsedThisRound = true;
        this.bus.dispatch('dm:whisper', {
          text: `[OoA] ${combatant.name} leaves ${hostile.name}'s reach — opportunity attack available if ${hostile.name}'s reaction not yet used. Roll manually or via attack resolver.`,
          priority: 1, category: 'combat', source: 'combat-service'
        });
      }
    }

    // Reasoning whisper (low priority, story category so it routes to
    // Max and is logged alongside atmosphere)
    if (decision.reasoning) {
      this.bus.dispatch('dm:whisper', {
        text: `[tactics] ${combatant.name}: ${decision.reasoning}`,
        priority: 2, category: 'combat', source: 'combat-service'
      });
    }
  }

  _basicNpcTactics(combatant, combat) {
    const actions = this.getActions(combatant.id);
    const rollable = actions.actions.filter(a => a.canRoll);
    if (!rollable.length) return null;

    const enemies = combat.turnOrder.filter(c => c.type === 'pc' && c.isAlive);
    if (!enemies.length) return null;

    const target = this._pickTarget(combatant, enemies);
    if (!target) return null;
    return {
      actionIndex: rollable[0].index,
      targetId: target.id,
      reasoning: target._pickMode === 'random'
        ? `Target ${target.name} (random pick)`
        : `Target ${target.name} (nearest by map position)`
    };
  }

  /**
   * Target selection for NPC AI: 30% random / 70% nearest-by-map-position.
   * Returns the selected enemy (with a _pickMode tag for logging) or null.
   * Falls back to random if no map token coords are available for the
   * combatant (e.g. creature placed mid-combat without a token).
   */
  _pickTarget(combatant, enemies) {
    if (!enemies || !enemies.length) return null;
    const rollRandom = Math.random() < 0.3;
    if (rollRandom) {
      const pick = enemies[Math.floor(Math.random() * enemies.length)];
      if (pick) pick._pickMode = 'random';
      return pick;
    }
    const selfTok = this.state.get(`map.tokens.${combatant.id}`);
    if (!selfTok || typeof selfTok.x !== 'number' || typeof selfTok.y !== 'number') {
      // No position info — fall back to a random pick rather than defaulting
      // to the lowest-HP PC (Bug 1 convergence on Spurt).
      const pick = enemies[Math.floor(Math.random() * enemies.length)];
      if (pick) pick._pickMode = 'random';
      return pick;
    }
    let best = null, bestDist = Infinity;
    for (const e of enemies) {
      const tok = this.state.get(`map.tokens.${e.id}`);
      if (!tok || typeof tok.x !== 'number' || typeof tok.y !== 'number') continue;
      const dx = tok.x - selfTok.x, dy = tok.y - selfTok.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < bestDist) { bestDist = d; best = e; }
    }
    if (!best) {
      // No enemy has a token — random fallback.
      const pick = enemies[Math.floor(Math.random() * enemies.length)];
      if (pick) pick._pickMode = 'random';
      return pick;
    }
    best._pickMode = 'nearest';
    return best;
  }

  // ── Condition Duration Tracking (Feature 53) ────────────────────────────

  _syncConditionsToToken(combatantId, conditions) {
    const token = this.state.get(`map.tokens.${combatantId}`);
    if (token) {
      this.state.set(`map.tokens.${combatantId}.conditions`, [...conditions]);
    }
  }

  _processConditionExpiry(combat) {
    for (const c of combat.turnOrder) {
      if (!c._conditionDurations) continue;
      const expired = [];
      for (const [cond, info] of Object.entries(c._conditionDurations)) {
        if (info.expiresRound && combat.round > info.expiresRound) {
          expired.push(cond);
        } else if (info.expiresRound === combat.round && info.expiresTurn === 'start') {
          expired.push(cond);
        }
      }
      for (const cond of expired) {
        c.conditions = c.conditions.filter(x => x !== cond);
        delete c._conditionDurations[cond];
        this.bus.dispatch('dm:whisper', {
          text: `${c.name}: ${cond} expired`,
          priority: 3, category: 'combat'
        });
      }
      if (expired.length) this._syncConditionsToToken(c.id, c.conditions);
    }
  }

  addConditionWithDuration(combatantId, condition, durationRounds) {
    const combat = this._getCombatState();
    const c = combat.turnOrder.find(x => x.id === combatantId);
    if (!c) return null;

    const wasNew = !c.conditions.includes(condition);
    // Addition 8 — condition immunity check on add path (same logic as
    // toggleCondition). If already present we never hit this branch.
    if (wasNew) {
      const cfg = this._creatureConfigFor(c.actorSlug);
      const imms = (cfg && cfg.immunities && cfg.immunities.conditions) || [];
      if (imms.map(s => String(s).toLowerCase()).includes(String(condition).toLowerCase())) {
        this.bus.dispatch('dm:whisper', {
          text: `${c.name} is immune to ${condition} — condition not applied.`,
          priority: 2, category: 'combat'
        });
        return c;
      }
    }
    if (wasNew) c.conditions.push(condition);
    if (!c._conditionDurations) c._conditionDurations = {};
    c._conditionDurations[condition] = {
      expiresRound: combat.round + durationRounds,
      expiresTurn: 'start'
    };

    this._setCombatState(combat);
    this._syncConditionsToToken(combatantId, c.conditions);
    this._broadcastCombat('combat:condition_changed', { combatantId, conditions: c.conditions, toggled: condition });
    if (wasNew) {
      this.bus.dispatch('dm:whisper', {
        text: `${c.name} is now ${condition}.`,
        priority: 1, category: 'combat'
      });
    }
    return c;
  }

  // ── Death Save Automation (Feature 54) ───────────────────────────────

  _autoDeathSave(combatant) {
    const d20 = this._rollD20();
    let result;
    if (d20 === 20) result = 'crit_success';
    else if (d20 === 1) result = 'crit_failure';
    else if (d20 >= 10) result = 'success';
    else result = 'failure';

    console.log(`[CombatService] Auto death save for ${combatant.name}: d20=${d20} → ${result}`);

    // Apply the death save
    const c = this.deathSave(combatant.id, result);

    // Dramatic effects
    this.bus.dispatch('dm:whisper', {
      text: `DEATH SAVE: ${combatant.name} rolls ${d20} → ${result.replace('_', ' ').toUpperCase()}! (${c.deathSaves.successes}S / ${c.deathSaves.failures}F)`,
      priority: 1, category: 'combat'
    });

    // Player screen effects
    if (result === 'crit_success') {
      this.bus.dispatch('player:horror_effect', {
        playerId: combatant.id,
        type: 'screen_flash',
        payload: { color: 'rgba(201,165,78,0.4)' },
        durationMs: 500
      });
    } else if (result === 'crit_failure' || c.deathSaves.failures >= 3) {
      this.bus.dispatch('player:horror_effect', {
        playerId: combatant.id,
        type: 'terror_pulse',
        payload: {},
        durationMs: 2000
      });
    } else if (result === 'failure') {
      this.bus.dispatch('player:horror_effect', {
        playerId: combatant.id,
        type: 'damage_flash',
        payload: { intensity: 0.3, shake: 3 },
        durationMs: 300
      });
    }

    // Check if dead
    if (c.deathSaves.failures >= 3) {
      this.bus.dispatch('dm:whisper', {
        text: `${combatant.name} HAS DIED. Three failed death saves.`,
        priority: 1, category: 'combat'
      });
      this.bus.dispatch('player:horror_effect', {
        playerId: 'all',
        type: 'screen_flash',
        payload: { color: 'rgba(139,0,0,0.3)' },
        durationMs: 800
      });
    }

    return { d20, result, deathSaves: c.deathSaves };
  }

  // ── Loot Generator (Feature 55) ──────────────────────────────────────

  async _generateLoot(combatant) {
    const aiEngine = this.orchestrator.getService('ai-engine');

    // Get actor data for context
    const mapSvc = this.orchestrator.getService('map');
    const actor = combatant.actorSlug ? (mapSvc?.customActors?.get(combatant.actorSlug) || mapSvc?.srdMonsters?.find(m => m.slug === combatant.actorSlug)) : null;
    const cr = actor?.challenge_rating || '0';

    if (!aiEngine?.gemini?.available) {
      // Basic loot table
      return this._basicLoot(combatant.name, cr);
    }

    try {
      const npcState = this.state.get(`npcs.${combatant.id}`) || {};
      const storyBeats = (this.state.get('story.beats') || []).filter(b => b.status === 'completed').map(b => b.name);

      const prompt = `Generate loot for defeated ${combatant.name} (CR ${cr}) in a gothic horror D&D 5e campaign set in 1274 Central Europe.

NPC info: ${npcState.trueIdentity || combatant.name}, ${npcState.role || 'enemy'}
Story context: ${storyBeats.length ? 'Completed beats: ' + storyBeats.join(', ') : 'Early in session'}

Generate 1-3 items that are:
- Story-relevant (plant hooks for future sessions, reveal lore)
- Period-appropriate (1274 medieval Eastern Europe)
- Some useful, some atmospheric/narrative

Respond with JSON: { "items": [{ "name": "...", "description": "...", "type": "weapon|armor|consumable|lore|treasure|key", "value": "Xgp", "hook": "optional future story hook" }], "gold": <number> }`;

      const result = await aiEngine.gemini.generateJSON(
        'You are a D&D 5e loot designer for gothic horror campaigns. Respond with valid JSON only.',
        prompt
      );

      if (result?.items) return result;
    } catch (err) {
      console.error('[CombatService] Loot generation error:', err.message);
    }

    return this._basicLoot(combatant.name, cr);
  }

  _basicLoot(name, cr) {
    const crNum = parseFloat(cr) || 0;
    const gold = Math.floor(Math.random() * (crNum * 10 + 5)) + 1;
    const items = [];
    if (crNum >= 3) {
      items.push({ name: 'Bloodstained Journal', description: `A worn leather journal belonging to ${name}. The pages are filled with cryptic notes.`, type: 'lore', value: '0gp' });
    }
    if (crNum >= 5) {
      items.push({ name: 'Dark Iron Key', description: 'A heavy key forged from dark iron. It feels unnaturally cold.', type: 'key', value: '0gp', hook: 'Opens something in a future location' });
    }
    return { items, gold };
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

    // NPC turn automation (Feature 52) + Death save automation (Feature 54)
    this.bus.subscribe('combat:next_turn', async (env) => {
      const combat = this._getCombatState();
      if (!combat.active) return;

      const current = combat.turnOrder[combat.currentTurn];
      if (!current || !current.isAlive) return;

      // Process condition expiry at start of turn
      this._processConditionExpiry(combat);
      this._setCombatState(combat);

      // Process bleeding at start of bleeding creature's turn
      if (current._bleeding && current._bleeding.length > 0) {
        this._processBleedingTick(current);
      }

      // Process shock countdown
      if (current._shockRoundsLeft && current._shockRoundsLeft > 0) {
        current._shockRoundsLeft--;
        if (current._shockRoundsLeft <= 0) {
          this.rouseFromShock(current.id);
        } else {
          this.bus.dispatch('dm:whisper', {
            text: `${current.name} is in shock — ${current._shockRoundsLeft} round(s) remaining. Medicine DC8 to rouse.`,
            priority: 3, category: 'combat'
          });
        }
      }

      // Death save automation for PCs at 0 HP
      if (current.type === 'pc' && current.hp.current === 0) {
        this._autoDeathSave(current);
        return; // Death save IS their turn
      }

      // NPC tactical AI
      if (current.type === 'npc') {
        const trustLevel = this.state.get('session.aiTrustLevel') || 'manual';
        let decision = null;
        try {
          decision = await this._npcTacticalAI(current, combat);
        } catch (err) {
          console.error(`[CombatService] _npcTacticalAI threw for ${current.name}:`, err.message);
          this.bus.dispatch('dm:whisper', {
            text: `[COMBAT] ${current.name}: tactical AI crashed (${err.message}) — manual resolution required`,
            priority: 1, category: 'combat', source: 'combat-service'
          });
        }

        if (!decision) {
          try { decision = this._basicNpcTactics(current, combat); } catch (e) {
            console.error(`[CombatService] _basicNpcTactics threw for ${current.name}:`, e.message);
          }
        }

        if (decision) {
          if (trustLevel === 'autopilot') {
            await this._executeNpcCombatAction(current, decision);
          } else {
            this.bus.dispatch('combat:npc_suggestion', {
              combatantId: current.id,
              combatantName: current.name,
              ...decision
            });
            this.bus.dispatch('dm:whisper', {
              text: `[Combat AI] ${current.name}: ${decision.reasoning}`,
              priority: 2, category: 'combat'
            });
          }
        } else {
          // Surface the silent failure to the DM so turns never silently skip.
          this.bus.dispatch('dm:whisper', {
            text: `[COMBAT] ${current.name}'s turn — no AI decision available (no actions parsed for actorSlug="${current.actorSlug}"). Resolve manually or use /api/combat/npc-execute.`,
            priority: 1, category: 'combat', source: 'combat-service'
          });
        }
      }
    }, 'combat');

    // Sync conditions to map tokens on condition change
    this.bus.subscribe('combat:condition_changed', (env) => {
      const { combatantId, conditions } = env.data;
      if (combatantId && conditions) {
        this._syncConditionsToToken(combatantId, conditions);
      }
    }, 'combat');

    // NPC death → generate loot (Feature 55)
    this.bus.subscribe('combat:hp_changed', async (env) => {
      const { combatantId, newHp } = env.data;
      if (newHp > 0) return;

      const combat = this._getCombatState();
      const c = combat.turnOrder.find(x => x.id === combatantId);
      if (!c || c.type === 'pc' || c.isAlive) return; // Only dead NPCs

      console.log(`[CombatService] ${c.name} defeated — generating loot`);
      const loot = await this._generateLoot(c);

      this.bus.dispatch('combat:loot_generated', {
        combatantId: c.id,
        combatantName: c.name,
        loot
      });

      this.bus.dispatch('dm:whisper', {
        text: `LOOT from ${c.name}: ${loot.gold}gp, ${loot.items.map(i => i.name).join(', ')}`,
        priority: 2, category: 'combat'
      });
    }, 'combat');

    // Addition 3 — player-initiated combat. Stage the pending initiation
    // for the DM to confirm via POST /api/combat/initiate. We do NOT
    // start combat here — the comm-router has already asked the DM to
    // confirm; the route handler in _setupRoutes does the actual start.
    this.bus.subscribe('combat:player_initiated', (env) => {
      const data = env.data || {};
      this.state.set('combat.pendingInitiation', {
        targetId: data.targetId,
        targetName: data.targetName,
        initiatedBy: data.playerId,
        timestamp: Date.now()
      });
    }, 'combat');

    // Addition 4 — player joins active combat mid-fight. Comm-router
    // dispatches this when a not-yet-in-combat player declares an action.
    // Insert at correct initiative position (turn order is sorted high-
    // to-low). No-op if combat isn't active or the player is somehow
    // already there.
    this.bus.subscribe('combat:player_joins', (env) => {
      const data = env.data || {};
      const combat = this._getCombatState();
      if (!combat.active) return;
      const { playerId, playerName, initiative } = data;
      if (!playerId || !Number.isFinite(initiative)) return;

      // Find this player's token (PC tokens are usually keyed by playerId)
      const tokens = this.state.get('map.tokens') || {};
      const tokenEntry = Object.entries(tokens).find(([tid, t]) =>
        tid === playerId
        || (t && (t.playerId === playerId || t.id === playerId || t.actorSlug === playerId))
      );
      if (!tokenEntry) {
        this.bus.dispatch('dm:whisper', {
          text: `Combat: ${playerName || playerId} wants to join but no map token found. Place a token first.`,
          priority: 1, category: 'combat'
        });
        return;
      }
      const [tokenId, token] = tokenEntry;

      // Already in combat? bail
      if ((combat.turnOrder || []).some(c => c && (c.id === tokenId || c.playerId === playerId))) return;

      const newCombatant = {
        id: tokenId,
        playerId,
        name: token.name || playerName || playerId,
        type: 'pc',
        initiative,
        initRoll: initiative,
        initMod: 0,
        hp: token.hp || { current: 10, max: 10 },
        ac: token.ac || 10,
        conditions: [],
        deathSaves: { successes: 0, failures: 0 },
        isAlive: true
      };

      // Insert at the right initiative position (turnOrder is sorted desc).
      // findIndex returns first slot where existing initiative is LOWER —
      // splice in there. If no such slot, push to end.
      if (!combat.turnOrder) combat.turnOrder = [];
      const insertAt = combat.turnOrder.findIndex(c => (c?.initiative ?? -Infinity) < initiative);
      if (insertAt === -1) {
        combat.turnOrder.push(newCombatant);
      } else {
        combat.turnOrder.splice(insertAt, 0, newCombatant);
        // If we inserted at or before currentTurn, the pointer needs to move
        // one slot right so it still references the same combatant.
        if (insertAt <= combat.currentTurn) combat.currentTurn += 1;
      }

      this._setCombatState(combat);
      this._broadcastCombat('combat:combatant_added', { combatant: newCombatant });

      this.bus.dispatch('dm:whisper', {
        text: `${newCombatant.name} inserted into turn order at initiative ${initiative}.`,
        priority: 2, category: 'combat'
      });
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
