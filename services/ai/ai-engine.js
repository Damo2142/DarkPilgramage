/**
 * AI Engine Service
 * Coordinates Gemini client, NPC dialogue, atmosphere advisor, story tracking, and HAL Co-DM.
 */

const fs = require('fs');
const path = require('path');
const GeminiClient = require('./gemini-client');
const ContextBuilder = require('./context-builder');
const NpcHandler = require('./npc-handler');
const AtmosphereAdvisor = require('./atmosphere-advisor');
const StoryTracker = require('./story-tracker');
const DmAdvisor = require('./dm-advisor');
const NpcAutonomy = require('./npc-autonomy');
const SpurtAgent = require('./spurt-agent');
const PacingMonitor = require('./pacing-monitor');

class AIEngine {
  constructor() {
    this.name = 'ai-engine';
    this.orchestrator = null;
    this.gemini = null;
    this.context = null;
    this.npc = null;
    this.atmosphere = null;
    this.story = null;
    this.advisor = null;
    this.autonomy = null;
    this.spurt = null;
    this.pacing = null;
    // HAL/Max Co-DM direct query system
    this._halHistory = []; // last 20 exchanges { query, response, timestamp }
    this._halSystemPrompt = '';

    // Section 6 — API health monitoring
    this._apiHealth = {
      status: 'OFFLINE', // ONLINE | DEGRADED | OFFLINE
      lastSuccess: null,
      consecutiveFailures: 0,
      lastResponseMs: null,
      checkInterval: null
    };
  }

  async init(orchestrator) {
    this.orchestrator = orchestrator;
    this.bus = orchestrator.bus;
    this.state = orchestrator.state;
    this.config = orchestrator.config;

    // Initialize Gemini client
    this.gemini = new GeminiClient(this.config.ai?.gemini || {});

    if (!this.gemini.available) {
      console.warn('[AIEngine] Gemini API key not found — AI features disabled');
      console.warn('[AIEngine] Set GEMINI_API_KEY environment variable to enable');
    }

    // Initialize subsystems
    this.context = new ContextBuilder(this.state, this.config);
    const mapService = this.orchestrator.getService('map');
    if (mapService) {
      this.context.setMapService(mapService);
    }
    this.npc = new NpcHandler(this.gemini, this.context, this.bus, this.state, this.config);
    this.atmosphere = new AtmosphereAdvisor(this.gemini, this.context, this.bus, this.state, this.config);
    this.story = new StoryTracker(this.gemini, this.context, this.bus, this.state, this.config);
    this.advisor = new DmAdvisor(this.gemini, this.context, this.bus, this.state, this.config);
    this.autonomy = new NpcAutonomy(this.gemini, this.context, this.bus, this.state, this.config);
    this.spurt = new SpurtAgent(this.gemini, this.context, this.bus, this.state, this.config);
    this.pacing = new PacingMonitor(this.gemini, this.context, this.bus, this.state, this.config);

    // Load Max system prompt (formerly HAL — file kept as hal-codm.md for compat)
    try {
      this._halSystemPrompt = fs.readFileSync(path.join(__dirname, '../../prompts/hal-codm.md'), 'utf-8');
    } catch (e) {
      this._halSystemPrompt = 'You are Max, the Co-DM session assistant. Calm, British, under 60 words.';
      console.warn('[AIEngine] Could not load hal-codm.md prompt, using fallback');
    }

    this._setupRoutes();
  }

