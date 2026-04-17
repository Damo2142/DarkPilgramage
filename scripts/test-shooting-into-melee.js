/**
 * scripts/test-shooting-into-melee.js
 *
 * Task 3 of session0-polish follow-up. Exercises processRangedAttack:
 *   - Alone target → normal resolution, no disadvantage, no friendly fire
 *   - Target with ally within 5ft → disadvantage (lower of two d20s) applied
 *   - Miss with ally within 5ft, d4=1 → friendly fire lands on ally
 *   - Miss with ally within 5ft, d4 != 1 → no friendly fire
 *   - Miss with no allies adjacent → no friendly fire
 *
 * To make friendly-fire outcomes deterministic we stub Math.random
 * per-scenario to force the d4 result.
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

const CombatService = require('../services/combat/combat-service');

function makeCombatService() {
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
  svc.bus = bus;
  svc.state = state;
  svc.config = {};
  svc._setupEventListeners();
  return { svc, bus, state, mapSvc };
}

function seedCombat(state, combatants) {
  state.set('combat', { active: true, round: 1, turnOrder: combatants, currentTurn: 0, turnHistory: [] });
  const tokens = {};
  for (const c of combatants) if (c.x != null) tokens[c.id] = { x: c.x, y: c.y, type: c.type };
  state.set('map.tokens', tokens);
}

let passed = 0, failed = 0;
const failures = [];
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; failures.push(msg); console.log(`  ✗ ${msg}`); }
}
function section(t) { console.log(`\n── ${t} ──`); }

// Force Math.random to a sequence of values (consumed in order).
function stubRandom(values) {
  const origRandom = Math.random;
  let i = 0;
  Math.random = () => {
    const v = values[i % values.length];
    i++;
    return v;
  };
  return () => { Math.random = origRandom; };
}

// Small helper to build an NPC target with conditions array
function npc(id, x, y, hp = 20, ac = 13, name = id) {
  return { id, name, type: 'npc', actorSlug: 'wolf', hp: { current: hp, max: hp }, ac,
    isAlive: true, conditions: [], x, y };
}
function pc(id, x, y, hp = 18, ac = 15, name = id) {
  return { id, name, type: 'pc', hp: { current: hp, max: hp }, ac,
    isAlive: true, conditions: [], x, y };
}

// ─── Scenario 1: alone target, clean hit ───
section('Scenario 1 — Alone target, clean shot');
{
  const { svc, bus, state } = makeCombatService();
  const shooter = pc('nick', 400, 400, 17, 15);
  const enemy   = npc('wolf-1', 1000, 400, 11, 13);   // ~30ft east, no adjacent allies
  seedCombat(state, [shooter, enemy]);

  const res = svc.processRangedAttack({
    shooterId: 'nick', targetId: 'wolf-1',
    d20: 18, toHit: 5, damage: 6, damageType: 'piercing', weaponName: 'Shortbow'
  });

  assert(res.disadvantage === false, 'no disadvantage when target is alone');
  assert(res.alliesAdjacentCount === 0, 'no allies counted as adjacent');
  assert(res.friendlyFire === false, 'no friendly fire on a hit');
  assert(res.hit === true, 'attack hit (18+5=23 vs AC 13)');
}

// ─── Scenario 2: ally within 5ft, disadvantage applied ───
section('Scenario 2 — Disadvantage when target has ally adjacent');
{
  const { svc, bus, state } = makeCombatService();
  const shooter = pc('nick', 400, 400);
  const enemy   = npc('wolf-1', 1000, 400);
  const allyOfEnemy = npc('wolf-2', 1000, 540);   // 5ft south of wolf-1
  seedCombat(state, [shooter, enemy, allyOfEnemy]);

  // Force Math.random so the "disadvantage re-roll" gives 1 (low) — with
  // d20First=15 (passed in) and d20Second=1, min=1 → miss.
  const restore = stubRandom([
    0.0,   // d20 second roll → 1 (Math.floor(0 * 20)+1 = 1)
    0.5    // d4 for friendly fire on miss → 3 (Math.floor(0.5*4)+1 = 3, not 1 → no FF)
  ]);
  const res = svc.processRangedAttack({
    shooterId: 'nick', targetId: 'wolf-1',
    d20: 15, toHit: 5, damage: 6, damageType: 'piercing', weaponName: 'Shortbow'
  });
  restore();

  assert(res.disadvantage === true, 'disadvantage flag set (any creature adj)');
  assert(res.anyAdjacentCount === 1, 'one creature (NPC wolf) adjacent — triggers disadvantage');
  assert(res.alliesAdjacentCount === 0, 'no shooter-side allies adjacent — no friendly-fire pool');
  assert(res.d20Used === 1, 'used the lower d20 (1)');
  assert(res.hit === false, '1+5 = 6 vs AC 13 misses');
  assert(res.friendlyFire === false, 'no FF possible — no allies adjacent');
  assert(res.d4 === undefined, 'd4 not rolled — no allies to hit');
}

// ─── Scenario 3: miss with ally adjacent, d4=1 → friendly fire ───
// Updated Saturday testing: per 5e, disadvantage fires for ANY creature
// adjacent to target; friendly fire REDIRECT only picks from shooter's-side.
// Use PC ally (ed) adjacent to target to exercise the friendly-fire pool.
section('Scenario 3 — Friendly fire hits the shooter-side adjacent ally');
{
  const { svc, bus, state } = makeCombatService();
  const shooter = pc('nick', 400, 400);
  const wolfA   = npc('wolf-1', 1000, 400);
  // Ed is a PC on shooter's side, 5ft south of wolf-1 → counts as friendly-fire victim
  const edAlly  = pc('ed', 1000, 540, 18, 15);
  seedCombat(state, [shooter, wolfA, edAlly]);

  // Need to force:
  //   - d20 second (disadvantage re-roll) → miss: give 0.0 (rolls 1)
  //   - d4 → 1: give 0.0 (Math.floor(0*4)+1 = 1)
  //   - random ally pick → 0.0 picks first (ed is only shooter-side adj)
  const restore = stubRandom([0.0, 0.0, 0.0]);
  const res = svc.processRangedAttack({
    shooterId: 'nick', targetId: 'wolf-1',
    d20: 15, toHit: 5, damage: 7, damageType: 'piercing', weaponName: 'Shortbow'
  });
  restore();

  assert(res.hit === false, 'shot missed (disadvantage pulled d20 to 1)');
  assert(res.friendlyFire === true, 'friendly fire fired on d4=1');
  assert(res.victimId === 'ed', 'victim is the adjacent PC ally ed');
  assert(res.victimDamage === 7, 'victim took the full damage');
  assert(res.d4 === 1, 'd4 captured as 1');

  // Check dispatched events
  const ffEvent = bus.events('combat:friendly_fire');
  assert(ffEvent.length === 1, 'combat:friendly_fire dispatched');
  if (ffEvent.length === 1) {
    assert(ffEvent[0].data.victim === 'ed', 'event carries victim id');
    assert(ffEvent[0].data.damage === 7, 'event carries damage');
  }
  const ffWhispers = bus.events('dm:whisper').filter(w => /FRIENDLY FIRE/.test(w.data.text || ''));
  assert(ffWhispers.length >= 1, 'DM earbud received [FRIENDLY FIRE] whisper');
}

// ─── Scenario 4: miss with NO allies adjacent → no friendly fire ───
section('Scenario 4 — No adjacent allies, plain miss');
{
  const { svc, bus, state } = makeCombatService();
  const shooter = pc('nick', 400, 400);
  const enemy   = npc('wolf-1', 1000, 400);
  seedCombat(state, [shooter, enemy]);

  const res = svc.processRangedAttack({
    shooterId: 'nick', targetId: 'wolf-1',
    d20: 2, toHit: 5, damage: 6, damageType: 'piercing', weaponName: 'Shortbow'
  });

  assert(res.hit === false, '2+5=7 vs AC 13 misses');
  assert(res.friendlyFire === false, 'no friendly fire without adjacent allies');
  assert(res.d4 === undefined, 'no d4 rolled (nobody to hit)');
}

// ─── Scenario 5: two PC allies adjacent to target, friendly fire picks one ───
section('Scenario 5 — Two PC allies adjacent, d4=1 picks one');
{
  const { svc, bus, state } = makeCombatService();
  const shooter = pc('nick', 400, 400);
  const wolfA   = npc('wolf-1', 1000, 400);
  const edAlly  = pc('ed', 1000, 540, 18, 15);     // south of target
  const kimAlly = pc('kim', 1140, 400, 22, 13);    // east of target
  seedCombat(state, [shooter, wolfA, edAlly, kimAlly]);

  // Stub: d20 second = 0 (miss), d4 = 0 (→1, friendly fire), pick = 0.6 (→ index 1)
  const restore = stubRandom([0.0, 0.0, 0.6]);
  const res = svc.processRangedAttack({
    shooterId: 'nick', targetId: 'wolf-1',
    d20: 15, toHit: 5, damage: 5, damageType: 'piercing', weaponName: 'Shortbow'
  });
  restore();

  assert(res.friendlyFire === true, 'friendly fire fired');
  assert(res.alliesAdjacentCount === 2, 'two PC allies adjacent');
  assert(res.victimId === 'kim', 'picked kim via 0.6 → index 1');
}

console.log(`\n══ RESULTS ══`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
if (failed > 0) {
  console.log('\nFailures:');
  failures.forEach(f => console.log(`  • ${f}`));
  process.exit(1);
}
console.log('\nAll shooting-into-melee tests passed.');
process.exit(0);
