/**
 * npc-tactics.js — INT-tier tactical decision helper for NPC combat turns
 *
 * Additive module. combat-service.js delegates to this for position-aware
 * NPC decisions. If this returns null the existing _npcTacticalAI / basic
 * path runs unchanged — nothing here replaces the legacy behavior.
 *
 * Scope (Phase 1 of session0-polish):
 *   - Chebyshev distance on a 140px = 5ft grid
 *   - A* pathfinding with wall-aware collision (via map-service helpers)
 *   - Per-action range check (melee reach, ranged normal/long, spell range)
 *   - INT-tier tactical scoring (FERAL / ANIMAL / HUMANOID / TACTICAL / MASTERFUL)
 *   - Engagement commitment (in-melee NPCs do not break off at will)
 *   - Opportunity attack detection on movement paths
 *
 * Out of scope (deferred to later work):
 *   - Multi-turn planning for MASTERFUL tier (reduced to TACTICAL+flanking+readying)
 *   - Spell selection beyond "is this action within range of target"
 *   - Team coordination between allied NPCs
 *
 * No runtime state held here — all data flows in via the decide() argument.
 */

// ─── Grid geometry ──────────────────────────────────────────────────────────

const FEET_PER_GRID = 5;

/**
 * Chebyshev distance between two tokens in feet.
 * Tokens on different maps return Infinity.
 */
function distanceFeet(tokA, tokB, gridSize = 140) {
  if (!tokA || !tokB) return Infinity;
  if (tokA.mapId && tokB.mapId && tokA.mapId !== tokB.mapId) return Infinity;
  if (typeof tokA.x !== 'number' || typeof tokB.x !== 'number') return Infinity;
  const dx = Math.abs(tokA.x - tokB.x);
  const dy = Math.abs(tokA.y - tokB.y);
  const cheby = Math.max(dx, dy);
  return (cheby / gridSize) * FEET_PER_GRID;
}

// ─── A* pathfinding on grid cells ───────────────────────────────────────────

/**
 * Find a path from (fromX, fromY) to (toX, toY) in pixel coords.
 * Returns an array of {x, y} waypoints (cell centers) or null if no path.
 *
 * - mapDef must carry walls, width, height, gridSize.
 * - blockingTokenPositions is an array of {x, y} cell centers occupied by
 *   other tokens that block passage (destination cell is allowed).
 * - pathBlockedFn is an injected function with the signature of
 *   map-service._pathBlockedByWall(x1, y1, x2, y2, walls) → bool.
 */
