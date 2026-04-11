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

| Phase | Subject | Commit |
|---|---|---|
| 1 | OVERNIGHT_DIAGNOSTIC.md created, codebase inspected | 83e105b |
| 3C | Max content dedup 60s — drop identical whispers in window | a545b02 |
| 4B | Single WebSocket connection per page guard | f7edf3e |
| 5D | Explicit STT startup banner | b322d4f |
| 7D | Token speaking pulse on /table | a4259c4 |
| 7E | Token rotation context menu on /dm/map | 3657754 |
| 6  | START COMBAT button on /dm + /api/combat/start-scene endpoint | f4e4b8e |
| 5A/5C/5E | Dedicated CHAT tab on player Chromebook | 1d72c7b |
| 8B | Memory leak prevention — interval handles + per-player buffer cleanup | 7f59e17 |
| 6 follow-up | Combat status reads both shape variants | 2b0014b |

Already shipped before this overnight run (kept here so the file is the
single source of truth):

- **Phase 2A — Echo TTS removed entirely** — `28c6f10`
  voice-service rewritten 857 → 459 lines. ECHO_DEVICES, _alexaSpeak,
  ALEXA_COOKIE/CSRF, behaviors/preview API, all gone.
- **Phase 2B/2C — Audio routing separation** — `da24a04`, `28c6f10`
  Max → DM earbud only, NPC public → room speaker only, NPC private →
  player Chromebook only. No double audio path.
- **Phase 2D — NPC public audio through room speaker** — `28c6f10`
  `npc:audio` event with channel='room' is played by `RoomAudio.handleNpcAudio`
  on the configured room sink via `setSinkId`.
- **Phase 3A — Max throttling 45s active / 20s quiet** — `da24a04`
- **Phase 3B — MAX PAUSE button + countdown + volume slider** — `da24a04`
- **Phase 4A — Server-side EventBus UUID dedup with 5s TTL** — `5563bca`
- **Phase 4C — Input debounce 3s** — `5563bca`
- **Phase 5B — Player MAP tab full screen + tap-to-move** — `27013a8`
- **Phase 7A — /table fog black until token enters** — `7304da2`, `1b95e4d`
- **Phase 7B — Token names hidden by default** — `32c7bc4`
- **Phase 7C — All NPCs in /dm/map panel** — `d82b360`
- **Phase 8A — Watchdog + /health endpoint** — `bdd351c`, `c26620c` (parent)
- **Phase 9 — /dm/classic route + nav link** — `b699ddb`

---

## 3. DIAGNOSTIC RESULTS

Live verification after rebuild + restart at the end of the overnight run.

### Routes
| URL | Status | Notes |
|---|---|---|
| GET /health | 200 | bare-text watchdog endpoint |
| GET /dm | 200 | center display with new combat + max controls strip |
| GET /dm/map | 200 | with rotation context menu |
| GET /dm/ref | 200 | with audio devices section |
| GET /dm/classic | 200 | original full dashboard, unchanged |
| GET /table | 200 | with token speaking pulse renderer |
| GET /player/kim | 200 | with new CHAT tab |

### Backend services
```
GET /api/voice/health → elevenLabs: ONLINE, 7/7 voice IDs configured
GET /api/health
  voice mode: web-audio
  voice maxPaused: false
  audio backend: gemini
  STT ready: true
  eventBus events: 61, dedupDrops: 12 (real duplicates caught on boot)
  combat active: false
GET /api/max/status → paused:false, volume:0.7, throttleMs:45000, queueLength:0
GET /api/map/npc-defaults → 8 NPC defaults available, all unplaced
POST /api/languages/preview vladislav→kim elvish_americas
  → result: FULL, sharedLang: elvish_americas, fluency: fluent
```

### Combat lifecycle
```
Start state               → /api/combat → active:false, round:0
POST /api/map/npc/place-default {marta} → tokenId marta-mmmq6srj1
POST /api/combat/start-scene → ok:true, combatants:3, round:1
POST /api/combat/end → ok
```

### Voice / audio sanity
- voice-service start banner: `Web Audio mode (no Echo/Alexa). Max → DM
  earbud, NPC public → Room speaker, NPC private → player Chromebook.`
- ElevenLabs first-call success during boot ('Back online' phrase): 303ms
- No ALEXA_COOKIE / ALEXA_CSRF / alexa.amazon / _alexaSpeak / ECHO_DEVICES
  references anywhere in `services/`, `core/`, or `server.js`.

---

## 4. REMAINING ISSUES

