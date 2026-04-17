/**
 * scripts/test-combat-auto-start.js
 *
 * Task 9 of session0-polish follow-up. Exercises the combat:auto_start
 * handler in combat-service. Verifies:
 *   - Dispatches npc:arrival for each listed combatant
 *   - Collects PCs on the target map and adds them to the combatantIds
 *   - Calls startCombat (when combat isn't already active)
 *   - Skips gracefully when no combatants are provided
 *   - Adds new combatants to an existing combat rather than restarting
 */

class MockBus {
  constructor() { this.dispatched = []; this.subscribers = new Map(); }
  dispatch(event, data) {
    this.dispatched.push({ event, data: data || {} });
    for (const s of (this.subscribers.get(event) || [])) { try { s({ data }); } catch (e) {} }
  }
  subscribe(event, fn) {
    if (!this.subscribers.has(event)) this.subscribers.set(event, []);
    this.subscribers.get(event).push(fn);
  }
  events(n) { return this.dispatched.filter(d => d.event === n); }
}
class MockState {
  constructor(s) { this._s = JSON.parse(JSON.stringify(s || {})); }
  get(k) { const p = k.split('.'); let v = this._s; for (const pp of p) { if (v == null) return undefined; v = v[pp]; } return v; }
  set(k, v) { const p = k.split('.'); let o = this._s; for (let i = 0; i < p.length - 1; i++) { if (!o[p[i]]) o[p[i]] = {}; o = o[p[i]]; } o[p[p.length-1]] = v; }
  updateDread(pid, v) { this.set(`players.${pid}.dread`, v); }
}

const CombatService = require('../services/combat/combat-service');

function makeSvc() {
  const bus = new MockBus();
  const state = new MockState({});
  const mapSvc = {
    maps: new Map([['pallidhearfloor1', { gridSize: 140, walls: [] }]]),
    activeMapId: 'pallidhearfloor1',
    playerMapAssignment: {},
    customActors: new Map(),
    srdMonsters: [],
    _pathBlockedByWall: () => false
  };
  const svc = new CombatService();
  svc.orchestrator = { bus, state, getService: (n) => n === 'map' ? mapSvc : null };
  svc.bus = bus; svc.state = state; svc.config = {};
  svc._setupEventListeners();
  return { svc, bus, state };
}

// Seed PCs on the map
function seedPCs(state, pcs) {
  const tokens = {};
  for (const p of pcs) {
    tokens[p.id] = { id: p.id, x: p.x, y: p.y, type: 'pc', name: p.name, actorSlug: p.id };
  }
  state.set('map.tokens', tokens);
  const players = {};
  for (const p of pcs) {
    players[p.id] = { character: { name: p.name, hp: { current: 20, max: 20 }, ac: 14 } };
  }
  state.set('players', players);
}

let passed = 0, failed = 0;
const failures = [];
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; failures.push(msg); console.log(`  ✗ ${msg}`); }
}
function section(t) { console.log(`\n── ${t} ──`); }

// ─── Scenario 1: start combat with 1 PC + 2 wolves ───
section('Auto-start with 2 wolves + 1 PC on map');
{
  const { svc, bus, state } = makeSvc();
  seedPCs(state, [{ id: 'ed', name: 'Ed', x: 2000, y: 1900 }]);

  bus.dispatch('combat:auto_start', {
    mapId: 'pallidhearfloor1',
    narration: 'Glass explodes.',
    combatants: [
      { actorSlug: 'wolf', tokenId: 'wolf-1', x: 2500, y: 700, name: 'Wolf 1',
        hp: { current: 11, max: 11 }, ac: 13 },
      { actorSlug: 'wolf', tokenId: 'wolf-2', x: 4600, y: 2100, name: 'Wolf 2',
        hp: { current: 16, max: 16 }, ac: 13 }
    ]
  });

  const arrivals = bus.events('npc:arrival');
  assert(arrivals.length === 2, 'two npc:arrival dispatched');
  assert(arrivals[0].data.tokenId === 'wolf-1', 'first arrival is wolf-1');
  assert(arrivals[1].data.tokenId === 'wolf-2', 'second arrival is wolf-2');

  const combat = state.get('combat');
  assert(combat.active === true, 'combat is active');
  assert(combat.turnOrder.length === 3, '3 combatants in turn order (1 PC + 2 wolves)');
  const ids = combat.turnOrder.map(c => c.id).sort();
  assert(ids.includes('ed'), 'ed in turn order');
  assert(ids.includes('wolf-1'), 'wolf-1 in turn order');
  assert(ids.includes('wolf-2'), 'wolf-2 in turn order');

  const narration = bus.events('dm:whisper').filter(w => /AUTO-COMBAT/.test(w.data.text || ''));
  assert(narration.length === 1, 'narration whispered to DM');
}

// ─── Scenario 2: empty combatants list → skip ───
section('Empty combatants list → skip');
{
  const { svc, bus, state } = makeSvc();
  seedPCs(state, [{ id: 'ed', name: 'Ed', x: 2000, y: 1900 }]);
  bus.dispatch('combat:auto_start', { combatants: [] });
  const combat = state.get('combat');
  assert(!combat?.active, 'combat not started');
}

// ─── Scenario 3: combat already active → add combatants ───
section('Combat already active → additive');
{
  const { svc, bus, state } = makeSvc();
  seedPCs(state, [{ id: 'ed', name: 'Ed', x: 2000, y: 1900 }]);

  // Start combat normally first
  svc.startCombat(['ed']);
  const beforeCount = state.get('combat.turnOrder').length;

  bus.dispatch('combat:auto_start', {
    combatants: [
      { actorSlug: 'wolf', tokenId: 'wolf-3', x: 2500, y: 700, hp: { current: 11, max: 11 }, ac: 13 }
    ]
  });

  const afterCount = state.get('combat.turnOrder').length;
  assert(afterCount === beforeCount + 1, 'one combatant added to existing combat');
  const addedMsg = bus.events('dm:whisper').filter(w => /already active/i.test(w.data.text || ''));
  assert(addedMsg.length >= 1, 'DM whisper notes existing combat');
}

// ─── Scenario 4: no PCs on target map → skip ───
section('No PCs on map → skip (combat needs at least one PC)');
{
  const { svc, bus, state } = makeSvc();
  // No seedPCs — state.map.tokens is undefined
  state.set('map.tokens', {});
  bus.dispatch('combat:auto_start', {
    mapId: 'pallidhearfloor1',
    combatants: [{ actorSlug: 'wolf', tokenId: 'wolf-x', x: 100, y: 100, hp: { current: 11, max: 11 }, ac: 13 }]
  });
  const combat = state.get('combat');
  assert(!combat?.active, 'combat not started when no PCs on map');
}

console.log(`\n══ RESULTS ══`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
if (failed > 0) {
  console.log('\nFailures:');
  failures.forEach(f => console.log(`  • ${f}`));
  process.exit(1);
}
console.log('\nAll combat auto-start tests passed.');
process.exit(0);
