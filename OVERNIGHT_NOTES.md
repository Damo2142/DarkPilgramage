# Overnight Autonomous Build — Phase R
## Started: 2026-04-06
## Branch: feature/phase-r-complete

---

## Build Order
- [x] SYSTEM A — Darkness and light
- [x] SYSTEM B — Passive perception and monster tells
- [ ] SYSTEM C — Psychological horror and character arc tracks
- [ ] SYSTEM D — Social combat and ambient NPC behavior
- [ ] SYSTEM E — Environmental hazards, reputation, session continuity
- [ ] SYSTEM F — NPC dialogue fix and stamina initialization
- [ ] SYSTEM G — Dashboard visual redesign and player UI fixes
- [ ] SYSTEM H — Full integration pass and dry run preparation

---

## Decisions Log

### System A
- Used feetPerGrid=5 for standard D&D 5ft grid calculation
- Character senses stored as object `{darkvision:60}` not string — added type-safe parsing (typeof check, Array.isArray, JSON.stringify fallback)
- Aldric's holy symbol starts extinguished, activates at 23:00 prayer event via timed event
- Dashboard map dim/dark overlay visuals deferred to System G (visual redesign pass)
- Fireplace extinguish triggers Hubitat ambient dim to 10% via existing atmo:light event bus
- Light positions use grid coordinates matching map token positions

---

## System Build Results

### SYSTEM A — Darkness and Light
**Status: PASS**
**Files created:** `services/lighting/lighting-service.js`
**Files modified:** `server.js`, `config/session-0.json`

**Built:**
- LightingService with fuel tracking, darkvision/blindsight, combat penalties, weather effects
- 9 Session 0 light sources: fireplace, 4 sconces, 2 candles, Katya lantern, Aldric symbol
- REST API: GET/POST /api/lighting endpoints
- Hubitat integration for fireplace dim
- Vladislav darkness whisper

**Test results:**
- Server starts: 15 services, lighting loads 9 sources — PASS
- GET /api/lighting returns all sources with correct data — PASS
- POST /api/lighting/toggle toggles fireplace lit/extinguished — PASS
- Bug fix: senses object type handling — FIXED AND VERIFIED

### SYSTEM B — Passive Perception and Monster Tells
**Status: PASS**
**Files created:** `services/observation/observation-service.js`
**Files modified:** `server.js`, `config/session-0.json`

**Built:**
- ObservationService with 3-tier observation system (auto/PP-filtered/investigation)
- 7 event observation sets with all Session 0 observations from spec
- Monster tells for Vladislav (8 tells) and Tomas (5 tells)
- Passive perception calculation: 10 + skills.perception.modifier
- Private message delivery via dm:private_message with 45s duration
- DM earbud whisper for all tiers
- REST API: /api/observations, /api/observations/fire, /api/observations/pp, /api/observations/tells

**Test results:**
- Server starts: 16 services, 6 event observations, 2 monster tell sets — PASS
- GET /api/observations/pp returns Barry PP 13 — PASS
- POST /api/observations/fire tier 2 DC12: Barry sees it (PP 13 >= 12) — PASS
- POST /api/observations/fire tier 2 DC15: Barry doesn't see it (PP 13 < 15) — PASS
- Monster tells loaded for hooded-stranger and tomas — PASS

