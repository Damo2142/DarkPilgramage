/**
 * scripts/test-vladislav-awareness.js
 *
 * Task 6 of session0-polish follow-up. Exercises _tickVladislavAwareness
 * by instantiating AmbientLifeService against a mock orchestrator and
 * firing the tick at a sequence of game-clock timestamps.
 *
 * Scenarios:
 *   - 17:45 → neutral
 *   - 18:30 → unease
 *   - 20:05 → sharpened_unease (time-based)
 *   - Dominik arrived flag → forces sharpened_unease (flag-based)
 *   - 21:05 → window_watch, token moves to east window
 *   - recognition flag at 21:16 → recognition
 *   - 21:25 after recognition → calculating
 *   - 22:00 → reactive
 *   - 06:00 next day → departure
 *   - Midnight wrap doesn't regress phase
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
  reset() { this.dispatched = []; }
}

class MockState {
  constructor(s) { this._s = JSON.parse(JSON.stringify(s || {})); }
  get(k) { const p = k.split('.'); let v = this._s; for (const pp of p) { if (v == null) return undefined; v = v[pp]; } return v; }
  set(k, v) { const p = k.split('.'); let o = this._s; for (let i = 0; i < p.length - 1; i++) { if (!o[p[i]]) o[p[i]] = {}; o = o[p[i]]; } o[p[p.length-1]] = v; }
}

const AmbientLife = require('../services/ambient-life/ambient-life-service');

function makeAmbient() {
  const bus = new MockBus();
  const state = new MockState({});
  const orchestrator = { bus, state, config: {}, getService: () => null };
  const svc = new AmbientLife();
  svc.orchestrator = orchestrator;
  svc.bus = bus;
  svc.state = state;
  svc.config = {};
  // Initialize internal state normally set in constructor
  svc._vladislavState = { awarenessPhase: 'neutral', lastAnnouncedPhase: null, tokenMovedToWindow: false };
  return { svc, bus, state };
}

// Seed a hooded-stranger token so the window-move side effect has something to move
function seedVladToken(state) {
  state.set('map.tokens.hooded-stranger', {
    id: 'hooded-stranger', x: 4100, y: 700,
    actorSlug: 'hooded-stranger', type: 'npc', name: 'Vladislav'
  });
  state.set('npcs.hooded-stranger', {});
}

// Simulate a tick at a specific hour/minute
function tick(svc, h, m) {
  const totalMinutes = h * 60 + m;
  svc._tickVladislavAwareness(h, m, totalMinutes);
}

let passed = 0, failed = 0;
const failures = [];
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; failures.push(msg); console.log(`  ✗ ${msg}`); }
}
function section(t) { console.log(`\n── ${t} ──`); }

// ─── Scenario 1: neutral at 17:45 ───
section('17:45 — neutral');
{
  const { svc, state } = makeAmbient();
  seedVladToken(state);
  tick(svc, 17, 45);
  // Before 18:00 and before any flag — phase should remain neutral
  assert(svc._vladislavState.awarenessPhase === 'neutral', 'phase stays neutral before 18:00');
}

// ─── Scenario 2: unease at 18:30 ───
section('18:30 — unease');
{
  const { svc, state, bus } = makeAmbient();
  seedVladToken(state);
  tick(svc, 17, 45);
  tick(svc, 18, 30);
  assert(svc._vladislavState.awarenessPhase === 'unease', 'advances to unease at 18:00+');
  assert(bus.events('creature:vladislav_phase_change').length >= 1, 'dispatched phase_change');
}

// ─── Scenario 3: sharpened_unease at 20:05 (time-based) ───
section('20:05 — sharpened_unease (time-based)');
{
  const { svc, state } = makeAmbient();
  seedVladToken(state);
  tick(svc, 17, 45);
  tick(svc, 20, 5);
  assert(svc._vladislavState.awarenessPhase === 'sharpened_unease', 'sharpened_unease at 20:00+');
}

// ─── Scenario 4: Dominik arrival flag forces sharpened_unease early ───
section('Dominik arrival flag forces sharpened_unease');
{
  const { svc, state } = makeAmbient();
  seedVladToken(state);
  state.set('flags.dominik_arrived', true);
  tick(svc, 19, 30);
  assert(svc._vladislavState.awarenessPhase === 'sharpened_unease', 'flag advances ahead of 20:00 clock');
}

// ─── Scenario 5: window_watch at 21:05 + token moves ───
section('21:05 — window_watch and token move');
{
  const { svc, state, bus } = makeAmbient();
  seedVladToken(state);
  tick(svc, 17, 45);
  tick(svc, 20, 5);
  bus.reset();
  tick(svc, 21, 5);
  assert(svc._vladislavState.awarenessPhase === 'window_watch', 'advances to window_watch at 21:00+');
  const tokMoved = bus.events('map:token_moved').find(e => e.data.tokenId === 'hooded-stranger');
  assert(!!tokMoved, 'map:token_moved dispatched for vlad token');
  if (tokMoved) {
    assert(tokMoved.data.x === 4700 && tokMoved.data.y === 1260, 'token snapped to east window (4700, 1260)');
    assert(tokMoved.data.reason === 'ambient-life-phase-change', 'reason tagged');
  }
  assert(svc._vladislavState.tokenMovedToWindow === true, 'tokenMovedToWindow flag set');
}

// ─── Scenario 6: recognition flag at 21:16 ───
section('21:16 — recognition flag triggers phase');
{
  const { svc, state } = makeAmbient();
  seedVladToken(state);
  tick(svc, 17, 45);
  tick(svc, 20, 5);
  tick(svc, 21, 5);
  state.set('flags.vladislav_knows_about_dominik', true);
  tick(svc, 21, 16);
  assert(svc._vladislavState.awarenessPhase === 'recognition', 'advances to recognition');
}

// ─── Scenario 7: calculating after recognition (21:25) ───
section('21:25 — calculating');
{
  const { svc, state } = makeAmbient();
  seedVladToken(state);
  state.set('flags.vladislav_knows_about_dominik', true);
  tick(svc, 21, 16);
  tick(svc, 21, 25);
  assert(svc._vladislavState.awarenessPhase === 'calculating', 'advances to calculating 5 min after recognition');
}

// ─── Scenario 8: reactive at 22:00 ───
section('22:00 — reactive');
{
  const { svc, state } = makeAmbient();
  seedVladToken(state);
  tick(svc, 17, 45);
  tick(svc, 22, 0);
  assert(svc._vladislavState.awarenessPhase === 'reactive', 'reactive at 22:00');
}

// ─── Scenario 9: departure at 06:00 next day ───
section('06:00 next day — departure');
{
  const { svc, state } = makeAmbient();
  seedVladToken(state);
  tick(svc, 17, 45);
  tick(svc, 22, 0);          // reactive
  tick(svc, 6, 0);           // 06:00 next day — departure
  assert(svc._vladislavState.awarenessPhase === 'departure', 'departure at 06:00 next day');
}

// ─── Scenario 10: midnight wrap doesn't regress ───
section('Midnight wrap — no regression');
{
  const { svc, state } = makeAmbient();
  seedVladToken(state);
  tick(svc, 22, 0);          // reactive
  tick(svc, 0, 30);          // 00:30 next day — should stay reactive
  tick(svc, 3, 0);           // 03:00 — still reactive
  assert(svc._vladislavState.awarenessPhase === 'reactive', 'stays reactive past midnight, before dawn');
}

console.log(`\n══ RESULTS ══`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
if (failed > 0) {
  console.log('\nFailures:');
  failures.forEach(f => console.log(`  • ${f}`));
  process.exit(1);
}
console.log('\nAll Vladislav awareness tests passed.');
process.exit(0);
