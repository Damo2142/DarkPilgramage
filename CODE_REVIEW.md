# Dark Pilgrimage — Code Review
Date: 2026-04-12 (overnight, post-diagnostic pass)
Branch: `feature/phase-r-complete`
Codebase: 22 539 LOC across 24 service files + core/

This file is updated continuously as the audit + fixes progress.

---

## Files Reviewed

| File | LOC | Status | Notes |
|---|---|---|---|
| `server.js` | 75 | REFACTORED (CR-2) | Global uncaught/unhandledRejection handlers now log and continue instead of crashing. |
| `core/event-bus.js` | 167 | CLEAN | FIX-C3 dedup with self-trim. crypto.randomUUID per envelope. Skip-list for streaming events. |
| `core/orchestrator.js` | — | CLEAN | Service register + start/stop loop, error-tolerant. |
| `core/state-manager.js` | — | CLEAN | FIX-9 patron-* merge. Snapshot timer is paired with stop(). |
| `services/audio/voice-service.js` | 459 | CLEAN (FIX-D rewrite) | Pure ElevenLabs dispatcher. No Echo. Pause/resume guards Max audio. Health check uses real TTS endpoint. |
| `services/audio/audio-service.js` | 484 | REFACTORED | STT startup banner (CR-2). Per-player buffer cleanup on disconnect. Sampled debug logs. |
| `services/audio/sound-service.js` | 473 | TODO | Pi speaker integration; SFX generation; ambient loop. |
| `services/ai/ai-engine.js` | 1110 | TODO | hostsMaxDirector + commRouter + npcHandler. Largest single point of audio failure. |
| `services/ai/max-director.js` | 322 | REFACTORED | 3-layer dedup: 60s content + 5s bus + 3s WS. 45s active / 20s quiet throttle. URGENT bypass. Pause API. |
| `services/ai/comm-router.js` | 941 | CLEAN | 6-channel routing, language barrier resolver, scripted speech parser. Heavy file but well-structured. |
| `services/ai/npc-handler.js` | — | TODO | Generates NPC dialogue; needs anachronism filter (CR-4). |
| `services/ai/spurt-agent.js` | 624 | TODO | Spurt frequency reduction (CR-4). |
| `services/ai/pacing-monitor.js` | 463 | TODO | [TENSION] / [REVELATION] events should be log-only, never spoken (CR-4). |
| `services/ai/npc-autonomy.js` | 452 | TODO | Per-NPC tick. Confirm clear cleanup. |
| `services/ai/context-builder.js` | 413 | TODO | Prompt assembly for Gemini. Caching candidate (CR-3). |
| `services/dashboard/dashboard-service.js` | 1067 | CLEAN | Routes /dm /dm/map /dm/ref /dm/classic /table /player + many /api/* |
| `services/player-bridge/player-bridge-service.js` | 1266 | REFACTORED | FIX-B6 dedup + npc:audio:player forwarding + chat:message dispatch. |
| `services/map/map-service.js` | 1870 | REFACTORED | NPC default registry, place-default, anonymize-all, facing endpoint, auto-reveal-on-entry. |
| `services/combat/combat-service.js` | 1684 | REFACTORED | start-scene endpoint added. Initiative + hit-location + shock + bleeding + conditions. |
| `services/world/world-clock-service.js` | 1846 | TODO | Timed events fire correctly per logs. Largest file — needs scan. |
| `services/characters/character-service.js` | 1177 | REFACTORED | DDB sync + language overrides + persistent intervals now have stop() handles. |
| `services/campaign/campaign-service.js` | 1426 | TODO | Sessions, recaps, future hooks, test mode. |
| `services/equipment/equipment-service.js` | 584 | TODO | Inventory degradation, equip/attune. |
| `services/stamina/stamina-service.js` | 734 | TODO | Stamina ring, rest. |
| `services/lighting/lighting-service.js` | 675 | TODO | Light source vision polygons. |
| `services/horror/horror-service.js` | 569 | TODO | Per-player horror score. |
| `services/social-combat/social-combat-service.js` | 584 | TODO | Conversation momentum. |
| `services/hazard/hazard-service.js` | 574 | TODO | Hazard tracking. |
| `services/ambient-life/ambient-life-service.js` | 593 | TODO | Env tick + NPC autonomous moves. |
| `services/atmosphere/atmosphere-engine.js` | 409 | TODO | Hubitat lighting. |
| `services/observation/observation-service.js` | — | TODO | Auto-perception checks. |

---

## Critical Issues Found and Fixed

### CR-2 — Global crash prevention (server.js)
**Found:** server.js had `process.on('uncaughtException', ...)` and
`process.on('unhandledRejection', ...)` but each handler took only the
error argument and logged a single line. Node 15+ DEFAULT behavior on
`unhandledRejection` is to terminate the process — the previous handler
prevented the crash but lost the stack trace, the origin, and any
context.

**Fix:** explicit handlers log full stack + origin and continue. Tagged
`[CRASH-PREVENTION]` in logs so the watchdog log can be grepped for
recovered crashes.

```js
process.on('uncaughtException', (err, origin) => {
  console.error('[CRASH-PREVENTION] Uncaught exception (' + origin + '):', err && err.stack || err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('[CRASH-PREVENTION] Unhandled rejection:', reason && reason.stack || reason);
});
```

---

## Performance Improvements Made

### CR-3 — Audio pipeline latency telemetry
- New `GET /api/latency/max` endpoint returns samples / avgMs / medianMs /
  p95Ms / 5 most recent samples. Populated by `voice-service` via the
  existing `max:latency` event. Use it to verify the 3-second budget.
- ElevenLabs connection pre-warmed at startup via `checkElevenLabsHealth(true)`
  which makes a single-character TTS call. Resolves DNS, opens TLS,
  pre-authenticates the API key.
- All system prompts loaded once into `this._systemPrompt` during init().
  Verified across `ai-engine`, `npc-handler`, `pacing-monitor`, `story-tracker`.
- Sync file IO restricted to init/load paths. Audited 68 `readFileSync` /
  `writeFileSync` calls across services — none in hot paths. The DDB sync
  uses `writeFileSync` which is acceptable because it's behind an explicit
  REST endpoint, not a frequent event handler.

### CR-2 — halQuery double-audio bugfix
The DM-typed Max query was dispatching `dm:whisper` (which max-director
enqueued and re-fired `voice:speak`) AND `voice:speak` directly — playing
Max audio twice. Fix: tag the whisper `_maxRouted: true` so max-director
skips it; the single `voice:speak` is now the only audio source. This
also resolves the "Max stutter" symptom Dave observed.

### CR-4 — Pacing-monitor whispers no longer reach earbud
`_dispatchAlert`, `_onSecretRevealed`, `_onClueFound` previously fired
`dm:whisper` without `_maxRouted`, so `[TENSION]` / `[REVELATION]` /
`[PACING]` alerts were spoken aloud. All three now tag `_maxRouted: true`,
`category: 'pacing-log'`, `logOnly: true`. They appear in the DM whisper
log on `/dm` but never reach the earbud.

---

## Memory Leaks Fixed

### Phase 8B (overnight diagnostic)
- character-service: bare setInterval for DDB cookie health check now
  stored in this._cookieHealthInterval and cleared in stop().
- audio-service: per-player audio buffer + lastTranscripts +
  whisperDebugCounters now dropped on `player:disconnected`.
- All other long-lived setInterval calls already had paired
  clearInterval in service stop() methods.

---

## CR-6 Combat System Review

The combat chain is implemented end-to-end. Verified paths:

```
DM clicks ⚔ START COMBAT on /dm (or POST /api/combat/start-scene)
  → combat-service.startCombat(combatantIds)
  → bus.dispatch('combat:started')
  → state.combat.active = true
  → spurt-agent reacts (reduced frequency CR-4)

NPC turn:
  → ai-engine npc-autonomy picks action
  → bus.dispatch('combat:hit_location') with location + damage
  → combat-service rolls d20 hit_location, applies damage
  → bus.dispatch('wounds:updated', { playerId, wounds, location })
  → character-service _computeWounds updates limb tier
  → bus.dispatch('combat:shock_failed') if applicable
  → horror-service applies shock damage
  → max-director enqueues whisper (45s throttle, URGENT bypass for shock)
  → voice-service plays Max audio on DM earbud sink

Player turn:
  → DM types or speaks 'Max, [character] rolled X to hit'
  → comm-router routes as max-action
  → ai-engine halQuery applies modifiers (CR-2 single audio source)
  → Max whisper with attack outcome
  → DM narrates result
```

**Confirmed working integrations:**
- combat:hit_location → wounds:updated → character wound tier update
- combat:shock_failed → horror-service shock processing
- combat:bleeding_tick → periodic damage during turn
- combat:morale_break → NPC flee

**Remaining gaps for CR-6:**
1. **NPC autonomous turn AI** is implemented but the per-NPC tactical
   decision loop in `npc-autonomy.js` was not exercised during this
   audit. Recommend a manual combat playthrough on a sandbox map.
2. **Combat end conditions** — manual `END COMBAT` works. Automatic
   end on "all enemies defeated" or "morale break" is dispatched as
   events but the auto-end is not enabled. This is a deliberate choice
   from earlier rounds: the DM owns the end state.
3. **Initiative entry** — players currently roll physical d20 and
   declare to Max. The Max parser in comm-router `_routeMaxDice`
   already handles "Max, [name] rolled X for initiative". Verified.

## Remaining Concerns

| Concern | Severity | Plan |
|---|---|---|
| Combat playthrough not exercised end-to-end | MEDIUM | Manual test session before April 19 |
| Whisper-based STT (faster-whisper fallback) not tested | LOW | Gemini STT is the active backend |
| Service restart for ai-engine is risky (re-init Gemini client) | LOW | Restart endpoint exists; expect ~2s reconnection |
| Map editor save state not auto-snapshotted | LOW | DM uses Save State button on /dm/map |

---

## Architecture Notes

### Service dependency graph (high-level)

```
                  ┌─────────────┐
                  │ Orchestrator│
                  └──────┬──────┘
                         │
        ┌────────────────┼────────────────┐
        │                │                │
   ┌────▼─────┐    ┌────▼─────┐    ┌────▼──────┐
   │ EventBus │    │  State   │    │   Config  │
   │ (dedup)  │    │ Manager  │    │  Loader   │
   └────┬─────┘    └────┬─────┘    └───────────┘
        │               │
        │     all 20 services subscribe + dispatch
        │               │
   ┌────▼───────────────▼────────────────────────┐
   │  characters → dashboard → player-bridge     │
   │  → map → combat → world-clock → audio       │
   │  → voice → sound → ai-engine → atmosphere   │
   │  → campaign → equipment → stamina           │
   │  → lighting → observation → horror          │
   │  → social-combat → hazard → ambient-life    │
   └─────────────────────────────────────────────┘
```

The Orchestrator owns the EventBus, StateManager, and config. Every
service is self-contained with `init/start/stop` and communicates only
through events. There are NO direct service-to-service method calls
except `orchestrator.getService('name')` lookups in dashboard endpoints
(documented in voice/max controls path).

### Single points of failure

- **Gemini API** (used by ai-engine + audio STT): if down, NPC dialogue
  generation stops + transcription stops. World still ticks, voice
  service still plays cached audio, dashboard still works.
- **ElevenLabs API**: if down, Max audio falls back to Web Speech API
  on the earbud sink (FIX-C1). NPC public dialogue falls back to text-only
  (`npc:audio:speak` event with no URL).
- **Hubitat API**: if down, lighting automation stops. Atmosphere profile
  changes still log; no other service depends on lighting.
- **WebSocket**: if a client disconnects, the server keeps running. Each
  client page reconnects with a 3-second backoff.

The server has no hard dependency on any external service for boot.

---

## Recommendations for Post-April-19

These are quality and architecture improvements to consider after game
night, when there's no time pressure.

1. **Split the largest service files.** `world-clock-service.js` (1846),
   `combat-service.js` (1684), `map-service.js` (1870), `campaign-service.js`
   (1426), `player-bridge-service.js` (1266), `characters-service.js` (1177)
   are all over 1000 lines. Each could be split into a controller + a
   model/state module. This would also make them easier to unit test.

2. **Convert sync init IO to async.** 68 `readFileSync` calls at startup
   contribute to slow boot. Promisify them and run in parallel for ~30%
   faster startup.

3. **Replace inline `<script>` blocks in HTML with bundled JS files.**
   `services/dashboard/public/index.html` is 8000+ lines. The dashboard JS
   should live in `services/dashboard/public/js/*.js` files imported via
   `<script type="module" src="..."></script>` so it can be tested,
   linted, and hot-reloaded independently.

4. **Add unit tests.** Zero tests today. Start with the most critical
   pure functions: `comm-router._sanitizePlayerInput`, `comm-router.resolveLanguage`,
   `comm-router._detectLanguageHint`, `event-bus._fingerprint`,
   `event-bus._isDuplicate`, `max-director.enqueue`,
   `voice-service._npcVoiceId`. These are pure and easy to test.

5. **Add a TypeScript build pass.** Don't rewrite — just generate `.d.ts`
   declarations from JSDoc to catch shape mismatches at build time. The
   FIX-D event channels (`max:audio`, `npc:audio`, `npc:audio:player`)
   would be a good first set of typed contracts.

6. **Telemetry dashboard.** `/api/latency/max` is a starting point.
   Aggregate per-service metrics: events per minute, dedup drops, error
   counts. Render on `/dm/ref` Tools tab or a dedicated `/dm/metrics`.

7. **Per-service config files.** Today every service reads `process.env`
   directly or pulls from `config/session-0.json`. Move per-service
   config into `config/services/<name>.json` so the session config is
   purely game state, not infrastructure.

8. **Automated combat regression test.** Build a sandbox map with two
   NPCs and run an automated initiative → attack → wound → death loop
   on every commit. Catches the "Max stutter" or "double audio" classes
   of bug before they reach the table.
