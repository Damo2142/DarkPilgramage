#!/usr/bin/env node
/**
 * ddb-sync.mjs — Fetch character data from D&D Beyond and save to config/characters/
 *
 * Usage:
 *   node scripts/ddb-sync.mjs                    # sync all IDs in .env DDB_CHARACTER_IDS
 *   node scripts/ddb-sync.mjs 12345678           # sync one character by ID
 *   node scripts/ddb-sync.mjs 12345678 87654321  # sync multiple IDs
 *
 * Requires in .env:
 *   COBALT_COOKIE=your-cobalt-session-value
 *   DDB_CHARACTER_IDS=12345678,87654321   (optional — used when no IDs passed as args)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ── Load .env manually (no dotenv dependency) ────────────────────────────────
function loadEnv() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) process.env[key] = val;
  }
}
loadEnv();

// ── Config ────────────────────────────────────────────────────────────────────
const COBALT_COOKIE = process.env.COBALT_COOKIE || '';
const OUT_DIR = path.join(ROOT, 'config', 'characters');
const DDB_API = 'https://character-service.dndbeyond.com/character/v5/character';

// Character IDs: CLI args take priority, else DDB_CHARACTER_IDS env var
const argIds = process.argv.slice(2).filter(a => /^\d+$/.test(a));
const envIds = (process.env.DDB_CHARACTER_IDS || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const CHARACTER_IDS = argIds.length ? argIds : envIds;

// ── Ability score helpers ─────────────────────────────────────────────────────
const STAT_NAMES = { 1: 'str', 2: 'dex', 3: 'con', 4: 'int', 5: 'wis', 6: 'cha' };
const STAT_LABELS = { str: 'Strength', dex: 'Dexterity', con: 'Constitution',
                      int: 'Intelligence', wis: 'Wisdom', cha: 'Charisma' };

function abilityMod(score) { return Math.floor((score - 10) / 2); }
function modStr(mod) { return mod >= 0 ? `+${mod}` : `${mod}`; }

function mergeStats(base, bonus, override) {
  const result = {};
  for (const s of base) {
    const key = STAT_NAMES[s.id];
    if (!key) continue;
    const ov = override?.find(o => o.id === s.id);
    const bn = bonus?.find(b => b.id === s.id);
    result[key] = ov?.value ?? ((s.value ?? 10) + (bn?.value ?? 0));
  }
  return result;
}

function calcProfBonus(totalLevel) {
  return Math.ceil(totalLevel / 4) + 1;
}

// ── Map DDB proficiencies to saving throw proficiency flags ───────────────────
function getSaveProfs(modifiers) {
  const saves = { str: false, dex: false, con: false, int: false, wis: false, cha: false };
  const allMods = Object.values(modifiers || {}).flat();
  for (const m of allMods) {
    if (m.type === 'proficiency' && m.subType?.endsWith('-saving-throws')) {
      const key = m.subType.replace('-saving-throws', '');
      if (saves.hasOwnProperty(key)) saves[key] = true;
    }
  }
  return saves;
}

// ── Map DDB skill proficiencies ───────────────────────────────────────────────
const SKILL_MAP = {
  'acrobatics': 'dex', 'animal-handling': 'wis', 'arcana': 'int',
  'athletics': 'str', 'deception': 'cha', 'history': 'int',
  'insight': 'wis', 'intimidation': 'cha', 'investigation': 'int',
  'medicine': 'wis', 'nature': 'int', 'perception': 'wis',
  'performance': 'cha', 'persuasion': 'cha', 'religion': 'int',
  'sleight-of-hand': 'dex', 'stealth': 'dex', 'survival': 'wis'
};

function getSkillProfs(modifiers) {
  const skills = {};
  const allMods = Object.values(modifiers || {}).flat();
  for (const skillKey of Object.keys(SKILL_MAP)) {
    const hasProficiency = allMods.some(m =>
      m.type === 'proficiency' && m.subType === skillKey
    );
    const hasExpertise = allMods.some(m =>
      m.type === 'expertise' && m.subType === skillKey
    );
    skills[skillKey] = hasExpertise ? 'expertise' : hasProficiency ? 'proficiency' : 'none';
  }
  return skills;
}

// ── Compute AC (best-effort) ──────────────────────────────────────────────────
function computeAC(data, abilityScores) {
  // Check characterValues for manually set AC override
  const acOverride = data.characterValues?.find(v => v.typeId === 1);
  if (acOverride?.value) return acOverride.value;

  const dexMod = abilityMod(abilityScores.dex || 10);
  let baseAC = 10 + dexMod;

  // Check inventory for armor
  const equippedArmor = (data.inventory || []).find(item =>
    item.equipped && item.definition?.armorClass
  );
  if (equippedArmor) {
    const armorAC = equippedArmor.definition.armorClass;
    const armorType = equippedArmor.definition.type; // 'Light Armor', 'Medium Armor', 'Heavy Armor'
    if (armorType === 'Light Armor') baseAC = armorAC + dexMod;
    else if (armorType === 'Medium Armor') baseAC = armorAC + Math.min(dexMod, 2);
    else if (armorType === 'Heavy Armor') baseAC = armorAC;
    else baseAC = armorAC + dexMod; // shield/other
  }

  // Shield bonus
  const hasShield = (data.inventory || []).some(item =>
    item.equipped && item.definition?.armorClass && item.definition?.filterType === 'Armor' &&
    item.definition?.type === 'Shield'
  );
  if (hasShield) baseAC += 2;

  return baseAC;
}

// ── Spell slots ───────────────────────────────────────────────────────────────
// Full caster slot table, indexed [casterLevel][spellLevel-1]
const FULL_CASTER_SLOTS = {
  1: [2], 2: [3], 3: [4,2], 4: [4,3], 5: [4,3,2],
  6: [4,3,3], 7: [4,3,3,1], 8: [4,3,3,2], 9: [4,3,3,3,1], 10: [4,3,3,3,2],
  11: [4,3,3,3,2,1], 12: [4,3,3,3,2,1], 13: [4,3,3,3,2,1,1], 14: [4,3,3,3,2,1,1],
  15: [4,3,3,3,2,1,1,1], 16: [4,3,3,3,2,1,1,1], 17: [4,3,3,3,2,1,1,1,1],
  18: [4,3,3,3,3,1,1,1,1], 19: [4,3,3,3,3,2,1,1,1], 20: [4,3,3,3,3,2,2,1,1]
};
// Warlock pact magic: [slotCount, slotLevel]
const WARLOCK_SLOTS = {
  1: [1,1], 2: [2,1], 3: [2,2], 4: [2,2], 5: [2,3], 6: [2,3],
  7: [2,4], 8: [2,4], 9: [2,5], 10: [2,5], 11: [3,5], 12: [3,5],
  13: [3,5], 14: [3,5], 15: [3,5], 16: [3,5], 17: [4,5], 18: [4,5],
  19: [4,5], 20: [4,5]
};
const FULL_CASTERS = new Set(['Bard','Cleric','Druid','Sorcerer','Wizard']);
const HALF_CASTERS = new Set(['Paladin','Ranger','Artificer']);
const THIRD_CASTER_SUBS = new Set(['Eldritch Knight','Arcane Trickster']);

function computeCasterLevel(classes) {
  let full = 0, half = 0, third = 0;
  for (const c of classes || []) {
    const name = c.name || '';
    const sub = c.subclass || '';
    if (name === 'Warlock') continue; // handled separately
    if (FULL_CASTERS.has(name)) full += c.level;
    else if (HALF_CASTERS.has(name)) half += c.level;
    else if (THIRD_CASTER_SUBS.has(sub)) third += c.level;
  }
  // Multiclass formula (PHB 164): full + floor(half/2) + floor(third/3)
  return full + Math.floor(half/2) + Math.floor(third/3);
}

function computeSpellSlots(classes, usedMap = {}) {
  const slots = {};
  // Regular slots from full/half/third casters
  const casterLevel = computeCasterLevel(classes);
  if (casterLevel > 0) {
    const table = FULL_CASTER_SLOTS[casterLevel] || [];
    table.forEach((total, idx) => {
      const key = `level${idx+1}`;
      const used = Math.min(total, usedMap[key]?.used || 0);
      slots[key] = { total, used, remaining: total - used };
    });
  }
  // Warlock pact magic (separate slot pool)
  const warlock = (classes || []).find(c => c.name === 'Warlock');
  if (warlock && warlock.level > 0) {
    const [count, lvl] = WARLOCK_SLOTS[warlock.level] || [0,0];
    if (count > 0) {
      const key = `level${lvl}`;
      // If this level already has slots from other classes, add pact on top
      const existing = slots[key] || { total: 0, used: 0, remaining: 0 };
      const total = existing.total + count;
      const used = Math.min(total, usedMap[key]?.used || existing.used);
      slots[key] = { total, used, remaining: total - used };
    }
  }
  return Object.keys(slots).length ? slots : null;
}

function getSpellSlots(data, classes) {
  // Build used-map from DDB's current usage, if any
  const usedMap = {};
  for (const slot of (data.spellSlots || [])) {
    if (slot.used > 0) usedMap[`level${slot.level}`] = { used: slot.used };
  }
  for (const slot of (data.pactMagic || [])) {
    if (slot.used > 0) usedMap[`level${slot.level}`] = { used: slot.used };
  }
  return computeSpellSlots(classes, usedMap);
}

// ── Map inventory ─────────────────────────────────────────────────────────────
function mapInventory(inventory) {
  return (inventory || []).map(item => ({
    name: item.definition?.name || 'Unknown',
    quantity: item.quantity || 1,
    equipped: item.equipped || false,
    type: item.definition?.filterType || item.definition?.type || 'Item',
    weight: item.definition?.weight || 0
  }));
}

// ── Main mapper: DDB JSON → Co-DM character schema ───────────────────────────
function mapCharacter(ddbData, ddbId) {
  const d = ddbData;

  // Class(es)
  const classes = (d.classes || []).map(c => ({
    name: c.definition?.name || 'Unknown',
    level: c.level || 1,
    subclass: c.subclassDefinition?.name || null
  }));
  const totalLevel = classes.reduce((sum, c) => sum + c.level, 0);
  const primaryClass = classes[0]?.name || 'Adventurer';

  // Ability scores
  const abilityScores = mergeStats(d.stats || [], d.bonusStats || [], d.overrideStats || []);

  // HP
  const maxHp = d.baseHitPoints || 10;
  const removed = d.removedHitPoints || 0;
  const tempHp = d.temporaryHitPoints || 0;
  const currentHp = Math.max(0, maxHp - removed);

  // Proficiency
  const profBonus = calcProfBonus(totalLevel);

  // Speed (base 30, check racial/class modifiers)
  const speedMod = (Object.values(d.modifiers || {}).flat()).find(
    m => m.type === 'set' && m.subType === 'speed'
  );
  const speed = speedMod?.value || d.race?.weightSpeeds?.normal || 30;

  // Saving throws
  const saveProfs = getSaveProfs(d.modifiers);
  const savingThrows = {};
  for (const [key, label] of Object.entries(STAT_LABELS)) {
    const abbr = key.toLowerCase().slice(0, 3);
    const mod = abilityMod(abilityScores[abbr] || 10);
    const isProficient = saveProfs[abbr];
    savingThrows[abbr] = {
      modifier: mod + (isProficient ? profBonus : 0),
      proficient: isProficient
    };
  }

  // Skills
  const skillProfs = getSkillProfs(d.modifiers);
  const skills = {};
  for (const [skillKey, statKey] of Object.entries(SKILL_MAP)) {
    const mod = abilityMod(abilityScores[statKey] || 10);
    const prof = skillProfs[skillKey];
    const bonus = prof === 'expertise' ? profBonus * 2 : prof === 'proficiency' ? profBonus : 0;
    skills[skillKey] = { modifier: mod + bonus, proficiency: prof };
  }

  // Ability score objects (score + modifier)
  const abilities = {};
  for (const [key] of Object.entries(STAT_LABELS)) {
    const abbr = key.toLowerCase().slice(0, 3);
    const score = abilityScores[abbr] || 10;
    abilities[abbr] = { score, modifier: abilityMod(score), modifierStr: modStr(abilityMod(score)) };
  }

  // AC
  const ac = computeAC(d, abilityScores);

  // Spell slots
  const spellSlots = getSpellSlots(d, classes);

  // Backstory, traits, appearance, allies
  const traits = d.traits || {};
  const notes = d.notes || {};

  const backstory = {
    personalityTraits: traits.personalityTraits || null,
    ideals: traits.ideals || null,
    bonds: traits.bonds || null,
    flaws: traits.flaws || null,
    backstoryText: notes.backstory || d.backstory || null,
    allies: notes.allies || null,
    organizations: notes.organizations || null,
    enemies: notes.enemies || null,
    otherNotes: notes.otherNotes || null
  };

  const appearance = {
    gender: d.gender || null,
    age: d.age || null,
    height: d.height || null,
    weight: d.weight || null,
    size: d.race?.size || null,
    eyes: d.eyes || null,
    hair: d.hair || null,
    skin: d.skin || null,
    faith: d.faith || null,
    description: traits.appearance || null
  };

  const patron = classes.map(c => c.subclass).filter(Boolean).join(', ') || null;

  return {
    ddbId: ddbId,
    name: d.name || 'Unknown',
    class: primaryClass,
    classes,
    level: totalLevel,
    race: d.race?.fullName || d.race?.baseRaceName || 'Unknown',
    background: d.background?.definition?.name || null,
    alignment: d.alignmentId ? alignmentName(d.alignmentId) : null,
    hp: { current: currentHp, max: maxHp, temp: tempHp },
    ac,
    speed,
    proficiencyBonus: profBonus,
    abilities,
    savingThrows,
    skills,
    spellSlots,
    inventory: mapInventory(d.inventory),
    conditions: [],
    languages: (d.modifiers?.language || []).map(m => m.friendlySubtypeName).filter(Boolean),
    backstory,
    appearance,
    patron,
    _syncedAt: new Date().toISOString(),
    _ddbUrl: `https://www.dndbeyond.com/characters/${ddbId}`
  };
}

function alignmentName(id) {
  const alignments = {1:'LG',2:'NG',3:'CG',4:'LN',5:'TN',6:'CN',7:'LE',8:'NE',9:'CE'};
  return alignments[id] || null;
}

// ── Fetch one character from DDB ──────────────────────────────────────────────
async function fetchCharacter(id) {
  console.log(`  → Fetching character ${id}...`);
  const url = `${DDB_API}/${id}`;

  const res = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${COBALT_COOKIE}`,
      'Cookie': `CobaltSession=${COBALT_COOKIE}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Origin': 'https://www.dndbeyond.com',
      'Referer': 'https://www.dndbeyond.com/'
    }
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(`  [Debug] Status: ${res.status}`);
    console.error(`  [Debug] Response: ${body.slice(0, 500)}`);
    if (res.status === 401 || res.status === 403) {
      throw new Error(`Auth failed (${res.status}) — check COBALT_COOKIE in .env`);
    }
    if (res.status === 404) {
      throw new Error(`Character ${id} not found on DDB — check the ID`);
    }
    throw new Error(`DDB API returned ${res.status} for character ${id}`);
  }

  const json = await res.json();
  if (!json.data) throw new Error(`Unexpected DDB response format for character ${id}`);
  return json.data;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('');
  console.log('  ⛧  DDB Character Sync');
  console.log('  ══════════════════════');
  console.log('');

  if (!COBALT_COOKIE) {
    console.error('❌ COBALT_COOKIE is not set in .env');
    console.error('   See README for how to extract it from DDB-Importer.');
    process.exit(1);
  }

  if (!CHARACTER_IDS.length) {
    console.error('❌ No character IDs provided.');
    console.error('   Usage: node scripts/ddb-sync.mjs 12345678');
    console.error('   Or set DDB_CHARACTER_IDS=12345678,87654321 in .env');
    process.exit(1);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  let success = 0, failed = 0;

  for (const id of CHARACTER_IDS) {
    try {
      const ddbData = await fetchCharacter(id);
      const character = mapCharacter(ddbData, id);
      const outPath = path.join(OUT_DIR, `${id}.json`);
      fs.writeFileSync(outPath, JSON.stringify(character, null, 2));
      console.log(`  ✅ ${character.name} (${character.race} ${character.class} ${character.level}) → config/characters/${id}.json`);
      success++;
    } catch (err) {
      console.error(`  ❌ Character ${id}: ${err.message}`);
      failed++;
    }
  }

  console.log('');
  console.log(`  Done. ${success} synced, ${failed} failed.`);
  if (success > 0) {
    console.log(`  Restart co-dm or hit /api/characters/reload to load new data.`);
  }
  console.log('');
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
