/**
 * character-service.js
 * Supports both foundryId (Foundry export) and ddbId (DDB sync) as keys.
 * DDB sync: pull characters from D&D Beyond, push HP/slots back.
 */

const fs = require('fs');
const path = require('path');

// ── DDB constants ──
const DDB_API = 'https://character-service.dndbeyond.com/character/v5/character';
const STAT_NAMES = { 1: 'str', 2: 'dex', 3: 'con', 4: 'int', 5: 'wis', 6: 'cha' };
const STAT_LABELS = { str: 'Strength', dex: 'Dexterity', con: 'Constitution',
                      int: 'Intelligence', wis: 'Wisdom', cha: 'Charisma' };
const SKILL_MAP = {
  'acrobatics': 'dex', 'animal-handling': 'wis', 'arcana': 'int',
  'athletics': 'str', 'deception': 'cha', 'history': 'int',
  'insight': 'wis', 'intimidation': 'cha', 'investigation': 'int',
  'medicine': 'wis', 'nature': 'int', 'perception': 'wis',
  'performance': 'cha', 'persuasion': 'cha', 'religion': 'int',
  'sleight-of-hand': 'dex', 'stealth': 'dex', 'survival': 'wis'
};
const ALIGNMENTS = {1:'LG',2:'NG',3:'CG',4:'LN',5:'TN',6:'CN',7:'LE',8:'NE',9:'CE'};

function abilityMod(score) { return Math.floor((score - 10) / 2); }
function modStr(mod) { return mod >= 0 ? '+' + mod : '' + mod; }

class CharacterService {
  constructor() {
    this.name = 'characters';
    this.orchestrator = null;
    this.charactersDir = null;
    this.assignmentsPath = null;
    this._ddbConfigPath = null;
    this._lastSync = null;
  }

  async init(orchestrator) {
    this.orchestrator = orchestrator;
    this.bus = orchestrator.bus;
    this.state = orchestrator.state;
    this.config = orchestrator.config;
    const configDir = path.resolve(this.config.configDir || './config');
    this.charactersDir = path.join(configDir, 'characters');
    this.assignmentsPath = path.join(configDir, 'character-assignments.json');
    this._ddbConfigPath = path.join(configDir, 'ddb-config.json');
    fs.mkdirSync(this.charactersDir, { recursive: true });
  }

  async start() {
    const loaded = this._loadAll();
    console.log('[Characters] Loaded ' + loaded + ' character(s) into game state');
    // Auto-sync from DDB if configured
    const ddbConf = this._readDdbConfig();
    if (ddbConf.characterIds && ddbConf.characterIds.length && process.env.COBALT_COOKIE) {
      console.log('[Characters] Auto-syncing ' + ddbConf.characterIds.length + ' character(s) from D&D Beyond...');
      this.ddbSyncAll().catch(e => console.warn('[Characters] Auto-sync failed:', e.message));
    }
  }

  async stop() {}

  _loadAll() {
    const characters = this._readCharacterFiles();
    const assignments = this._readAssignments();
    let count = 0;
    for (const [playerId, charId] of Object.entries(assignments)) {
      if (playerId.startsWith('_')) continue;
      const char = characters[String(charId)];
      if (!char) {
        console.warn('[Characters] Assignment: player \'' + playerId + '\' -> ID ' + charId + ' not found');
        continue;
      }
      this.state.setPlayer(playerId, { name: playerId, character: char });
      console.log('[Characters] -> ' + playerId + ': ' + char.name + ' (' + char.race + ' ' + char.class + ' ' + char.level + ')');
      count++;
    }
    this.state.set('characters.available', characters);
    return count;
  }

  _readCharacterFiles() {
    const chars = {};
    if (!fs.existsSync(this.charactersDir)) return chars;
    for (const file of fs.readdirSync(this.charactersDir)) {
      if (!file.endsWith('.json')) continue;
      try {
        const data = JSON.parse(fs.readFileSync(path.join(this.charactersDir, file), 'utf8'));
        const id = data.foundryId || data.ddbId || path.basename(file, '.json');
        chars[String(id)] = data;
      } catch (err) {
        console.warn('[Characters] Failed to parse ' + file + ': ' + err.message);
      }
    }
    return chars;
  }

