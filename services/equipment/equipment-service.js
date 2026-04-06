/**
 * equipment-service.js — Equipment Degradation & Consumable Tracking
 * Tracks item condition (0-4), ammo, spell components, healer's kit charges.
 * Hooks into combat events for automatic degradation.
 */

const fs = require('fs');
const path = require('path');

// Condition states
const CONDITION = { PRISTINE: 0, GOOD: 1, WORN: 2, DAMAGED: 3, BROKEN: 4 };
const CONDITION_LABELS = ['Pristine', 'Good', 'Worn', 'Damaged', 'Broken'];

// Weapon → ammo type mapping
const WEAPON_AMMO_MAP = {
  'shortbow': 'arrows', 'longbow': 'arrows', 'bow': 'arrows',
  'hand crossbow': 'bolts', 'light crossbow': 'bolts', 'heavy crossbow': 'bolts', 'crossbow': 'bolts',
  'blowgun': 'needles', 'sling': 'bullets'
};

// Default ammo counts for new quivers/pouches
const DEFAULT_AMMO = { arrows: 20, bolts: 20, needles: 50, bullets: 20 };

class EquipmentService {
  constructor() {
    this.name = 'equipment';
    this.orchestrator = null;
  }

  async init(orchestrator) {
    this.orchestrator = orchestrator;
    this.bus = orchestrator.bus;
    this.state = orchestrator.state;
    this.config = orchestrator.config;

    // Load SRD spells for component lookup
    this._srdSpells = [];
    try {
      const spellPath = path.join(this.config.configDir || './config', 'srd-spells.json');
      this._srdSpells = JSON.parse(fs.readFileSync(spellPath, 'utf8'));
    } catch (e) {
      console.warn('[Equipment] Could not load srd-spells.json for component tracking');
    }
  }

  async start() {
    this._setupRoutes();
    this._setupEventListeners();
    this._initAllPlayers();
    console.log('[Equipment] Ready');
  }

  async stop() {}

  getStatus() {
    const players = this.state.get('players') || {};
    let tracked = 0;
    for (const p of Object.values(players)) {
      if (p.equipment) tracked++;
    }
    return { status: 'running', playersTracked: tracked };
  }

  // ═══════════════════════════════════════════════════════════════
  // INITIALIZATION
  // ═══════════════════════════════════════════════════════════════

  _initAllPlayers() {
    const players = this.state.get('players') || {};
    for (const [playerId, player] of Object.entries(players)) {
      if (player.character) {
        this._initPlayerEquipment(playerId);
      }
    }
  }

  _initPlayerEquipment(playerId) {
    const existing = this.state.get(`players.${playerId}.equipment`);
    if (existing) return; // Already initialized

    const char = this.state.get(`players.${playerId}.character`);
    if (!char) return;

    const equipment = {
      conditions: {},    // itemName -> condition (0-4)
      ammo: {},          // ammoType -> { count, max }
      components: {},    // componentName -> { count, maxUses, spells }
      healerKit: null     // { charges, max } or null if no kit
    };

    // Initialize item conditions
    for (const item of (char.inventory || [])) {
      if (item.equipped || item.type === 'Weapon' || item.type === 'Armor' || item.acType) {
        equipment.conditions[item.name] = CONDITION.PRISTINE;
      }
    }

    // Initialize ammo based on equipped ranged weapons
    const equippedWeapons = (char.inventory || []).filter(i => i.equipped && i.subtype === 'ranged');
    for (const weapon of equippedWeapons) {
      const ammoType = this._getAmmoType(weapon.name);
      if (ammoType && !equipment.ammo[ammoType]) {
        equipment.ammo[ammoType] = { count: DEFAULT_AMMO[ammoType] || 20, max: DEFAULT_AMMO[ammoType] || 20 };
      }
    }

    // Initialize spell components based on character's known spells
    if (char.spells && char.spells.length > 0) {
      this._initSpellComponents(equipment, char);
    }

    // Check for healer's kit
    const hasKit = (char.inventory || []).some(i =>
      i.name && i.name.toLowerCase().includes('healer') && i.name.toLowerCase().includes('kit')
    );
    if (hasKit) {
      equipment.healerKit = { charges: 10, max: 10 };
    }

    this.state.set(`players.${playerId}.equipment`, equipment);
  }

