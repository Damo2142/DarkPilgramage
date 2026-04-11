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
- [x] SYSTEM F — NPC dialogue fix and stamina initialization
- [x] SYSTEM G — Dashboard visual redesign and player UI fixes
- [x] SYSTEM H — Full integration pass and dry run preparation

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

### SYSTEM F — NPC Dialogue Fix and Stamina Init
**Status: PASS**
**Files modified:** `services/ai/npc-handler.js`

**Built/Fixed:**
- Fixed double-leading-quote issue in NPC dialogue cleaning (AI sometimes produces `""Oh...`)
- Verified NPC dialogue pipeline: raw Gemini response logged, cleaned text logged, full dialogue not truncated
- Verified Marta dialogue: spoken dialogue first, no reference to "father", uses "traveler" as address
- Verified stamina API: both /api/stamina/jerome and /api/stamina/barry resolve correctly via _resolvePlayerId
- Stamina init confirmed: jerome/barry → {max:70, current:70, state:'fresh', conMod:2}
- No "father" references found in config, prompts, or AI service code (already cleaned in prior work)

**Test results:**
- GET /api/stamina/jerome returns valid JSON — PASS
- GET /api/stamina/barry resolves to jerome, returns valid JSON — PASS
- Marta NPC dialogue: full spoken response, no truncation, no father ref — PASS
- Double-quote fix applied to npc-handler.js cleaning pipeline — FIXED

**Decisions:**
- The NPC dialogue "truncation" issue from the spec appears to have been already resolved
- The "father" references were already prohibited in npc-base.md and hal-codm.md prompts
- No further changes needed to stamina — _resolvePlayerId already handles name fallback

### SYSTEM G — Dashboard Visual Redesign and Player UI
**Status: PASS**
**Files modified:** `services/dashboard/public/index.html`, `services/player-bridge/public/index.html`

**Dashboard changes:**
- Updated CSS variables: bg=#141210, surface=#1e1a14, panel-body=#12100c, text=#c8b89a, accent=#e8c060
- Panel headers: #1e1a14 bg, #3a3028 border, 12px uppercase 0.08em letter-spacing, #8a7a62 text
- Panels: 8px border-radius, #2a2218 border, 8px gap between
- Wound dots: 14px diameter (was 10px), 4px gap (was 3px)
- Player name: 14px #e8d0a0 (was 10px)
- Weather icon + game time display added to header bar
- Horror color indicator on player rows (green→amber→red border-left)

**Player bridge changes:**
- Added 5-tab navigation: CONDITION / ARMS & ARMOR / GIFTS & MAGIC / SOUL / NUMBERS
- Tab bar: #2a2420 bg, inactive #6a5a48, active #e8c060 with 2px underline
- Sections wrapped in tab divs, switchTab() JS function
- Observation zone: fixed overlay at top, italic fade-in, auto-fade after 45s
- dm:private_message with style='observation' routes to observation zone instead of toast

**Test results:**
- Server starts: all services OK — PASS
- Dashboard page loads with new colors — PASS
- Player page loads with tab structure — PASS

**Decisions:**
- Wound silhouette size not changed per spec ("stays at current compact size")
- Pop-out panel functionality already existed — added it to all panel headers
- Equipment equipped/pack split deferred to integration test (needs char sheet data)

### SYSTEM H — Full Integration Pass and Dry Run
**Status: PASS**

**Server Startup:** 19 services, all initialized cleanly
```
✓ characters (1 character: Barry Goodfellow Frascht)
✓ dashboard (HTTPS, port 3200)
✓ player-bridge (HTTPS, port 3202)
✓ map (3 maps, 322 SRD monsters, 110 SRD items, 145 SRD spells, 13 custom actors)
✓ combat
✓ world-clock (14 timed events, 6 secrets, 14 clues, 4 hooks, 3 factions)
✓ audio (Whisper ready)
✓ voice (disabled — no ALEXA_COOKIE)
✓ sound (disabled — no ELEVENLABS_API_KEY, 39 cached sounds)
✓ ai-engine (Gemini connected)
✓ atmosphere (10 profiles, Hubitat configured)
✓ campaign (7 lore entries, 2 downtime events)
✓ equipment
✓ stamina (Jerome initialized: max 70, fresh)
✓ lighting (9 sources, 8 lit)
✓ observation (6 event observations, 2 monster tell sets)
✓ horror (1 player, arc profile generated)
✓ social-combat
✓ hazard (4 hazards, 3 NPC standings)
```

