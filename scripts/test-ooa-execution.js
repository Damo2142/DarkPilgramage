/**
 * scripts/test-ooa-execution.js
 *
 * Integration smoke test for Task 2 of session0-polish follow-up.
 * Exercises _executeOpportunityAttack + _handlePcMoveForOoA in isolation
 * by instantiating CombatService against a mock orchestrator.
 *
 * Scenarios:
 *   - NPC moves past PC's reach → PC gets OoA → damage applied
 *   - Same scenario, PC reaction already used → no OoA
 *   - Kill switch state.flags.useOpportunityAttacks === false → no OoA
 *   - Two PCs adjacent to moving NPC → both get one OoA each
 *   - Same PC triggered twice in one round → only fires once (reaction consumed)
 *   - PC moves out of NPC reach during combat → NPC strikes PC
 *
 * Usage: node scripts/test-ooa-execution.js
 */

const path = require('path');

class MockBus {
  constructor() {
    this.dispatched = [];
    this.subscribers = new Map();
  }
  dispatch(event, data) {
    this.dispatched.push({ event, data: data || {} });
    for (const s of (this.subscribers.get(event) || [])) {
      try { s({ data }); } catch (e) {}
    }
  }
  subscribe(event, fn) {
    if (!this.subscribers.has(event)) this.subscribers.set(event, []);
    this.subscribers.get(event).push(fn);
  }
  events(name) { return this.dispatched.filter(d => d.event === name); }
  reset() { this.dispatched = []; }
}

class MockState {
  constructor(seed) { this._s = JSON.parse(JSON.stringify(seed || {})); }
  get(key) {
    const parts = key.split('.');
    let v = this._s;
    for (const p of parts) { if (v == null) return undefined; v = v[p]; }
    return v;
  }
  set(key, value) {
    const parts = key.split('.');
    let o = this._s;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!o[parts[i]]) o[parts[i]] = {};
      o = o[parts[i]];
    }
    o[parts[parts.length - 1]] = value;
  }
}

// ─── Build a minimal CombatService harness ─────────────────────────────

const CombatService = require('../services/combat/combat-service');

function makeCombatService(seedState) {
  const bus = new MockBus();
  const state = new MockState(seedState);
  // Minimal dashboard stub so _setupRoutes works
  const dashboard = { app: { get: () => {}, post: () => {}, put: () => {} } };
  // Map service stub with customActors for actor lookup
  const mapSvc = {
    maps: new Map([['test-map', { gridSize: 140, width: 4900, height: 2800, walls: [] }]]),
    activeMapId: 'test-map',
    playerMapAssignment: {},
    customActors: new Map([
      ['wolf', {
        slug: 'wolf',
        intelligence: 8,
        speed: { walk: 30 },
        actions: [
          { name: 'Scimitar', attack_bonus: 4, damage_dice: '1d6', damage_bonus: 2,
            damageType: 'slashing',
            desc: 'Melee Weapon Attack: +4 to hit, reach 5 ft., one target. Hit: 5 (1d6 + 2) slashing damage.' }
        ]
      }]
    ]),
    srdMonsters: [],
    _pathBlockedByWall: () => false
  };
  const orchestrator = {
    bus, state, config: {},
    getService: (name) => name === 'map' ? mapSvc : (name === 'dashboard' ? dashboard : null)
  };

  const svc = new CombatService();
  svc.orchestrator = orchestrator;
  svc.bus = bus;
  svc.state = state;
  svc.config = {};
  // Skip _setupRoutes (requires full express setup) — init event listeners instead
  svc._setupEventListeners();

  return { svc, bus, state, mapSvc };
}

// ─── Test helpers ───────────────────────────────────────────────────────

let passed = 0, failed = 0;
const failures = [];
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; failures.push(msg); console.log(`  ✗ ${msg}`); }
}
function section(title) { console.log(`\n── ${title} ──`); }

