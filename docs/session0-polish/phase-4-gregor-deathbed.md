# Phase 4 — Gregor's deathbed scene

Implemented as fragment `config/session-0-fragments/04-gregor-deathbed.json`. Merged cleanly on top of session-0.json's existing 21:00 `gregor_collapse` event — this extends rather than replaces.

## Timed events added

| Time | ID | Purpose |
|---|---|---|
| 21:00 | `gregor-collapse-severe` | Escalates the existing `gregor_collapse` with DC 12 / DC 15 Medicine checks revealing vampire toxin, plus DC 13 passive perception on Vladislav's reaction |
| 21:05 | `gregor-moves-to-ed` | `token:move` event — Gregor pulls Ed close; _lookup on Ed's position at runtime |
| 21:08 | `gregor-deathbed-message` | Scripted speech in Slovak (full text + narrator translation), private to Ed's Chromebook with English to DM earbud. Names Matthias, Abbey, Bagman warning, Vladislav |
| 21:10 | `gregor-death-save-window` | 2-minute save window; healing stabilizes (unconscious but alive) |
| 21:12 | `gregor-death-or-stable` | Resolves + transfers bag to Ed on death; `npc:died` fires; `state.items.bag-of-holding-cellar.carrier = 'ed'` |
| 21:13 | `vladislav-approaches-gregor` | Vladislav crosses the room, kneels, Slovak farewell, Common warning about the bag, sets `vladislav_named_in_slovak` and `vladislav_mentioned_bag_warning` flags |

## Slovak text verification

Full Slovak message at 21:08 includes all key names: Matthias, Prokop, Bagman (Vreckár), Bledá laň (Pallid Hart), Vladislav. Narrator translation follows the work-order English verbatim.

## Deferred

- **`_lookup: "ed-token-position"` resolution at runtime** — the token:move handler in world-clock/map-service does not currently resolve `_lookup` values. For Sunday, Dave should manually move Gregor's token to Ed at 21:05, or the DM dashboard's NPC panel can be used. A proper lookup resolver is a Phase 2/3 follow-up.
- **~~`_deliveryMode: "private_to_ed_chromebook_with_english_to_dm_earbud"`~~** — **FIXED (Task 1, follow-up work order).** comm-router now recognizes `_deliveryMode: 'private*'` and `targetPlayer`. On a private delivery: normalizes to the existing `_private/_sourcePlayerId` contract, suppresses the `npc:approved` room-speaker dispatch, and whispers the `narratorTranslation` at priority 1 to the DM earbud. Verified by `scripts/test-gregor-slovak-routing.js` (7/7 assertions passing).
- **`gregor-death-or-stable` resolution** — the 21:12 event describes what should happen but the state machine resolving `state.npcs.patron-farmer.status` on healing events is not implemented. Dave flips the status manually via `/api/npcs/patron-farmer` or via the DM dashboard's NPC panel.

## Risk

Low. Additive fragment. Removing `04-gregor-deathbed.json` reverts to the existing (simpler) Gregor collapse event.
