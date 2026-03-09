# THE DARK PILGRIMAGE — CO-DM PROJECT STATUS
**Updated:** 2026-03-09  
**Session:** March 9 build night

---

## SYSTEM OVERVIEW

AI-powered Co-DM for gothic horror D&D 5e campaign set in 1274 Central Europe. Three-castle arc: Orava → Houska → Čachtice. The Co-DM system handles real-time atmosphere, lighting, player character sheets, NPC dialogue, Dread tracking, and session management.

### Infrastructure
| Component | Details |
|-----------|---------|
| **pve1** | i5-3470, 4 cores — primary VM host, runs Co-DM |
| **pve5** | Xeon 5160, 4 cores — runs Foundry VTT |
| **Foundry VTT** | v13, Ubuntu 24.04 VM @ `192.168.0.198:30000`, user `dave`, service `foundry` |
| **Co-DM** | Docker on pve1, systemd service `co-dm` |
| **Dashboard** | `https://192.168.0.198:3200` |
| **Player Bridge** | `https://192.168.0.198:3202/player/{name}` |
| **Hubitat Bridge** | `http://192.168.0.198:3100` (plain HTTP), service `dp-bridge` |
| **Hubitat** | `192.168.0.131`, Maker API app ID `1102`, token = `$HUBITAT_TOKEN` |

### Key File Locations
```
~/dark-pilgrimage/co-dm/              ← main project
  server.js                           ← entry point (auto-loads session-0.json)
  docker-compose.yml                  ← ports 3200 + 3202, volume mounts
  config/
    session-0.json                    ← scene, NPCs, story beats (auto-loaded)
    character-assignments.json        ← { "playerId": "foundryId" }
    characters/                       ← character JSON files from Foundry export
    atmosphere-profiles/              ← 9 JSON profiles
  services/
    dashboard/public/index.html       ← DM dashboard (volume-mounted, no rebuild needed)
    player-bridge/public/index.html   ← Player character sheet (volume-mounted)
    characters/character-service.js   ← supports foundryId AND ddbId
    atmosphere/atmosphere-engine.js   ← Hubitat lighting control
  core/
    orchestrator.js
    state-manager.js
    event-bus.js

~/foundry-data/Data/modules/dark-pilgrimage/
  module.json
  scripts/main.mjs
  scripts/character-export.mjs        ← "Export Characters → Co-DM" button in Foundry

~/dark-pilgrimage-bridge/server.mjs   ← Hubitat bridge, port 3100
```

---

## WHAT IS BUILT AND WORKING

### Co-DM Core
- [x] Node.js orchestrator with event bus, state manager, session logger
- [x] Docker container with HTTPS (self-signed certs)
- [x] systemd service (`co-dm`) with auto-restart
- [x] Volume mounts for HTML files — no rebuild needed for UI changes
- [x] `session-0.json` auto-loaded on startup (server.js fix, March 9)

### DM Dashboard (`3200`)
- [x] Live session stats and event log
- [x] Real-time transcript panel with **🗑 Clear** button
- [x] Player cards with HP bars, Dread bars, online/offline indicator
- [x] **📋 Sheet button** — opens full character sheet modal (fixed March 9)
- [x] **+ Add Player** button — creates player slot, shows URL
- [x] **✕ Remove Player** button on each player card
- [x] Character assignment dropdown (assign Foundry character to player)
- [x] Dread controls (+5 / +10 / -5 / -10 / +20)
- [x] Atmosphere profile grid (9 profiles)
- [x] NPC dialogue queue with approve/reject/edit
- [x] NPC manual dialogue trigger
- [x] Story beats panel — loaded from session-0.json, click to complete
- [x] Horror effects panel (screen tint, flash, whisper, dread vision)
- [x] Private message to player
- [x] AI trust level selector (Manual / Assisted / Autopilot)
- [x] Session controls (Start / Pause / Resume / End)
- [x] PANIC button (restores all lights to full)
- [x] **Collapsible panels** — click any section header to collapse (March 9)
- [x] **Resizable columns** — drag the divider bars between Transcript / Controls / Players to resize; layout saved to localStorage (March 9)
- [x] Earbud TTS with priority queue and category filters