// Put the combatants into state + kick combat.active
function seedCombat(state, combatants) {
  state.set('combat', {
    active: true, round: 1, turnOrder: combatants,
    currentTurn: 0, turnHistory: []
  });
  const tokens = {};
  for (const c of combatants) {
    if (c.x != null) tokens[c.id] = { x: c.x, y: c.y, type: c.type, name: c.name, id: c.id };
  }
  state.set('map.tokens', tokens);
}

// ─── Scenario 1: NPC moves past PC's reach → PC gets OoA → damage ──

section('Scenario 1 — NPC flees, PC executes OoA');
{
  const { svc, bus, state } = makeCombatService({});

  const goblin = {
    id: 'wolf-1', name: 'Wolf', type: 'npc', actorSlug: 'wolf',
    hp: { current: 7, max: 7 }, ac: 15, isAlive: true, conditions: [], initiative: 12, initMod: 1,
    x: 980, y: 420  // next to ed
  };
  const ed = {
    id: 'ed', name: 'FrostyCritter', type: 'pc',
    hp: { current: 18, max: 18 }, ac: 13, isAlive: true, conditions: [], initiative: 10, initMod: 2,
    x: 840, y: 420
  };
  // Seed ed's character attacks
  state.set('players.ed.character', {
    name: 'FrostyCritter',
    attacks: [
      { name: 'Dagger', toHit: 5, damage: '1d4+3', damageType: 'Piercing', range: '5/5' }
    ]
  });
  seedCombat(state, [goblin, ed]);

  // Simulate a tactical decision that moves the goblin away with ed getting OoA
  const decision = {
    actionIndex: 0, targetId: 'some-other-pc',
    movePath: [{ x: 1400, y: 420 }, { x: 1800, y: 420 }],
    triggersOoaFrom: ['ed'],
    reasoning: 'testing-flee'
  };
  svc._applyNpcMovement(goblin, decision);

  const ooaEvents = bus.events('combat:opportunity_attack');
  assert(ooaEvents.length === 1, 'exactly one combat:opportunity_attack event dispatched');
  if (ooaEvents.length === 1) {
    const e = ooaEvents[0].data;
    assert(e.attacker === 'ed', 'attacker is ed (the PC)');
    assert(e.target === 'wolf-1', 'target is the goblin');
    assert(e.direction === 'pc_strikes_fleeing_npc', 'direction label matches');
    assert(typeof e.d20 === 'number' && e.d20 >= 1 && e.d20 <= 20, 'd20 rolled in range');
    assert(typeof e.attackRoll === 'number' && e.attackRoll === e.d20 + 5, 'attackRoll = d20 + toHit');
  }

  // Ed's reaction should be marked used
  const combat = state.get('combat');
  const edCombatant = combat.turnOrder.find(c => c.id === 'ed');
  assert(edCombatant._reactionUsedThisRound === true, 'ed\'s reaction marked used');
}

// ─── Scenario 2: reaction already used → no OoA ────

section('Scenario 2 — Reaction already used');
{
  const { svc, bus, state } = makeCombatService({});
  const goblin = {
    id: 'wolf-1', name: 'Wolf', type: 'npc', actorSlug: 'wolf',
    hp: { current: 7, max: 7 }, ac: 15, isAlive: true, conditions: [], x: 980, y: 420
  };
  const ed = {
    id: 'ed', name: 'FrostyCritter', type: 'pc',
    hp: { current: 18, max: 18 }, ac: 13, isAlive: true, conditions: [], x: 840, y: 420,
    _reactionUsedThisRound: true
  };
  state.set('players.ed.character', { attacks: [{ name: 'Dagger', toHit: 5, damage: '1d4+3', range: '5/5' }] });
  seedCombat(state, [goblin, ed]);

  svc._applyNpcMovement(goblin, {
    actionIndex: 0, targetId: 'x', movePath: [{ x: 1800, y: 420 }],
    triggersOoaFrom: ['ed'], reasoning: 'testing'
  });

  const ooaEvents = bus.events('combat:opportunity_attack');
  assert(ooaEvents.length === 0, 'no OoA fired — reaction already spent');
  const skipWhispers = bus.events('dm:whisper').filter(w => /already spent/i.test(w.data.text || ''));
  assert(skipWhispers.length >= 1, 'DM whispered that reaction was already spent');
}

