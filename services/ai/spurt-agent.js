/**
 * Spurt AI Agent — Phase E
 * AI-controlled kobold Wild Magic Sorcerer party member.
 * Features: combat actions, dialogue generation, wild magic surges,
 * personality drift based on Dread, distinct voice/mannerisms.
 */

const fs = require('fs');
const path = require('path');

// Official D&D 5e Wild Magic Surge Table (d100)
const WILD_MAGIC_TABLE = [
  { range: [1, 2], effect: 'Roll on this table at the start of each of your turns for the next minute, ignoring this result on subsequent rolls.', category: 'meta' },
  { range: [3, 4], effect: 'For the next minute, you can see any invisible creature if you have line of sight to it.', category: 'utility' },
  { range: [5, 6], effect: 'A modron chosen and controlled by the DM appears in an unoccupied space within 5 feet of you, then disappears 1 minute later.', category: 'summon' },
  { range: [7, 8], effect: 'You cast Fireball as a 3rd-level spell centered on yourself.', category: 'damage', selfHarm: true, spell: 'Fireball', damage: '8d6', damageType: 'fire' },
  { range: [9, 10], effect: 'You cast Magic Missile as a 5th-level spell.', category: 'damage', spell: 'Magic Missile' },
  { range: [11, 12], effect: 'Roll a d10. Your height changes by a number of inches equal to the roll. If odd, you shrink. If even, you grow.', category: 'cosmetic' },
  { range: [13, 14], effect: 'You cast Confusion centered on yourself.', category: 'control', selfHarm: true, spell: 'Confusion' },
  { range: [15, 16], effect: 'For the next minute, you regain 5 hit points at the start of each of your turns.', category: 'healing' },
  { range: [17, 18], effect: 'You grow a long beard made of feathers that remains until you sneeze.', category: 'cosmetic' },
  { range: [19, 20], effect: 'You cast Grease centered on yourself.', category: 'control', spell: 'Grease' },
  { range: [21, 22], effect: 'Creatures have disadvantage on saves against the next spell you cast in the next minute that involves a saving throw.', category: 'buff' },
  { range: [23, 24], effect: 'Your skin turns a vibrant shade of blue. A Remove Curse spell can end this effect.', category: 'cosmetic' },
  { range: [25, 26], effect: 'An eye appears on your forehead for the next minute. You gain advantage on Perception checks that rely on sight.', category: 'utility' },
  { range: [27, 28], effect: 'For the next minute, all your spells with a casting time of 1 action have a casting time of 1 bonus action.', category: 'buff' },
  { range: [29, 30], effect: 'You teleport up to 60 feet to an unoccupied space of your choice that you can see.', category: 'movement' },
  { range: [31, 32], effect: 'You are transported to the Astral Plane until the end of your next turn, after which time you return.', category: 'movement' },
  { range: [33, 34], effect: 'Maximize the damage of the next damaging spell you cast within the next minute.', category: 'buff' },
  { range: [35, 36], effect: 'Roll a d10. Your age changes by a number of years equal to the roll. If odd, younger. If even, older.', category: 'cosmetic' },
  { range: [37, 38], effect: '1d6 flumphs controlled by the DM appear in unoccupied spaces within 60 feet of you and are frightened of you. They vanish after 1 minute.', category: 'summon' },
  { range: [39, 40], effect: 'You regain 2d10 hit points.', category: 'healing' },
  { range: [41, 42], effect: 'You turn into a potted plant until the start of your next turn. You are incapacitated and have vulnerability to all damage. If you drop to 0 HP, your pot breaks and you revert.', category: 'cosmetic', selfHarm: true },
  { range: [43, 44], effect: 'For the next minute, you can teleport up to 20 feet as a bonus action on each of your turns.', category: 'movement' },
  { range: [45, 46], effect: 'You cast Levitate on yourself.', category: 'utility', spell: 'Levitate' },
  { range: [47, 48], effect: 'A unicorn controlled by the DM appears in a space within 5 feet of you, then disappears 1 minute later.', category: 'summon' },
  { range: [49, 50], effect: 'You can\'t speak for the next minute. Whenever you try, pink bubbles float out of your mouth.', category: 'cosmetic', silenced: true },
  { range: [51, 52], effect: 'A spectral shield hovers near you for the next minute, granting you a +2 bonus to AC and immunity to Magic Missile.', category: 'buff' },
  { range: [53, 54], effect: 'You are immune to being intoxicated by alcohol for the next 5d6 days.', category: 'utility' },
  { range: [55, 56], effect: 'Your hair falls out but grows back within 24 hours.', category: 'cosmetic' },
  { range: [57, 58], effect: 'For the next minute, any flammable object you touch that isn\'t being worn or carried by another creature bursts into flame.', category: 'utility' },
  { range: [59, 60], effect: 'You regain your lowest-expended spell slot.', category: 'buff' },
  { range: [61, 62], effect: 'For the next minute, you must shout when you speak.', category: 'cosmetic' },
  { range: [63, 64], effect: 'You cast Fog Cloud centered on yourself.', category: 'control', spell: 'Fog Cloud' },
  { range: [65, 66], effect: 'Up to three creatures you choose within 30 feet take 4d10 lightning damage.', category: 'damage', damage: '4d10', damageType: 'lightning' },
  { range: [67, 68], effect: 'You are frightened by the nearest creature until the end of your next turn.', category: 'control', selfHarm: true },
  { range: [69, 70], effect: 'Each creature within 30 feet of you becomes invisible for the next minute. The invisibility ends on a creature when it attacks or casts a spell.', category: 'utility' },
  { range: [71, 72], effect: 'You gain resistance to all damage for the next minute.', category: 'buff' },
  { range: [73, 74], effect: 'A random creature within 60 feet of you becomes poisoned for 1d4 hours.', category: 'control' },
  { range: [75, 76], effect: 'You glow with bright light in a 30-foot radius for the next minute. Any creature that ends its turn within 5 feet of you is blinded until the end of its next turn.', category: 'utility' },
  { range: [77, 78], effect: 'You cast Polymorph on yourself. If you fail the saving throw, you turn into a sheep for the spell\'s duration.', category: 'cosmetic', selfHarm: true, spell: 'Polymorph' },
  { range: [79, 80], effect: 'Illusory butterflies and flower petals flutter in the air within 10 feet of you for the next minute.', category: 'cosmetic' },
  { range: [81, 82], effect: 'You can take one additional action immediately.', category: 'buff' },
  { range: [83, 84], effect: 'Each creature within 30 feet of you takes 1d10 necrotic damage. You regain HP equal to the sum of necrotic damage dealt.', category: 'damage', damage: '1d10', damageType: 'necrotic' },
  { range: [85, 86], effect: 'You cast Mirror Image.', category: 'buff', spell: 'Mirror Image' },
  { range: [87, 88], effect: 'You cast Fly on a random creature within 60 feet of you.', category: 'utility', spell: 'Fly' },
  { range: [89, 90], effect: 'You become invisible for the next minute. During that time, other creatures can\'t hear you. The invisibility ends if you attack or cast a spell.', category: 'utility' },
  { range: [91, 92], effect: 'If you die within the next minute, you immediately come back to life as if by the Reincarnate spell.', category: 'buff' },
  { range: [93, 94], effect: 'Your size increases by one size category for the next minute.', category: 'buff' },
  { range: [95, 96], effect: 'You and all creatures within 30 feet gain vulnerability to piercing damage for the next minute.', category: 'control', selfHarm: true },
  { range: [97, 98], effect: 'You are surrounded by faint, ethereal music for the next minute.', category: 'cosmetic' },
  { range: [99, 100], effect: 'You regain all expended sorcery points.', category: 'buff' }
];

