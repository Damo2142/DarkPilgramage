# BLOCKED — Phase 2: Combat rules enforcement UI

**Status:** deferred to follow-up session (not in this session's commits)

**Why blocked:** Phase 2 is code-heavy with UI modifications to `services/dashboard/public/dm-ref.html` (Combat tab spell attack resolver panel, friendly-fire d4 on miss, cover bonuses) and `services/player-bridge/public/index.html` (OoA warnings, friendly-fire AoE warnings). The UI files are 3,566 + 5,678 lines and HTML-heavy — careful, and not a fast delivery.

**What Phase 2 needs to build (condensed from work order):**

### 2.1 Shooting into melee (disadvantage + d4 friendly fire on miss)
- On ranged attack from DM Attack Resolver panel in `dm-ref.html`:
  - Before roll: check target's map position. If any non-self ally is within 5ft (use `services/combat/npc-tactics.js#distanceFeet` and `state.map.tokens`), apply disadvantage.
  - On miss: roll d4 server-side. On 1, select a random ally within 5ft of intended target, redirect the hit, apply damage.
  - Whispers: DM earbud `[FRIENDLY FIRE] arrow veers toward <ally> (d4=1) — roll damage`; shooter's Chromebook RED flash.
- Server endpoint needed: `POST /api/combat/attack/ranged` that takes `{shooterId, targetId, attackRoll, damage}` and runs the disadvantage/redirect logic.

### 2.2 Cover
- New helper `services/combat/cover.js` or extend `npc-tactics.js`:
  - `computeCover(attackerTok, targetTok, walls, otherTokens, gridSize)` → `{level: 'none'|'half'|'three-quarters'|'full', acBonus: 0|2|5|Infinity, reason}`
  - Half: target within 5ft of a wall or large token between attacker and target
  - Three-quarters: two walls / corner
  - Full: no line of sight
- Wire into `combat-service.processAttack` — adjust `targetAC` by cover bonus before hit/miss check.
- Display in DM Attack Resolver: "Cover: half (+2)".

### 2.3 OoA surfacing on player UI
- Player Chromebook: when the PC taps a grid cell to move, run wall + OoA check first. If the move would cross NPC reach, show modal: "⚠ Leaving <NPC> reach — they will attack. Continue?"
- DM dashboard map: draw a thin red border around NPCs whose reach a player's proposed move would cross.
- Backend: new endpoint `POST /api/map/token/preview-move` returns `{blocked: bool, ooaTriggers: [npcName]}` without committing the move.

### 2.4 Friendly-fire AoE warnings
- In DM Attack Resolver's AoE flow: after the DM selects a spell with AoE (fireball, thunderwave, burning hands), before rolling, compute which friendly tokens fall in the AoE radius + shape. Display "⚠ AoE includes ally <name> — save required or full damage."
- No auto-exclusion — PC is making the choice.

## Recommended path for follow-up

1. **Hour 1:** Build `services/combat/cover.js`. Wire into `processAttack`. Add unit tests in `scripts/test-cover.js` mirroring the npc-tactics test style.
2. **Hour 2:** Ranged shot disadvantage + d4 on miss. New server endpoint. Unit test.
3. **Hour 3:** Player Chromebook tap-to-move preview with OoA warning modal. Smallest diff: add a click-handler intercept that fetches `/api/map/token/preview-move` first.
4. **Hour 4:** DM map red border rendering. Modify `dm-map.html`'s render loop to highlight NPCs with reach-threat on hover over a PC.
5. **Hour 5:** AoE friendly-fire warning in DM Attack Resolver's spell panel flow.

## Risk if not landed Sunday

- Shooting-into-melee / friendly-fire: Dave can apply disadvantage manually and roll d4 at the table.
- Cover: Dave narrates + applies AC bonus manually.
- OoA warning: Dave tells the player "that move triggers OoA" verbally.

None of these are session-blocking. They are quality-of-life improvements that Dave can paper over.
