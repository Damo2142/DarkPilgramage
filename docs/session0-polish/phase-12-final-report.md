# Phase 12 — Final Report

**Branch:** `feature/session0-polish`
**Base:** `main`
**Commits on branch:** 5
**Session:** 2026-04-17 (Friday), single autonomous pass
**Author:** Claude Code (Opus 4.7, 1M context) on pve1
**Merge status:** NOT MERGED. Dave merges Saturday after testing. Do not force-merge.

---

## Summary (for Dave's first read)

**What's mergeable right now:** Phases 0, 1, 3, 4, 5, 7, 9, 10 (scaffold), 11. Ship these. They give you the full Dominik + Gregor deathbed + Vladislav + Matthias/Abbey + timeline-polish + Phase-1 NPC combat positioning (behind a live kill switch) by Sunday.

**What's deferred to a follow-up session:** Phases 2, 6, 8 — documented as BLOCKED-\*.md files. Each has a manual DM workaround for Sunday and a detailed spec for what the follow-up session needs to build.

**Biggest thing to test Saturday:**
1. Does the system boot with 7 fragments merged? (`~/dark-pilgrimage/start.sh` and watch boot log for 7 `[config] Merged fragment:` lines)
2. Does Phase 1 combat positioning misbehave? (live kill switch: `POST /api/combat/set-flag {useTacticalPositioning: false}`)
3. Does the Gregor deathbed Slovak message route to Ed's Chromebook privately? (this needs in-session verification)

---

## Commits

| SHA | Subject | Phase |
|---|---|---|
| 47ba5ca | docs(session0-polish): Phase 0 branch setup and planning scaffold | 0 |
| 4515605 | feat(combat): npc-tactics helper — distance, A* pathfinding, range checks, INT-tier scoring | 1 |
| 7a2af63 | feat(combat): wire npc-tactics into _npcTacticalAI with manual override endpoint and reaction tracking | 1 |
| 373407d | feat(session-0): Phase 3 — Brother Dominik Novák (disguised vampire spawn) + fragment loader | 3 |
| 5794145 | feat(session-0): Phases 4+5+7+9+10+11 — Gregor deathbed, Vladislav, Matthias, timeline, player hooks, cleanup | 4+5+7+9+10+11 |

5 commits. All pushed to `origin/feature/session0-polish` after commit 1; commits 2-5 will push with the final summary commit (below).

---

## Files created

### Services / code
- `services/combat/npc-tactics.js` — 420 LOC. Helper module: Chebyshev distance, A* pathfinding, range parsing, INT-tier scoring, OoA detection. Pure functions, no service state.
- `utils/config-loader.js` — rewritten. Now scans `config/session-0-fragments/*.json` and array-concat deep-merges them onto the base. Preserves identical output when no fragments present.

### Tests
- `scripts/test-npc-tactics.js` — 43 smoke tests. All pass. Runnable with `node scripts/test-npc-tactics.js` (exit 0 on pass, 1 on fail).

### Data (actors + fragments)
- `config/actors/brother-dominik-novak.json` — CR 5 vampire spawn, disguised, full statblock + disguise metadata
- `config/session-0-fragments/03-dominik.json` — Dominik NPC dispositions, Slovak whisperScript, 9 timed events
- `config/session-0-fragments/04-gregor-deathbed.json` — 6 timed events covering the deathbed scene with Slovak message
- `config/session-0-fragments/05-vladislav.json` — awareness phases, demo state machine, Matthias relationship, 4 timed events, Slovak phonetics table
- `config/session-0-fragments/07-matthias-abbey.json` — Abbey + Matthias futureHooks
- `config/session-0-fragments/09-timeline.json` — 6 timed events (Letavec shutter, horse dies, upstairs volunteer, Marta-Kim, wolves-through-window, Tomas-cellar)
- `config/session-0-fragments/10-player-hooks.json` — scaffold hooks for Ed/Kim/Jen/Nick/Spurt (scaffold: true markers)
- `config/session-0-fragments/11-cleanup.json` — midnight `tomas_breaks` clarification cue

