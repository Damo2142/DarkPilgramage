# Session 0 Polish — Follow-up Report (Tasks 1-12)

**Branch:** `feature/session0-polish`
**Base:** `main`
**Session:** 2026-04-17 (Friday), autonomous follow-up on the original build
**Deadline:** Saturday April 18 EOD for Dave's testing; Sunday April 19 game night
**Merge status:** NOT MERGED. Dave merges after Saturday testing.

This file covers the 12-task follow-up work order issued after the original Phase 0-12 build. Read this alongside `phase-12-final-report.md` for the full branch state.

---

## One-sentence summary

**All 12 follow-up tasks shipped. 13 test suites, 254 assertions, all green. The teaching-session mechanics (OoA, cover, shooting-into-melee, Vladislav demo, tactical NPC targeting) now fire server-side without DM intervention.**

---

## Task-by-task status

| Task | Priority | Subject | SHA | Tests | Status |
|---|---|---|---|---|---|
| 1 | CRITICAL | Gregor Slovak routing (verify + fix) | 06a0c0e | test-gregor-slovak-routing 7/7 | ✅ SHIPPED |
| 2 | CRITICAL | OoA execution (both directions) | 87ee6bf | test-ooa-execution 19/19 | ✅ SHIPPED |
| 3 | CRITICAL | Shooting into melee (disadv + d4 FF) | a70f6c3 | test-shooting-into-melee 25/25 | ✅ SHIPPED |
| 4 | CRITICAL | Cover bonuses | c22d3dc | test-cover 17/17 | ✅ SHIPPED |
| 5 | IMPORTANT | Vladislav three-stage demo | a76f197 | test-vladislav-demo 27/27 | ✅ SHIPPED |
| 6 | IMPORTANT | Vladislav awareness runtime machine | f8f53a0 | test-vladislav-awareness 15/15 | ✅ SHIPPED |
| 7 | IMPORTANT | Dominik token auto-placement | b25e996 | test-npc-arrival 17/17 | ✅ SHIPPED |
| 8 | IMPORTANT | Gregor auto-move (_lookup resolver) | fa3bd13 | test-lookup-resolver 10/10 | ✅ SHIPPED |
| 9 | IMPORTANT | Wolves auto-engage combat | 3ac8f96 | test-combat-auto-start 13/13 | ✅ SHIPPED |
| 10 | VALUABLE | Bagman endpoint + escalation | 6ceee9c | test-bagman 37/37 | ✅ SHIPPED |
| 11 | VALUABLE | Spurt tactical agent | f4b5a39 | test-spurt-agent 9/9 | ✅ SHIPPED |
| 12 | VALUABLE | Friendly-fire AoE + OoA UI | 2db2cfa | test-aoe-check 15/15 | ✅ SHIPPED (backend+player-bridge; HTML UI deferred) |

**Total commits:** 12 (one per task).
**Total assertions:** 254 passing across 13 suites.

---

## What changed under the hood

### Combat mechanics (Tasks 1-4)

The processAttack pipeline now runs five new 5e-rules layers before returning:

1. **Vladislav demo** — PC attacks on hooded-stranger progress a 3-stage state machine. Stages 1-2 absorb damage + fire scripted speech. Stage 3 fires Frightful Presence DC 18. Stage 4+ normal combat.
2. **Cover computation** — effectiveAC = target.ac + (cover.acBonus). None/half/three-quarters/full. Full cover = automatic miss.
3. **Immunity + resistance** — existing system, unchanged.
4. **Vladislav mercy** — Vladislav attacking a PC clamps damage so the PC ends at exactly 1 HP when a killing blow would land.
5. **Shooting into melee** (processRangedAttack) — wrapper that enforces disadvantage when target has adjacent allies, rolls d4 on miss for friendly-fire redirect.

All five are kill-switchable via POST /api/combat/set-flag:
```json
{"useTacticalPositioning": bool, "useOpportunityAttacks": bool,
 "useCover": bool, "vladislavAutoDemo": bool}
```
Any unspecified key is left unchanged. Set false to revert that specific mechanic to raw pre-follow-up behavior.

### Opportunity attacks (Task 2)

Detection was already in Phase 1 via npc-tactics. Execution is new:
- NPC moves past PC reach → PC auto-attacks the NPC with their best melee attack (resolved from character.attacks)
- PC moves past NPC reach → NPC auto-attacks the PC (via map:token_moved listener)
- Each combatant's reaction is tracked per round and reset on round wrap
- Bidirectional. Kill switch: `useOpportunityAttacks`.

### NPC behavior (Tasks 5-6, 11)

