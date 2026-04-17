/**
 * scripts/test-cover.js
 *
 * Task 4 of session0-polish follow-up. Exercises services/combat/cover.js
 * computeCover() pure function — independent of combat-service wiring.
 *
 * Scenarios:
 *   - Attacker + target adjacent, no walls → none
 *   - 30ft apart through open space → none
 *   - One wall segment between → half (+2)
 *   - Two walls / corner between → three-quarters (+5)
 *   - Impenetrable wall grid (3+ walls) → full (automatic miss)
 *   - Large token between them → half
 *   - Medium token between them → none (Medium doesn't grant cover)
 *   - Window between them → none (arrows pass through)
 *   - Open door between them → none
 *   - Closed door between them → half
 */

const Cover = require('../services/combat/cover');

let passed = 0, failed = 0;
const failures = [];
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; failures.push(msg); console.log(`  ✗ ${msg}`); }
}
function section(t) { console.log(`\n── ${t} ──`); }

// ─── Scenario 1 — Adjacent, clear ───
section('Adjacent, no walls');
{
  const atk = { x: 280, y: 280 };
  const tgt = { x: 420, y: 280 };
  const c = Cover.computeCover(atk, tgt, [], [], 140);
  assert(c.level === 'none', 'level is none');
  assert(c.acBonus === 0, 'no AC bonus');
}

// ─── Scenario 2 — Open space ───
section('30ft apart through open space');
{
  const atk = { x: 280, y: 280 };
  const tgt = { x: 1120, y: 280 };   // 6 cells east = 30ft
  const c = Cover.computeCover(atk, tgt, [], [], 140);
  assert(c.level === 'none', 'level is none');
}

// ─── Scenario 3 — Single wall ───
section('Single wall between');
{
  const atk = { x: 280, y: 280 };
  const tgt = { x: 840, y: 280 };
  // wall perpendicular to line, in the middle
  const walls = [{ x1: 560, y1: 140, x2: 560, y2: 420, type: 'wall' }];
  const c = Cover.computeCover(atk, tgt, walls, [], 140);
  assert(c.level === 'half', 'level is half');
  assert(c.acBonus === 2, '+2 AC');
  assert(c.units === 1, 'one unit counted');
}

// ─── Scenario 4 — Two walls / corner ───
section('Two wall segments between');
{
  const atk = { x: 280, y: 280 };
  const tgt = { x: 1120, y: 280 };
  const walls = [
    { x1: 560, y1: 140, x2: 560, y2: 420, type: 'wall' },
    { x1: 840, y1: 140, x2: 840, y2: 420, type: 'wall' }
  ];
  const c = Cover.computeCover(atk, tgt, walls, [], 140);
  assert(c.level === 'three-quarters', 'level is three-quarters');
  assert(c.acBonus === 5, '+5 AC');
}

// ─── Scenario 5 — Full cover (3+ walls) ───
section('Full cover — three walls block');
{
  const atk = { x: 280, y: 280 };
  const tgt = { x: 1400, y: 280 };
  const walls = [
    { x1: 420, y1: 140, x2: 420, y2: 420, type: 'wall' },
    { x1: 700, y1: 140, x2: 700, y2: 420, type: 'wall' },
    { x1: 980, y1: 140, x2: 980, y2: 420, type: 'wall' },
    { x1: 1260, y1: 140, x2: 1260, y2: 420, type: 'wall' }
  ];
  const c = Cover.computeCover(atk, tgt, walls, [], 140);
  assert(c.level === 'full', 'level is full');
  assert(c.acBonus === Infinity, 'infinity AC bonus');
}

// ─── Scenario 6 — Large token between ───
section('Large token between');
{
  const atk = { x: 280, y: 280 };
  const tgt = { x: 1120, y: 280 };
  const otherTokens = [{ id: 'ogre', x: 700, y: 280, size: 'Large' }];
  const c = Cover.computeCover(atk, tgt, [], otherTokens, 140);
  assert(c.level === 'half', 'Large token grants half cover');
}

// ─── Scenario 7 — Medium token doesn't grant cover ───
section('Medium token between');
{
  const atk = { x: 280, y: 280 };
  const tgt = { x: 1120, y: 280 };
  const otherTokens = [{ id: 'human', x: 700, y: 280, size: 'Medium' }];
  const c = Cover.computeCover(atk, tgt, [], otherTokens, 140);
  assert(c.level === 'none', 'Medium token — no cover');
}

// ─── Scenario 8 — Window doesn't block ───
section('Window between (arrows pass through)');
{
  const atk = { x: 280, y: 280 };
  const tgt = { x: 840, y: 280 };
  const walls = [{ x1: 560, y1: 140, x2: 560, y2: 420, type: 'window' }];
  const c = Cover.computeCover(atk, tgt, walls, [], 140);
  assert(c.level === 'none', 'window does not grant cover');
}

// ─── Scenario 9 — Open door doesn't block ───
section('Open door between');
{
  const atk = { x: 280, y: 280 };
  const tgt = { x: 840, y: 280 };
  const walls = [{ x1: 560, y1: 140, x2: 560, y2: 420, type: 'door', open: true }];
  const c = Cover.computeCover(atk, tgt, walls, [], 140);
  assert(c.level === 'none', 'open door does not grant cover');
}

// ─── Scenario 10 — Closed door blocks ───
section('Closed door between');
{
  const atk = { x: 280, y: 280 };
  const tgt = { x: 840, y: 280 };
  const walls = [{ x1: 560, y1: 140, x2: 560, y2: 420, type: 'door', open: false }];
  const c = Cover.computeCover(atk, tgt, walls, [], 140);
  assert(c.level === 'half', 'closed door grants half cover');
}

// ─── Scenario 11 — Missing positions return none, not crash ───
section('Missing positions');
{
  const c1 = Cover.computeCover(null, { x: 100, y: 100 }, [], [], 140);
  assert(c1.level === 'none', 'null attacker → none');
  const c2 = Cover.computeCover({ x: 100 }, { x: 200, y: 100 }, [], [], 140);
  assert(c2.level === 'none', 'missing y → none');
}

console.log(`\n══ RESULTS ══`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
if (failed > 0) {
  console.log('\nFailures:');
  failures.forEach(f => console.log(`  • ${f}`));
  process.exit(1);
}
console.log('\nAll cover tests passed.');
process.exit(0);
