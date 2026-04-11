# OVERNIGHT DIAGNOSTIC — 2026-04-11 → 2026-04-12

Branch: `feature/phase-r-complete`
Game night: April 19, 2026 (5 days out)

This file is updated continuously throughout the autonomous run.

---

## 1. CODEBASE INSPECTION

### Architecture overview

Node.js monolith. 20 services registered into a single Orchestrator that
shares an EventBus, StateManager, and config loaded from `config/session-0.json`.
Entry point is `server.js` (75 lines). All services are plugin-shaped:
`init(orchestrator)`, `start()`, `stop()`, `getStatus()`.

```
server.js
└── Orchestrator
    ├── EventBus (core/event-bus.js — server-side dedup, FIX-C3)
    ├── StateManager (core/state-manager.js — patron-* merge, FIX-9)
    └── 20 services in this exact register order:
        characters · dashboard · player-bridge · map · combat ·
        world-clock · audio · voice · sound · ai-engine · atmosphere ·
        campaign · equipment · stamina · lighting · observation ·
        horror · social-combat · hazard · ambient-life
```

### Service map

| Service | LOC | Purpose |
|---|---|---|
| `dashboard` | 1067 | HTTPS server on 3200, serves /dm /dm/map /dm/ref /dm/classic /table /player /api/* + WS broadcast |
| `player-bridge` | 1266 | Per-player WS at `?player=<id>`, mic audio relay, chat dedup, npc:audio:player forwarding |
| `map` | 1870 | Map definitions, tokens, walls, fog zones, NPC defaults (FIX-B3), token movement, auto-reveal-on-entry |
| `combat` | 1684 | Initiative tracker, hit-location, shock saves, bleeding, conditions |
| `world` | 1846 | World clock + timed events + secrets + clues + NPC goals |
| `audio` | 484 | Mic chunk receiver → Gemini STT or faster-whisper. Sampled debug logs (FIX5). 3s transcription dedup (FIX-B6) |
| `voice` | 459 | **FIX-D rewrite** — ElevenLabs-only dispatcher. Channel-tagged events: `max:audio` / `npc:audio` / `npc:audio:player`. No Echo/Alexa |
| `sound` | 473 | ElevenLabs SFX generation, ambient loop, optional Pi speaker bridge |
| `ai-engine` | 1110 | Gemini 2.0 Flash chat + story tracker + NPC handler + atmosphere advisor + comm-router + max-director |
| `atmosphere` | 409 | Hubitat lights + atmosphere profiles |
| `characters` | 1177 | DDB sync + character file load + language overrides (FIX-3 fix) |
| `campaign` | 1426 | Sessions/campaign timeline + recaps + future hooks + test mode + start-campaign endpoint |
| `equipment` | 584 | Inventory equip/attune/AC, equipment degradation |
| `stamina` | 734 | Stamina ring tracking, short/long rest |
| `lighting` | 675 | Dynamic lighting sources, vision polygon helpers |
| `observation` | — | Auto-perception zone checks, monster tells |
| `horror` | 569 | Per-player horror score, condition triggers |
| `social-combat` | 584 | Conversation/social combat momentum |
| `hazard` | 574 | Active hazards + NPC standings |
| `ambient-life` | 593 | Env tick + NPC autonomous movement + dwell triggers + Katya performance |

### EventBus contract (FIX-C3)

`bus.dispatch(event, data)` assigns a `crypto.randomUUID()` to every envelope
and drops content-identical repeats within 5 seconds. The fingerprint is
`event|text|message|npcId|playerId|tokenId|targetId|channel|priority|category|profile|zoneId`.

Skip-list (never deduped — high-volume continuous streams):
`audio:chunk audio:dm_chunk audio:player_stream_start audio:player_stream_stop
transcript:silence player:camera_frame world:time_update state:change
map:token_moved token:move system:error *`.

### Audio routing model (FIX-D)

Echo/Alexa removed entirely. voice-service is a thin ElevenLabs dispatcher.
All output is via the dashboard browser using `HTMLAudioElement.setSinkId()`
on the configured PC sinks.

| Channel | Server event | Browser sink |
|---|---|---|
| **Max → DM earbud** | `max:audio` (URL of MP3) | `codm.audioDevices.v1.earbud` (TOZO-NC7) |
| **Max fallback (silent)** | `max:audio:speak` (text only) | Web Speech API on earbud sink |
| **NPC public → room speaker** | `npc:audio` (URL + npc + text) | `codm.audioDevices.v1.roomSpeaker` (Realtek) |
| **NPC private → player** | `npc:audio:player` → WS `npc:audio` | Player Chromebook default speaker |
| **Atmosphere ambient** | `sound:ambient` | room speaker sink |
| **SFX / directional** | `sound:play` | room speaker sink |

### Already shipped before this overnight run

| Round | Highlights | Reference commits |
|---|---|---|
| Language system (8 parts) | Master registry, NPC + player overrides, comm-router resolveLanguage, scripted Slovak scene at 19:00, /dm/ref Tools tab Languages section | f35c7e4..d788d04, 336b045 |
| Outstanding round (9 fixes) | Start Campaign / Start Session buttons, Max query debounce, player MAP fullscreen + tap-to-move, persistent chat bar, mic debug logging, ElevenLabs voice IDs from .env, /table fog black until token enters, anonymous tokens by default, all 9 NPCs in panel | b299472..bbccd69 |
| Critical issues (9 fixes) | /dm/classic route + nav, kitchen leak per-rect drawImage, NPC tokens not auto-placed (Place button spawns at default), ElevenLabs health uses real TTS endpoint, Audio Devices section in Tools tab, duplicate response debounce (chat/STT/WS), watchdog + /health endpoint | b699ddb..7d8c211 |
| Critical audio + throttle + dedup | Audio routing earbud vs speaker, Max throttling 45s active / 20s quiet + PAUSE button + volume slider, server-side EventBus UUID dedup with 5s TTL | 5563bca, da24a04, 343eb8f |
| Echo removal (FIX-D) | voice-service rewritten 857→459 lines. ECHO_DEVICES, _alexaSpeak, ALEXA_COOKIE, ALEXA_CSRF, behaviors/preview API all gone. Pure Web Audio routing | 28c6f10 |

### Known issues from inspection (before this overnight run)

1. **Chat is on every tab via persistent floating bar** — needs to become a
   dedicated CHAT tab per Phase 5A/5C. Floating bar removed from non-chat tabs.
2. **No CHAT tab** — currently 6 tabs without CHAT. Add as 2nd tab.
3. **Mic pipeline** — debug logs added in FIX5 but no startup verification of
   STT readiness. Need to confirm faster-whisper or Gemini STT initializes.
4. **Token pulse on speak** — not yet implemented. Per Phase 7D.
5. **Token rotation context menu on /dm/map** — doesn't exist yet. Per Phase 7E.
6. **Combat START button on /dm** — combat must be started from /dm/ref Combat
   tab today. /dm needs a one-click start.
7. **Single WS per page** — some pages may be reconnecting. Add `_wsInitialized`
   guard.
8. **Max content dedup** — bus dedup is 5s. Spec asks for 60s on Max content.
9. **.env may have leaked Amazon session tokens** — needs scrubbing per Phase 8C.
10. **Memory leak audit** — recentEvents map sweep was added in FIX-C3, but other
    setInterval sites haven't been audited.

---

## 2. FIXES APPLIED (this overnight run)

(Updated as commits are made.)

---

## 3. DIAGNOSTIC RESULTS

(Populated by Phase 10.)

---

## 4. REMAINING ISSUES

(Anything that couldn't be fixed.)

---

## 5. RECOMMENDED PRE-GAME ACTIONS

(Manual steps Dave needs to do before April 19.)
