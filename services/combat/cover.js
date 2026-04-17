/**
 * services/combat/cover.js — 5e cover calculation
 *
 * Given an attacker and a target, count how many wall segments and
 * large tokens sit between them on the attacker→target line. Translate
 * the count into a 5e cover level and AC bonus:
 *
 *   none            → +0
 *   half cover      → +2
 *   three-quarters  → +5
 *   full cover      → attack cannot target (treated as automatic miss)
 *
 * Intentional simplifications for Phase 1:
 *   - Each wall/closed door counts as one cover unit
 *   - Windows don't grant cover (arrows + spells pass through — abstraction)
 *   - Large (size=Large) tokens between attacker and target count as one
 *     unit each; smaller tokens don't block arrows for this engine
 *   - Three or more units collapse to "full cover — no line of sight"
 *
 * No runtime state — pure functions. Caller injects wall array and
 * token array so this module is independent of map-service specifics.
 */

/**
 * Line-segment intersection. Returns true if segment A crosses segment B
 * strictly in the open interval of A (not at the endpoints of A, so a wall
 * AT the attacker's position doesn't count).
 *
 * Copy of map-service._linesIntersect (intentionally duplicated so
 * services/combat stays independent of services/map imports).
 */
function linesIntersect(ax1, ay1, ax2, ay2, bx1, by1, bx2, by2) {
  const dax = ax2 - ax1, day = ay2 - ay1;
  const dbx = bx2 - bx1, dby = by2 - by1;
  const d = dax * dby - day * dbx;
  if (Math.abs(d) < 0.0001) return false;
  const t = ((bx1 - ax1) * dby - (by1 - ay1) * dbx) / d;
  const u = ((bx1 - ax1) * day - (by1 - ay1) * dax) / d;
  return t > 0.01 && t < 0.99 && u >= -0.001 && u <= 1.001;
}

/**
 * Returns true if a token's center is "close enough" to the attacker-target
 * line to count as blocking cover. For a Medium token we'd need a full
 * bounding-box test; for Large+ we accept anything within the token radius
 * of the line as a blocker. Keeps the math cheap.
 *
 * @param {number} distFromLine — perpendicular distance from the token center to the line
 * @param {number} gridSize — pixels per grid cell
 * @param {string} size — 'Medium' | 'Large' | 'Huge' | 'Gargantuan'
 */
function tokenBlocksLine(distFromLine, gridSize, size) {
  // Large: 2x2 squares → ~1 cell radius = gridSize
  // Huge: 3x3 → ~1.5*gridSize
  // Gargantuan: 4x4 → ~2*gridSize
  const radius = size === 'Gargantuan' ? 2 * gridSize
               : size === 'Huge'       ? 1.5 * gridSize
               : size === 'Large'      ? 0.9 * gridSize
               : 0;  // Medium or smaller — no cover grant
  return radius > 0 && distFromLine <= radius;
}

/**
 * Perpendicular distance from a point (px, py) to the line segment
 * (ax, ay) — (bx, by). Returns the shortest distance; if the point
 * projects outside the segment the endpoint distance is used.
 */
function pointToSegmentDistance(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/**
 * Compute cover for an attack from attackerTok to targetTok.
 *
 * @param {object} attackerTok — { x, y }
 * @param {object} targetTok   — { x, y }
 * @param {Array}  walls       — [{ x1, y1, x2, y2, type, open }]
 * @param {Array}  otherTokens — [{ x, y, size, id }] — exclude attacker and target
 * @param {number} gridSize    — pixels per 5ft grid cell (default 140)
 * @returns {object} { level: 'none'|'half'|'three-quarters'|'full',
 *                     acBonus: 0|2|5|Infinity, reason: string, units: number }
 */
function computeCover(attackerTok, targetTok, walls = [], otherTokens = [], gridSize = 140) {
  if (!attackerTok || !targetTok) {
    return { level: 'none', acBonus: 0, reason: 'missing positions', units: 0 };
  }
  if (typeof attackerTok.x !== 'number' || typeof targetTok.x !== 'number') {
    return { level: 'none', acBonus: 0, reason: 'non-numeric positions', units: 0 };
  }

  let units = 0;
  const reasons = [];

  // Wall blockers
  for (const w of walls) {
    if (!w || typeof w.x1 !== 'number') continue;
    const type = w.type || 'wall';
    if (type === 'window') continue;              // arrows pass through
    if (type === 'door' && w.open) continue;      // open doors don't block
    if (linesIntersect(
      attackerTok.x, attackerTok.y, targetTok.x, targetTok.y,
      w.x1, w.y1, w.x2, w.y2
    )) {
      units++;
      reasons.push(type);
      if (units >= 3) break;  // short-circuit — full cover
    }
  }

  // Large+ tokens between them
  if (units < 3) {
    for (const tok of otherTokens) {
      if (!tok || typeof tok.x !== 'number') continue;
      if (tok.id === attackerTok.id || tok.id === targetTok.id) continue;
      if (!tok.size) continue;
      const dist = pointToSegmentDistance(
        tok.x, tok.y,
        attackerTok.x, attackerTok.y,
        targetTok.x, targetTok.y
      );
      if (tokenBlocksLine(dist, gridSize, tok.size)) {
        units++;
        reasons.push(`${tok.size.toLowerCase()} token`);
        if (units >= 3) break;
      }
    }
  }

  if (units === 0) return { level: 'none', acBonus: 0, reason: 'clear line', units: 0 };
  if (units === 1) return { level: 'half', acBonus: 2, reason: reasons[0], units: 1 };
  if (units === 2) return { level: 'three-quarters', acBonus: 5, reason: reasons.join('+'), units: 2 };
  return { level: 'full', acBonus: Infinity, reason: reasons.join('+'), units };
}

module.exports = {
  computeCover,
  // Exported for tests
  linesIntersect,
  pointToSegmentDistance,
  tokenBlocksLine
};
