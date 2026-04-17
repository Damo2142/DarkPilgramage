# Phase 5 — Vladislav enhancements

Implemented as fragment `config/session-0-fragments/05-vladislav.json`. Data-only — no service code changes.

## What's in the fragment

### `npcs.hooded-stranger._phase5_additions.awarenessPhases`
Seven-state state machine: `neutral → unease → sharpened_unease → window_watch → recognition → calculating → reactive → departure`. Timed transitions as documented in the work order. Consumed by Dave / the AI when generating Vladislav's dialogue — when context-builder assembles Vladislav's context, it can read his current awareness phase and tone his dialogue accordingly.

### `npcs.hooded-stranger._phase5_additions.demoStateMachine`
Three-stage power demo (attacks, crush blade, Frightful Presence + mist-reform). State lives at `state.npcs.hooded-stranger.demo_stage`. **Not yet wired into combat-service** — the stages trigger on attacks, which means combat-service would need to check Vladislav's demo_stage before processing damage. For Saturday test, Dave runs the demo manually via DM panel.

### `npcs.hooded-stranger._phase5_additions.matthiasRelationship`
Duplicates Phase 7's data — both fragments contain it. Since they're identical, alphabetical-last-wins is a no-op.

## New timed events

| Time | ID | Conditional on |
|---|---|---|
| 21:55 | `vladislav-breadcrumb-if-needed` | `state.flags.tomas_threat_identified !== true` — hints Tomas is the werewolf 5 min before transform |
| 22:00 | `vladislav-counter-whisper-to-ed` | `state.flags.ed_has_been_whispered_by_dominik === true` — private Common whisper: "The monk is not what he seems. Neither am I..." |
| 22:05 | `vladislav-search-the-body` | `state.npcs.brother-dominik-novak.status === 'dead'` (oneShot) — Vlad names that there's a second spawn |
| 06:00 | `vladislav-dawn-speech` | Vlad alive + party alive + not enemies — full speech reveal of Matthias + abbey password + "try not to die" |

## Slovak phonetics

The fragment includes a `slovakPhonetics` block with 4 transliterated phrases for Dave to deliver at the table:
- *Odpočívaj v pokoji* ("od-po-CHEE-vai f po-KO-yee")
- *Prenesiem odkaz* ("pre-ne-SEE-em od-kaz")
- *Starec, priest ti to zveril?* ("STA-rets, pree-est tee to ZVE-ril")
- *Vladislav povedal, že jeho modlitby stále fungujú* ("VLA-dis-laff PO-ve-dal zhe YE-ho MOD-lit-bi STA-le FUN-goo-yoo")

Dave can surface these in the dashboard's Tools tab or keep a printed cue-sheet at the table.

## Deferred

- **Demo state machine wiring** — combat-service hooks into Vlad's demo_stage field. Needs a combat-service check in `processAttack` that short-circuits damage on demo_stage 0-2 and routes to scripted narrative responses. Phase 6 or later code-only work.
- **`checkFlag` free-form-JS evaluation** — same deferral as Phase 3. Dave manually gates the conditional whispers on Saturday test.
- **State-based awareness phase transitions** — the phase schedule in the fragment is descriptive only. A phase-advance handler that flips `state.npcs.hooded-stranger.awareness_phase` on the time schedule + on bus events (like Dominik recognition at 21:15) is a next-session item.
