# Known Issues — Session 0 Polish

Issues discovered during this build. Each entry: what, where, severity, disposition (fixed in this branch / deferred / left for Dave).

---

## KI-001 — Snapshot undercounted ground-floor scene tokens

**Severity:** info
**Where:** `CURRENT-STATE-SNAPSHOT.md` section 3 (NPC list), says "9 tokens" for pallid-hart-ground scene
**Actual:** 10 tokens — Aldous Kern is present at (3800, 1900) with publicName "The Quiet Man"
**Disposition:** Left. The snapshot is a read-only historical photograph. The scene itself is correct.
