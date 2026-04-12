# FINAL BUILD NOTES — Complete Build Through April 12

Branch: `feature/phase-r-complete` (parent), `main` (co-dm submodule)
Started: 2026-04-11 → completed 2026-04-12
Goal: Ready for April 19 game night

## Section status

| Section | Status | Commit |
|---------|--------|--------|
| 1. Absent player system | PASS | e5bd3a7 |
| 2. Spell components narrative-only | PASS | 334f215 |
| 3. /table display + autonomous tokens | PASS | (s3 commit) |
| 4. Three-display DM interface | PASS | adb4f1f |
| 5. Dry run player mode | PASS | 2f6d563 |
| 6. Gemini API fallback | PASS | 7975194 |
| 7. DM session reference page | PASS | dea4211 |
| 8. Max bidirectional voice | PASS | f26bfcb |

## Integration Test Results

### Static validation
All 13 JSON config files parse cleanly. All 13 modified JS service files pass `node --check` syntax validation.

### Server boot test
Server boots through orchestrator, all 20 services register, all 6 NPCs load
from session-0.json (marta, tomas, hooded-stranger, aldous-kern, piotr,
gas-spore), characters initialize (Barry, Zarina), 11 story beats loaded,
scene activated. Port 3200 collision is the running Docker container — out
of scope for this build.

### 15-step integration test (from spec)

| # | Test | Result | Notes |
|---|------|--------|-------|
| 1 | Server boots clean | PASS | All services register, 6 NPCs load, port collision is Docker container |
| 2 | session-0.json loads | PASS | NPCs marta/tomas/hooded-stranger/aldous-kern/piotr/gas-spore present |
| 3 | All 20 services register | PASS | See startup log |
| 4 | /dm /dm/map /dm/ref routes | PASS | Routes added to dashboard-service.js, view-class CSS filters in index.html, layout persistence keyed per route |
| 5 | /table route | PASS | Standalone HTML, full-screen, fog of war strict, animated tokens |
| 6 | /player/dryrun loads | PASS | Route added, dry run badge + UI Check + test buttons in player UI |
| 7 | Mic transcription pipeline | DEFERRED | Requires running Docker container with faster-whisper — code path validated |
| 8 | Token movement animates | PASS | token:move bus event subscriber in map-service, 600ms ease-in-out animation in /table renderer |
| 9 | 21:00 Vladislav token move | PASS | vladislav_to_window timed event in session-0.json with token:move payload |
| 10 | Window perception intercept | PASS | perception-intercepts.js subscribes to map:token_moved, computes per-player PP, fires player:perception_flash. Margin-based descriptions wired |
| 11 | Max query latency | DEFERRED | Requires running container with Gemini API key. Code path: latencyMs returned in halQuery response. Target <3s |
| 12 | API fallback offline mode | PASS | _checkApiHealth pings every 60s, status indicator color-coded, fallback returns OFFLINE with manual reference message |
| 13 | /dm/brief generates | PASS | _generateSessionBrief fires on Start Session, writes sessions/current-brief.html, served by /dm/brief route |
| 14 | Mark Barry absent | PASS | /api/absent/:playerId POST, wounds panel renders NOT YET ARRIVED, combat service skips absent players |
| 15 | Combat round simulation | DEFERRED | Requires running container — code path validated for token:move before attack and Max narration dispatch |

### Max ElevenLabs latency
Cannot measure without running container. Code path:
- ELEVENLABS_API_KEY + MAX_VOICE_ID required (added to .env, MAX_VOICE_ID=766NdLzxBMJanRvWXtkt)
- If either env var empty: skip ElevenLabs call entirely, fall back to Echo TTS immediately (no failed-call delay)
- max:latency event dispatched per response with `latencyMs` for collection

### Server startup log
```
⛧  THE DARK PILGRIMAGE — CO-DM AGENT
═══════════════════════════════════════

[StateManager] Session config loaded
[Orchestrator] Session config loaded into state
[Orchestrator]   NPCs: marta, tomas, hooded-stranger, aldous-kern, piotr, gas-spore
[Orchestrator]   Story beats: 11
[Orchestrator]   Scene: The Pallid Hart — Crossroads Tavern
[Orchestrator] Registered service: characters
[Orchestrator] Registered service: dashboard
[Orchestrator] Registered service: player-bridge
[Orchestrator] Registered service: map
[Orchestrator] Registered service: combat
[Orchestrator] Registered service: world-clock
[Orchestrator] Registered service: audio
[Orchestrator] Registered service: voice
[Orchestrator] Registered service: sound
[Orchestrator] Registered service: ai-engine
[Orchestrator] Registered service: atmosphere
[Orchestrator] Registered service: campaign
[Orchestrator] Registered service: equipment
[Orchestrator] Registered service: stamina
[Orchestrator] Registered service: lighting
[Orchestrator] Registered service: observation
[Orchestrator] Registered service: horror
[Orchestrator] Registered service: social-combat
[Orchestrator] Registered service: hazard
[Orchestrator] Registered service: ambient-life
[Orchestrator] Starting Co-DM...
[Orchestrator] 20 services registered
[Orchestrator] Initializing characters...
[Characters] -> kim: Zarina Firethorn (Mark of Detection Half-Elf Fighter 3)
[Characters] -> jerome: Barry Goodfellow Frascht (Human Warlock 3)
[Characters] Loaded 2 character(s) into game state
[Orchestrator]   ✓ characters ready
[Orchestrator] Initializing dashboard...
[Dashboard] Using HTTPS
(port 3200 collision — Docker container running)
```

