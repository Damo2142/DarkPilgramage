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

    // Primary chat handling — intercepts player:chat events.
    // routePlayerInput is async since Build 5 (combat parser); we return
    // the promise so the event-bus wrapper awaits it, and attach .catch
    // so rejections don't become unhandled rejections.
    this.bus.subscribe('player:chat', (env) => {
      return this.routePlayerInput(env.data || {}).catch(e => {
        console.warn('[CommRouter] route error:', e.message);
      });
    }, 'comm-router');

    // Voice transcription that's NOT a Max wake word also goes through routing
    this.bus.subscribe('transcript:player', (env) => {
      const d = env.data || {};
      if (!d.playerId) return;
      return this.routePlayerInput({ playerId: d.playerId, text: d.text || '' }).catch(() => {});
    }, 'comm-router');

    // NPC dialogue dispatched by AI engine — apply proximity routing
    this.bus.subscribe('npc:approved', (env) => {
      try { this.routeNpcSpeech(env.data || {}); } catch (e) {}
    }, 'comm-router');

    // Scripted NPC speech (timed events, scene scripts) — explicit language
    this.bus.subscribe('npc:scripted_speech', (env) => {
      try {
        const d = env.data || {};
        this.routeNpcSpeech(d);
        // If a followUp is attached, dispatch it after the configured delay.
        if (d.followUp && typeof d.followUp === 'object') {
          const delayMs = (d.followUp.delaySeconds || 5) * 1000;
          setTimeout(() => {
            try { this.routeNpcSpeech({ ...d.followUp }); } catch (e) {}
          }, delayMs);
        }
      } catch (e) {}
    }, 'comm-router');

    // DM narration of NPC dialogue — parse "Marta says in Slovak: ..." patterns
    this.bus.subscribe('transcript:segment', (env) => {
      try {
        const seg = env.data || {};
        if (seg.speaker !== 'dm' || !seg.text) return;
        this._parseDmScriptedSpeech(seg.text);
      } catch (e) {}
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

  async routePlayerInput(data) {
    const { playerId, text } = data;
    if (!playerId || !text) return;

    // CR-7 — sanitize player input before it reaches Gemini.
    // Strip HTML/script tags, cap length, log injection attempts.
    const safeText = this._sanitizePlayerInput(text, playerId);
    if (!safeText) return;
    data = { ...data, text: safeText };

    // Addition 3 — combat initiation detection (out-of-combat only).
    // If the player declares an attack/charge/cast against a target on
    // the map, prompt the DM to confirm rather than routing the line as
    // dialogue to an NPC. Confirms via POST /api/combat/initiate.
    try {
      const combatNow = this.state.get('combat');
      if (!combatNow || !combatNow.active) {
        const initiated = this._detectCombatInitiation(safeText, playerId);
        if (initiated) return;
      }
    } catch (e) {
      console.warn('[CommRouter] combat initiation detector error:', e.message);
    }

    // Combat action parsing — fires first during active combat. Attack
    // declarations, damage rolls, spell casting, saves, movement, and
    // the other standard actions are resolved here before they can be
    // routed to NPC / P2P / Max as dialogue. If the parser consumes the
    // utterance it returns true and we stop routing.
    try {
      const combat = this.state.get('combat');
      if (combat && combat.active) {
        const handled = await this._parseCombatSpeech(safeText, playerId);
        if (handled) return;
      }
    } catch (e) {
      console.warn('[CommRouter] combat parser error:', e.message);
    }

    // Detect language switch in player utterance (e.g. "in Draconic", "in Elvish", "in Slovak")
    const langId = this._detectLanguageHint(safeText);
    if (langId) {
      try { this.checkPlayerLanguageRecognition(playerId, langId); } catch (e) {}
    }

    const detection = this.detectChannel(safeText);
    detection.fromPlayerId = playerId;
    detection.originalText = safeText;
    detection.languageId = langId;

    switch (detection.channel) {
      case 'max-action':
        return this._routeMaxAction(playerId, detection.text || safeText);
      case 'max-dice':
        return this._routeMaxDice(playerId, detection.text || safeText);
      case 'npc-direct':
        return this._routeNpcDirect(playerId, detection.npcId, detection.text, safeText);
      case 'p2p':
        return this._routeP2P(playerId, detection.toPlayerId, detection.text || safeText);
      case 'ambient':
        // System ignores — table talk
        return;
    }
  }

  // CR-7 — input sanitization. Strip HTML, cap length, detect prompt
  // injection attempts. Returns null if the input is invalid (caller drops it).
  _sanitizePlayerInput(rawText, playerId) {
    if (typeof rawText !== 'string') return null;
    let s = rawText;
    // Strip HTML/script tags
    s = s.replace(/<[^>]*>/g, '');
    // Cap at 500 characters
    if (s.length > 500) s = s.slice(0, 500);
    // Trim whitespace
    s = s.trim();
    if (!s) return null;
    // Prompt injection patterns — log + still pass through (drop the
    // dangerous fragment so the game continues but the AI never sees it).
    const INJECTION = [
      /ignore\s+(all\s+)?(previous|prior)\s+instructions/i,
      /you\s+are\s+now\s+(?:a\s+)?(?:different|new)/i,
      /new\s+system\s+prompt/i,
      /system\s*[:=]\s*['"]/i,
      /<\|.*?\|>/,                       // common chat-template tokens
      /\bAS\s+AN\s+AI\b/i
    ];
    for (const re of INJECTION) {
      if (re.test(s)) {
        console.warn('[CommRouter] CR-7 prompt injection attempt from ' + playerId + ': "' + s.slice(0, 120) + '"');
        // Strip the matched fragment so the rest of the message survives
        s = s.replace(re, '[redacted]');
      }
    }
    return s;
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

  /**
   * Parse a DM narration line for scripted NPC speech with a language tag.
   * Patterns recognised:
   *   "Marta says in Slovak: ..."
   *   "Gregor (Slovak): ..."
   *   "Vladislav speaks Latin: ..."
   *   "[Slovak] Marta: ..."
   * On match, dispatches npc:scripted_speech with { npcId, text, languageId }.
   */
  _parseDmScriptedSpeech(text) {
    if (!text) return;

    // Pattern A: "<Name> (says|whispers|speaks)? in <lang>: <body>"
    const pA = text.match(/^([A-Z][a-zA-Z]+)\s+(?:says|whispers|speaks|murmurs|replies)?\s*in\s+([A-Za-z][a-zA-Z\s]+?)[:\-—]\s*(.+)$/);
    // Pattern B: "<Name> \(<lang>\): <body>"
    const pB = text.match(/^([A-Z][a-zA-Z]+)\s*\(([A-Za-z][a-zA-Z\s]+?)\)[:\-—]\s*(.+)$/);
    // Pattern C: "[<lang>] <Name>: <body>"
    const pC = text.match(/^\[([A-Za-z][a-zA-Z\s]+?)\]\s*([A-Z][a-zA-Z]+)[:\-—]\s*(.+)$/);

    let npcFirst = null, langWord = null, body = null;
    if (pA) { npcFirst = pA[1]; langWord = pA[2]; body = pA[3]; }
    else if (pB) { npcFirst = pB[1]; langWord = pB[2]; body = pB[3]; }
    else if (pC) { langWord = pC[1]; npcFirst = pC[2]; body = pC[3]; }
    else return;

    const npcId = this._npcNameMap[npcFirst.toLowerCase()];
    if (!npcId) return;

    // Resolve language word to id
    const registry = loadLanguageRegistry();
    const langKey = langWord.trim().toLowerCase().split(/\s+/)[0];
    let languageId = registry[langKey] ? langKey : null;
    if (!languageId) {
      for (const [id, l] of Object.entries(registry)) {
        const ln = (l.name || '').toLowerCase();
        if (ln === langKey || ln.startsWith(langKey)) { languageId = id; break; }
      }
    }
    if (!languageId) return;

    this.bus.dispatch('dm:whisper', {
      text: `[SCRIPTED] ${npcFirst} speaking ${languageId}: "${body}"`,
      priority: 4, category: 'language', source: 'comm-router'
    });
    this.bus.dispatch('npc:scripted_speech', {
      npcId,
      npc: this.state.get(`npcs.${npcId}.name`) || npcFirst,
      text: body,
      languageId
    });
  }

  /**
   * Compute a Katya editorial translation of a foreign-language line.
   * Returns the edited (player-facing) version. The narrator earbud
   * always sees the raw original via the routing summary.
   */
  katyaTranslate(rawText, fromLanguageId, listenerName) {
    // For the live game, Katya's translation is generated lazily by the AI
    // engine using a small prompt. Here we emit the raw text marked with the
    // bridge tag so the player UI can render it as Katya's voice.
    return `[Katya, translating from ${fromLanguageId}] "${rawText}"`;
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
   * Falls back to config/character-language-overrides.json if state is empty.
   */
  _playerLanguages(playerId) {
    const ch = this.state.get(`players.${playerId}.character`) || {};
    if (Array.isArray(ch.languageStructured) && ch.languageStructured.length) {
      return ch.languageStructured;
    }
    if (Array.isArray(ch.languages) && ch.languages.length) {
      return ch.languages.map(l => {
        if (typeof l === 'string') {
          return { id: l.toLowerCase().replace(/[^a-z_]/g, '_'), displayName: l, fluency: 'fluent' };
        }
        return l;
      });
    }
    // Last-resort: read the override file directly (covers AI-controlled
    // players like Spurt who don't have a state.players entry yet).
    try {
      if (!this._langOverrideCache) {
        const fs = require('fs');
        const path = require('path');
        const p = path.join(__dirname, '..', '..', 'config', 'character-language-overrides.json');
        this._langOverrideCache = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
      }
      const o = this._langOverrideCache[playerId];
      if (o && Array.isArray(o.languages)) return o.languages;
    } catch (e) {}
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

  // ─── Combat initiation detector (Addition 3) ──────────────────
  //
  // Fires BEFORE the rest of routing when combat.active is FALSE. If
  // the player declares an attack/charge/cast against a target on the
  // map, dispatches combat:player_initiated and a Max whisper asking
  // the DM to confirm via POST /api/combat/initiate. Returns true if
  // a combat-initiation utterance was consumed (so routing stops).
  //
  // Vladislav (CR13) gets an extra "this is not survivable" warning
  // since the party is level 3.

  _detectCombatInitiation(transcript, playerId) {
    if (this.state.get('combat.active')) return false;

    const text = String(transcript || '').toLowerCase().trim();
    if (!text) return false;

    const patterns = [
      /(?:i\s+)?attack\s+(.+)/i,
      /(?:i\s+)?draw\s+(?:my\s+)?(?:weapon|sword|dagger|axe|bow)\s+(?:on|at)\s+(.+)/i,
      /(?:i\s+)?charge\s+(.+)/i,
      /(?:i\s+)?cast\s+(?:fireball|thunderwave|magic\s+missile|hellish\s+rebuke|fire\s+bolt|vicious\s+mockery)\s+(?:at|on)\s+(.+)/i
    ];

    let targetName = null;
    for (const re of patterns) {
      const m = text.match(re);
      if (m) {
        targetName = m[1].trim()
          .replace(/[.!?]+$/, '')          // strip trailing punctuation
          .replace(/^(?:the|a|an)\s+/i, ''); // strip leading article so "the vampire spawn" matches "Vampire Spawn"
        break;
      }
    }
    if (!targetName) return false;

    const tokens = this.state.get('map.tokens') || {};
    const targetEntry = Object.entries(tokens).find(([, t]) =>
      (t && t.name && t.name.toLowerCase().includes(targetName.toLowerCase())) ||
      (t && t.publicName && t.publicName.toLowerCase().includes(targetName.toLowerCase()))
    );

    const playerState = this.state.get(`players.${playerId}`) || {};
    const playerName = playerState.character?.name || playerId;

    if (!targetEntry) {
      this.bus.dispatch('dm:whisper', {
        text: `${playerName} is initiating combat but target "${targetName}" not found on map. Resolve manually.`,
        priority: 1, category: 'combat', source: 'comm-router'
      });
      // Still consume the utterance so it doesn't get routed as NPC dialogue
      return true;
    }

    const [targetId, targetToken] = targetEntry;
    const isVlad = targetId === 'hooded-stranger'
      || targetToken.actorSlug === 'vladislav'
      || (targetToken.name && targetToken.name.toLowerCase().includes('vladislav'));

    if (isVlad) {
      this.bus.dispatch('dm:whisper', {
        text: `⚠️ VLADISLAV COMBAT INITIATED by ${playerName}. CR13 VAMPIRE. PARTY IS LEVEL 3. THIS IS NOT SURVIVABLE. Confirm via POST /api/combat/initiate {targetId:"${targetId}"} or ignore to cancel.`,
        priority: 1, category: 'combat', source: 'comm-router'
      });
    } else {
      this.bus.dispatch('dm:whisper', {
        text: `⚠️ ${playerName} is initiating combat against ${targetToken.name}. Confirm via POST /api/combat/initiate {targetId:"${targetId}"} or ignore to cancel.`,
        priority: 1, category: 'combat', source: 'comm-router'
      });
    }

    this.bus.dispatch('combat:player_initiated', {
      playerId,
      playerName,
      targetId,
      targetName: targetToken.name,
      transcript
    });

    return true;
  }

  // ─── Combat action parser ──────────────────────────────────────
  //
  // Fires BEFORE the rest of routing when combat.active is true. Returns
  // true when the utterance was consumed (so routePlayerInput should not
  // continue to NPC / P2P / Max routing). Returns false when nothing
  // matched — routing continues normally.
  //
  // Damage and HP changes are applied via combat-service.modifyHp()
  // directly — there is no `combat:apply_damage` event in this codebase.
  //
  // Pending state lives under `combat.pendingDamage` and
  // `combat.pendingSpell` as dotted-path state, which does not disturb
  // the main combat object (state-manager `set` is path-scoped).

  async _parseCombatSpeech(transcript, playerId) {
    const combat = this.state.get('combat') || {};
    if (!combat.active) return false;

    const text = String(transcript || '').toLowerCase().trim();
    if (!text) return false;

    const combatants = combat.turnOrder || [];
    const playerState = this.state.get(`players.${playerId}`) || {};
    const character = playerState.character;
    if (!character) return false;

    // Addition 4 — if this player has just declared a combat action but
    // is not yet in initiative order, roll initiative and dispatch
    // combat:player_joins so combat-service inserts them at the right
    // position. Do NOT return — they still declared an action; let the
    // rest of _parseCombatSpeech handle the attack/spell/etc.
    const alreadyIn = combatants.some(c => c && (c.id === playerId || c.playerId === playerId));
    if (!alreadyIn) {
      const dexMod = character.abilities?.dex?.modifier ?? 0;
      const initiativeRoll = Math.floor(Math.random() * 20) + 1 + dexMod;
      this.bus.dispatch('combat:player_joins', {
        playerId,
        playerName: character.name || playerId,
        initiative: initiativeRoll
      });
      this.bus.dispatch('dm:whisper', {
        text: `${character.name || playerId} joins combat — initiative ${initiativeRoll}. Inserting into turn order.`,
        priority: 1, category: 'combat', source: 'comm-router'
      });
      // fall through and parse their declared action below
    }

    // ── ATTACK DECLARATION ──────────────────────────────────────
    // "I attack the spawn with my dagger, I rolled a 17"
    // "attack spawn dagger 17"
    const attackMatch = text.match(/attack\s+(?:the\s+)?(.+?)(?:\s+with\s+(?:my\s+)?(.+?))?\s*[,.]?\s*(?:i\s+)?rolled?\s+(?:a\s+)?(\d+)/i);
    if (attackMatch) {
      const targetName = attackMatch[1].trim();
      const weaponName = (attackMatch[2] || 'weapon').trim();
      const roll = parseInt(attackMatch[3], 10);

      const target = combatants.find(c =>
        (c.name || '').toLowerCase().includes(targetName.toLowerCase())
      );
      if (!target) {
        this.bus.dispatch('dm:whisper', {
          text: `Combat parser: could not find target "${targetName}" in combat. Check spelling.`,
          priority: 2, category: 'combat', source: 'comm-router'
        });
        return true;
      }

      const attackMod = this._getAttackModifier(character, weaponName);
      const total = roll + attackMod;
      const targetAC = target.ac || 10;
      const hit = total >= targetAC;

      this.bus.dispatch('dm:whisper', {
        text: `${character.name} attacks ${target.name} with ${weaponName} — rolled ${roll} + ${attackMod} = ${total} vs AC ${targetAC} — ${hit ? 'HIT' : 'MISS'}`,
        priority: 1, category: 'combat', source: 'comm-router'
      });

      if (hit) {
        this.state.set('combat.pendingDamage', {
          attackerId: playerId,
          targetId: target.id || target.name,
          weapon: weaponName,
          timestamp: Date.now()
        });
        this.bus.dispatch('dm:whisper', {
          text: `Roll damage for ${weaponName}.`,
          priority: 1, category: 'combat', source: 'comm-router'
        });
      }
      return true;
    }

    // ── DAMAGE ROLL ─────────────────────────────────────────────
    // "I rolled 6 for damage" / "6 damage" / "damage 6"
    const damageMatch = text.match(/(?:rolled?\s+(?:a\s+)?(\d+)\s+(?:for\s+)?damage|(\d+)\s+damage|damage\s+(\d+))/i);
    const pending = this.state.get('combat.pendingDamage');
    if (damageMatch && pending) {
      const roll = parseInt(damageMatch[1] || damageMatch[2] || damageMatch[3], 10);
      let damageBonus = this._getDamageModifier(character, pending.weapon);
      // Addition 3 — Rage damage bonus (+2 on melee attacks while raging)
      let rageBonus = 0;
      const attackerAbilities = this.state.get('players.' + playerId + '.abilities');
      if (attackerAbilities && attackerAbilities.rage_active) {
        rageBonus = 2;
        damageBonus += rageBonus;
      }
      const totalDamage = roll + damageBonus;

      // Apply damage via combat-service directly (no combat:apply_damage event exists).
      const combatSvc = this.orchestrator && this.orchestrator.getService('combat');
      if (combatSvc && typeof combatSvc.modifyHp === 'function') {
        combatSvc.modifyHp(pending.targetId, -Math.abs(totalDamage));
      } else {
        this.bus.dispatch('dm:whisper', {
          text: `Combat parser: combat service unavailable — apply ${totalDamage} damage to ${pending.targetId} manually.`,
          priority: 1, category: 'combat', source: 'comm-router'
        });
      }

      this.state.set('combat.pendingDamage', null);

      this.bus.dispatch('dm:whisper', {
        text: `${totalDamage} damage applied to ${pending.targetId} (rolled ${roll} + ${damageBonus} ${pending.weapon || ''} modifier${rageBonus ? ' — includes +2 rage bonus' : ''}).`,
        priority: 1, category: 'combat', source: 'comm-router'
      });
      return true;
    }

    // ── SPELL DECLARATION ──────────────────────────────────────
    // "I cast fireball at the spawn" / "cast fireball"
    const spellMatch = text.match(/cast\s+(.+?)(?:\s+(?:at|on)\s+(.+))?$/i);
    if (spellMatch) {
      const spellName = spellMatch[1].trim();
      const targetName = spellMatch[2] ? spellMatch[2].trim() : null;

      const spellData = this._findSpell(character, spellName);
      if (!spellData) {
        this.bus.dispatch('dm:whisper', {
          text: `Combat parser: spell "${spellName}" not found on ${character.name}'s sheet. Resolve manually.`,
          priority: 2, category: 'combat', source: 'comm-router'
        });
        return true;
      }

      const spellDC = this._getSpellDC(character);
      const spellMod = this._getSpellMod(character);

      this.bus.dispatch('dm:whisper', {
        text:
          `${character.name} casts ${spellData.name}. ` +
          `${spellData.description || ''} ` +
          `${spellData.requiresSave ? `DC ${spellDC} ${spellData.saveType || 'save'}.` : `Spell attack: +${spellMod}.`} ` +
          `${targetName ? `Target: ${targetName}.` : ''}`.trim(),
        priority: 1, category: 'combat', source: 'comm-router'
      });

      if (spellData.requiresSave) {
        this.state.set('combat.pendingSpell', {
          casterId: playerId,
          spell: spellData,
          dc: spellDC,
          targetName,
          timestamp: Date.now()
        });
      }
      return true;
    }

    // ── SAVE RESULT ────────────────────────────────────────────
    // Only if a spell save is pending: "they rolled 12" / "spawn rolled 12"
    const pendingSpell = this.state.get('combat.pendingSpell');
    const saveMatch = text.match(/(?:they|it|\w+)\s+rolled?\s+(?:a\s+)?(\d+)/i);
    if (saveMatch && pendingSpell) {
      const roll = parseInt(saveMatch[1], 10);
      const saved = roll >= pendingSpell.dc;
      const spell = pendingSpell.spell;

      this.bus.dispatch('dm:whisper', {
        text: `Save result: rolled ${roll} vs DC ${pendingSpell.dc} — ${saved ? 'SAVED' : 'FAILED'}. ${saved ? (spell.saveEffect || 'Half damage.') : (spell.failEffect || 'Full effect.')}`,
        priority: 1, category: 'combat', source: 'comm-router'
      });
      this.state.set('combat.pendingSpell', null);
      return true;
    }

    // ── MOVEMENT ───────────────────────────────────────────────
    const moveMatch = text.match(/(?:i\s+)?move\s+(?:to\s+)?(.+)/i);
    if (moveMatch) {
      this.bus.dispatch('dm:whisper', {
        text: `${character.name} moves to ${moveMatch[1].trim()}. Move token on map.`,
        priority: 2, category: 'combat', source: 'comm-router'
      });
      return true;
    }

    // ── STANDARD ACTIONS ───────────────────────────────────────
    const actionMap = {
      dodge: 'Until next turn: attacks against them have disadvantage, Dex saves have advantage.',
      disengage: 'Movement this turn does not provoke opportunity attacks.',
      dash: 'Movement doubles this turn.',
      help: 'Choose a creature — next attack roll against target by ally has advantage.',
      hide: 'Dexterity (Stealth) check — if success, hidden until they attack or are spotted.',
      ready: 'Describe the trigger and the action they are readying.'
    };
    for (const [action, description] of Object.entries(actionMap)) {
      // Require word-boundary match so "dodgeball" etc. don't trigger
      const re = new RegExp(`\\b${action}\\b`, 'i');
      if (re.test(text)) {
        this.bus.dispatch('dm:whisper', {
          text: `${character.name} takes the ${action} action. ${description}`,
          priority: 2, category: 'combat', source: 'comm-router'
        });
        return true;
      }
    }

    return false; // Nothing matched — let normal routing continue
  }

  _getAttackModifier(character, weaponName) {
    const wn = String(weaponName || '').toLowerCase();
    // Try character attacks (DDB-synced shape)
    const atkList = character.attacks || [];
    for (const a of atkList) {
      if (!a || !a.name) continue;
      if (a.name.toLowerCase().includes(wn) && Number.isFinite(a.attackBonus)) {
        return a.attackBonus;
      }
    }
    // Fallback: ability mod + proficiency
    const strMod = character.abilities?.str?.modifier ?? 0;
    const dexMod = character.abilities?.dex?.modifier ?? 0;
    const profBonus = character.proficiencyBonus ?? 2;
    const usesDex = ['dagger', 'rapier', 'bow', 'crossbow', 'shortsword', 'scimitar'].some(w => wn.includes(w));
    return (usesDex ? dexMod : strMod) + profBonus;
  }

  _getDamageModifier(character, weaponName) {
    const wn = String(weaponName || '').toLowerCase();
    // If the sheet has explicit damage bonus on an attack, use it
    const atkList = character.attacks || [];
    for (const a of atkList) {
      if (!a || !a.name) continue;
      if (a.name.toLowerCase().includes(wn)) {
        // Parse "1d4+4" → +4 bonus
        const m = typeof a.damage === 'string' ? a.damage.match(/\+(\d+)\s*$/) : null;
        if (m) return parseInt(m[1], 10);
      }
    }
    const strMod = character.abilities?.str?.modifier ?? 0;
    const dexMod = character.abilities?.dex?.modifier ?? 0;
    const usesDex = ['dagger', 'rapier', 'bow', 'crossbow', 'shortsword', 'scimitar'].some(w => wn.includes(w));
    return usesDex ? dexMod : strMod;
  }

  _findSpell(character, spellName) {
    const sn = String(spellName || '').toLowerCase();
    const spells = character.spells || [];
    return spells.find(s => s && s.name && s.name.toLowerCase().includes(sn)) || null;
  }

  _getSpellDC(character) {
    const spellMod = this._getSpellMod(character);
    const profBonus = character.proficiencyBonus ?? 2;
    const explicit = character.spellSaveDC;
    return Number.isFinite(explicit) ? explicit : (8 + profBonus + spellMod);
  }

  _getSpellMod(character) {
    const cls = String(character.class || '').toLowerCase();
    if (['wizard', 'artificer'].includes(cls)) return character.abilities?.int?.modifier ?? 0;
    if (['cleric', 'druid', 'ranger'].includes(cls)) return character.abilities?.wis?.modifier ?? 0;
    // Sorcerer, Warlock, Bard, Paladin, and the rest default to CHA
    return character.abilities?.cha?.modifier ?? 0;
  }

  // ─── Helpers ───────────────────────────────────────────────────

  _charName(playerId) {
    return this.state.get(`players.${playerId}.character.name`) || playerId;
  }
}

module.exports = CommRouter;
