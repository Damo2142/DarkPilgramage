# Architecture Decisions Log

One entry per decision. Newest at top. Include context, the decision, alternatives considered, and why.

---

## AD-001 — Aldous Kern already placed; no scene edit needed

**Date:** 2026-04-17 (Phase 0)
**Context:** The work order's Phase 0.3 instructs me to place `aldous-kern` on the ground-floor scene at approximately (1600, 1900). Upstream snapshot also listed him as "defined but not placed".
**Finding:** Aldous is already a token in `config/scenes/pallid-hart-ground.json` at position (3800, 1900) with publicName "The Quiet Man", nameRevealedToPlayers false, HP 8/8, AC 10. He is the 10th token in the scene. The earlier snapshot undercounted (claimed 9 tokens).
**Decision:** Do not modify the scene file. The existing placement is sensible (east side of common room near the door, away from other patrons). Re-placing him would change his position unnecessarily and could break continuity with whatever testing has already happened against that position.
**Alternatives considered:**
  - (a) Move him to (1600, 1900) per the work order. Rejected — that would overlap Henryk's area and change a position that's already been committed to the scene file. The work order says position is a suggestion ("verify no wall/token overlap; if that doesn't work, pick one that does").
  - (b) Leave the work order's intent intact by adjusting Aldous elsewhere. Rejected — no reason to.
**Follow-up:** Document in KNOWN-ISSUES.md that the earlier snapshot was off by one on token count.
