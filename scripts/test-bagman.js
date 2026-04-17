/**
 * scripts/test-bagman.js
 *
 * Task 10 of session0-polish follow-up. Exercises the 8-tier escalation
 * ladder in bagman-service.reach().
 */

class MockBus {
  constructor() { this.dispatched = []; this.subscribers = new Map(); }
  dispatch(event, data) { this.dispatched.push({ event, data: data || {} }); }
  subscribe() {}
  events(n) { return this.dispatched.filter(d => d.event === n); }
}
class MockState {
  constructor(s) { this._s = JSON.parse(JSON.stringify(s || {})); }
  get(k) { const p = k.split('.'); let v = this._s; for (const pp of p) { if (v == null) return undefined; v = v[pp]; } return v; }
  set(k, v) { const p = k.split('.'); let o = this._s; for (let i = 0; i < p.length - 1; i++) { if (!o[p[i]]) o[p[i]] = {}; o = o[p[i]]; } o[p[p.length-1]] = v; }
}

const BagmanService = require('../services/items/bagman-service');

async function makeSvc() {
  const bus = new MockBus();
  const state = new MockState({});
  const svc = new BagmanService();
  await svc.init({ bus, state, config: {}, getService: () => null });
  return { svc, bus, state };
}

let passed = 0, failed = 0;
const failures = [];
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; failures.push(msg); console.log(`  ✗ ${msg}`); }
}
function section(t) { console.log(`\n── ${t} ──`); }

(async () => {
  // ─── Scenario 1: First 8 reaches escalate predictably ───
  section('Tiers 1→8 escalation');
  {
    const { svc, bus, state } = await makeSvc();

    const tier1 = svc.reach({ playerId: 'ed', requestedItem: 'holy water' });
    assert(tier1.tier === 1, 'tier 1 on first reach');
    assert(tier1.itemDelivered === true, 'item delivered tier 1');
    assert(tier1.outcome === 'safe', 'outcome safe tier 1');
    assert(tier1.awareOfParty === false, 'not aware yet');

    const tier2 = svc.reach({ playerId: 'ed', requestedItem: 'holy water' });
    assert(tier2.tier === 2, 'tier 2 on second reach');
    assert(tier2.outcome === 'safe-watched', 'outcome safe-watched tier 2');

    const tier3 = svc.reach({ playerId: 'nick', requestedItem: 'torch' });
    assert(tier3.tier === 3, 'tier 3 on third reach');
    assert(tier3.outcome === 'item-plus-artifact', 'outcome item-plus-artifact tier 3');

    const tier4 = svc.reach({ playerId: 'kim', requestedItem: 'silver dagger' });
    assert(tier4.tier === 4, 'tier 4');
    assert(tier4.outcome === 'damp', 'damp at tier 4');

    const tier5 = svc.reach({ playerId: 'ed', requestedItem: 'stakes' });
    assert(tier5.tier === 5, 'tier 5');
    assert(tier5.outcome === 'voice-thank-you', 'tier 5 triggers voice');
    assert(tier5.awareOfParty === true, 'awareOfParty flipped at tier 5');
    const awarenessEvents = bus.events('bagman:awareness_acquired');
    assert(awarenessEvents.length === 1, 'bagman:awareness_acquired fired once');

    const tier6 = svc.reach({ playerId: 'jen', requestedItem: 'healing potion' });
    assert(tier6.outcome === 'cold-breath', 'tier 6 cold breath');

    const tier7 = svc.reach({ playerId: 'ed', requestedItem: 'holy water' });
    assert(tier7.tier === 7, 'tier 7');
    assert(/pale-finger|item-only/.test(tier7.outcome), 'tier 7 is finger or safe');

    const tier8 = svc.reach({ playerId: 'nick', requestedItem: 'stakes' });
    assert(tier8.tier === 8, 'tier 8');
    assert(tier8.outcome === 'str-save-dc12', 'tier 8 STR save DC12');
    assert(tier8.saveRequired === 'STR DC 12', 'saveRequired field set');
  }

  // ─── Scenario 2: Every reach delivers the item regardless ───
  section('Every reach delivers the item');
  {
    const { svc } = await makeSvc();
    for (let i = 1; i <= 10; i++) {
      const r = svc.reach({ playerId: 'ed', requestedItem: 'x' });
      assert(r.itemDelivered === true, `tier ${i} itemDelivered`);
    }
  }

  // ─── Scenario 3: carrier is tracked ───
  section('Carrier tracked');
  {
    const { svc, state } = await makeSvc();
    svc.reach({ playerId: 'ed', requestedItem: 'x' });
    assert(state.get('items.bag-of-holding-cellar.bagmanState.carrier') === 'ed',
      'carrier set to ed');
    svc.reach({ playerId: 'nick', requestedItem: 'y' });
    assert(state.get('items.bag-of-holding-cellar.bagmanState.carrier') === 'nick',
      'carrier updated to nick');
  }

  // ─── Scenario 4: Dispatches bagman:reach with tier + player ───
  section('bagman:reach event emission');
  {
    const { svc, bus } = await makeSvc();
    svc.reach({ playerId: 'ed', requestedItem: 'dagger' });
    const evs = bus.events('bagman:reach');
    assert(evs.length === 1, 'one bagman:reach event');
    if (evs.length === 1) {
      assert(evs[0].data.playerId === 'ed', 'event has playerId');
      assert(evs[0].data.tier === 1, 'event has tier');
      assert(evs[0].data.requestedItem === 'dagger', 'event has requestedItem');
    }
  }

  // ─── Scenario 5: reset endpoint behavior ───
  section('Reset clears state');
  {
    const { svc, state } = await makeSvc();
    svc.reach({ playerId: 'ed', requestedItem: 'x' });
    svc.reach({ playerId: 'ed', requestedItem: 'x' });
    svc._setState({ reachCount: 0, lastReachTime: null, carrier: null, awareOfParty: false });
    const next = svc.reach({ playerId: 'ed', requestedItem: 'y' });
    assert(next.tier === 1, 'after reset, tier 1 again');
  }

  console.log(`\n══ RESULTS ══`);
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  if (failed > 0) {
    console.log('\nFailures:');
    failures.forEach(f => console.log(`  • ${f}`));
    process.exit(1);
  }
  console.log('\nAll Bagman escalation tests passed.');
  process.exit(0);
})();