| Issue | Severity | Status / Workaround |
|---|---|---|
| ElevenLabs key in `.env` was previously failing 401 | RESOLVED | Was a divergence between subscription endpoint and TTS endpoint. FIX-B4 switched the health check to the same TTS path Max uses; now reports ONLINE. |
| GitHub push blocked by HTTPS auth | RESOLVED-PENDING-DAVE | Switched both repos to SSH. Public key generated and printed in section 5 below. Dave must add it to GitHub once before any push will succeed. |
| sshd_config keepalive | PENDING-DAVE | Cannot sudo without prompt. Section 5 has the exact commands. |
| Stale `node server.js` host process holding port 3200 | RESOLVED | Killed before Phase 10 verification. Watchdog will catch reoccurrence. |
| Faster-whisper model files on disk | NOT TESTED | Gemini STT is the active backend; Whisper path is only the fallback. |

---

## 5. RECOMMENDED PRE-GAME ACTIONS

### A. Add this SSH public key to GitHub (one-time)

GitHub → Settings → SSH and GPG keys → New SSH key → name it `pve1-codm`,
paste this exact value:

```
ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAACAQDRDZ9OzDl5ctkqPrq/SgC5Kd6TX80Zp4FBixa8j6MY53mQWxSE6w3kHlh5lut7OFaMlDFJGYdygceyOU0x7b6RQTiO9yvqx7a473Zjp92/JSghtJ9Fe23eiw5luumQ2QwA7WQ4PCDZ69k2WN4ilwazGHtnJDODhWLjKqINQ6XorB2ZXsXtK8pjS9X+5BDXCSvsZFmjqxbuXAGRqR1tL5ZeUopbqLnf338xFnnLg3SreOKGQkXqCpq9IZM0b6Z6/6wzHK/bOtX7nw1DrMvkATHt+TlA+fpwMbCTxRBjek98IUCb5VIwTBhV1JyKX+R/c+BvZO99CkWKBWcLpKAAwWEwqETar/0Yu+UsBEqT0ZdkE8xAJxs1a4UamFctRQtokD7MGNexU9gVSZsfvMPRghc4C/y2v0JcTfEJYDIXr66mvjp7p0PvCI5feAaUgX0XfBH8dDlHMi6+6+lCNyjm7zW9Dcje++BaCh1JRS0mXl88g9PrB1c0qaSr7eeiUW3Kzr3fCbKpe0UoamRdC4E01CcwZWT8pXvEDLaQOPGysxrv57ZXmfgMN0nqsLET/+vZtJe2Wyf106ve8reJXDqgx9f+tIwxoZjrPG997clV0vIOYEk1EJL+hKC0ucMRRlyMtbkiMcITp9Nzfl4c98bRo1LogqAXpy3RjqwF5NljTaCxrw== dave@pve1-codm
```

After it's added, future pushes will work without any password prompt:
```
cd ~/dark-pilgrimage && git push origin feature/phase-r-complete
cd ~/dark-pilgrimage/co-dm && git push origin main
```

Both remotes have already been switched to `git@github.com:Damo2142/DarkPilgramage.git`
and `github.com` is in `~/.ssh/known_hosts`. The first push test confirmed
the SSH connection works — only the public key authorization is missing.

### B. SSH keepalive (one-time, requires sudo)

Run on pve1 as root:
```bash
echo "ClientAliveInterval 60" | sudo tee -a /etc/ssh/sshd_config
echo "ClientAliveCountMax 10" | sudo tee -a /etc/ssh/sshd_config
sudo systemctl restart sshd
```

On Dave's laptop, edit `~/.ssh/config` and add:
```
Host 192.168.0.198
  ServerAliveInterval 60
  ServerAliveCountMax 10
  TCPKeepAlive yes
```

This sends keepalives every 60s and tolerates up to 10 missed (~10 min idle).

### C. Browser device permission (one-time per browser)

Open `/dm/ref`, click the **Tools** tab, scroll to **Audio Devices**, click
**Grant Mic Permission**, then choose:
- **Room Speaker:** the Realtek output (PC built-in)
- **DM Earbud:** the TOZO-NC7 Bluetooth output

Click **Save Audio Config**. Selections persist in `localStorage`. Test
each via the **Test** buttons next to the dropdown.

### D. Verify ElevenLabs key still ONLINE before each session

`/dm/ref` Tools tab → System section → ElevenLabs pill should be green.
If it shows INVALID_KEY, rotate `ELEVENLABS_API_KEY` in `~/dark-pilgrimage/co-dm/.env`
and restart the container.

### E. Pin the watchdog at boot

The watchdog is launched by `start.sh`. To survive a host reboot, add to
crontab:
```
@reboot ~/dark-pilgrimage/start.sh
```
or wire start.sh into the existing systemd service `co-dm`.