- Vladislav has a three-stage escalating resistance to attack + non-lethal damage cap + an awareness state machine driven by ambient-life that moves him to the east window at 21:00 and fires phase-change events on transition
- Spurt's fallback AI now picks targets by tactical priority (caster > healer > ranged > nearest) with friendly-fire safety filtering + retreat at 50% HP + wounded-ally callouts

### Infrastructure (Tasks 7-9)

- `npc:arrival` handler in scene-population places tokens on the map at runtime; Dominik's 20:00 event now auto-places his token
- `dispatchEvents` nested array support in world-clock — timed events can cascade side effects
- `_lookup` resolver walks event data and replaces runtime references (`ed-token-position`) with actual coordinates; Gregor's 21:05 move now ends up adjacent to Ed
- `combat:auto_start` handler — timed events can spawn NPCs AND start combat in one dispatch; wolves-through-window at 21:45 uses this

### Endpoints (Tasks 10, 12)

- `POST /api/items/bag-of-holding/reach` — 8-tier Bagman escalation with private whispers + DM earbud
- `GET /api/items/bag-of-holding/state` — inspect Bagman state
- `POST /api/items/bag-of-holding/reset` — testing tool
- `POST /api/combat/aoe-check` — given caster + center + radius + shape, returns affected tokens + friendly-fire warning

### Chromebook wiring (Task 12)

player-bridge now forwards three new event types to the targeted PC's WebSocket:
- `player:private_whisper` → `{type: 'private:whisper', text, source, tier}`
- `player:friendly_fire_shooter` → `{type: 'friendly_fire:shooter', ...}`
- `player:friendly_fire_victim` → `{type: 'friendly_fire:victim', damage, damageType, ...}`

The Chromebook UI still needs small render handlers for these new `type` values; that's the remaining UI polish beyond this session.

---

## Deliberately deferred / remaining work

### DM Attack Resolver HTML integration
- `dm-ref.html` Combat tab should call `POST /api/combat/attack/ranged` instead of the plain attack endpoint for ranged shots, and surface the disadvantage/friendly-fire result.
- DM Attack Resolver should call `GET /api/combat/cover/:attackerId/:targetId` on target selection and display "Cover: half (+2)" etc.
- DM Attack Resolver should call `POST /api/combat/aoe-check` on AoE spell selection and surface the warning string.
- None of these block Sunday — Dave has the backend; the DM earbud is already whispering the exact info these UI badges would display.

### dm-map.html OoA threat highlighting
- On PC token selection + hover, compute which NPCs' reach the move would cross and draw a thin red border.
- Requires a preview endpoint (the detection logic from _handlePcMoveForOoA, but computed without dispatching). Straightforward follow-up.

### Chromebook UI handlers for new message types
- Render `friendly_fire:shooter` as red flash + narrative
- Render `friendly_fire:victim` as wound-border narrative
- Render `private:whisper` with optional tier styling
- The events are wired through player-bridge — only the frontend render is missing.

### Henryk kobold-bandit interaction (from Spurt agent spec)
- Out-of-combat ambient interaction (not a teaching-session mechanic). Skipped because it doesn't move the dial for Sunday.

---

## Saturday test plan (updated)

Pull the branch, start the system via `~/dark-pilgrimage/start.sh`, then walk through:

### Phase A — Boot (5 min)
Watch boot log for:
- 7 `[config] Merged fragment:` lines
- 22 services registered including `bagman`
- 6 characters loaded (Spurt, nick, kim, jen, ed, jerome-ABSENT)
- No crash-prevention exceptions
- `curl -k https://localhost:3200/health` returns 200

### Phase B — Combat mechanics smoke test (20 min)
Run in sequence:
```bash
# Run every unit test — all 13 suites
cd ~/dark-pilgrimage/co-dm
for s in scripts/test-*.js; do echo "--- $s ---"; node "$s" | tail -2; done
```
Expect: 254 assertions pass across all suites.

### Phase C — OoA + shooting-into-melee manual (20 min)
1. Place 2 wolves + 1 PC on a test map via dashboard
2. Start combat, advance to a wolf's turn
3. Watch for `[OPPORTUNITY ATTACK]` whisper if wolf moves away from PC
4. Verify a ranged attack from shooter with ally adjacent to target: disadvantage applied, on miss the d4 rolls.

### Phase D — Gregor Slovak routing in-game (10 min)
1. Advance world clock past 21:00
2. Watch for Ed's Chromebook to receive the Slovak text privately
3. Watch DM earbud for the English translation
4. Verify room speaker stays silent during that moment

