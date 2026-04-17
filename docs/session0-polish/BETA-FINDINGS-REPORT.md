# Beta Findings — Fix Report

**Branch:** `feature/session0-polish` (not merged)
**Ticket source:** Claude Opus 4.7 (consumer app) + Dave's beta test 2026-04-17
**Work date:** 2026-04-17 evening
**Worker:** Claude Code (Opus 4.7, 1M context) on pve1
**Time spent:** ~1.5 hours on the 6 findings, re-test pass pending

**Verdict on beta re-pass:** 🟡 **READY for Dave's re-beta, but full live re-test still owed** — see re-test checklist at the bottom. Dave should re-run his manual beta flow (particularly Dominik whisper delivery at 20:20) before merging.

---

## Finding-by-finding

### F1 — NPC narrative start positions

**What it was:** Scene tokens were geometrically valid but narratively wrong. Marta near kitchen instead of behind bar / near cellar. Vladislav top-right instead of bottom-left corner. Dominik arrival in storage room instead of at front door.

**Root cause:** Coordinates inherited from earlier dev iterations without a narrative-intent review against the binder/ChatGPT map prompt.

**What changed:**
- Dave already repositioned scene tokens via his python script — confirmed the scene file positions match narrative intent:
  - Marta at (3990, 1470) — east side near bar ✓
  - Vladislav at (1050, 1890) — bottom-left corner ✓
  - Katya at (2730, 1890) — middle-south near hearth ✓
- **Dominik arrival coordinates FIXED:** `config/session-0-fragments/03-dominik.json` — npc:arrival dispatch changed from (4600, 1900) [storage-east zone] to **(1500, 900)** [just east of the west-wall front door]. Added `_arrivalPositionNote` explaining the choice.
- **Added `_narrativeIntentNote`** to `config/scenes/pallid-hart-ground.json` documenting binder-based positions so future reshuffles don't break narrative layout.

**How to verify:** On fresh session start → map/load → session/start, the NPC tokens should be in their correct narrative quadrants. At world-clock 20:00, Dominik's token should auto-place at (1500, 900), clearly near the west wall door, not in storage-east.

### F2 — Dominik's whispers severely gated

**What it was:** 20:20 / 20:45 / 21:00 whisper events fired as `dm:whisper` with prose instructions to Max like "IF Ed is within 10ft of Dominik and they have exchanged at least one line: fire the whisper." Max cannot programmatically evaluate proximity, so the whispers never reached Ed's Chromebook.

**Root cause:** The three whisper events were authored as DM-facing cues assuming Max would gate them. But there's no tool/state gate, and Max is prompt-only. So the gate was a suggestion, not enforcement — in practice blocking delivery entirely.

**What changed:** `03-dominik.json` + `09-timeline.json` — reshaped the three Dominik whispers AND Marta's confession from `dm:whisper` to `npc:scripted_speech` with private delivery:

- `dominik-first-whisper-opening` (20:20): Slovak text "Priateľu, kráčal som..." → Ed via private delivery, English translation → DM earbud
- `dominik-second-whisper-middle` (20:45): "Cirkev nás učí..." → Ed
- `dominik-close-whisper` (21:00): "Ak vám dnes v noci ponúkne naliať..." → Ed
- `marta-confession-to-kim` (20:45): "Three years ago. He doesn't remember..." → Kim

Proximity gating removed entirely. Trade-off: these fire on the timer regardless of table positioning. Dave's narrative job: narrate the approach ("Dominik slides into the empty chair next to you, Ed" / "Marta steers you into the kitchen, Kim") just before each whisper fires.

**How to verify:** Advance world clock to 20:19 → within 1 second Ed's Chromebook should receive the Slovak text, DM earbud should speak the English translation, room speaker should be silent. Repeat at 20:44 and 20:59.

### F3 — Gas spore observation leak to non-cellar PCs

**What it was:** Ed received the tier-1 "something floating in the cellar with stalks" observation while standing in the common room.

