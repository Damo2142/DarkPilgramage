/**
 * NPC Dialogue Handler
 * Generates in-character NPC responses based on transcript context.
 * Manages dialogue queue and DM approval flow.
 */

const fs = require('fs');
const path = require('path');

class NpcHandler {
  constructor(gemini, contextBuilder, bus, state, config) {
    this.gemini = gemini;
    this.ctx = contextBuilder;
    this.bus = bus;
    this.state = state;
    this.config = config;
    this._dialogueId = 0;
    this._pendingQueue = new Map(); // id -> dialogue suggestion
    this._systemPrompt = '';

    // Load base NPC prompt
    try {
      this._systemPrompt = fs.readFileSync(
        path.join(__dirname, '..', '..', 'prompts', 'npc-base.md'), 'utf-8'
      );
    } catch (e) {
      console.warn('[NpcHandler] No npc-base.md prompt found, using default');
      this._systemPrompt = this._defaultPrompt();
    }
  }

  /**
   * Analyze recent transcript and decide if an NPC should respond
   * Called after each transcript segment
   */
  async evaluateTranscript(segment) {
    if (!this.gemini.available) return;

    const npcs = this.state.get('npcs') || {};
    const activeNpcs = Object.entries(npcs).filter(([id, npc]) =>
      npc.status === 'alive' && npc.location
    );

    if (activeNpcs.length === 0) return;

    // Quick check: does the transcript mention or address any NPC?
    const text = segment.text.toLowerCase();
    const npcNames = activeNpcs.map(([id, npc]) => ({
      id,
      npc,
      mentioned: this._isNpcAddressed(text, npc)
    }));

    const addressed = npcNames.filter(n => n.mentioned);

    // If someone directly addressed an NPC, generate a response
    for (const { id, npc } of addressed) {
      await this.generateDialogue(id);
    }

    // If no one was directly addressed, ask AI if any NPC would naturally interject
    if (addressed.length === 0 && segment.speaker !== 'system') {
      await this._checkForInterjection(activeNpcs);
    }
  }

