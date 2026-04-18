# Dark Pilgrimage Co-DM — Complete System Handoff

**Last updated:** 2026-04-17, night before Session 0 (April 19, 2026)
**For:** A new DM or developer taking over this project.

This document is the single source of truth for what exists, why, and how to
operate it. Read it in full before making changes.

---

## 1 · What this is

An AI-powered Co-Dungeon-Master system running in Dave's home for a single
D&D 5e campaign: **Dark Pilgrimage** — gothic horror, 1274 Central Europe,
three-castle arc Orava → Houska → Cachtice. It is **not a product.** It is a
hand-built tool for one table, one setting, one DM. There is no Shroud
abstraction, no customer layer, no multi-tenant anything.

The DM (Dave) narrates and voices. The Co-DM runs the rest:
- Every NPC and monster (dialogue, movement, tactical decisions)
- Tracks every secret, clue, story beat — controls information flow
- Whispers to the DM via earbud: NPC intentions, rules, nudges, translations
- Drives Hubitat smart bulbs for atmosphere
- Pushes screen effects to player Chromebooks (tint, flash, dread vision)
- Plays ElevenLabs SFX + directional horror audio through a mesh of Echo devices
- Parses player speech (Gemini STT) into game actions
- Maintains a world clock that fires events whether players act or not

Vision in one sentence: **interactive-video-game-experience at the tabletop.**

## 2 · Deadline and current state (as of 2026-04-17 22:40)

- **Session 0 is April 19, 2026** — two days out.
- All 79 originally-planned features across phases A–Q are built.
- Pre-session audit surfaced and fixed: movement bugs, language-translation
  gating, Chromebook playback, character-sheet save-proficiency calc bug,
  Chazz button bug, Ed character swap reconciliation.
- Smoke test: 48/48. Slovak routing unit test: 9/9. AI ONLINE. DDB ONLINE.
- **Status: green for Sunday.**

## 3 · Hardware & deployment

| Component | Host | Role |
|---|---|---|
| Co-DM server | `pve1` (i5-3470) bare-metal, via `~/dark-pilgrimage/start.sh` | Node.js monolith on port 3200 |
| Hubitat hub | 192.168.0.131 | Smart-bulb automation via Maker API |
| RGB bulbs | `912`, `913` | Story-beat reactive color |
| Ambient bulbs | `880`, `881`, `649`, `582` | Room lighting |
| Echo Dot Max | Game room | Primary audio output (SFX via 3.5mm AUX to PC) |
| Echo devices | Kitchen, dining, office | Directional horror narration via Alexa TTS |
| Chromebooks | Per-player | Player UI, sees their own sheet + handouts + screen FX |
| Dell touchscreen | Table | Shared battlemap display |
| DM earbud | Bluetooth to PC | Whispers (ElevenLabs TTS or browser TTS fallback) |
| pve5 (Xeon 5160, no AVX) | — | Previously ran Foundry; **Foundry integration is REMOVED** |

**Important:** The system is **bare-metal only** on `pve1`. Docker was tried
and rejected — it broke audio device routing. See memory
`feedback_deployment.md`. Do not revert to Docker.

**ESP32 / haptic** and **Foundry** integrations were explicitly removed.
Don't rebuild them.

## 4 · Repository structure

```
~/dark-pilgrimage/               parent repo (branch: feature/phase-r-complete)
├── start.sh                     watchdog launcher; sources co-dm/.env into env
├── watchdog.sh                  auto-restart if node dies
├── co-dm/                       git submodule (branch: feature/session0-polish)
│   ├── server.js                entry; loads orchestrator
│   ├── .env                     GEMINI_API_KEY, COBALT_COOKIE, HUBITAT_TOKEN, ELEVENLABS_API_KEY (gitignored)
│   ├── core/
│   │   ├── orchestrator.js      service registry + boot order
│   │   ├── event-bus.js         pub/sub with dedup skip list for specific event types
│   │   ├── state-manager.js     central game state, supports dot-path get/set
│   │   └── session-logger.js    transcript + event JSONL log per session
│   ├── services/                22 service directories (see §5)
│   ├── prompts/
│   │   ├── hal-codm.md          HAL/Max system prompt (Co-DM director role)
│   │   ├── npc-base.md          baseline NPC dialogue prompt
│   │   ├── atmosphere-advisor.md
│   │   ├── story-tracker.md
│   │   └── session-summary.md
│   ├── config/
│   │   ├── session-0.json                    primary session config (NPCs, scenes, backstories)
│   │   ├── session-0-fragments/*.json        auto-merged into session-0 at boot
│   │   ├── character-assignments.json        player-slug → DDB-id
│   │   ├── ddb-config.json                   DDB IDs to auto-sync at boot
│   │   ├── character-language-overrides.json per-player language override (structured)
│   │   ├── character-origins.json            Americas-origin overlay (Spurt, Kim)
│   │   ├── race-reactions.json               per-NPC reactions to each PC's race
│   │   ├── characters/<ddbId>.json           cached DDB character pulls (gitignored)
│   │   ├── maps/<mapId>.json                 map definitions (tokens, walls, zones)
│   │   ├── scenes/<sceneId>.json             scene setup (onEnter, encounters)
│   │   ├── atmosphere-profiles/*.json        14 profiles: tavern_warm → terror_peak
│   │   ├── npcs/*.json, actors/*.json, creatures/*.json
│   │   ├── srd-*.json                        5e SRD reference data
│   │   ├── future-hooks.json                 latent campaign hooks
│   │   ├── languages.json                    language registry (id, intelligibility)
│   │   └── world/encounter-tables.json
│   ├── assets/
│   │   ├── maps/*.png                        battlemap images (ChatGPT-generated)
│   │   ├── tokens/*.webp                     token art
│   │   └── sounds/*.mp3                      ElevenLabs-cached SFX (39 pre-generated)
│   ├── sessions/<date>/                      transcript logs, state snapshots, campaign persistence
│   ├── scripts/                              standalone test scripts (see §12)
│   ├── docs/session0-polish/                 phase reports, test reports
│   └── test-smoke.js                         48-check end-to-end regression canary
└── drops/                                    supporting artifacts, ChatGPT prompts, daily reports
```

