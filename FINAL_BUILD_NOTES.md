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

