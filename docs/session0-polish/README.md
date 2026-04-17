# Session 0 Polish — Running Log

**Branch:** `feature/session0-polish`
**Started:** 2026-04-17
**Target merge-ready date:** 2026-04-18 EOD (Dave tests Saturday, Sunday April 19 is game night)
**Author:** Claude Code (Opus 4.7, 1M context) on pve1, working from a work-order by Claude Opus 4.7 (consumer app)

## Status overview

| Phase | Subject | Status | Commits |
|---|---|---|---|
| 0 | Branch + baselines + Aldous placement | IN PROGRESS | — |
| 1 | NPC combat positioning | pending | — |
| 2 | Combat rules enforcement UI | pending | — |
| 3 | Brother Dominik Novák | pending | — |
| 4 | Gregor's deathbed scene | pending | — |
| 5 | Vladislav enhancements | pending | — |
| 6 | Bagman escalation | pending | — |
| 7 | Matthias / Abbey futureHooks | pending | — |
| 8 | Spurt tactical hook | pending | — |
| 9 | Timeline additions | pending | — |
| 10 | Per-player campaign hooks | pending | — |
| 11 | Cleanup | pending | — |
| 12 | Self-test and final report | pending | — |

This file is updated at every commit boundary. If you are resuming autonomously, start here, then read `phase-<N>-*.md` for the phase you are in.

## Operating rules (as given by the work-order)

- **Never merge to `main`.** Dave does that after testing.
- **Never force-push.** Ever.
- **Commit often.** If a phase is big, split into sub-commits.
- **Additive > modificatory.** Preserve existing behavior.
- **Document every non-obvious decision** in `ARCHITECTURE-DECISIONS.md`.
- **Document every issue you find but don't fix** in `KNOWN-ISSUES.md`.
- **If truly blocked,** write `BLOCKED-<topic>.md` and continue.

## Quick reference

- Snapshot (ground truth as of 2026-04-17): `~/dark-pilgrimage/CURRENT-STATE-SNAPSHOT.md`
- Live system: bare-metal via `~/dark-pilgrimage/start.sh` — kill node + rerun start.sh to pick up service JS changes
- HTML (dashboard + player-bridge public/) is live-reload (volume-mounted in old Docker days, just browser-refresh now)
- Ground-truth roster: `config/character-assignments.json` + `config/characters/*.json`
- Tomas transforms at **22:00 in-game** (ambient-life-service.js:796), not midnight