function findPath(fromX, fromY, toX, toY, mapDef, blockingTokenPositions, pathBlockedFn) {
  const grid = mapDef.gridSize || 140;
  const cols = Math.ceil((mapDef.width || 4900) / grid);
  const rows = Math.ceil((mapDef.height || 2800) / grid);
  const walls = mapDef.walls || [];

  const toCell = (px) => Math.floor(px / grid);
  const fromCellX = toCell(fromX);
  const fromCellY = toCell(fromY);
  const toCellX = toCell(toX);
  const toCellY = toCell(toY);

  if (fromCellX === toCellX && fromCellY === toCellY) {
    return [{ x: toX, y: toY }];
  }

  const cellKey = (cx, cy) => `${cx},${cy}`;
  const cellCenter = (cx, cy) => ({
    x: cx * grid + Math.floor(grid / 2),
    y: cy * grid + Math.floor(grid / 2)
  });

  const blockedCells = new Set();
  for (const p of (blockingTokenPositions || [])) {
    blockedCells.add(cellKey(toCell(p.x), toCell(p.y)));
  }
  // Destination cell is always traversable (we want to stop there even if
  // it's flagged by a hostile token).
  blockedCells.delete(cellKey(toCellX, toCellY));

  const cheby = (ax, ay, bx, by) => Math.max(Math.abs(ax - bx), Math.abs(ay - by));

  const open = new Map();
  const closed = new Set();
  const cameFrom = new Map();
  const gScore = new Map();

  const startKey = cellKey(fromCellX, fromCellY);
  const goalKey = cellKey(toCellX, toCellY);

  gScore.set(startKey, 0);
  open.set(startKey, cheby(fromCellX, fromCellY, toCellX, toCellY));

  // Cap iterations — on a 35x20 grid A* should resolve in well under 1000
  // iterations even pathological; this guard protects against a bug causing
  // an infinite loop in a hot combat tick.
  const maxIter = Math.min(cols * rows * 4, 5000);
  let iter = 0;

  while (open.size > 0 && iter++ < maxIter) {
    // Pick the open node with the lowest fScore
    let currentKey = null;
    let currentF = Infinity;
    for (const [k, f] of open) {
      if (f < currentF) { currentF = f; currentKey = k; }
    }
    if (currentKey === null) break;
    if (currentKey === goalKey) {
      // Reconstruct path
      const path = [];
      let k = currentKey;
      while (k !== startKey) {
        const [cx, cy] = k.split(',').map(Number);
        path.push(cellCenter(cx, cy));
        k = cameFrom.get(k);
        if (!k) break;
      }
      path.reverse();
      // Replace last step with exact target coords so the NPC lands on the
      // intended tile, not the cell center.
      if (path.length > 0) path[path.length - 1] = { x: toX, y: toY };
      return path;
    }

    open.delete(currentKey);
    closed.add(currentKey);

    const [cx, cy] = currentKey.split(',').map(Number);
    const cc = cellCenter(cx, cy);

    for (let ddy = -1; ddy <= 1; ddy++) {
      for (let ddx = -1; ddx <= 1; ddx++) {
        if (ddx === 0 && ddy === 0) continue;
        const nx = cx + ddx;
        const ny = cy + ddy;
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
        const nKey = cellKey(nx, ny);
        if (closed.has(nKey)) continue;
        if (blockedCells.has(nKey) && nKey !== goalKey) continue;

        const nc = cellCenter(nx, ny);
        // Wall check on the segment between cell centers
        if (pathBlockedFn(cc.x, cc.y, nc.x, nc.y, walls)) continue;

        const tentativeG = (gScore.get(currentKey) ?? Infinity) + 1;
        if (tentativeG < (gScore.get(nKey) ?? Infinity)) {
          cameFrom.set(nKey, currentKey);
          gScore.set(nKey, tentativeG);
          open.set(nKey, tentativeG + cheby(nx, ny, toCellX, toCellY));
        }
      }
    }
  }

  return null;
}

/**
 * Given a path (array of {x,y}) and a speed in feet, trim the path to
 * the number of cells the NPC can reach this turn.
 * Returns { reachable: [...], ranOutAt: N cells, fullPathLength: M }.
 */
function trimPathToSpeed(path, speedFeet, gridSize = 140) {
  if (!path || path.length === 0) return { reachable: [], ranOutAt: 0, fullPathLength: 0 };
  const cellsAllowed = Math.floor(speedFeet / FEET_PER_GRID);
  const reachable = path.slice(0, cellsAllowed);
  return { reachable, ranOutAt: reachable.length, fullPathLength: path.length };
}

// ─── Weapon range parsing ──────────────────────────────────────────────────

/**
 * Extract range info from an NPC action description.
 * Returns { type: 'melee'|'ranged'|'mixed'|'spell', reach: ft, normal: ft, long: ft }
 * Reasonable defaults when description is absent.
 */
function getActionRange(action) {
  if (!action) return { type: 'melee', reach: 5, normal: 0, long: 0 };
  const desc = String(action.desc || action.description || '').toLowerCase();

  const rangeMatch = desc.match(/range\s+(\d+)\s*\/\s*(\d+)\s*ft/);
  const reachMatch = desc.match(/reach\s+(\d+)\s*ft/);
  const reach = reachMatch ? Number(reachMatch[1]) : 5;

  // Mixed melee+ranged (e.g. thrown hunting knife) — must be checked BEFORE
  // the pure-ranged branch, since the description will match both patterns.
  if (desc.includes('melee or ranged')) {
    return {
      type: 'mixed',
      reach,
      normal: rangeMatch ? Number(rangeMatch[1]) : 20,
      long: rangeMatch ? Number(rangeMatch[2]) : 60
    };
  }

  // Pure ranged
  if (rangeMatch) {
    return {
      type: 'ranged',
      reach: 0,
      normal: Number(rangeMatch[1]),
      long: Number(rangeMatch[2])
    };
  }

  // Spell range — these need manual curation; default to 60ft touch-or-bolt
  if ((action.name || '').match(/spell|bolt|ray|sphere|fireball/i)) {
    return { type: 'spell', reach: 0, normal: 60, long: 120 };
  }

  return { type: 'melee', reach, normal: 0, long: 0 };
}

