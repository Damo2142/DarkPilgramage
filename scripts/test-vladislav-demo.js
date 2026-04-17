/**
 * scripts/test-vladislav-demo.js
 *
 * Task 5 of session0-polish follow-up. Exercises the Vladislav three-stage
 * demo state machine and non-lethal mercy clamp in combat-service.
 *
 * Scenarios:
 *   - First PC attack on Vladislav → stage 1, no damage, scripted speech
 *   - Second PC attack → stage 2, no damage
 *   - Third PC attack → stage 3, no damage, Frightful Presence fires
 *   - Fourth PC attack → stage 4, normal damage applies
 *   - Vladislav attacks PC, damage would kill → clamped to leave PC at 1 HP
 *   - Vladislav attacks PC for non-lethal amount → full damage applies
 *   - Kill switch vladislavAutoDemo=false → demo skipped entirely
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
  updateDread(playerId, newScore) { this.set(`players.${playerId}.dread`, newScore); }
  updateHorror(playerId, newScore) { this.set(`players.${playerId}.horror`, newScore); }
}

const CombatService = require('../services/combat/combat-service');

function makeSvc() {
  const bus = new MockBus();
  const state = new MockState({});
  const mapSvc = {
    maps: new Map([['test-map', { gridSize: 140, walls: [] }]]),
    activeMapId: 'test-map',
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

function vlad(hp = 144) {
  return { id: 'hooded-stranger', name: 'Vladislav', type: 'npc', actorSlug: 'hooded-stranger',
    hp: { current: hp, max: 144 }, ac: 16, isAlive: true, conditions: [], x: 400, y: 400 };
}
function ed(hp = 18) {
  return { id: 'ed', name: 'Ed', type: 'pc',
    hp: { current: hp, max: 18 }, ac: 13, isAlive: true, conditions: [], x: 540, y: 400 };
}
function seedCombat(state, combatants) {
  state.set('combat', { active: true, round: 1, turnOrder: combatants, currentTurn: 0, turnHistory: [] });
  const tokens = {};
  for (const c of combatants) if (c.x != null) tokens[c.id] = { x: c.x, y: c.y, type: c.type, actorSlug: c.actorSlug };
  state.set('map.tokens', tokens);
}

let passed = 0, failed = 0;
const failures = [];
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; failures.push(msg); console.log(`  ✗ ${msg}`); }
}
function section(t) { console.log(`\n── ${t} ──`); }

// ─── Scenarios 1-4: Demo stages + breakthrough ───
section('Stages 1 → 2 → 3 → 4 on successive PC attacks');
{
  const { svc, bus, state } = makeSvc();
  seedCombat(state, [vlad(), ed()]);

  const r1 = svc.processAttack('ed', 'hooded-stranger', 25, 8, 'piercing', false, 'Dagger');
  assert(r1.hit === false, 'stage 1 — no hit registered');
  assert(r1.damage === 0, 'stage 1 — no damage');
  assert(r1.vladislavDemoStage === 1, 'demo stage is 1');
  assert(bus.events('npc:scripted_speech').length === 1, 'stage 1 fires a scripted speech');

  const r2 = svc.processAttack('ed', 'hooded-stranger', 25, 8, 'piercing', false, 'Dagger');
  assert(r2.damage === 0, 'stage 2 — no damage');
  assert(r2.vladislavDemoStage === 2, 'demo stage is 2');

  const r3 = svc.processAttack('ed', 'hooded-stranger', 25, 8, 'piercing', false, 'Dagger');
  assert(r3.damage === 0, 'stage 3 — no damage');
  assert(r3.vladislavDemoStage === 3, 'demo stage is 3');
  assert(bus.events('combat:frightful_presence').length === 1, 'stage 3 dispatches Frightful Presence');
  const fp = bus.events('combat:frightful_presence')[0].data;
  assert(fp.saveDC === 18, 'Frightful Presence DC 18');
  assert(fp.saveType === 'WIS', 'WIS save');

  const r4 = svc.processAttack('ed', 'hooded-stranger', 25, 8, 'piercing', false, 'Dagger');
  assert(r4.vladislavDemoStage === undefined, 'stage 4+ is not part of demo response');
  assert(r4.hit === true, 'stage 4 — attack hits normally');
  assert(r4.damage > 0, 'stage 4 — damage applies');
}

// ─── Scenario 5: Vladislav strikes PC, mercy clamps the killing blow ───
section('Vladislav attack mercy — clamp to 1 HP');
{
  const { svc, bus, state } = makeSvc();
  const edLow = ed(10);
  seedCombat(state, [vlad(), edLow]);

  // Ed has 10 HP. Vladislav attacks for 50 — should clamp to 9 (leave Ed at 1)
  const r = svc.processAttack('hooded-stranger', 'ed', 22, 50, 'piercing', false, 'Claws');
  assert(r.hit === true, 'Vladislav hits');
  assert(r.damage === 9, `damage clamped to 9 (was 50, Ed had 10 HP)`);
  assert(r.vladislavMercy === true, 'mercy flag set');
  const mercy = bus.events('dm:whisper').filter(w => /VLADISLAV MERCY/.test(w.data.text || ''));
  assert(mercy.length === 1, 'DM whispered [VLADISLAV MERCY]');

  // Check ed's actual HP
  const combat = state.get('combat');
  const edAfter = combat.turnOrder.find(c => c.id === 'ed');
  assert(edAfter.hp.current === 1, 'Ed ended at exactly 1 HP');
}

// ─── Scenario 6: Vladislav strikes for non-lethal amount, no clamp ───
section('Vladislav attack for non-lethal damage — no clamp');
{
  const { svc, bus, state } = makeSvc();
  const edHealthy = ed(18);
  seedCombat(state, [vlad(), edHealthy]);

  const r = svc.processAttack('hooded-stranger', 'ed', 22, 5, 'piercing', false, 'Claws');
  assert(r.hit === true, 'Vladislav hits');
  assert(r.damage === 5, 'damage unmodified (5 < 18)');
  assert(r.vladislavMercy === false, 'no mercy flag');
}

// ─── Scenario 7: Kill switch off — demo + mercy disabled ───
section('Kill switch vladislavAutoDemo=false');
{
  const { svc, bus, state } = makeSvc();
  state.set('flags.vladislavAutoDemo', false);
  seedCombat(state, [vlad(), ed()]);

  const r = svc.processAttack('ed', 'hooded-stranger', 25, 8, 'piercing', false, 'Dagger');
  assert(r.hit === true, 'with demo disabled, attack hits');
  assert(r.damage > 0, 'with demo disabled, damage applies');
  assert(r.vladislavDemoStage === undefined, 'no demo stage tracked');
}

// ─── Scenario 8: NPC attacks Vladislav don't trigger the demo ───
section('NPC (non-PC) attacking Vladislav bypasses the demo');
{
  const { svc, bus, state } = makeSvc();
  const otherNpc = { id: 'wolf-1', name: 'Wolf', type: 'npc', actorSlug: 'wolf',
    hp: { current: 11, max: 11 }, ac: 13, isAlive: true, conditions: [], x: 680, y: 400 };
  seedCombat(state, [vlad(), otherNpc]);

  const r = svc.processAttack('wolf-1', 'hooded-stranger', 20, 5, 'piercing', false, 'Bite');
  assert(r.vladislavDemoStage === undefined, 'NPC attacks do not advance demo stage');
  assert(r.hit === true, 'NPC attack hits Vladislav normally');
}

console.log(`\n══ RESULTS ══`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
if (failed > 0) {
  console.log('\nFailures:');
  failures.forEach(f => console.log(`  • ${f}`));
  process.exit(1);
}
console.log('\nAll Vladislav demo tests passed.');
process.exit(0);