  _readAssignments() {
    if (!fs.existsSync(this.assignmentsPath)) return {};
    try {
      const raw = JSON.parse(fs.readFileSync(this.assignmentsPath, 'utf8'));
      const clean = {};
      for (const [k, v] of Object.entries(raw)) {
        if (!k.startsWith('_')) clean[k] = v;
      }
      return clean;
    } catch (err) {
      console.warn('[Characters] Could not read assignments: ' + err.message);
      return {};
    }
  }

  reload() {
    const loaded = this._loadAll();
    this.bus.dispatch('characters:reloaded', { count: loaded });
    return loaded;
  }

  saveCharacter(id, data) {
    const outPath = path.join(this.charactersDir, id + '.json');
    data._syncedAt = new Date().toISOString();
    fs.writeFileSync(outPath, JSON.stringify(data, null, 2));
    console.log('[Characters] Saved ' + data.name + ' -> config/characters/' + id + '.json');
  }

  deleteCharacter(id) {
    const filePath = path.join(this.charactersDir, id + '.json');
    if (!fs.existsSync(filePath)) return false;
    fs.unlinkSync(filePath);
    // Remove from any assignments
    const assignments = this._readAssignments();
    for (const [pid, cid] of Object.entries(assignments)) {
      if (cid === id) { delete assignments[pid]; }
    }
    fs.writeFileSync(this.assignmentsPath, JSON.stringify(assignments, null, 2));
    // Remove from state
    const players = this.state.get('players') || {};
    for (const [pid, pdata] of Object.entries(players)) {
      if (pdata && pdata.character && (pdata.character.ddbId === id || pdata.character.foundryId === id)) {
        delete pdata.character;
        this.state.set('players.' + pid, pdata);
      }
    }
    this.reload();
    console.log('[Characters] Deleted character: ' + id);
    return true;
  }

  getAssignments() { return this._readAssignments(); }

  getCharacter(id) {
    const chars = this._readCharacterFiles();
    return chars[String(id)] || null;
  }

  assign(playerId, charId) {
    const assignments = this._readAssignments();
    assignments[playerId] = String(charId);
    fs.writeFileSync(this.assignmentsPath, JSON.stringify(assignments, null, 2));
    this.reload();
    return assignments;
  }

  unassign(playerId) {
    const assignments = this._readAssignments();
    delete assignments[playerId];
    fs.writeFileSync(this.assignmentsPath, JSON.stringify(assignments, null, 2));
    this.reload();
    return assignments;
  }

  addPlayer(playerId) {
    const assignments = this._readAssignments();
    if (!assignments[playerId]) {
      assignments[playerId] = null;
      fs.writeFileSync(this.assignmentsPath, JSON.stringify(assignments, null, 2));
    }
    return assignments;
  }

  removePlayer(playerId) {
    return this.unassign(playerId);
  }