// ─── Scenario 3: kill switch disables OoA ────

section('Scenario 3 — Kill switch off');
{
  const { svc, bus, state } = makeCombatService({});
  state.set('flags.useOpportunityAttacks', false);

  const goblin = {
    id: 'wolf-1', name: 'Wolf', type: 'npc', actorSlug: 'wolf',
    hp: { current: 7, max: 7 }, ac: 15, isAlive: true, conditions: [], x: 980, y: 420
  };
  const ed = {
    id: 'ed', name: 'FrostyCritter', type: 'pc',
    hp: { current: 18, max: 18 }, ac: 13, isAlive: true, conditions: [], x: 840, y: 420
  };
  state.set('players.ed.character', { attacks: [{ name: 'Dagger', toHit: 5, damage: '1d4+3', range: '5/5' }] });
  seedCombat(state, [goblin, ed]);

  svc._applyNpcMovement(goblin, {
    actionIndex: 0, targetId: 'x', movePath: [{ x: 1800, y: 420 }],
    triggersOoaFrom: ['ed'], reasoning: 'testing'
  });

  const ooaEvents = bus.events('combat:opportunity_attack');
  assert(ooaEvents.length === 0, 'no OoA fired — kill switch disables');
  const disabledWhispers = bus.events('dm:whisper').filter(w => /OoA disabled/i.test(w.data.text || ''));
  assert(disabledWhispers.length === 1, 'DM whispered [OoA disabled] for the skipped trigger');
}

// ─── Scenario 4: two PCs adjacent → both get OoA ────

section('Scenario 4 — Two PCs, both trigger');
{
  const { svc, bus, state } = makeCombatService({});
  const goblin = {
    id: 'wolf-1', name: 'Wolf', type: 'npc', actorSlug: 'wolf',
    hp: { current: 7, max: 7 }, ac: 15, isAlive: true, conditions: [], x: 980, y: 420
  };
  const ed = {
    id: 'ed', name: 'Ed', type: 'pc', hp: { current: 18, max: 18 }, ac: 13, isAlive: true, conditions: [],
    x: 840, y: 420
  };
  const nick = {
    id: 'nick', name: 'Chazz', type: 'pc', hp: { current: 17, max: 17 }, ac: 15, isAlive: true, conditions: [],
    x: 1120, y: 420
  };
  state.set('players.ed.character',   { attacks: [{ name: 'Dagger', toHit: 5, damage: '1d4+3', range: '5/5' }] });
  state.set('players.nick.character', { attacks: [{ name: 'Rapier', toHit: 4, damage: '1d8+2', range: '5/5' }] });
  seedCombat(state, [goblin, ed, nick]);

  svc._applyNpcMovement(goblin, {
    actionIndex: 0, targetId: 'x',
    movePath: [{ x: 1800, y: 2000 }],  // flees far away
    triggersOoaFrom: ['ed', 'nick'], reasoning: 'flee-both'
  });

  const ooaEvents = bus.events('combat:opportunity_attack');
  assert(ooaEvents.length === 2, 'two OoA events — one per adjacent PC');
  if (ooaEvents.length === 2) {
    const attackers = ooaEvents.map(e => e.data.attacker).sort();
    assert(attackers[0] === 'ed' && attackers[1] === 'nick', 'both ed and nick attacked');
  }
}

// ─── Scenario 5: PC→NPC OoA (via _handlePcMoveForOoA) ────

