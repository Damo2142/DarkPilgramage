# Phase 1 — NPC combat positioning

## 1.1–1.7 Implementation summary

Additive module `services/combat/npc-tactics.js` provides position-aware NPC decisions. Wired into `combat-service._npcTacticalAI` as an early branch with graceful fallback.

### What's built

- **`services/combat/npc-tactics.js`** (420 LOC). Pure functions, no service state:
  - `distanceFeet(a, b, gridSize)` — Chebyshev in feet (5e standard)
  - `findPath(...)` — A* on grid cells with injected wall-block function
  - `trimPathToSpeed(path, speedFt)` — clip path to movement budget
  - `getActionRange(action)` — parse melee/ranged/mixed/spell + reach + normal/long ranges from action description
  - `isInRange(range, distFt)` — usable + disadvantage flag
  - `detectOpportunityAttacks(path, startPos, hostiles, disengaging)` — per-hostile single-fire OoA detection
  - `computeIntTier(intScore, override)` — FERAL/ANIMAL/HUMANOID/TACTICAL/MASTERFUL
  - `decide({combatant, combat, actions, mapDef, tokensOnMap, intScore, intTierOverride, speedFt, pathBlockedFn, reactionUsedByHostiles})` — returns `{actionIndex, targetId, movePath, triggersOoaFrom, disadvantage, tier, reasoning}` or `null`

- **`services/combat/combat-service.js`** changes (additive):
  - `require('./npc-tactics')` at top
  - `_tryPositionalDecide(combatant, combat)` — gathers map + actors + tokens and calls `NpcTactics.decide`
  - `_applyNpcMovement(combatant, decision)` — snaps token to end of path, dispatches `map:token_moved`, whispers OoA detections, marks hostile reactions as used
  - Early branch in `_npcTacticalAI` — if `state.combat.useTacticalPositioning !== false` and `_tryPositionalDecide` returns a decision, use it; otherwise fall through to the existing Gemini / basic tactics path unchanged
  - Round-start reset of `_reactionUsedThisRound` flag on every combatant in `nextTurn`

- **REST endpoints:**
  - `POST /api/combat/override-npc-turn` — `{combatantId, actionIndex, targetId, movePath?}` — skips tactical AI for this NPC, applies optional movement, executes the given action
  - `POST /api/combat/set-flag` — `{useTacticalPositioning: bool}` — live-session kill switch

### Feature flag

`state.combat.useTacticalPositioning` defaults to `undefined` (treated as enabled). DM can disable during a session via `POST /api/combat/set-flag {useTacticalPositioning: false}`. When disabled, the entire new path is bypassed — combat reverts to the pre-Phase-1 AI+basic path.

### What's intentionally NOT built in Phase 1

- **OoA execution.** Opportunity attacks are detected and whispered (`[OoA] <NPC> leaves <PC>'s reach...`) with the hostile's reaction marked as used, but the actual damage roll is not automated. Rationale: execution requires reliable attacker-action plumbing from the PC side (which weapon do they OoA with? what bonus?) and a full attack round does not cleanly fit inside an NPC's turn. Dave runs OoA damage manually or via the Attack Resolver panel.
- **Disengage action.** npc-tactics.decide() always passes `disengaging: false`. A full disengage pathway would need action economy tracking (action/bonus/reaction budgets per turn). For now, NPCs always risk OoAs when breaking away.
- **Multi-turn planning for MASTERFUL tier.** Collapsed into "TACTICAL + flanking + readying against casters" — the scoring rewards caster priority strongly, but the AI is still making one-turn decisions.
- **Team coordination between allied NPCs.** Each NPC decides independently.

## 1.8 Test results

Smoke test at `scripts/test-npc-tactics.js`. **43/43 passing.**

```
── distanceFeet ── 6 passed
── computeIntTier ── 11 passed
── getActionRange ── 4 passed (fixed mixed-range parse ordering bug)
── isInRange ── 5 passed
── findPath — open map ── 3 passed (fixed `0 || Infinity` falsy bug in A*)
── findPath — fully walled target ── 1 passed (returns null)
── trimPathToSpeed ── 3 passed
── detectOpportunityAttacks ── 4 passed (single-fire, disengage suppression, multi-hostile)
── decide() integration ── 4 passed (ANIMAL targets wounded equal-distance target)
── decide() MASTERFUL targeting priority ── 2 passed (caster preference overrides engagement)
```

Two bugs caught by tests during initial run:
1. `(gScore.get(currentKey) || Infinity) + 1` treated g=0 at start as falsy, always returned Infinity. Replaced with `??`.
2. Mixed-range action description matched pure-ranged regex first because description contains both "reach 5 ft." and "range 20/60 ft.". Reordered so "melee or ranged" check runs first.

Run with `node scripts/test-npc-tactics.js`.

## Integration risk

Because the new path is behind a runtime flag that defaults on but can be disabled instantly via REST, the worst-case during Dave's Saturday test:
- NPC combat behaves strangely → `curl -k -X POST -H 'content-type: application/json' -d '{"useTacticalPositioning":false}' https://localhost:3200/api/combat/set-flag`
- Combat reverts to pre-Phase-1 behavior immediately. No restart needed.

The combat-service's positional branch is wrapped in a try/catch that logs the error and falls through to the existing AI path. A bug inside npc-tactics therefore cannot crash the combat pipeline; it degrades to the old behavior.

## What's next (Phase 2)

Phase 2 will build on this foundation to:
- Actually execute OoA damage (once the attack resolver panel is wired to accept programmatic triggers)
- Cover calculation (+2/+5 AC from walls/large tokens between attacker and target)
- Shooting-into-melee disadvantage + d4 friendly-fire on miss
- Friendly-fire AoE warnings on PC UI

## Commit strategy

Phase 1 landed in 2 commits:
1. `feat(combat): npc-tactics helper — distance, A* pathfinding, range checks, INT-tier scoring` (4515605)
2. `feat(combat): wire npc-tactics into _npcTacticalAI with manual override endpoint and reaction tracking` (this commit)