// ════════════════════════════════════════════════════════════════════
// FUTURE HOOK AWARENESS FLAGS
// ════════════════════════════════════════════════════════════════════
//
// Bagman: at Dread 41+ if party inventory contains item with bagman:true flag
// Spurt refuses to approach it and cannot explain why. He watches it.
// spurt.bagmanAwareness = true at Dread 41+
//
// False Hydra: Spurt's Draconic speech at high Dread is partially immune to the song.
// His attempts to warn the party are dismissed while song is active.
// When song broken party realizes Spurt was trying to tell them the whole time.
// spurt.hydraImmunity = true
//
// Leucrotta: if Leucrotta uses a voice Spurt has heard, Spurt reacts differently.
// At Dread 61+ he addresses the voice directly in Draconic rather than following it.
// spurt.leucrottaAwareness = true at Dread 61+
//
// Noční Letavec awareness — Spurt can hear the Letavec at greater range than humans
// At Dread 41+: Spurt becomes agitated near the inn perimeter at night.
//   He won't go near windows or doors after dark during the active cycle.
//   He cannot explain why — just "no. no outside. no."
// At Dread 61+: If the Letavec speaks to a chosen target and Spurt is present
//   He addresses it directly in Draconic: "We know what you are. We know where you sleep."
//   This is a bluff. He does not know where it sleeps. But the Letavec pauses.
//   It has not been spoken to in Draconic before. It is briefly uncertain.
// At Dread 81+: Spurt has decided the Letavec is the most interesting thing
//   he has ever encountered. He starts leaving it small offerings near the tree line.
//   Bones, shiny objects, a cantrip flame. He thinks they are negotiating.
//   They are not negotiating. But the Letavec is confused by this behavior
//   and has not harvested Spurt yet partly out of something resembling curiosity.
// spurt.letavecAwareness = true
// spurt.letavecNegotiating = false  // becomes true at Dread 81+
// ════════════════════════════════════════════════════════════════════

