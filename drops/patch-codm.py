#!/usr/bin/env python3
"""
Patch script for dashboard and player bridge.
Run: python3 /tmp/patch-codm.py
"""
import re, os

DASHBOARD = os.path.expanduser("~/dark-pilgrimage/co-dm/services/dashboard/public/index.html")
PLAYER_BRIDGE = os.path.expanduser("~/dark-pilgrimage/co-dm/services/player-bridge/player-bridge-service.js")

# ─── PATCH 1: Player Bridge — HP fires state:change ──────────────────────────
print("Patching player bridge HP handler...")
with open(PLAYER_BRIDGE) as f:
    pb = f.read()

old_hp = """      case 'action:hp':
        const current = this.state.get(`players.${playerId}.character.hp.current`) || 0;
        this.state.set(`players.${playerId}.character.hp.current`, Math.max(0, current + msg.delta));
        break;"""

new_hp = """      case 'action:hp': {
        const hpPath = `players.${playerId}.character.hp.current`;
        const hpMax  = `players.${playerId}.character.hp.max`;
        const cur    = this.state.get(hpPath) || 0;
        const max    = this.state.get(hpMax)  || 10;
        const newHp  = Math.max(0, Math.min(max, cur + msg.delta));
        this.state.set(hpPath, newHp);
        this.bus.dispatch('state:change', { path: hpPath, value: newHp });
        console.log(`[PlayerBridge] ${playerId} HP: ${cur} -> ${newHp}`);
        break;
      }"""

if old_hp in pb:
    pb = pb.replace(old_hp, new_hp)
    print("  ✓ HP handler patched")
else:
    print("  ! HP handler not found - may already be patched")

with open(PLAYER_BRIDGE, 'w') as f:
    f.write(pb)

# ─── PATCH 2: Dashboard — fix foundryId, add sheet modal ─────────────────────
print("Patching dashboard...")
with open(DASHBOARD) as f:
    dash = f.read()

# Fix foundryId references  
dash = dash.replace("c.ddbId", "c.foundryId || c.ddbId")
print("  ✓ foundryId references fixed")

# Fix char options to use foundryId as value
old_char_opts = """    const charOptions = Object.values(availableChars).map(c =>
      `<option value="${c.ddbId}">${esc(c.name)} (${esc(c.class)} ${c.level})</option>`
    ).join('');"""
new_char_opts = """    const charOptions = Object.values(availableChars).map(c => {
      const cid = c.foundryId || c.ddbId;
      return `<option value="${cid}">${esc(c.name)} (${esc(c.class)} ${c.level})</option>`;
    }).join('');"""
if old_char_opts in dash:
    dash = dash.replace(old_char_opts, new_char_opts)
    print("  ✓ char options fixed")

# Add sheet modal CSS before /* Scrollbar */
sheet_css = """    /* Player sheet modal */
    .sheet-modal { display:none; position:fixed; inset:0; background:rgba(0,0,0,0.88); z-index:500; overflow-y:auto; padding:20px; }
    .sheet-modal.open { display:block; }
    .sheet-inner { max-width:700px; margin:0 auto; background:var(--surface); border:1px solid var(--border); border-radius:6px; padding:20px; }
    .sheet-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:8px; margin:10px 0; }
    .sheet-stat { background:var(--surface2); border-radius:4px; padding:8px; text-align:center; }
    .sheet-stat .label { font-size:9px; color:var(--text-dim); text-transform:uppercase; }
    .sheet-stat .value { font-size:20px; font-weight:700; color:var(--accent); }
    .sheet-stat .mod { font-size:12px; color:var(--text-dim); }
    .sheet-row { display:flex; justify-content:space-between; padding:3px 0; font-size:11px; border-bottom:1px solid var(--bg); }
    .sheet-section { font-size:10px; font-weight:700; text-transform:uppercase; color:var(--text-dim); margin:10px 0 4px; letter-spacing:1px; }

    /* Scrollbar */"""

if "    /* Scrollbar */" in dash and ".sheet-modal" not in dash:
    dash = dash.replace("    /* Scrollbar */", sheet_css)
    print("  ✓ sheet modal CSS added")

# Add sheet button to player card
old_dread_div = '<div class="dread-controls">'
new_dread_div = """<div style="margin-top:4px;"><button class="sm ghost" onclick="viewSheet(\'${id}\')">📋 Sheet</button></div>
        <div class="dread-controls">"""