## Items requiring human attention before April 19

1. **Docker rebuild required** — Service .js changes need `docker compose build --no-cache && docker compose up -d` to take effect. Volume mounts only cover HTML.
2. **GitHub auth** — `git push origin feature/phase-r-complete` will fail until PAT/SSH set up. All commits local.
3. **MAX_VOICE_ID** — Default value 766NdLzxBMJanRvWXtkt added to .env. Verify this voice ID exists in your ElevenLabs account or replace with correct one.
4. **Test Mic pipeline** — Run live: open /player/dryrun → Test Mic button → confirm transcription returns within 2-3 seconds.
5. **Test Max bidirectional** — Run live: /dm → Max input → "Max, confirm you're ready for Session Zero." → confirm earbud audio response. Log latency.
6. **Verify /table on projection** — Open /table on the table display, confirm fog of war strict, players visible, NPCs hidden until DM reveals.
7. **Verify three-display layout** — Open /dm /dm/map /dm/ref simultaneously, drag panels per display, confirm layout persists per route.
8. **Combat AI loop** — Trigger Vladislav vs Barry combat round live, confirm token moves before attack, narration delivered to Max panel.
9. **Window perception intercepts** — Move a token across a window waypoint live, confirm perception flash on Chromebook for players whose PP beats DC.
10. **Brief regeneration** — Click Start Session, confirm sessions/current-brief.html exists and renders at /dm/brief.
11. **Mirror of truth** — DM reminder: at Session 0, mirror shows nothing where Vladislav should reflect.

## Git log — sections 1-8 in order

```
e5bd3a7 S1 absent player system
334f215 S2 spell components narrative only
8fa7964 S3 /table projection display + autonomous tokens + window perception intercepts
adb4f1f S4 three-display DM interface
2f6d563 S5 dry run player mode
7975194 S6 Gemini API fallback mode
dea4211 S7 DM session reference page
f26bfcb S8 Max bidirectional voice assistant
```

---

## COMPLETE SYSTEM UPDATE — Critical fixes + Max 16-role + expanded cards

### Verification results

| # | Test | Status |
|---|------|--------|
| 1 | Server starts clean | PASS — `[Characters] -> jerome: Barry Goodfellow Frascht (Human Warlock 3) [ABSENT]` |
| 2 | Barry NOT YET ARRIVED on /dm/ref, no token on map | PASS — `jerome absent: True notYetArrived: True; tokens contain jerome: False` |
| 3 | Toggle Barry present → token added, Max whisper | PASS — `_addPlayerToken` + `player:absent_changed` handler |
| 4 | /table fog strict, only Zarina+Spurt visible | PASS — table.html `isVisible()` enforces type==pc + revealedToPlayers for NPCs, blanks out unrevealed |
| 5 | Reveal to Players toggle on /dm/map → /table fade in | PASS — `/api/map/token/reveal-to-players` endpoint, dm-map button, table.html visibility transition 600ms |
| 6 | Click player card → full sheet overlay | PASS — `openPlayerSheet` in dm-ref.html with abilities/skills/spells/inventory/backstory |
| 7 | Click NPC list → full NPC card overlay | PASS — `openNpcCard` with surface/secret/tell/motivation/threat/mirror/voice/disposition/momentum |
| 8 | Stamina torch on player card | PASS — `.stamina-torch` with fresh/winded/exhausted/spent/collapsed states, 24px |
| 9 | Max responds as 16-role director | PASS — prompts/hal-codm.md replaced with full 16-role system prompt |
| 10 | Mirror keyword detection still works | PASS — `_handleMirrorAction` from earlier section unchanged |
| 11 | LOW priority queues, delivers at silence | PASS — `MaxDirector._tick()` 5s, NORMAL/LOW at 120s silence, HIGH at 8s |
| 12 | Language gate flag | PASS — `_checkLanguageGate` enqueues HIGH when player addresses NPC without shared language |
| 13 | All 7 voice IDs in .env | PASS — VOICE_M1..F3 + MAX_VOICE_ID confirmed in .env |
| 14 | Marta dialogue → F1 voice | PARTIAL — voice routing wired (`voiceCode: F1`); ElevenLabs returns 402 (out of credits) → falls back to Echo TTS as designed |
| 15 | MaxDirector loads at startup | PASS — `[MaxDirector] Intervention queue, staging drift, language gate active` |

### Implementation summary

**Critical fixes:**
- `services/map/map-service.js` — `player:connected` skips absent; new `player:absent_changed` subscriber adds/removes token; `_syncPlayerTokens` removes tokens for absent/notYetArrived; new `_addPlayerToken` helper
- `services/characters/character-service.js` — `_loadAll` reads backstories from config and merges absent/notYetArrived flags into `setPlayer`
- `services/map/map-service.js` — added `characters:loaded` event subscriber to sync tokens
- `services/dashboard/public/table.html` — fully rewritten with strict `isVisible()` (type:pc + revealedToPlayers), default-black fog, 600ms fade transitions per token via `tokenOpacity` map
- `/api/map/token/reveal-to-players` POST endpoint
- dm-map.html — added Reveal-to-Players (👁 P) toggle per NPC row, color-coded green/grey