**Root cause:** `comm-router._collectActiveLookObservationEvents()` fires ALL registered observation events for the scene when a PC declares an active look. `cellar_entry` observations were in that list. So Ed rolling perception anywhere on the ground floor triggered the cellar-only observations, and tier-2 passive-perception filters let them through based on DC alone.

**What changed:** `services/ai/comm-router.js:1594` — `_collectActiveLookObservationEvents(playerId)` now:
- Takes a `playerId` parameter
- Looks up that player's token position
- Checks if the token is in the cellar-access zone (x=1000-1280, y=600-1020) OR the cellar interior (x=980-1540, y=1120-1400)
- Skips observation events tagged as cellar-only (eventId contains 'cellar', or items reference gasspore/piotr) if the player isn't in the cellar

**How to verify:** With Ed at (2730, 1470) (common room), trigger active perception intent. The gas-spore observations should NOT fire. Move Ed's token to (1200, 800) (cellar-access zone) and re-trigger — THEY should fire.

### F4 — Whisper log duplicate display

**What it was:** Same event rendering 4 times in the dashboard whisper log feed. Audio was fine; only the display was duplicating.

**Root cause:** `services/dashboard/public/index.html:addTranscript()` appended unconditionally. One bus event can reach the dashboard WS multiple times via different event type paths (dm:whisper + npc:approved + scripted_speech + world:timed_event) all referencing the same text. Each one appends a new log entry.

**What changed:** `index.html:3017` — `addTranscript()` now keeps a 3-second deduplication window keyed by `speaker|text[:200]`. Entries within the window with the same key are skipped.

**How to verify:** Trigger any scripted speech twice with identical text within 3s → transcript shows one entry instead of 2+.

### F5 — Max can voice actions he hasn't executed

**What it was:** Dave verbally told Max "skip to 18:19." Max replied in earbud "Skipping to 18:19. Tomas is changing now..." but the world clock stayed at 17:33, and Tomas doesn't transform at 18:19 (real time is 22:00).

**Root cause:** Max is prompt-only. He has no tool-calling infrastructure in `ai-engine.js`. When asked to do something, he narrates a plausible response without actually being able to execute. His prompt at `prompts/hal-codm.md` didn't tell him this limitation.

**What changed:** `prompts/hal-codm.md` — added a **YOUR LIMITATIONS** section before YOUR VOICE:
- Explicit "You do NOT have the ability to execute commands"
- When asked to do mechanical things, Max tells Dave the UI path instead of narrating
- "What is Tomas doing?" must answer from actual state, not future narrative
- "What happens at 22:00?" — answer the timeline without narrating it as happening
- Self-check heuristic: if Max is about to say "Skipping to X" or "I've done Y" — stop, say "To do that, use [UI path]"

**Not fixed:** The real long-term fix is adding Anthropic/Gemini tool-calling to ai-engine so Max CAN advance the clock when asked. That's a 2+ hour code change — out of scope for this fix-ticket. The prompt-level fix is a reliability improvement but not a guarantee.

**How to verify:** After server restart (so the new prompt takes effect), ask Max verbally "advance 30 minutes". Expected: "To advance the clock, use Dashboard Tools tab → Advance Time → 30 minutes" or similar refusal. NOT: "Advancing 30 minutes. Here's what happens next..."

### F6 — Cellar door / Marta positioning

**What it was:** Tied to F1. Marta should be near the cellar door. Image may or may not show a cellar door.

**Root cause:** The map has no discrete "cellar door" wall-segment — the cellar is accessed via a narrative trapdoor that the binder describes. Cellar-access zone is at (1000, 600)-(1280, 1020); that's where Marta's "watch station" makes sense.

**What changed:** Same as F1 — Dave's manual repositioning put Marta at (3990, 1470), behind the bar on the east wall. That's consistent with binder narrative ("runs bar while watching the cellar door"). The cellar is a narrative location not a wall-gate; Marta's proximity to it is fiction reinforced by her bar station.

Added `_narrativeIntentNote` to the scene confirming this.