Config merge behaviour: `session-0-fragments/*.json` are merged into
`session-0.json` at boot. You edit fragments, not the main file, for most
session content.

## 5 · Services inventory (all 22)

Boot order matters — services register in `orchestrator.js` then `startAll()`
iterates in registration order.

| # | Service | Responsibilities | Key events |
|---|---|---|---|
| 1 | `characters` | DDB sync, ability-score/save/skill recompute, language overrides, HP/stamina heal endpoints | `characters:loaded`, `characters:ddb_synced` |
| 2 | `dashboard` | DM-facing UI on port 3200 + WS upgrade router (delegates `?player=` to player-bridge) | `dashboard:client_connected` |
| 3 | `player-bridge` | Player Chromebook UI served on same 3200, WS with per-player `_sendToPlayer()` | `player:*` |
| 4 | `map` | Tokens, walls, doors, zones; `/api/map/token/move` enforces wall + speed | `map:token_moved`, `map:zone_enter`, `map:zone_revealed` |
| 5 | `combat` | Initiative, attack resolution, OoA (bidirectional), 5e shooting-into-melee | `combat:started`, `combat:attack_result`, `combat:opportunity_attack` |
| 6 | `world-clock` | Game-time ticks, timed events | `world:tick`, `world:hour_changed` |
| 7 | `audio` | STT (Gemini), mic capture from browser, player audio streaming | `audio:chunk`, `transcript:player`, `transcript:segment` |
| 8 | `voice` | ElevenLabs TTS for NPCs + earbud whispers + Alexa TTS to Echos | `voice:tts_ready`, `dm:whisper` |
| 9 | `sound` | SFX generation (ElevenLabs) + cache + playback routing | `audio:play_sound`, `audio:ambience_change` |
| 10 | `ai-engine` | Gemini client, NPC handler, atmosphere advisor, story tracker, HAL director, `commRouter` | `npc:approved`, `npc:scripted_speech`, `ai:*`, `hal:*` |
| 11 | `atmosphere` | Profile switching, Hubitat Maker API calls, lighting cues | `atmosphere:profile_change` |
| 12 | `campaign` | Recaps, XP, timeline, lore DB, persistent backstory hooks, snapshots | `campaign:*` |
| 13 | `equipment` | Equip/unequip/attune, AC recompute via equipped armor | `equipment:updated` |
| 14 | `stamina` | Separate-from-HP exhaustion pool, CON-based max, short/long rest | `stamina:updated` |
| 15 | `lighting` | Token-carried light sources, vision math, combat darkness penalties | `lighting:update` |
| 16 | `observation` | Perception checks, environmental observation triggers, active investigation detection | `observation:trigger`, `player:perception_flash` |
| 17 | `horror` | Dread score, horror arcs per PC, screen FX dispatch | `horror:effect`, `horror:clear`, `dread:update` |
| 18 | `social-combat` | Social combat mechanic for NPC interactions | `social:*` |
| 19 | `hazard` | Environmental hazards | `hazard:*` |
| 20 | `ambient-life` | Env ticks, NPC autonomous movement, proximity dwell, Katya auto-performances | `ambient:observation`, `ambient:environment`, `ambient:performance`, `ambient:dwell_reaction` |
| 21 | `scene-population` | Populates scene tokens from config on scene activation | `scene:activated` |
| 22 | `bagman` | The Bagman entity — cross-session antagonist flavour | `bagman:*` |

Two additional registered in code: `items` (SRD equipment lookup) and `world`
(world state / journey tracking) — both are effectively passive DB layers.

Event bus has a **DEDUP_SKIP_EVENTS** list (in `core/event-bus.js`) for events
that must NOT be deduplicated (e.g. `combat:prev_turn`).

## 6 · Character system (complete walkthrough)

### 6a · Ingest flow

1. `start.sh` → `node server.js config/session-0.json`
2. `characters` service starts:
   - Reads every `config/characters/*.json` (gitignored — each file is a cached DDB pull)
   - Applies `character-language-overrides.json` → `character.languageStructured`
   - Applies `character-origins.json` → `character.americasOrigin`
   - Runs `recomputeDerivedStats()` — adds class save proficiencies + recomputes skill/save modifiers from canonical ability scores (fix 2026-04-17)
   - Loads `character-assignments.json` → maps player-slug (`ed`, `kim`, `jen`, `nick`, `jerome`, `spurt-ai-pc`) to ddbId
   - For each assigned player, injects character into `state.players.<slug>.character`
3. If `ddb-config.json` has IDs AND `COBALT_COOKIE` is set, kicks off auto-sync:
   - For each ID, GET `https://character-service.dndbeyond.com/character/v5/character/<id>`
   - Parses via `_mapDdbCharacter()` → runs `recomputeDerivedStats()` → saves to disk
   - Reloads state with fresh data
4. Players and the dashboard receive `characters:loaded` event and WS `init` payload.

### 6b · Player assignments