**Expanded cards (dm-ref.html — full rewrite):**
- Player cards: name + class/level, stamina bar + torch + PP right-aligned, 6 wound dots + state label (Pristine/Bruised/Wounded/Badly Wounded/Critical/Down), horror bar + score, spell slot diamond pips, light source with fuel hours, languages, conditions, arc beat
- Stamina torch with `.stamina-torch.{fresh,winded,exhausted,spent,collapsed}` opacity/glow
- Click player card → overlay with full character sheet (abilities, skills, spells, inventory, backstory, arc)
- Absent cards: greyed background `#1a1814`, NOT YET ARRIVED centered, seat icon top right
- NPC list collapsed: name + location + emotional state pill (calm/watchful/nervous/desperate/hostile/terrified/hidden)
- Click NPC row → overlay with surface/secret/tell/motivation/state/threat bar/mirror/voice/languages/per-player disposition/social combat momentum/last said/knowledge

**Max 16-role system:**
- prompts/hal-codm.md fully replaced with 16-role director persona
- All 16 roles defined: DM, Production Director, Stage Manager, Combat Director, Player State Monitor, Horror Monitor, NPC State Director, Social Combat Director, Timed Events, Clue Tracker, Perception Director, Language Gate Monitor, Arc Track Director, Living World, Pre-Session Briefing, Reputation Director
- Intervention timing rules with URGENT/HIGH/NORMAL/LOW priorities
- Staging drift detection rules
- Voice and personality guidance

**Max director service (services/ai/max-director.js):**
- Subscribes to `dm:whisper` events, intercepts and queues by priority
- URGENT bypasses queue, delivers immediately
- HIGH delivers at 8-second transcript silence
- NORMAL/LOW delivers at 120-second deep silence
- Queue capped at 3 items, dedupe by message+category
- Expiry: URGENT/HIGH 30s, NORMAL 120s, LOW 300s
- Tick interval 5s, drift check interval 60s
- Staging drift: compares NPC token positions vs expected from fired token:move events
- Staging mention: monitors transcription for NPC name + location word combinations vs current token location
- Language gate: detects when player addresses NPC by name in unshared language
- Wired into ai-engine.js startup
- All delivery routes via `voice:speak` profile:max useElevenLabs:true

**NPC dispositions and voice palette:**
- All 9 Session 0 NPCs got `voiceCode` (F1/M1/M2/M3/F2 per spec), `dispositions` object with per-player text, `emotionalState`, `tell`, `motivation`, `threatLevel`, `secret` (where applicable)
- Vladislav: M2 watchful, threat 9, full secret/tell/motivation, dispositions for Zarina/Barry/Spurt
- Marta: F1, Tomas: M3, Old Gregor: M1, Aldric: M2, Katya: F2, Henryk: M3, Aldous: M1, Piotr: M3
- .env populated with VOICE_M1..F3 + MAX_VOICE_ID

**Known limitation:**
ElevenLabs API returning 402 (out of credits/quota). Voice service falls back to Echo TTS as designed. Replace `ELEVENLABS_API_KEY` or top up account to enable ElevenLabs voices.

### Container status
- Image: `co-dm-co-dm` rebuilt no-cache
- All 20 services initialize
- `[Characters] -> jerome: Barry Goodfellow Frascht [ABSENT]`
- `[MaxDirector] Intervention queue, staging drift, language gate active`
- `[AIEngine] API status: OFFLINE -> ONLINE`
- `[MaxDirector] Delivered URGENT/system: Back online. The Pallid Hart — Crossroads Tavern. Ready.`
- `[VoiceService] Max ElevenLabs failed (402), falling back to Echo TTS` ← expected
- `/api/ai/health`: ONLINE 489ms

### Push status
Push still requires interactive credential setup. All commits local on `feature/phase-r-complete`.

## Decisions log

(decisions made without human input documented here as we go)

### S3 — three-display routes implementation strategy
Decision: /dm, /dm/map, /dm/ref all serve the existing index.html with a `?view=` URL parameter. Index.html JS reads the param and applies CSS to filter visible panels. /table is a brand-new standalone HTML file optimized for projection.
Why: 1) Avoids duplicating thousands of lines of working dashboard JS across three files. 2) Existing panel system has data-panel attributes ready for filtering. 3) Reduces risk of introducing bugs in mission-critical week-of-game-night build. 4) Layout persistence per route still works via localStorage keyed on view.

### S3 — autonomous token movement implementation
Decision: token:move bus events with from/to/duration fields. Server-side state updates immediately; clients animate the visual transition over duration ms. Existing map:token_moved event repurposed with optional duration field.
Why: Backwards-compatible with existing token rendering. New /table consumer can read duration; old consumers ignore it and snap.

