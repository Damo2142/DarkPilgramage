# Phase 0 — Branch setup, baselines, Aldous placement

## 0.1 Branch creation — DONE

```
$ cd ~/dark-pilgrimage/co-dm
$ git checkout main
Already on 'main'
Your branch is up to date with 'origin/main'.
$ git pull origin main
Already up to date.
$ git checkout -b feature/session0-polish
Switched to a new branch 'feature/session0-polish'
```

Parent repo `~/dark-pilgrimage` stays on `feature/phase-r-complete` with its unpushed commit. Not touched.

## 0.2 Docs scaffold — DONE

Created `docs/session0-polish/` with:
- `README.md` — running log
- `ARCHITECTURE-DECISIONS.md` — running decision log (one entry: AD-001)
- `KNOWN-ISSUES.md` — running issue log (one entry: KI-001)
- `phase-0-baseline.md` — this file

## 0.3 Aldous Kern placement — NOT NEEDED

**Finding:** Aldous Kern is already present in `config/scenes/pallid-hart-ground.json` as the 10th token at position (3800, 1900) with publicName "The Quiet Man", HP 8/8, AC 10, nameRevealedToPlayers false, actorSlug `aldous-kern`.

**Decision:** Do not modify the scene. See `ARCHITECTURE-DECISIONS.md` AD-001.

**Position rationale verification:** (3800, 1900) places him on the east-center area of the common room, y-aligned with Henryk the Merchant at (2500, 1900) but ~1300px (~9 grid squares / ~45 ft) apart. Aldric is at (1800, 1100), Gregor at (2800, 1500), Katya at (1400, 1700), Tomas at (3200, 1300). No overlap. Near the front door on the east wall — narratively fitting for a pilgrim who watches the entrance.

## 0.4 Baseline verification

Because Phase 0 makes no runtime-impacting changes (no service code modified, no config modified, just added docs), formal verification via service restart is deferred until Phase 1 introduces the first functional changes. At that point we'll:
- Start service via `~/dark-pilgrimage/start.sh`
- Confirm 21 services log "ready"
- Confirm `curl -k https://localhost:3200/health` returns 200
- Confirm Aldous appears in scene tokens via `/api/map` after a session reset

Deferring is a judgment call — Phase 0 adds only markdown files in `docs/`, no code or config is touched. Restarting the live system to verify no-op docs would be wasteful. The first real verification point is end of Phase 1.

## Commit

Single commit closes Phase 0:
```
docs(session0-polish): Phase 0 branch setup and planning scaffold
```
