# Phase 3 — Brother Dominik Novák

## What was built

- **`config/actors/brother-dominik-novak.json`** — vampire spawn actor file, CR 5, statblock matches the work-order spec (82 HP, AC 15, regen, spider climb, vampire weaknesses). Carries `int_tier_override_when_disguised: "TACTICAL"` and `int_tier_when_revealed: "HUMANOID"` so npc-tactics picks the right behavior for each phase. Disguise metadata includes tells (DC 13 Religion for unconsecrated cross, DC 10 Medicine for cold skin, Zarina's Mark auto-detects necrotic aura at 30ft).
- **`config/session-0-fragments/03-dominik.json`** — merged on top of session-0.json via the new fragment loader. Contains:
  - Full NPC dispositions block with disposition-per-PC, Slovak whisperScript (3 whispers with both Slovak text and narrator translation), combat lines, disguise resources
  - 9 new timed events:
    - 20:00 `dominik-arrival` — front door bangs, Dominik stumbles in
    - 20:02 `dominik-first-greeting` — Common greeting to the room
    - 20:20 `dominik-first-whisper-opening` — Slovak whisper to Ed (conditional on Ed availability)
    - 20:30 `dominik-requests-room` — asks Marta, gets Room 3
    - 20:32 `dominik-goes-upstairs` — token moves to upper floor Room 3
    - 20:37 `dominik-returns` — token moves back to common room
    - 20:45 `dominik-second-whisper-middle` — Slovak whisper, conditional
    - 21:00 `dominik-close-whisper` — Slovak whisper, conditional
    - 21:15 `vladislav-recognizes-dominik` — sets `state.flags.vladislav_knows_about_dominik`
  - `futureHooks.dominiks-master` — unnamed rival master seeded for post-Session-0

## Fragment loader (infra for Phase 3+ and beyond)

Extended `utils/config-loader.js` with:
- Array-concat deep merge (previously: arrays replaced)
- Automatic scan of `config/session-0-fragments/*.json` after the base session file merges
- Alphabetical load order — prefix fragments `03-`, `04-`, `05-` etc.

Verified: with no fragments the loader produces identical output to before (44 timedEvents). With `03-dominik.json` the count is 53.

## What's intentionally not built in this phase

- **`npc:arrival` dispatch handler** — the `dominik-arrival` event's `dispatchEvents` field is a new pattern. The existing world-clock-service fires the event but ambient-life / map-service don't yet listen for `npc:arrival`. For April 19, the DM has two options:
  - Manually place Dominik's token at 20:00 via the map panel (actor slug = `brother-dominik-novak`, default pos in the fragment)
  - Or defer the arrival presentation and just have him appear in the next Max whisper
  A proper `npc:arrival` listener that auto-places the token and fires an atmosphere cue is a next-session item. Flagged in KNOWN-ISSUES.
- **Disguise-to-combat transition** — Dominik's actor file carries both INT tier values. combat-service's `_tryPositionalDecide` currently reads `int_tier || int_tier_when_revealed` — so if his disguise is up he uses TACTICAL, if Dave manually sets `state.npcs.brother-dominik-novak.disguise.active = false` (or the disguise metadata is stripped at scene-state), combat-service will fall back to the `int_tier_when_revealed` = HUMANOID. A clean state-machine for disguise flipping is a Phase 5 concern (Vladislav has a similar need).
- **Conditional check evaluation** — the `checkFlag` field on several events is informational only; world-clock's condition evaluator uses structured conditions, not free-form JS. The DM (or a small handler update) must gate Ed-specific whispers manually for Sunday. Flagged in KNOWN-ISSUES.

## Manual verification checklist for Dave

1. Start bare-metal via `~/dark-pilgrimage/start.sh`
2. Watch boot log for `[config] Merged fragment: 03-dominik.json`
3. `curl -k https://localhost:3200/api/world/timed-events | jq '. | length'` (or equivalent) — should show 53 total
4. `curl -k https://localhost:3200/api/npcs/brother-dominik-novak` (if exposed) — Dominik data present
5. Advance world clock past 20:00 and watch for the dominik-arrival DM whisper

## Risk

Low-risk change. The fragment is purely additive. If anything misbehaves:
- Remove or rename `config/session-0-fragments/03-dominik.json` → everything reverts
- The only code change outside the fragment is `utils/config-loader.js`, which falls back cleanly when no fragments directory exists.