  getStatus() {
    const chars = this._readCharacterFiles();
    const assignments = this._readAssignments();
    return {
      name: this.name,
      status: 'running',
      charactersLoaded: Object.keys(chars).length,
      characters: Object.values(chars).map(c => ({
        foundryId: c.foundryId,
        ddbId: c.ddbId,
        name: c.name,
        class: c.class,
        level: c.level,
        race: c.race,
        syncedAt: c._syncedAt
      })),
      assignments,
      ddbConfig: this._readDdbConfig(),
      lastSync: this._lastSync
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // DDB SYNC — Pull from D&D Beyond
  // ══════════════════════════════════════════════════════════════════════════

  _readDdbConfig() {
    if (!fs.existsSync(this._ddbConfigPath)) return { characterIds: [] };
    try { return JSON.parse(fs.readFileSync(this._ddbConfigPath, 'utf8')); }
    catch (e) { return { characterIds: [] }; }
  }

  saveDdbConfig(config) {
    fs.writeFileSync(this._ddbConfigPath, JSON.stringify(config, null, 2));
  }

  async ddbSyncAll() {
    const conf = this._readDdbConfig();
    const ids = conf.characterIds || [];
    if (!ids.length) return { synced: 0, failed: 0, results: [] };
    const results = [];
    let synced = 0, failed = 0;
    for (const id of ids) {
      try {
        const char = await this.ddbSyncOne(id);
        results.push({ id, name: char.name, success: true });
        synced++;
      } catch (e) {
        results.push({ id, error: e.message, success: false });
        failed++;
      }
    }
    this._lastSync = { time: new Date().toISOString(), synced, failed, results };
    this.reload();
    this.bus.dispatch('characters:ddb_synced', this._lastSync);
    return this._lastSync;
  }

  async ddbSyncOne(ddbId) {
    const cookie = process.env.COBALT_COOKIE;
    if (!cookie) throw new Error('COBALT_COOKIE not set in .env');

    console.log('[DDB] Fetching character ' + ddbId + '...');
    const res = await fetch(DDB_API + '/' + ddbId, {
      headers: {
        'Authorization': 'Bearer ' + cookie,
        'Cookie': 'CobaltSession=' + cookie,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Origin': 'https://www.dndbeyond.com',
        'Referer': 'https://www.dndbeyond.com/'
      }
    });

    if (!res.ok) {
      if (res.status === 401 || res.status === 403) throw new Error('Auth failed — COBALT_COOKIE expired');
      if (res.status === 404) throw new Error('Character ' + ddbId + ' not found on DDB');
      throw new Error('DDB API returned ' + res.status);
    }

    const json = await res.json();
    if (!json.data) throw new Error('Unexpected DDB response format');

    const char = this._mapDdbCharacter(json.data, ddbId);

    // Preserve current HP if character already exists (don't overwrite mid-session changes)
    const existing = this.getCharacter(String(ddbId));
    if (existing && existing.hp) {
      char.hp.current = existing.hp.current;
      char.hp.temp = existing.hp.temp || 0;
    }

    this.saveCharacter(String(ddbId), char);
    console.log('[DDB] Synced: ' + char.name + ' (' + char.race + ' ' + char.class + ' ' + char.level + ')');
    return char;
  }

  _mapDdbCharacter(d, ddbId) {
    // Classes
    const classes = (d.classes || []).map(c => ({
      name: c.definition?.name || 'Unknown',
      level: c.level || 1,
      subclass: c.subclassDefinition?.name || null
    }));
    const totalLevel = classes.reduce((sum, c) => sum + c.level, 0);
    const primaryClass = classes[0]?.name || 'Adventurer';
    const profBonus = Math.ceil(totalLevel / 4) + 1;

    // Ability scores
    const abilityScores = {};
    for (const s of (d.stats || [])) {
      const key = STAT_NAMES[s.id];
      if (!key) continue;
      const ov = (d.overrideStats || []).find(o => o.id === s.id);
      const bn = (d.bonusStats || []).find(b => b.id === s.id);
      abilityScores[key] = ov?.value ?? ((s.value ?? 10) + (bn?.value ?? 0));
    }

    // Abilities object
    const abilities = {};
    for (const key of Object.keys(STAT_LABELS)) {
      const abbr = key.toLowerCase().slice(0, 3);
      const score = abilityScores[abbr] || 10;
      abilities[abbr] = { score, modifier: abilityMod(score), modifierStr: modStr(abilityMod(score)) };
    }

    // HP
    const maxHp = d.baseHitPoints || 10;
    const removed = d.removedHitPoints || 0;
    const tempHp = d.temporaryHitPoints || 0;

    // Speed
    const speedMod = (Object.values(d.modifiers || {}).flat()).find(
      m => m.type === 'set' && m.subType === 'speed'
    );
    const speed = speedMod?.value || d.race?.weightSpeeds?.normal?.walk || 30;

    // Saving throws
    const allMods = Object.values(d.modifiers || {}).flat();
    const saveProfs = {};
    for (const key of Object.keys(STAT_LABELS)) {
      const abbr = key.toLowerCase().slice(0, 3);
      saveProfs[abbr] = allMods.some(m => m.type === 'proficiency' && m.subType === abbr + '-saving-throws');
    }
    const savingThrows = {};
    for (const key of Object.keys(STAT_LABELS)) {
      const abbr = key.toLowerCase().slice(0, 3);
      const mod = abilityMod(abilityScores[abbr] || 10);
      savingThrows[abbr] = { modifier: mod + (saveProfs[abbr] ? profBonus : 0), proficient: saveProfs[abbr] };
    }

    // Skills
    const skills = {};
    for (const [skillKey, statKey] of Object.entries(SKILL_MAP)) {
      const hasProficiency = allMods.some(m => m.type === 'proficiency' && m.subType === skillKey);
      const hasExpertise = allMods.some(m => m.type === 'expertise' && m.subType === skillKey);
      const prof = hasExpertise ? 'expertise' : hasProficiency ? 'proficiency' : 'none';
      const mod = abilityMod(abilityScores[statKey] || 10);
      const bonus = prof === 'expertise' ? profBonus * 2 : prof === 'proficiency' ? profBonus : 0;
      skills[skillKey] = { modifier: mod + bonus, proficiency: prof };
    }

    // AC
    let ac = 10 + abilityMod(abilityScores.dex || 10);
    const acOverride = d.characterValues?.find(v => v.typeId === 1);
    if (acOverride?.value) {
      ac = acOverride.value;
    } else {
      const equippedArmor = (d.inventory || []).find(i => i.equipped && i.definition?.armorClass);
      if (equippedArmor) {
        const armorAC = equippedArmor.definition.armorClass;
        const armorType = equippedArmor.definition.type;
        const dexMod = abilityMod(abilityScores.dex || 10);
        if (armorType === 'Light Armor') ac = armorAC + dexMod;
        else if (armorType === 'Medium Armor') ac = armorAC + Math.min(dexMod, 2);
        else if (armorType === 'Heavy Armor') ac = armorAC;
        else ac = armorAC + dexMod;
      }
      const hasShield = (d.inventory || []).some(i =>
        i.equipped && i.definition?.armorClass && i.definition?.type === 'Shield'
      );
      if (hasShield) ac += 2;
    }

    // Spell slots
    let spellSlots = null;
    if (d.spellSlots) {
      spellSlots = {};
      for (const slot of d.spellSlots) {
        if (slot.available > 0 || slot.used > 0) {
          spellSlots['level' + slot.level] = { total: slot.available + slot.used, used: slot.used, remaining: slot.available };
        }
      }
      if (!Object.keys(spellSlots).length) spellSlots = null;
    }

    // Spells known
    const spells = [];
    for (const src of ['classSpells', 'raceSpells', 'featSpells']) {
      for (const group of (d[src] || [])) {
        for (const spell of (group.spells || [])) {
          const def = spell.definition;
          if (!def) continue;
          spells.push({
            name: def.name,
            level: def.level || 0,
            school: def.school,
            ritual: def.ritual || false,
            concentration: def.concentration || false,
            prepared: spell.prepared || spell.alwaysPrepared || def.level === 0,
            description: def.description ? def.description.replace(/<[^>]+>/g, '').slice(0, 200) : ''
          });
        }
      }
    }

    // Features
    const features = [];
    for (const mod of allMods) {
      if (mod.type === 'bonus' || !mod.friendlyTypeName || !mod.friendlySubtypeName) continue;
      if (mod.type === 'proficiency' || mod.type === 'expertise') continue;
      features.push({
        name: mod.friendlySubtypeName,
        source: mod.friendlyTypeName,
        description: mod.description || ''
      });
    }
    // Deduplicate features by name
    const seenFeatures = new Set();
    const uniqueFeatures = features.filter(f => {
      if (seenFeatures.has(f.name)) return false;
      seenFeatures.add(f.name);
      return true;
    });

    // Inventory
    const inventory = (d.inventory || []).map(item => ({
      name: item.definition?.name || 'Unknown',
      quantity: item.quantity || 1,
      equipped: item.equipped || false,
      type: item.definition?.filterType || item.definition?.type || 'Item',
      weight: item.definition?.weight || 0
    }));

    // Currency
    const currency = {
      pp: d.currencies?.pp || 0,
      gp: d.currencies?.gp || 0,
      ep: d.currencies?.ep || 0,
      sp: d.currencies?.sp || 0,
      cp: d.currencies?.cp || 0
    };

    // Attacks from inventory weapons
    const attacks = [];
    for (const item of (d.inventory || [])) {
      const def = item.definition;
      if (!item.equipped || !def || def.filterType !== 'Weapon') continue;
      const finesse = (def.properties || []).some(p => p.name === 'Finesse');
      const ranged = def.attackType === 2;
      const statKey = ranged ? 'dex' : (finesse ? (abilityScores.dex >= abilityScores.str ? 'dex' : 'str') : 'str');
      const atkMod = abilityMod(abilityScores[statKey] || 10) + profBonus;
      const dmgMod = abilityMod(abilityScores[statKey] || 10);
      attacks.push({
        name: def.name,
        toHit: atkMod,
        damage: (def.damage?.diceString || '1d4') + (dmgMod >= 0 ? '+' + dmgMod : dmgMod),
        damageType: def.damageType || 'bludgeoning',
        range: def.range ? def.range + '/' + (def.longRange || def.range) : '5ft'
      });
    }

    return {
      ddbId: String(ddbId),
      name: d.name || 'Unknown',
      class: primaryClass,
      classes,
      level: totalLevel,
      race: d.race?.fullName || d.race?.baseRaceName || 'Unknown',
      background: d.background?.definition?.name || null,
      alignment: ALIGNMENTS[d.alignmentId] || null,
      hp: { current: Math.max(0, maxHp - removed), max: maxHp, temp: tempHp },
      ac,
      speed: typeof speed === 'object' ? speed.walk || 30 : speed,
      initiative: abilityMod(abilityScores.dex || 10),
      proficiencyBonus: profBonus,
      abilities,
      savingThrows,
      skills,
      spellSlots,
      spells,
      attacks,
      features: uniqueFeatures,
      inventory,
      conditions: [],
      currency,
      languages: allMods.filter(m => m.type === 'language').map(m => m.friendlySubtypeName).filter(Boolean),
      _syncedAt: new Date().toISOString(),
      _source: 'ddb',
      _ddbUrl: 'https://www.dndbeyond.com/characters/' + ddbId
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // DDB PUSH — Write HP and spell slots back to D&D Beyond
  // ══════════════════════════════════════════════════════════════════════════

  async ddbPushHp(ddbId, currentHp, maxHp, tempHp) {
    const cookie = process.env.COBALT_COOKIE;
    if (!cookie) throw new Error('COBALT_COOKIE not set');

    const removedHp = Math.max(0, maxHp - currentHp);
    const url = DDB_API + '/' + ddbId;

    // DDB uses PATCH with removedHitPoints and temporaryHitPoints
    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        'Authorization': 'Bearer ' + cookie,
        'Cookie': 'CobaltSession=' + cookie,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Origin': 'https://www.dndbeyond.com',
        'Referer': 'https://www.dndbeyond.com/'
      },
      body: JSON.stringify({
        removedHitPoints: removedHp,
        temporaryHitPoints: tempHp || 0
      })
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn('[DDB] Push HP failed (' + res.status + '):', body.slice(0, 200));
      throw new Error('DDB push HP failed: ' + res.status);
    }
    console.log('[DDB] Pushed HP for character ' + ddbId + ': ' + currentHp + '/' + maxHp);
    return { pushed: true };
  }

  async ddbPushSpellSlots(ddbId, spellSlots) {
    const cookie = process.env.COBALT_COOKIE;
    if (!cookie) throw new Error('COBALT_COOKIE not set');

    // DDB spell slot usage endpoint
    const slotsPayload = [];
    for (const [key, val] of Object.entries(spellSlots || {})) {
      const level = parseInt(key.replace('level', ''));
      if (isNaN(level)) continue;
      slotsPayload.push({ level, used: val.used || 0 });
    }

    if (!slotsPayload.length) return { pushed: false, reason: 'no slots' };

    const res = await fetch(DDB_API + '/' + ddbId + '/spellslots', {
      method: 'PUT',
      headers: {
        'Authorization': 'Bearer ' + cookie,
        'Cookie': 'CobaltSession=' + cookie,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Origin': 'https://www.dndbeyond.com',
        'Referer': 'https://www.dndbeyond.com/'
      },
      body: JSON.stringify({ spellSlots: slotsPayload })
    });

    if (!res.ok) {
      console.warn('[DDB] Push spell slots failed (' + res.status + ')');
      throw new Error('DDB push spell slots failed: ' + res.status);
    }
    console.log('[DDB] Pushed spell slots for character ' + ddbId);
    return { pushed: true };
  }

  // Push all tracked changes for a player back to DDB
  async ddbPushPlayer(playerId) {
    const player = this.state.get('players.' + playerId);
    if (!player?.character?.ddbId) throw new Error('No DDB character assigned to ' + playerId);
    const c = player.character;
    const results = {};

    // Push HP
    try {
      results.hp = await this.ddbPushHp(c.ddbId, c.hp.current, c.hp.max, c.hp.temp);
    } catch (e) { results.hp = { error: e.message }; }

    // Push spell slots
    if (c.spellSlots) {
      try {
        results.spellSlots = await this.ddbPushSpellSlots(c.ddbId, c.spellSlots);
      } catch (e) { results.spellSlots = { error: e.message }; }
    }

    return results;
  }

  // Push all assigned DDB characters
  async ddbPushAll() {
    const assignments = this._readAssignments();
    const results = {};
    for (const [playerId, charId] of Object.entries(assignments)) {
      if (!charId) continue;
      try {
        results[playerId] = await this.ddbPushPlayer(playerId);
      } catch (e) {
        results[playerId] = { error: e.message };
      }
    }
    return results;
  }
}

module.exports = CharacterService;
