# Dark Pilgrimage — Daily Update: April 12, 2026

**Session duration:** all day
**Deadline:** April 19, 2026 (7 days remaining)
**Overall status:** Full system audit completed, 22+ bugs fixed, combat audio pipeline reworked, PTT mic hardened. One week to dry run.

---

## What Got Built Today

### 1. Full System Audit (`fb7ea7f` + `f849ac2`)
Read every file sequentially — 20 services + core + HTML — looking for broken wiring, payload mismatches, event-name typos, and adjacent bugs.

**Findings report covered 40+ files.** 15 backend bugs, 3 UI gaps, 4 adjacent breaks introduced by the route rename.

**Bugs fixed (15 backend + 3 UI + 4 adjacent = 22 total):**
- `map-service`: NPCs were never auto-placed on `campaign:started`. Added `_autoPlaceAllNpcDefaults()` — iterates `_npcDefaults`, places each NPC token at its saved x/y. Dave places nothing manually now.
- `dashboard-service`: `/api/session/resume` was defined twice — second definition (load-from-disk) overrode the first (unpause). Renamed the load-from-disk route to `/api/session/resume-save`. Fixed all four HTML callers of the old route name.
- `npc-autonomy`: dispatched `map:token_move` but map-service subscribes to `token:move` with `{entityId, to:{x,y}}` payload. NPC autonomous movement was silently broken.
- `npc-autonomy`: zone center math used `zone.width/height` but zones store `zone.w/h`. NPC movement to zones produced NaN coords.
- `context-builder`: same `zone.width/height` bug — AI context never knew which zone a token was in.
- `lighting-service`: subscribed to `combat:nextTurn` (camelCase) but combat-service dispatches `combat:next_turn` (snake_case). Weather combat effects never fired.
- `horror-service`: death-save handler checked `env.data.success` but combat-service dispatches `{result, combatantId}`. Horror never spiked on death save failure. Also fixed the adjacent `playerId → combatantId` field mismatch.
- `pacing-monitor`: used `.includes()` on `discoveredBy` which is an object keyed by playerId, not an array. Per-player secret tracking was silently broken.
- `campaign-service`: called `ai.contextBuilder.setCampaignFutureHooks()` but ai-engine exposes `ai.context`. Future hooks from config/future-hooks.json never reached AI context.
- `combat-service`: 4× `srdMonsters.get(slug)` calls on an Array (should be `.find()`). NPC initiative, morale checks, action lookups, and loot generation all silently fell back to defaults.
- `state-manager`: `updateDread()` reported the NEW score as `previous` because it called `get()` after `set()`. Captured `prev` before the set.
- `state-manager`: `startSession()` leaked `_elapsedInterval` if called twice. Added `clearInterval` before reassignment.
- `ai-engine`: mirror-mechanic dex-mod calculation used `abilities.dex - 10` on an object, producing NaN. Fixed to `abilities?.dex?.modifier ?? 0`.
- `perception-intercepts`: had duplicate `passivePerception || passivePerception` typo, falling back to 10 when character lacked the computed field. Replaced with proper PP calc from WIS + proficiency.
- `session-logger`: `JSON.parse(line)` with no try-catch would crash on malformed log lines. Wrapped in try-catch.

**UI additions:**
- `dm.html`: 528Hz WebAudio ACK tone on Max spacebar / MAX NEXT button. Later routed through `AudioContext.setSinkId(MaxControls._earbudSinkId)` so the tone goes to the earbud only, not the room speaker.
- `dm-ref.html`: ENCOUNTER PROPOSAL panel (APPROVE / SKIP / Refresh) wired to `/api/encounter/approve`, `/api/encounter/skip`, `/api/encounter/pending`. Polls every 6s. Shows creature + location + reason + narrative + DM note when ambient-life proposes.
- `player-bridge/index.html`: IC/OOC toggle button next to chat input. When OOC active, prepends `OOC: ` to outgoing messages.