| Slug | DDB ID | Character | Class/Level | Race |
|---|---|---|---|---|
| `ed` | 164451753 | Vaelthion Shadeknife | Rogue 3 | Human |
| `kim` | 164126673 | Zarina Firethorn | Fighter 3 | Mark of Detection Half-Elf |
| `jen` | 164256658 | Marfire 2.0 | Barbarian 3 | Firbolg |
| `nick` | 164256380 | Chazz "Merry Tunes" Mortimer | Bard 3 | Tiefling |
| `jerome` | 162702065 | Barry Goodfellow Frascht | Warlock 3 | Human |
| `spurt-ai-pc` | 162472191 | Spurt the Sorcerer | Sorcerer 3 | Kobold |

**Vaelthion (164451753) is excluded from auto-sync** — see `ddb-config.json`
`_note` field. Dave manually edited AC and languages; DDB sync would clobber.
The file on disk is canonical for Vaelthion; all others pull fresh from DDB.

### 6c · Language system (two-layer)

- **Raw `languages` array** on character JSON: string list from DDB.
- **Structured `languageStructured`** from `character-language-overrides.json`:
  `[{ id, displayName, fluency, note }]` where fluency ∈
  `fluent | fluent — native | conversational | partial | basic`.

All language-gating in the AI (comm-router) uses the structured list. The raw
array is display-only. If a character's DDB sheet doesn't list a needed
language (e.g. Slovak for Ed), the override file is the fix — it survives DDB
re-sync because it's a separate file.

### 6d · Calculation guarantees

`recomputeDerivedStats(char)` runs at every load + every DDB sync. It:

1. Treats `abilities[*].score` as ground truth; recomputes modifier + modifierStr.
2. Applies **class saving-throw proficiencies** from 5e rules (PHB per-class) via
   `CLASS_SAVE_PROFS` lookup. Preserves existing `proficient: true` flags
   (feats, racial features). Recomputes every save modifier.
3. Preserves skill `proficiency` tier (`none | proficiency | expertise | half-proficiency`).
   Recomputes every skill modifier from ability × tier × proficiency bonus.
4. Defaults initiative to DEX mod if not already set.

This means the character sheet on the dashboard, player UI, and AI prompts
always reflects the PC's correct save/skill math regardless of what DDB
returned or what anyone hand-edited. Any ability-score change auto-cascades.

### 6e · Gotchas

- **DDB auto-sync clobbers manual character JSON edits** on every boot. To
  preserve hand-edited fields (custom AC, inventory, features), remove the ID
  from `ddb-config.json` `characterIds`. See Vaelthion as example.
- **Character files are gitignored.** They carry player DDB data. Don't
  commit them. The recompute logic fixes them on load.
- **Map token JSON has its own `name` and `ac`** independent of character
  state. When a character is renamed, update `config/maps/<map>.json` tokens
  too (see `pallidhearfloor1.json` for the Ed token entry).

## 7 · AI stack

### 7a · Gemini

- Client: `services/ai/gemini-client.js` — `generate()`, `chat()`, `generateJSON()`
- Model: **`gemini-2.5-flash`** (2.0 is deprecated for new users → 404)
- Settings: safety OFF, 500 tokens, temp 0.8
- Key: `GEMINI_API_KEY` env var (loaded from `co-dm/.env` via `start.sh`)
- Health: `/api/ai/health` → `{status, geminiAvailable, consecutiveFailures}`

### 7b · HAL / Max director

- System prompt: `prompts/hal-codm.md` — defines HAL as "director in the chair,
  never on stage." 60-word max responses to DM earbud.
- Query endpoint: `POST /api/hal/query`
- History: `GET /api/hal/history`
- Triggers: voice wake-word ("max" / "hal") via audio-service STT; also
  proactive whispers from story-tracker / horror / combat.

### 7c · NPC dialogue

- Handler: `services/ai/npc-handler.js` — generates NPC lines, enqueues for
  DM approval.
- Trust levels: `manual` (DM approves all), `assisted` (auto-approve
  high-confidence), `autopilot` (all auto). Default = autopilot.
- Approval event: `npc:approved` — carries `{text, npc, npcId, voiceCode,
  languageId?, _private?, _sourcePlayerId?}`.
- Voice-service subscribes to `npc:approved` → ElevenLabs → room speaker
  (unless `_private`).
- Comm-router subscribes to `npc:approved` → per-player language + proximity
  gating.

### 7d · Comm-router (six-channel routing)

`services/ai/comm-router.js` is the brain for routing WHO-HEARS-WHAT.

Six channels:
1. **Max direct** — DM speaks "Max, ..." → routed to HAL
2. **Max dice** — DM speaks a roll keyword after Max wake → dice interpreter
3. **NPC direct** — DM speaks NPC name first → routed as scripted speech
4. **NPC auto-dialogue** — AI-generated NPC lines via `npc:approved`
5. **P2P** — player speaks another player's name first → private whisper
6. **Ambient** — unmatched player speech → rolling transcript buffer

For each NPC speech event, comm-router:
1. Computes **hearing tiers** per player from map distance + walls + atmosphere noise + conditions
2. Resolves **language barrier** per player via `resolveLanguage(npcId, playerId, {languageId})`
3. Combines: `BARRIER > KATYA_BRIDGE > PARTIAL > FULL`
4. Applies `_applyLanguageTier()` to text (BARRIER → "[unintelligible — slovak]")
5. Dispatches `player:npc_speech` per-player with `{text, tier, languageResult, fullText}`
6. Whispers a routing summary to the DM earbud

### 7e · Language resolver

Inside `resolveLanguage()`:

1. Direct match — player speaks the language → `FULL` with fluency
2. Mutually intelligible — Czech+Slovak, Polish+Slovak → `FULL via: mutual`
3. Partially intelligible — dialects → `PARTIAL`
4. **Fallback to Common — ONLY IF the DM did not specify a language.** If the
   DM explicitly picked a language (e.g. scripted `languageId: 'slovak'`),
   the resolver does NOT fall back — non-speakers get BARRIER. This was a
   real bug fixed 2026-04-17.
5. Katya bridge — if Katya is in range and speaks both → `KATYA_BRIDGE`
6. Hard barrier

Test tooling:
- `POST /api/languages/preview {npcId, playerId, languageId}` → resolver result
- `GET /api/languages/players` → each PC's structured language list

### 7f · System prompt injection

`context-builder.js` assembles the NPC context (scene, map, players,
languages, story, atmosphere, race reactions). **Player `languages` field is
injected** (fix 2026-04-17) so the AI knows what Ed/Kim/Jen/Nick/Spurt can
actually understand.

## 8 · Audio architecture

| Path | Source | Destination | Mechanism |
|---|---|---|---|
| Earbud whispers (DM-only) | Voice-service ElevenLabs or browser-TTS fallback | DM's Bluetooth earbud | Priority queue 1–6; 1 = URGENT/system, 6 = auto-read |
| Room speaker (NPC dialogue) | ElevenLabs TTS triggered by `npc:approved` | PC audio → Echo Dot Max via 3.5mm aux | Chrome `setSinkId()` routes different Audio elements |
| SFX | ElevenLabs sound-generation → cached as MP3 in `assets/sounds/` | Player Chromebook via WS `audio:play` | Gesture-unlocked on first tap |
| Ambience | Same path as SFX, looped | Player Chromebook via WS `audio:ambience` | `window._ambience` element |
| Directional horror | Voice-service → Alexa TTS via `behaviors/preview` API | Other Echo devices (kitchen, dining, office) | Alexa cookie auth, expires 2-4 weeks |
| Player STT | Chromebook mic → WS `audio:chunk` → audio-service → Gemini STT | Transcript events into bus | Replaces old local Whisper (removed) |

Chromebook autoplay: `Audio.play()` is blocked until first user gesture. The
`playAudioUrl()` helper in `player-bridge/public/index.html` queues all audio
that arrives before the first tap, then drains on unlock. Shows a
"Tap anywhere to enable sound" toast if anything is queued.

## 9 · UI surfaces

### 9a · `services/dashboard/public/index.html` — main DM dashboard

Panels (all pop-outable via `/panel/panel-<name>`):
- Map / VTT renderer (canvas 2D)
- Transcript
- Combat tracker + initiative
- NPC status + dialogue approval queue
- HAL query + history
- Wounds display (SVG body silhouette, 6 limbs × 5 tiers)
- Atmosphere profile selector
- Player list with per-player heal/full-rest/clear-wounds buttons
- Encounter proposals (with approve/skip)
- Spurt AI agent panel
- DDB tools (pull/push/cookie)
- Session tools (save/reset/resume/snapshot/restore/skip-time)

WS: connects to `wss://HOST:3200/` (no `?player=` → routed to dashboard WSS)

### 9b · `services/dashboard/public/dm-ref.html` — reference UI

An alternate DM view with a "Players" tab showing per-PC cards. Dave uses
this for at-a-glance player state. The Chazz button bug was in this file.

### 9c · `services/player-bridge/public/index.html` — player Chromebook UI

One URL per player: `https://HOST:3200/player/<slug>`. WS:
`wss://HOST:3200?player=<slug>` — routed to player-bridge WSS (not dashboard).

Features:
- Character sheet (stats, saves, skills, spells, attacks, inventory)
- HP bar, stamina ring, wound panel (SVG limb overlay)
- Player-visible map with fog of war
- Observation cards (perception flashes, ambient events)
- Handouts panel (with language-gated readability)
- Chat (party, DM whispers, P2P, NPC dialogue)
- Movement range overlay during combat
- Dread overlay / screen FX (tint, flash, dread_vision)
- Private NPC audio player (ElevenLabs MP3s played locally)
- Bardic Inspiration receiver (Chazz gives, others receive)
- Gemini STT via mic button

WS message types the client handles: see `handle()` switch in the file. All
`type`s must be cased correctly — silent drops happen when a service
dispatches with a `type` that has no `case`.

## 10 · Session 0 plan

**Date:** April 19, 2026 (Sunday)

**Opening:** All PCs are already in the tavern (Pallid Hart inn). They have
been here varying lengths of time. They do NOT know each other — anonymous
token mode ("Traveler" labels). Each player can observe the others but knows
nothing of them.

**Roster at the Pallid Hart:**
- 4 player PCs: Ed/Vaelthion (Human Rogue, native Slovak), Kim/Zarina (Half-Elf Fighter, Mark of Detection), Jen/Marfire (Firbolg Barbarian), Nick/Chazz (Tiefling Bard)
- 1 AI PC: Spurt the Sorcerer (Kobold) — played by spurt-agent
- 1 PC arriving at dawn: Jerome/Barry Frascht (Human Warlock; has hidden Van Helsing bloodline — see `project_barry_frascht.md` memory)
- 4 patrons: Henryk (German merchant), Brother Aldric (pilgrim), Katya (minstrel, translates Slovic↔Common), Old Gregor (dying farmer)
- Vladislav (vampire CR13, disguised; wants the cellar)
- Tomas Birkov (werewolf CR3 disguised as trapper; also wants the cellar; reveals on full moon / wound inspection DC14 / midnight)
- Marta Hroznovska (nervous innkeeper)
- Piotr (vampire spawn CR3, chained in cellar)
- Swarms (bats, rats), a wolf, a dire wolf, a generic vampire spawn CR5