class SpurtAgent {
  constructor(gemini, contextBuilder, bus, state, config) {
    this.gemini = gemini;
    this.ctx = contextBuilder;
    this.bus = bus;
    this.state = state;
    this.config = config;

    this._systemPrompt = '';
    this._spurtId = 'spurt'; // token/combatant ID
    this._ddbId = '162472191';
    this._dialogueHistory = [];
    this._lastDialogueTime = 0;
    this._dialogueCooldownMs = 15000; // min 15s between unprompted dialogue
    this._surgeCount = 0;
    this._activeEffects = []; // from wild magic surges

    // Future hook awareness flags
    this.hydraImmunity = true;          // Draconic partially immune to False Hydra song
    this.bagmanAwareness = false;       // becomes true at Dread 41+ near bagman item
    this.leucrottaAwareness = false;    // becomes true at Dread 61+
    this.letavecAwareness = true;       // always aware (Kobold hearing)
    this.letavecNegotiating = false;    // becomes true at Dread 81+

    // Load prompt
    try {
      this._systemPrompt = fs.readFileSync(
        path.join(__dirname, '..', '..', 'prompts', 'spurt-agent.md'), 'utf-8'
      );
    } catch (e) {
      console.warn('[SpurtAgent] No spurt-agent.md prompt found');
      this._systemPrompt = 'You are Spurt, a kobold Wild Magic Sorcerer. Stay in character.';
    }
  }

