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
    const cookie = process.env.COBALT_COOKIE || process.env.DDB_COBALT_TOKEN;
    if (ddbConf.characterIds && ddbConf.characterIds.length && cookie) {
      console.log('[Characters] Auto-syncing ' + ddbConf.characterIds.length + ' character(s) from D&D Beyond...');
      this.ddbSyncAll().catch(e => console.warn('[Characters] Auto-sync failed:', e.message));
    }
    // DDB cookie health check on startup + every 4 hours (PHASE 8B — track handle)
    this._cookieHealthTimeout = setTimeout(() => this._checkDdbCookieHealth(), 5000);
    this._cookieHealthInterval = setInterval(() => this._checkDdbCookieHealth(), 4 * 60 * 60 * 1000);
    // Listen for player inventory/spell updates and persist to disk
    this.bus.subscribe('player:inventory_update', (env) => this._persistPlayerCharacter(env.data.playerId), 'characters');
    this.bus.subscribe('player:spells_update', (env) => this._persistPlayerCharacter(env.data.playerId), 'characters');

    // Wound system — compute wound state from HP changes
    this.bus.subscribe('hp:update', (env) => {
      const { playerId, current, max } = env.data;
      if (playerId) this._computeWounds(playerId, current, max);
    }, 'characters');

    // Wound manual override route + all HTTP routes below. Defer route
    // registration until system:ready so dashboard-service (which mounts
    // express on port 3200) has created its app object. character-service
    // is registered BEFORE dashboard-service in server.js, so at this
    // point orchestrator.getService('dashboard').app is null and every
    // route registration would silently no-op — which is exactly what
    // used to happen (pre-existing bug caught during Addition 2).
    const registerRoutes = () => {
      const app = this.orchestrator.getService('dashboard')?.app;
      if (!app) return false;
      this._registerHttpRoutes(app);
      console.log('[Characters] HTTP routes registered (wounds, purse, absent, languages, abilities, rest)');
      return true;
    };
    if (!registerRoutes()) {
      this.bus.subscribe('system:ready', registerRoutes, 'characters');
    }
  }

  _registerHttpRoutes(app) {
    {
      app.put('/api/wounds/:playerId/:limb', (req, res) => {
        const { playerId, limb } = req.params;
        const { state: woundState } = req.body;
        const validLimbs = ['head', 'torso', 'leftArm', 'rightArm', 'leftLeg', 'rightLeg'];
        if (!validLimbs.includes(limb)) return res.status(400).json({ error: 'Invalid limb' });
        if (woundState < 0 || woundState > 4) return res.status(400).json({ error: 'State must be 0-4' });
        const wounds = this.state.get('players.' + playerId + '.wounds') || this._defaultWounds();
        wounds[limb] = woundState;
        this.state.set('players.' + playerId + '.wounds', wounds);
        this.bus.dispatch('wounds:updated', { playerId, wounds });
        res.json({ ok: true, wounds });
      });

      app.get('/api/wounds/:playerId', (req, res) => {
        const wounds = this.state.get('players.' + req.params.playerId + '.wounds') || this._defaultWounds();
        res.json({ wounds });
      });

      // ── Purse / monetary system ──
      app.get('/api/purse/:playerId', (req, res) => {
        const purse = this.state.get('players.' + req.params.playerId + '.character.purse')
          || { cp: 0, sp: 0, gp: 0, pp: 0, transactions: [] };
        res.json(purse);
      });

      app.post('/api/purse/:playerId/transaction', (req, res) => {
        const { playerId } = req.params;
        const { delta, description, npc, location } = req.body || {};
        if (!delta || typeof delta !== 'object') return res.status(400).json({ error: 'delta object required' });
        const purse = this.state.get('players.' + playerId + '.character.purse')
          || { cp: 0, sp: 0, gp: 0, pp: 0, transactions: [] };
        for (const k of ['cp', 'sp', 'gp', 'pp']) {
          if (typeof delta[k] === 'number') purse[k] = (purse[k] || 0) + delta[k];
        }
        purse.transactions = purse.transactions || [];
        purse.transactions.push({
          delta, description: description || '', npc: npc || null, location: location || null,
          timestamp: new Date().toISOString()
        });
        this.state.set('players.' + playerId + '.character.purse', purse);
        this.bus.dispatch('purse:transaction', { playerId, delta, description });
        res.json({ ok: true, purse });
      });

      // ── Resource consumption (invisible by default — surfaces as story) ──
      app.post('/api/resources/:playerId/consume', (req, res) => {
        const { playerId } = req.params;
        const { resource, amount } = req.body || {};
        if (!resource) return res.status(400).json({ error: 'resource required' });
        const path = 'players.' + playerId + '.resources.' + resource;
        const current = this.state.get(path) || 0;
        const newVal = Math.max(0, current - (amount || 1));
        this.state.set(path, newVal);
        // Surface threshold check
        const thresholds = { rations: 2, ammo: 5, torches: 1, healersKit: 2 };
        if (thresholds[resource] && newVal <= thresholds[resource] && current > thresholds[resource]) {
          this.bus.dispatch('resource:surface', { playerId, resource, value: newVal });
        }
        res.json({ ok: true, resource, value: newVal });
      });

      app.get('/api/resources/:playerId', (req, res) => {
        const r = this.state.get('players.' + req.params.playerId + '.resources') || {};
        res.json(r);
      });

      // ── Absent player toggle ──
      app.get('/api/absent', (req, res) => {
        const players = this.state.get('players') || {};
        const result = {};
        for (const [pid, p] of Object.entries(players)) {
          result[pid] = {
            name: p.character?.name || pid,
            absent: !!p.absent,
            absentReason: p.absentReason || null,
            notYetArrived: !!p.notYetArrived
          };
        }
        // Backstories may also flag absent (e.g. Barry's notYetArrived)
        const backstories = this.state.get('backstories') || {};
        for (const [pid, bs] of Object.entries(backstories)) {
          if (bs.absent || bs.notYetArrived) {
            if (!result[pid]) result[pid] = { name: pid };
            result[pid].absent = !!bs.absent;
            result[pid].absentReason = bs.absentReason || null;
            result[pid].notYetArrived = !!bs.notYetArrived;
          }
        }
        res.json(result);
      });

      app.post('/api/absent/:playerId', async (req, res) => {
        const { playerId } = req.params;
        const { absent, reason } = req.body || {};
        this.state.set('players.' + playerId + '.absent', !!absent);
        if (reason) this.state.set('players.' + playerId + '.absentReason', reason);
        this.bus.dispatch('player:absent_changed', { playerId, absent: !!absent });

        // If marking present (returning), generate Max return note
        if (!absent) {
          try {
            const aiEngine = this.orchestrator.getService('ai-engine');
            if (aiEngine?.gemini?.available) {
              const charName = this.state.get('players.' + playerId + '.character.name') || playerId;
              const scene = this.state.get('scene') || {};
              const prompt = `The player ${playerId} playing ${charName} is returning after being absent. Current scene: ${scene.name || 'unknown'} — ${scene.description || ''}. Give the DM one sentence on how to reintroduce this character naturally. Under 15 words.`;
              const note = await aiEngine.gemini.generate('You are Max, the DM session assistant. Be brief and direct.', prompt, { maxTokens: 50, temperature: 0.7 });
              this.bus.dispatch('dm:whisper', { text: note || `${charName} returns to the table.`, priority: 2, category: 'story', source: 'max' });
            }
          } catch (e) {}
        }

        res.json({ ok: true, absent: !!absent });
      });

      // ── Language validation ──
      app.get('/api/languages/validation', (req, res) => {
        const players = this.state.get('players') || {};
        const result = {};
        for (const [pid, p] of Object.entries(players)) {
          const lang = p.character?.languages || [];
          const valid = p.character?.languageValidation || {};
          result[pid] = { name: p.character?.name || pid, languages: lang, validation: valid };
        }
        res.json(result);
      });

      app.post('/api/languages/:playerId/:lang', (req, res) => {
        const { playerId, lang } = req.params;
        const { status, backstory } = req.body || {};
        const valid = ['approved', 'unavailable', 'pending'];
        if (!valid.includes(status)) return res.status(400).json({ error: 'status must be approved/unavailable/pending' });
        const path = 'players.' + playerId + '.character.languageValidation.' + lang;
        this.state.set(path, status);
        if (backstory) {
          this.state.set('players.' + playerId + '.character.languageBackstory.' + lang, backstory);
        }
        res.json({ ok: true });
      });

      // ── Addition 2: Class abilities ──────────────────────────────
      // State lives at players.<pid>.abilities and holds use-counts plus
      // active flags (rage_active, action_surge_active). Defaults are
      // materialized lazily on first use.
      const DEFAULT_ABILITY_MAX = {
        rage: 3,
        bardic_inspiration: 4,
        second_wind: 1,
        action_surge: 1
      };
      const _getAbilities = (playerId) => {
        return this.state.get('players.' + playerId + '.abilities') || {};
      };
      const _setAbility = (playerId, key, value) => {
        this.state.set('players.' + playerId + '.abilities.' + key, value);
      };
      const _broadcastAbilityState = (playerId) => {
        const abilities = _getAbilities(playerId);
        this.bus.dispatch('character:abilities_update', { playerId, abilities });
      };

      app.get('/api/characters/:playerId/abilities', (req, res) => {
        res.json({ ok: true, abilities: _getAbilities(req.params.playerId) });
      });

      app.post('/api/characters/ability', (req, res) => {
        const { playerId, ability, action, target } = req.body || {};
        if (!playerId || !ability) return res.status(400).json({ error: 'playerId and ability required' });
        const playerState = this.state.get('players.' + playerId);
        if (!playerState) return res.status(404).json({ error: 'player not found' });
        const abilities = _getAbilities(playerId);
        const charName = playerState.character && playerState.character.name || playerId;

        switch (ability) {
          case 'rage': {
            if (action === 'activate') {
              const uses = abilities.rage_uses !== undefined ? abilities.rage_uses : DEFAULT_ABILITY_MAX.rage;
              if (uses <= 0) return res.status(400).json({ error: 'No rage uses remaining — long rest required.' });
              _setAbility(playerId, 'rage_active', true);
              _setAbility(playerId, 'rage_uses', uses - 1);
              this.bus.dispatch('character:ability_used', { playerId, ability: 'rage', action: 'activate' });
              this.bus.dispatch('dm:whisper', {
                text: `${charName} rages. Bear Totem — resistance to ALL damage except psychic. +2 melee damage. Advantage on STR checks and saves.`,
                priority: 1, category: 'combat'
              });
              _broadcastAbilityState(playerId);
              return res.json({ ok: true, remaining: uses - 1, active: true });
            }
            if (action === 'deactivate') {
              _setAbility(playerId, 'rage_active', false);
              this.bus.dispatch('character:ability_used', { playerId, ability: 'rage', action: 'deactivate' });
              this.bus.dispatch('dm:whisper', {
                text: `${charName} rage ended.`, priority: 2, category: 'combat'
              });
              _broadcastAbilityState(playerId);
              return res.json({ ok: true, active: false });
            }
            return res.status(400).json({ error: 'rage action must be activate or deactivate' });
          }
          case 'bardic_inspiration': {
            const uses = abilities.bardic_inspiration_uses !== undefined ? abilities.bardic_inspiration_uses : DEFAULT_ABILITY_MAX.bardic_inspiration;
            if (uses <= 0) return res.status(400).json({ error: 'No bardic inspiration uses remaining — short or long rest required.' });
            _setAbility(playerId, 'bardic_inspiration_uses', uses - 1);
            if (target) {
              this.bus.dispatch('player:notification', {
                playerId: target, type: 'ability:bardic_inspiration', die: 'd6', from: charName
              });
            }
            this.bus.dispatch('dm:whisper', {
              text: `${charName} uses Bardic Inspiration on ${target || 'unknown'} — 1d6 granted for 10 minutes.`,
              priority: 2, category: 'story'
            });
            _broadcastAbilityState(playerId);
            return res.json({ ok: true, remaining: uses - 1 });
          }
          case 'second_wind': {
            const uses = abilities.second_wind_uses !== undefined ? abilities.second_wind_uses : DEFAULT_ABILITY_MAX.second_wind;
            if (uses <= 0) return res.status(400).json({ error: 'No second wind uses remaining — short or long rest required.' });
            const fighterLevel = (playerState.character && playerState.character.level) || 3;
            const roll = Math.floor(Math.random() * 10) + 1 + Math.max(1, fighterLevel);
            const hp = (playerState.character && playerState.character.hp) || { current: 0, max: 25 };
            const hpMax = typeof hp.max === 'number' ? hp.max : 25;
            const hpCur = typeof hp.current === 'number' ? hp.current : 0;
            const newHp = Math.min(hpCur + roll, hpMax);
            this.state.set('players.' + playerId + '.character.hp.current', newHp);
            _setAbility(playerId, 'second_wind_uses', uses - 1);
            this.bus.dispatch('hp:update', { playerId, current: newHp, max: hpMax, source: 'second-wind' });
            this.bus.dispatch('dm:whisper', {
              text: `${charName} uses Second Wind — healed ${roll} HP (1d10+${Math.max(1, fighterLevel)}). Now ${newHp}/${hpMax}.`,
              priority: 2, category: 'combat'
            });
            _broadcastAbilityState(playerId);
            return res.json({ ok: true, remaining: uses - 1, healed: roll });
          }
          case 'action_surge': {
            const uses = abilities.action_surge_uses !== undefined ? abilities.action_surge_uses : DEFAULT_ABILITY_MAX.action_surge;
            if (uses <= 0) return res.status(400).json({ error: 'No action surge uses remaining — short or long rest required.' });
            _setAbility(playerId, 'action_surge_active', true);
            _setAbility(playerId, 'action_surge_uses', uses - 1);
            this.bus.dispatch('dm:whisper', {
              text: `${charName} uses Action Surge — extra action this turn.`,
              priority: 1, category: 'combat'
            });
            _broadcastAbilityState(playerId);
            return res.json({ ok: true, remaining: uses - 1 });
          }
          default:
            return res.status(400).json({ error: 'Unknown ability: ' + ability });
        }
      });

      // Short / long rest — reset ability counts + spell slots.
      app.post('/api/characters/:playerId/rest', (req, res) => {
        const playerId = req.params.playerId;
        const type = (req.body && req.body.type) || 'short';
        if (type !== 'short' && type !== 'long') {
          return res.status(400).json({ error: 'type must be short or long' });
        }
        const playerState = this.state.get('players.' + playerId);
        if (!playerState) return res.status(404).json({ error: 'player not found' });
        const charName = playerState.character && playerState.character.name || playerId;
        const char = playerState.character || {};
        const isWarlock = /Warlock/i.test(char.class || '');

        if (type === 'long') {
          // Reset every ability to default max
          _setAbility(playerId, 'rage_uses', DEFAULT_ABILITY_MAX.rage);
          _setAbility(playerId, 'rage_active', false);
          _setAbility(playerId, 'bardic_inspiration_uses', DEFAULT_ABILITY_MAX.bardic_inspiration);
          _setAbility(playerId, 'second_wind_uses', DEFAULT_ABILITY_MAX.second_wind);
          _setAbility(playerId, 'action_surge_uses', DEFAULT_ABILITY_MAX.action_surge);
          _setAbility(playerId, 'action_surge_active', false);
          // HP to max
          if (char.hp && typeof char.hp.max === 'number') {
            this.state.set('players.' + playerId + '.character.hp.current', char.hp.max);
            this.state.set('players.' + playerId + '.character.hp.temp', 0);
            this.bus.dispatch('hp:update', { playerId, current: char.hp.max, max: char.hp.max, source: 'long-rest' });
          }
          // Spell slots to max on all levels
          if (char.spellSlots && typeof char.spellSlots === 'object') {
            const updated = {};
            for (const [k, v] of Object.entries(char.spellSlots)) {
              if (v && typeof v === 'object' && typeof v.total === 'number') {
                updated[k] = { total: v.total, used: 0, remaining: v.total };
              } else {
                updated[k] = v;
              }
            }
            this.state.set('players.' + playerId + '.character.spellSlots', updated);
          }
          this.bus.dispatch('session:long_rest', { playerId });
          this.bus.dispatch('dm:whisper', {
            text: `${charName} takes a long rest. HP, spell slots, and all class abilities restored.`,
            priority: 3, category: 'system'
          });
        } else {
          // Short rest — Second Wind, Action Surge, warlock spell slots.
          _setAbility(playerId, 'second_wind_uses', DEFAULT_ABILITY_MAX.second_wind);
          _setAbility(playerId, 'action_surge_uses', DEFAULT_ABILITY_MAX.action_surge);
          _setAbility(playerId, 'action_surge_active', false);
          if (isWarlock && char.spellSlots && typeof char.spellSlots === 'object') {
            const updated = {};
            for (const [k, v] of Object.entries(char.spellSlots)) {
              if (v && typeof v === 'object' && typeof v.total === 'number') {
                updated[k] = { total: v.total, used: 0, remaining: v.total };
              } else {
                updated[k] = v;
              }
            }
            this.state.set('players.' + playerId + '.character.spellSlots', updated);
          }
          this.bus.dispatch('dm:whisper', {
            text: `${charName} takes a short rest. Second Wind, Action Surge` + (isWarlock ? ', and warlock spell slots' : '') + ' restored.',
            priority: 3, category: 'system'
          });
        }

        // Persist to disk
        try { this._persistPlayerCharacter(playerId); } catch (e) {}
        _broadcastAbilityState(playerId);
        return res.json({ ok: true, type, abilities: _getAbilities(playerId) });
      });
    }
  }

  _defaultWounds() {
    return { head: 0, torso: 0, leftArm: 0, rightArm: 0, leftLeg: 0, rightLeg: 0 };
  }

  _computeWounds(playerId, current, max) {
    if (!max || max <= 0) return;
    const pct = current / max;
    const prev = this.state.get('players.' + playerId + '.wounds') || this._defaultWounds();
    const wounds = { ...prev };
    const limbs = ['head', 'leftArm', 'rightArm', 'leftLeg', 'rightLeg'];

    // Determine overall tier from HP percentage
    let tier;
    if (current <= 0) tier = 4;       // Crippled
    else if (pct <= 0.25) tier = 3;   // Broken
    else if (pct <= 0.50) tier = 2;   // Wounded
    else if (pct <= 0.75) tier = 1;   // Scratched
    else tier = 0;                     // Unharmed

    // Cap all wounds down to the current tier (healing reduces wounds)
    for (const k of Object.keys(wounds)) {
      if (wounds[k] > tier) wounds[k] = tier;
    }

    if (tier === 0) {
      // Full health — clear all wounds
      for (const k of Object.keys(wounds)) wounds[k] = 0;
    } else if (tier === 1) {
      // Scratched — at least one limb at 1
      const alreadyHurt = limbs.filter(l => wounds[l] >= 1);
      if (alreadyHurt.length === 0) {
        const pick = limbs[Math.floor(Math.random() * limbs.length)];
        wounds[pick] = 1;
      }
    } else if (tier === 2) {
      // Wounded — torso always, one random limb
      wounds.torso = Math.max(wounds.torso, 2);
      const alreadyHurt = limbs.filter(l => wounds[l] >= 1);
      if (alreadyHurt.length === 0) {
        const pick = limbs[Math.floor(Math.random() * limbs.length)];
        wounds[pick] = Math.max(wounds[pick], 1);
      }
      // Escalate existing wounds
      for (const l of limbs) {
        if (wounds[l] > 0 && wounds[l] < 2) wounds[l] = 2;
      }
    } else if (tier === 3) {
      // Broken — torso + multiple limbs
      wounds.torso = Math.max(wounds.torso, 3);
      const shuffled = limbs.sort(() => Math.random() - 0.5);
      wounds[shuffled[0]] = Math.max(wounds[shuffled[0]], 3);
      wounds[shuffled[1]] = Math.max(wounds[shuffled[1]], 2);
      if (wounds[shuffled[2]] === 0) wounds[shuffled[2]] = Math.max(wounds[shuffled[2]], 1);
    } else {
      // Crippled — everything maxed
      for (const k of Object.keys(wounds)) wounds[k] = 4;
    }

    // Always update state and broadcast so clients stay synced
    this.state.set('players.' + playerId + '.wounds', wounds);
    this.bus.dispatch('wounds:updated', { playerId, wounds, tier, hpPct: pct });
  }

  async stop() {
    if (this._cookieHealthTimeout) { clearTimeout(this._cookieHealthTimeout); this._cookieHealthTimeout = null; }
    if (this._cookieHealthInterval) { clearInterval(this._cookieHealthInterval); this._cookieHealthInterval = null; }
  }

  _loadAll() {
    const characters = this._readCharacterFiles();
    const assignments = this._readAssignments();
    // Read backstories from session config so absent/notYetArrived flags propagate
    const backstories = (this.config && this.config.backstories) || {};
    let count = 0;
    for (const [playerId, charId] of Object.entries(assignments)) {
      if (playerId.startsWith('_')) continue;
      const char = characters[String(charId)];
      if (!char) {
        console.warn('[Characters] Assignment: player \'' + playerId + '\' -> ID ' + charId + ' not found');
        continue;
      }
      // Preserve existing absent/notYetArrived state if already set
      const existing = this.state.get('players.' + playerId) || {};
      const bs = backstories[playerId] || {};

      // Apply campaign language overrides — replaces DDB-synced language list
      const langOverride = this._langOverrides && this._langOverrides[playerId];
      if (langOverride && Array.isArray(langOverride.languages)) {
        char.languages = langOverride.languages.map(l => l.displayName || l.id || l);
        char.languageStructured = langOverride.languages;
        char.languageNote = langOverride.languageNote || null;
      }

      const playerData = {
        name: playerId,
        character: char,
        absent: existing.absent || !!bs.absent,
        absentReason: existing.absentReason || bs.absentReason || null,
        notYetArrived: existing.notYetArrived || !!bs.notYetArrived
      };
      this.state.setPlayer(playerId, playerData);
      const flag = (playerData.absent || playerData.notYetArrived) ? ' [ABSENT]' : '';
      console.log('[Characters] -> ' + playerId + ': ' + char.name + ' (' + char.race + ' ' + char.class + ' ' + char.level + ')' + flag);
      count++;
    }
    this.state.set('characters.available', characters);
    if (count > 0) {
      this.bus.dispatch('characters:loaded', { count });
    }
    return count;
  }

  _readCharacterFiles() {
    const chars = {};
    if (!fs.existsSync(this.charactersDir)) return chars;

    // Load americas-origin overlay (read-only — character files are owned by Docker root)
    let originsOverlay = {};
    try {
      const overlayPath = path.join(__dirname, '..', '..', 'config', 'character-origins.json');
      if (fs.existsSync(overlayPath)) {
        const data = JSON.parse(fs.readFileSync(overlayPath, 'utf8'));
        originsOverlay = data.americasOriginByDDBId || {};
      }
    } catch (err) {
      console.warn('[Characters] Origins overlay parse failed: ' + err.message);
    }

    // Load language validation rules
    let langRules = null;
    try {
      const langPath = path.join(__dirname, '..', '..', 'config', 'language-validation.json');
      if (fs.existsSync(langPath)) {
        langRules = JSON.parse(fs.readFileSync(langPath, 'utf8'));
      }
    } catch (err) {}

    // Load character language overrides (campaign-specific)
    let langOverrides = {};
    try {
      const overridePath = path.join(__dirname, '..', '..', 'config', 'character-language-overrides.json');
      if (fs.existsSync(overridePath)) {
        const data = JSON.parse(fs.readFileSync(overridePath, 'utf8'));
        // Strip _note key
        for (const k of Object.keys(data)) {
          if (k.startsWith('_')) continue;
          langOverrides[k] = data[k];
        }
      }
    } catch (err) {
      console.warn('[Characters] Language overrides parse failed:', err.message);
    }
    // Stash for use in _loadAll where playerId is known
    this._langOverrides = langOverrides;
    if (Object.keys(langOverrides).length) {
      console.log('[Characters] Loaded language overrides for: ' + Object.keys(langOverrides).join(', '));
    }

    for (const file of fs.readdirSync(this.charactersDir)) {
      if (!file.endsWith('.json')) continue;
      try {
        const data = JSON.parse(fs.readFileSync(path.join(this.charactersDir, file), 'utf8'));
        const id = data.foundryId || data.ddbId || path.basename(file, '.json');
        // Merge americas origin from overlay (does NOT modify the read-only file)
        if (originsOverlay[String(id)]?.americasOrigin) {
          data.americasOrigin = originsOverlay[String(id)].americasOrigin;
        }
        // Initialize purse from DDB currency if not present in state
        if (!data.purse) {
          const ddbCurrency = data.currency || {};
          data.purse = {
            cp: ddbCurrency.cp || 0,
            sp: ddbCurrency.sp || 0,
            gp: ddbCurrency.gp || 0,
            pp: ddbCurrency.pp || 0,
            transactions: []
          };
        }
        // Validate languages — flag for DM review
        if (langRules && Array.isArray(data.languages)) {
          const race = (data.race || '').replace(/^.*\s/, ''); // last word
          const raceAuto = langRules.raceAutoApprove?.[race] || [];
          const validation = {};
          for (const lang of data.languages) {
            if (lang === 'Common' || lang === 'Latin' || langRules.autoApprove?.humanHistorical?.includes(lang)) {
              validation[lang] = 'approved';
            } else if (raceAuto.includes(lang)) {
              validation[lang] = 'approved';
            } else if (langRules.requireBackstory?.[lang]) {
              validation[lang] = 'pending';
            } else {
              validation[lang] = 'pending';
            }
          }
          data.languageValidation = validation;
        }
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
    const char = chars[String(id)] || null;
    if (!char) return null;
    // Apply language override if any player assignment maps to this character
    try {
      const assignments = this._readAssignments();
      const playerId = Object.keys(assignments).find(pid => String(assignments[pid]) === String(id));
      const langOverride = playerId && this._langOverrides && this._langOverrides[playerId];
      if (langOverride && Array.isArray(langOverride.languages)) {
        char.languages = langOverride.languages.map(l => l.displayName || l.id || l);
        char.languageStructured = langOverride.languages;
        char.languageNote = langOverride.languageNote || null;
      }
    } catch (e) {}
    return char;
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

  // Save player's current character state back to disk
  _calcAC(char) {
    const dexMod = char.abilities?.dex?.modifier ?? 0;
    let ac = 10 + dexMod;
    const equipped = (char.inventory || []).filter(i => i.equipped);
    const armor = equipped.find(i => i.acType && i.acType !== 'shield');
    if (armor) {
      if (armor.acType === 'light') ac = armor.ac + dexMod;
      else if (armor.acType === 'medium') ac = armor.ac + Math.min(2, dexMod);
      else if (armor.acType === 'heavy') ac = armor.ac;
    }
    const shield = equipped.find(i => i.acType === 'shield');
    if (shield) ac += shield.ac || 2;
    // Magic item AC bonuses
    for (const item of equipped) {
      if (!item.modifiers?.acBonus) continue;
      if (item.attunement && !item.attuned) continue;
      ac += item.modifiers.acBonus;
    }
    return ac;
  }

  _persistPlayerCharacter(playerId) {
    const charData = this.state.get('players.' + playerId + '.character');
    if (!charData) return;
    const id = charData.ddbId || charData.foundryId;
    if (!id) return;
    // Recalculate AC from equipped items
    charData.ac = this._calcAC(charData);
    this.state.set('players.' + playerId + '.character.ac', charData.ac);
    this.saveCharacter(String(id), charData);
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

  /**
   * Validate DDB API response before parsing — DDB returns HTML when the
   * cookie has expired (login redirect). Throw a clear error and update
   * status before any JSON.parse() runs.
   */
  async _parseDdbResponse(res, label) {
    const text = await res.text();
    if (text.trim().startsWith('<')) {
      this._setDdbStatus('COOKIE_EXPIRED');
      throw new Error('DDB returned HTML — cookie likely expired. Re-authenticate via Tools tab. (' + label + ')');
    }
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new Error('DDB returned non-JSON for ' + label + ': ' + text.slice(0, 100));
    }
  }

  /**
   * DDB cookie/auth status. Surfaces to all DM displays via state and bus.
   */
  _setDdbStatus(status) {
    if (this._ddbStatus === status) return;
    this._ddbStatus = status;
    this.state.set('ddb.status', status);
    this.state.set('ddb.statusUpdatedAt', new Date().toISOString());
    this.bus.dispatch('ddb:status', { status });
    console.log('[DDB] Status: ' + status);
  }

  getDdbStatus() {
    return this._ddbStatus || 'UNKNOWN';
  }

  /**
   * Periodic cookie health check. Runs on startup + every 4 hours.
   * Pulls one character header (cheap) to verify the cookie still works.
   */
  async _checkDdbCookieHealth() {
    const cookie = process.env.COBALT_COOKIE || process.env.DDB_COBALT_TOKEN;
    if (!cookie) {
      this._setDdbStatus('NO_COOKIE');
      return;
    }
    const conf = this._readDdbConfig();
    const probeId = (conf.characterIds && conf.characterIds[0]);
    if (!probeId) {
      this._setDdbStatus('NO_CHARACTERS');
      return;
    }
    try {
      const res = await fetch(DDB_API + '/' + probeId, {
        headers: {
          'Authorization': 'Bearer ' + cookie,
          'Cookie': 'CobaltSession=' + cookie,
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0',
          'Origin': 'https://www.dndbeyond.com',
          'Referer': 'https://www.dndbeyond.com/'
        }
      });
      const text = await res.text();
      if (!res.ok || text.trim().startsWith('<')) {
        this._setDdbStatus('COOKIE_EXPIRED');
        return;
      }
      try {
        JSON.parse(text);
        this._setDdbStatus('ONLINE');
      } catch (e) {
        this._setDdbStatus('COOKIE_EXPIRED');
      }
    } catch (e) {
      this._setDdbStatus('OFFLINE');
    }
  }

  /**
   * Save the cobalt cookie to .env. Runtime env updated immediately so
   * subsequent fetches use it without restart.
   */
  saveCobaltCookie(cookie) {
    if (!cookie) throw new Error('cookie required');
    process.env.COBALT_COOKIE = cookie;
    process.env.DDB_COBALT_TOKEN = cookie;
    // Persist to .env file (best effort)
    try {
      const envPath = path.join(__dirname, '..', '..', '.env');
      let content = '';
      if (fs.existsSync(envPath)) content = fs.readFileSync(envPath, 'utf8');
      const lines = content.split('\n').filter(l => !l.startsWith('COBALT_COOKIE=') && !l.startsWith('DDB_COBALT_TOKEN='));
      lines.push('COBALT_COOKIE=' + cookie);
      lines.push('DDB_COBALT_TOKEN=' + cookie);
      fs.writeFileSync(envPath, lines.filter(Boolean).join('\n') + '\n');
    } catch (e) {
      console.warn('[DDB] Could not persist cookie to .env:', e.message);
    }
    this._setDdbStatus('ONLINE');
    // Trigger health check
    this._checkDdbCookieHealth();
    return { ok: true };
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
    const cookie = process.env.COBALT_COOKIE || process.env.DDB_COBALT_TOKEN;
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
      if (res.status === 401 || res.status === 403) {
        this._setDdbStatus('COOKIE_EXPIRED');
        throw new Error('DDB cookie expired. Re-authenticate via Tools tab.');
      }
      if (res.status === 404) throw new Error('Character ' + ddbId + ' not found on DDB');
      throw new Error('DDB API returned ' + res.status);
    }

    const json = await this._parseDdbResponse(res, 'character ' + ddbId);
    if (!json.data) throw new Error('Unexpected DDB response format');
    this._setDdbStatus('ONLINE');

    const char = this._mapDdbCharacter(json.data, ddbId);

    // Preserve local state if character already exists (don't overwrite mid-session changes)
    const existing = this.getCharacter(String(ddbId));
    if (existing) {
      // Preserve HP
      if (existing.hp) {
        char.hp.current = existing.hp.current;
        char.hp.temp = existing.hp.temp || 0;
      }
      // Preserve local equipped/attuned state (player may have changed these in-session)
      // and Addition-1 custom weapon fields (magical, silver, attackBonus,
      // damageBonus, damageType override, properties override, special_effect).
      // DDB doesn't expose these — they are the Co-DM's combat metadata, keyed
      // by item name. Do not overwrite them on re-sync.
      if (existing.inventory && existing.inventory.length > 0) {
        const PRESERVE_KEYS = ['magical', 'silver', 'attackBonus', 'damageBonus', 'damageType', 'properties', 'special_effect'];
        const localState = {};
        for (const item of existing.inventory) {
          if (!item.name) continue;
          const keep = {};
          if (item.equipped || item.attuned) {
            keep.equipped = item.equipped;
            keep.attuned = item.attuned;
          }
          for (const k of PRESERVE_KEYS) {
            if (item[k] !== undefined) keep[k] = item[k];
          }
          if (Object.keys(keep).length) localState[item.name] = keep;
        }
        for (const item of char.inventory) {
          const saved = localState[item.name];
          if (!saved) continue;
          if (saved.equipped !== undefined) item.equipped = saved.equipped || item.equipped;
          if (saved.attuned !== undefined) item.attuned = saved.attuned || item.attuned;
          for (const k of PRESERVE_KEYS) {
            if (saved[k] !== undefined) item[k] = saved[k];
          }
        }
      }
      // Preserve Addition-1 spell-level magical flag (warlock spells etc).
      if (existing.spells && existing.spells.length > 0 && Array.isArray(char.spells)) {
        const spellLocal = {};
        for (const s of existing.spells) {
          if (s.name && s.magical !== undefined) spellLocal[s.name] = s.magical;
        }
        for (const s of char.spells) {
          if (s.name && spellLocal[s.name] !== undefined) s.magical = spellLocal[s.name];
        }
      }
    }

    // Recalculate AC based on current equipped items
    char.ac = this._calcAC(char);

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

    // Inventory — include full equipment stats for AC/attack calculation
    const inventory = (d.inventory || []).map(item => {
      const def = item.definition || {};
      const entry = {
        name: def.name || 'Unknown',
        quantity: item.quantity || 1,
        equipped: item.equipped || false,
        type: def.filterType || def.type || 'Item',
        weight: def.weight || 0,
        rarity: def.rarity || null,
        magic: def.magic || false
      };
      // Armor stats
      if (def.armorClass) {
        entry.ac = def.armorClass;
        const armorType = def.type || '';
        if (armorType === 'Light Armor') entry.acType = 'light';
        else if (armorType === 'Medium Armor') entry.acType = 'medium';
        else if (armorType === 'Heavy Armor') entry.acType = 'heavy';
        else if (armorType === 'Shield') entry.acType = 'shield';
      }
      // Weapon stats
      if (def.filterType === 'Weapon' || def.attackType) {
        entry.damage = def.damage?.diceString || null;
        entry.damageType = def.damageType || null;
        entry.subtype = (def.attackType === 2) ? 'ranged' : 'melee';
        entry.properties = (def.properties || []).map(p => p.name?.toLowerCase()).filter(Boolean);
        entry.range = def.range ? (def.range + (def.longRange ? '/' + def.longRange : '') + 'ft') : '5ft';
      }
      // Attunement
      if (def.canAttune || def.requiresAttunement) {
        entry.attunement = true;
        entry.attuned = item.isAttuned || false;
      }
      // Magic item modifiers (AC bonus, etc)
      const grantedMods = (def.grantedModifiers || []);
      if (grantedMods.length) {
        entry.modifiers = {};
        for (const mod of grantedMods) {
          if (mod.type === 'bonus' && mod.subType === 'armor-class') {
            entry.modifiers.acBonus = mod.value;
          }
        }
      }
      // Cursed items
      if (def.canBeCursed || (def.description || '').toLowerCase().includes('cursed')) {
        entry.cursed = true;
      }
      return entry;
    });

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

    // Patron / subclass details (important for warlocks, clerics, etc)
    const patron = classes.map(c => c.subclass).filter(Boolean).join(', ') || null;

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
      senses: {
        darkvision: uniqueFeatures.some(f => f.name === 'Darkvision') ? 60 : 0
      },
      inventory,
      conditions: [],
      currency,
      languages: allMods.filter(m => m.type === 'language').map(m => m.friendlySubtypeName).filter(Boolean),
      backstory,
      appearance,
      patron,
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