/**
 * Is a target in range given an action's range profile and the distance in ft?
 * Returns { usable: bool, disadvantage: bool, reason: string }
 */
function isInRange(range, distFt) {
  if (range.type === 'melee' || range.type === 'spell') {
    if (distFt <= range.reach) return { usable: true, disadvantage: false, reason: 'in reach' };
    return { usable: false, disadvantage: false, reason: `out of reach (${distFt}ft > ${range.reach}ft)` };
  }
  if (range.type === 'ranged') {
    if (distFt <= range.normal) return { usable: true, disadvantage: false, reason: 'in normal range' };
    if (distFt <= range.long) return { usable: true, disadvantage: true, reason: 'in long range (disadvantage)' };
    return { usable: false, disadvantage: false, reason: `out of range (${distFt}ft > ${range.long}ft)` };
  }
  if (range.type === 'mixed') {
    if (distFt <= range.reach) return { usable: true, disadvantage: false, reason: 'in melee reach' };
    if (distFt <= range.normal) return { usable: true, disadvantage: false, reason: 'thrown at normal range' };
    if (distFt <= range.long) return { usable: true, disadvantage: true, reason: 'thrown at long range (disadvantage)' };
    return { usable: false, disadvantage: false, reason: 'out of all ranges' };
  }
  return { usable: false, disadvantage: false, reason: 'unknown range type' };
}

// ─── INT tier ──────────────────────────────────────────────────────────────

const INT_TIERS = {
  FERAL:     { rank: 1, maxInt: 4,  label: 'feral' },
  ANIMAL:    { rank: 2, maxInt: 9,  label: 'animal' },
  HUMANOID:  { rank: 3, maxInt: 13, label: 'humanoid' },
  TACTICAL:  { rank: 4, maxInt: 17, label: 'tactical' },
  MASTERFUL: { rank: 5, maxInt: 30, label: 'masterful' }
};

function computeIntTier(intScore, override) {
  if (override && INT_TIERS[override]) return INT_TIERS[override];
  if (typeof intScore !== 'number' || !Number.isFinite(intScore)) return INT_TIERS.ANIMAL;
  if (intScore <= INT_TIERS.FERAL.maxInt) return INT_TIERS.FERAL;
  if (intScore <= INT_TIERS.ANIMAL.maxInt) return INT_TIERS.ANIMAL;
  if (intScore <= INT_TIERS.HUMANOID.maxInt) return INT_TIERS.HUMANOID;
  if (intScore <= INT_TIERS.TACTICAL.maxInt) return INT_TIERS.TACTICAL;
  return INT_TIERS.MASTERFUL;
}

// ─── Target scoring ────────────────────────────────────────────────────────

/**
 * Score a (target, action) pair for an NPC given their tier and current
 * situation. Higher is more attractive. Returns a number — the caller
 * picks the max-scoring pair.
 */
