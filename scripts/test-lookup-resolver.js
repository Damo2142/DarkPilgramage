/**
 * scripts/test-lookup-resolver.js
 *
 * Task 8 of session0-polish follow-up. Exercises world-clock-service's
 * _resolveLookups helper — walks event payloads looking for `_lookup`
 * markers and replaces their x/y with resolved runtime positions.
 *
 * Scenarios:
 *   - <id>-token-position → adjacent tile
 *   - <id>-token-position-exact → exact coords
 *   - Missing token → x/y left alone
 *   - Mover adjacency preference — pick the tile closest to the mover
 *   - Nested inside data.to → resolves in place
 *   - Original data object is NOT mutated (deep clone)
 */

class MockBus {
  constructor() { this.dispatched = []; this.subscribers = new Map(); }
  dispatch(event, data) { this.dispatched.push({ event, data }); }
  subscribe(event, fn) {
    if (!this.subscribers.has(event)) this.subscribers.set(event, []);
    this.subscribers.get(event).push(fn);
  }
}
class MockState {
  constructor(s) { this._s = JSON.parse(JSON.stringify(s || {})); }
  get(k) { const p = k.split('.'); let v = this._s; for (const pp of p) { if (v == null) return undefined; v = v[pp]; } return v; }
  set(k, v) { const p = k.split('.'); let o = this._s; for (let i = 0; i < p.length - 1; i++) { if (!o[p[i]]) o[p[i]] = {}; o = o[p[i]]; } o[p[p.length-1]] = v; }
}

const WorldClockService = require('../services/world/world-clock-service');

function makeWC(stateSeed = {}) {
  const bus = new MockBus();
  const state = new MockState(stateSeed);
  const svc = new WorldClockService();
  svc.orchestrator = { bus, state, config: {}, getService: () => null };
  svc.bus = bus; svc.state = state; svc.config = {};
  return { svc, bus, state };
}

let passed = 0, failed = 0;
const failures = [];
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; failures.push(msg); console.log(`  ✗ ${msg}`); }
}
function section(t) { console.log(`\n── ${t} ──`); }

// ─── Scenario 1: adjacent lookup ───
section('<id>-token-position → adjacent');
{
  const { svc } = makeWC({
    map: { gridSize: 140, tokens: {
      ed: { x: 1000, y: 500 },
      'patron-farmer': { x: 2000, y: 500 }
    }}
  });
  const input = {
    entityId: 'patron-farmer',
    to: { x: 0, y: 0, _lookup: 'ed-token-position' }
  };
  const resolved = svc._resolveLookups(input);
  assert(!!resolved.to, 'to object still present');
  assert(resolved.to._lookup === undefined, '_lookup marker stripped');
  // Adjacent should be one of the 8 offsets around (1000, 500) with gridSize 140
  const dx = Math.abs(resolved.to.x - 1000);
  const dy = Math.abs(resolved.to.y - 500);
  assert(dx <= 140 && dy <= 140 && (dx === 140 || dy === 140),
    `resolved to adjacent tile (got ${resolved.to.x}, ${resolved.to.y})`);
}

// ─── Scenario 2: exact lookup ───
section('<id>-token-position-exact → exact coords');
{
  const { svc } = makeWC({
    map: { gridSize: 140, tokens: { ed: { x: 1000, y: 500 } } }
  });
  const input = { to: { x: 0, y: 0, _lookup: 'ed-token-position-exact' } };
  const resolved = svc._resolveLookups(input);
  assert(resolved.to.x === 1000 && resolved.to.y === 500, 'exact coords returned');
}

// ─── Scenario 3: unresolvable ───
section('Unresolvable lookup keeps original x/y');
{
  const { svc } = makeWC({ map: { gridSize: 140, tokens: {} } });
  const input = { to: { x: 999, y: 888, _lookup: 'nobody-token-position' } };
  const resolved = svc._resolveLookups(input);
  assert(resolved.to.x === 999, 'x preserved');
  assert(resolved.to.y === 888, 'y preserved');
  assert(resolved.to._lookup === undefined, 'marker stripped');
}

// ─── Scenario 4: mover adjacency preference ───
section('Mover adjacency — prefer the closest tile to the mover');
{
  const { svc } = makeWC({
    map: { gridSize: 140, tokens: {
      ed:             { x: 1000, y: 500 },
      'patron-farmer': { x: 2000, y: 500 }
    }}
  });
  const input = {
    entityId: 'patron-farmer',
    to: { x: 0, y: 0, _lookup: 'ed-token-position' }
  };
  const resolved = svc._resolveLookups(input);
  // Mover (patron-farmer) is at x=2000 — east of ed at x=1000. Closest
  // adjacent tile to ed FROM mover's position is the east side of ed
  // (x = 1000 + 140 = 1140).
  assert(resolved.to.x === 1140 && resolved.to.y === 500,
    `resolved to east-adjacent of ed (got ${resolved.to.x}, ${resolved.to.y})`);
}

// ─── Scenario 5: does not mutate original input ───
section('Input object not mutated');
{
  const { svc } = makeWC({
    map: { gridSize: 140, tokens: { ed: { x: 1000, y: 500 } } }
  });
  const input = { to: { x: 0, y: 0, _lookup: 'ed-token-position' } };
  const inputClone = JSON.parse(JSON.stringify(input));
  svc._resolveLookups(input);
  assert(JSON.stringify(input) === JSON.stringify(inputClone),
    'original input untouched (deep clone works)');
}

// ─── Scenario 6: nested deep inside payload ───
section('Nested lookup resolution');
{
  const { svc } = makeWC({
    map: { gridSize: 140, tokens: { ed: { x: 1000, y: 500 } } }
  });
  const input = {
    dispatchEvents: [
      { event: 'token:move', data: { entityId: 'x', to: { x: 0, y: 0, _lookup: 'ed-token-position-exact' } } }
    ]
  };
  const resolved = svc._resolveLookups(input);
  const sub = resolved.dispatchEvents[0].data.to;
  assert(sub.x === 1000 && sub.y === 500, 'nested _lookup resolved');
}

console.log(`\n══ RESULTS ══`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
if (failed > 0) {
  console.log('\nFailures:');
  failures.forEach(f => console.log(`  • ${f}`));
  process.exit(1);
}
console.log('\nAll _lookup resolver tests passed.');
process.exit(0);