### Player Character Sheet (`3202/player/{name}`)
- [x] Proper player-specific page (was serving dashboard HTML — fixed March 9)
- [x] WebSocket connects with `?player=playerId` param
- [x] Character auto-injected on connect from Foundry export
- [x] **Stats tab** — ability scores (editable), saving throws, death saves, conditions
- [x] **Combat tab** — attacks auto-built from inventory, roll to attack (crit/miss), spell attack/DC
- [x] **Spells tab** — spell slot pips (click to use/restore), add spells manually, add slot levels
- [x] **Skills tab** — click proficiency dot to cycle none/proficiency/expertise
- [x] **Items tab** — inventory by category, equipped toggle, currency display, add items
- [x] **Features tab** — auto-populated for Kobold + Wild Magic Sorcerer, add/remove
- [x] **Dice tab** — d4 through d100, custom dice, roll history
- [x] **Notes tab** — persistent notes (localStorage), chat
- [x] HP tracking with damage (temp HP absorbs first), healing, temp HP
- [x] Dread bar
- [x] Horror effects layer (screen tint, flash, visions)
- [x] Vitals strip (AC, Initiative, Speed, Prof, Inspiration) — all editable

### Character System
- [x] Foundry module exports characters via "⛧ Export Characters → Co-DM" button
- [x] Character service supports both `foundryId` and `ddbId` as lookup keys
- [x] `character-assignments.json` strips comment keys (`_comment`, `_example`)
- [x] Characters pushed to player pages on connect and on re-import

### Smart Home / Atmosphere
- [x] 9 atmosphere profiles (tavern_warm → terror_peak → dawn)
- [x] Sengled RGBW bulbs: device IDs 912, 913 (color), 880/881/649/582 (ambient)
- [x] Hubitat bridge at port 3100 (plain HTTP — avoids SSL cert issue)
- [x] **Session end turns ALL lights off** (fixed March 9 — was restoring to full bright)
- [x] PANIC button restores lights to full (intentional — safety use)
- [x] Flicker engine for horror profiles
- [x] Ambient lights stay off during sessions (RGB only)

### AI Engine
- [x] Gemini 2.0 Flash client (free tier, live sessions)
- [x] Rolling transcript context builder
- [x] NPC dialogue handler with DM approval queue and trust levels
- [x] Atmosphere advisor with confidence scoring
- [x] Story beat tracker with DM nudge system
- [x] Two NPC profiles built: Marta Kowalski, Vladislav Dragan

### Audio
- [x] Whisper.cpp pipeline (base.en model, VAD enabled)
- [x] Python worker calls `whisper-cli` as subprocess (AVX workaround for pve5)
- [x] numpy pinned to `<2`
- [x] Player mic streaming via WebSocket (HTTPS required for browser mic access)

---

## CURRENT CHARACTER: SPURT THE SORCERER
- **File:** `config/characters/UWI7ofarm9TdYbAG.json`
- **Assignment:** `config/character-assignments.json` → `"testplayer": "UWI7ofarm9TdYbAG"`
- **Player URL:** `https://192.168.0.198:3202/player/testplayer`
- Kobold Wild Magic Sorcerer 3 | HP 17/17 | AC 12 | CHA +3
- No spell slots exported from Foundry yet (add manually on player sheet Spells tab)
- Weapons: Scorpion Staff, Dagger, Unarmed Strike

---

## KNOWN ISSUES / LIMITATIONS

| Issue | Status |
|-------|--------|
| DDB-Importer SSL errors | External proxy issue, not local. Cobalt cookie saved. Not blocking. |
| **HP sync DM dashboard** | Player HP changes on player sheet do not update DM dashboard in real time. Bus dispatch fires but dashboard does not re-render. Needs dedicated debug session. |
| Spell slots not in Foundry export | Add manually on player sheet Spells tab |
| Sengled bulb device IDs | Confirmed: 912, 913 (color), 880/881/649/582 (ambient) |
| Port 30000 external access | TCP forwarding not yet configured |
| Dell touchscreen table display | Monk's Common Display configured, hardware setup pending |

---

## PENDING BUILDS

