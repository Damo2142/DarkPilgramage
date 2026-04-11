/**
 * Communication Router — Section 6
 *
 * Routes player chat input across six channels:
 *   1. Player → Max (action declaration)
 *   2. Player → Max (dice result)
 *   3. Player → NPC (direct conversation)
 *   4. NPC → players (public, proximity-based)
 *   5. NPC → player (private, single recipient)
 *   6. Player → player (P2P, never surfaces to narrator)
 *
 * Implements:
 *   - Wake-word and NPC-name detection (priority order)
 *   - Proximity-based hearing tiers (FULL/PARTIAL/NOTHING)
 *   - Hearing modifiers (Mark of Detection, Keen Hearing, helms,
 *     deafened, environment noise)
 *   - Private intent detection
 *   - Physical dice parsing and modifier application
 */

// Words that mark a message as a private NPC interaction
const PRIVATE_INTENT_KEYWORDS = [
  'privately', 'whisper', 'quietly', 'alone', 'pull aside',
  'just between us', 'in private', 'lower my voice', 'lean in',
  'quietly asks', 'aside'
];

// Words that mark a dice declaration to Max
const DICE_KEYWORDS = [
  'rolled', 'rolls', 'rolling', 'roll'
];

// Roll types — pattern matches in declared text
const ROLL_TYPES = {
  attack: /\b(to\s*hit|attack|hit\b)/i,
  damage: /\b(damage|dmg)/i,
  save: /\b(save|saving\s*throw|sav)/i,
  check: /\b(check|skill|investigation|perception|stealth|athletics|acrobatics|persuasion|insight|history|arcana|nature|religion|medicine|survival|deception|intimidation|performance)/i,
  initiative: /\b(initiative|init)/i
};

// Lazy-loaded master language registry (config/languages.json)
let _LANGUAGE_REGISTRY = null;
function loadLanguageRegistry() {
  if (_LANGUAGE_REGISTRY) return _LANGUAGE_REGISTRY;
  try {
    const path = require('path');
    const fs = require('fs');
    const p = path.join(__dirname, '..', '..', 'config', 'languages.json');
    if (fs.existsSync(p)) {
      const data = JSON.parse(fs.readFileSync(p, 'utf8'));
      const map = {};
      (data.languages || []).forEach(l => { map[l.id] = l; });
      _LANGUAGE_REGISTRY = map;
    } else {
      _LANGUAGE_REGISTRY = {};
    }
  } catch (e) {
    console.warn('[CommRouter] Could not load languages.json:', e.message);
    _LANGUAGE_REGISTRY = {};
  }
  return _LANGUAGE_REGISTRY;
}

// Atmosphere noise level (feet of hearing reduction)
const ATMOSPHERE_NOISE = {
  tavern_warm: 0,
  tavern_tense: -5,
  tavern_dark: -5,
  investigation: 0,
  dread_rising: -10,
  terror_peak: -10,
  combat: -20,
  revelation: 0,
  dawn: 0,
  blizzard_dark: -15,
  home_normal: 0
};

class CommRouter {
  constructor(orchestrator, bus, state, config) {
    this.orchestrator = orchestrator;
    this.bus = bus;
    this.state = state;
    this.config = config;

    // Cache of NPC names + aliases for routing detection
    this._npcNameMap = {};   // lowercase first-word → npcId
    this._playerNameMap = {}; // lowercase first-word → playerId

    // Default base hearing radius in feet
    this.baseHearingFeet = 30;

    // Audio routing settings (mirrors Section 25 toggles)
    this._languageRouting = { earbudOnly: false, ambientMurmur: false };
  }

  init() {
    // Build name caches once on startup, refresh on state changes
    this._refreshNameCache();

    this.bus.subscribe('characters:loaded', () => this._refreshNameCache(), 'comm-router');
    this.bus.subscribe('state:session_loaded', () => this._refreshNameCache(), 'comm-router');

    // Primary chat handling — intercepts player:chat events
    this.bus.subscribe('player:chat', (env) => {
      try {
        this.routePlayerInput(env.data || {});
      } catch (e) {
        console.warn('[CommRouter] route error:', e.message);
      }
    }, 'comm-router');

    // Voice transcription that's NOT a Max wake word also goes through routing
    this.bus.subscribe('transcript:player', (env) => {
      try {
        const d = env.data || {};
        if (!d.playerId) return;
        this.routePlayerInput({ playerId: d.playerId, text: d.text || '' });
      } catch (e) {}
    }, 'comm-router');

    // NPC dialogue dispatched by AI engine — apply proximity routing
    this.bus.subscribe('npc:approved', (env) => {
      try { this.routeNpcSpeech(env.data || {}); } catch (e) {}
    }, 'comm-router');

    console.log('[CommRouter] 6-channel communication routing active');
  }

