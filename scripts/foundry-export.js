/**
 * dark-pilgrimage — Character Export to Co-DM
 * Add this to the existing dark-pilgrimage Foundry module.
 * 
 * Place at: ~/foundry-data/Data/modules/dark-pilgrimage/character-export.js
 * Then add a <script> reference to it in module.json scripts array.
 *
 * Adds a "Export to Co-DM" button to the Actors sidebar header.
 * Clicking it pushes all PC actors to Co-DM via POST /api/characters/import
 */

const CODM_URL = 'https://192.168.0.198:3200/api/characters/import';

// ── Map Foundry dnd5e actor to Co-DM character schema ────────────────────────
function mapActor(actor) {
  const sys = actor.system;
  const attrs = sys.attributes || {};
  const abils = sys.abilities || {};

  // Classes
  const classItems = actor.items.filter(i => i.type === 'class');
  const totalLevel = classItems.reduce((s, c) => s + (c.system?.levels || 1), 0) || 1;
  const primaryClass = classItems[0]?.name || 'Adventurer';
  const subclassItem = actor.items.find(i => i.type === 'subclass');
  const profBonus = attrs.prof || Math.ceil(totalLevel / 4) + 1;

  // HP
  const hp = attrs.hp || {};
  const maxHp = hp.max || 10;
  const currentHp = Math.max(0, maxHp - (hp.damage || 0));

  // Abilities
  const abilities = {};
  for (const [key, data] of Object.entries(abils)) {
    const score = data.value || 10;
    const mod = Math.floor((score - 10) / 2);
    abilities[key] = { score, modifier: mod, modifierStr: mod >= 0 ? `+${mod}` : `${mod}` };
  }

  // Saving throws
  const savingThrows = {};
  for (const [key, data] of Object.entries(abils)) {
    const mod = Math.floor(((data.value || 10) - 10) / 2);
    const isProficient = data.proficient === 1;
    savingThrows[key] = { modifier: mod + (isProficient ? profBonus : 0), proficient: isProficient };
  }

  // Skills
  const SKILL_ABILITY = {
    acr:'dex', ani:'wis', arc:'int', ath:'str', dec:'cha', his:'int',
    ins:'wis', itm:'cha', inv:'int', med:'wis', nat:'int', prc:'wis',
    prf:'cha', per:'cha', rel:'int', slt:'dex', ste:'dex', sur:'wis'
  };
  const SKILL_NAMES = {
    acr:'acrobatics', ani:'animal-handling', arc:'arcana', ath:'athletics',
    dec:'deception', his:'history', ins:'insight', itm:'intimidation',
    inv:'investigation', med:'medicine', nat:'nature', prc:'perception',
    prf:'performance', per:'persuasion', rel:'religion', slt:'sleight-of-hand',
    ste:'stealth', sur:'survival'
  };
  const skills = {};
  for (const [abbr, fullName] of Object.entries(SKILL_NAMES)) {
    const statKey = SKILL_ABILITY[abbr];
    const statMod = Math.floor(((abils[statKey]?.value || 10) - 10) / 2);
    const val = sys.skills?.[abbr]?.value || 0;
    const bonus = val === 2 ? profBonus * 2 : val === 1 ? profBonus : 0;
    skills[fullName] = {
      modifier: statMod + bonus,
      proficiency: val === 2 ? 'expertise' : val === 1 ? 'proficiency' : 'none'
    };
  }

  // Spell slots
  const spellSlots = {};
  for (let i = 1; i <= 9; i++) {
    const slot = attrs.spells?.[`spell${i}`];
    if (slot?.max > 0) {
      spellSlots[`level${i}`] = { total: slot.max, used: slot.max - (slot.value ?? slot.max), remaining: slot.value ?? slot.max };
    }
  }

  // Inventory
  const invTypes = ['weapon','equipment','consumable','tool','container','loot'];
  const inventory = actor.items
    .filter(i => invTypes.includes(i.type))
    .map(i => ({ name: i.name, quantity: i.system?.quantity || 1, equipped: i.system?.equipped || false, type: i.type }));

  const raceItem = actor.items.find(i => i.type === 'race');
  const bgItem = actor.items.find(i => i.type === 'background');

  return {
    foundryId: actor.id,
    name: actor.name,
    class: primaryClass,
    classes: classItems.map(c => ({ name: c.name, level: c.system?.levels || 1, subclass: subclassItem?.name || null })),
    level: totalLevel,
    race: raceItem?.name || sys.details?.race || 'Unknown',
    background: bgItem?.name || null,
    hp: { current: currentHp, max: maxHp, temp: hp.temp || 0 },
    ac: attrs.ac?.value || 10,
    speed: attrs.movement?.walk || 30,
    proficiencyBonus: profBonus,
    abilities,
    savingThrows,
    skills,
    spellSlots: Object.keys(spellSlots).length ? spellSlots : null,
    inventory,
    conditions: [],
    currency: sys.currency || {},
    _syncedAt: new Date().toISOString(),
    _source: 'foundry-live'
  };
}

// ── Push all PCs to Co-DM ─────────────────────────────────────────────────────
async function exportCharacters() {
  const pcs = game.actors.filter(a => a.type === 'character');
  if (!pcs.length) {
    ui.notifications.warn('No PC actors found in this world.');
    return;
  }

  const characters = pcs.map(mapActor);
  ui.notifications.info(`Exporting ${characters.length} character(s) to Co-DM...`);

  try {
    const res = await fetch(CODM_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ characters }),
      // Self-signed cert — ignore SSL errors in Foundry context
    });

    if (!res.ok) throw new Error(`Co-DM responded ${res.status}`);
    const data = await res.json();
    ui.notifications.info(`✓ Exported to Co-DM: ${data.saved} character(s) saved.`);
    console.log('[Dark Pilgrimage] Character export:', data);
  } catch (err) {
    ui.notifications.error(`Export failed: ${err.message}`);
    console.error('[Dark Pilgrimage] Export error:', err);
  }
}

// ── Add button to Actors sidebar ──────────────────────────────────────────────
Hooks.on('renderActorDirectory', (app, html, data) => {
  const btn = $(`
    <button class="dp-export-btn" title="Export PCs to Co-DM" style="
      margin: 4px 8px;
      width: calc(100% - 16px);
      background: #1a1a22;
      border: 1px solid #8a7030;
      color: #c9a54e;
      font-size: 11px;
      padding: 4px 8px;
      cursor: pointer;
      border-radius: 3px;
    ">
      ⛧ Export Characters → Co-DM
    </button>
  `);
  btn.on('click', exportCharacters);
  html.find('.directory-header').after(btn);
});

// Also register as a macro so it can be called from a hotbar macro
Hooks.once('ready', () => {
  window.DarkPilgrimage = window.DarkPilgrimage || {};
  window.DarkPilgrimage.exportCharacters = exportCharacters;
  console.log('[Dark Pilgrimage] Character export ready. Call DarkPilgrimage.exportCharacters() from console or macro.');
});
