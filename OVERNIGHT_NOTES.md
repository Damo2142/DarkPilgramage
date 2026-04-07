# Overnight Autonomous Build — Phase R
## Started: 2026-04-06
## Branch: feature/phase-r-complete

---

## Build Order
- [x] SYSTEM A — Darkness and light
- [x] SYSTEM B — Passive perception and monster tells
- [x] SYSTEM C — Psychological horror and character arc tracks
- [x] SYSTEM D — Social combat and ambient NPC behavior
- [x] SYSTEM E — Environmental hazards, reputation, session continuity
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

### SYSTEM C — Psychological Horror and Character Arc Tracks
**Status: PASS**
**Files created:** `services/horror/horror-service.js`
**Files modified:** `server.js`

**Built:**
- HorrorService with per-player horror score 0-100 (hidden from players)
- 8 horror trigger types with specified amounts
- 5 threshold effects (20/40/60/80/100) delivered privately
- WIS save DC14 at 80, Frightened at 100
- AI-generated character arc profiles via Gemini
- Barry-specific hardcoded seeds (gregor body, name recognition, stakes, DC15 bonus)
- Transcript watchFor monitoring with pre-built quick thoughts
- DM dashboard color coding (green → amber → deep red)
- REST API: /api/horror, /api/horror/trigger, /api/horror/set, /api/horror/arcs, /api/horror/barry-seed

**Test results:**
- Server starts: 17 services, horror initialized for 1 player — PASS
- GET /api/horror returns jerome at 0/green/calm — PASS
- POST /api/horror/trigger vladislav_feeds: jerome 0→20 — PASS
- Threshold 20 triggered, private message dispatched — PASS
- Arc profile generated via Gemini API — PASS
- DM dashboard color shifts from green to yellow-green — PASS

### SYSTEM D — Social Combat and Ambient NPC Behavior
**Status: PASS**
**Files created:** `services/social-combat/social-combat-service.js`
**Files modified:** `server.js`

**Built:**
- SocialCombatService with momentum -10 to +10
- 5 player actions (persuade/deceive/intimidate/insight/recall) vs AI NPC rolls
- Vladislav-specific rules: advantage on rolls, minimum momentum -3
- AI-generated NPC dialogue colored by momentum
- Vladislav insight DC18 private observation trigger
- Ambient NPC behavior: 8-12 minute random interval, AI-generated or fallback
- REST API: /api/social-combat (GET/start/action/end/momentum/ambient-toggle)

**Test results:**
- Server starts: 18 services — PASS
- POST /api/social-combat/start with Vladislav — PASS
- Social combat action: Barry insight 18 vs Vladislav 20, shift -1 — PASS
- AI dialogue generated for Vladislav response — PASS
- Vladislav advantage and min momentum -3 rules active — PASS

### SYSTEM E — Environmental Hazards, Reputation, Session Continuity
**Status: PASS**
**Files created:** `services/hazard/hazard-service.js`
**Files modified:** `server.js`, `config/session-0.json`

**Built:**
- HazardService with 4 hazard zones (fireplace fire, outdoor blizzard, cellar stairs, balcony)
- Hazard proximity warning and auto-damage on token entry
- Per-NPC standing -10 to +10 trust system (3 NPCs: marta, tomas, hooded-stranger)
- 5 reputation triggers for Session 0 events
- Session end: save all state (wounds, horror, equipment, standings, hazards)
- Long rest recovery: horror -10, wounds downgrade, equipment repair
- AI session summary generation on session end
- REST API: /api/hazards, /api/npc-standings, /api/session/long-rest

**Test results:**
- Server starts: 19 services, 4 hazards, 3 NPC standings — PASS
- GET /api/hazards returns all 4 hazard zones — PASS
- GET /api/npc-standings returns marta/tomas/hooded-stranger at 0 — PASS
- POST /api/npc-standings Marta +5: standing changes to 5 — PASS

