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

    const detection = this.detectChannel(text);
    detection.fromPlayerId = playerId;
    detection.originalText = text;

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

  // ─── Channel 4/5 — NPC → players (proximity routing) ───────────

  routeNpcSpeech(npcDialogue) {
    // npcDialogue: { npcId, npc, text, voiceProfile, _private, _sourcePlayerId }
    const npcId = npcDialogue.npcId;
    if (!npcId) return;
    const text = npcDialogue.text || '';

    // PRIVATE — only the source player hears
    if (npcDialogue._private && npcDialogue._sourcePlayerId) {
      this._sendNpcAudioToPlayer(npcDialogue._sourcePlayerId, npcId, text, 'FULL');
      this.bus.dispatch('dm:whisper', {
        text: `[NPC private] ${npcDialogue.npc || npcId} → ${this._charName(npcDialogue._sourcePlayerId)}: routed privately.`,
        priority: 3, category: 'npc', source: 'comm-router'
      });
      // Check for adjacent eavesdroppers
      const adjacent = this._findAdjacentPlayers(npcDialogue._sourcePlayerId, npcId);
      if (adjacent.length) {
        this.bus.dispatch('dm:whisper', {
          text: `[NPC private] ${adjacent.map(p => this._charName(p)).join(', ')} adjacent — eavesdropping possible.`,
          priority: 2, category: 'npc', source: 'comm-router'
        });
      }
      return;
    }

    // PUBLIC — proximity routing
    const tiers = this._calculateHearingTiers(npcId);
    const fullPlayers = [];
    const partialPlayers = [];
    for (const [pid, tier] of Object.entries(tiers)) {
      if (tier === 'FULL') {
        this._sendNpcAudioToPlayer(pid, npcId, text, 'FULL');
        fullPlayers.push(this._charName(pid));
      } else if (tier === 'PARTIAL') {
        this._sendNpcAudioToPlayer(pid, npcId, text, 'PARTIAL');
        partialPlayers.push(this._charName(pid));
      }
    }
    // Whisper routing summary to narrator
    let summary = `[${npcDialogue.npc || npcId}] speaking. `;
    if (fullPlayers.length) summary += `Full: ${fullPlayers.join(', ')}. `;
    if (partialPlayers.length) summary += `Partial: ${partialPlayers.join(', ')}. `;
    this.bus.dispatch('dm:whisper', {
      text: summary, priority: 3, category: 'npc-routing', source: 'comm-router'
    });
  }

  _sendNpcAudioToPlayer(playerId, npcId, text, tier) {
    let displayText = text;
    if (tier === 'PARTIAL') {
      // Strip details — keep ~30% of words
      const words = text.split(/\s+/);
      const kept = words.filter((_, i) => i % 3 === 0);
      displayText = '...' + kept.join(' ') + '...';
    }
    const npcName = this.state.get(`npcs.${npcId}.name`) || npcId;
    this.bus.dispatch('player:npc_speech', {
      playerId, npcId, npcName, text: displayText, tier, fullText: text
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