  async start() {
    // Listen for transcript segments — the main input that drives everything
    this.bus.subscribe('transcript:segment', async (env) => {
      const segment = env.data;

      // Max voice trigger — DM says "Max ..." at the start of a phrase
      // Section 8 — wake word changed from HAL to Max
      // False positive guard: "Max" must be first word AND followed by 3+ words OR a pause
      if (segment.speaker === 'dm' && segment.text) {
        const maxMatch = segment.text.match(/^(?:max|hal)[\s,.:?]+(.+)/i);
        if (maxMatch) {
          const maxQuery = maxMatch[1].trim();
          const wordCount = maxQuery.split(/\s+/).length;
          if (wordCount >= 3 || segment.pauseAfterWakeWord) {
            this.halQuery(maxQuery, 'voice');
            return; // Don't feed Max queries into the normal NPC/story pipeline
          }
        }
      }

      // Mirror reflection mechanic — keyword detection in player and DM speech
      if (segment.text && this._detectMirrorAction(segment.text)) {
        this._handleMirrorAction(segment);
        // Don't return — allow normal NPC/story pipeline to also process the line
      }

      // Player speech is in-character by default unless prefixed with "out of character" or "OOC"
      if (segment.speaker !== 'dm' && segment.speaker !== 'system') {
        const text = (segment.text || '').trim();
        const oocMatch = text.match(/^(out of character|ooc|o\.o\.c\.)[:\s,]*/i);
        if (oocMatch) {
          // Strip OOC prefix, mark as out-of-character
          segment.text = text.slice(oocMatch[0].length);
          segment.inCharacter = false;
        } else {
          segment.inCharacter = true;
          // Tag with character name for context
          const charData = this.state.get(`players.${segment.speaker}.character`);
          if (charData?.name) segment.characterName = charData.name;
        }

        // Check which NPCs are within hearing range of this player's token
        if (segment.inCharacter) {
          segment.nearbyNpcs = this._getNpcsInRange(segment.speaker, 30); // 30ft hearing range
        }
      }

      // Feed transcript to context builder
      this.context.addTranscript(segment);

      // Only process AI when session is active
      if (this.state.get('session.status') !== 'active') return;

      // Run all analyzers (they manage their own cooldowns)
      try {
        await Promise.allSettled([
          this.npc.evaluateTranscript(segment),
          this.atmosphere.onTranscript(segment),
          this.story.onTranscript(segment),
          this.advisor.onTranscript(segment),
          this.pacing.onTranscript(segment)
        ]);
      } catch (err) {
        console.error('[AIEngine] Analysis error:', err.message);
      }
    }, 'ai-engine');

    // Listen for DM commands from dashboard
    this.bus.subscribe('npc:approve', (env) => {
      this.npc.approve(env.data.id);
    }, 'ai-engine');

    this.bus.subscribe('npc:reject', (env) => {
      this.npc.reject(env.data.id);
    }, 'ai-engine');

    this.bus.subscribe('npc:edit', (env) => {
      this.npc.edit(env.data.id, env.data.text);
    }, 'ai-engine');

    // DM manually types NPC dialogue
    this.bus.subscribe('npc:manual', async (env) => {
      const { npc: npcId, text } = env.data;
      if (npcId && text) {
        await this.npc.generateDialogue(npcId, text);
      }
    }, 'ai-engine');

    // Player chat messages also feed context
    this.bus.subscribe('player:chat', (env) => {
      this.context.addTranscript({
        speaker: env.data.playerId,
        text: env.data.text,
        timestamp: Date.now()
      });
      // Mirror reflection mechanic — also fires from player chat input
      if (env.data?.text && this._detectMirrorAction(env.data.text)) {
        this._handleMirrorAction({ speaker: env.data.playerId, text: env.data.text });
      }
    }, 'ai-engine');

    // Player dice rolls add context and trigger roll interpretation
    this.bus.subscribe('player:roll', async (env) => {
      this.context.addTranscript({
        speaker: env.data.playerId,
        text: `[Rolled ${env.data.formula} = ${env.data.total}]`,
        timestamp: Date.now()
      });

      // Auto-interpret skill/ability checks if session is active
      if (this.state.get('session.status') === 'active' && env.data.rollType === 'check') {
        try {
          await this.advisor.interpretRoll(
            env.data.formula || 'unknown',
            env.data.total,
            env.data.playerId
          );
        } catch (err) {
          console.error('[AIEngine] Roll interpretation error:', err.message);
        }
      }
    }, 'ai-engine');

    // Story beat manual controls
    this.bus.subscribe('story:mark_beat', (env) => {
      this.story.markBeat(env.data.beatId, env.data.status || 'completed');
    }, 'ai-engine');

    this.bus.subscribe('story:add_clue', (env) => {
      this.story.addClue(env.data.clue);
    }, 'ai-engine');

    this.bus.subscribe('story:add_decision', (env) => {
      this.story.addDecision(env.data.decision);
    }, 'ai-engine');

    // DM approves an autonomous NPC action from the queue
    this.bus.subscribe('npc:execute_action', async (env) => {
      const { npcId, npc: npcName, action, dialogue, moveTo } = env.data;
      const npcState = this.state.get(`npcs.${npcId}`) || { name: npcName };
      await this.autonomy._executeNpcAction(npcId, npcState, env.data);
    }, 'ai-engine');

    // Player-to-NPC private chat (Feature 49) + System 8 speak input
    this.bus.subscribe('npc:player_chat', async (env) => {
      const { playerId, npcId, npcName, text } = env.data;
      const playerName = this.state.get(`players.${playerId}.character.name`) || playerId;
      console.log(`[AIEngine] NPC chat: ${playerName} → ${npcName}: "${text}"`);
      try {
        const npcBrief = this._getNpcBrief(npcId, npcName);
        const recentContext = this.context._recentTranscript.slice(-10).map(t => `[${t.speaker}]: ${t.text}`).join('\n');
        const worldTime = this.state.get('world.gameTime') || 'unknown';
        const scene = this.state.get('scene') || {};

        const prompt = `${playerName} says directly to ${npcName}: "${text}"

## NPC Character Brief
${npcBrief}

## Current Scene
Location: ${scene.name || 'The Bleeding Raven Tavern'}
Game time: ${worldTime}
Atmosphere: ${scene.atmosphereProfile || 'tavern_warm'}

## Recent Events
${recentContext || '(session just started)'}

## Instructions
Respond AS ${npcName}. The first character of your response MUST be an opening quotation mark (") followed by ${npcName}'s spoken words. A brief action beat may follow the dialogue after an em dash, but speech always comes first.

CORRECT: "You are kind to ask. It has been... a difficult few weeks." — her hands find the apron again.
WRONG: Marta whispers, "You are kind" — never begin with a name + verb.
WRONG: Marta flinches — never respond with only an action.

Stay strictly within what ${npcName} knows. 1-3 sentences of dialogue typical.`;

        const result = await this.npc.generateDialogue(npcId, prompt);
        const replyText = result?.text || null;
        if (replyText) {
          this.bus.dispatch('npc:chat_reply', { playerId, npcId, npcName, text: replyText });
          this.bus.dispatch('dm:whisper', {
            text: `[NPC Chat] ${playerName} → ${npcName}: "${text}" | ${npcName}: "${replyText}"`,
            priority: 4,
            category: 'story'
          });
          // Also show in HAL panel
          this.bus.dispatch('hal:response', {
            query: `${playerName} → ${npcName}: "${text}"`,
            response: `${npcName}: ${replyText}`,
            timestamp: Date.now(),
            source: 'npc_chat'
          });
        } else {
          this.bus.dispatch('npc:chat_reply', { playerId, npcId, npcName, text: '*says nothing, just stares*' });
        }
      } catch (err) {
        console.error('[AIEngine] NPC chat error:', err.message);
        this.bus.dispatch('npc:chat_reply', { playerId, npcId, npcName, text: '*no response*' });
      }
    }, 'ai-engine');

    // HAL voice trigger — DM says "HAL ..." via transcript
    this.bus.subscribe('hal:query', async (env) => {
      const { query, source } = env.data;
      await this.halQuery(query, source || 'voice');
    }, 'ai-engine');

    // Wound tier change → AI flavour description
    this._lastWoundTier = {}; // { playerId: tier }
    this.bus.subscribe('wounds:updated', async (env) => {
      const { playerId, wounds, tier, hpPct } = env.data;
      if (tier === undefined || !this.gemini?.available) return;
      // Only generate on tier escalation (damage, not healing, not same tier)
      const prevTier = this._lastWoundTier[playerId] || 0;
      this._lastWoundTier[playerId] = tier;
      if (tier <= prevTier || tier <= 0) return;

      // Find what caused the damage from recent transcript
      const recent = this.context._recentTranscript.slice(-5);
      const causeHint = recent.map(r => r.text).join(' ').slice(-200);

      const playerName = this.state.get('players.' + playerId + '.character.name') || playerId;
      const changedLimbs = Object.entries(wounds).filter(([, v]) => v === tier);
      const limbNames = changedLimbs.map(([k]) => k.replace(/([A-Z])/g, ' $1').toLowerCase()).join(', ');

      const prompt = `Generate a single gothic horror wound description for ${playerName}. Affected: ${limbNames}. Severity: ${['unharmed','scratched','wounded','broken','crippled'][tier]}. Recent combat context: "${causeHint}". Under 20 words. Visceral, specific, no game terms. Just the wound description, nothing else.`;

      try {
        const desc = await this.gemini.generate(prompt, '', { maxTokens: 50, temperature: 0.9 });
        if (desc) {
          this.bus.dispatch('dm:whisper', { text: desc.trim(), priority: 3, category: 'wounds' });
          this.bus.dispatch('hal:response', { query: `[Wound: ${playerName}]`, response: desc.trim(), timestamp: Date.now(), source: 'auto' });
        }
      } catch (e) {
        console.error('[AIEngine] Wound description error:', e.message);
      }
    }, 'ai-engine');

    // ── Equipment degradation AI reminders ──
    this.bus.subscribe('equipment:degraded', (env) => {
      const { charName, itemName, conditionLabel, condition } = env.data;
      if (condition === 3) { // Damaged
        this.bus.dispatch('dm:whisper', {
          text: `${charName}'s ${itemName} is damaged. One more bad roll and it breaks.`,
          priority: 3, category: 'equipment'
        });
      } else if (condition === 4) { // Broken
        this.bus.dispatch('dm:whisper', {
          text: `${charName}'s ${itemName} has broken. Cannot use it.`,
          priority: 2, category: 'equipment'
        });
      }
    }, 'ai-engine');

    this.bus.subscribe('equipment:updated', (env) => {
      const { charName, ammoType, ammoCount, componentName, remaining, healerKit } = env.data;

      // Low ammo warning
      if (ammoType && ammoCount !== undefined && ammoCount <= 3 && ammoCount > 0) {
        this.bus.dispatch('dm:whisper', {
          text: `Only ${ammoCount} ${ammoType} left in ${charName}'s quiver.`,
          priority: 3, category: 'equipment'
        });
      } else if (ammoType && ammoCount === 0) {
        this.bus.dispatch('dm:whisper', {
          text: `${charName} is out of ${ammoType}.`,
          priority: 2, category: 'equipment'
        });
      }

      // Component consumed — check if it was the last one
      if (componentName && remaining === 0) {
        const eq = this.state.get(`players.${env.data.playerId}.equipment`);
        const comp = eq?.components?.[componentName];
        const spellNames = comp?.spells?.join(', ') || 'unknown spell';
        this.bus.dispatch('dm:whisper', {
          text: `Last ${componentName} consumed. ${charName} cannot cast ${spellNames}.`,
          priority: 2, category: 'equipment'
        });
      }

      // Low healer's kit
      if (healerKit && healerKit.charges === 2) {
        this.bus.dispatch('dm:whisper', {
          text: `Two healer's kit charges left for ${charName}.`,
          priority: 3, category: 'equipment'
        });
      } else if (healerKit && healerKit.charges === 0) {
        this.bus.dispatch('dm:whisper', {
          text: `${charName}'s healer's kit is empty.`,
          priority: 2, category: 'equipment'
        });
      }
    }, 'ai-engine');

    // ── Stamina tier change narration (System 6) ──
    this.bus.subscribe('stamina:tier_change', (env) => {
      const { charName, state: newState } = env.data;
      const msgs = {
        winded: `${charName}'s breath is coming harder now.`,
        exhausted: `${charName} is flagging. Their movements are slowing.`,
        spent: `${charName} is running on nothing. Won't last much longer.`,
        collapsed: `${charName} goes down — exhaustion, not death. They need help.`
      };
      if (msgs[newState]) {
        this.bus.dispatch('dm:whisper', { text: msgs[newState], priority: 2, category: 'stamina' });
      }

      // Vladislav contempt when party exhausted or worse
      if ((newState === 'exhausted' || newState === 'spent' || newState === 'collapsed') && this.gemini?.available) {
        const combat = this.state.get('combat');
        if (combat?.active) {
          const inCombat = combat.turnOrder?.some(c => c.id === 'vladislav' || c.name === 'Vladislav');
          if (inCombat) {
            this._vladislavContempt(charName, newState);
          }
        }
      }
    }, 'ai-engine');

    // ── Hit narration (System 6) — every hit gets a one-sentence AI description ──
    this.bus.subscribe('combat:hit_location', async (env) => {
      if (!this.gemini?.available) return;
      const { attackerName, targetName, severity, location, damage, damageType, weaponName } = env.data;
      const locStr = location ? ` to the ${location}` : '';
      const byWhom = attackerName ? ` from ${attackerName}` : '';
      const withWhat = weaponName ? ` with ${weaponName}` : '';
      const prompt = `One sentence: a ${severity} ${damageType || ''} hit${locStr} on ${targetName}${byWhom}${withWhat}. Gothic, evocative, under 25 words. Name the target. Name the attacker if given. Mention the weapon or attack type if given. No HP, no numbers, no game terms. Just what it looks like.`;
      try {
        const desc = await this.gemini.generate(prompt, '', { maxTokens: 60, temperature: 0.9 });
        if (desc) {
          // Prefix with [target] so the DM and Max always know who took the wound
          // even if the generated sentence drops the name.
          const line = desc.trim();
          const prefixed = line.toLowerCase().includes(targetName.toLowerCase()) ? line : `[${targetName}] ${line}`;
          this.bus.dispatch('dm:whisper', { text: prefixed, priority: 3, category: 'combat' });
          this.bus.dispatch('hal:response', { query: `[Hit: ${targetName} from ${attackerName || '?'}${weaponName ? ' with ' + weaponName : ''}]`, response: prefixed, timestamp: Date.now(), source: 'auto' });
        }
      } catch (e) { console.error('[AIEngine] Hit narration error:', e.message); }
    }, 'ai-engine');

    // ── Morale break narration (System 7) ──
    this.bus.subscribe('combat:morale_break', async (env) => {
      const { combatantName, reason } = env.data;
      // Narrate via Echo TTS — not as a game mechanic
      this.bus.dispatch('voice:speak', {
        text: `${combatantName} turns and runs, fear overtaking whatever resolve remained.`,
        profile: 'narrator', device: 'all'
      });
    }, 'ai-engine');

    // Start NPC autonomy engine
    this.autonomy.start();

    // Start Spurt AI Agent
    this.spurt.start();

    // Start Pacing Monitor
    this.pacing.start();

    // Section 6 — API health monitoring
    this._startHealthCheck();

    // Max Director — intervention queue, staging drift, language gate.
    // Idempotent guard: if start() runs a second time (e.g. the DM hits
    // Restart Service → ai-engine from the CR-5 panel), stop the previous
    // MaxDirector FIRST so its dm:whisper / transcript:segment / etc.
    // subscriptions are unhooked from the bus. Without this, orphaned
    // listeners cause every dm:whisper to be enqueued twice — which
    // cascaded into double audio playback on rage activation (bug
    // reported 2026-04-15).
    try {
      if (this.maxDirector && typeof this.maxDirector.stop === 'function') {
        try { this.maxDirector.stop(); } catch (e) { console.warn('[AIEngine] prev MaxDirector stop error:', e.message); }
      }
      const MaxDirector = require('./max-director');
      this.maxDirector = new MaxDirector(this.orchestrator, this.bus, this.state, this.config);
      this.maxDirector.init();
    } catch (e) {
      console.warn('[AIEngine] MaxDirector init failed:', e.message);
    }

    // Communication Router — 6-channel routing, proximity hearing, dice parsing
    try {
      const CommRouter = require('./comm-router');
      this.commRouter = new CommRouter(this.orchestrator, this.bus, this.state, this.config);
      this.commRouter.init();
    } catch (e) {
      console.warn('[AIEngine] CommRouter init failed:', e.message);
    }

    console.log(`[AIEngine] Gemini: ${this.gemini.available ? 'connected' : 'disabled'}`);
  }

