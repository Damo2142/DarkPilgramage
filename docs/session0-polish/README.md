# Session 0 Polish — Running Log

**Branch:** `feature/session0-polish`
**Started:** 2026-04-17
**Target merge-ready date:** 2026-04-18 EOD (Dave tests Saturday, Sunday April 19 is game night)
**Author:** Claude Code (Opus 4.7, 1M context) on pve1, working from a work-order by Claude Opus 4.7 (consumer app)

## Status overview (final — end of 2026-04-17 autonomous session)

| Phase | Subject | Status | Commit(s) |
|---|---|---|---|
| 0 | Branch + baselines + Aldous placement | ✅ SHIPPED | 47ba5ca |
| 1 | NPC combat positioning | ✅ SHIPPED (OoA detect-only, exec deferred) | 4515605, 7a2af63 |
| 2 | Combat rules enforcement UI | 🚫 BLOCKED — see BLOCKED-phase-2 | — |
| 3 | Brother Dominik Novák | ✅ SHIPPED | 373407d |
| 4 | Gregor's deathbed scene | ✅ SHIPPED | 5794145 |
| 5 | Vladislav enhancements | ✅ SHIPPED (data-only; demo wiring deferred) | 5794145 |
| 6 | Bagman escalation | 🚫 BLOCKED — see BLOCKED-phase-6 | — |
| 7 | Matthias / Abbey futureHooks | ✅ SHIPPED | 5794145 |
| 8 | Spurt tactical hook | 🚫 BLOCKED — see BLOCKED-phase-8 | — |
| 9 | Timeline additions | ✅ SHIPPED | 5794145 |
| 10 | Per-player campaign hooks | ✅ SHIPPED (scaffold — Dave reviews) | 5794145 |
| 11 | Cleanup | ✅ SHIPPED | 5794145 |
| 12 | Self-test and final report | ✅ SHIPPED | this commit |

**Read `phase-12-final-report.md` for the full rundown.** Then `BLOCKED-*.md` files for the three deferred phases. Each deferred phase has a Sunday manual workaround + a detailed spec for the next autonomous session.

Phases 2, 6, 8 are **code-heavy** (dashboard HTML edits, new REST endpoints, AI agent behavior). They were deferred rather than rushed because:
- All three have trivial manual workarounds for Sunday (narrate the mechanics at the table)
- None of them block game-night content
- A rushed implementation would risk the system Dave depends on

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