### Documentation (all under `docs/session0-polish/`)
- `README.md` — running log
- `ARCHITECTURE-DECISIONS.md` — decision log
- `KNOWN-ISSUES.md` — issue log
- `phase-0-baseline.md`
- `phase-1-combat-positioning.md`
- `phase-3-dominik.md`
- `phase-4-gregor-deathbed.md`
- `phase-5-vladislav.md`
- `phase-7-matthias.md`
- `phase-9-timeline.md`
- `phase-10-player-hooks.md`
- `phase-11-cleanup.md`
- `phase-12-final-report.md` (this file)
- `BLOCKED-phase-2-combat-rules-ui.md` — deferred, manual workaround + follow-up spec
- `BLOCKED-phase-6-bagman.md` — deferred, manual workaround + follow-up spec
- `BLOCKED-phase-8-spurt-agent.md` — deferred, manual workaround + follow-up spec

### Files modified
- `services/combat/combat-service.js` — added `require('./npc-tactics')`, `_tryPositionalDecide`, `_applyNpcMovement`, positional branch in `_npcTacticalAI`, reaction reset in `nextTurn`, two new routes (`/api/combat/override-npc-turn`, `/api/combat/set-flag`). All changes additive behind the `useTacticalPositioning` flag.

### Files NOT modified
- `config/session-0.json` — **deliberately untouched**. All Phase 3-11 content is in fragments.
- All other service code — untouched.

---

## Architectural decisions

All documented in `ARCHITECTURE-DECISIONS.md`. Key ones:

- **AD-001 — Aldous Kern already placed.** Phase 0's spec asked to place him; he was already present in the ground-floor scene. No modification.
- **npc-tactics Option A (extend combat-service).** Work order presented two options; Option A chosen for simplicity and because npc-autonomy.js is dormant/untested.
- **Fragment loader, array-concat deep merge.** Chosen over editing session-0.json directly. Safer (original file untouched), testable (fragments can be disabled by rename), supports phase-by-phase delivery.
- **OoA detection only, not execution in Phase 1.** Detection + reaction-used flag in place; execution deferred because full PC-side attack plumbing needs the Attack Resolver panel wiring which is Phase 2 territory.
- **Sibling event for midnight cleanup (Phase 11).** Fragment loader can't edit the original tomas_breaks; added a +1 minute clarification sibling. Post-deadline cleanup on session-0.json is a Dave-hand task.

---

## Known issues (from KNOWN-ISSUES.md + discovered during build)

| ID | Severity | Disposition |
|---|---|---|
| KI-001 | info | Snapshot undercounted ground-floor scene tokens (9 vs actual 10, Aldous present). Left. |
| (Phase 3) | medium | `npc:arrival` bus event has no listener yet. DM places Dominik token manually at 20:00. |
| (Phase 3) | low | Disguise state machine not wired; combat-service reads `int_tier \|\| int_tier_when_revealed` so it will use revealed-tier if the disguise data is absent. |
| (Phase 3-5) | low | `checkFlag` fields on timed events are descriptive; no JS evaluator. DM gates conditional whispers manually. |
| (Phase 4) | medium | `_lookup: "ed-token-position"` in token:move is not resolved at runtime. DM moves Gregor manually via NPC panel. |
| (Phase 4) | low | `_deliveryMode` on scripted_speech — needs verification that Ed's Chromebook receives private + DM earbud gets translation. Test on Saturday. |
| (Phase 5) | medium | Demo state machine not wired into combat-service.processAttack. DM runs the three-stage demo manually. |
| (Phase 5) | low | Awareness phase transitions are descriptive schedule, not a runtime state machine. |
| (Phase 9) | low | `combat:wolves_arrive` has no subscriber — DM starts wolf combat via dashboard. |
| (Phase 10) | review-required | Player hooks are scaffold — Dave reviews + edits before Sunday. |

---

## Saturday test plan (recommended)

### Phase A — Boot verification (10 min)
1. `cd ~/dark-pilgrimage && ./start.sh`
2. In logs, verify:
   - `[config] Merged fragment: 03-dominik.json` through `11-cleanup.json` (7 lines)
   - 21 services report "ready"
   - `curl -k https://localhost:3200/health` returns 200
3. `curl -k https://localhost:3200/api/map` — active map shows `pallidhearfloor1` with all 10 scene tokens
4. `curl -k https://localhost:3200/api/npcs` (if exposed) — Dominik + full patron list present