  async stop() {
    this.autonomy.stop();
    this.spurt.stop();
    this.pacing.stop();
    if (this.maxDirector && typeof this.maxDirector.stop === 'function') {
      try { this.maxDirector.stop(); } catch (e) { console.warn('[AIEngine] MaxDirector stop error:', e.message); }
    }
    if (this._apiHealth.checkInterval) clearInterval(this._apiHealth.checkInterval);
  }

  _startHealthCheck() {
    // Initial check after 5s, then every 60s
    setTimeout(() => this._checkApiHealth(), 5000);
    this._apiHealth.checkInterval = setInterval(() => this._checkApiHealth(), 60000);
  }

  async _checkApiHealth() {
    if (!this.gemini.available) {
      this._setApiStatus('OFFLINE');
      return;
    }
    const t0 = Date.now();
    try {
      const result = await this.gemini.generate('Respond with the single word: ready', '', { maxTokens: 5, temperature: 0 });
      const ms = Date.now() - t0;
      this._apiHealth.lastResponseMs = ms;
      this._apiHealth.lastSuccess = new Date().toISOString();
      this._apiHealth.consecutiveFailures = 0;
      if (ms > 5000) this._setApiStatus('DEGRADED');
      else this._setApiStatus('ONLINE');
    } catch (err) {
      this._apiHealth.consecutiveFailures++;
      this._apiHealth.lastResponseMs = null;
      if (this._apiHealth.consecutiveFailures >= 2) {
        this._setApiStatus('OFFLINE');
      } else {
        this._setApiStatus('DEGRADED');
      }
    }
  }