**Load-bearing narrative hooks:**
- Gregor dies speaking Slovak to **Vaelthion/Ed** at a chosen moment. Ed is the party's only fluent Slovak speaker. Without him, this scene breaks.
- Dominik's private whispers test Ed's Slovak + piety.
- Katya bridges Slovak↔Common for the rest of the party (implicit, range-gated).
- Full moon + wounds inspection can trigger Tomas reveal.

**9 atmosphere profiles:** tavern_warm → tavern_tense → tavern_dark →
investigation → dread_rising → terror_peak → combat → revelation → dawn.

**Maps:** 4 locations, all have ChatGPT-generated battlemaps (1536×1024 px).
Ground floor uses 8960×5120 / 256px coord space (VTT stretches). Others use
1536×1024 / 64px grid.

Details in `config/session-0.json` + `config/session-0-fragments/*.json`.

**MISSING but acceptable for Session 0:** a per-PC "why are you at the Pallid
Hart tonight" document. Generic `scene.arrivalNotes` covers it. Can be
drafted as `docs/session0-polish/player-arrivals.md` later.

## 11 · Atmosphere + Hubitat integration

- Profiles: `config/atmosphere-profiles/*.json` (14 files)
- Each profile defines: `lights` (bulbs + RGB + brightness), `playerEffects`
  (screen tint/flash), `audio` (ambience track), `narrator` (one-line intent)
- Selector: POST `/api/atmosphere/profile` with `{profileId}` or use the
  dashboard dropdown
- Hubitat: Maker API via `HUBITAT_TOKEN` env var, URL pattern
  `http://192.168.0.131/apps/api/.../devices/<id>/setColor`
- Alexa cookie auth: used for directional TTS only; cookie expires every
  2-4 weeks; see memory `feedback_deployment.md` for refresh procedure

## 12 · Testing & regression canary

Three test levels, run in this order:

### 12a · Unit-style scripts (no server needed)

- `scripts/test-gregor-slovak-routing.js` — Stubs bus, validates the private
  Slovak whisper path. **9/9 is the target.**
- `scripts/test-ooa-execution.js` — Bidirectional opportunity-attack logic
- `scripts/test-spurt-agent.js` — Spurt AI tactical target picking

### 12b · Live end-to-end smoke (server must be running)

- `test-smoke.js` at co-dm root — 48 checks across:
  - Server up, /api/state populated
  - WS connect for Dave + Ed + Kim + Jen + Nick
  - init packets carry correct character per player
  - Language inventory per PC
  - audio:play broadcast routed to all players
  - private:whisper routed to one player only
  - friendly_fire shooter + victim routed correctly
  - ambient:observation broadcast
  - NPC language gating (Marta Slovak → Ed/Nick FULL, Kim/Jen BARRIER)
  - Perception flash one-to-one
  - WS reconnect recovery
  - HP round-trip REST persistence
  - Movement REST endpoint sanity

**Target: 48/48.** Run this before any session or after any code change that
touches services.

### 12c · API + UI checks

- `curl -sk https://localhost:3200/api/ai/health` → `status:ONLINE`
- `curl -sk https://localhost:3200/api/ddb/status` → `hasCookie:true, status:ONLINE`
- Browse `https://localhost:3200/` (DM dashboard)
- Browse `https://localhost:3200/player/ed` (any player UI)

## 13 · Known issues + deferred work

| # | Issue | Severity | Defer reason |
|---|---|---|---|
| 1 | co-dm → DDB push returns HTTP 405 (write API changed) | medium | Session 0 using paper; fix post-session by reverse-engineering DDB Network tab. See memory `post-session-0-worklist` drawer. |
| 2 | Per-PC "why at inn" document doesn't exist | low | Generic arrivalNotes covers it; draft optional. |
| 3 | Map token JSON duplicates character name/AC — drift risk on rename | low | Update by hand when renaming PCs. |
| 4 | Ed's character excluded from auto-sync — manual edits don't refresh from DDB | by-design | Toggle by re-adding `164451753` to `ddb-config.json`, at cost of clobbering hand-edits. |
| 5 | `character-service.js saveCharacter()` silently overwrites manual edits | footgun | Documented; mitigation is `ddb-config.json` exclusion. |
| 6 | `162702065` (Jerome/Barry) arrives at dawn — `absent: true`, `notYetArrived: true` | intentional | Session design. |
| 7 | Multi-monitor DM dashboard (detach panels across 3 monitors) | planned | Pop-out routes exist (`/panel/panel-<name>`); full drag-to-monitor workspace is a post-Session-0 project. |
| 8 | Full AI-controlled NPC token movement + tactical positioning | planned | Ambient-life-service has basic NPC shift; full tactical autonomy is planned post-Session-0. |
| 9 | Alexa cookie expires every 2–4 weeks — directional horror goes silent | recurring | Refresh cookie via browser Network tab. |
| 10 | Gemini API key rotation — bashrc exports shadow .env | operational | `~/.bashrc` line ~120 exports `GEMINI_API_KEY`; keep in sync with `.env` or remove the bashrc export entirely. |

## 14 · Operating procedures

### 14a · Start / stop

```bash
# Start (preferred — watchdog + .env source)
~/dark-pilgrimage/start.sh

# Stop
pkill -f 'node.*server.js'
# (watchdog will restart unless you also kill watchdog.sh)

# Start without watchdog (for debugging)
cd ~/dark-pilgrimage/co-dm
set -a && source .env && set +a
node server.js ../config/session-0.json
```