  start() {
    // Listen for combat turn events — when it's Spurt's turn, decide action
    this.bus.subscribe('combat:next_turn', async (env) => {
      const combatant = env.data.combatant;
      if (combatant && combatant.id === this._spurtId && combatant.isAlive) {
        await this._onCombatTurn(env.data);
      }
    }, 'spurt-agent');

    // Listen for combat start — Spurt reacts
    this.bus.subscribe('combat:started', async (env) => {
      const combat = env.data.combat;
      if (combat?.turnOrder?.some(c => c.id === this._spurtId)) {
        await this._onCombatStart(combat);
      }
    }, 'spurt-agent');

    // Listen for significant events and react with dialogue
    // CR-4 — Spurt was reacting to every NPC dialogue at 30%. Reduced to
    // 12% (60% reduction per spec) plus a 90-second per-Spurt cooldown so
    // he doesn't dominate scenes. He's a memorable voice, not a constant one.
    this._lastSpurtReactAt = 0;
    this.bus.subscribe('npc:approved', async (env) => {
      const now = Date.now();
      if (now - this._lastSpurtReactAt < 90 * 1000) return;
      if (Math.random() >= 0.12) return;
      this._lastSpurtReactAt = now;
      await this._reactToEvent('npc_dialogue', `${env.data.npc} says: "${env.data.text}"`);
    }, 'spurt-agent');

    this.bus.subscribe('atmosphere:profile_change', async (env) => {
      // React to atmosphere shifts
      const profile = env.data.profile || env.data.newProfile;
      if (profile && ['dread_rising', 'terror_peak', 'combat', 'revelation'].includes(profile)) {
        await this._reactToEvent('atmosphere', `The atmosphere shifted to: ${profile}`);
      }
    }, 'spurt-agent');

    this.bus.subscribe('world:secret_revealed', async (env) => {
      await this._reactToEvent('secret', `A secret was revealed: ${env.data.description || env.data.secretId}`);
    }, 'spurt-agent');

    // DM can manually prompt Spurt to speak
    this.bus.subscribe('spurt:speak', async (env) => {
      const { prompt, type } = env.data;
      if (type === 'combat') {
        await this._onCombatTurn(null, prompt);
      } else {
        await this._generateDialogue(prompt || 'React to the current situation.');
      }
    }, 'spurt-agent');

    // DM can trigger a wild magic surge manually
    this.bus.subscribe('spurt:wild_surge', async () => {
      const surge = this._rollWildMagicSurge();
      this.bus.dispatch('spurt:surge_result', surge);
    }, 'spurt-agent');

    // System 11: Spurt wound reactions — party member reaches Broken/Crippled
    this.bus.subscribe('wounds:updated', async (env) => {
      const { playerId, wounds, tier } = env.data;
      if (!tier || tier < 3) return; // Only Broken (3) or Crippled (4)
      if (playerId === this._spurtId) return; // Don't react to own wounds

      const charName = this.state.get(`players.${playerId}.character.name`) || playerId;
      const dread = this._getSpurtDread();

      let prompt;
      if (dread <= 40) {
        prompt = `A party member (${charName}) just got badly hurt (wound tier: ${tier === 3 ? 'Broken' : 'Crippled'}). Spurt is concerned and scared but tries to help. React in character, under 15 words.`;
      } else if (dread <= 60) {
        prompt = `${charName} is badly wounded. Spurt moves closer, uses Prestidigitation to clean the wound, asks rapid panicked questions. Under 15 words.`;
      } else if (dread <= 80) {
        prompt = `${charName} is horribly wounded. Spurt mixes Common and Draconic, suggests setting something on fire to cauterize it, laughs nervously. Under 15 words.`;
      } else {
        prompt = `${charName} is critically wounded. Spurt addresses the wound directly in Draconic, produces a cantrip flame, attempts reckless field surgery with magic. Under 15 words.`;
      }

      const dialogue = await this._generateDialogue(prompt, true);
      if (dialogue) {
        // Deliver via Echo TTS in dining room
        this.bus.dispatch('voice:speak', { text: dialogue, profile: 'spurt', device: 'dining_room' });
      }
    }, 'spurt-agent');

    // Stamina-aware combat: catch breath when spent, press forward when fresh
    this.bus.subscribe('stamina:tier_change', async (env) => {
      if (env.data.playerId !== this._spurtId) return;
      const newState = env.data.state;
      if (newState === 'spent') {
        this.bus.dispatch('dm:whisper', {
          text: 'Spurt is spent — will try to Catch Breath next turn.',
          priority: 3, category: 'story'
        });
      }
    }, 'spurt-agent');

    console.log('[SpurtAgent] Ready — Spurt the Sorcerer is listening');
  }

  stop() {
    // Nothing to clean up
  }

  // ── Dread-Based Personality ──────────────────────────────────────────

  _getSpurtDread() {
    // Spurt uses the average party dread, amplified by 20% (he's more sensitive)
    const players = this.state.get('players') || {};
    const scores = Object.values(players)
      .map(p => p.dread?.score || 0)
      .filter(s => s > 0);

    if (scores.length === 0) return 0;
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    return Math.min(100, Math.round(avg * 1.2));
  }

  _getDreadTier() {
    const dread = this._getSpurtDread();
    if (dread >= 81) return 'manic';
    if (dread >= 61) return 'unhinged';
    if (dread >= 41) return 'anxious';
    return 'normal';
  }

  // ── Character State ──────────────────────────────────────────────────

  _getSpurtCharacter() {
    // Try state first, fall back to config file
    const fromState = this.state.get(`players.${this._spurtId}.character`);
    if (fromState) return fromState;

    try {
      return JSON.parse(fs.readFileSync(
        path.join(__dirname, '..', '..', 'config', 'characters', `${this._ddbId}.json`), 'utf-8'
      ));
    } catch (e) {
      return null;
    }
  }

  _getSpurtCombatant() {
    const combat = this.state.get('combat') || {};
    return combat.turnOrder?.find(c => c.id === this._spurtId) || null;
  }