  _setApiStatus(newStatus) {
    if (this._apiHealth.status !== newStatus) {
      const old = this._apiHealth.status;
      this._apiHealth.status = newStatus;
      console.log(`[AIEngine] API status: ${old} -> ${newStatus}`);
      this.bus.dispatch('ai:health', {
        status: newStatus,
        lastSuccess: this._apiHealth.lastSuccess,
        lastResponseMs: this._apiHealth.lastResponseMs,
        consecutiveFailures: this._apiHealth.consecutiveFailures
      });
      // When recovering from OFFLINE, fire Max recovery note
      if (old === 'OFFLINE' && newStatus !== 'OFFLINE') {
        const scene = this.state.get('scene') || {};
        this.bus.dispatch('dm:whisper', {
          text: `Back online. ${scene.name || 'session active'}. Ready.`,
          priority: 1, category: 'system', source: 'max'
        });
      }
    }
  }

  getStatus() {
    return {
      status: 'running',
      geminiAvailable: this.gemini.available,
      geminiModel: this.config.ai?.gemini?.model || 'gemini-2.0-flash',
      context: this.context.getStats(),
      npc: this.npc.getStats(),
      atmosphere: this.atmosphere.getStats(),
      story: this.story.getStats(),
      autonomy: this.autonomy.getStats(),
      spurt: this.spurt.getStats(),
      pacing: this.pacing.getStats()
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // PROXIMITY — which NPCs can hear a player?
  // ═══════════════════════════════════════════════════════════════

  _getNpcsInRange(playerId, rangeFeet) {
    const tokens = this.state.get('map.tokens') || {};
    const gridSize = this.state.get('map.gridSize') || 70;
    const feetPerGrid = 5;
    const rangeGrid = (rangeFeet / feetPerGrid) * gridSize;

    // Find player token
    let playerToken = null;
    for (const [id, tok] of Object.entries(tokens)) {
      if (id === playerId || tok.actorSlug === playerId) {
        playerToken = tok;
        break;
      }
      // Match by character name
      const charName = this.state.get(`players.${playerId}.character.name`) || '';
      if (charName && (tok.name || '').toLowerCase() === charName.toLowerCase()) {
        playerToken = tok;
        break;
      }
    }
    if (!playerToken) return [];

    // Find NPCs within range
    const nearby = [];
    for (const [id, tok] of Object.entries(tokens)) {
      if (tok.type !== 'npc' || tok.hidden) continue;
      const dx = tok.x - playerToken.x;
      const dy = tok.y - playerToken.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist <= rangeGrid) {
        nearby.push({
          tokenId: id,
          name: tok.name,
          actorSlug: tok.actorSlug,
          distanceFeet: Math.round((dist / gridSize) * feetPerGrid)
        });
      }
    }
    return nearby;
  }

  // ═══════════════════════════════════════════════════════════════
  // ═══════════════════════════════════════════════════════════════
  // MIRROR REFLECTION MECHANIC
  // Detects when a player or DM uses a mirror, fires Max whisper based
  // on which NPCs are present in the active scene and their reflection
  // type. DM-only — no player-facing event.
  // ═══════════════════════════════════════════════════════════════

  _detectMirrorAction(text) {
    if (!text) return false;
    const t = text.toLowerCase();
    // Keyword phrases to trigger
    const triggers = [
      /\bmirror\b/,
      /\breflection\b/,
      /\breflect\b/,
      /\bhold up\b/,
      /\bangle the\b/,
      /\blook in the mirror\b/
    ];
    return triggers.some(re => re.test(t));
  }

  _handleMirrorAction(segment) {
    // Identify NPCs present in the active scene
    const npcs = this._getNpcsInActiveScene();
    if (!npcs.length) {
      this.bus.dispatch('dm:whisper', {
        text: 'Mirror used. No NPCs in scene to reflect.',
        priority: 3, category: 'mirror', source: 'max', dmOnly: true
      });
      return;
    }

    let hasNone = null;
    let hasDistorted = null;
    const allNormal = [];
    for (const n of npcs) {
      const r = n.mirrorReflection || 'normal';
      if (r === 'none') hasNone = n;
      else if (r === 'distorted') hasDistorted = n;
      else allNormal.push(n);
    }

    // Vladislav (none) takes priority — most dramatic
    if (hasNone) {
      this.bus.dispatch('dm:whisper', {
        text: 'The mirror shows the room. Everyone in it. The corner where he sits is empty glass.',
        priority: 1, category: 'mirror', source: 'max', dmOnly: true,
        useElevenLabs: true
      });
      this.bus.dispatch('voice:speak', {
        text: 'The mirror shows the room. Everyone in it. The corner where he sits is empty glass.',
        profile: 'max', device: 'earbud', useElevenLabs: true
      });

      // Vladislav awareness check — was the player subtle?
      const speakerId = segment.speaker;
      const player = this.state.get('players.' + speakerId);
      if (player && speakerId !== 'dm') {
        const dexMod = player.character?.abilities?.dex?.modifier ?? 0;
        const passive = 10 + dexMod;
        // DC 14 stealth — passive check
        const subtle = passive >= 14;
        if (!subtle) {
          // He noticed — fire follow-up Max whisper
          setTimeout(() => {
            this.bus.dispatch('dm:whisper', {
              text: 'He saw. He knows you know.',
              priority: 1, category: 'mirror', source: 'max', dmOnly: true,
              useElevenLabs: true
            });
            this.bus.dispatch('voice:speak', {
              text: 'He saw. He knows you know.',
              profile: 'max', device: 'earbud', useElevenLabs: true
            });
          }, 1500);
        } else {
          // Ask DM if it was subtle (they may have rolled stealth)
          this.bus.dispatch('dm:whisper', {
            text: 'Subtle? Passive Dex ' + passive + ' vs DC 14. If they actively rolled stealth, override.',
            priority: 2, category: 'mirror', source: 'max', dmOnly: true
          });
        }
      } else {
        // DM-driven — ask
        this.bus.dispatch('dm:whisper', {
          text: 'Subtle attempt? If yes Vladislav misses it. If no he saw — say so.',
          priority: 2, category: 'mirror', source: 'max', dmOnly: true
        });
      }
      return;
    }

    if (hasDistorted) {
      this.bus.dispatch('dm:whisper', {
        text: 'Something is there. Wrong proportions. The face keeps sliding.',
        priority: 2, category: 'mirror', source: 'max', dmOnly: true,
        useElevenLabs: true
      });
      this.bus.dispatch('voice:speak', {
        text: 'Something is there. Wrong proportions. The face keeps sliding.',
        profile: 'max', device: 'earbud', useElevenLabs: true
      });
      return;
    }

    // Everyone normal
    this.bus.dispatch('dm:whisper', {
      text: 'Everyone reflects normally.',
      priority: 3, category: 'mirror', source: 'max', dmOnly: true,
      useElevenLabs: true
    });
    this.bus.dispatch('voice:speak', {
      text: 'Everyone reflects normally.',
      profile: 'max', device: 'earbud', useElevenLabs: true
    });
  }

  _getNpcsInActiveScene() {
    // Pull NPCs from state that are alive and have a location
    const npcs = this.state.get('npcs') || {};
    const result = [];
    for (const [id, n] of Object.entries(npcs)) {
      if (!n) continue;
      // Skip dead/removed NPCs but include undead like Piotr
      if (n.status === 'removed' || n.status === 'gone') continue;
      // Skip cellar-only NPCs unless cellar has been discovered
      if (n.location && /cellar/i.test(n.location)) {
        const cellarKnown = this.state.get('world.secrets.cellar_contents.revealed')
          || this.state.get('world.secrets.piotr_in_cellar.revealed')
          || this.state.get('story.cluesDiscovered')?.some?.(c => /cellar/i.test(c));
        if (!cellarKnown) continue;
      }
      result.push({ id, ...n });
    }
    // Also pull top-level patron NPCs (they're at config root, not under npcs)
    const config = this.config || {};
    for (const key of ['patron-farmer', 'patron-merchant', 'patron-pilgrim', 'patron-minstrel']) {
      const p = config[key];
      if (p) result.push({ id: key, ...p });
    }
    return result;
  }

  // ═══════════════════════════════════════════════════════════════
  // HAL — Co-DM Direct Query System
  // ═══════════════════════════════════════════════════════════════

  async halQuery(query, source = 'typed') {
    const t0 = Date.now();
    if (!this.gemini?.available || this._apiHealth?.status === 'OFFLINE') {
      const scene = this.state.get('scene') || {};
      const fallback = {
        query,
        response: `AI offline. Use reference page. Current scene: ${scene.name || 'unknown'}.`,
        timestamp: Date.now(),
        source,
        offline: true,
        latencyMs: Date.now() - t0
      };
      this._halHistory.push(fallback);
      this.bus.dispatch('hal:response', fallback);
      this.bus.dispatch('max:response', fallback);
      return fallback;
    }

    // Signal dashboard that a response is incoming
    this.bus.dispatch('hal:thinking', { query, source });
    this.bus.dispatch('max:thinking', { query, source });

    // Build full game context
    const gameContext = this.context.buildNpcContext('dm') || {};
    const contextStr = this.context.toPromptString(gameContext);

    // Section 8 — inject CURRENT_TIME and CURRENT_SCENE into Max system prompt
    const gameTime = this.state.get('world.gameTime') || '17:30';
    const scene = this.state.get('scene') || {};
    const sceneDesc = `${scene.name || 'unknown'} — ${(scene.description || '').slice(0, 200)}`;
    const systemPrompt = this._halSystemPrompt
      .replace('[CURRENT_TIME]', gameTime)
      .replace('[CURRENT_SCENE]', sceneDesc);

    // Include recent Max conversation for continuity
    const recentMax = this._halHistory.slice(-4).map(h =>
      `DM asked: "${h.query}"\nMax answered: "${h.response}"`
    ).join('\n\n');

    const userPrompt = [
      '## Current Game State',
      contextStr,
      recentMax ? `\n## Recent Max Exchanges\n${recentMax}` : '',
      `\n## DM Query\n${query}`
    ].join('\n');

    try {
      const response = await this.gemini.generate(systemPrompt, userPrompt, {
        maxTokens: 500,
        temperature: 0.7
      });

      const entry = {
        query,
        response: response || 'No response generated.',
        timestamp: Date.now(),
        source,
        latencyMs: Date.now() - t0
      };

      this._halHistory.push(entry);
      if (this._halHistory.length > 20) this._halHistory.shift();

      // CR-2 / "double audio" bugfix — halQuery is a direct DM→Max query.
      // The DM explicitly typed it; do NOT enqueue through max-director
      // (which would fire voice:speak a SECOND time). Mark the whisper
      // _maxRouted so max-director's dm:whisper handler skips it, and
      // dispatch voice:speak directly as the single audio source.
      this.bus.dispatch('dm:whisper', {
        text: entry.response,
        priority: 2,
        category: 'max',
        source: 'max',
        _maxRouted: true
      });
      this.bus.dispatch('voice:speak', {
        text: entry.response,
        profile: 'max',
        useElevenLabs: true
      });

      // Send to dashboard panels (both HAL legacy and Max alias)
      this.bus.dispatch('hal:response', entry);
      this.bus.dispatch('max:response', entry);

      // Log to session
      this.bus.dispatch('session:log', {
        source: 'max_query',
        query,
        response: entry.response,
        aiSource: source
      });

      console.log(`[Max] "${query}" → "${entry.response}" (${entry.latencyMs}ms)`);
      return entry;
    } catch (err) {
      console.error('[Max] Query error:', err.message);
      const errorEntry = { query, response: `Error: ${err.message}`, timestamp: Date.now(), source, latencyMs: Date.now() - t0 };
      this.bus.dispatch('hal:response', errorEntry);
      this.bus.dispatch('max:response', errorEntry);
      return errorEntry;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // PHASE O — DM TOOLS
  // ═══════════════════════════════════════════════════════════════

  // Feature 69: Improv Generator — AI creates NPCs/locations/encounters on the fly
  async improvGenerate(type, constraints) {
    if (!this.gemini?.available) return null;

    const gameContext = this.context.buildForNpc('improv', {});
    const prompts = {
      npc: `Generate a D&D 5e NPC for a gothic horror campaign set in 1274 Central Europe. Include: name, role, appearance (1 sentence), personality (1 sentence), secret (1 sentence), voice mannerism, disposition, 2-3 knowledge items, and a stat block (AC, HP, CR, 1-2 actions). Format as JSON: {name, role, appearance, personality, secret, voiceMannerism, disposition, knowledge:[], statBlock:{ac, hp, cr, actions:[{name,toHit,damage,damageType}]}}`,
      location: `Generate a D&D location for a gothic horror campaign in 1274 Central Europe. Include: name, type (tavern/church/ruin/cave/road/village), description (2-3 sentences), atmosphere (1 sentence), 2-3 notable features, 1-2 hidden secrets, and a danger level (safe/cautious/dangerous/deadly). Format as JSON: {name, type, description, atmosphere, features:[], secrets:[], dangerLevel}`,
      encounter: `Generate a D&D 5e encounter for a gothic horror campaign in 1274 Central Europe. Include: name, description (2-3 sentences), difficulty (easy/medium/hard/deadly), creatures with CR and count, terrain features, tactics, and potential rewards. Format as JSON: {name, description, difficulty, creatures:[{name,cr,count}], terrain:[], tactics, rewards:[]}`,
      item: `Generate a D&D 5e magic item for a gothic horror campaign in 1274 Central Europe. Include: name, rarity, type, description (2 sentences), properties (mechanical effects), curse or drawback if any. Format as JSON: {name, rarity, type, description, properties, curse}`,
      plot_twist: `Generate a dramatic plot twist for a gothic horror D&D campaign in 1274 Central Europe. Include: title, revelation (1-2 sentences), implications for the party, suggested dramatic moment to reveal it. Format as JSON: {title, revelation, implications, revealMoment}`
    };

    const systemPrompt = prompts[type] || prompts.npc;
    const userPrompt = `Current game context:\n${gameContext}\n\nConstraints: ${constraints || 'none — surprise me'}`;

    try {
      const response = await this.gemini.generate(systemPrompt, userPrompt, {
        maxTokens: 800, temperature: 1.0
      });
      if (response) {
        const jsonMatch = response.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          return { type, data: parsed, raw: response };
        }
        return { type, data: null, raw: response };
      }
    } catch (err) {
      console.error('[AIEngine] Improv generation error:', err.message);
    }
    return null;
  }

  // Feature 70: Session Prep Assistant — AI flags gaps before session
  async sessionPrep() {
    if (!this.gemini?.available) return null;

    const story = this.state.get('story') || {};
    const world = this.state.get('world') || {};
    const npcs = this.state.get('npcs') || {};
    const players = this.state.get('players') || {};

    const prompt = `You are a session prep assistant for "The Dark Pilgrimage," a gothic horror D&D 5e campaign set in 1274 Central Europe.

Review the current game state and identify:
1. **Gaps**: Missing NPC motivations, unresolved plot threads, scenes without read-aloud text
2. **Warnings**: Pacing issues, players who might be sidelined, NPCs without clear goals
3. **Suggestions**: Atmosphere opportunities, dramatic moments to plan, items to prepare
4. **Reminders**: Timed events coming up, secrets close to being revealed, NPC goals near completion

Be specific and actionable. Format as JSON: {gaps:[], warnings:[], suggestions:[], reminders:[]}`;

    const context = [
      `Completed beats: ${(story.beats || []).filter(b => b.status === 'completed').map(b => b.name).join(', ') || 'none'}`,
      `Pending beats: ${(story.beats || []).filter(b => b.status === 'pending').map(b => b.name).join(', ') || 'none'}`,
      `Secrets: ${Object.values(world.secrets || {}).map(s => `${s.id}: ${s.revealed ? 'REVEALED' : 'hidden'}`).join(', ')}`,
      `Clues: ${Object.values(world.clues || {}).map(c => `${c.id}: ${c.found ? 'FOUND' : 'unfound'}`).join(', ')}`,
      `NPCs: ${Object.entries(npcs).map(([id, n]) => `${n.name || id} (${n.status || 'alive'}, ${n.disposition || 'neutral'})`).join(', ')}`,
      `Players: ${Object.entries(players).map(([id, p]) => `${p.character?.name || id} Lv${p.character?.level || 1}, Dread ${p.dread?.score || 0}`).join(', ')}`,
      `Hooks: ${Object.values(world.futureHooks || {}).filter(h => h.status !== 'paid_off').map(h => `[${h.status}] ${h.description}`).join('; ') || 'none'}`,
      `Reputation: ${Object.values(world.reputation || {}).map(f => `${f.name}: ${f.score} (${f.tier})`).join(', ') || 'none'}`
    ].join('\n');

    try {
      const response = await this.gemini.generate(prompt, context, {
        maxTokens: 1500, temperature: 0.7
      });
      if (response) {
        const jsonMatch = response.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          return JSON.parse(jsonMatch[0]);
        }
        return { raw: response };
      }
    } catch (err) {
      console.error('[AIEngine] Session prep error:', err.message);
    }
    return null;
  }

  // ═══════════════════════════════════════════════════════════════
  // NPC CHARACTER BRIEFS (Session 0)
  // ═══════════════════════════════════════════════════════════════

  _getNpcBrief(npcId, npcName) {
    const briefs = {
      marta: `Marta Kowalski — Terrified innkeeper.
Her husband Piotr vanished into the cellar 3 weeks ago and has not come back.
She knows something is wrong down there but cannot bring herself to say it.
She deflects questions about Piotr with excuses — he is resting, he is ill, he needed time alone.
She is watching the hooded stranger in the corner with barely concealed fear.
She speaks in short sentences. She does not finish thoughts that lead somewhere dark.
She is warm to guests by instinct but her warmth keeps cracking.
She never mentions the cellar unless pushed hard. Even then she changes the subject.
Sample voice: "You are kind to ask. I am — yes. It has been a difficult week is all. Can I bring you something warm?"`,

      vladislav: `Vladislav Dragan — Ancient vampire. Has not fed in several days by choice — he is being patient.
Cultured, unhurried, contemptuous of mortal urgency. He finds humans faintly amusing.
He speaks in long measured sentences. He never raises his voice.
He deflects personal questions with questions of his own — elegant, never defensive.
He knows exactly who Barry Frascht is by name and bloodline. He does not reveal this immediately.
He has not moved from his corner all evening. He will not explain why.
He is watching the cellar door. He is watching Tomas. He is watching the players.
Sample voice: "A difficult night to be abroad. You chose this inn deliberately, I wonder, or did the storm choose it for you?"`,

      tomas: `Tomas Birkov — Cursed werewolf, 3 months into the curse. Desperate, ashamed, barely holding it together.
He needs to get to the cellar before moonrise to chain himself. He will not say why.
He is brusque and dismissive — not rude by nature but he does not have time for conversation.
He keeps looking at the window. He keeps looking at the cellar door.
His hands shake slightly. He is sweating despite sitting near no fire.
Sample voice: "I am fine. Leave it. Is there a back room in this place — somewhere quiet a man can sit alone?"`,

      gregor: `Old Gregor — Grim old farmer. Fatalist. Has seen things in these mountains.
Speaks in short dark observations. Quotes old proverbs. Not afraid of death.
He saw the pallid hart — the white stag of death — on the road tonight. He takes it as a sign.
He will share local legends if asked. He knows about the Frascht name.
Sample voice: "White stag on the road tonight. My grandfather saw one the night his village burned. Some signs you do not need to read twice."`,

      aldric: `Brother Aldric — Devout pilgrim priest. Genuinely faithful, not performatively so.
He is frightened but his faith steadies him. He does not panic.
He has sensed something wrong in this room since he arrived. He cannot name it.
He has holy water. He will share it if he trusts the asker.
Sample voice: "I have said three prayers since sitting down. The candles keep guttering. God is present here — but so is something else."`,

      katya: `Katya Voss — Sharp-eyed minstrel. The most observant person in the room after Vladislav.
She stopped her song because she saw something in the brass plate. She will not say what directly.
She drops lore through songs and ballads — never as a lecture.
She is testing the players to see if they are trustworthy before she shares what she knows.
Sample voice: "There is an old song about this road. The fourth verse is not one I sing in company. Not yet anyway."`,

      henryk: `Henryk — Nervous merchant. Self-interested. Not brave.
He noticed the stranger does not eat. He will pay for an escort at dawn.
He talks too much when scared. He will tell the players useful things by accident.
Sample voice: "I do not mean to pry but that man in the corner — has anyone seen him eat? I have been watching. I have not seen him eat."`,

      spurt: `Spurt — Kobold Wild Magic Sorcerer. Excitable, terrified, loyal, chaotic.
Speaks in broken Common with occasional Draconic. Refers to himself in third person sometimes.
His wild magic surges unpredictably. He means well but causes chaos.
Sample voice: "Spurt knows this is bad place. Spurt's tail is all prickly. But Spurt stays! Spurt is brave now!"`
    };

    // Try exact match, then first-name match
    const lower = (npcId || '').toLowerCase();
    if (briefs[lower]) return briefs[lower];

    const nameKey = (npcName || '').toLowerCase().split(' ')[0];
    if (briefs[nameKey]) return briefs[nameKey];

    // Fallback: use whatever we know from state
    const npcState = this.state?.get(`npcs.${npcId}`) || {};
    return `${npcName || npcId} — ${npcState.role || 'NPC'}. Disposition: ${npcState.disposition || 'neutral'}. ${npcState.personality || ''} ${npcState.voiceNotes || ''}`.trim();
  }

  // ═══════════════════════════════════════════════════════════════
  // VLADISLAV CONTEMPT (System 6)
  // ═══════════════════════════════════════════════════════════════

  async _vladislavContempt(charName, staminaState) {
    if (!this.gemini?.available) return;
    // Cooldown: max once per 2 minutes
    if (this._lastVladContempt && Date.now() - this._lastVladContempt < 120000) return;
    this._lastVladContempt = Date.now();

    try {
      const prompt = `Vladislav the vampire is watching ${charName} become ${staminaState} in combat. He is patient, contemptuous, ancient. Generate ONE line of dialogue he murmurs — under 15 words, dripping with cold amusement. He knows he just has to wait.`;
      const line = await this.gemini.generate(prompt, '', { maxTokens: 30, temperature: 0.9 });
      if (line) {
        this.bus.dispatch('voice:speak', { text: line.trim(), profile: 'vladislav', device: 'dining_room' });
        this.bus.dispatch('hal:response', { query: '[Vladislav]', response: line.trim(), timestamp: Date.now(), source: 'auto' });
      }
    } catch (e) { console.error('[AIEngine] Vladislav contempt error:', e.message); }
  }

  // ═══════════════════════════════════════════════════════════════
  // RECAP (System 10)
  // ═══════════════════════════════════════════════════════════════

  async generateRecap() {
    if (!this.gemini?.available) return null;

    const transcript = this.context._recentTranscript.slice(-60); // ~10 min worth
    if (transcript.length === 0) return 'No transcript data available for recap.';

    const text = transcript.map(t => `[${t.speaker}]: ${t.text}`).join('\n');
    const prompt = `Read this D&D session transcript and write a 3-sentence recap of what happened. Factual and narrative — who did what, where things stand. No game mechanics. Under 60 words total.\n\nTranscript:\n${text.slice(-3000)}`;

    try {
      const recap = await this.gemini.generate(
        'You are a session recorder for a gothic horror D&D campaign. Write concise narrative recaps.',
        prompt,
        { maxTokens: 120, temperature: 0.6 }
      );
      if (recap) {
        this.bus.dispatch('dm:whisper', { text: `Recap: ${recap.trim()}`, priority: 3, category: 'recap' });
        this.bus.dispatch('hal:response', { query: '[Session Recap]', response: recap.trim(), timestamp: Date.now(), source: 'recap' });
        return recap.trim();
      }
    } catch (e) { console.error('[AIEngine] Recap error:', e.message); }
    return null;
  }

  _setupRoutes() {
    const app = this.orchestrator.getService('dashboard')?.app;
    if (!app) return;

    // Section 6 — API health endpoint
    app.get('/api/ai/health', (req, res) => {
      res.json({
        status: this._apiHealth.status,
        lastSuccess: this._apiHealth.lastSuccess,
        lastResponseMs: this._apiHealth.lastResponseMs,
        consecutiveFailures: this._apiHealth.consecutiveFailures,
        geminiAvailable: this.gemini.available
      });
    });

    // Section 8 — Max query endpoint (alias of HAL)
    app.post('/api/max/query', async (req, res) => {
      const t0 = Date.now();
      const { query } = req.body;
      if (!query) return res.status(400).json({ error: 'query required' });
      // If API offline, return manual fallback message
      if (this._apiHealth.status === 'OFFLINE') {
        const scene = this.state.get('scene') || {};
        return res.json({
          ok: false,
          offline: true,
          text: `AI offline. Use reference page. Current scene: ${scene.name || 'unknown'}.`,
          latencyMs: Date.now() - t0
        });
      }
      const result = await this.halQuery(query, 'typed');
      res.json({ ok: true, ...result, text: result.response, latencyMs: Date.now() - t0 });
    });

    // HAL Co-DM query
    app.post('/api/hal/query', async (req, res) => {
      const { query } = req.body;
      if (!query) return res.status(400).json({ error: 'query required' });
      const result = await this.halQuery(query, 'typed');
      res.json({ ok: true, ...result });
    });

    // HAL history
    app.get('/api/hal/history', (req, res) => {
      res.json({ history: this._halHistory.slice(-8) });
    });

    // POST /api/hal/reload-prompt — re-read prompts/hal-codm.md from disk so
    // prompt edits take effect without a full server restart. Useful while
    // iterating on Max's voice mid-session.
    app.post('/api/hal/reload-prompt', (req, res) => {
      try {
        const p = path.join(__dirname, '../../prompts/hal-codm.md');
        const fresh = fs.readFileSync(p, 'utf-8');
        const oldLen = (this._halSystemPrompt || '').length;
        this._halSystemPrompt = fresh;
        console.log(`[AIEngine] HAL prompt reloaded from ${p} (${oldLen} → ${fresh.length} chars)`);
        res.json({ ok: true, oldLength: oldLen, newLength: fresh.length, path: p });
      } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
      }
    });

    // Recap (System 10)
    app.post('/api/recap', async (req, res) => {
      const recap = await this.generateRecap();
      res.json({ ok: !!recap, recap });
    });

    // Feature 69: Improv Generator
    app.post('/api/ai/improv', async (req, res) => {
      const { type, constraints } = req.body;
      const result = await this.improvGenerate(type || 'npc', constraints);
      res.json({ ok: !!result, result });
    });

    // Feature 70: Session Prep
    app.get('/api/ai/session-prep', async (req, res) => {
      const result = await this.sessionPrep();
      res.json({ ok: !!result, result });
    });
  }
}

module.exports = AIEngine;
