# Build 2 — Character Data / DDB Sync

## How It Works

1. **`scripts/ddb-sync.mjs`** — run this on the VM (outside Docker) to fetch characters from D&D Beyond
2. Characters are saved as JSON to **`config/characters/{ddbId}.json`** — volume-mounted into container
3. **`services/characters/character-service.js`** — loads those files into game state on startup
4. Dashboard shows synced characters and lets you assign players → characters
5. No Docker rebuild needed after initial deploy — files are volume-mounted

---

## Step 1 — Get Your Cobalt Cookie

The Cobalt cookie is your D&D Beyond session token. DDB-Importer already has it.

**Find it from DDB-Importer:**
1. Open Foundry VTT in your browser → go to your world
2. Open the DDB-Importer module settings (the magic wand icon, or Compendium → DDB-Importer)
3. Find the **Cobalt Cookie** field — copy that entire value

**Alternative (from browser):**
1. Go to dndbeyond.com and log in
2. Open DevTools → Application → Cookies → dndbeyond.com
3. Find `CobaltSession` → copy the value

---

## Step 2 — Add to .env

```bash
nano ~/dark-pilgrimage/co-dm/.env
```

Add these lines:
```
COBALT_COOKIE=your-cobalt-value-here
DDB_CHARACTER_IDS=12345678,87654321
```

Replace `12345678` with your actual character IDs (from the DDB URL: `dndbeyond.com/characters/12345678`).

---

## Step 3 — Run the Sync Script

```bash
cd ~/dark-pilgrimage/co-dm

# Sync all IDs from DDB_CHARACTER_IDS in .env
node scripts/ddb-sync.mjs

# Or pass IDs directly
node scripts/ddb-sync.mjs 12345678 87654321
```

Expected output:
```
  ⛧  DDB Character Sync
  ══════════════════════

  → Fetching character 12345678...
  ✅ Aldric Thornwood (Human Fighter 3) → config/characters/12345678.json

  Done. 1 synced, 0 failed.
  Restart co-dm or hit /api/characters/reload to load new data.
```

---

## Step 4 — Restart the Service

```bash
sudo systemctl restart co-dm
journalctl -u co-dm -f
```

Or use the **⟳ Reload from Files** button in the dashboard (no restart needed).

---

## Step 5 — Assign Players in Dashboard

1. Open dashboard → right column → **Characters** panel
2. Players appear once they connect at `https://192.168.0.198:3202/player/{name}`
3. Use the dropdown to assign each player → their DDB character
4. Assignment is saved to `config/character-assignments.json` immediately

---

## Step 6 — Edit session-0.json (optional)

You can also hard-code assignments in `config/character-assignments.json`:
```json
{
  "player1": "12345678",
  "player2": "87654321"
}
```

The player URL slug (e.g., `player1` from `/player/player1`) is the key.

---

## Re-Syncing Characters

Run the sync script again any time a character changes on DDB:

```bash
node ~/dark-pilgrimage/co-dm/scripts/ddb-sync.mjs
```

Then click **⟳ Reload from Files** in the dashboard — no restart needed.

---

## Data Synced

| Field | Notes |
|-------|-------|
| Name, Race, Class, Level | Full class list with subclasses |
| HP (current/max/temp) | Tracks removed HP from DDB |
| AC | Computed from equipped armor + DEX |
| Speed | From race/class modifiers |
| Proficiency bonus | From total level |
| Ability scores + modifiers | STR DEX CON INT WIS CHA |
| Saving throws | With proficiency bonuses |
| Skills | All 18, with proficiency/expertise |
| Spell slots | By level, remaining vs total |
| Inventory | All items with equipped status |
| Languages | From race/background/feats |

---

## Troubleshooting

**`Auth failed (401)`** — Cobalt cookie expired. Refresh it from DDB-Importer or your browser.

**`Character not found (404)`** — Double-check the character ID from the DDB URL.

**Characters show in dashboard but player cards don't update** — Make sure player URL slugs match the assignment keys exactly (case-sensitive).