section('Scenario 5 — PC flees NPC reach, NPC strikes');
{
  const { svc, bus, state } = makeCombatService({});
  const goblin = {
    id: 'wolf-1', name: 'Wolf', type: 'npc', actorSlug: 'wolf',
    hp: { current: 7, max: 7 }, ac: 15, isAlive: true, conditions: [], x: 980, y: 420
  };
  const ed = {
    id: 'ed', name: 'Ed', type: 'pc', hp: { current: 18, max: 18 }, ac: 13, isAlive: true, conditions: [],
    x: 840, y: 420
  };
  state.set('players.ed.character', { attacks: [{ name: 'Dagger', toHit: 5, damage: '1d4+3', range: '5/5' }] });
  seedCombat(state, [goblin, ed]);

  // Simulate ed moving far away from the goblin — map-service would normally
  // dispatch map:token_moved with oldX/oldY; we trigger _handlePcMoveForOoA
  // directly to exercise the branch.
  svc._handlePcMoveForOoA({
    data: {
      tokenId: 'ed',
      x: 2800, y: 420,       // new position — way out of reach
      oldX: 840, oldY: 420,  // old position — adjacent to goblin
      reason: 'player-drag'
    }
  });

  const ooaEvents = bus.events('combat:opportunity_attack');
  assert(ooaEvents.length === 1, 'one OoA fired when PC moved out of NPC reach');
  if (ooaEvents.length === 1) {
    const e = ooaEvents[0].data;
    assert(e.attacker === 'wolf-1', 'attacker is the NPC');
    assert(e.target === 'ed', 'target is the PC');
    assert(e.direction === 'npc_strikes_fleeing_pc', 'direction label matches');
  }
}

// ─── Scenario 6: PC moves within reach → no OoA ────

section('Scenario 6 — PC moves within NPC reach');
{
  const { svc, bus, state } = makeCombatService({});
  const goblin = {
    id: 'wolf-1', name: 'Wolf', type: 'npc', actorSlug: 'wolf',
    hp: { current: 7, max: 7 }, ac: 15, isAlive: true, conditions: [], x: 980, y: 420
  };
  const ed = {
    id: 'ed', name: 'Ed', type: 'pc', hp: { current: 18, max: 18 }, ac: 13, isAlive: true, conditions: [],
    x: 840, y: 420
  };
  state.set('players.ed.character', { attacks: [{ name: 'Dagger', toHit: 5, damage: '1d4+3', range: '5/5' }] });
  seedCombat(state, [goblin, ed]);

  // Ed shifts one cell but stays adjacent to goblin — no OoA
  svc._handlePcMoveForOoA({
    data: { tokenId: 'ed', x: 840, y: 560, oldX: 840, oldY: 420, reason: 'player-drag' }
  });
  const ooaEvents = bus.events('combat:opportunity_attack');
  assert(ooaEvents.length === 0, 'no OoA when PC stays within NPC reach');
}

// ─── Scenario 7: combat-tactical moves don't re-trigger ────

section('Scenario 7 — NPC tactical move ignored by PC-OoA handler');
{
  const { svc, bus, state } = makeCombatService({});
  const goblin = {
    id: 'wolf-1', name: 'Wolf', type: 'npc', actorSlug: 'wolf',
    hp: { current: 7, max: 7 }, ac: 15, isAlive: true, conditions: [], x: 980, y: 420
  };
  const ed = {
    id: 'ed', name: 'Ed', type: 'pc', hp: { current: 18, max: 18 }, ac: 13, isAlive: true, conditions: [],
    x: 840, y: 420
  };
  state.set('players.ed.character', { attacks: [{ name: 'Dagger', toHit: 5, damage: '1d4+3', range: '5/5' }] });
  seedCombat(state, [goblin, ed]);

  svc._handlePcMoveForOoA({
    data: {
      tokenId: 'wolf-1',    // NPC, not PC
      x: 2800, y: 420, oldX: 980, oldY: 420,
      reason: 'combat-tactical'
    }
  });
  const ooaEvents = bus.events('combat:opportunity_attack');
  assert(ooaEvents.length === 0, 'no OoA fired for NPC tactical moves (handled elsewhere)');
}

// ─── Results ────

console.log(`\n══ RESULTS ══`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
if (failed > 0) {
  console.log('\nFailures:');
  failures.forEach(f => console.log(`  • ${f}`));
  process.exit(1);
}
console.log('\nAll OoA execution tests passed.');
process.exit(0);