  // ─── Name caches ───────────────────────────────────────────────

  _refreshNameCache() {
    this._npcNameMap = {};
    const npcs = this.state.get('npcs') || {};
    for (const [id, n] of Object.entries(npcs)) {
      if (!n || !n.name) continue;
      const first = n.name.split(' ')[0].toLowerCase();
      if (first.length > 2) this._npcNameMap[first] = id;
      // Also alias publicName / addressableAs
      if (n.publicName) {
        const pf = n.publicName.split(' ')[0].toLowerCase();
        if (pf.length > 2) this._npcNameMap[pf] = id;
      }
      if (Array.isArray(n.addressableAs)) {
        n.addressableAs.forEach(alias => {
          const af = String(alias).split(' ')[0].toLowerCase();
          if (af.length > 2) this._npcNameMap[af] = id;
        });
      }
    }
    // Patron NPCs from config root
    const cfg = this.config || {};
    ['patron-farmer', 'patron-merchant', 'patron-pilgrim', 'patron-minstrel'].forEach(k => {
      const p = cfg[k];
      if (p && p.name) {
        const first = p.name.split(' ')[0].toLowerCase();
        if (first.length > 2) this._npcNameMap[first] = k;
      }
    });

    this._playerNameMap = {};
    const players = this.state.get('players') || {};
    for (const [pid, p] of Object.entries(players)) {
      const name = p?.character?.name;
      if (!name) continue;
      const first = name.split(' ')[0].toLowerCase();
      if (first.length > 2) this._playerNameMap[first] = pid;
    }

    console.log(`[CommRouter] Name cache: ${Object.keys(this._npcNameMap).length} NPCs, ${Object.keys(this._playerNameMap).length} players`);
  }

  // ─── Wake-word detection ───────────────────────────────────────

  /**
   * Determine which channel a player message belongs to.
   * Priority: Max → NPC → Player (P2P) → ambient
   */
  detectChannel(text) {
    if (!text) return { channel: 'ambient' };
    const lower = text.trim().toLowerCase();
    const firstWord = lower.split(/[\s,.:?!]+/)[0];

    // Channel 1/2: Max wake word
    if (firstWord === 'max' || firstWord === 'hal') {
      // Distinguish action vs dice
      const rest = text.replace(/^(max|hal)[\s,.:?!]+/i, '');
      const isDice = DICE_KEYWORDS.some(k => new RegExp('\\b' + k + '\\b', 'i').test(rest));
      return { channel: isDice ? 'max-dice' : 'max-action', text: rest };
    }

    // Channel 3: NPC name first word
    const npcId = this._npcNameMap[firstWord];
    if (npcId) {
      // Strip NPC name from text for cleaner prompt
      const stripped = text.replace(new RegExp('^' + firstWord + '[\\s,.:?!]+', 'i'), '');
      return { channel: 'npc-direct', npcId, text: stripped };
    }

    // Channel 6: Player name first word — P2P
    const playerId = this._playerNameMap[firstWord];
    if (playerId) {
      const stripped = text.replace(new RegExp('^' + firstWord + '[\\s,.:?!]+', 'i'), '');
      return { channel: 'p2p', toPlayerId: playerId, text: stripped };
    }

    return { channel: 'ambient' };
  }

  // ─── Main router ───────────────────────────────────────────────

  routePlayerInput(data) {
    const { playerId, text } = data;
    if (!playerId || !text) return;

    // Detect language switch in player utterance (e.g. "in Draconic", "in Elvish", "in Slovak")
    const langId = this._detectLanguageHint(text);
    if (langId) {
      try { this.checkPlayerLanguageRecognition(playerId, langId); } catch (e) {}
    }

    const detection = this.detectChannel(text);
    detection.fromPlayerId = playerId;
    detection.originalText = text;
    detection.languageId = langId;

    switch (detection.channel) {
      case 'max-action':
        return this._routeMaxAction(playerId, detection.text || text);
      case 'max-dice':
        return this._routeMaxDice(playerId, detection.text || text);
      case 'npc-direct':
        return this._routeNpcDirect(playerId, detection.npcId, detection.text, text);
      case 'p2p':
        return this._routeP2P(playerId, detection.toPlayerId, detection.text || text);
      case 'ambient':
        // System ignores — table talk
        return;
    }
  }

