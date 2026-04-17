# BLOCKED — Phase 8: Spurt tactical hook

**Status:** deferred to follow-up session.

**Why blocked:** Phase 8 modifies `services/ai/spurt-agent.js` (629 LOC) — agent behavior code with careful context integration. The AI code paths are sensitive to the existing max-director / context-builder wiring and deserve focused attention, not a rushed mixed-commit.

## What the follow-up session needs to build

### 8.1 Formation-holding

In `spurt-agent.js` decision path, before picking a move target:
1. Compute all alive allies on the same map
2. Prefer a move target that ends adjacent to at least one non-caster ally
3. Penalize moves that strand Spurt alone

Implementation note: reuse `services/combat/npc-tactics.js#distanceFeet` — it's already exported for this purpose.

### 8.2 Never shoot into melee

When picking a ranged target:
- Check if the intended target has any non-self ally within 5ft
- If yes, drop that target and pick a different ranged target, or move first
- If no alternatives, spend turn moving to a position where the line-of-sight clears

### 8.3 Tactical target priority

Replace Spurt's existing target-scoring with INT-tier-aware scoring that matches the TACTICAL tier of `npc-tactics.js`:
1. Identify spellcasters (first priority)
2. Identify healers (second)
3. Identify archers in the back line (third)
4. Fall back to nearest melee engager

### 8.4 Cover use

Prefer end-of-turn positions adjacent to obstacles when possible. Reuse the cover computation from the deferred Phase 2 once it lands.

### 8.5 Verbal threat callouts

When Spurt's sensors detect a threat targeting a squishy ally (low HP or caster class), emit a chat dialogue line via the existing `chat:message` dispatch:

- "The one in the doorway is behind you!"
- "Watch the window — she's flanking you!"
- "They're going for <player name> — cover them!"

Fire at most once per 3 rounds to avoid chatter.

### 8.6 Retreat threshold

When Spurt's HP drops below 50%, check:
- Is there a safer position within movement range?
- If yes, retreat there and take the Dodge action.
- If no, fight defensively — pick the least-risky attack.

### 8.7 Kobold-bandit Henryk distrust

New event handler in spurt-agent for proximity to Henryk:
- When `distanceFeet(Spurt, Henryk) <= 10ft`:
  - 20% chance per 5-minute window: Henryk mutters about kobold bandits (public dialogue via `npc:scripted_speech`, German, Katya can translate)
  - If Spurt initiates conversation diplomatically (Dave's call via DM panel): 30% chance Henryk warms up, shares kobold folklore
  - If Spurt does anything mischievous near Henryk's goods: Henryk erupts (scripted escalation via existing social-combat service)

## Effort estimate

~2-3 hours. The agent code already exists; this is behavioral extension, not new architecture.

## Risk if not landed Sunday

Spurt still acts — his existing behavior from the pre-Phase-R build is intact. What's missed without Phase 8:
- Spurt may charge into melee and leave flanks exposed (same as the human players — so actually a consistent table dynamic, not a regression)
- No verbal warnings to the table ("watch the window!")
- No Henryk kobold-folklore color

None of these are session-blocking. They're flavor and model-good-play improvements.

## Note on the AI Spurt being "exemplar play"

The work-order intent was that Spurt visibly models good play as a contrast to Nick/Jen's chaos. Without Phase 8, Spurt's current behavior is closer to average. Dave may want to manually steer Spurt's actions via the DM panel for teaching moments until Phase 8 lands.
