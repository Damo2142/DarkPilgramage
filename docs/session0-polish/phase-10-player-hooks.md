# Phase 10 — Per-player campaign hooks

Implemented as fragment `config/session-0-fragments/10-player-hooks.json`.

## Status: SCAFFOLD — Dave review required

The work order referenced "hook specifications from an earlier overnight-prep message" that was not in this session's context. These hooks are AI-drafted scaffolds that fit each character's class/background/race and match the pattern Barry's existing hooks use. **Each hook has `scaffold: true`** so the DM/Dave knows they are draft.

## Per-player hooks added to `futureHooks`

- **Ed (Rogue, Halfling):**
  - `ed-underground-contact` — halfling fence in Spiš who owes a debt
  - `ed-slovak-loyalty` — Slovak-speaking favors vs Austrian clergy suspicion
- **Kim (Fighter EK, Mark of Detection Half-Elf):**
  - `kim-mark-of-detection-hunted` — formalizes the existing background threat
  - `kim-detect-magic-at-houska` — payoff at Houska
- **Jen (Barbarian, Firbolg):**
  - `jen-speech-of-beast-and-leaf` — extends existing hook through Houska/Čachtice
  - `jen-firbolg-ancestry` — grove refuge two weeks west
- **Nick (Bard Lore, Tiefling):**
  - `nick-bards-college-connections` — classmates at Houska + Čachtice
  - `nick-old-knowledge` — names the existing passive Max whisper pattern
- **Spurt (Sorcerer Wild Magic, Kobold, AI-controlled):**
  - `spurt-kobold-cavetalk` — extends vampire-scent + structural-danger sense
  - `spurt-wild-magic-regional-resonance` — suggested 1-in-10 surge chance for campaign

## Review checklist for Dave (pre-Sunday)

1. Open `config/session-0-fragments/10-player-hooks.json`
2. Read each hook
3. Edit, replace, or delete scaffold hooks as desired
4. Remove `scaffold: true` field on any hook Dave confirms
5. Add any specific hooks from the original overnight-prep message that aren't represented here

## Note on Barry

Barry's existing hooks in session-0.json are untouched — this fragment only adds new hooks, it doesn't modify Barry's. Jerome may still be absent (session-0 memory flagged him as "pending DDB import"), which is why Barry's arc was left untouched.
