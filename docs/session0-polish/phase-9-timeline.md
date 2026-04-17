# Phase 9 — Timeline additions

Implemented as fragment `config/session-0-fragments/09-timeline.json`.

## Events added

| Time | ID | Role |
|---|---|---|
| 18:20 | `ground-floor-shutter-ed-spotlight` | Ed spotlight observation (Letavec past the window); DC 14 passive for others |
| 19:00 | `horse-dies-in-stable` | Scream-cut-off + three-toed tracks + missing stableboy |
| 19:15 | `upstairs-shutter-volunteer` | Marta asks a PC to check upstairs — quiet by default (Spawn 1 is suppressed unless Room 5 is opened) |
| 20:45 | `marta-confession-to-kim` | Private story beat — Marta's scar, "if he transforms, make it quick" |
| 21:45 | `wolves-through-window` | Combat beat: wolf + distraction window + front-door second wolf — positioning-lesson scenario |
| 23:45 | `tomas-descends-to-cellar-if-contained` | Atmosphere beat conditional on Tomas being contained — audio cue through the floor |

## Design notes

- **Wolves-through-window is the teaching combat.** Three threats, three timings. If the party piles on the wolf and ignores the front door, the second wolf hits the squishiest PC at range. This is explicitly designed to surface the group's bad-positioning habits without being fatal.
- **Marta's confession** conditionally fires on `kim_within_5ft_of_marta` flag — which the DM or a proximity handler sets manually. For Sunday, Dave watches for the moment and fires manually via the dashboard.
- **Horse-dies** is early (19:00) to establish Letavec threat before any other monster acts visibly. The three-toed tracks only make sense once the party has the word "Letavec" in their vocabulary, so it's deliberately a puzzle.

## Risks / deferred

- `targetCharacter: "ed"` + `bypassPPCheck: true` on Letavec observation — verified supported by observation-service per earlier snapshot review. Kim's Mark-of-Detection observations use the same pattern.
- Wolf combat uses `combat:wolves_arrive` dispatch — existing combat-service does not subscribe to that event. DM manually starts wolf combat via dashboard on Saturday/Sunday. Full auto-trigger on a combat event is a follow-up.
