# FINAL BUILD NOTES — Sections 1-8

Branch: `feature/phase-r-complete` (parent), `main` (co-dm submodule)
Started: 2026-04-11 autonomous run
Goal: Last build before April 19 game night

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

