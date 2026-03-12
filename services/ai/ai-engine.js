/**
 * AI Engine Service
 * Coordinates Gemini client, NPC dialogue, atmosphere advisor, and story tracking.
 */

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
    this.npc = new NpcHandler(this.gemini, this.context, this.bus, this.state, this.config);
    this.atmosphere = new AtmosphereAdvisor(this.gemini, this.context, this.bus, this.state, this.config);
    this.story = new StoryTracker(this.gemini, this.context, this.bus, this.state, this.config);
    this.advisor = new DmAdvisor(this.gemini, this.context, this.bus, this.state, this.config);
    this.autonomy = new NpcAutonomy(this.gemini, this.context, this.bus, this.state, this.config);
    this.spurt = new SpurtAgent(this.gemini, this.context, this.bus, this.state, this.config);
    this.pacing = new PacingMonitor(this.gemini, this.context, this.bus, this.state, this.config);

    this._setupRoutes();
  }

  async start() {
    // Listen for transcript segments — the main input that drives everything
    this.bus.subscribe('transcript:segment', async (env) => {
      const segment = env.data;

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

    // Player-to-NPC private chat (Feature 49)
    this.bus.subscribe('npc:player_chat', async (env) => {
      const { playerId, npcId, npcName, text } = env.data;
      console.log(`[AIEngine] NPC chat: ${playerId} → ${npcId}: "${text}"`);
      try {
        const response = await this.npc.generateDialogue(npcId, `Player ${playerId} says directly to ${npcName}: "${text}". Respond in character.`);
        if (response) {
          this.bus.dispatch('npc:chat_reply', { playerId, npcId, npcName, text: response });
          // Also log to DM dashboard
          this.bus.dispatch('dm:whisper', {
            text: `[NPC Chat] ${playerId} → ${npcName}: "${text}" | ${npcName}: "${response}"`,
            priority: 4,
            category: 'story'
          });
        } else {
          this.bus.dispatch('npc:chat_reply', { playerId, npcId, npcName, text: '*says nothing, just stares*' });
        }
      } catch (err) {
        console.error('[AIEngine] NPC chat error:', err.message);
        this.bus.dispatch('npc:chat_reply', { playerId, npcId, npcName, text: '*no response*' });
      }
    }, 'ai-engine');

    // Start NPC autonomy engine
    this.autonomy.start();

    // Start Spurt AI Agent
    this.spurt.start();

    // Start Pacing Monitor
    this.pacing.start();

    console.log(`[AIEngine] Gemini: ${this.gemini.available ? 'connected' : 'disabled'}`);
  }

  async stop() {
    this.autonomy.stop();
    this.spurt.stop();
    this.pacing.stop();
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

  _setupRoutes() {
    const app = this.orchestrator.getService('dashboard')?.app;
    if (!app) return;

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