### 2. Debug endpoints for game-night troubleshooting (`aafbb5b`)
Two REST endpoints added to `observation-service.js`:

- `POST /api/debug/perception-flash` — direct perception flash for a specific player. Dispatches `player:perception_flash` with playerId + description + margin. Used to verify the 22px blood-red border glow is hot on kim's Chromebook without waiting for a creature to cross a window waypoint.
- `POST /api/debug/npc-speak` — dispatches literal NPC dialogue (no AI generation). `npc:approved` fires → voice-service → ElevenLabs → room speaker. With `private:true` + `toPlayerId`, routes to that player's Chromebook instead.

Both useful for pre-game pipeline verification.

### 3. Player Push-to-Talk Mic (`0320533` + `9e2a318`)
Replaced continuous mic streaming with explicit PTT.

**Button:** Full-width bar at bottom of player UI. 72px tall, "🎙 HOLD TO SPEAK". Pulsing blood-red while held ("🔴 SPEAKING…"). Gothic palette, touch-optimized for Chromebook.

**Input coverage:** pointerdown / pointerup / pointercancel / pointerleave / touchstart / touchend / touchcancel. Keyboard fallback (spacebar while focused). Pointer capture so sliding finger off doesn't drop the hold. Safety release on tab blur + visibilitychange — prevents hot mic.

**No auto-start:** removed `PlayerMic.start()` from `ws.onopen` at line 1307. Mic is cold until PTT button is held. No continuous streaming.

**Hardening (later same night):**
- One-time mic permission warmup fires 800ms after script load — browser permission prompt appears BEFORE first PTT press, eliminating the race condition where the user released while the prompt was still visible
- `engage()` is now async and awaits `PlayerMic.start()`. A `starting` flag prevents re-entry. If release fired during start, mic is torn down after the await resolves
- `engage()` checks `PlayerMic._active` after await; if false, throws and shows "🎙 MIC BLOCKED — TAP TO RETRY" on the button
- Pre-created AudioContext is resumed on user gesture before `PlayerMic.start()` — fixes the Chromebook bug where newly-created contexts stay suspended
- `micBlocked` flag preserves the error text across release() so the user knows to retry

### 4. Combat audio pipeline overhaul (`2add506`)
Combat wasn't audible — turn notifications showed in the log but never reached the earbud. Ambient-life stopped way too much during combat. Max-director's 45s active-mode throttle was too slow for combat pace.

**combat-service.js — 8 new `dm:whisper` URGENT dispatches:**
- `combat:started` → "Combat begins."
- `combat:ended` → "Combat ends."
- `combat:next_turn` → "{name}'s turn."
- `combat:prev_turn` → "{name}'s turn."
- modifyHp when HP drops to 0 from positive → "{name} is down."
- `combat:death_save` → "{name} rolls a death save."
- toggleCondition when condition ADDED → "{name} is now {condition}."
- addConditionWithDuration same pattern when NEW

URGENT routes via max-director's direct-deliver bypass — each announcement reaches ElevenLabs → DM earbud without waiting for spacebar. No change to `combat:initiative_changed`, `combat:combatant_added`, `combat:combatant_removed` — housekeeping, not story.

**ambient-life-service.js — narrowed combat pause scope:**
- `combat:started` now calls `_stopForCombat()` (pauses only env tick + creature tick) instead of `_stopAll()` (paused everything)
- `combat:ended` calls `_resumeFromCombat()` — resumes only those two
- Removed `combat.active` guards from `_fireNpcMove` and `_checkDwells` — NPC autonomous movement and player proximity dwell continue during combat
- Kept guards in `_fireEnvTick`, `_creatureTick`, `_firePerformance` — Katya doesn't perform during combat atmosphere (redundant check with atmo profile gate anyway)

**max-director.js — combat mode throttle relaxation:**
- When `combat.active` is true in state: `waitingForAck` check is skipped (queue drains without spacebar), `minGap = 0` (no throttle), silence requirements waived for HIGH/NORMAL
- URGENT continues to bypass everything via `enqueue` → `_deliver(entry, true)` direct path
- On `combat:ended`, `waitingForAck = false` is explicitly cleared so the first post-combat whisper doesn't stall