  // ─── Channel 1 — Player → Max (action) ─────────────────────────

  _routeMaxAction(playerId, query) {
    const charName = this._charName(playerId);
    // Prepend "[Action declaration from Character]" so Max prompt sees it as game action
    const fullQuery = `[Action declaration from ${charName}] ${query}`;
    this.bus.dispatch('dm:whisper', {
      text: `[ACTION] ${charName}: ${query}`,
      priority: 2,
      category: 'action',
      source: 'comm-router'
    });
    // Forward to Max query handler
    const aiEngine = this.orchestrator.getService('ai-engine');
    if (aiEngine && typeof aiEngine.halQuery === 'function') {
      aiEngine.halQuery(fullQuery, 'player-action').catch(() => {});
    }
  }

  // ─── Channel 2 — Player → Max (dice) ───────────────────────────

  _routeMaxDice(playerId, declaration) {
    const charName = this._charName(playerId);
    const parsed = this.parseDiceDeclaration(declaration, playerId);
    if (!parsed.value && parsed.value !== 0) {
      // Couldn't parse a number
      this.bus.dispatch('dm:whisper', {
        text: `[DICE] ${charName}: ${declaration} — could not parse number, please clarify`,
        priority: 2, category: 'dice', source: 'comm-router'
      });
      return;
    }
    const result = this.applyDiceModifiers(parsed, playerId);
    // Whisper full result to narrator earbud
    this.bus.dispatch('dm:whisper', {
      text: `[DICE] ${charName} rolled ${parsed.value} ${result.rollType}: ${result.summary}`,
      priority: 1,
      category: 'dice',
      source: 'comm-router'
    });
    this.bus.dispatch('voice:speak', {
      text: result.summary,
      profile: 'max',
      device: 'earbud',
      useElevenLabs: true
    });
  }

  parseDiceDeclaration(text, playerId) {
    const lower = text.toLowerCase();
    // Detect roll type
    let rollType = 'check';
    for (const [type, re] of Object.entries(ROLL_TYPES)) {
      if (re.test(lower)) { rollType = type; break; }
    }
    // Extract first number
    const numMatch = text.match(/-?\d+/);
    const value = numMatch ? parseInt(numMatch[0]) : null;
    // Detect target NPC
    let targetNpcId = null;
    for (const [name, id] of Object.entries(this._npcNameMap)) {
      if (lower.includes(name)) { targetNpcId = id; break; }
    }
    // Detect weapon
    const weaponWords = ['longsword', 'shortsword', 'dagger', 'crossbow', 'bow', 'mace', 'spear', 'axe', 'rapier', 'staff', 'club'];
    let weapon = null;
    for (const w of weaponWords) {
      if (lower.includes(w)) { weapon = w; break; }
    }
    return { rollType, value, targetNpcId, weapon, raw: text };
  }

  applyDiceModifiers(parsed, playerId) {
    const ch = this.state.get(`players.${playerId}.character`) || {};
    const charName = ch.name || playerId;
    let bonus = 0;
    let bonusBreakdown = '';
    let total = parsed.value || 0;

    if (parsed.rollType === 'attack') {
      // Attack bonus from weapon + str/dex mod + proficiency
      const profBonus = ch.proficiencyBonus || 2;
      const strMod = (ch.abilities?.str?.modifier) || 0;
      const dexMod = (ch.abilities?.dex?.modifier) || 0;
      // Use the higher mod (assume finesse-aware)
      const useDex = parsed.weapon && /dagger|rapier|shortsword|bow|crossbow/.test(parsed.weapon);
      const abilityMod = useDex ? dexMod : Math.max(strMod, dexMod);
      bonus = profBonus + abilityMod;
      bonusBreakdown = `+${profBonus} prof ${abilityMod >= 0 ? '+' : ''}${abilityMod} ${useDex ? 'dex' : 'str'}`;
      total = parsed.value + bonus;
      const targetTok = parsed.targetNpcId && this.state.get(`map.tokens.${parsed.targetNpcId}`);
      const targetAC = targetTok?.ac || (parsed.targetNpcId && this.state.get(`npcs.${parsed.targetNpcId}.ac`)) || null;
      let outcome = '';
      if (targetAC) {
        outcome = total >= targetAC ? `Hits AC ${targetAC}.` : `Misses AC ${targetAC}.`;
      } else {
        outcome = 'Roll damage if it connects.';
      }
      const targetName = parsed.targetNpcId ? (this.state.get(`npcs.${parsed.targetNpcId}.name`) || parsed.targetNpcId) : 'target';
      return {
        rollType: 'attack',
        bonus, total, summary: `${parsed.value} ${bonusBreakdown} — ${total} total against ${targetName}. ${outcome}`
      };
    }
    if (parsed.rollType === 'damage') {
      const strMod = (ch.abilities?.str?.modifier) || 0;
      const dexMod = (ch.abilities?.dex?.modifier) || 0;
      const useDex = parsed.weapon && /dagger|rapier|shortsword|bow|crossbow/.test(parsed.weapon);
      const abilityMod = useDex ? dexMod : Math.max(strMod, dexMod);
      bonus = abilityMod;
      total = parsed.value + bonus;
      return {
        rollType: 'damage',
        bonus, total, summary: `${parsed.value} ${abilityMod >= 0 ? '+' : ''}${abilityMod} = ${total} damage.`
      };
    }
    if (parsed.rollType === 'save') {
      total = parsed.value;
      return {
        rollType: 'save',
        bonus: 0, total,
        summary: `Save total ${total}. Apply ability and proficiency manually if not yet included.`
      };
    }
    // Default check
    return {
      rollType: parsed.rollType,
      bonus: 0, total: parsed.value,
      summary: `${parsed.rollType}: ${parsed.value} (apply skill modifier).`
    };
  }

