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
          this.advisor.onTranscript(segment)
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

    // Start NPC autonomy engine
    this.autonomy.start();

    console.log(`[AIEngine] Gemini: ${this.gemini.available ? 'connected' : 'disabled'}`);
  }

  async stop() {
    this.autonomy.stop();
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
      autonomy: this.autonomy.getStats()
    };
  }
}

module.exports = AIEngine;