  /**
   * Generate dialogue for a specific NPC
   */
  async generateDialogue(npcId, manualPrompt = null) {
    const context = this.ctx.buildNpcContext(npcId);
    if (!context) return null;

    const npc = this.state.get(`npcs.${npcId}`);
    const contextStr = this.ctx.toPromptString(context);

    // Load NPC-specific voice notes if available
    let npcNotes = '';
    try {
      const npcConfig = JSON.parse(fs.readFileSync(
        path.join(__dirname, '..', '..', 'config', 'npcs', `${npcId}.json`), 'utf-8'
      ));
      if (npcConfig.voiceNotes) npcNotes = `\n\nVoice/personality notes: ${npcConfig.voiceNotes}`;
      if (npcConfig.speechPatterns) npcNotes += `\nSpeech patterns: ${npcConfig.speechPatterns}`;
    } catch (e) {
      // No NPC config file, that's fine
    }

    const prompt = manualPrompt
      ? `The DM wants ${npc.name} to say something about: "${manualPrompt}"\n\n${contextStr}`
      : `Based on the recent dialogue, generate what ${npc.name} would say next. If ${npc.name} would not naturally speak right now, respond with just "SILENCE".\n\n${contextStr}`;

    const response = await this.gemini.generate(
      this._systemPrompt + npcNotes,
      prompt,
      { maxTokens: 300, temperature: 0.85 }
    );

    if (!response || response.trim() === 'SILENCE') return null;

    // Clean up the response
    let dialogue = response.trim();
    // Remove quotes if the AI wrapped them
    dialogue = dialogue.replace(/^["']|["']$/g, '');
    // Remove character name prefix if AI added it
    const namePrefix = new RegExp(`^${npc.name}:\\s*`, 'i');
    dialogue = dialogue.replace(namePrefix, '');

    const id = `npc-${++this._dialogueId}`;
    const suggestion = {
      id,
      npc: npc.name,
      npcId,
      text: dialogue,
      timestamp: Date.now(),
      autoApproved: false
    };

    // Check trust level and auto-pilot
    const trustLevel = this.state.get('session.aiTrustLevel') || 'manual';
    const autoPilotNpcs = this.config.ai?.npcAutoPilot || [];
    const isAutoPilot = autoPilotNpcs.includes(npcId);

    if (trustLevel === 'autopilot' || (trustLevel === 'assisted' && isAutoPilot)) {
      suggestion.autoApproved = true;
      this._executeDialogue(suggestion);
    } else {
      // Queue for DM approval
      this._pendingQueue.set(id, suggestion);
      this.bus.dispatch('ai:npc_dialogue', suggestion);
    }

    return suggestion;
  }

  /**
   * DM approved a queued dialogue
   */
  approve(dialogueId) {
    const suggestion = this._pendingQueue.get(dialogueId);
    if (!suggestion) return;

    this._pendingQueue.delete(dialogueId);
    this._executeDialogue(suggestion);
  }

  /**
   * DM rejected a queued dialogue
   */
  reject(dialogueId) {
    this._pendingQueue.delete(dialogueId);
  }

  /**
   * DM edited and approved a dialogue
   */
  edit(dialogueId, newText) {
    const suggestion = this._pendingQueue.get(dialogueId);
    if (!suggestion) return;

    suggestion.text = newText;
    this._pendingQueue.delete(dialogueId);
    this._executeDialogue(suggestion);
  }

  /**
   * Execute an approved dialogue — dispatch to voice output and log
   */
  _executeDialogue(suggestion) {
    const npc = this.state.get(`npcs.${suggestion.npcId}`);

    // Add to NPC's dialogue history
    const history = npc?.dialogueHistory || [];
    history.push(suggestion.text);
    // Keep last 10
    if (history.length > 10) history.shift();
    this.state.set(`npcs.${suggestion.npcId}.dialogueHistory`, history);

    // Dispatch for voice output (Echo Speaks) and player display
    this.bus.dispatch('npc:approved', {
      id: suggestion.id,
      npc: suggestion.npc,
      npcId: suggestion.npcId,
      text: suggestion.text,
      voiceProfile: npc?.voiceProfile || null,
      autoApproved: suggestion.autoApproved
    });

    // Add to transcript context
    this.ctx.addTranscript({
      speaker: suggestion.npc,
      text: suggestion.text,
      timestamp: Date.now()
    });
  }

  /**
   * Check if any NPC would naturally interject
   */
  async _checkForInterjection(activeNpcs) {
    if (!this.gemini.available) return;

    const context = this.ctx.buildAtmosphereContext();
    const contextStr = this.ctx.toPromptString(context);

    const npcList = activeNpcs.map(([id, npc]) =>
      `${id}: ${npc.name} (${npc.role}, ${npc.disposition})`
    ).join('\n');

    const response = await this.gemini.generateJSON(
      'You are a D&D game assistant. Analyze if any NPC would naturally interject in the current conversation.',
      `Active NPCs:\n${npcList}\n\n${contextStr}\n\nWould any of these NPCs naturally say something right now? Respond with JSON: { "shouldInterject": true/false, "npcId": "id_or_null", "reason": "brief reason" }`,
      { maxTokens: 100, temperature: 0.7 }
    );

    if (response?.shouldInterject && response?.npcId) {
      await this.generateDialogue(response.npcId);
    }
  }

  /**
   * Check if transcript text addresses an NPC
   */
  _isNpcAddressed(text, npc) {
    const name = (npc.name || '').toLowerCase();
    const firstName = name.split(' ')[0];

    // Direct name mention
    if (text.includes(firstName) && firstName.length > 2) return true;

    // Role mention
    if (npc.role) {
      const roleWords = npc.role.toLowerCase().split(/\s+/);
      for (const word of roleWords) {
        if (word.length > 3 && text.includes(word)) return true;
      }
    }

    return false;
  }

  _defaultPrompt() {
    return `You are an NPC dialogue generator for a gothic horror D&D campaign set in 1274 Central Europe called "The Dark Pilgrimage."

RULES:
- Respond ONLY with the NPC's spoken dialogue — no narration, no actions, no quotes
- Stay in character based on the NPC's personality, knowledge, and disposition
- Use period-appropriate speech — medieval Central European setting
- Keep responses concise (1-3 sentences typical, longer for important reveals)
- NPCs should NOT reveal information they wouldn't know or share
- Horror tone: atmospheric and unsettling, never gratuitous
- If the NPC would not speak, respond with just "SILENCE"`;
  }

  getStats() {
    return {
      pendingQueue: this._pendingQueue.size,
      totalGenerated: this._dialogueId
    };
  }
}

module.exports = NpcHandler;
