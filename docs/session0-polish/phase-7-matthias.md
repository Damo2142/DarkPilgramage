# Phase 7 — Matthias / Abbey futureHooks

Implemented as fragment `config/session-0-fragments/07-matthias-abbey.json`.

Two futureHook entries:

- **`futureHooks.abbey-of-saint-prokop`** — safe-haven location, 2 days south, past the black pines, 30 brothers + abbot + Matthias (infirmarer). Services listed. Notes the Matthias-Bagman dynamic: Matthias knows the Bagman's true name and has kept him quiet for decades.

- **`futureHooks.father-matthias`** — NPC seed for a Light-domain cleric, level 12, ~60 years old, former soldier, blunt and pragmatic. Includes:
  - Relationships (Vladislav mutual-tolerance, Gregor 32-year friendship, Bagman manager)
  - Services and costs (cure wounds, lesser/greater restoration, raise dead at 500 gp + conditions, reincarnate, no true resurrection here)
  - Explicit NOT-a-DMPC note
  - `fullActorFileDeferred: true` — full statblock is a next-session task, not needed Sunday

## Why fragment 07, not 08

The fragment numbering skips 06 and 08 intentionally — those slots are reserved for Phase 6 (Bagman escalation) and Phase 8 (Spurt tactical hook) which were deferred in this session. When they land, they can slot in as `06-*.json` and `08-*.json` without renaming the existing fragments.

## No code changes

Pure data fragment. Session-0.json untouched. Fragment loader picks it up after session-0.json and before `09-timeline.json` alphabetically.