function scoreTargetAction({
  target, action, range, usable, distFt, combatant, tier, engagedWith, enemiesInReach
}) {
  if (!usable.usable) return -Infinity;

  let score = 0;

  // Base damage expectation (rough): higher-damage actions score higher
  score += Number(action.damage_bonus || action.damageBonus || 0) * 2;
  const damageDice = String(action.damage_dice || action.damage || '1d6');
  const diceMatch = damageDice.match(/(\d+)d(\d+)/);
  if (diceMatch) score += Number(diceMatch[1]) * ((Number(diceMatch[2]) + 1) / 2);

  // Hit probability (rough): attack bonus minus target AC
  const atkBonus = Number(action.attack_bonus || action.attackBonus || 3);
  const hitProb = Math.max(0.05, Math.min(0.95, (21 - ((target.ac || 12) - atkBonus)) / 20));
  score *= hitProb;

  // Disadvantage (long-range ranged) penalizes score
  if (usable.disadvantage) score *= 0.55;

  // Tier-specific modifiers
  const hpPct = (target.hp?.current || 0) / Math.max(1, target.hp?.max || 1);

  switch (tier.rank) {
    case 1: // FERAL — attack nearest, no tactics
      score += Math.max(0, 200 - distFt) / 10;  // nearest gets strong boost
      break;
    case 2: // ANIMAL — prefer wounded; pack tactics if ally adjacent (not modeled here beyond scoring)
      score += (1 - hpPct) * 20;  // wounded targets preferred
      score += Math.max(0, 100 - distFt) / 10;
      break;
    case 3: // HUMANOID — threat ranking: melee > caster > ranged, prefer focus-fire
      score += Math.max(0, 100 - distFt) / 15;
      // Prefer targets with lower HP (focus fire)
      score += (1 - hpPct) * 15;
      break;
    case 4: // TACTICAL — priority targets, flanking, ready action for casters
      // Guess role by class/type markers on the target
      if (targetLooksLikeCaster(target)) score += 25;
      if (targetLooksLikeHealer(target)) score += 30;
      if (targetLooksLikeRanged(target)) score += 15;
      score += (1 - hpPct) * 10;
      // Slight distance penalty — tactical NPCs don't waste movement
      score -= distFt / 20;
      break;
    case 5: // MASTERFUL — like tactical but amplified and with patience
      if (targetLooksLikeCaster(target)) score += 40;
      if (targetLooksLikeHealer(target)) score += 45;
      if (targetLooksLikeRanged(target)) score += 20;
      score += (1 - hpPct) * 15;
      // Masterful NPCs will refuse a shot that wastes their turn — strong
      // preference for setup moves and action economy.
      score -= distFt / 30;
      break;
  }

  // Engagement commitment: if the NPC is engaged with a hostile in melee,
  // targeting someone else is penalized heavily (override only at TACTICAL+
  // with a clear tactical reason).
  if (engagedWith && engagedWith.length > 0) {
    const targetingEngaged = engagedWith.some(e => e.id === target.id);
    if (!targetingEngaged) {
      if (tier.rank <= 3) score -= 100;          // strong commitment
      else score -= 30;                          // TACTICAL+ can break off for priority
    }
  }

  return score;
}

// Heuristics on target "role" — cheap string checks, not ground truth.
function targetLooksLikeCaster(t) {
  const blob = `${t.name || ''} ${t.class || ''} ${t.actorSlug || ''}`.toLowerCase();
  return /wizard|sorcer|warlock|bard|druid|cleric/.test(blob);
}
function targetLooksLikeHealer(t) {
  const blob = `${t.name || ''} ${t.class || ''}`.toLowerCase();
  return /cleric|paladin|druid/.test(blob);
}
function targetLooksLikeRanged(t) {
  const blob = `${t.name || ''} ${t.class || ''}`.toLowerCase();
  return /ranger|archer|rogue/.test(blob);
}

// ─── Opportunity attack detection ──────────────────────────────────────────

/**
 * Given a movement path and a list of hostile tokens with their reach,
 * return an array of {hostileId, triggeredAtStep} for each OoA that fires.
 *
 * Rules:
 *   - A hostile triggers OoA when the NPC's path exits their reach (goes from
 *     within-reach at step K to outside-reach at step K+1) without
 *     disengaging.
 *   - Each hostile fires at most once per NPC's move.
 *   - Hostiles with no map position are skipped.
 */
function detectOpportunityAttacks(path, startPos, hostiles, disengaging, gridSize = 140) {
  if (disengaging) return [];
  if (!path || path.length === 0) return [];

  const triggers = [];
  const alreadyFired = new Set();

  // Build full waypoint list including start
  const waypoints = [{ x: startPos.x, y: startPos.y }, ...path];

  for (const h of hostiles) {
    if (alreadyFired.has(h.id)) continue;
    if (typeof h.x !== 'number' || typeof h.y !== 'number') continue;
    const reachFt = h.reach || 5;

    // Walk the path; find first step where we move from within-reach to out-of-reach
    let wasInReach = distanceFeet({x: waypoints[0].x, y: waypoints[0].y}, h, gridSize) <= reachFt;
    for (let i = 1; i < waypoints.length; i++) {
      const nowInReach = distanceFeet({x: waypoints[i].x, y: waypoints[i].y}, h, gridSize) <= reachFt;
      if (wasInReach && !nowInReach) {
        triggers.push({ hostileId: h.id, triggeredAtStep: i - 1 });
        alreadyFired.add(h.id);
        break;
      }
      wasInReach = nowInReach;
    }
  }

  return triggers;
}

