# Dark Pilgrimage — Full Project Context

> Paste this into Claude web to give full context on the project. Last updated: April 6, 2026.

---

## What This Is

An AI-powered **Co-DM system** for a gothic horror D&D 5e campaign called "The Dark Pilgrimage," set in October 1274, Central Europe. The campaign follows a three-castle arc: **Orava → Houska → Cachtice**. This is a personal project built for Dave's home game — not a product. It runs on local hardware with smart home integration (Hubitat), Echo devices, Chromebooks as player displays, and a Dell touchscreen as the table display.

The vision: an interactive video game experience at the tabletop where AI acts as a full Co-DM — running all NPCs autonomously, whispering tactics and lore to the DM's earbud, tracking secrets and clues, driving timed world events, controlling smart home lights for atmosphere, and playing an AI-controlled party member (Spurt the Kobold).

**Deadline:** April 19, 2026. All 79 features are complete (phases A-Q). Currently in integration testing / dry run / playtest phase.

---

## Architecture

- **Stack:** Node.js monolith in Docker, plugin-based service architecture via event bus
- **Entry point:** `co-dm/server.js` → orchestrator loads 12 services
- **Codebase:** ~13,400 lines of JavaScript across 30 files
- **Dependencies:** express, ws, multer, uuid (minimal — no heavy frameworks)
- **Docker:** Node 22 base, host networking, volume-mounted HTML (live reload), service JS changes require rebuild
- **Persistence:** LevelDB via state-manager, JSON config files, session logs
- **SSL:** Self-signed certs for HTTPS (required for Chrome audio device enumeration)

### Core (4 modules)
| File | Purpose |
|------|---------|
| `core/orchestrator.js` | Service lifecycle — register, start, stop all services |
| `core/event-bus.js` | Pub/sub event system — all inter-service communication |
| `core/state-manager.js` | Central game state (players, NPCs, scenes, world) — LevelDB backed |
| `core/session-logger.js` | Persistent game event logging |

### Services (12 total)
| Service | Path | Purpose |
|---------|------|---------|
| Dashboard | `services/dashboard/` | DM web UI (port 3200) — map, panels, controls |
| Player Bridge | `services/player-bridge/` | Player web UI (port 3202) — character sheet, map, spells |
| Map | `services/map/` | VTT renderer, fog of war, walls, tokens, zones |
| Combat | `services/combat/` | Initiative tracker, combat AI, AOE visualization |
| Characters | `services/characters/` | Character management, DDB sync, equipment, spells |
| World Clock | `services/world/` | Real-time game clock, timed events, weather phases |
| AI Engine | `services/ai/` | Gemini 2.0 Flash integration — NPC dialogue, story tracking, atmosphere advice, Spurt agent |
| Atmosphere | `services/atmosphere/` | Hubitat smart home control — lights, effects |
| Audio | `services/audio/audio-service.js` | Audio routing, output device management |
| Voice | `services/audio/voice-service.js` | Alexa TTS, Echo directional horror narration |
| Sound | `services/audio/sound-service.js` | ElevenLabs SFX generation + caching |
| Campaign | `services/campaign/` | Recaps, downtime events, XP, timeline, lore |

### AI Subsystem (`services/ai/`)
| File | Purpose |
|------|---------|
| `ai-engine.js` | Main AI service — coordinates all AI features |
| `gemini-client.js` | Gemini 2.0 Flash API — generate(), chat(), generateJSON() |
| `context-builder.js` | Assembles game state + rolling 5min transcript buffer for prompts |
| `npc-handler.js` | NPC dialogue generation, approval queue, auto-approve by trust level |
| `npc-autonomy.js` | Autonomous NPC decisions — goals, movement, reactions |
| `atmosphere-advisor.js` | Mood detection, atmosphere profile suggestions |
| `story-tracker.js` | Story beat detection, DM nudges (nudge/reminder/warning) |
| `pacing-monitor.js` | Session pacing analysis |
| `spurt-agent.js` | AI-controlled party member (Spurt the Kobold) |
| `dm-advisor.js` | DM whisper suggestions |

