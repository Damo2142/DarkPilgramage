/**
 * scripts/test-spurt-agent.js
 *
 * Task 11 of session0-polish follow-up. Exercises _pickTacticalTarget,
 * _tacticalCallout, and the raised retreat threshold in _fallbackCombatAction.
 *
 * Scenarios:
 *   - Caster enemy in pool → picked over melee
 *   - Caster has ally within 5ft → picker skips and takes next priority
 *   - Retreat threshold: HP <= 50% → dodge
 *   - Tactical callout fires for critically wounded ally
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

const SpurtAgent = require('../services/ai/spurt-agent');

function makeAgent() {
  const bus = new MockBus();
  const state = new MockState({});
  const agent = new SpurtAgent(null, null, bus, state, {});
  return { agent, bus, state };
}

let passed = 0, failed = 0;
const failures = [];
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; failures.push(msg); console.log(`  ✗ ${msg}`); }
}
function section(t) { console.log(`\n── ${t} ──`); }

// Spurt combatant (full HP, no retreat)
const fullSpurt = () => ({
  id: 'spurt-ai-pc', name: 'Spurt', type: 'pc',
  hp: { current: 14, max: 14 }, ac: 12, isAlive: true
});
const woundedSpurt = () => ({
  id: 'spurt-ai-pc', name: 'Spurt', type: 'pc',
  hp: { current: 6, max: 14 }, ac: 12, isAlive: true  // 43% < 50% → retreat
});

// ─── Scenario 1: caster priority ───
section('Caster priority over melee');
{
  const { agent, state } = makeAgent();
  state.set('map.tokens', {
    'spurt-ai-pc': { x: 100, y: 100 },
    'wolf-1': { x: 200, y: 100 },   // melee, 5ft east
    'wizard-1': { x: 400, y: 100 }  // caster, 15ft east
  });
  const enemies = [
    { id: 'wolf-1', name: 'Wolf', class: '', isAlive: true, hp: { current: 11, max: 11 } },
    { id: 'wizard-1', name: 'Evil Wizard', class: 'wizard', isAlive: true, hp: { current: 17, max: 17 } }
  ];
  const picked = agent._pickTacticalTarget(fullSpurt(), enemies, []);
  assert(picked && picked.id === 'wizard-1', 'wizard picked over wolf');
}

// ─── Scenario 2: caster has adjacent ally → fall through ───
section('Caster adjacent to ally → friendly-fire safety kicks in');
{
  const { agent, state } = makeAgent();
  state.set('map.tokens', {
    'spurt-ai-pc': { x: 100, y: 100 },
    'wolf-1':    { x: 200, y: 100 },
    'wizard-1':  { x: 400, y: 100 },
    'ed':        { x: 540, y: 100 }   // 5ft east of wizard, ally in danger zone
  });
  const enemies = [
    { id: 'wolf-1', name: 'Wolf', isAlive: true, hp: { current: 11, max: 11 } },
    { id: 'wizard-1', name: 'Evil Wizard', class: 'wizard', isAlive: true, hp: { current: 17, max: 17 } }
  ];
  const allies = [
    { id: 'ed', name: 'Ed', type: 'pc', isAlive: true, hp: { current: 18, max: 18 } }
  ];
  const picked = agent._pickTacticalTarget(fullSpurt(), enemies, allies);
  assert(picked && picked.id === 'wolf-1', 'wolf picked — wizard skipped due to ally adjacency');
}

// ─── Scenario 3: retreat threshold ───
section('Retreat when HP <= 50%');
{
  const { agent, state } = makeAgent();
  state.set('combat', {
    active: true, round: 1, currentTurn: 0,
    turnOrder: [
      woundedSpurt(),
      { id: 'wolf-1', name: 'Wolf', type: 'npc', isAlive: true, hp: { current: 11, max: 11 } }
    ]
  });
  state.set('map.tokens', {
    'spurt-ai-pc': { x: 100, y: 100 },
    'wolf-1': { x: 200, y: 100 }
  });
  const action = agent._fallbackCombatAction(woundedSpurt());
  assert(action.action === 'dodge', 'Spurt takes Dodge action when wounded');
  assert(/too hurt|gets behind|wall/i.test(action.dialogue), 'Spurt voices the retreat');
}

// ─── Scenario 4: no retreat at 60% HP ───
section('No retreat at 60% HP');
{
  const { agent, state } = makeAgent();
  state.set('combat', {
    active: true, turnOrder: [
      fullSpurt(),
      { id: 'wolf-1', name: 'Wolf', type: 'npc', isAlive: true, hp: { current: 11, max: 11 } }
    ]
  });
  state.set('map.tokens', {
    'spurt-ai-pc': { x: 100, y: 100 },
    'wolf-1': { x: 200, y: 100 }
  });
  // 14/14 is above 50%
  const action = agent._fallbackCombatAction(fullSpurt());
  assert(action.action !== 'dodge', 'at full HP Spurt does not dodge');
  assert(action.action === 'cast_spell' && action.spell === 'Sorcerous Burst', 'casts Sorcerous Burst');
}

// ─── Scenario 5: tactical callout fires for critically wounded ally ───
section('Tactical callout for wounded ally');
{
  const { agent } = makeAgent();
  const allies = [
    { id: 'ed', name: 'Ed', hp: { current: 3, max: 18 }, isAlive: true }   // ~17% < 30% threshold
  ];
  const enemies = [
    { id: 'wolf-1', name: 'Wolf', isAlive: true, hp: { current: 11, max: 11 } }
  ];
  const callout = agent._tacticalCallout(fullSpurt(), enemies, allies);
  assert(callout !== null, 'callout fires for critically wounded ally');
  assert(/Ed/.test(callout), 'callout names the wounded ally');
}

// ─── Scenario 6: no callout when allies healthy ───
section('No callout when all allies healthy');
{
  const { agent } = makeAgent();
  const allies = [
    { id: 'ed', name: 'Ed', hp: { current: 18, max: 18 }, isAlive: true }
  ];
  const enemies = [
    { id: 'wolf-1', name: 'Wolf', isAlive: true, hp: { current: 11, max: 11 } }
  ];
  const callout = agent._tacticalCallout(fullSpurt(), enemies, allies);
  assert(callout === null, 'no callout when allies full HP');
}

console.log(`\n══ RESULTS ══`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
if (failed > 0) {
  console.log('\nFailures:');
  failures.forEach(f => console.log(`  • ${f}`));
  process.exit(1);
}
console.log('\nAll Spurt tactical tests passed.');
process.exit(0);