**Integration Test Results:**
1. Stamina API: /api/stamina/jerome ✓, /api/stamina/barry ✓ (both resolve to Jerome)
2. Lighting: 9 sources loaded, 8 lit, toggle works ✓
3. Passive Perception: Barry PP=13, DC12 ✓ (reaches), DC15 ✓ (filtered)
4. Horror: Jerome 0→20 on vladislav_feeds, threshold 20 triggered ✓
5. Social Combat: Vladislav started, advantage active, momentum adjustable ✓
6. Hazards: 4 active, all correct ✓
7. NPC Standings: 3 NPCs at 0, adjustable ✓
8. NPC Dialogue: Marta responds about cellar, no father reference ✓
9. NPC Dialogue: "The Stranger" (Vladislav) responds in character ✓
10. Light toggle: table-candle-1 extinguished ✓
11. Session start: creates session ID ✓
12. Dashboard visual: new color scheme loads ✓
13. Player bridge: tabs load, observation zone ready ✓

**Not tested (requires physical devices/browser):**
- Movement rate limiting overlay (requires browser drag)
- Map dim/dark overlays (canvas rendering)
- Hubitat light control (no token in test env)
- Alexa TTS (no cookie auth)
- Pop-out panel window.open() (requires browser)
- Equipment condition degradation (requires combat with nat 1 / crit)

**Git Log:**
See commit history for all systems in order.

### COMBAT SERVICE FIX — Flexible Combatant Resolution
**Status: PASS**
**Files modified:** `services/combat/combat-service.js`

**Problem:** `startCombat()` required exact map token IDs (e.g., `vladislav-mmmq6srl10`) which the DM would never know.

**Fix:** Added `_resolveToken(input)` method that accepts any of:
1. Exact token ID (e.g., `vladislav-mmmq6srl10`)
2. Actor slug (e.g., `vladislav`, `marta`)
3. Character/NPC name (e.g., `Vladislav Dragan`, `Tomas Birkov`)
4. Player ID (e.g., `jerome`) — auto-creates virtual combatant from character data
5. NPC config ID (e.g., `hooded-stranger`) — resolves via NPC trueIdentity to token
6. Fuzzy partial name match as fallback

**Test results:**
- `"jerome"` → Barry Goodfellow Frascht (PC, from character data) ✓
- `"vladislav"` → Vladislav Dragan (token via actor slug) ✓
- `"marta"` → Marta Kowalski (token via actor slug) ✓
- `"tomas"` → Tomas Birkov (token via actor slug) ✓
- `"hooded-stranger"` → Vladislav Dragan (via NPC trueIdentity match) ✓
- `"Vladislav Dragan"` → exact name match on token ✓

**Push Status:**
- Git push failed — permission denied (known issue, needs auth fix)
- All commits are local on branch `main` (co-dm) and `feature/phase-r-complete` (parent)
- Dave will need to fix GitHub auth and push manually

---

## OVERNIGHT AUTONOMOUS RUN — Sections 23-35

### SECTION 23 — Poludnitsa Creature File
**Status: PASS**
- `config/creatures/poludnitsa.json` created. CR5 fey, conversation-based mechanic.
- Future hook merged into existing `config/future-hooks.json` — total 10 hooks.
- All existing creature files protected (Letavec, Penitent untouched).

### SECTION 24 — Integration Pass
**Status: PASS — programmatic validation**

**Creature files (all 15 — load without parse errors):**
- aufhocker, corpse-candle, erlking, gas-spore, hound-of-tindalos, moroaica,
  nachtmahr, neck, nocni-letavec, penitent, poludnitsa, strigoi, vrykolakas,
  wailing, wild-hunt — all PASS

**Settlements:** PASS — 15 settlements load from `config/world/settlements.json`
**Campaign arc:** PASS — `The Dark Pilgrimage`, 5 acts
**Future hooks:** PASS — 10 hooks (Poludnitsa added)
**Session 0 NPCs:** PASS — marta, tomas, hooded-stranger, aldous-kern, gas-spore
- Vladislav `letavecKnowledge`: TRUE, `hydraAwareness`: TRUE
- Aldous `aiDialogueBrief`: present
- Henryk inventory contains boot-wax with futureHook flag

**Server startup:** PASS — orchestrator boots, all 20 services register, NPCs load.
Container port 3200 collision is expected (Docker container running). Standalone
node runs validate config loading; live HTTP testing requires container restart.

**Items NOT yet exercised in live runtime (require live server interaction):**
- Dream generation (Horror system queue) — code path exists, not triggered live
- Autonomous combat loop full round — combat-service has NPC tactics but live
  test requires running server with map state populated
- Language Slovak filter live delivery — code path scheduled in S25
- Shed scene as triggerable event — not yet built (planned S30 foreground events)
- Domovoi ambient behaviors — pre-existing system, not modified by this run
- Breathing room indicator in dashboard top bar — not yet built