### Key Directories
| Path | Contents |
|------|----------|
| `config/session-0.json` | Full Session 0 definition — scenes, NPCs, events, secrets, clues, story beats |
| `config/maps/*.json` | Map definitions with walls, doors, tokens, lighting, zones |
| `config/atmosphere-profiles/*.json` | 10 atmosphere profiles controlling lights, audio, effects |
| `config/characters/` | Saved character data (DDB import format) |
| `prompts/` | AI prompt templates (NPC dialogue, story tracking, atmosphere, Spurt, pacing, session summary) |
| `assets/maps/` | Map images (ChatGPT-generated battlemaps, 1536x1024) |
| `assets/tokens/` | Token art |
| `assets/sounds/` | 39 pre-generated ElevenLabs MP3 SFX |
| `sessions/` | Runtime session data, campaign data (timeline, lore, XP, recaps) |

---

## Infrastructure

| Component | Details |
|-----------|---------|
| Co-DM server | pve1 (Proxmox VM, i5-3470), IP: 192.168.0.198 |
| Smart home | Hubitat Elevation at 192.168.0.131 |
| RGB bulbs | Device IDs 912, 913 |
| Ambient bulbs | Device IDs 880, 881, 649, 582 |
| SFX output | Echo Gen 1 in living room via 3.5mm aux from PC |
| DM whispers | Bluetooth earbud paired to PC |
| Directional narration | Echo devices in kitchen, dining room, office via Alexa TTS |
| Player devices | Chromebooks running player-bridge UI |
| Table display | Dell touchscreen |
| systemd service | `co-dm` |

### Docker Setup
```yaml
# Key docker-compose.yml settings
init: true                          # Proper signal handling (prevents zombie processes)
stop_grace_period: 10s
network_mode: host                  # Ports 3200 (dashboard), 3202 (player bridge)
security_opt: apparmor:unconfined   # Prevents cgroup freeze on container stop
pid: host                           # Same reason
env_file: ./.env                    # HUBITAT_TOKEN, GEMINI_API_KEY
```

Volume mounts: sessions, config, dashboard public, player-bridge public, assets, SSL certs (all live-editable except service JS which requires rebuild).

---

## Session 0: "The Pallid Hart"

### Premise
A crossroads tavern in the Orava mountains during a blizzard, October 15, 1274. Each PC arrives alone on the mountain road, has a solo scare sequence, then enters the inn to find strangers huddled together. A vampire and a werewolf are both hiding among them. Both want the cellar. Things escalate toward midnight.

### NPCs
| NPC | True Identity | Role | Key Trait |
|-----|---------------|------|-----------|
| **Marta Kowalski** | Innkeeper (CR0) | Nervous innkeeper behind the bar | Terrified — her husband Piotr vanished into the cellar 3 weeks ago |
| **Vladislav Dragan** | Vampire (CR13) | Hooded stranger in the dark corner | Ancient, patient, cultured. Hasn't eaten/moved/spoken. Coffin is in the cellar |
| **Tomas Birkov** | Werewolf (CR3) | Trapper near the door | Cursed 3 months ago. Desperate to reach cellar before moonrise to chain himself |
| **Piotr Kowalski** | Vampire spawn (CR3) | Marta's husband, chained in cellar | Turned by Vladislav. The emotional core of the session |
| **Old Gregor** | Farmer | Grim fatalist by the hearth | Knows the old legends. Saw the pallid hart (white stag of death). Will be fed on by Vladislav |
| **Henryk** | Merchant | Nervous, self-interested | Noticed the stranger doesn't eat. Will pay anything for an escort at dawn |
| **Brother Aldric** | Pilgrim priest | Devout, frightened | Genuine faith — can sense evil. Has holy water. His prayers make Vladislav react |
| **Katya Voss** | Minstrel | Clever observer by the hearth | Noticed no reflection. Knows ballads about the Fraschts. Drops lore through songs and tales |