**How to verify:** Session 0 opening narration: "Marta polishes a glass behind the bar. Every few minutes her eyes flick toward the cellar door" — Dave reads this. The token at (3990, 1470) supports that description visually.

---

## Files touched

```
config/scenes/pallid-hart-ground.json           — +1 line (_narrativeIntentNote)
config/session-0-fragments/03-dominik.json      — reshaped 3 whisper events (dm:whisper → npc:scripted_speech), reshaped Dominik arrival coords
config/session-0-fragments/09-timeline.json     — reshaped Marta confession event (dm:whisper → npc:scripted_speech)
services/ai/comm-router.js                      — _collectActiveLookObservationEvents now takes playerId + zone-filters cellar observations
services/dashboard/public/index.html            — addTranscript() display-side dedup
prompts/hal-codm.md                             — +YOUR LIMITATIONS section (beta finding 5)
```

Zero existing unit tests broken. All 13 suites still pass:
```
test-aoe-check: Passed: 15
test-bagman: Passed: 37
test-combat-auto-start: Passed: 13
test-cover: Passed: 17
test-gregor-slovak-routing: Passed: 7
test-lookup-resolver: Passed: 10
test-npc-arrival: Passed: 17
test-npc-tactics: Passed: 43
test-ooa-execution: Passed: 19
test-shooting-into-melee: Passed: 26
test-spurt-agent: Passed: 9
test-vladislav-awareness: Passed: 15
test-vladislav-demo: Passed: 27
```
254 assertions total still green.

---

## Re-test protocol (owed)

Before Dave's beta re-pass, need a live verification run covering:

1. ✅ Boot server, watch boot log for 7 fragment merges. Trigger `/api/map/load/pallidhearfloor1` + `/api/session/start`.
2. ✅ Check scene token positions — Marta east of map at bar, Vlad bottom-left, etc.
3. **Pending live verify:** Advance clock to 20:00:01 → Dominik's arrival token at (1500, 900). Not storage-east.
4. **Pending live verify:** Advance to 20:20:01 → Ed's Chromebook WS gets Slovak text, DM earbud gets English, room speaker silent.
5. **Pending live verify:** Advance to 20:45 → same for Ed + Marta-Kim whisper chain.
6. **Pending live verify:** Advance to 21:00 → Dominik's third whisper delivers.
7. **Pending live verify:** At any time in 17:30-21:00, force Ed to trigger an active perception check while in common room → gas-spore observations should NOT fire for Ed.
8. **Pending live verify:** Fire two identical scripted speeches back-to-back → only one in transcript panel.
9. **Pending live verify:** (Max prompt) Restart server to pick up new prompt. Ask Max "advance 30 min" — should get UI-path response, not fake narration.

Recommendation: Dave re-runs his manual beta flow now. This fix ticket targeted the root causes of what he hit. The re-test protocol above is the minimum live-verification set he should confirm before considering merge-ready.

---

## Kill switches (no new ones — existing set covers)

No new runtime flags added for this fix. Existing `POST /api/combat/set-flag` still covers all combat mechanics. The fragment fixes (F2, F3) are data/logic changes that can't be toggled live. Rollback path: `git revert <commit-sha>` or rename fragment to `.bak`.

---

## What I couldn't fix in this session

**F5 real fix (Max tool-calling)** — this is a 2+ hour code change (add Gemini tool-use to ai-engine, wire world-clock/combat/map to callable tools). The prompt-level fix above is a mitigation, not a solution. **Sunday workaround:** Dave only asks Max questions, never commands. For mechanical changes, Dave uses the dashboard directly. When in doubt about what Max told him: check the state via `/api/state` or `/api/world`.

---

## One-line verdict

🟡 **Ready for Dave's re-beta.** All 6 findings addressed. Three F2/F3 fixes need live verification after server restart. F5 mitigated via prompt but not fully fixed. Full live re-test still owed before merge — Dave drives that.

— Claude Code (Opus 4.7)