**Items confirmed via static inspection:**
- All creature stat blocks parseable
- Session 0 contains all required NPC additions
- Vladislav social combat unlock chain present
- Henryk boot wax dialogue + inventory present
- Bag of holding cellar item with bagman flag present

### SECTION 25 — Language Audio + Americas Origin
- See commit `feat: language audio system Americas origin framework`
- `config/setting-authenticity.json` created with rules
- AI context builder injects setting-authenticity rules and americas guidance
- NPC reactions for non-human characters appended to session-0.json
- Dashboard session control toggles for non-Common NPC speech routing

### SECTION 26 — Voice Profiles + Directional Audio
- All 9 Session 0 NPCs (Marta, Vladislav, Tomas, Gregor, Aldric, Katya, Henryk,
  Aldous, Piotr) have `voiceProfile` and `roomPosition` populated
- ElevenLabs fallback chain in sound service: ElevenLabs → Echo TTS → text-only
- elevenLabsVoiceId fields empty (DM populates manually)

### SECTION 27 — Pre-Session Planning
- Dashboard panel `pre-session-planning` added with five sub-panels
- `/api/campaign/pre-session-briefing` endpoint generates AI briefing
- Saves session plan adjustments to LevelDB

### SECTION 28 — Monetary System
- Character `purse` field initialized with cp/sp/gp/pp + transactions log
- `config/world/regional-pricing.json` with currency display map
- NPC price lists merged into Marta and Henryk in session-0.json
- Resource consumption marked invisible by default — surfaced as story
- Dashboard party finance panel added to Players panel

### SECTION 29 — Language Backstory Validation
- DDB sync flow flags non-Common languages on import
- Common (= Latin) auto-approved
- Draconic auto-approved for Kobolds, requires backstory for humans
- Americas languages forbidden for European humans without DM override

### SECTION 30 — Three-Button Session System + Living World
- Start Campaign / Start Session / Stop Session implemented in dashboard
- World clock continuous mode added to world-clock-service
- Between-session player web UI with chat/journal/correspondence/downtime tabs
- World history log in campaign-service with `addWorldHistoryEntry`
- Correspondence travel-time calculation using settlement gazetteer distances
- `home_normal` atmosphere profile created

### SECTION 31 — Test Mode
- Test Mode toggle in dashboard Settings
- Red TEST banner when active
- Reset Campaign / Reset Session / Skip Time / Force Fire / Save State / Restore
- Auto-snapshot on Start Session (last 10 retained)

### SECTION 32 — Automatic World Principle
- Appended to `prompts/hal-codm.md` (existing content preserved)
- Resource surfacing rules and NPC autonomous decision rules

### SECTION 33 — Final Integration Test
- All JSON files load
- All JS syntax checks pass
- Server boots clean (subject to container port collision in dev)
- Live runtime tests pending — DM should run after Docker restart

### SECTION 34 — Encounter and Treasure System
- `config/world/encounter-tables.json` — orava-mountains, bohemia, moravia,
  western-hungary tables built
- `config/world/treasure-tables.json` — categories + coin scaling
- `config/world/curiosities.json` — compass-wrong, carved-figure, locket-portrait,
  key-no-lock, sealed-letter
- `config/world/magical-items.json` — hunters-cloak, ring-of-warmth-addiction,
  sword-that-hungers, mirror-of-truth, boots-of-silent-approach, journal-of-the-hunter
- Dashboard Encounter and Treasure panels added

### SECTION 35 — Port Verification
- Port 3200 confirmed serving:
  - `/` and `/dashboard` — DM dashboard
  - `/player/jerome` — Barry Frascht (player-bridge route)
  - `/player/spurt` — Spurt
  - `/player/zarina` — Zarina Firethorn
  - `/tablet` — tablet map view (path-based routing on same port)
- No port changes required

### REQUIRES HUMAN ATTENTION BEFORE WEEKEND DRY RUN
1. Restart Docker container to pick up service JS changes (volume mounts only
   cover HTML — service .js requires `docker compose build --no-cache`)
2. Run live integration tests for combat AI loop, dream delivery, language audio
3. Populate ElevenLabs voice IDs for NPC voiceProfiles (currently empty, falls
   back to Echo TTS)
4. Fix GitHub push auth — all commits are local on `main` (co-dm) and
   `feature/phase-r-complete` (parent)
5. Verify Hubitat `home_normal` profile bulb response with physical bulbs
6. Mirror of truth flagged for Session 0: shows nothing where Vladislav's
   reflection should be — DM needs to remember this if players use it
7. Spurt's americasOrigin needs to be populated in his character file when
   imported from DDB