// ─── Main decision entry point ─────────────────────────────────────────────

/**
 * Pick a (target, action, path) decision for an NPC on their turn.
 *
 * args:
 *   combatant       — { id, name, hp, ac, actorSlug, conditions, ... }
 *   combat          — { turnOrder, round, currentTurn, ... }
 *   actions         — output of combat-service.getActions(combatantId)
 *   mapDef          — current map definition with walls + gridSize
 *   tokensOnMap     — state.map.tokens (only tokens on the same map as combatant)
 *   intTierOverride — optional string 'FERAL'|'ANIMAL'|'HUMANOID'|'TACTICAL'|'MASTERFUL'
 *   intScore        — combatant's INT stat (used if override absent)
 *   speedFt         — combatant's movement speed in feet
 *   pathBlockedFn   — injected from map-service._pathBlockedByWall
 *   reactionUsedByHostiles — Set of hostile ids whose reaction is already spent this round
 *
 * Returns:
 *   { actionIndex, targetId, movePath: [{x,y}...], triggersOoaFrom: [hostileId],
 *     reachedTarget: bool, reasoning: string, tier: label, disadvantage: bool }
 *   or null if the decision logic declines (caller should fall back).
 */
function decide(args) {
  const {
    combatant, combat, actions, mapDef, tokensOnMap,
    intTierOverride, intScore, speedFt = 30, pathBlockedFn,
    reactionUsedByHostiles = new Set()
  } = args;

  if (!combatant || !actions || !actions.actions) return null;
  if (!mapDef) return null;

  const selfTok = tokensOnMap[combatant.id];
  if (!selfTok || typeof selfTok.x !== 'number' || typeof selfTok.y !== 'number') {
    // No map position — we can't do position-aware tactics. Decline and
    // let the caller fall back to the legacy 30/70 picker.
    return null;
  }

  const tier = computeIntTier(intScore, intTierOverride);
  const grid = mapDef.gridSize || 140;

  // Candidate enemies: alive PCs on same map. NPC-vs-NPC not modeled here.
  const enemies = [];
  for (const c of combat.turnOrder) {
    if (c.id === combatant.id) continue;
    if (!c.isAlive) continue;
    if (c.type !== 'pc') continue;
    const tok = tokensOnMap[c.id];
    if (!tok) continue;
    enemies.push({ ...c, x: tok.x, y: tok.y });
  }
  if (enemies.length === 0) return null;

  // Engagement state: hostiles currently within reach of the NPC
  const selfMeleeReach = 5;
  const engagedWith = enemies.filter(e =>
    distanceFeet(selfTok, e, grid) <= selfMeleeReach
  );

  // Blocking-token positions for pathfinding (exclude self)
  const blockingPositions = [];
  for (const [tid, tok] of Object.entries(tokensOnMap)) {
    if (tid === combatant.id) continue;
    if (typeof tok.x !== 'number' || typeof tok.y !== 'number') continue;
    blockingPositions.push({ x: tok.x, y: tok.y });
  }

  // Rollable actions only (matches existing contract in combat-service)
  const rollableActions = actions.actions.filter(a => a.canRoll);
  if (rollableActions.length === 0) return null;

  let best = null;
  let bestScore = -Infinity;

  for (const enemy of enemies) {
    const distFt = distanceFeet(selfTok, enemy, grid);

    for (const action of rollableActions) {
      // Map action index back through actions.actions
      const actionIndex = action.index;
      // Parse action range from the _actionData attached to the action record.
      // getActions() packages these for UI use; we need the underlying action
      // dict which may live on actions.raw[actionIndex] or on the action itself.
      const rawAction = (actions.raw && actions.raw[actionIndex]) || action;
      const range = getActionRange(rawAction);

      // Can we reach range this turn? Compute path.
      let movePath = [];
      let reachedTarget = false;
      let effectiveDistFt = distFt;

      if (range.type === 'melee' || range.type === 'spell') {
        if (distFt <= range.reach) {
          reachedTarget = true;
        } else {
          // Try to path to within-reach of target
          const pathFull = findPath(
            selfTok.x, selfTok.y,
            enemy.x, enemy.y,
            mapDef, blockingPositions, pathBlockedFn
          );
          if (!pathFull) continue;  // cannot path to target
          const trim = trimPathToSpeed(pathFull, speedFt, grid);
          movePath = trim.reachable;
          // After moving, are we within reach?
          const endPos = movePath.length > 0 ? movePath[movePath.length - 1] : selfTok;
          effectiveDistFt = distanceFeet(endPos, enemy, grid);
          reachedTarget = effectiveDistFt <= range.reach;
        }
      } else if (range.type === 'ranged' || range.type === 'mixed') {
        if (distFt <= range.long) {
          reachedTarget = true;  // can attack from current position
        } else {
          // Move to close to normal range — not strictly needed for ranged
          // actions, but useful for mixed (thrown) at edge of long range.
          const pathFull = findPath(selfTok.x, selfTok.y, enemy.x, enemy.y, mapDef, blockingPositions, pathBlockedFn);
          if (pathFull) {
            const trim = trimPathToSpeed(pathFull, speedFt, grid);
            movePath = trim.reachable;
            const endPos = movePath.length > 0 ? movePath[movePath.length - 1] : selfTok;
            effectiveDistFt = distanceFeet(endPos, enemy, grid);
          }
          reachedTarget = effectiveDistFt <= range.long;
        }
      }

      if (!reachedTarget) continue;

      const usable = isInRange(range, effectiveDistFt);
      if (!usable.usable) continue;

      const score = scoreTargetAction({
        target: enemy, action: rawAction, range, usable,
        distFt: effectiveDistFt, combatant, tier,
        engagedWith, enemiesInReach: engagedWith
      });

      if (score > bestScore) {
        bestScore = score;
        best = {
          actionIndex, target: enemy, action: rawAction, movePath,
          reachedTarget, reasoning: '', usable, distFt: effectiveDistFt
        };
      }
    }
  }

  if (!best) return null;

  // Detect opportunity attacks along the chosen path
  const hostilesForOoa = enemies
    .filter(e => !reactionUsedByHostiles.has(e.id))
    .map(e => ({ id: e.id, x: e.x, y: e.y, reach: 5 }));
  const ooa = detectOpportunityAttacks(
    best.movePath, { x: selfTok.x, y: selfTok.y },
    hostilesForOoa,
    false,  // disengage: not modeled at FERAL/ANIMAL; at TACTICAL+ the tactical
            // logic could choose to disengage but for Phase 1 we keep it simple.
    grid
  );

  const reasoning = buildReasoning(tier, best, engagedWith);

  return {
    actionIndex: best.actionIndex,
    targetId: best.target.id,
    targetName: best.target.name,
    movePath: best.movePath,
    triggersOoaFrom: ooa.map(o => o.hostileId),
    reachedTarget: true,
    disadvantage: !!best.usable.disadvantage,
    tier: tier.label,
    reasoning
  };
}

function buildReasoning(tier, best, engagedWith) {
  const parts = [`[${tier.label}]`];
  parts.push(`→ ${best.action.name || 'attack'} ${best.target.name}`);
  if (best.movePath.length > 0) {
    parts.push(`(move ${best.movePath.length} tiles, ~${best.movePath.length * FEET_PER_GRID}ft)`);
  } else {
    parts.push('(no move)');
  }
  if (best.usable.disadvantage) parts.push('DISADV (long range)');
  if (engagedWith.length > 0) {
    const targetingEngaged = engagedWith.some(e => e.id === best.target.id);
    if (targetingEngaged) parts.push('committed to engaged target');
    else parts.push('broke from engagement (tactical reason)');
  }
  return parts.join(' ');
}

module.exports = {
  // Public API used by combat-service
  decide,
  computeIntTier,
  distanceFeet,
  findPath,
  trimPathToSpeed,
  getActionRange,
  isInRange,
  detectOpportunityAttacks,
  // Constants
  INT_TIERS,
  FEET_PER_GRID,
};
