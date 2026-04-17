# Phase 11 — Cleanup

Implemented as fragment `config/session-0-fragments/11-cleanup.json`.

## Midnight `tomas_breaks` clarification

The existing `tomas_breaks` timed event at `1274-10-16T00:00:00` in session-0.json is a stale DM cue — `ambient-life-service.js:796` actually fires the transformation at 22:00. The cue's own text already admits this ("Ambient-life owns the actual transform tick — this is the DM cue").

Because the fragment loader is array-CONCAT (not replace), the fragment cannot edit the original event in place. Instead, this fragment adds a sibling event one minute later (`tomas-midnight-clarification` at 1274-10-16T00:01:00) that explains to the DM what just happened. This is the simplest safe path — the original event fires harmlessly at midnight as atmosphere, and 60 seconds later the clarification whisper primes the DM that Tomas is already a werewolf (contained in cellar, or loose in the room per state).

### Alternative considered

- Rewriting the original `tomas_breaks` text by editing session-0.json directly. Rejected: risk of corrupting the JSON, and touches a file that Dave may have local work against.
- Adding a `__replace__` sentinel to the fragment loader. Rejected: adds complexity for a one-time cleanup.

### Post-deadline follow-up

After Sunday, Dave can manually edit `tomas_breaks.data.text` in session-0.json to reflect its actual role. Not urgent.

## Other minor fixes

Reviewed `KNOWN-ISSUES.md` during this pass. No additional minor fixes were identified that were (a) safe to change pre-Sunday AND (b) in scope for this work order. Items already noted as deferred:

- `npc:arrival` handler for Dominik
- `_lookup` runtime resolution for Gregor's token:move
- `checkFlag` free-form-JS condition evaluator
- Demo-stage wiring in combat-service
- `combat:wolves_arrive` subscription
- Disguise state-machine flip

All deferred items are described with specific owning code paths in the relevant phase docs so a follow-up session can pick them up.