### Phase B — Phase 1 combat positioning (20 min)
1. Place any NPC with int_tier on the map via /dm/map → Place default
2. Place a PC token nearby
3. Start combat: `POST /api/combat/start-scene` or the UI button
4. Advance turn to the NPC
5. Watch for:
   - `[tactics] <NPC>: [tier] → <action> <target> (move N tiles) ...` whisper in Max log
   - NPC token snaps to end of path
   - DM whisper log contains the reasoning
6. If anything misbehaves: `POST /api/combat/set-flag {useTacticalPositioning: false}` — reverts instantly, no restart
7. Run `node scripts/test-npc-tactics.js` — expect 43/43 pass

### Phase C — Dominik arrival (15 min)
1. Advance world clock to 19:55
2. Wait ~5 min real-time (or use `advanceTime` endpoint)
3. Expect `dominik-arrival` whisper at 20:00 and `dominik-first-greeting` at 20:02
4. Manually place Dominik's token at (4600, 1900) via DM map (since `npc:arrival` handler is not wired)
5. Position Ed near Dominik, watch for Slovak whisper at 20:20 to Ed's Chromebook

### Phase D — Gregor deathbed (15 min)
1. Advance world clock to 20:55
2. At 21:00, Gregor collapse escalates with Medicine DC 12/15 observations
3. At 21:08, Slovak deathbed message to Ed. **Verify: Ed's Chromebook shows Slovak text, DM earbud hears English translation.** If this routing isn't working, make note — Max comm-router handling of `_deliveryMode + targetPlayer` may need a patch.
4. Flip `state.npcs.patron-farmer.status` to 'dead' via REST or dashboard
5. At 21:12, bag handoff whisper fires
6. At 21:13, Vladislav approaches — Slovak + Common dialogue

### Phase E — Vladislav dawn speech (5 min)
1. Jump world clock to 05:55 (`POST /api/world/advance-time {minutes: ...}`)
2. At 06:00, dawn speech fires — whole-table Common delivery on room speaker
3. Matthias password revealed, abbey named, "try not to die before we meet again"

### Phase F — Player hooks review (20 min)
Open `config/session-0-fragments/10-player-hooks.json` in a text editor. Review each hook. Edit, keep, or replace as desired. Remove `scaffold: true` on approved hooks.

### Phase G — Go/no-go decision
If A through F pass: merge `feature/session0-polish` to `main`, push. Run Sunday on main.
If F fails (hooks need major rewrite): do that Saturday afternoon on the branch, then merge.
If A/B/C/D/E fails: re-check the relevant phase doc, file an issue in KNOWN-ISSUES, and either manual-workaround for Sunday or delay merge until fixed.

---

## For the next autonomous session

**Pick up from:**
- Read `docs/session0-polish/README.md` for status
- Read `docs/session0-polish/BLOCKED-phase-2-combat-rules-ui.md`, `BLOCKED-phase-6-bagman.md`, `BLOCKED-phase-8-spurt-agent.md` for specs
- Read each phase's doc for deferred items
- Baseline: all 12 phases have a home (either shipped or BLOCKED); nothing is forgotten

**Priority order for the next session:**
1. **Phase 2.2 cover** — cheapest combat-rules win, reuses npc-tactics infrastructure
2. **Phase 6 Bagman** — narratively high-value, short endpoint
3. **Phase 2.1 shooting into melee** — friendly-fire d4 mechanic
4. **Phase 8 Spurt tactical** — agent behavior improvement
5. **Phase 2.3/2.4 OoA and AoE UI** — quality of life
6. **Deferred items from Phases 3, 4, 5** — npc:arrival handler, _lookup resolver, checkFlag evaluator, demo state machine wiring

---

## Closing

Dave — this is what a Friday-autonomous build landed. Sunday's session has:
- Full Dominik NPC (disguise + Slovak whispers + timed arrival)
- Gregor's deathbed as a real cinematic moment with a Slovak payoff
- Vladislav's awareness phases, counter-whispers, dawn speech with Matthias password
- The Abbey of Saint Prokop seeded as a Session 1+ destination
- Timeline polish across six beats
- Per-player hook scaffolds (review + edit pre-Sunday)
- Phase 1 NPC combat positioning with live kill switch

What it doesn't have is Phase 2's combat-UI polish, Phase 6's Bagman endpoint, and Phase 8's Spurt behavior. All three have manual workarounds documented, and all three have detailed specs for the next session.

Good luck Sunday.

— Claude Code (Opus 4.7)