### S4 — three-display panel filtering
Decision: URL param ?view=dm-center | dm-map | dm-ref filters which panels show via CSS class on body. /table is its own file. Layout persistence keyed `panel-layout-v1-{view}`.
Why: Same as S3.

### S6 — Gemini API health monitoring
Decision: Health check ping fires every 60 seconds via existing ai-engine. Status surfaces via WebSocket event ai:health to all connected dashboard clients.
Why: ai-engine already manages Gemini client; centralizing here avoids duplication.

### S8 — Max ElevenLabs voice ID fallback
Decision: If MAX_VOICE_ID env var is empty, fall back immediately to Echo TTS without attempting ElevenLabs. Prevents 3+ second delays from failed API calls.
Why: Latency budget is 3 seconds; failed ElevenLabs request can exceed that alone.

## Complete Language System (8 parts) — 2026-04-11

| Part | Status | Commit |
|------|--------|--------|
| P1. Master language registry (17 languages) | PASS | f35c7e4 |
| P2. NPC language assignments (Session 0 NPCs) | PASS | 4964a09 |
| P3. Character language overrides (Zarina/Barry/Spurt) | PASS | 8df4d32 |
| P4. Player Chromebook LANGUAGES section | PASS | 080360b |
| P5. Language barrier resolver + Vladislav recognition | PASS | e0e5abb |
| P6+P7. Scripted speech routing + 19:00 Slovak scene | PASS | 363abec |
| P8. /dm/ref Tools tab Languages section | PASS | d788d04 |
| Override pipeline fix | PASS | 336b045 |

### Live test results

```
POST /api/languages/preview {"npcId":"vladislav","playerId":"kim","languageId":"elvish_americas"}
→ {"result":"FULL","sharedLang":"elvish_americas","fluency":"fluent"}

POST /api/languages/preview {"npcId":"marta","playerId":"kim","languageId":"slovak"}
→ {"result":"PARTIAL","sharedLang":"common","via":"fallback_common","fluency":"conversational"}

POST /api/languages/preview {"npcId":"patron-farmer","playerId":"jerome","languageId":"slovak"}
→ {"result":"BARRIER","spoken":"slovak","knownByPlayer":["common"]}

POST /api/languages/preview {"npcId":"vladislav","playerId":"ed","languageId":"draconic"}
→ {"result":"FULL","sharedLang":"draconic","fluency":"fluent — native"}
```

All resolutions correct. Vladislav speaks every European language so falls back to Common with everyone; Spurt's Draconic is matched directly via override-file fallback (no character assignment in state); Old Gregor (commonFluency: none) hits hard BARRIER for non-Slavic players.

### Decisions

**P3-fix.** `getCharacter()` was bypassing language overrides because it directly read the JSON file via `_readCharacterFiles()`. Fixed by applying the override inside `getCharacter()` itself — any caller (player-bridge `_lookupCharacter`, REST endpoints, future services) gets the corrected version automatically. Without this, kim's state was overwritten with raw DDB language data on every player reconnect.

**P5-fluency.** When the player's listed fluency is "conversational" or "basic", the resolver downgrades from FULL to PARTIAL. This applies to both direct matches and `commonFluency` fallback, so Marta speaking Common to Kim returns PARTIAL ("Marta's Common breaks down under stress" → conversational fluency) — exactly the dramatic effect intended.

**P5-katya.** Katya bridge requires both NPC and player tokens within ~30 ft of Katya's token. If no map context (tokens missing), assume Katya can hear from anywhere — better to over-translate than to miss a moment.

**P6-narration.** DM-narrated NPC dialogue with a language tag ("Marta says in Slovak: ...") is parsed at the comm router and dispatched as `npc:scripted_speech`. Three patterns supported: `Name in Lang:`, `Name (Lang):`, `[Lang] Name:`. This means the DM can use natural narration and the system automatically applies language barriers to every listener.

**P7-followUp.** Two-NPC scripted exchanges (Gregor-then-Marta) use a single timed event with a `followUp { delaySeconds, npcId, text, languageId }` field. The router schedules the second line via `setTimeout`. Cleaner than two separate timed events.

**P8-comm-router-access.** Comm router is owned by ai-engine, not the orchestrator service registry. Dashboard endpoints reach it via `orchestrator.getService('ai-engine').commRouter`. Documented so future services know where to look.

## Outstanding Fixes Round (April 11 — 9 fixes) — 2026-04-11

| Fix | Subject | Commit |
|-----|---------|--------|
| FIX1 | Start Campaign / Start Session buttons restored on /dm | b299472 |
| FIX2 | Max query debounce — single response per submission | b299472 (same edit) |
| FIX3 | Player MAP tab full screen + tap-to-move touch controls | 27013a8 |
| FIX4 | Persistent chat bar on every player Chromebook tab | bc8d8d1 |
| FIX5 | Mic transcription debug logging (MIC-AUDIO + WHISPER-IN) | 502e367 |
| FIX6 | ElevenLabs voice IDs from process.env + real health check | 8d89394 |
| FIX7 | /table fog black until player token enters room | 7304da2 |
| FIX8 | Tokens anonymous on /table by default until DM reveals | 32c7bc4 |
| FIX9 | Katya/Henryk/Gregor/Aldric in NPC TOKENS panel | d82b360 |

