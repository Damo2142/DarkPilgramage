/**
 * scripts/test-aoe-check.js
 *
 * Task 12 of session0-polish follow-up. Exercises the AoE friendly-fire
 * check logic. Mocks express.app to capture the handler.
 */

class MockBus {
  constructor() { this.subscribers = new Map(); }
  dispatch() {}
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

// Express route capturer
class MockApp {
  constructor() { this.routes = {}; }
  get(path, handler) { this.routes[`GET ${path}`] = handler; }
  post(path, handler) { this.routes[`POST ${path}`] = handler; }
  put(path, handler) { this.routes[`PUT ${path}`] = handler; }
}
function mockReq(body, params = {}) { return { body, params }; }
function mockRes() {
  const r = { statusCode: 200, jsonBody: null };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.jsonBody = b; return r; };
  return r;
}

const CombatService = require('../services/combat/combat-service');

function makeSvc() {
  const bus = new MockBus();
  const state = new MockState({});
  const app = new MockApp();
  const mapSvc = {
    maps: new Map([['test-map', { gridSize: 140, walls: [] }]]),
    activeMapId: 'test-map',
    playerMapAssignment: {},
    customActors: new Map(),
    srdMonsters: [],
    _pathBlockedByWall: () => false
  };
  const dashboard = { app };
  const svc = new CombatService();
  svc.orchestrator = {
    bus, state,
    getService: (n) => n === 'map' ? mapSvc : (n === 'dashboard' ? dashboard : null)
  };
  svc.bus = bus; svc.state = state; svc.config = {};
  svc._setupEventListeners();
  svc._setupRoutes();
  return { svc, state, app };
}

let passed = 0, failed = 0;
const failures = [];
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; failures.push(msg); console.log(`  ✗ ${msg}`); }
}
function section(t) { console.log(`\n── ${t} ──`); }

function seedPcs(state, tokens) {
  const tokState = {};
  const turnOrder = [];
  for (const t of tokens) {
    tokState[t.id] = { x: t.x, y: t.y, name: t.name || t.id, type: t.type };
    turnOrder.push({
      id: t.id, name: t.name || t.id, type: t.type,
      hp: { current: 20, max: 20 }, ac: 13, isAlive: true
    });
  }
  state.set('map.tokens', tokState);
  state.set('combat', { active: true, round: 1, turnOrder, currentTurn: 0 });
}

// ─── Scenario 1: AoE hits one ally + two enemies ───
section('Fireball shape — 1 ally + 2 enemies in radius');
{
  const { svc, state, app } = makeSvc();
  seedPcs(state, [
    { id: 'nick', type: 'pc', x: 0, y: 0 },                  // caster
    { id: 'ed',   type: 'pc', x: 600, y: 0, name: 'Ed' },    // ally, ~21ft from center
    { id: 'wolf-1', type: 'npc', x: 700, y: 0, name: 'Wolf 1' },
    { id: 'wolf-2', type: 'npc', x: 700, y: 200, name: 'Wolf 2' },
    { id: 'wolf-3', type: 'npc', x: 5000, y: 5000, name: 'Far Wolf' }
  ]);
  const handler = app.routes['POST /api/combat/aoe-check'];
  assert(typeof handler === 'function', 'AoE endpoint registered');
  const req = mockReq({ casterId: 'nick', center: { x: 700, y: 100 }, radiusFt: 20 });
  const res = mockRes();
  handler(req, res);
  const body = res.jsonBody;
  assert(res.statusCode === 200, 'responds 200 on valid request');
  assert(body && Array.isArray(body.affected), 'response has affected array');
  if (body) {
    const ids = body.affected.map(a => a.id).sort();
    assert(ids.includes('ed'), 'ed (ally) in radius');
    assert(ids.includes('wolf-1'), 'wolf-1 (enemy) in radius');
    assert(ids.includes('wolf-2'), 'wolf-2 (enemy) in radius');
    assert(!ids.includes('wolf-3'), 'far wolf excluded');
    assert(body.friendlyCount === 1, 'exactly one friendly in radius');
    assert(body.enemyCount === 2, 'exactly two enemies in radius');
    assert(/AoE includes ally Ed/.test(body.warning), 'warning names the ally');
  }
}

// ─── Scenario 2: AoE with no allies in radius → no warning ───
section('AoE with enemies only → no warning');
{
  const { svc, state, app } = makeSvc();
  seedPcs(state, [
    { id: 'nick', type: 'pc', x: 0, y: 0 },
    { id: 'wolf-1', type: 'npc', x: 700, y: 0, name: 'Wolf' }
  ]);
  const handler = app.routes['POST /api/combat/aoe-check'];
  const req = mockReq({ casterId: 'nick', center: { x: 700, y: 0 }, radiusFt: 20 });
  const res = mockRes();
  handler(req, res);
  assert(res.jsonBody.friendlyCount === 0, 'no friendlies');
  assert(res.jsonBody.warning === null, 'no warning');
}

// ─── Scenario 3: missing fields → 400 ───
section('Missing fields → 400');
{
  const { svc, app } = makeSvc();
  const handler = app.routes['POST /api/combat/aoe-check'];
  const res = mockRes();
  handler(mockReq({}), res);
  assert(res.statusCode === 400, '400 on missing fields');
}

// ─── Scenario 4: cube shape uses Chebyshev ───
section('Cube shape — Chebyshev distance');
{
  const { svc, state, app } = makeSvc();
  seedPcs(state, [
    { id: 'nick', type: 'pc', x: 0, y: 0 },
    { id: 'ed', type: 'pc', x: 700, y: 700, name: 'Ed' }     // 25ft Chebyshev, 35ft Euclidean
  ]);
  const handler = app.routes['POST /api/combat/aoe-check'];
  // Thunderwave at 30ft cube at origin — ed in Chebyshev range
  const resC = mockRes();
  handler(mockReq({ casterId: 'nick', center: { x: 0, y: 0 }, radiusFt: 30, shape: 'cube' }), resC);
  assert(resC.jsonBody.affected.some(a => a.id === 'ed'), 'ed in cube at 25ft Chebyshev');

  // Same as a 30ft circle — ed is 35ft Euclidean, out of range
  const resE = mockRes();
  handler(mockReq({ casterId: 'nick', center: { x: 0, y: 0 }, radiusFt: 30, shape: 'circle' }), resE);
  assert(!resE.jsonBody.affected.some(a => a.id === 'ed'), 'ed not in 30ft Euclidean circle (35ft away)');
}

console.log(`\n══ RESULTS ══`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
if (failed > 0) {
  console.log('\nFailures:');
  failures.forEach(f => console.log(`  • ${f}`));
  process.exit(1);
}
console.log('\nAll AoE-check tests passed.');
process.exit(0);