### Timed Event Timeline (Real-Time, 1:1 Scale)
| Game Time | Event |
|-----------|-------|
| 17:30 | Session starts. Tavern warm. Katya performing |
| 18:00 | Sunset complete → atmosphere shifts to tavern_tense |
| 19:00 | Vladislav begins watching specific players |
| 19:30 | Katya stops mid-song — she saw the missing reflection in brass plate |
| 19:45 | Moonrise — Tomas feels the pull, agitation increases |
| 20:00 | Tomas visibly sweating, hands shaking |
| 20:30 | Scratching sounds from cellar (repeats every 20 min) |
| 21:00 | Old Gregor collapses — Vladislav fed on him. Medicine DC12: two puncture wounds |
| 21:30 | Tomas makes desperate move toward cellar. Vladislav stiffens. Both converge |
| 22:00 | Fire dies completely (Vladislav drawing heat). Storm peaks. → dread_rising |
| 23:00 | Brother Aldric prays loudly. Holy symbol glows. Vladislav snarls — players see fangs |
| 23:30 | Midnight approaches. Both monsters must act within the hour |
| 00:00 | Tomas transforms if not in cellar. Two monsters in one inn |
| 04:00 | Storm fading. Eerie silence |
| 06:00 | Dawn. Vladislav must retreat or die. Storm over. → dawn |

### Secrets & Clues System
The session has a structured **secrets → clues → discovery chains** system:

**Secrets:**
- Vladislav is a vampire (discoverable via: cellar coffin, no reflection, avoids fire, caught feeding, holy symbol)
- Tomas is a werewolf (discoverable via: wound examination DC14, catching him trying to lock himself away, full moon trigger)
- Piotr is a vampire spawn in the cellar (discoverable via: entering cellar, Marta breaking down, Vladislav taunting her)
- Both Tomas and Vladislav want the cellar (discoverable via: watching their behavior)
- The cellar contains coffin, spawn, and drained bodies

**Barry Frascht Secret (CAMPAIGN-SPANNING):**
The Frascht family are legendary monster hunters — a Van Helsing bloodline known and feared across the supernatural world. Barry's parents were active hunters killed by Vladislav. Barry has no memory of this. His genie patron knows but is forbidden from telling him. Barry's "paranoid" gear (9 stakes, holy water, mirror, manacles) is instinct — hunter blood calling. Vladislav recognizes the name immediately. Session 0 plants tiny seeds only — never reveal the full truth yet.

**Story Branches:**
1. Players find cellar before Vladislav reveals → they have evidence and initiative
2. Vladislav strikes first → horror reveal, players blindsided
3. Tomas transforms publicly → chaos, two monsters in one inn

### Atmosphere Profiles
9 profiles that control Hubitat smart bulbs + player screen effects + audio:
`tavern_warm → tavern_tense → tavern_dark → investigation → dread_rising → terror_peak → combat → revelation → dawn`

### Future Hooks
- If Vladislav escapes → recurring antagonist across three-castle arc, flees toward Houska
- If players help Tomas → he knows mountain routes to Houska, possible guide
- Cellar contains letters referencing Houska Castle and "the gathering" → seeds for sessions 2-4
- Marta becomes ally or enemy depending on how players handle Piotr

---

## AI System Details

### Gemini 2.0 Flash Configuration
- Safety filters: OFF
- Max tokens: 500
- Temperature: 0.8
- Methods: `generate()`, `chat()`, `generateJSON()`

### Trust Levels
| Level | Behavior |
|-------|----------|
| Manual | All AI outputs queued for DM approval |
| Assisted | High-confidence outputs auto-approved |
| Autopilot | All outputs auto-approved |

### DM Whisper Priority Queue (via Bluetooth earbud)
1. Dread alerts
2. Roll prompts
3. Story nudges
4. Atmosphere suggestions
5. NPC dialogue
6. Auto-read text

### Spurt the Kobold (AI Party Member)
Wild Magic Sorcerer 3. AI-controlled. Personality scales with party Dread level:
- **0-40:** Eager, nervous, third-person speech, fascinated by traps
- **41-60:** Faster speech, paranoid, clings to party, involuntary Prestidigitation
- **61-80:** Erratic, mixes Common/Draconic, laughs at horror, suggests setting things on fire
- **81-100:** Full dissociation, talks to his magic, addresses monsters directly, frighteningly insightful