  _buildSpurtContext(extraContext = '') {
    const char = this._getSpurtCharacter();
    const dread = this._getSpurtDread();
    const tier = this._getDreadTier();
    const combatant = this._getSpurtCombatant();
    const combat = this.state.get('combat') || {};

    const parts = [];
    parts.push(`## Spurt's Current State`);
    parts.push(`Dread Level: ${dread}/100 (personality mode: ${tier.toUpperCase()})`);

    if (char) {
      const hp = char.hp || {};
      parts.push(`HP: ${hp.current || '?'}/${hp.max || '?'} | AC: ${char.ac || 12}`);
      parts.push(`Spell Slots: ${JSON.stringify(char.spellSlots || 'unknown')}`);
      const spellNames = (char.spells || []).map(s => `${s.name} (Lv${s.level})`).join(', ');
      parts.push(`Known Spells: ${spellNames}`);
      const weapons = (char.attacks || []).map(a => `${a.name} (+${a.toHit} to hit, ${a.damage} ${a.damageType})`).join(', ');
      parts.push(`Weapons: ${weapons}`);
      const items = (char.inventory || []).filter(i => !['Weapon', 'Armor'].includes(i.type) && i.quantity > 0)
        .map(i => `${i.name}${i.quantity > 1 ? ' x' + i.quantity : ''}`).join(', ');
      if (items) parts.push(`Items: ${items}`);
    }

    if (combatant) {
      parts.push(`\n## Combat State`);
      parts.push(`Round: ${combat.round || 1}`);
      parts.push(`Spurt HP: ${combatant.hp.current}/${combatant.hp.max} | Conditions: ${combatant.conditions.join(', ') || 'none'}`);

      const allies = combat.turnOrder.filter(c => c.type === 'pc' && c.id !== this._spurtId && c.isAlive);
      const enemies = combat.turnOrder.filter(c => c.type === 'npc' && c.isAlive);
      if (allies.length) parts.push(`Allies: ${allies.map(a => `${a.name} HP:${a.hp.current}/${a.hp.max}`).join(', ')}`);
      if (enemies.length) parts.push(`Enemies: ${enemies.map(e => `${e.name} HP:${e.hp.current}/${e.hp.max} AC:${e.ac}`).join(', ')}`);
    }

    if (this._activeEffects.length) {
      parts.push(`\nActive Wild Magic Effects: ${this._activeEffects.join('; ')}`);
    }

    // Recent dialogue history for Spurt
    if (this._dialogueHistory.length) {
      parts.push(`\nSpurt's recent dialogue: ${this._dialogueHistory.slice(-5).map(d => `"${d}"`).join(' | ')}`);
    }

    // Add game context
    const atmoCtx = this.ctx.buildAtmosphereContext();
    const ctxStr = this.ctx.toPromptString(atmoCtx);
    parts.push(`\n${ctxStr}`);

    if (extraContext) parts.push(`\n## Additional Context\n${extraContext}`);

    return parts.join('\n');
  }

  // ── Dialogue Generation ──────────────────────────────────────────────