### Immediate
- [ ] **HP sync** — real-time HP updates from player sheet to DM dashboard player cards
- [ ] **Dashboard drag-to-reorder panels** — drag individual sections (Players, Story Beats, NPC Queue, etc.) into any order; save layout to localStorage
- [ ] **Swap in Twilight Tavern maps** in Foundry
- [ ] **Create NPC actors** in Foundry (Marta, Vladislav)
- [ ] **Build audio playlists** in Foundry
- [ ] **Add walls and lighting** to scenes in Foundry
- [ ] **Port forwarding** — 30000 TCP for external Foundry access

### Build 5 — Roll Engine / Voice Action Parser
Parse spoken combat calls from DM mic transcript ("Spurt attacks the stranger, rolls 14") into structured roll events. Trigger dice animations on player screens.

### Build 6 — Wound & Combat System  
Combat tracker with initiative order, turn indicators on both DM and player screens. DM rolls initiative for all PCs (d20 + DEX), Co-DM tracks order. No Foundry sync needed — Co-DM owns combat state during sessions.

### Build 7 — Player App Upgrade
- QR code join flow
- Chromebook kiosk mode
- Dual-axis alignment tracking (Compassion ↔ Ruthlessness)
- Private DM-to-player channel (targeted documents, cursed item whispers)

### Build 8 — Foundry Write-back
Co-DM → Foundry actor HP/spell slot updates. Currently one-directional (Foundry → Co-DM only).

### Build 9 — AI Intelligence Upgrades
- **Spurt AI Agent** — Kobold Wild Magic Sorcerer played by AI. Gemini generates in-character responses on his turn or when addressed. Dread tracked separately, gets unhinged at 80+. Approve via earbud queue.
- Improved NPC memory and knowledge tier enforcement
- Session summary generation

### Build 10 — Multi-Room Audio (Echo Speaks)
- Per-NPC SSML voice profiles delivered via Echo devices
- Surround-sound horror: scratching from other rooms, whispers from behind players
- Game room Echo Dot Max as primary output

### Build 11 — Between-Session Features
- Session summary auto-generation
- Character XP / level-up tracking
- Campaign timeline and lore database

### Build 12-13 — Shroud Product Prep
The Co-DM system is being developed as a marketable product called **Shroud** — an AI-powered tabletop horror engine.
- Docker-based architecture for distribution (already done)
- Smart home abstraction layer (Hubitat, Home Assistant, SmartThings)
- VTT abstraction layer (Foundry, Roll20, Owlbear)
- Revenue model: free core + Pro subscription + campaign marketplace
- This campaign is the proof-of-concept

---

## HARDWARE ON HAND
- USB camera + mic
- ESP32 microcontrollers + vibration motors (planned: haptic Dread feedback)
- Raspberry Pis
- Dell touchscreen (player/map table display)
- Echo devices throughout home (Echo Dot Max in game room)
- Chromebooks (dedicated player devices during sessions)
- Sengled RGBW bulbs (installed, IDs confirmed)

---

## TOOLS & API KEYS
- **Gemini API** — `$GEMINI_API_KEY` in env (free tier for live sessions)
- **Hubitat Token** — `$HUBITAT_TOKEN` in env
- **Claude Max plan** — between-session prep and building
- **GitHub** — https://github.com/Damo2142/DarkPilgramage.git
- **D&D Beyond** — Cobalt cookie saved in DDB-Importer

---

## KEY TECHNICAL NOTES
- pve5 Xeon 5160 **has no AVX** — numpy 2.x, ctranslate2, PyTorch will crash. Always use pve1 for ML. Pin numpy `<2`, use whisper.cpp via subprocess.
- Mobile browsers require **HTTPS for microphone**. Self-signed certs on 3202.
- Volume mounts mean **HTML edits don't need a Docker rebuild** — just refresh browser.
- `session-0.json` is **auto-loaded** on startup. Edit it to change scene/NPCs/beats.
- Character lookup uses `foundryId` first, falls back to `ddbId`.
- `character-assignments.json` — keys starting with `_` are stripped (comments safe).
- Bash `!` breaks sed in double-quoted strings — use Python for complex patches.

---

## SESSION CADENCE
- **During sessions:** Gemini handles live Co-DM (low latency, free)
- **Between sessions:** Claude Max handles building, design, prep
- **Transcript IDs:** module source `2026-02-28-15-56-14`, VM setup `2026-02-28-22-55-58`, campaign design `2026-02-28-14-42-02`

---
*To give this doc to Claude tomorrow: include the tarball + this file in your first message.*