  _initSpellComponents(equipment, char) {
    const hasPouch = (char.inventory || []).some(i =>
      i.name && (i.name.toLowerCase().includes('component pouch') || i.name.toLowerCase().includes('arcane focus'))
    );

    for (const spell of char.spells) {
      const srdSpell = this._findSrdSpell(spell.name);
      if (!srdSpell) continue;

      const parsed = this._parseMaterialComponent(srdSpell.components);
      if (!parsed) continue;

      if (parsed.costly) {
        // Costly components: tracked individually, consumed on cast
        const key = parsed.material;
        if (!equipment.components[key]) {
          equipment.components[key] = {
            count: 1,
            costly: true,
            goldValue: parsed.goldValue,
            consumed: parsed.consumed,
            spells: [spell.name]
          };
        } else {
          if (!equipment.components[key].spells.includes(spell.name)) {
            equipment.components[key].spells.push(spell.name);
          }
        }
      } else if (hasPouch) {
        // Non-costly: tracked per pouch, 10 uses before restocking
        const key = parsed.material;
        if (!equipment.components[key]) {
          equipment.components[key] = {
            count: 10,
            maxUses: 10,
            costly: false,
            spells: [spell.name]
          };
        } else {
          if (!equipment.components[key].spells.includes(spell.name)) {
            equipment.components[key].spells.push(spell.name);
          }
        }
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // CORE METHODS
  // ═══════════════════════════════════════════════════════════════

  getPlayerEquipment(playerId) {
    this._initPlayerEquipment(playerId);
    const eq = this.state.get(`players.${playerId}.equipment`) || {};
    const char = this.state.get(`players.${playerId}.character`);
    if (!char) return { conditions: {}, ammo: {}, components: {}, healerKit: null, items: [] };

    // Build enriched item list
    const items = (char.inventory || []).map(item => {
      const condition = eq.conditions?.[item.name];
      return {
        ...item,
        condition: condition !== undefined ? condition : null,
        conditionLabel: condition !== undefined ? CONDITION_LABELS[condition] : null
      };
    });

    return {
      conditions: eq.conditions || {},
      ammo: eq.ammo || {},
      components: eq.components || {},
      healerKit: eq.healerKit || null,
      items
    };
  }

  setCondition(playerId, itemName, newState) {
    if (newState < 0 || newState > 4) return null;
    const eq = this.state.get(`players.${playerId}.equipment`);
    if (!eq) return null;

    const oldState = eq.conditions[itemName];
    eq.conditions[itemName] = newState;
    this.state.set(`players.${playerId}.equipment.conditions`, eq.conditions);

    const charName = this.state.get(`players.${playerId}.character.name`) || playerId;

    this.bus.dispatch('equipment:updated', {
      playerId, itemName, condition: newState,
      conditionLabel: CONDITION_LABELS[newState],
      charName
    });

    return { itemName, condition: newState, conditionLabel: CONDITION_LABELS[newState] };
  }

  degradeItem(playerId, itemName, reason) {
    const eq = this.state.get(`players.${playerId}.equipment`);
    if (!eq || eq.conditions[itemName] === undefined) return null;

    const current = eq.conditions[itemName];
    if (current >= CONDITION.BROKEN) return null; // Already broken

    const newState = current + 1;
    eq.conditions[itemName] = newState;
    this.state.set(`players.${playerId}.equipment.conditions`, eq.conditions);

    const charName = this.state.get(`players.${playerId}.character.name`) || playerId;

    this.bus.dispatch('equipment:degraded', {
      playerId, itemName,
      condition: newState,
      conditionLabel: CONDITION_LABELS[newState],
      reason, charName
    });

    this.bus.dispatch('equipment:updated', {
      playerId, itemName, condition: newState,
      conditionLabel: CONDITION_LABELS[newState],
      charName
    });

    return { itemName, condition: newState, conditionLabel: CONDITION_LABELS[newState] };
  }

  adjustAmmo(playerId, ammoType, delta) {
    const eq = this.state.get(`players.${playerId}.equipment`);
    if (!eq || !eq.ammo[ammoType]) return null;

    eq.ammo[ammoType].count = Math.max(0, eq.ammo[ammoType].count + delta);
    this.state.set(`players.${playerId}.equipment.ammo`, eq.ammo);

    const charName = this.state.get(`players.${playerId}.character.name`) || playerId;

    this.bus.dispatch('equipment:updated', {
      playerId, ammoType,
      ammoCount: eq.ammo[ammoType].count,
      charName
    });

    return eq.ammo[ammoType];
  }

  consumeComponent(playerId, componentName) {
    const eq = this.state.get(`players.${playerId}.equipment`);
    if (!eq || !eq.components[componentName]) return null;

    const comp = eq.components[componentName];
    if (comp.count <= 0) return { consumed: false, reason: 'depleted' };

    comp.count--;
    this.state.set(`players.${playerId}.equipment.components`, eq.components);

    const charName = this.state.get(`players.${playerId}.character.name`) || playerId;

    this.bus.dispatch('equipment:updated', {
      playerId, componentName,
      remaining: comp.count,
      charName
    });

    return { consumed: true, remaining: comp.count, component: comp };
  }

  useHealerKit(playerId) {
    const eq = this.state.get(`players.${playerId}.equipment`);
    if (!eq || !eq.healerKit) return null;
    if (eq.healerKit.charges <= 0) return { used: false, reason: 'empty' };

    eq.healerKit.charges--;
    this.state.set(`players.${playerId}.equipment.healerKit`, eq.healerKit);

    const charName = this.state.get(`players.${playerId}.character.name`) || playerId;

    this.bus.dispatch('equipment:updated', {
      playerId, healerKit: eq.healerKit, charName
    });

    return { used: true, charges: eq.healerKit.charges };
  }

  // ═══════════════════════════════════════════════════════════════
  // MAINTENANCE (Rest)
  // ═══════════════════════════════════════════════════════════════

  getMaintenanceList(playerId) {
    const eq = this.state.get(`players.${playerId}.equipment`);
    if (!eq) return [];

    const items = [];
    for (const [name, cond] of Object.entries(eq.conditions || {})) {
      if (cond >= CONDITION.WORN && cond <= CONDITION.DAMAGED) {
        items.push({ name, condition: cond, conditionLabel: CONDITION_LABELS[cond] });
      }
    }
    return items;
  }

  repairItem(playerId, itemName) {
    const eq = this.state.get(`players.${playerId}.equipment`);
    if (!eq || eq.conditions[itemName] === undefined) return null;

    const current = eq.conditions[itemName];
    if (current <= CONDITION.PRISTINE) return null; // Already pristine
    if (current >= CONDITION.BROKEN) return null; // Cannot repair broken items manually

    return this.setCondition(playerId, itemName, current - 1);
  }

  longRestMaintenance(playerId) {
    const eq = this.state.get(`players.${playerId}.equipment`);
    if (!eq) return [];

    const repaired = [];
    for (const [name, cond] of Object.entries(eq.conditions || {})) {
      if (cond > CONDITION.PRISTINE && cond < CONDITION.BROKEN) {
        eq.conditions[name] = cond - 1;
        repaired.push({ name, from: CONDITION_LABELS[cond], to: CONDITION_LABELS[cond - 1] });
      }
    }

    if (repaired.length > 0) {
      this.state.set(`players.${playerId}.equipment.conditions`, eq.conditions);
      this.bus.dispatch('equipment:updated', { playerId, maintenance: 'long_rest', repaired });
    }

    return repaired;
  }

  // ═══════════════════════════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════════════════════════

  _getAmmoType(weaponName) {
    const lower = weaponName.toLowerCase();
    for (const [weapon, ammo] of Object.entries(WEAPON_AMMO_MAP)) {
      if (lower.includes(weapon)) return ammo;
    }
    return null;
  }

  _getEquippedRangedWeapon(playerId) {
    const char = this.state.get(`players.${playerId}.character`);
    if (!char) return null;
    return (char.inventory || []).find(i => i.equipped && i.subtype === 'ranged');
  }

  _findSrdSpell(name) {
    return this._srdSpells.find(s => s.name.toLowerCase() === name.toLowerCase());
  }

  _parseMaterialComponent(componentStr) {
    if (!componentStr || !componentStr.includes('M')) return null;

    const match = componentStr.match(/M\s*\(([^)]+)\)/);
    if (!match) return null;

    const material = match[1].trim();
    const goldMatch = material.match(/(\d+)\s*gp/);
    const consumed = material.toLowerCase().includes('consumed') || material.toLowerCase().includes('which the spell consumes');

    return {
      material,
      costly: !!goldMatch,
      goldValue: goldMatch ? parseInt(goldMatch[1]) : 0,
      consumed: consumed || !!goldMatch // Costly components are consumed by default
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // EVENT LISTENERS — Automatic Degradation
  // ═══════════════════════════════════════════════════════════════

  _setupEventListeners() {
    // Character loaded/updated → init equipment tracking
    this.bus.subscribe('characters:reloaded', () => {
      this._initAllPlayers();
    }, 'equipment');

    this.bus.subscribe('character:update', (env) => {
      const { playerId } = env.data;
      if (playerId) this._initPlayerEquipment(playerId);
    }, 'equipment');

    // Natural 1 on attack → weapon degrades
    this.bus.subscribe('combat:attack_result', (env) => {
      const { attackerId, attackRoll, crit, hit } = env.data;
      // Check for nat 1 (fumble): attackRoll minus toHit bonus would be raw d20
      // We check the combat service's roll data if available
      // Simpler: if attackRoll is very low and not a crit, check player weapon
      this._onAttackResult(env.data);
    }, 'equipment');

    // NPC roll results for nat 1 detection
    this.bus.subscribe('player:roll', (env) => {
      const { playerId, rollType, result, total, formula } = env.data;
      if (rollType === 'attack' && result && result[0] === 1) {
        // Nat 1 on attack — degrade equipped weapon
        this._degradePlayerWeapon(playerId, 'Natural 1 on attack roll');
      }
      // Ranged attack → decrement ammo
      if (rollType === 'attack') {
        this._onPlayerAttack(playerId, env.data);
      }
      // Medicine check with healer's kit
      if (rollType === 'check' && env.data.label && env.data.label.toLowerCase().includes('medicine')) {
        this.useHealerKit(playerId);
      }
    }, 'equipment');

    // Critical hit received → armor degrades
    this.bus.subscribe('combat:attack_result', (env) => {
      const { targetId, hit, crit } = env.data;
      if (hit && crit && targetId) {
        this._degradePlayerArmor(targetId, 'Critical hit received');
      }
    }, 'equipment-armor');

    // Spell cast → consume components
    this.bus.subscribe('player:roll', (env) => {
      if (env.data.rollType === 'spell' && env.data.spellName) {
        this._onSpellCast(env.data.playerId, env.data.spellName);
      }
    }, 'equipment-spells');

    // Also listen for spell slot usage which indicates a spell was cast
    this.bus.subscribe('player:spells_update', (env) => {
      // This fires when spell slots change — handled by spell cast events above
    }, 'equipment');
  }

  _onAttackResult(data) {
    const { attackerId, attackRoll, crit } = data;
    // For NPC attacks processed through combat service, check the d20 roll
    // The raw d20 is embedded in the full attack flow via rollNpcAction
    // Player attacks come through player:roll event instead
  }

  _degradePlayerWeapon(playerId, reason) {
    const char = this.state.get(`players.${playerId}.character`);
    if (!char) return;

    const weapon = (char.inventory || []).find(i => i.equipped && (i.type === 'Weapon' || i.subtype));
    if (!weapon) return;

    this.degradeItem(playerId, weapon.name, reason);
  }

  _degradePlayerArmor(playerId, reason) {
    const char = this.state.get(`players.${playerId}.character`);
    if (!char) return;

    const armor = (char.inventory || []).find(i => i.equipped && i.acType && i.acType !== 'shield');
    if (!armor) return;

    this.degradeItem(playerId, armor.name, reason);
  }

  _onPlayerAttack(playerId, rollData) {
    // Check if this is a ranged attack
    const weapon = this._getEquippedRangedWeapon(playerId);
    if (!weapon) return;

    const ammoType = this._getAmmoType(weapon.name);
    if (!ammoType) return;

    this.adjustAmmo(playerId, ammoType, -1);
  }

  _onSpellCast(playerId, spellName) {
    const srdSpell = this._findSrdSpell(spellName);
    if (!srdSpell) return;

    const parsed = this._parseMaterialComponent(srdSpell.components);
    if (!parsed || !parsed.costly) return;

    // Find matching component in player's equipment
    const eq = this.state.get(`players.${playerId}.equipment`);
    if (!eq) return;

    // Look for the component by material description
    for (const [compName, comp] of Object.entries(eq.components || {})) {
      if (comp.costly && comp.spells.includes(spellName) && comp.consumed) {
        this.consumeComponent(playerId, compName);
        break;
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // ROUTES
  // ═══════════════════════════════════════════════════════════════

  _setupRoutes() {
    const app = this.orchestrator.getService('dashboard')?.app;
    if (!app) return;

    // GET full equipment state for a player
    app.get('/api/equipment/:playerId', (req, res) => {
      const data = this.getPlayerEquipment(req.params.playerId);
      res.json(data);
    });

    // PUT item condition
    app.put('/api/equipment/:playerId/:itemName/condition', (req, res) => {
      const { state: newState } = req.body;
      if (newState === undefined || newState < 0 || newState > 4) {
        return res.status(400).json({ error: 'state must be 0-4' });
      }
      const itemName = decodeURIComponent(req.params.itemName);
      const result = this.setCondition(req.params.playerId, itemName, newState);
      if (!result) return res.status(404).json({ error: 'Item not found' });
      res.json({ ok: true, ...result });
    });

    // PUT ammo
    app.put('/api/equipment/:playerId/ammo/:type', (req, res) => {
      const { delta } = req.body;
      if (typeof delta !== 'number') return res.status(400).json({ error: 'delta required' });
      const result = this.adjustAmmo(req.params.playerId, req.params.type, delta);
      if (!result) return res.status(404).json({ error: 'Ammo type not found' });
      res.json({ ok: true, ...result });
    });

    // PUT consume component
    app.put('/api/equipment/:playerId/components/:component', (req, res) => {
      const { consume } = req.body;
      if (!consume) return res.status(400).json({ error: 'consume: true required' });
      const compName = decodeURIComponent(req.params.component);
      const result = this.consumeComponent(req.params.playerId, compName);
      if (!result) return res.status(404).json({ error: 'Component not found' });
      res.json({ ok: true, ...result });
    });

    // GET maintenance list
    app.get('/api/equipment/:playerId/maintenance', (req, res) => {
      const list = this.getMaintenanceList(req.params.playerId);
      res.json({ items: list });
    });

    // POST repair item (during rest)
    app.post('/api/equipment/:playerId/repair/:itemName', (req, res) => {
      const itemName = decodeURIComponent(req.params.itemName);
      const result = this.repairItem(req.params.playerId, itemName);
      if (!result) return res.status(400).json({ error: 'Cannot repair' });
      res.json({ ok: true, ...result });
    });

    // POST long rest maintenance
    app.post('/api/equipment/:playerId/long-rest', (req, res) => {
      const repaired = this.longRestMaintenance(req.params.playerId);
      res.json({ ok: true, repaired });
    });

    // POST short rest maintenance (manual per-item repair)
    app.post('/api/equipment/:playerId/short-rest', (req, res) => {
      // Returns list of repairable items; actual repairs done via /repair/:itemName
      const list = this.getMaintenanceList(req.params.playerId);
      res.json({ ok: true, items: list });
    });
  }
}

module.exports = EquipmentService;