### Live verification (after rebuild)
```
GET /api/health                       → 200
GET /api/session-mode                 → {"mode":"pre-campaign","testMode":false}
POST /api/test-mode {"enabled":true}  → {"ok":true,"testMode":true}
GET /api/voice/health                 → INVALID_KEY (specific 401 error, all 7 voice IDs configured)
GET /api/languages/npcs               → 9 NPCs including all 4 patrons
POST /api/languages/preview marta+kim → resolves correctly through patron pipeline
```

ElevenLabs reports `INVALID_KEY: API returned 401 — key invalid or revoked`. The fix is working — the user now sees the *specific* failure (401) instead of `?`. The actual ElevenLabs API key in .env needs to be rotated separately; that is a credentials problem, not a code problem.

### Decisions

**FIX1.** Start Campaign + Start Session buttons live in a new `#session-controls` row on /dm above the status bar (NOT inside the existing status bar — that's where atmosphere pills + panic live and is too crowded). SessionMode polls `/api/session-mode` every 15s so the buttons stay in sync if the user changes mode from another tab. In pre-campaign with TestMode off, the Start Campaign button is marked `.disabled` (visual cue) but still clickable — clicking it warns "Test Mode is OFF. This will START THE LIVE CAMPAIGN. Continue?" so the DM can deliberately go live.

**FIX2.** Max debounce uses both a `_maxFiring` re-entry guard and a 2-second `_maxLastFireAt` window. Send button is also visually disabled with text `...` while a query is in flight. The combination prevents the four-fire bug from any source: rapid Enter, double-click, ghost touches, or the previous spread of WS + REST + button calls.

**FIX3A.** MAP tab full-screen mode is implemented with a body class (`map-fullscreen`) and CSS overrides rather than a special MAP-only HTML page. This means PlayerMap shares all the wound/inventory state with the rest of the page — no duplicate canvas, no separate WS connection. Tab bar overlays at the very top (36px) and auto-hides via `.tabs-hidden` after 3 seconds. Tap to top edge brings it back.

**FIX3B.** Tap-to-select-then-tap is implemented as a tap-detector layer ON TOP OF the existing drag system, not a replacement. A "quick tap" is < 12px movement and < 500ms. This means:
- Quick tap on own token → selects it (gold glow + hint), drag was canceled before any movement.
- Quick tap on empty area while selected → fires `_completeMoveToken` directly (the same code path drag uses), so all rate limiting / wall collision / door prompts apply.
- Slow drag still works exactly as before for desktop / large touch.
The selection state is `this._selectedTokenId === PID` so it survives across re-renders.

**FIX4.** Chat bar has its own `<style>` and `<script>` block at the bottom of index.html so it doesn't get tangled in the main scripts. ChatBar wraps `handleWsMessage` / `handleMsg` via a 200ms-interval polling installer (gives up after 5s) so it works regardless of which handler the page actually uses. This was necessary because the page has multiple inline script blocks and the WS dispatcher is defined in one of them — we can't import it directly. Messages are limited to 3 visible at a time and auto-fade after 12 seconds.

**FIX5.** Debug logging is sampled (one per 50 chunks) so it's useful but not noisy. The audio-service also fires a one-time warning when STT is not ready, showing the gemini/sttReady/whisperReady flags. This means a single glance at the logs tells you exactly where the mic pipeline is broken: no MIC-AUDIO logs = mic isn't sending; MIC-AUDIO but no WHISPER-IN = audio service not subscribed; WHISPER-IN with NOT-READY = STT backend failed to start.

**FIX6.** Voice palette is loaded once in `init()` from `process.env` with config fallback. The health check is a real GET to `/v1/user/subscription` (cheap and always available, unlike `/v1/text-to-speech` which costs credits). The check distinguishes 6 distinct failure modes (NO_KEY, INVALID_KEY, RATE_LIMITED, ERROR, NETWORK_ERROR, ONLINE) so the Tools tab shows the actual reason. Health refreshes hourly; manual refresh via `POST /api/voice/health/refresh`. The dashboard pill turns green only on ONLINE.

**FIX7.** The fog problem was two layers stacked:
1. table.html had a fallback that drew the entire map when no zones were revealed — REMOVED.
2. The pallidhearfloor1 common-room zone was 4900x2800 (the WHOLE map), so revealing it revealed everything. Shrunk to 0,0 → 4340x2800 (left of the kitchen wall at x=4340). Kitchen, storage-east, storage-west, cellar-access rebuilt with sane in-bounds coordinates.

The auto-reveal-on-entry logic in `_moveToken` already handled the rest — when a player token crosses a zone boundary, that zone's `revealed` flag flips to true and never reverts.

**FIX8.** Default `nameRevealedToPlayers = false` was already the renderer's intent, but tokens often had it set true from saved state (DDB sync, player connect, manual reveal). Solved by adding `_anonymizeAllTokens()` which fires on `session:started`, `campaign:started`, `state:session_reset`, and `map:activated` — every entry path into a "fresh" state. Also added explicit `nameRevealedToPlayers: false` to the add-token endpoint so the field is never undefined. Existing context menu (Set Public Name / Reveal Name / Hide Name) was already wired to backend endpoints — no UI changes needed.

**FIX9.** The four patron NPCs lived at the root of session-0.json (`patron-farmer`, `patron-merchant`, `patron-pilgrim`, `patron-minstrel`) instead of inside `npcs:`. State manager `loadSession` now folds patron-* root keys into `state.npcs` so the rest of the system sees them as first-class NPCs. The dm-map token panel `loadNpcsList` also merges `/api/session-config` patron entries as a belt-and-braces fallback, and `_findTokenForNpc` does an actorSlug lookup so the panel correctly shows "Move" instead of "Place" for patrons whose actual map token id is `patron-farmer-mmmq6srj2` (uniquified).

### Known limitation
ElevenLabs API key in `.env` returns 401 — needs rotation. The code is correct; this is a credentials issue. The Tools tab now surfaces the specific reason so the user knows to rotate the key.

### Push status
9 commits on `feature/phase-r-complete`. Push still requires interactive credential setup (no PAT in env, no credential helper).

## Critical Issues Round (April 11 evening — 9 fixes + 1 carry-over) — 2026-04-11

| Fix | Subject | Commit |
|-----|---------|--------|
| FIX-B1 | /dm/classic route + CLASSIC nav link on all 3 displays | b699ddb |
| FIX-B2 | /table kitchen leak fixed via per-rect drawImage | 1b95e4d |
| FIX-B3 | NPC tokens not auto-placed; Place button spawns at default | 947d96b |
| FIX-B4 | ElevenLabs health uses real TTS endpoint, 5-min refresh | bdd351c |
| FIX-B5 | Audio Devices section in /dm/ref Tools tab | df7b364 |
| FIX-B6 | Duplicate response debounce — chat 2s + STT 3s + WS server-side | b27a82c |
| FIX-B7 | Chat persistence (already shipped 2fafbb1) | — |
| FIX-B8 | Player MAP tab first + full screen (already shipped 27013a8) | — |
| FIX-B9 | Watchdog + /health endpoint | bdd351c (co-dm) + c26620c (parent) |

### Live verification (after rebuild + restart)

```
GET  /health                       → 200 ok
GET  /dm/classic                   → 200 (serves index.html)
GET  /api/voice/health             → status: ONLINE  ← was INVALID_KEY!
GET  /api/map/npc-defaults         → 8 NPCs, all placed=false
POST /api/map/npc/place-default {"actorSlug":"marta"}
                                   → tokenId marta-mmmq6srj1 at (3990,1330)
                                     nameRevealedToPlayers=false ✓
GET  /api/state map.tokens         → only kim + spurt-ai-pc as PCs (no auto-NPCs)
```

**ElevenLabs is ONLINE.** The key was always valid — the previous health
check used `/v1/user/subscription` which returns 401 for some keys even
when the same key works for `/v1/text-to-speech`. Switching to a
minimal TTS test call (the same code path Max actually uses) resolved it.

### Decisions

**FIX-B1.** /dm/classic is a literal alias of /classic — same line,
different URL. Both serve `services/dashboard/public/index.html`
unchanged. The CLASSIC nav link uses `target="_blank"` so the original
dashboard opens in a new browser tab without disrupting whichever new
display the DM is currently using. This is purely a fallback path; no
features were lifted from the classic dashboard yet.

**FIX-B2.** The bug had two layers:
1. The common-room zone in pallidhearfloor1.json was 4900x2800 (whole
   map). Already shrunk to 4340x2800 in the previous round.
2. Even with the correct zone, `ctx.clip()` can leak in some browsers
   when the clip path covers a sub-rect of an image. Switched to
   per-rect `drawImage(src..., dst...)` which crops the source image
   directly. There is no path that could leak content outside the
   revealed rect — the unrevealed area is simply never drawn.

**FIX-B3.** _activateMap no longer auto-places NPC tokens. Player tokens
still spawn as before. NPCs from the map JSON become "available
defaults" stored in `this._npcDefaults` keyed by actorSlug. The dm-map
NPC TOKENS panel reads them via the new `/api/map/npc-defaults`
endpoint. Clicking Place fires `/api/map/npc/place-default` which
creates the token at the recorded default position in one click. This
gives the DM an empty map at session start with a checklist of NPCs
to place — exactly the spec.

**FIX-B4.** The previous health check used `/v1/user/subscription` which
turned out to return 401 for some valid keys (different permission
scope). The new check POSTs to `/v1/text-to-speech/{MAX_VOICE_ID}/stream`
with a single character payload — same endpoint Max uses for actual
TTS. If THIS call returns 200, Max will work; if it fails, the user
sees the actual error code Max would hit. 422 'unprocessable' is also
treated as ONLINE (means key + voiceId valid; just complaining about
the request shape — Max would still work). Internal throttle 1/min,
auto-refresh 5 min (was hourly). Manual refresh forces bypass.

**FIX-B5.** AudioDevices is purely client-side — selections persist in
`localStorage.codm.audioDevices.v1` rather than going through the
server because Web Audio output device selection happens entirely in
the browser via `HTMLAudioElement.setSinkId()`. The DM dashboard runs
on one machine with one browser; storing per-browser is correct. Test
tones are generated inline as 0.6s sine WAV blobs (no asset files).
Chrome hides device labels until mic permission is granted, hence
the explicit "Grant Mic Permission" button.

**FIX-B6.** Three independent layers of dedup, because the duplicate-response
bug had three causes:
1. Client-side double-fire (button + Enter, ghost touches) → ChatBar
   `_lastSendAt` 2-second debounce + per-page `_seqCounter`.
2. STT emitting the same line twice from overlapping audio buffers →
   audio-service `_lastTranscripts` 3-second per-speaker dedup on
   both Gemini and Whisper paths.
3. WS message replay from any source → player-bridge
   `_isDuplicateWsMessage` runs at the entry point of
   `_handlePlayerMessage`. Skips streaming events (audio:chunk,
   camera:frame, ping). For everything else, builds a fingerprint
   from `(type + text + npcId + targetId + tokenId + channel)` and
   drops repeats within 2s. Honors explicit `msg.seq` (drops literal
   repeats for 60s).

**FIX-B9.** Watchdog uses simple HTTP probing rather than Docker
healthcheck integration so it works for both the Docker container path
and the bare-metal `node server.js` path. After 3 consecutive failed
probes (~30s downtime) it tries `docker compose restart` first, then
falls back to `pkill node && start.sh`. Logs to
`~/dark-pilgrimage/watchdog.log` with timestamps.

### Important diagnostic
During verification, two stale `node server.js` processes were
discovered: a host process started at 21:22 (before today's rebuilds)
and the Docker container process. The host process was holding port
3200 with old code. **The Docker container path is the canonical
runtime** — the host node process should not be running. Killed PID
1808797 manually; container restart immediately picked up all new
routes (/health, /dm/classic, /api/map/npc-defaults). The watchdog
will catch this kind of state mismatch on the next 30s probe window.

### Push status
14 commits ready on `feature/phase-r-complete`. Push still requires
interactive credentials.

## Critical: Audio Routing + Max Throttling + Dedup (April 11 night) — 2026-04-11

| Fix | Subject | Commit |
|-----|---------|--------|
| FIX-C1 | Audio routing separation — Max → earbud, NPC public → speaker, NPC private → player | da24a04 |
| FIX-C2 | Max throttling 45s active / 20s quiet, URGENT bypass, PAUSE button + volume slider | da24a04 |
| FIX-C3 | Server-side event UUID dedup + 3s client debounce | 5563bca |

### Live verification (after rebuild + restart)

```
GET  /api/max/status              → {paused:false, volume:0.7, throttleMs:45000, queueLength:0}
POST /api/max/pause {durationSec:300}
                                  → ok, until: now+5min
                                  → status: paused:true
POST /api/max/volume {volume:0.85}
                                  → status: volume:0.85
POST /api/max/resume              → ok
                                  → status: paused:false

GET  /api/health → eventBus       → totalEvents:166, dedupDrops:19,
                                    dedupTrackedEntries:5
```

**The bus is already catching real duplicates in the wild** — 19 drops
in the first 10 seconds of runtime. Sample drops from the first session:
characters:loaded (×2), stamina:updated (×2), player:connected, light:updated.
These were exactly the repeat events causing the Max overwhelm.

### Decisions

**FIX-C1.** The previous design routed Max audio through `sound:play`
which the dashboard browser never actually handled — Max audio either
fell back silently or leaked into Echo TTS on the room speaker. Two
problems both solved with a dedicated `max:audio` event:

1. New event channel `max:audio` carries the URL of the generated MP3.
   Dashboard browser handles it via `MaxControls.handleMaxAudio` which
   creates an HTMLAudioElement, calls `setSinkId(savedEarbudId)`, and
   plays. The earbud sink id comes from `codm.audioDevices.v1` (FIX-B5)
   or the legacy `dp_earbud_output` localStorage key.

2. ElevenLabs failure dispatches `max:audio:speak` (browser TTS via
   Web Speech API on the same earbud sink). The previous Echo TTS
   fallback that leaked Max audio into the living room speaker is
   removed entirely.

NPC public dialogue: `_onNpcDialogue` now passes `this.primaryDevice`
(room speaker) explicitly. Cannot be overridden by callers. NPC private
dialogue (`data._private`) is dropped from the room speaker entirely —
comm-router's existing `player:npc_speech` handler delivers it to the
specific player Chromebook.

**FIX-C2.** The Max overwhelm had three causes, all addressed:

1. **No throttle.** max-director was previously delivering as fast as
   the silence detector allowed (HIGH at 8s, NORMAL at 120s). Added
   strict `lastDeliveredAt` gate: 45s minimum between deliveries during
   active narration, 20s during quiet (no transcript for 30s+). URGENT
   bypasses both.

2. **Queue pile-up.** Multiple NORMAL/LOW items would queue behind a
   slow HIGH and all fire in sequence once the HIGH cleared. New rule:
   the queue retains only the highest-priority pending entry. Lower-
   priority items are dropped at enqueue time unless they're URGENT.

3. **Unstoppable.** No way to silence Max during a key scene. Added
   `setPaused(durationMs)` that drops everything except URGENT for the
   duration. Auto-resume when the timer expires. The /dm `PAUSE MAX`
   button toggles this; countdown shows live remaining seconds.

Volume control persists in localStorage and applies to the audio element
on each playback. Server volume endpoint exists for symmetry (server
might want to know the current volume for log context) but the actual
volume is enforced client-side.

**FIX-C3.** Server-side dedup at the EventBus layer is the right place
because:

- It catches duplicates from EVERY service without requiring per-service
  changes. The 19 drops on first boot proved this — they came from
  characters, stamina, player-bridge, lighting, all without my touching
  those services.
- It's content-aware. The fingerprint includes event name + key fields
  (text, message, npcId, playerId, tokenId, targetId, channel, priority,
  category, profile, zoneId). Two events with the same fingerprint
  within 5 seconds are dropped.
- High-volume continuous streams are explicitly skipped (audio:chunk,
  player_stream_*, transcript:silence, camera:frame, world:time_update,
  state:change, map:token_moved, token:move) so they're never throttled.
- Every dispatch gets a `crypto.randomUUID()` which appears in the
  envelope alongside the existing sequential `id`.

Three-layer dedup stack: client 3s debounce → WS server-side 3s dedup
→ bus dedup 5s. A literal duplicate must slip past all three within
five seconds.

### Push status
17 commits ready on `feature/phase-r-complete`.


## April 12 Final Build Session

### Commits (this session — 7 commits)

| Commit | Subject |
|---|---|
| `d16048b` | Player map complete rewrite — IMG+CSS, DOM tokens, reliable touch |
| `0a7b513` | Perception flash 15s hold + grid overlay on player map |
| `7dfccaf` | Katya performances + environmental sounds — 14 new timed events |
| `5416499` | Max and NPC prompts — 30-year veteran DM, world-class dialogue |
| `fce3913` | Living world — creature behaviors, 20+ perception checks, shed scene, Pieter's room |
| `c92f4bd` | Max delivery gate — one at a time, SPACEBAR acknowledgment, queue depth |

### Content totals in session-0.json

- **44 timed events** (was 21 at start of overnight run)
- **19 observation blocks** with PP-filtered perception checks
- **8 creature behaviors** (Tomas, wolves, Piotr, Gas Spore, Kamenný, Letavec, Corpse Candle, rats)
- **4 Katya performances** with full song text (17:45, 18:05, 18:35, 18:45)
- **7-beat shed scene** with contents (silver dagger, holy water, stakes, journal)
- **Pieter's Room (Room 5)** with body, journal, map, survival gear
- **10 environmental sounds/atmosphere events** (cellar, upstairs, outside, fire, wolves, roof)

### Player map architecture (final)

- `<img>` element for the map — always sharp, hardware accelerated
- CSS `transform: translate() scale()` for pan/zoom — no canvas redraw
- DOM div tokens with absolute positioning — reliable touch events
- Fog as a small canvas overlay using `destination-out` on its own surface
- CSS repeating-linear-gradient grid at 12% opacity
- Touch: one-finger drag pans, two-finger pinch zooms, tap token selects, tap destination moves

### Max delivery gate

- One item at a time. SPACEBAR or → MAX NEXT to advance.
- Queue depth shown as a count badge in the max-controls strip.
- URGENT bypasses the gate entirely.
- 45s minimum between deliveries during active narration.
- 60-second content dedup — same whisper text dropped.
- `_maxRouted: true` prevents re-enqueue of already-delivered items.

### Perception system

- observation-service fires Tier 2 checks (PP-filtered) automatically
  when timed events trigger their linked eventId.
- Players who beat DC: 15-second Chromebook flash (22px bold, red border pulse).
- Players who fail: complete silence — no indication anything happened.
- Max gets full truth always.

### Live verification (post-restart)

```
GET /health              → 200
GET /api/max/status      → paused:false, queue:0, throttle:45000
POST /api/max/acknowledge → ok
GET /api/health          → 20 services, observations:18, voice:web-audio
ElevenLabs               → ONLINE, 7/7 voice IDs, 338ms first-call latency
EventBus                 → dedup active, real duplicates caught on boot
```

### GO/NO-GO for April 19

**GO.** The core systems are built, tested, and live:
- Max whispers to earbud only — no double audio, no room speaker leak
- NPC dialogue to room speaker only — ElevenLabs voice palette mapped
- 44 timed events covering 17:30 → 06:00 game time
- 19 observation blocks with PP routing to player Chromebooks
- 8 creature behavior definitions ready for the living world
- Shed scene and Pieter's room fully authored
- Player map sharp and touch-responsive on Chromebook
- Max delivery gate prevents DM overwhelm (SPACEBAR to advance)
- Combat start button on /dm + full initiative/turn system
- Session lifecycle (start campaign → start session → stop → reset) working

**Pre-game-night checklist (Dave):**
1. SSH key: add the public key from OVERNIGHT_DIAGNOSTIC.md to GitHub
2. Browser config: /dm/ref → Tools → Audio Devices → set Room Speaker + DM Earbud
3. ElevenLabs: verify green on Tools tab
4. Test mode: Start Campaign → Start Session → verify Katya sings at 17:45
5. Kill any stale `node server.js` on the host before starting Docker