# Use a safer approach with a marker
if 'viewSheet' not in dash:
    # Find the dread-controls div inside renderPlayers template literal
    dash = dash.replace(
        "        <div class=\"dread-controls\">",
        "        <div style=\"margin-top:4px;\"><button class=\"sm ghost\" onclick=\"viewSheet('${id}')\" >📋 Sheet</button></div>\n        <div class=\"dread-controls\">",
        1
    )
    print("  ✓ sheet button added to player card")

# Add viewSheet function before connect()
view_sheet_fn = """
  // === PLAYER SHEET MODAL ===
  function viewSheet(playerId) {
    const p = state.players && state.players[playerId];
    const c = p && p.character;
    if (!c) { alert('No character data for ' + playerId); return; }

    let modal = document.getElementById('sheet-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'sheet-modal';
      modal.className = 'sheet-modal';
      modal.addEventListener('click', function(e) { if (e.target === modal) modal.classList.remove('open'); });
      document.body.appendChild(modal);
    }

    const abils = c.abilities || {};
    const abilHtml = Object.entries(abils).map(function(entry) {
      const k = entry[0], v = entry[1];
      return '<div class="sheet-stat"><div class="label">' + k.toUpperCase() + '</div><div class="value">' + (v.score||10) + '</div><div class="mod">' + (v.modifierStr||0) + '</div></div>';
    }).join('');

    const saveHtml = Object.entries(c.savingThrows||{}).map(function(entry) {
      const k = entry[0], v = entry[1];
      const mod = typeof v === 'object' ? v.modifier : v;
      const prof = (typeof v === 'object' && v.proficient) ? ' ●' : '';
      return '<div class="sheet-row"><span>' + k.toUpperCase() + prof + '</span><span>' + (mod >= 0 ? '+'+mod : mod) + '</span></div>';
    }).join('');

    const skillHtml = Object.entries(c.skills||{}).map(function(entry) {
      const k = entry[0], v = entry[1];
      const mod = typeof v === 'object' ? v.modifier : v;
      const prof = typeof v === 'object' ? (v.proficiency === 'expertise' ? ' ◆' : v.proficiency === 'proficiency' ? ' ●' : '') : '';
      return '<div class="sheet-row"><span>' + k + prof + '</span><span>' + (mod >= 0 ? '+'+mod : mod) + '</span></div>';
    }).join('');

    const invHtml = (c.inventory||[]).map(function(i) {
      return '<div class="sheet-row"><span>' + esc(i.name) + '</span><span>x' + (i.quantity||1) + '</span></div>';
    }).join('');

    const slotHtml = c.spellSlots ? Object.entries(c.spellSlots).map(function(entry) {
      const l = entry[0], s = entry[1];
      return '<div class="sheet-row"><span>' + l + '</span><span>' + s.remaining + '/' + s.total + '</span></div>';
    }).join('') : '<div style="color:var(--text-dim);font-size:11px;">No spell slots</div>';

    const hp = c.hp || {};
    modal.innerHTML = '<div class="sheet-inner">'
      + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">'
      + '<h2 style="font-family:Cinzel,serif;color:var(--accent)">' + esc(c.name||playerId) + '</h2>'
      + '<button onclick="document.getElementById('sheet-modal').classList.remove('open')">✕ Close</button></div>'
      + '<div style="font-size:11px;color:var(--text-dim);margin-bottom:12px;">'
      + esc(c.race||'') + ' ' + esc(c.class||'') + ' ' + (c.level||'')
      + ' · HP ' + (hp.current||0) + '/' + (hp.max||0)
      + ' · AC ' + (c.ac||10)
      + ' · Speed ' + (c.speed||30) + 'ft'
      + ' · Prof +' + (c.proficiencyBonus||2) + '</div>'
      + '<div class="sheet-section">Ability Scores</div><div class="sheet-grid">' + abilHtml + '</div>'
      + '<div class="sheet-section">Saving Throws</div>' + saveHtml
      + '<div class="sheet-section">Skills</div>' + skillHtml
      + '<div class="sheet-section">Spell Slots</div>' + slotHtml
      + '<div class="sheet-section">Inventory</div>' + invHtml
      + '</div>';

    modal.classList.add('open');
  }

  connect();"""

if "viewSheet" not in dash:
    dash = dash.replace("  connect();", view_sheet_fn)
    print("  ✓ viewSheet function added")
else:
    print("  ! viewSheet already present")

with open(DASHBOARD, 'w') as f:
    f.write(dash)

print("\nDashboard patched. Verify:")
print("  grep -n viewSheet ~/dark-pilgrimage/co-dm/services/dashboard/public/index.html | head -5")