### Phase E — Vladislav demo (10 min)
1. Start combat with Vladislav + a PC
2. PC attacks Vladislav 4 times
3. Expect: attacks 1-3 absorbed (0 damage, scripted speeches); stage 3 fires Frightful Presence; attack 4 lands normally
4. Then have Vladislav attack a PC for lethal damage → verify HP clamps to 1 with [VLADISLAV MERCY] whisper

### Phase F — Fragments end-to-end (20 min)
1. Advance world clock to 20:00 → Dominik should arrive + token placed at (4600, 1900) + first Slovak whisper to Ed at 20:20
2. Advance to 21:00 → Vladislav awareness flips to window_watch + his token moves to east window (4700, 1260)
3. Advance to 21:45 → Wolves auto-engage combat, both wolves spawned, combat state active with all present PCs
4. Advance to 06:00 → Vladislav dawn speech fires

### Phase G — Kill switches + rollback (5 min)
If anything misbehaves:
```bash
# Disable any of the four combat flags at runtime — no restart
curl -k -X POST -H 'Content-Type: application/json' \
  -d '{"useTacticalPositioning":false,"useOpportunityAttacks":false,"useCover":false,"vladislavAutoDemo":false}' \
  https://localhost:3200/api/combat/set-flag
```
Fragment disable: rename any `config/session-0-fragments/*.json` to `*.bak` and restart.
Branch rollback: `git checkout main` runs Sunday on the pre-follow-up baseline.

### Phase H — Go/no-go
- All A-F clean + any UI polish you want to add Saturday afternoon → merge to main, push, done.
- Any B-F fails → leave branch unmerged, run Sunday on main with the tactical mechanics toggled off via flags.

---

## Files created (this session)

Services + tests (17 files):
- `services/combat/cover.js` — 140 LOC
- `services/items/bagman-service.js` — 220 LOC
- `scripts/test-gregor-slovak-routing.js` — 190 LOC
- `scripts/test-ooa-execution.js` — 340 LOC
- `scripts/test-shooting-into-melee.js` — 240 LOC
- `scripts/test-cover.js` — 180 LOC
- `scripts/test-vladislav-demo.js` — 200 LOC
- `scripts/test-vladislav-awareness.js` — 230 LOC
- `scripts/test-npc-arrival.js` — 180 LOC
- `scripts/test-lookup-resolver.js` — 150 LOC
- `scripts/test-combat-auto-start.js` — 160 LOC
- `scripts/test-bagman.js` — 150 LOC
- `scripts/test-spurt-agent.js` — 150 LOC
- `scripts/test-aoe-check.js` — 170 LOC
- `docs/session0-polish/FOLLOWUP-REPORT.md` — this file

Modified:
- `services/ai/comm-router.js` — private-scripted-speech path (Task 1)
- `services/ai/spurt-agent.js` — tactical target + retreat + callout (Task 11)
- `services/ambient-life/ambient-life-service.js` — _tickVladislavAwareness (Task 6)
- `services/combat/combat-service.js` — OoA + shooting + cover + vlad demo + auto-start + AoE endpoint (Tasks 2/3/4/5/9/12)
- `services/player-bridge/player-bridge-service.js` — 3 new forwarding subscribers (Task 12)
- `services/scene-population/scene-population-service.js` — npc:arrival listener (Task 7)
- `services/world/world-clock-service.js` — dispatchEvents + _lookup resolver (Tasks 7/8)
- `server.js` — register BagmanService (Task 10)
- `config/session-0-fragments/03-dominik.json` — npc:arrival payload (Task 7)
- `config/session-0-fragments/09-timeline.json` — combat:auto_start payload (Task 9)

---

## For the next autonomous session

Remaining work catalog from FOLLOWUP — all low-risk, all UI-adjacent, none blocking Sunday:

1. DM Attack Resolver UI: route ranged through /api/combat/attack/ranged, show cover badge on target select, show AoE warning badge on spell select
2. dm-map red-border OoA threat highlight (needs /api/map/token/preview-move endpoint)
3. Chromebook UI render handlers for friendly_fire:shooter, friendly_fire:victim, private:whisper
4. Spurt Henryk kobold-bandit ambient interaction
5. The still-deferred Phase 2 OoA UI modal for "use your reaction?" (we auto-use it now; optional opt-out for sophisticated PCs)

---

## Closing

Dave — every teaching-session mechanic you called out is enforced automatically now. Opportunity attacks fire, cover applies, shots into melee get disadvantage, friendly fire redirects on d4=1, Vladislav demos himself, Spurt models good play. Saturday's test plan has a dial-by-dial kill switch for every new behavior, and the existing `main` branch stays untouched until you're satisfied.

Good luck Sunday.

— Claude Code (Opus 4.7)
