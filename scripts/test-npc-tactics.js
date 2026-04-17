/**
 * scripts/test-npc-tactics.js
 *
 * Standalone smoke test for services/combat/npc-tactics.js.
 * No test framework — plain assertions with pass/fail counts.
 *
 * Usage:  node scripts/test-npc-tactics.js
 *
 * Exits 0 on pass, 1 on any failure. Intended for Phase 1 of the
 * session0-polish work.
 */

const t = require('../services/combat/npc-tactics');

let passed = 0;
let failed = 0;
const failures = [];

function assert(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    failures.push(msg);
    console.log(`  ✗ ${msg}`);
  }
}

function section(title) {
  console.log(`\n── ${title} ──`);
}

// ───────────── Chebyshev distance ─────────────
section('distanceFeet');
{
  const g = 140;
  // Same square
  assert(t.distanceFeet({x:100,y:100}, {x:100,y:100}, g) === 0, 'zero distance on identical position');
  // 1 grid cell east = 5ft
  assert(t.distanceFeet({x:0,y:0}, {x:140,y:0}, g) === 5, '1 cell east = 5ft');
  // 5 cells east = 25ft
  assert(t.distanceFeet({x:0,y:0}, {x:700,y:0}, g) === 25, '5 cells east = 25ft');
  // Diagonal — Chebyshev: max of dx/dy
  assert(t.distanceFeet({x:0,y:0}, {x:420,y:280}, g) === 15, '3 east + 2 south = 15ft (Chebyshev)');
  // Different maps → Infinity
  assert(t.distanceFeet({x:0,y:0,mapId:'a'}, {x:0,y:0,mapId:'b'}, g) === Infinity, 'different maps = Infinity');
  // Missing coords → Infinity
  assert(t.distanceFeet({}, {x:0,y:0}, g) === Infinity, 'missing x = Infinity');
}

// ───────────── INT tier ─────────────
section('computeIntTier');
{
  assert(t.computeIntTier(2).label === 'feral', 'INT 2 = feral');
  assert(t.computeIntTier(4).label === 'feral', 'INT 4 = feral (boundary)');
  assert(t.computeIntTier(5).label === 'animal', 'INT 5 = animal');
  assert(t.computeIntTier(9).label === 'animal', 'INT 9 = animal (boundary)');
  assert(t.computeIntTier(10).label === 'humanoid', 'INT 10 = humanoid');
  assert(t.computeIntTier(13).label === 'humanoid', 'INT 13 = humanoid (boundary)');
  assert(t.computeIntTier(14).label === 'tactical', 'INT 14 = tactical');
  assert(t.computeIntTier(17).label === 'tactical', 'INT 17 = tactical (boundary)');
  assert(t.computeIntTier(18).label === 'masterful', 'INT 18 = masterful');
  assert(t.computeIntTier(10, 'MASTERFUL').label === 'masterful', 'override forces tier');
  assert(t.computeIntTier(null).label === 'animal', 'missing INT falls back to animal');
}

// ───────────── Range parsing ─────────────
section('getActionRange');
{
  const melee = { desc: 'Melee Weapon Attack: +4 to hit, reach 5 ft., one target.' };
  const r1 = t.getActionRange(melee);
  assert(r1.type === 'melee' && r1.reach === 5, 'parses melee reach 5ft');

  const reachWeapon = { desc: 'Melee Weapon Attack: +5 to hit, reach 10 ft., one target.' };
  const r2 = t.getActionRange(reachWeapon);
  assert(r2.type === 'melee' && r2.reach === 10, 'parses reach weapon 10ft');

  const ranged = { desc: 'Ranged Weapon Attack: +3 to hit, range 80/320 ft.' };
  const r3 = t.getActionRange(ranged);
  assert(r3.type === 'ranged' && r3.normal === 80 && r3.long === 320, 'parses ranged 80/320');

  const thrown = { desc: 'Melee or Ranged Weapon Attack: +4 to hit, reach 5 ft. or range 20/60 ft.' };
  const r4 = t.getActionRange(thrown);
  assert(r4.type === 'mixed' && r4.reach === 5, 'parses thrown mixed');
}

// ───────────── isInRange ─────────────
section('isInRange');
{
  const melee = { type: 'melee', reach: 5, normal: 0, long: 0 };
  assert(t.isInRange(melee, 5).usable === true, 'melee 5ft target in reach');
  assert(t.isInRange(melee, 10).usable === false, 'melee 10ft out of reach');

  const ranged = { type: 'ranged', reach: 0, normal: 80, long: 320 };
  assert(t.isInRange(ranged, 40).usable === true && t.isInRange(ranged, 40).disadvantage === false,
    'ranged in normal range: no disadv');
  assert(t.isInRange(ranged, 200).usable === true && t.isInRange(ranged, 200).disadvantage === true,
    'ranged at long range: disadv');
  assert(t.isInRange(ranged, 400).usable === false, 'ranged past long range: unusable');
}