Combat AI: prefers ranged (Sorcerous Burst), uses Burning Hands on groups, creative item use, riskier at high Dread.

---

## Key Technical Lessons

- **Client→Server:** Use REST `fetch()`, not WebSocket send (unreliable from browser). WS fine for server→client push.
- **Touch devices:** HTML5 drag events don't fire. Must use touchstart/touchmove/touchend.
- **Wall collision:** Adjacent wall segments share endpoints. Line intersection test must include endpoints on wall parameter (u >= 0, u <= 1) or tokens slip through joints.
- **Vision during drag:** Anchor vision/fog to start position during drag, only update on drop. Separate visual position from logical position.
- **Door interaction:** Client-side wall check returns blocking wall info. If door, show modal prompt instead of blocking. Call `/api/map/walls/toggle-door` with playerId for lock picks.
- **Docker shutdown:** `init: true` + `stop_grace_period: 10s` + `security_opt: apparmor:unconfined` + `pid: host` prevents cgroup freeze.
- **Alexa soundbank:// URLs** don't work through behaviors/preview API. Echo can only do TTS narration.
- **ElevenLabs SFX:** `sound_generation` permission must be enabled on API key. Sounds cached as MP3 in assets/sounds/.
- **Audio routing:** Chrome `setSinkId()` routes different Audio elements to different output devices.

---

## Project Status (as of April 6, 2026)

### Complete (ALL 79 features, phases A-Q)
- **Pre-phases:** HP sync, VTT renderer, Fog of War, Scene Editor, SRD Compendium, DDB sync, Initiative/Combat Tracker, AOE visualization, polygon zones, dice rolls on all stats/saves/skills, NPC panel, player inventory+spells, character persistence
- **Phase A:** Session schema
- **Phase B:** Transcript/whisper input
- **Phase C:** DM earbud whispers
- **Phase D:** NPC autonomy (goals, movement, decisions)
- **Phase E:** Spurt AI party member
- **Phase F:** Info/pacing monitoring
- **Phase G:** Echo TTS / directional horror audio
- **Phase H:** Player screen effects (tint, flash, dread vision)
- **Phase I:** Atmosphere automation (Hubitat smart home)
- **Phase J:** Player experience polish
- **Phase K:** Combat AI assistance
- **Phase L:** Sound board + ElevenLabs SFX
- **Phase M:** Campaign continuity (recaps, lore, timeline)
- **Phase N:** Between-session features (downtime, XP)
- **Phase O:** DM tools
- **Phase P:** Player app polish
- **Phase Q:** Session 0 content (all NPCs, events, clues, maps)
- **Also done:** Session save/resume, panel pop-out windows, audio output routing, language gating, player arrival sequence, auto-perception zone checks, zone labels

### Removed (not building)
- ESP32 haptic feedback
- Foundry VTT integration
- Shroud product abstraction

### Remaining
- Integration testing and dry run
- Token art (cosmetic, optional)
- Assign remaining 4 player character sheets (pending DDB import)

---

## Git & Repo
- **Repo:** github.com/Damo2142/DarkPilgramage
- **Branches:** `master` (parent repo), `main` (co-dm submodule)
- **co-dm is a git submodule** inside the dark-pilgrimage parent repo

---

## Characters

### Player Characters
- **Spurt the Sorcerer** — Kobold Wild Magic Sorcerer 3, DDB ID 162472191 (AI-controlled party member)
- **Barry Goodfellow Frascht** — Human Warlock 1 (Genie patron, Pact of the Tome, Haunted One), played by "fraschty". Hidden Van Helsing bloodline secret.
- 4 additional PCs pending assignment

### Campaign Arc
Three-castle pilgrimage through Central Europe:
1. **Orava Castle** region (Session 0 at The Pallid Hart) — introduction, vampire + werewolf
2. **Houska Castle**, Bohemia — said to be built over a gateway to Hell, vampire network gathering
3. **Cachtice Castle**, western Hungary — noble family with dark secrets

### Factions
- **Mountain Villagers** — superstitious, fearful, need help
- **Church of Light** — clergy and inquisitors, anti-undead, Brother Aldric is representative
- **Vladislav's Brood** — growing vampire network spanning all three castles