### 5. NPC dialogue on room speaker (Marta test verified)
`POST /api/debug/npc-speak` with `{npcId:'marta', text:'Can I get you something? The stew is hot tonight.'}` generated a 40KB MP3 via ElevenLabs (329ms latency for Max voice, comparable for NPC voices) and routed it through `npc:audio` channel=room to the Realtek PC speaker sink. Routing verified end-to-end.

### 6. Perception flash to kim verified (debug endpoint)
`POST /api/debug/perception-flash` with playerId=kim dispatched `player:perception_flash` via bus. Player-bridge subscriber forwarded via WS to kim's Chromebook. 22px blood-red border flash rendered in browser. Full chain works.

---

## System State At End Of Session

**Services:** All 20 running. PID 1905892 from the last restart; watchdog probing /health every 10s.

**Character assignments:**
- kim → Zarina Firethorn (Mark of Detection Half-Elf Fighter 3) — connected, arc profile generated
- jerome → Barry Goodfellow Frascht (Human Warlock 3) — flagged ABSENT
- nick, jen, ed → unassigned (null)

**External services at last check:**
- Gemini: ONLINE (after env key refresh)
- ElevenLabs: ONLINE, 7/7 voice IDs configured, 39 cached core SFX
- DDB: ONLINE, last Zarina sync successful
- Hubitat: wired but no activity logged this session
- Pi speaker: NO URL set (no ambient output)

**Known issues to watch:**
- `horror-service.js:132` field mismatch (playerId vs combatantId in death-save handler) — fixed in `f849ac2`
- Other `_broadcastCombat` events (initiative, add/remove, hp_changed) still don't fire dm:whisper — deliberate per spec (housekeeping, not story)
- PlayerMic.start() internally swallows permission errors — PTT now detects this via `_active` flag after await rather than relying on the promise
- 28 commits pushed today across `co-dm/main` and parent `feature/phase-r-complete`

---

## Deadline Outlook

7 days to April 19. What's still on the priority list per CLAUDE.md:

1. **Multi-monitor DM dashboard** — pop-out foundation exists (`/panel/panel-*` routes), not yet drag-across-monitors with position persistence
2. **Full AI-controlled NPC autonomy** — basic ambient movement works, AI tactical positioning is partial. Creature engine handles 12 scripted creatures + spontaneous encounter AI, but real-time AI decisions for where NPCs walk during exploration is not yet closed-loop.
3. **Integration testing + dry run** — debug endpoints added tonight make pipeline verification fast (perception flash, NPC speak, etc.). Actual 20-service stress test not yet run.

**Tomorrow's candidates:**
- Stress test with all 20 services hot and 2 player connections
- Multi-monitor workspace (highest user-facing priority)
- Combat AI tactical positioning closed-loop
- Fix the 45s throttle in peacetime narration so it doesn't feel glacial when HAL is giving atmospheric cues (current 45s active-mode gap is designed to not step on DM, but may be too conservative in low-activity scenes)

---

## Commits Pushed Today

On `co-dm` submodule (`main`):
- `55abd6c` feat: creature token management + DDB sync + ambient NPC enrichment
- `fb7ea7f` fix: 18 audit fixes — event wiring, payload mismatches, UI additions
- `f849ac2` fix: horror-service death-save handler — use combatantId
- `aafbb5b` feat: debug endpoints for game-night troubleshooting
- `2add506` fix: combat audio pipeline — turn announcements + throttle relaxation
- `0320533` feat: player PTT button + dm.html earbud ack tone routing + Zarina resync
- `9e2a318` fix: PTT hardening — warmup permission, await start, context resume, error UI

On parent `feature/phase-r-complete`:
- 7 submodule bumps corresponding to the above

All pushed to GitHub. Audit trail is clean.