// ───────────── Pathfinding: open space ─────────────
section('findPath — open map');
{
  const mapDef = { gridSize: 140, width: 4900, height: 2800, walls: [] };
  const noBlocker = (x1,y1,x2,y2,walls) => false;
  const p = t.findPath(70, 70, 4830, 2730, mapDef, [], noBlocker);
  assert(p !== null, 'finds a path across open 35x20 grid');
  assert(p.length > 0, 'returned path is non-empty');
  assert(p[p.length-1].x === 4830 && p[p.length-1].y === 2730, 'last waypoint is exact target');
}

// ───────────── Pathfinding: walled off ─────────────
section('findPath — fully walled target');
{
  // Wall the target cell on all 4 sides
  const mapDef = {
    gridSize: 140, width: 4900, height: 2800,
    walls: [
      { x1: 700, y1: 700, x2: 840, y2: 700, type: 'wall' },
      { x1: 700, y1: 840, x2: 840, y2: 840, type: 'wall' },
      { x1: 700, y1: 700, x2: 700, y2: 840, type: 'wall' },
      { x1: 840, y1: 700, x2: 840, y2: 840, type: 'wall' },
    ]
  };
  // Copy of _linesIntersect from map-service.js verbatim
  const linesIntersect = (ax1, ay1, ax2, ay2, bx1, by1, bx2, by2) => {
    const dax = ax2 - ax1, day = ay2 - ay1;
    const dbx = bx2 - bx1, dby = by2 - by1;
    const d = dax * dby - day * dbx;
    if (Math.abs(d) < 0.0001) return false;
    const u = ((bx1 - ax1) * day - (by1 - ay1) * dax) / d;
    const s = ((bx1 - ax1) * dby - (by1 - ay1) * dbx) / d;
    return s > 0.01 && s < 0.99 && u >= -0.001 && u <= 1.001;
  };
  const pathBlocked = (x1,y1,x2,y2,walls) => {
    for (const w of walls) {
      if ((w.type || 'wall') === 'door' && w.open) continue;
      if (linesIntersect(x1,y1,x2,y2, w.x1, w.y1, w.x2, w.y2)) return true;
    }
    return false;
  };
  const p = t.findPath(70, 70, 770, 770, mapDef, [], pathBlocked);
  assert(p === null, 'cannot path into fully walled cell');
}

// ───────────── trimPathToSpeed ─────────────
section('trimPathToSpeed');
{
  const path = [{x:0,y:0},{x:140,y:0},{x:280,y:0},{x:420,y:0},{x:560,y:0},{x:700,y:0}];
  const trimmed = t.trimPathToSpeed(path, 15, 140);  // 15ft speed = 3 cells
  assert(trimmed.reachable.length === 3, '15ft speed → 3 cells');
  assert(trimmed.fullPathLength === 6, 'full path length preserved');

  const trimmed30 = t.trimPathToSpeed(path, 30, 140);  // 30ft speed = 6 cells, full path fits
  assert(trimmed30.reachable.length === 6, '30ft speed → 6 cells');
}

// ───────────── Opportunity attack detection ─────────────
section('detectOpportunityAttacks');
{
  // Scenario: hostile at (280, 140), reach 5ft. NPC starts at (280, 280) — 5ft south, in reach.
  // NPC moves east to (1400, 280). Path exits reach on first step.
  const hostile = { id: 'h1', x: 280, y: 140, reach: 5 };
  const startPos = { x: 280, y: 280 };
  const path = [{x: 420, y: 280}, {x: 560, y: 280}, {x: 1400, y: 280}];
  const triggers = t.detectOpportunityAttacks(path, startPos, [hostile], false, 140);
  assert(triggers.length === 1 && triggers[0].hostileId === 'h1', 'OoA triggers when leaving reach');

  // Same scenario but disengaging
  const triggers2 = t.detectOpportunityAttacks(path, startPos, [hostile], true, 140);
  assert(triggers2.length === 0, 'disengaging suppresses OoA');

  // NPC stays within reach the whole path → no trigger
  const circlePath = [{x: 280, y: 280}];
  const triggers3 = t.detectOpportunityAttacks(circlePath, startPos, [hostile], false, 140);
  assert(triggers3.length === 0, 'no OoA when staying in reach');

  // Two hostiles both in reach at start; NPC moves away → both trigger at most once each
  const h1 = { id: 'h1', x: 280, y: 140, reach: 5 };
  const h2 = { id: 'h2', x: 420, y: 280, reach: 5 };  // east of start
  const awayPath = [{x: 280, y: 1400}];  // move south, both should trigger (left both reaches)
  const triggers4 = t.detectOpportunityAttacks(awayPath, startPos, [h1, h2], false, 140);
  assert(triggers4.length === 2, 'two hostiles each get one OoA');
}