  async _generateDialogue(prompt, forceSend = false) {
    if (!this.gemini.available) return null;

    // Cooldown check (unless forced)
    if (!forceSend && Date.now() - this._lastDialogueTime < this._dialogueCooldownMs) return null;

    const context = this._buildSpurtContext();
    const tier = this._getDreadTier();

    const fullPrompt = `${prompt}\n\n${context}\n\nRespond as Spurt in his ${tier.toUpperCase()} personality mode. Type: dialogue. Remember: ONLY spoken words, no narration.`;

    const response = await this.gemini.generate(
      this._systemPrompt,
      fullPrompt,
      { maxTokens: 200, temperature: tier === 'manic' ? 1.0 : tier === 'unhinged' ? 0.95 : 0.85 }
    );

    if (!response || response.trim() === 'SILENCE') return null;

    let dialogue = response.trim()
      .replace(/^["']|["']$/g, '')
      .replace(/^Spurt:\s*/i, '');

    this._dialogueHistory.push(dialogue);
    if (this._dialogueHistory.length > 20) this._dialogueHistory.shift();
    this._lastDialogueTime = Date.now();

    // Dispatch to dashboard and players
    this.bus.dispatch('spurt:dialogue', {
      text: dialogue,
      dreadTier: tier,
      dread: this._getSpurtDread()
    });

    // Whisper to DM earbud
    this.bus.dispatch('dm:whisper', {
      text: `Spurt says: ${dialogue}`,
      priority: 5,
      category: 'npc'
    });

    // Send to all players as NPC dialogue
    this.bus.dispatch('npc:approved', {
      id: `spurt-${Date.now()}`,
      npc: 'Spurt',
      npcId: this._spurtId,
      text: dialogue,
      voiceProfile: 'spurt',
      autoApproved: true
    });

    return dialogue;
  }

  // ── Combat Actions ───────────────────────────────────────────────────

  async _onCombatStart(combat) {
    const dread = this._getSpurtDread();
    let prompt;
    if (dread >= 80) {
      prompt = 'Combat has just begun! Spurt is in a manic state. React with a battle cry or panicked exclamation.';
    } else if (dread >= 60) {
      prompt = 'Combat has just begun! Spurt is unhinged. React with a mix of terror and inappropriate excitement.';
    } else if (dread >= 40) {
      prompt = 'Combat has just begun! Spurt is anxious but determined. React with nervous determination.';
    } else {
      prompt = 'Combat has just begun! Spurt is ready to fight. React with eager kobold battle spirit.';
    }
    await this._generateDialogue(prompt, true);
  }

  async _onCombatTurn(turnData, manualPrompt = null) {
    if (!this.gemini.available) return;

    const context = this._buildSpurtContext(manualPrompt || '');
    const tier = this._getDreadTier();
    const combatant = this._getSpurtCombatant();

    if (!combatant || !combatant.isAlive) return;

    const prompt = manualPrompt
      ? `It's Spurt's turn in combat. The DM wants Spurt to: ${manualPrompt}\n\n${context}`
      : `It's Spurt's turn in combat. Decide what Spurt does this turn.\n\n${context}`;

    const fullPrompt = `${prompt}\n\nPersonality mode: ${tier.toUpperCase()}. Type: combat.\nRespond with JSON for combat action. Include dialogue.`;

    const response = await this.gemini.generateJSON(
      this._systemPrompt,
      fullPrompt,
      { maxTokens: 400, temperature: tier === 'manic' ? 1.0 : 0.8 }
    );

    if (!response) {
      // Fallback: basic attack
      const fallback = this._fallbackCombatAction(combatant);
      this._executeCombatAction(fallback);
      return;
    }

    // Validate and execute the action
    this._executeCombatAction(response);
  }

  _fallbackCombatAction(combatant) {
    const combat = this.state.get('combat') || {};
    const enemies = (combat.turnOrder || []).filter(c => c.type === 'npc' && c.isAlive);
    const allies  = (combat.turnOrder || []).filter(c => c.type === 'pc'  && c.isAlive && c.id !== combatant.id);

    // Task 11 (session0-polish follow-up) — retreat threshold raised from
    // 30% to 50% so Spurt models conservative play for the teaching session.
    if (combatant.hp.current <= combatant.hp.max * 0.5) {
      return {
        action: 'dodge',
        target: null,
        dialogue: 'Spurt is hurt! Spurt gets behind a wall!',
        reasoning: 'HP below 50% threshold — retreat + Dodge action.'
      };
    }

    // Task 11 — tactical target pick. Priority ladder:
    //   1. enemy spellcaster (class contains cleric/wizard/sorcerer/warlock/bard/druid)
    //   2. enemy healer (cleric/paladin/druid)
    //   3. enemy ranged striker (ranger/archer/rogue)
    //   4. nearest-by-map-position
    // Skip any target that has an ally within 5ft (friendly-fire avoidance
    // for ranged attacks — Spurt's Sorcerous Burst is ranged).
    const target = this._pickTacticalTarget(combatant, enemies, allies)
                || enemies[0];

    // Tactical callout dialogue — if Spurt noticed a flanked/caster threat
    // targeting a squishy ally, surface it (once per decision).
    const callout = this._tacticalCallout(combatant, enemies, allies);
    if (callout) {
      try { this.bus.dispatch('chat:message', { from: 'Spurt', text: callout, channel: 'ic' }); } catch (e) {}
    }

    // Default: Sorcerous Burst at the picked target
    return {
      action: 'cast_spell',
      spell: 'Sorcerous Burst',
      slotLevel: 0,
      target: target?.name || 'nearest enemy',
      dialogue: 'Spurt blasts the bad thing! Yes yes!',
      reasoning: 'Default cantrip attack at range'
    };
  }

  /**
   * Task 11 (session0-polish follow-up) — tactical target picker.
   * Priority: caster > healer > ranged > nearest-by-map-position.
   * Avoids targets who have an allied PC within 5ft (friendly-fire safety
   * for Spurt's ranged cantrip). Returns null if no usable target found.
   */
  _pickTacticalTarget(combatant, enemies, allies) {
    if (!enemies || enemies.length === 0) return null;

    const NpcTactics = require('../combat/npc-tactics');
    const gridSize = this.state.get('map.gridSize') || 140;
    const selfTok = this.state.get(`map.tokens.${combatant.id}`);

    const isCaster = (c) => /wizard|sorcer|warlock|bard|druid|cleric/i.test(
      c.name + ' ' + (c.class || '') + ' ' + (c.actorSlug || '')
    );
    const isHealer = (c) => /cleric|paladin|druid/i.test(
      c.name + ' ' + (c.class || '')
    );
    const isRanged = (c) => /ranger|archer|rogue/i.test(
      c.name + ' ' + (c.class || '')
    );

    const hasAllyAdjacent = (enemy) => {
      const eTok = this.state.get(`map.tokens.${enemy.id}`);
      if (!eTok || typeof eTok.x !== 'number') return false;
      for (const a of allies) {
        const aTok = this.state.get(`map.tokens.${a.id}`);
        if (!aTok || typeof aTok.x !== 'number') continue;
        if (NpcTactics.distanceFeet(aTok, eTok, gridSize) <= 5) return true;
      }
      return false;
    };

    // Filter out friendly-fire candidates first
    const safeEnemies = enemies.filter(e => !hasAllyAdjacent(e));
    const pool = safeEnemies.length > 0 ? safeEnemies : enemies;  // degrade gracefully if every enemy has adjacent allies

    // Priority ladders
    const caster = pool.find(isCaster);
    if (caster) return caster;
    const healer = pool.find(isHealer);
    if (healer) return healer;
    const ranged = pool.find(isRanged);
    if (ranged) return ranged;

    // Nearest by map position
    if (selfTok && typeof selfTok.x === 'number') {
      let best = null, bestDist = Infinity;
      for (const e of pool) {
        const eTok = this.state.get(`map.tokens.${e.id}`);
        if (!eTok || typeof eTok.x !== 'number') continue;
        const d = NpcTactics.distanceFeet(selfTok, eTok, gridSize);
        if (d < bestDist) { bestDist = d; best = e; }
      }
      if (best) return best;
    }

    return pool[0];
  }

  /**
   * Task 11 — verbal tactical callout. If a dangerous enemy is targeting
   * a squishy ally (low HP or caster), Spurt says something in character.
   * Returns null if no callout is warranted.
   */
  _tacticalCallout(combatant, enemies, allies) {
    for (const ally of allies) {
      const pctHp = ally.hp?.current / Math.max(1, ally.hp?.max || 1);
      if (pctHp > 0.3) continue;           // only call out for critically wounded allies
      const threat = enemies.find(e => e.isAlive && e.hp?.current > 0);
      if (!threat) return null;
      return `${ally.name} is hurt! The ${threat.name || 'monster'} is after them — Spurt sees it!`;
    }
    return null;
  }

  _executeCombatAction(action) {
    // Store dialogue
    if (action.dialogue) {
      this._dialogueHistory.push(action.dialogue);
      if (this._dialogueHistory.length > 20) this._dialogueHistory.shift();
    }

    // Dispatch the combat action for DM approval
    this.bus.dispatch('spurt:combat_action', {
      action: action.action,
      spell: action.spell || null,
      slotLevel: action.slotLevel || 0,
      target: action.target || null,
      movement: action.movement || null,
      dialogue: action.dialogue || null,
      reasoning: action.reasoning || null,
      dreadTier: this._getDreadTier(),
      dread: this._getSpurtDread()
    });

    // Whisper action to DM earbud
    const actionDesc = action.spell
      ? `${action.action}: ${action.spell} on ${action.target || 'enemy'}`
      : `${action.action}${action.target ? ' on ' + action.target : ''}`;

    this.bus.dispatch('dm:whisper', {
      text: `Spurt wants to ${actionDesc}. ${action.reasoning || ''}`,
      priority: 2,
      category: 'story'
    });

    // Check for wild magic surge if spell slot used
    if (action.slotLevel && action.slotLevel >= 1) {
      this._checkWildMagicSurge();
    }
  }

  // ── Wild Magic Surge ─────────────────────────────────────────────────

  _rollD100() {
    return Math.floor(Math.random() * 100) + 1;
  }

  _rollD20() {
    return Math.floor(Math.random() * 20) + 1;
  }

  _checkWildMagicSurge() {
    // Wild Magic Sorcerer: after casting a leveled spell, DM can have you roll d20.
    // On a 1, roll on the Wild Magic Surge table.
    const d20 = this._rollD20();

    this.bus.dispatch('spurt:wild_magic_check', {
      d20Roll: d20,
      triggered: d20 === 1
    });

    // Whisper to DM
    this.bus.dispatch('dm:whisper', {
      text: d20 === 1
        ? `WILD MAGIC SURGE! Spurt rolled a 1 on the Wild Magic check!`
        : `Spurt's Wild Magic check: d20=${d20} (no surge)`,
      priority: d20 === 1 ? 1 : 4,
      category: 'story'
    });

    if (d20 === 1) {
      const surge = this._rollWildMagicSurge();
      this.bus.dispatch('spurt:surge_result', surge);
      return surge;
    }
    return null;
  }

  _rollWildMagicSurge() {
    const roll = this._rollD100();
    const entry = WILD_MAGIC_TABLE.find(e => roll >= e.range[0] && roll <= e.range[1]);
    this._surgeCount++;

    const surge = {
      d100Roll: roll,
      effect: entry?.effect || 'Unknown magical effect',
      category: entry?.category || 'unknown',
      selfHarm: entry?.selfHarm || false,
      spell: entry?.spell || null,
      damage: entry?.damage || null,
      damageType: entry?.damageType || null,
      silenced: entry?.silenced || false,
      surgeNumber: this._surgeCount
    };

    // Track active effect
    this._activeEffects.push(`Surge #${this._surgeCount}: ${surge.effect}`);
    if (this._activeEffects.length > 5) this._activeEffects.shift();

    // Whisper the result to DM
    this.bus.dispatch('dm:whisper', {
      text: `WILD MAGIC SURGE (d100=${roll}): ${surge.effect}`,
      priority: 1,
      category: 'dread'
    });

    // Generate Spurt's reaction to the surge
    this._reactToSurge(surge);

    return surge;
  }

  async _reactToSurge(surge) {
    const dread = this._getSpurtDread();
    let prompt;

    if (surge.selfHarm) {
      prompt = `Spurt's wild magic just surged dangerously: "${surge.effect}". React with alarm or manic glee depending on dread level.`;
    } else if (surge.category === 'cosmetic') {
      prompt = `Spurt's wild magic just caused a weird cosmetic effect: "${surge.effect}". React with confusion or delight.`;
    } else if (surge.category === 'buff') {
      prompt = `Spurt's wild magic just gave a beneficial effect: "${surge.effect}". React with surprised excitement.`;
    } else {
      prompt = `Spurt's wild magic just surged: "${surge.effect}". React in character.`;
    }

    await this._generateDialogue(prompt, true);
  }

  // ── Event Reactions ──────────────────────────────────────────────────

  async _reactToEvent(eventType, description) {
    if (!this.gemini.available) return;
    if (Date.now() - this._lastDialogueTime < this._dialogueCooldownMs) return;

    let prompt;
    switch (eventType) {
      case 'npc_dialogue':
        prompt = `An NPC just spoke. ${description}. If Spurt would naturally react or interject, generate his response. If not, respond with SILENCE.`;
        break;
      case 'atmosphere':
        prompt = `The mood has shifted dramatically. ${description}. Spurt notices the change — how does he react?`;
        break;
      case 'secret':
        prompt = `Something important was just revealed. ${description}. How does Spurt react to this revelation?`;
        break;
      default:
        prompt = `Something happened: ${description}. How does Spurt react?`;
    }

    await this._generateDialogue(prompt);
  }

  // ── Stats ────────────────────────────────────────────────────────────

  getStats() {
    return {
      dread: this._getSpurtDread(),
      dreadTier: this._getDreadTier(),
      dialogueCount: this._dialogueHistory.length,
      surgeCount: this._surgeCount,
      activeEffects: this._activeEffects.length,
      lastDialogue: this._dialogueHistory[this._dialogueHistory.length - 1] || null
    };
  }
}

module.exports = SpurtAgent;