  // ─── Channel 3 — Player → NPC (direct) ─────────────────────────

  _routeNpcDirect(playerId, npcId, query, originalText) {
    const charName = this._charName(playerId);
    const isPrivate = this._isPrivateIntent(originalText);

    this.bus.dispatch('dm:whisper', {
      text: `[NPC] ${charName} → ${npcId}${isPrivate ? ' (private)' : ''}: ${query}`,
      priority: 3, category: 'npc', source: 'comm-router'
    });

    // Hand off to NPC dialogue handler
    const aiEngine = this.orchestrator.getService('ai-engine');
    if (aiEngine && aiEngine.npc && typeof aiEngine.npc.generateDialogue === 'function') {
      // Tag with private intent and source player so the response router knows
      aiEngine.npc.generateDialogue(npcId, `[Spoken by ${charName}${isPrivate ? ' privately' : ''}]: ${query}`)
        .then((suggestion) => {
          if (suggestion) {
            suggestion._private = isPrivate;
            suggestion._sourcePlayerId = playerId;
          }
        })
        .catch(() => {});
    }
  }

  _isPrivateIntent(text) {
    if (!text) return false;
    const lower = text.toLowerCase();
    return PRIVATE_INTENT_KEYWORDS.some(k => lower.includes(k));
  }

