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

(Populated by CR-3.)

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

## Remaining Concerns

(Populated as audit progresses.)

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

(Populated at end of audit.)