### 14b · Rotate Gemini API key

1. Generate new key at https://aistudio.google.com/app/apikey
2. `sed -i 's|^GEMINI_API_KEY=.*|GEMINI_API_KEY=NEWKEY|' ~/dark-pilgrimage/co-dm/.env`
3. Update `~/.bashrc` line ~120 `export GEMINI_API_KEY="..."` to match
4. Restart: `pkill -f 'node.*server.js' && ~/dark-pilgrimage/start.sh`
5. Verify: `curl -sk https://localhost:3200/api/ai/health`

### 14c · Refresh DDB Cobalt cookie (every 2–4 weeks)

1. Log into dndbeyond.com in Chrome
2. DevTools → Application → Cookies → dndbeyond.com → `CobaltSession`
3. Copy the value (starts with `eyJ...`, ~159 chars)
4. `POST /api/ddb/cookie {"cookie":"<value>"}` via dashboard Tools tab, OR
   `sed -i 's|^COBALT_COOKIE=.*|COBALT_COOKIE=<value>|' ~/dark-pilgrimage/co-dm/.env`
5. Restart server to apply (if you didn't use the API)

### 14d · Add / rotate a player character

1. Update `config/character-assignments.json` — player-slug → new ddbId
2. Update `config/ddb-config.json` `characterIds` — add the new ID
3. Audit + update `config/character-language-overrides.json` (the `ed` slot
   was stale for weeks — see MemPalace drawer "Character-swap reconciliation
   checklist")
4. Audit + update `config/race-reactions.json` for the new race
5. Update the map token in `config/maps/<active>.json` — name + AC + image
6. Check `config/session-0-fragments/*.json` for `pc` / `playerRace` / `playerClass` fields
7. Check `prompts/hal-codm.md` for narrative name references
8. Restart, then confirm via `test-smoke.js` 48/48

### 14e · Snapshot / restore

- `POST /api/test/snapshot {name}` — snapshot current state
- `GET /api/test/snapshots` — list all
- `POST /api/test/restore/<id>` — restore
- Snapshots live under `sessions/<date>/state-snapshots/`

## 15 · Git state (2026-04-17)

- **Parent repo** (`~/dark-pilgrimage`): branch `feature/phase-r-complete`, remote `github.com:Damo2142/DarkPilgramage.git`. NOT merged to `main`.
- **Submodule** (`~/dark-pilgrimage/co-dm`): branch `feature/session0-polish`, same remote. NOT merged to `main`.
- Last pre-session commit on co-dm: `eb95a12` — "fix: character sheet calculations + Chazz button bug"
- Last pre-session commit on parent: `04ac8b7` — "bump co-dm: character sheet calc fixes + Chazz button bug"

Merge to main after Session 0 runs clean.

## 16 · Memory system

This project uses two persistence layers for future AI sessions:

1. **Native Claude memory** at
   `~/.claude/projects/-home-dave-dark-pilgrimage/memory/` — Markdown files
   with frontmatter. `MEMORY.md` is the index. Types: `user`, `feedback`,
   `project`, `reference`.
2. **MemPalace** (MCP server) — richer, queryable knowledge graph + drawers
   (verbatim content) + diary. Invoked via `mempalace_*` tools. Auto-save
   hook fires at end of every Claude Code session.

Key memory files a new AI should read on startup:
- `MEMORY.md` — index
- `build-plan.md` — 79-feature master plan
- `session-resume.md` — exact pickup point
- `feedback_deployment.md` — bare-metal only, no Docker
- `feedback_vision.md` — AI should run all NPCs autonomously like a video game RPG
- `feedback_bug_audit_2026_04_17.md` — bug-class patterns from the pre-Session-0 audit
- `reference_smoke_test.md` — canary test pointer

MemPalace drawers worth searching when you pick up:
- "Ed character swap reconciliation" — how to safely swap a PC
- "DDB API write direction broken" — the 405 post-session worklist
- "Character-swap reconciliation checklist" — 9-place audit after any swap
- "DDB auto-sync clobbers manual edits" — the character-service footgun

## 17 · Quick-reference paths

| Need | Path |
|---|---|
| Entry | `co-dm/server.js` |
| Orchestrator | `co-dm/core/orchestrator.js` |
| Main session config | `co-dm/config/session-0.json` + fragments |
| All 22 services | `co-dm/services/*` |
| DDB pull code | `co-dm/services/characters/character-service.js` `ddbSyncOne()` |
| DDB push (broken) | same file, `ddbPushHp()`, `ddbPushSpellSlots()` |
| Char-calc recompute | same file, `recomputeDerivedStats()` |
| Language resolver | `co-dm/services/ai/comm-router.js` `resolveLanguage()` |
| HAL/Max system prompt | `co-dm/prompts/hal-codm.md` |
| Smoke test | `co-dm/test-smoke.js` |
| Slovak routing unit test | `co-dm/scripts/test-gregor-slovak-routing.js` |
| Player UI | `co-dm/services/player-bridge/public/index.html` |
| DM dashboard | `co-dm/services/dashboard/public/index.html` |
| DM reference UI | `co-dm/services/dashboard/public/dm-ref.html` |

## 18 · If you are an AI taking over

1. Read `MEMORY.md` first.
2. Then search MemPalace for `dark-pilgrimage` wing drawers.
3. Run `node test-smoke.js` to see if anything is broken.
4. Check `git log --oneline -10` on both repos.
5. Don't rebuild ESP32 / haptic or Foundry — those were removed deliberately.
6. Don't add Docker — the bare-metal requirement is non-negotiable (audio device routing).
7. Don't generalize this into a product — it's for Dave's table only.
8. When in doubt about an NPC's reaction to a PC, check `config/race-reactions.json` + `config/character-language-overrides.json` — those are the two files that have repeatedly held stale data from early testing.

## 19 · If you are a DM taking over

1. The campaign premise: gothic horror, 1274 Central Europe, three-castle
   arc. October, winter coming on. Vampires and werewolves exist and are
   terrible. The church is a political/military force, not a spiritual comfort.
2. Each PC has a narrative anchor — see `config/session-0-fragments/10-player-hooks.json`
   and `config/race-reactions.json` per-player entries.
3. The AI plays every non-PC at the table. You narrate and voice-act. You do
   not need to track NPC positions, dialogue, or stats — HAL handles it. You
   focus on pacing and letting players feel weight.
4. The Co-DM whispers to your earbud when it notices something: a good
   perception roll that ought to reveal a clue, an NPC goal that's going
   unaddressed, a world-clock event firing. Trust the whispers — they are
   short (under 60 words) and actionable.
5. When players speak, the AI already hears them via mic → STT. You don't
   need to describe what they said. Just react to it.
6. At the end of each session, the campaign service generates a recap and
   persists timeline + lore. You can edit both in `sessions/campaign/`.

## 20 · SRD rules accuracy scorecard (honest state, 2026-04-17)

Dave's requirement: **all services follow SRD rules, accurately, for both
PCs and NPCs**. Full 5e rule coverage is a huge surface — this section is the
honest scorecard of what's enforced live, what's authored-in-data-but-not-
recomputed, and what still requires the DM to manually apply.

### Enforced live — computed + verified

| Rule | Where | Notes |
|---|---|---|
| Ability score → modifier | `character-service.js recomputeDerivedStats()` | Source of truth: `abilities[*].score`. Auto-recomputed every load. |
| Class saving-throw proficiencies | same | `CLASS_SAVE_PROFS` lookup applied at load — fills DDB gaps. |
| Save modifier = ability mod + PB(if prof) | same | Preserves pre-existing `proficient: true` flags (feats, race). |
| Skill modifier = ability mod + PB × tier | same | Tiers: `none/proficiency/expertise/half-proficiency`. |
| AC from equipped armor (Light/Medium/Heavy + Shield + magic bonus) | same + `SRD_ARMOR_AC` lookup | Falls back to SRD table when DDB omits `definition.armorClass`. |
| Initiative defaults to DEX mod | same | Only applied if no explicit override present. |
| Wall collision on movement | `map-service.js _pathBlockedByWall()` | Open doors / windows pass through appropriately. |
| Speed clamp in combat (feet → squares) | `map-service.js _moveToken()` | Rounds with overshoot guard; dash prompt at 2× speed. |
| Door-interaction prompts | same | Lock-pick via `/api/map/walls/toggle-door`. |
| Attack roll = d20 + attack bonus vs target AC | `combat-service.js _resolveAttack()` | Accepts DDB-computed `toHit` (authoritative). |
| 5e shooting-into-melee semantics (disadvantage at range ≤5 to an enemy of a melee ally) | `combat-service.js` cover system | Verified Saturday test, CR `dd4de`. |
| Opportunity attack (bidirectional: PC flees NPC → NPC OoA; NPC flees PC → PC OoA) | `combat-service.js _maybeOpportunityAttack()` | Commit `b23aa6a`. |
| Language barrier gating (NPC speech → per-player BARRIER/PARTIAL/FULL) | `ai/comm-router.js resolveLanguage()` | Respects DM-specified `languageId` (no Common fallback when language is explicit). |
| Proximity hearing tiers + wall attenuation | `ai/comm-router.js _calculateHearingTiers()` | Distance in ft, atmosphere noise, wall count, deafened/distracted conditions. |
| Katya language bridge | same | `KATYA_BRIDGE` tier when she's in range and speaks both. |
| NPC stat block normalization (SRD snake_case → camelCase) | `map-service.js _normalizeActorStatBlock()` | Both shapes readable downstream. Authoritative fields from statblock — no recompute that would overwrite hand-authored bonuses. |
| Horror / dread thresholds + per-PC arcs | `horror-service.js` | Dread score 0–100; thresholds: calm/unsettled/afraid/terrified. |
| Wound tier → HP / narrative mapping | `character-service.js _computeWounds()` | 6 limbs × 5 tiers. |
| Passive Perception = 10 + WIS mod + prof (if prof in Perception) | `observation-service.js` line 137 comment | Formula applied when rolling active perception. |

### Authored in data, not dynamically recomputed (authoritative from source)

| Rule | Data file | How it's used |
|---|---|---|
| NPC attack bonus + damage dice | `config/actors/*.json` `actions[]` | Read directly by combat-service `_rollNpcAttack()`. Combat trusts these. |
| NPC saving throw bonuses | `config/actors/*.json` `<ability>_save` fields | Normalized to `savingThrows[abbr].modifier` — combat uses directly. |
| NPC skills | `config/actors/*.json` `skills` flat object | Normalized — combat can call via `skills[key].modifier`. |
| Monster damage resistances / immunities / vulnerabilities | `damage_resistances`, `damage_immunities`, `damage_vulnerabilities` | Used by combat-service damage application. |
| Spell slot tables | `character-service.js FULL_CASTER_SLOTS`, `WARLOCK_SLOTS` | Computed from class+level via `computeSpellSlotsForClasses()`. |
| Spell save DC | Read from DDB per-character; no dynamic recompute | Authoritative from the DDB side. |
| Spell attack bonus | same | Authoritative from DDB. |

### NOT YET wired — manual DM application required

| Rule / Feature | Class | How it shows up in play | Status |
|---|---|---|---|
| Sneak Attack (2d6 at level 3) | Rogue | Player declares on hit with advantage or adjacent ally; DM adds the 2d6 manually | Feature listed on sheet; no tracker/button |
| Cunning Action | Rogue | Bonus Action: Dash/Disengage/Hide | Listed; no button |
| Wails from the Grave (Phantom) | Rogue subclass | Splits SA damage to a second target as psychic | Listed; no mechanic |
| Weapon Mastery — Nick, Vex (2024 rules) | Various | Declared on hit, adds bonus effect | Listed; no mechanic |
| Sorcery Points (3 at L3) + Flexible Casting | Sorcerer | Convert slot ↔ points; DM tracks manually | No UI counter |
| Wild Magic Surge | Sorcerer | Trigger on spell 1+; 5% by default; DM rolls d100 from surge table | No table/trigger button |
| Metamagic (2 options known) | Sorcerer | Apply to a spell; costs sorcery points | No UI |
| Pact Magic slots (2 L2 slots, short-rest recovery) | Warlock | Tracked manually via DM | Handled in spell slot compute |
| Hex (1st-level spell, +1d6 necrotic) | Warlock | Upkeep concentration; adds damage on hit | No tracker |
| Invocations (1 at L3) | Warlock | Always-on modifier depending on invocation | No UI |
| Rage (3 uses, damage resist + +2 dmg) | Barbarian | **Wired** — button + counter + banner | ✅ |
| Reckless Attack | Barbarian | Advantage on attacks + enemies have advantage against you this turn | No button |
| Danger Sense | Barbarian | Advantage on DEX saves against effects you can see | Not auto-applied |
| Bardic Inspiration (4 uses, d6) | Bard | **Wired** — gives target a d6 to add to roll | ✅ |
| Cutting Words / Combat Inspiration | Bard subclass | Reactive use of Bardic Inspiration | No mechanic |
| Jack of All Trades | Bard | Half prof on non-prof skills | **Wired** via `half-proficiency` tier |
| Action Surge / Second Wind | Fighter | **Wired** | ✅ |
| Fighting Style auto-apply | Fighter | Defense +1 AC, Archery +2 to ranged attacks, etc. | Authored by DDB, not auto-enforced on recompute — trust DDB |
| Extra Attack | Fighter (5+) | N/A at L3 |  |
| Channel Divinity | Cleric/Paladin | 1 use per short rest (L2+) | No counter |
| Lay on Hands pool | Paladin | HP pool = 5 × level | No tracker |
| Wild Shape | Druid | 2 uses per short rest | No counter |
| Ki Points | Monk | = level | No counter |
| Concentration tracking | all casters | Losing concentration on damage requires CON save DC 10 or half damage | No automatic concentration state |
| Advantage/disadvantage stacking | all | Multiple sources don't stack (one adv + any number of disadv = straight roll) | Wounds contribute; feats/conditions partial |
| Exhaustion | all | Stamina service handles exhaustion-like pool | Not 1:1 with 5e 6-level exhaustion |
| Death saves | all | **Wired** — combat-service handles death-save rolls | ✅ |
| Inspiration (from DM) | all | **Wired** — `/api/inspiration` grants + tracks | ✅ |

### Honest assessment

**Core combat math** (attack roll, damage, AC, saves, opportunity attacks,
language gating, wall collision, speed clamps) **works correctly and follows
SRD rules.** The system plays clean combat.

**Class feature uses** (Rage, Bardic, Second Wind, Action Surge) are wired
for **Barbarian, Bard, Fighter.** Other classes — **Rogue, Sorcerer, Warlock,
Monk, Druid, Cleric, Paladin, Ranger, Wizard** — have their features listed
on the character sheet but the mechanics are not click-to-use. The DM must
apply them by narration + manual tracking.

**NPCs/monsters** are statted via SRD statblocks (open5e format). Their
attack bonuses, damage, saves, skills, resistances, and immunities are
correctly honored by combat-service because both field shapes (snake_case
and camelCase) are accepted.

**Concentration, advantage stacking, and exhaustion** are partial. The wound
system contributes to advantage/disadvantage narratively but does not track
every source. The DM is the source of truth for these rulings at the table.

### Work order for "100% rules accuracy" (post-Session-0)

Priority 1 — the classes at your table tomorrow that don't have wired abilities:
- Rogue (Ed): Sneak Attack tracker + Cunning Action + Weapon Mastery declarations
- Sorcerer (Spurt): Sorcery Points UI + Wild Magic Surge trigger + Metamagic
- Warlock (Barry, arriving dawn): Pact slots UI + Hex concentration + Invocations list

Priority 2 — universal combat rules:
- Concentration tracking with auto-CON-save prompt on damage
- Advantage/disadvantage source registry (conditions, wounds, features, terrain)
- Exhaustion levels 1-6 with full SRD effects (disadv on ability checks, speed halved, etc.)

Priority 3 — other classes (for future campaigns):
- Monk / Druid / Cleric / Paladin / Ranger / Wizard feature wiring

Priority 4 — polish:
- Spell DC auto-compute from `8 + PB + spellcasting ability mod`
- Spell attack auto-compute from `PB + spellcasting ability mod`
- Fighting Style auto-apply at load
- Feat effects (Alert, Sentinel, Great Weapon Master, etc.)

---

*This document is the one-stop handoff. If it gets stale, the person
updating it should also update `MEMORY.md` index, the MemPalace decisions
room, and push a fresh commit. Don't let it drift.*