  /**
   * Detect a language hint in player text. Recognises forms like
   * "in Draconic", "in Elvish", "speaks Slovak", "switches to German".
   * Returns language id from registry or null.
   */
  _detectLanguageHint(text) {
    if (!text) return null;
    const registry = loadLanguageRegistry();
    const lower = text.toLowerCase();
    // Patterns: "in <lang>", "speaks <lang>", "in <lang>:", "(in <lang>)"
    const patterns = [
      /\bin\s+([a-z][a-z\s]+?)(?:[:.,)\]]|$)/i,
      /\bspeak(?:s|ing)?\s+([a-z][a-z\s]+?)(?:[:.,)\]]|$)/i,
      /\bswitch(?:es|ing)?\s+to\s+([a-z][a-z\s]+?)(?:[:.,)\]]|$)/i,
      /\b\(in\s+([a-z][a-z\s]+?)\)/i
    ];
    for (const re of patterns) {
      const m = lower.match(re);
      if (!m) continue;
      const candidate = m[1].trim().split(/\s+/)[0]; // first word of the captured phrase
      // Direct id match
      if (registry[candidate]) return candidate;
      // Match by language name
      for (const [id, lang] of Object.entries(registry)) {
        const lname = (lang.name || '').toLowerCase();
        const dname = (lang.displayName || '').toLowerCase();
        if (lname === candidate || dname === candidate || lname.startsWith(candidate)) return id;
      }
      // Special: "elvish" → elvish_americas (only Americas elvish exists in registry)
      if (candidate === 'elvish' && registry['elvish_americas']) return 'elvish_americas';
    }
    return null;
  }

  // ─── Channel 4/5 — NPC → players (proximity routing) ───────────

  routeNpcSpeech(npcDialogue) {
    // npcDialogue: { npcId, npc, text, voiceProfile, _private, _sourcePlayerId, languageId? }
    const npcId = npcDialogue.npcId;
    if (!npcId) return;
    const text = npcDialogue.text || '';
    const languageId = npcDialogue.languageId || null; // optional override; otherwise resolver picks NPC's primary

    // PRIVATE — only the source player hears (still apply language barrier)
    if (npcDialogue._private && npcDialogue._sourcePlayerId) {
      const lr = this.resolveLanguage(npcId, npcDialogue._sourcePlayerId, { languageId });
      const adjustedText = this._applyLanguageTier(text, lr);
      this._sendNpcAudioToPlayer(npcDialogue._sourcePlayerId, npcId, adjustedText, 'FULL', lr);
      this.bus.dispatch('dm:whisper', {
        text: `[NPC private] ${npcDialogue.npc || npcId} → ${this._charName(npcDialogue._sourcePlayerId)}: ${lr.result}${lr.via ? ' via ' + lr.via : ''}`,
        priority: 3, category: 'npc', source: 'comm-router'
      });
      const adjacent = this._findAdjacentPlayers(npcDialogue._sourcePlayerId, npcId);
      if (adjacent.length) {
        this.bus.dispatch('dm:whisper', {
          text: `[NPC private] ${adjacent.map(p => this._charName(p)).join(', ')} adjacent — eavesdropping possible.`,
          priority: 2, category: 'npc', source: 'comm-router'
        });
      }
      return;
    }

    // PUBLIC — proximity routing combined with language barrier
    const tiers = this._calculateHearingTiers(npcId);
    const fullPlayers = [];
    const partialPlayers = [];
    const barrierPlayers = [];
    const bridgePlayers = [];
    for (const [pid, tier] of Object.entries(tiers)) {
      if (tier === 'NOTHING') continue;
      const lr = this.resolveLanguage(npcId, pid, { languageId });
      // Combine: if either proximity or language is partial, listener gets partial.
      // Barrier always wins (player hears sound but cannot understand).
      let finalTier = tier;
      if (lr.result === 'BARRIER') finalTier = 'BARRIER';
      else if (lr.result === 'KATYA_BRIDGE') finalTier = 'KATYA_BRIDGE';
      else if (lr.result === 'PARTIAL' && tier === 'FULL') finalTier = 'PARTIAL';

      const adjustedText = this._applyLanguageTier(text, lr);
      this._sendNpcAudioToPlayer(pid, npcId, adjustedText, finalTier, lr);

      const name = this._charName(pid);
      if (finalTier === 'FULL') fullPlayers.push(name);
      else if (finalTier === 'PARTIAL') partialPlayers.push(name);
      else if (finalTier === 'BARRIER') barrierPlayers.push(name);
      else if (finalTier === 'KATYA_BRIDGE') bridgePlayers.push(name);
    }
    // Whisper routing summary to narrator (always include the raw text + language)
    const npcLangs = this._npcLanguages(npcId);
    const spokenLang = languageId || npcLangs.primary || 'common';
    let summary = `[${npcDialogue.npc || npcId}] speaking ${spokenLang}. `;
    if (fullPlayers.length) summary += `Full: ${fullPlayers.join(', ')}. `;
    if (partialPlayers.length) summary += `Partial: ${partialPlayers.join(', ')}. `;
    if (bridgePlayers.length) summary += `Katya translates: ${bridgePlayers.join(', ')}. `;
    if (barrierPlayers.length) summary += `BARRIER: ${barrierPlayers.join(', ')}. `;
    this.bus.dispatch('dm:whisper', {
      text: summary + `\n  RAW: "${text}"`,
      priority: 3, category: 'npc-routing', source: 'comm-router'
    });
  }

  _sendNpcAudioToPlayer(playerId, npcId, text, tier, langResult) {
    let displayText = text;
    // If language tier is already applied (text begins with [marker]), trust it.
    // Otherwise apply proximity-based truncation as before.
    if (tier === 'PARTIAL' && !/^\[/.test(text)) {
      const words = text.split(/\s+/);
      const kept = words.filter((_, i) => i % 3 === 0);
      displayText = '...' + kept.join(' ') + '...';
    }
    const npcName = this.state.get(`npcs.${npcId}.name`) || npcId;
    this.bus.dispatch('player:npc_speech', {
      playerId, npcId, npcName, text: displayText, tier, fullText: text,
      language: langResult ? (langResult.spoken || langResult.sharedLang) : null,
      languageResult: langResult || null
    });
  }

  // ─── Hearing tier calculation ──────────────────────────────────

  _calculateHearingTiers(npcId) {
    const npcTok = this.state.get(`map.tokens.${npcId}`);
    if (!npcTok) {
      // No token — broadcast to all players as PARTIAL
      const players = this.state.get('players') || {};
      const result = {};
      for (const pid of Object.keys(players)) {
        const p = players[pid];
        if (p && (p.absent || p.notYetArrived)) continue;
        result[pid] = 'FULL';
      }
      return result;
    }

    const map = this.state.get('map') || {};
    const gs = map.gridSize || 70;
    const ftPerPx = 5 / gs;

    // Atmosphere noise
    const atmo = this.state.get('atmosphere.currentProfile') || 'tavern_warm';
    const noiseModFt = ATMOSPHERE_NOISE[atmo] || 0;

    const players = this.state.get('players') || {};
    const result = {};
    for (const [pid, p] of Object.entries(players)) {
      if (!p || p.absent || p.notYetArrived) continue;
      const playerTok = this.state.get(`map.tokens.${pid}`);
      if (!playerTok) continue;

      const dx = playerTok.x - npcTok.x;
      const dy = playerTok.y - npcTok.y;
      const distFt = Math.sqrt(dx * dx + dy * dy) * ftPerPx;

      // Compute effective hearing range for this player
      let rangeFt = this.baseHearingFeet + noiseModFt;
      const ch = p.character || {};

      // Modifiers — Mark of Detection
      if (ch.race && /mark of detection/i.test(ch.race)) rangeFt += 10;

      // Keen hearing feat (look in features)
      const features = ch.features || [];
      const hasKeen = features.some(f => /keen hearing/i.test(f.name || f));
      if (hasKeen) rangeFt += 10;

      // Equipped great helm
      const equipped = (ch.inventory || []).filter(i => i.equipped);
      const hasGreatHelm = equipped.some(i => /great helm/i.test(i.name || ''));
      if (hasGreatHelm) rangeFt -= 10;

      // Conditions
      const conditions = p.conditions || [];
      if (conditions.some(c => /deafened/i.test(c))) {
        result[pid] = 'NOTHING';
        continue;
      }
      if (conditions.some(c => /distracted/i.test(c))) rangeFt -= 10;

      // Walls between speaker and listener (rough check — count wall intersections)
      const wallCount = this._countWallsBetween(npcTok.x, npcTok.y, playerTok.x, playerTok.y);
      if (wallCount >= 2) {
        result[pid] = 'PARTIAL';
        continue;
      }

      // Tier assignment
      if (distFt <= rangeFt * 0.7) result[pid] = 'FULL';
      else if (distFt <= rangeFt) result[pid] = 'PARTIAL';
      else result[pid] = 'NOTHING';
    }
    return result;
  }

  _countWallsBetween(x1, y1, x2, y2) {
    const walls = this.state.get('map.walls') || [];
    let count = 0;
    for (const w of walls) {
      if (w.type === 'window' || (w.type === 'door' && w.open)) continue;
      // Line segment intersection
      if (this._segmentsIntersect(x1, y1, x2, y2, w.x1, w.y1, w.x2, w.y2)) count++;
    }
    return count;
  }

  _segmentsIntersect(x1, y1, x2, y2, x3, y3, x4, y4) {
    const denom = (x4 - x3) * (y1 - y2) - (x1 - x2) * (y4 - y3);
    if (denom === 0) return false;
    const t = ((y3 - y4) * (x1 - x3) + (x4 - x3) * (y1 - y3)) / denom;
    const s = ((y1 - y2) * (x1 - x3) + (x2 - x1) * (y1 - y3)) / denom;
    return t >= 0 && t <= 1 && s >= 0 && s <= 1;
  }

  _findAdjacentPlayers(sourcePlayerId, npcId) {
    const npcTok = this.state.get(`map.tokens.${npcId}`);
    if (!npcTok) return [];
    const map = this.state.get('map') || {};
    const gs = map.gridSize || 70;
    const adjacentRangePx = gs * 1.5;
    const players = this.state.get('players') || {};
    const result = [];
    for (const [pid, p] of Object.entries(players)) {
      if (pid === sourcePlayerId) continue;
      if (!p || p.absent || p.notYetArrived) continue;
      const tok = this.state.get(`map.tokens.${pid}`);
      if (!tok) continue;
      const d = Math.sqrt((tok.x - npcTok.x) ** 2 + (tok.y - npcTok.y) ** 2);
      if (d <= adjacentRangePx) result.push(pid);
    }
    return result;
  }

  // ─── Language barrier resolution ───────────────────────────────

  /**
   * Get the structured language list for a player.
   * Returns array of { id, fluency, displayName? }
   */
  _playerLanguages(playerId) {
    const ch = this.state.get(`players.${playerId}.character`) || {};
    if (Array.isArray(ch.languageStructured) && ch.languageStructured.length) {
      return ch.languageStructured;
    }
    if (Array.isArray(ch.languages)) {
      return ch.languages.map(l => {
        if (typeof l === 'string') {
          return { id: l.toLowerCase().replace(/[^a-z_]/g, '_'), displayName: l, fluency: 'fluent' };
        }
        return l;
      });
    }
    return [{ id: 'common', displayName: 'Common', fluency: 'fluent' }];
  }

  /**
   * Get languages an NPC speaks. Returns { ids: [], primary: id, commonFluency }
   */
  _npcLanguages(npcId) {
    // Try state first (active NPCs), then config patron NPCs
    const npc = this.state.get(`npcs.${npcId}`) || (this.config && this.config[npcId]) || null;
    if (!npc) return { ids: ['common'], primary: 'common', commonFluency: 'fluent' };
    const ids = Array.isArray(npc.languages) && npc.languages.length ? npc.languages.slice() : ['common'];
    const primary = npc.primaryLanguage || ids[0];
    const commonFluency = npc.commonFluency || 'fluent';
    return { ids, primary, commonFluency, specialLanguageRules: npc.specialLanguageRules || null };
  }

  /**
   * Resolve a language barrier between an NPC speaking and a player listening.
   *
   * Inputs:
   *   speakerLangId — the language being spoken (defaults to npc.primaryLanguage)
   *   playerId      — the listener
   *   npcId         — the speaker
   *
   * Returns one of:
   *   { result: 'FULL', sharedLang }
   *   { result: 'PARTIAL', sharedLang, partialOf, fluency }
   *   { result: 'KATYA_BRIDGE', via: 'katya' }
   *   { result: 'BARRIER', spoken, knownByPlayer: [...] }
   */
  resolveLanguage(npcId, playerId, options = {}) {
    const registry = loadLanguageRegistry();
    const npcLangs = this._npcLanguages(npcId);
    const playerLangs = this._playerLanguages(playerId);
    const spokenId = options.languageId || npcLangs.primary || 'common';

    const playerLangIds = playerLangs.map(l => l.id);
    const playerLangById = {};
    playerLangs.forEach(l => { playerLangById[l.id] = l; });

    // 1. Direct match — player speaks the language
    if (playerLangById[spokenId]) {
      const fluency = (playerLangById[spokenId].fluency || 'fluent').toLowerCase();
      if (/fluent|native/.test(fluency)) return { result: 'FULL', sharedLang: spokenId, fluency };
      if (/conversational/.test(fluency)) return { result: 'PARTIAL', sharedLang: spokenId, fluency };
      if (/basic/.test(fluency)) return { result: 'PARTIAL', sharedLang: spokenId, fluency: 'basic' };
      return { result: 'FULL', sharedLang: spokenId, fluency };
    }

    // 2. Mutually intelligible language
    const spokenEntry = registry[spokenId] || {};
    const mutual = spokenEntry.mutuallyIntelligibleWith || [];
    for (const m of mutual) {
      if (playerLangById[m]) {
        return { result: 'FULL', sharedLang: m, via: 'mutual', spoken: spokenId };
      }
    }

    // 3. Partially intelligible language
    const partial = spokenEntry.partiallyIntelligibleWith || [];
    for (const p of partial) {
      if (playerLangById[p]) {
        return { result: 'PARTIAL', sharedLang: p, partialOf: spokenId, via: 'partial' };
      }
    }

    // 4. NPC can fall back to Common if speaker has any commonFluency and player has Common
    if (playerLangById['common'] && (npcLangs.ids.includes('common') || npcLangs.commonFluency)) {
      const cf = (npcLangs.commonFluency || 'fluent').toLowerCase();
      if (/fluent/.test(cf)) return { result: 'FULL', sharedLang: 'common', via: 'fallback_common' };
      if (/conversational/.test(cf)) return { result: 'PARTIAL', sharedLang: 'common', via: 'fallback_common', fluency: 'conversational' };
      if (/basic/.test(cf)) return { result: 'PARTIAL', sharedLang: 'common', via: 'fallback_common', fluency: 'basic' };
      if (/none/.test(cf)) {
        // Falls through to Katya bridge / barrier
      } else {
        return { result: 'PARTIAL', sharedLang: 'common', via: 'fallback_common', fluency: cf };
      }
    }

    // 5. Katya bridge — if Katya is present and speaks both
    const katyaPresent = this._isKatyaInRange(npcId, playerId);
    if (katyaPresent) {
      const katyaCfg = (this.config && (this.config['patron-minstrel'] || this.config.katya)) || this.state.get('npcs.katya') || null;
      const katyaLangs = (katyaCfg && katyaCfg.languages) || ['common', 'slovak', 'german', 'french'];
      if (katyaLangs.includes(spokenId)) {
        return { result: 'KATYA_BRIDGE', via: 'katya', spoken: spokenId };
      }
    }

    // 6. Hard barrier
    return { result: 'BARRIER', spoken: spokenId, knownByPlayer: playerLangIds };
  }

  _isKatyaInRange(npcId, playerId) {
    const map = this.state.get('map') || {};
    const gs = map.gridSize || 70;
    const range = gs * 6; // ~30 ft
    const npcTok = this.state.get(`map.tokens.${npcId}`);
    const playerTok = this.state.get(`map.tokens.${playerId}`);
    const katyaTok = this.state.get('map.tokens.katya') || this.state.get('map.tokens.patron-minstrel');
    if (!katyaTok) return false;
    if (!npcTok || !playerTok) return true; // No map context — assume Katya can bridge
    const dn = Math.hypot(katyaTok.x - npcTok.x, katyaTok.y - npcTok.y);
    const dp = Math.hypot(katyaTok.x - playerTok.x, katyaTok.y - playerTok.y);
    return dn <= range && dp <= range;
  }

  /**
   * Apply a language tier transformation to spoken text.
   */
  _applyLanguageTier(text, langResult) {
    if (!langResult || langResult.result === 'FULL') return text;
    if (langResult.result === 'PARTIAL') {
      const words = text.split(/\s+/);
      const kept = words.filter((_, i) => i % 2 === 0); // ~50% words
      return '[' + (langResult.sharedLang || 'partial') + '] ...' + kept.join(' ') + '...';
    }
    if (langResult.result === 'KATYA_BRIDGE') {
      return '[Katya translates from ' + langResult.spoken + '] ' + text;
    }
    if (langResult.result === 'BARRIER') {
      // Player hears sound but no comprehension
      return '[unintelligible — ' + (langResult.spoken || 'foreign tongue') + ']';
    }
    return text;
  }

  /**
   * Fire special-rule whispers when a player speaks a flagged language
   * near an NPC with specialLanguageRules.
   */
  checkPlayerLanguageRecognition(playerId, languageId) {
    if (!languageId) return;
    // Find any NPC with specialLanguageRules near the player
    const npcs = this.state.get('npcs') || {};
    const map = this.state.get('map') || {};
    const gs = map.gridSize || 70;
    const range = gs * 8; // generous — recognition does not require closeness
    const playerTok = this.state.get(`map.tokens.${playerId}`);
    const charName = this._charName(playerId);

    for (const [npcId, npc] of Object.entries(npcs)) {
      const cfg = npc || (this.config && this.config[npcId]) || null;
      const rules = cfg && cfg.specialLanguageRules;
      if (!rules || !rules[languageId]) continue;
      // Proximity gate
      const npcTok = this.state.get(`map.tokens.${npcId}`);
      if (playerTok && npcTok) {
        const d = Math.hypot(playerTok.x - npcTok.x, playerTok.y - npcTok.y);
        if (d > range) continue;
      }
      const ruleText = rules[languageId];
      // Determine priority — HIGH if rule mentions HIGH, else NORMAL
      const isHigh = /HIGH/i.test(ruleText);
      this.bus.dispatch('dm:whisper', {
        text: `[LANGUAGE RECOGNITION] ${cfg.name || npcId} hears ${charName} speaking ${languageId}. ${ruleText}`,
        priority: isHigh ? 1 : 3,
        category: 'language-recognition',
        source: 'comm-router'
      });
    }
  }

  // ─── Channel 6 — Player → player (P2P) ─────────────────────────

  _routeP2P(fromPlayerId, toPlayerId, text) {
    if (!toPlayerId) return;
    // Route only to the recipient — never log to narrator
    this.bus.dispatch('player:p2p_message', {
      fromPlayerId, toPlayerId,
      fromName: this._charName(fromPlayerId),
      text
    });
    // Deliberate: no dm:whisper, no logging
  }

  // ─── Helpers ───────────────────────────────────────────────────

  _charName(playerId) {
    return this.state.get(`players.${playerId}.character.name`) || playerId;
  }
}

module.exports = CommRouter;
