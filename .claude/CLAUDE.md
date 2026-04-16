## PERMISSIONS
- Full read/write/execute permissions on this system
- Do not ask for permission — Dave has authorized all actions
- Commit and push code freely
- Save memory and status updates every 30 minutes automatically

# Co-DM Development Context

## Resume Point
When starting a new session, read these memory files first:
1. `~/.claude/projects/-home-dave-dark-pilgrimage/memory/MEMORY.md` — full project context
2. `~/.claude/projects/-home-dave-dark-pilgrimage/memory/build-plan.md` — 79 features, 17 phases
3. `~/.claude/projects/-home-dave-dark-pilgrimage/memory/session-resume.md` — exact pickup point

## Current Status: ALL 79 FEATURES COMPLETE (Phases A-Q) + Ambient Life System
Next priorities (in order):

### Priority 1: Multi-Monitor DM Dashboard
The current single-page dashboard is too much on one screen. Dave has 3 monitors and needs to spread panels across all of them. Build a proper multi-window system where every panel (map, transcript, combat tracker, NPC status, HAL, wounds, etc.) can be detached and dragged to any monitor. Pop-out foundation exists (`/panel/panel-{name}` routes) — extend it into a full multi-window workspace. Each window should remember its position/size across sessions.

### Priority 2: Full AI-Controlled NPC Autonomy (Token Movement + Actions)
NPCs and monsters must be as realistic and AI-controlled as possible — actions, token movements, decisions all handled by the Co-DM. Dave describes what is happening; the AI runs everything else. The ambient-life-service has basic NPC position shifting. Expand this so the AI decides WHERE NPCs walk on the map in real time, moves their tokens, chooses when to interact/speak/fight, and handles tactical positioning during both exploration and combat. This should feel like a video game RPG at a tabletop — a living world where every non-player entity is autonomous. The DM is the narrator/voice actor; the Co-DM is the director running the show.

### Priority 3: Integration Testing + Dry Run
Full system test before April 19 deadline. All 20 services running together, player devices connected, AI responding, ambient life firing, NPC autonomy working.

## Completed: ALL phases A-Q + session save/resume + panel pop-out + audio routing + language gating + Docker graceful shutdown fix + ambient life system (env ticks, NPC movement, proximity dwell, Katya performances)

## Rules
- This is a PERSONAL project — no product abstraction, no Shroud, no multi-platform
- Built for Dave's home: Hubitat smart home, Echo devices, Chromebooks, Dell touchscreen
- ESP32/haptic and Foundry integration are REMOVED — do not build or reference
- Work every day until April 19 deadline
- Be thorough, do your best work, don't cut corners
- Volume-mounted HTML = live reload. Service JS = Docker rebuild required.
- Always push to GitHub at end of session
- Always update memory files before ending session
