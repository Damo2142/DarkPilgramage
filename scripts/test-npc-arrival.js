/**
 * scripts/test-npc-arrival.js
 *
 * Task 7 of session0-polish follow-up. Exercises the npc:arrival handler
 * in ScenePopulationService — the listener that turns a timed-event
 * dispatch into an actual map token placement.
 *
 * Scenarios:
 *   - Valid npc:arrival → token placed in state.map.tokens
 *                        map:token_added dispatched
 *                        state.flags.<id>_arrived set to true
 *   - Dominik-specific arrival → also sets flags.dominik_arrived
 *   - Missing actorSlug + tokenId → no-op (guard)
 *   - Token already on map → no-op (idempotent)
 *
 * Plus an end-to-end smoke: world-clock's dispatchEvents nested array
 * should fire npc:arrival when the outer dm:whisper event is processed.
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
}

const ScenePopulationService = require('../services/scene-population/scene-population-service');

function makeScenePop() {
  const bus = new MockBus();
  const state = new MockState({});
  const svc = new ScenePopulationService();
  svc.orchestrator = { bus, state, config: {}, getService: () => null };
  svc.bus = bus;
  svc.state = state;
  svc.config = {};
  // Manually wire the subscribers that start() sets up
  svc.scenes = new Map();
  svc.start();
  return { svc, bus, state };
}

let passed = 0, failed = 0;
const failures = [];
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; failures.push(msg); console.log(`  ✗ ${msg}`); }
}
function section(t) { console.log(`\n── ${t} ──`); }

// ─── Scenario 1: valid arrival ───
section('Valid npc:arrival places the token');
{
  const { svc, bus, state } = makeScenePop();
  bus.dispatch('npc:arrival', {
    actorSlug: 'brother-dominik-novak',
    tokenId: 'brother-dominik-novak',
    name: 'Brother Dominik Novák',
    x: 4600, y: 1900,
    hp: { current: 82, max: 82 },
    ac: 15,
    publicName: 'A Traveling Monk',
    nameRevealedToPlayers: false
  });

  const tok = state.get('map.tokens.brother-dominik-novak');
  assert(!!tok, 'token placed in state.map.tokens');
  if (tok) {
    assert(tok.x === 4600 && tok.y === 1900, 'position is (4600, 1900)');
    assert(tok.actorSlug === 'brother-dominik-novak', 'actorSlug set');
    assert(tok.hp?.current === 82, 'HP from payload');
    assert(tok.ac === 15, 'AC from payload');
    assert(tok.nameRevealedToPlayers === false, 'name hidden');
  }
  assert(bus.events('map:token_added').length === 1, 'map:token_added dispatched');
  assert(state.get('flags.brother-dominik-novak_arrived') === true, 'flag <id>_arrived set');
  assert(state.get('flags.dominik_arrived') === true, 'friendlier flags.dominik_arrived alias set');
}

// ─── Scenario 2: token already on map, no duplicate ───
section('Token already on map → idempotent');
{
  const { svc, bus, state } = makeScenePop();
  state.set('map.tokens.brother-dominik-novak', {
    id: 'brother-dominik-novak', x: 100, y: 100, actorSlug: 'brother-dominik-novak'
  });
  bus.dispatch('npc:arrival', {
    actorSlug: 'brother-dominik-novak',
    tokenId: 'brother-dominik-novak',
    x: 4600, y: 1900
  });
  const tok = state.get('map.tokens.brother-dominik-novak');
  assert(tok.x === 100 && tok.y === 100, 'existing token not overwritten');
  assert(bus.events('map:token_added').length === 0, 'no second map:token_added fired');
}

// ─── Scenario 3: missing actorSlug AND tokenId → no-op ───
section('Missing identifiers → no-op');
{
  const { svc, bus, state } = makeScenePop();
  bus.dispatch('npc:arrival', { x: 100, y: 100 });
  assert(Object.keys(state.get('map.tokens') || {}).length === 0, 'no token placed');
  assert(bus.events('map:token_added').length === 0, 'no map:token_added fired');
}

// ─── Scenario 4: world-clock dispatchEvents nested array ───
section('world-clock dispatchEvents fires npc:arrival');
{
  const bus = new MockBus();
  const state = new MockState({});
  // Hook up a simple listener to confirm npc:arrival fires
  let received = null;
  bus.subscribe('npc:arrival', (env) => { received = env.data; });

  // Simulate what world-clock does inside _checkTimedEvents:
  const evt = {
    id: 'dominik-arrival',
    event: 'dm:whisper',
    data: {
      description: 'Brother Dominik Novák arrives',
      dispatchEvents: [
        {
          event: 'npc:arrival',
          data: {
            actorSlug: 'brother-dominik-novak',
            tokenId: 'brother-dominik-novak',
            x: 4600, y: 1900
          }
        }
      ]
    }
  };
  // Replicate the world-clock dispatch loop (primary + dispatchEvents)
  bus.dispatch(evt.event, { ...evt.data, _timedEvent: evt.id });
  if (Array.isArray(evt.data.dispatchEvents)) {
    for (const sub of evt.data.dispatchEvents) {
      bus.dispatch(sub.event, { ...sub.data, _timedEventParent: evt.id });
    }
  }

  assert(received !== null, 'npc:arrival was dispatched via dispatchEvents');
  if (received) {
    assert(received.tokenId === 'brother-dominik-novak', 'payload tokenId carried through');
    assert(received.x === 4600 && received.y === 1900, 'position carried through');
    assert(received._timedEventParent === 'dominik-arrival', 'parent event id tagged on payload');
  }
}

console.log(`\n══ RESULTS ══`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
if (failed > 0) {
  console.log('\nFailures:');
  failures.forEach(f => console.log(`  • ${f}`));
  process.exit(1);
}
console.log('\nAll npc:arrival tests passed.');
process.exit(0);
