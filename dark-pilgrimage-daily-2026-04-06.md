# Dark Pilgrimage — Daily Update: April 6, 2026

**Session duration:** ~3 hours
**Deadline:** April 19, 2026 (13 days remaining)
**Overall status:** All 79 features complete. Three major new systems added today. Integration testing phase.

---

## What Got Built Today

### 1. HAL Co-DM System
A direct query interface between the DM and the AI, bypassing the normal NPC/story pipeline.

**Voice trigger:** DM says "HAL, what would Vladislav do here?" into the mic. The word "HAL" is stripped, the rest routes to Gemini with full game context (5-minute transcript buffer, map state, NPC goals, secrets, clues). Response whispered to DM earbud and displayed in the HAL dashboard panel.

**Dashboard panel:** Shows last 8 HAL exchanges. DM query in gold, AI response in blue. Text input at the bottom for typed queries. Pulsing orange indicator while thinking, green flash on response. Auto-scrolls.

**System prompt** (`prompts/hal-codm.md`): HAL is the writer and director. The DM is the voice actor. HAL owns narrative continuity, canon, pacing, NPC consistency. Covers rules, story, lore, tactics, descriptions, improvisation. 60-word max — responses are whispered into an earbud.

**API:** `POST /api/hal/query` (typed), `GET /api/hal/history`. Event bus: `hal:query`, `hal:thinking`, `hal:response`. Session log source: `hal_query`.

### 2. Movement Rate Limiting
Token drag on both player bridge and DM dashboard now shows movement range.

**Player bridge (enforced):**
- Drag start reads `char.speed`, draws green dashed circle (normal range) and orange dashed circle (dash = 2x speed) centered on start position
- Ghost token turns orange in dash zone, red at boundary, snaps to max range
- Feet counter above token during drag: `moved/speed ft`
- Drop beyond normal range → modal: "Dash (uses your action)" or "Cancel"
- Dash marks action as spent for the turn
- Zones with `difficult_terrain: true` double movement cost
- In combat: cumulative tracking per turn, resets on `combat:next_turn`
- Outside combat: overlay shows for reference, each drag independent (no enforcement)
- Both mouse and touch handlers

**DM dashboard (informational):**
- Green + orange range circles shown when dragging PC tokens
- No enforcement — DM can always move freely

### 3. Gothic Wound System
No player ever sees a hit point number. Wounds replace HP as the player-facing health indicator.

**Server-side** (`character-service.js`):
- 6 body regions: head, torso, leftArm, rightArm, leftLeg, rightLeg
- 5 severity tiers: 0 Unharmed / 1 Scratched / 2 Wounded / 3 Broken / 4 Crippled
- Auto-computed from HP thresholds on every `hp:update` event:
  - >75% HP → all clear
  - 50-75% → Scratched (one random limb)
  - 25-50% → Wounded (torso always + limbs escalate)
  - <25% → Broken (torso + multiple limbs)
  - 0 HP → Crippled (all)
- Wounds only escalate, never auto-downgrade
- DM manual override: `PUT /api/wounds/:playerId/:limb` with `{ state: 0-4 }`
- `wounds:updated` event broadcasts to all clients

**Player bridge:**
- "Body" tab with SVG humanoid silhouette, 6 clickable regions
- Color scale: dark green → olive → amber → deep red (slow pulse) → near-black (fast pulse)
- 30 unique narrative descriptions (6 limbs x 5 states), all gothic horror tone
- Example: Head Wounded → "Your ears ring. The world tilts when you move too fast."
- Persistent mini silhouette overlay in lower-right corner on ALL pages
- Tap overlay to expand wound detail popup
- HP bar hidden from players — they only see wounds

**DM dashboard:**
- "Wounds" panel: compact row per player with 6 colored dots
- Click any dot → popover with +/- controls for that limb
- Changes push immediately to server

**AI integration:**
- On wound tier escalation, AI generates a <20-word gothic wound description
- Uses recent transcript to tie the wound to what caused it (e.g., "Three deep furrows open across Barry's forearm, black at the edges.")
- Whispered to DM earbud + shown in HAL panel

### 4. HP Hidden from Players
The HP bar, damage/heal buttons, and temp HP display are hidden from the player bridge (`display:none`). All HP sync logic still works server-side — the DM sees everything. Players see only their wound silhouette.

---

## Files Modified

| File | Changes |
|------|---------|
| `services/ai/ai-engine.js` | HAL query system, voice trigger detection, wound AI descriptions (+149 lines) |
| `services/characters/character-service.js` | Wound computation from HP, wound API routes (+90 lines) |
| `core/state-manager.js` | Wounds object in player default state (+4 lines) |
| `services/dashboard/public/index.html` | HAL panel, DmWounds panel, movement range overlay (+247 lines) |
| `services/player-bridge/public/index.html` | Movement limiting, wound SVG panel, persistent overlay, HP hidden (+444 lines) |
| `prompts/hal-codm.md` | New file — HAL Co-DM system prompt |
| `services/dashboard/dashboard-service.js` | Minor route additions (+12 lines) |
| `services/player-bridge/player-bridge-service.js` | Player bridge service updates (+14 net lines) |
| `config/session-0.json` | Session config updates |

**Total:** +1,247 lines across 11 files, 1 new file

---

## Git Status

- **co-dm submodule (main):** 2 commits ready, NOT pushed (GitHub auth needs SSH key or token)
  - `62de52a` HAL Co-DM system, movement rate limiting, gothic wound system, HP hidden from players
  - `9a7da76` Add persistent wound body overlay to player bridge lower-right corner
- **Parent repo (master):** Not updated yet (waiting for submodule push)

**Action needed:** Set up GitHub SSH key or personal access token to push. Run `cd co-dm && git push origin main` once auth is configured.

---

## What's Next

1. **Push to GitHub** — auth fix needed
2. **Integration testing** — all new systems need live testing with actual player connections
3. **Wound system tuning** — test HP threshold breakpoints with real combat damage
4. **HAL testing** — verify Gemini responses are under 60 words and contextually grounded
5. **Movement testing** — verify difficult terrain zones, dash prompt UX on touchscreen
6. **Token art** — cosmetic, optional
7. **Remaining 4 player character assignments** — pending DDB import
8. **Dry run / playtest** — before April 19

---

## Architecture Notes for Future Sessions

### HAL Query Flow
```
DM speaks "HAL, ..." → transcript:segment (speaker:dm)
  → ai-engine detects /^hal/i prefix
  → strips "HAL", routes to halQuery()
  → context-builder assembles full game state
  → Gemini generate() with hal-codm.md system prompt
  → dm:whisper (earbud) + hal:response (dashboard panel)
  → session:log (source: hal_query)
```

### Wound Computation Flow
```
combat:hp_changed or player HP adjust
  → hp:update event (playerId, current, max)
  → character-service _computeWounds()
  → calculates tier from HP percentage
  → assigns limb wounds (random + rules-based)
  → wounds:updated event → all clients
  → ai-engine generates flavour description
  → dm:whisper + hal:response
```

### Movement Rate Limiting Flow
```
Player drag start → read char.speed, compute pixel budget
  → render green circle (normal) + orange circle (dash)
  → during drag: clamp to boundary, color ghost
  → on drop: check if beyond normal range
    → if yes: show Dash modal
    → if Dash accepted: mark action spent, complete move
    → if Cancel: snap back
  → wall collision checked after movement budget
  → combat: cumulative per turn, reset on turn change
  → outside combat: per-drag, no enforcement
```