// ───────────── decide() — integration smoke ─────────────
section('decide() integration');
{
  const mapDef = { id: 'test', gridSize: 140, width: 4900, height: 2800, walls: [] };
  const noBlocker = () => false;

  // Same-distance target preference test: both PCs 15ft from goblin on
  // opposite sides, one wounded, one full HP. ANIMAL tier should pick
  // the wounded one.
  const combatant = {
    id: 'goblin-1', name: 'Goblin', hp: {current: 7, max: 7}, ac: 15,
    type: 'npc', isAlive: true
  };
  const tokensOnMap = {
    'goblin-1': { x: 980, y: 420 },
    'pc-1':     { x: 1400, y: 420 },  // 3 cells east = 15ft, full HP
    'pc-2':     { x: 560,  y: 420 }   // 3 cells west = 15ft, wounded
  };
  const combat = {
    turnOrder: [
      combatant,
      { id: 'pc-1', name: 'Nick', hp: {current: 17, max: 17}, ac: 15, type: 'pc', isAlive: true },
      { id: 'pc-2', name: 'Kim',  hp: {current: 8, max: 22},  ac: 13, type: 'pc', isAlive: true }
    ],
    round: 1, currentTurn: 0
  };
  const actions = {
    actions: [
      { index: 0, name: 'Scimitar', canRoll: true, attack_bonus: 4, damage_dice: '1d6', damage_bonus: 2,
        desc: 'Melee Weapon Attack: +4 to hit, reach 5 ft., one target. Hit: 5 (1d6 + 2) slashing damage.' }
    ],
    raw: [
      { name: 'Scimitar', attack_bonus: 4, damage_dice: '1d6', damage_bonus: 2,
        desc: 'Melee Weapon Attack: +4 to hit, reach 5 ft., one target. Hit: 5 (1d6 + 2) slashing damage.' }
    ],
    specialAbilities: []
  };

  const decision = t.decide({
    combatant, combat, actions, mapDef, tokensOnMap,
    intScore: 8, speedFt: 30, pathBlockedFn: noBlocker
  });

  assert(decision !== null, 'decide() returns a decision for an ANIMAL-tier goblin');
  assert(decision && decision.targetId === 'pc-2', 'ANIMAL targets wounded pc-2 (8/22) over full-HP pc-1');
  assert(decision && decision.actionIndex === 0, 'picks the Scimitar action');
  assert(decision && decision.movePath.length > 0, 'moves toward target (was out of reach)');
}

// ───────────── decide() — MASTERFUL prioritizes caster over nearest ─────────────
section('decide() MASTERFUL targeting priority');
{
  const mapDef = { id: 'test', gridSize: 140, width: 4900, height: 2800, walls: [] };
  const noBlocker = () => false;

  const combatant = {
    id: 'vlad-1', name: 'Vladislav', hp: {current: 144, max: 144}, ac: 16,
    type: 'npc', isAlive: true
  };
  // Equal-distance caster priority test: both PCs at 5ft on opposite sides,
  // Vlad engaged with both. MASTERFUL should still pick the wizard.
  const tokensOnMap = {
    'vlad-1':    { x: 980, y: 420 },
    'fighter-1': { x: 840, y: 420 },  // 1 cell west = 5ft
    'wizard-1':  { x: 1120, y: 420 }  // 1 cell east = 5ft
  };
  const combat = {
    turnOrder: [
      combatant,
      { id: 'fighter-1', name: 'Zarina Firethorn', class: 'fighter',
        hp: {current: 22, max: 22}, ac: 13, type: 'pc', isAlive: true },
      { id: 'wizard-1',  name: 'Chazz Wizard',      class: 'wizard',
        hp: {current: 17, max: 17}, ac: 15, type: 'pc', isAlive: true }
    ],
    round: 1, currentTurn: 0
  };
  const actions = {
    actions: [
      { index: 0, name: 'Bite', canRoll: true, attack_bonus: 9, damage_dice: '1d6', damage_bonus: 4,
        desc: 'Melee Weapon Attack: +9 to hit, reach 5 ft.' }
    ],
    raw: [
      { name: 'Bite', attack_bonus: 9, damage_dice: '1d6', damage_bonus: 4,
        desc: 'Melee Weapon Attack: +9 to hit, reach 5 ft.' }
    ],
    specialAbilities: []
  };

  const decision = t.decide({
    combatant, combat, actions, mapDef, tokensOnMap,
    intScore: 17, intTierOverride: 'MASTERFUL', speedFt: 30, pathBlockedFn: noBlocker
  });

  assert(decision !== null, 'decide() returns a decision for MASTERFUL tier');
  assert(decision && decision.targetId === 'wizard-1',
    'MASTERFUL breaks from nearest fighter to target the wizard (caster priority overrides 5ft vs 40ft engagement)');
}

// ───────────── Summary ─────────────
console.log(`\n══ RESULTS ══`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
if (failed > 0) {
  console.log('\nFailures:');
  failures.forEach(f => console.log(`  • ${f}`));
  process.exit(1);
}
console.log('\nAll tests passed.');
process.exit(0);
