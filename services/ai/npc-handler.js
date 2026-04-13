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
   * Generate dialogue for a specific NPC.
   *
   * MemPalace recall: before building the prompt we ask the palace for
   * the top 3 results keyed on the NPC. The compressed recall is
   * injected as a `## PALACE RECALL` section at the top of the context
   * string. Failure-silent: if the CLI is unavailable or times out, the
   * context is identical to what the pre-integration code produced.
   */
  async generateDialogue(npcId, manualPrompt = null) {
    const npcForQuery = this.state.get(`npcs.${npcId}`);
    const recallTopic = (npcForQuery && npcForQuery.name) || npcId;
    const context = await this.ctx.buildNpcContextWithRecall(npcId, recallTopic);
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

    // Inject session-config NPC brief and knowledge boundaries (e.g. Aldous Kern's False Hydra editing)
    if (npc.aiDialogueBrief) {
      npcNotes += `\n\nAI Dialogue Brief: ${npc.aiDialogueBrief}`;
    }
    if (Array.isArray(npc.knowledgeBoundaries) && npc.knowledgeBoundaries.length) {
      npcNotes += `\n\nKnowledge Boundaries (the NPC literally cannot communicate these):\n  - ${npc.knowledgeBoundaries.join('\n  - ')}`;
    }
    if (Array.isArray(npc.behaviors) && npc.behaviors.length) {
      npcNotes += `\n\nObservable Behaviors:\n  - ${npc.behaviors.join('\n  - ')}`;
    }

    const dialogueFormatRule = `\n\nCRITICAL FORMAT RULE: Your response must BEGIN with spoken dialogue in quotation marks. Never begin with a character name followed by a verb. Never begin with a stage direction or physical action. The first character of your response must be an opening quotation mark.
Correct: "You are kind to ask. It has been a difficult week." — she looks away.
Wrong: Marta whispers, "You are kind"
Wrong: Marta flinches, her eyes darting to the door`;

    const prompt = manualPrompt
      ? `${manualPrompt}${dialogueFormatRule}\n\n${contextStr}`
      : `Based on the recent dialogue, generate what ${npc.name} would say next. If ${npc.name} would not naturally speak right now, respond with just "SILENCE".${dialogueFormatRule}\n\n${contextStr}`;

    const response = await this.gemini.generate(
      this._systemPrompt + npcNotes,
      prompt,
      { maxTokens: 400, temperature: 0.85 }
    );

    console.log(`[NpcHandler] Raw Gemini response for ${npc.name}: "${response}"`);

    if (!response || response.trim() === 'SILENCE') return null;

    // Clean up the response
    let dialogue = response.trim();
    // Remove character name prefix if AI added it (e.g. "Marta: ...")
    const namePrefix = new RegExp(`^${npc.name}[:\\s]+`, 'i');
    dialogue = dialogue.replace(namePrefix, '');
    // Remove first-name prefix too
    const firstName = (npc.name || '').split(' ')[0];
    if (firstName.length > 2) {
      const firstNamePrefix = new RegExp(`^${firstName}[:\\s]+`, 'i');
      dialogue = dialogue.replace(firstNamePrefix, '');
    }
    // Fix double-leading quotes (AI sometimes wraps then adds inner quotes)
    dialogue = dialogue.replace(/^["']{2,}/, '"');
    // Only strip wrapping quotes if the ENTIRE response is a single quoted string
    // (i.e. starts with " and ends with " with no em dash action beat after)
    if (/^["'].*["']$/.test(dialogue) && !dialogue.includes('—')) {
      dialogue = dialogue.replace(/^["']|["']$/g, '');
    }

    console.log(`[NpcHandler] Cleaned dialogue for ${npc.name}: "${dialogue}"`);

    // CR-4 — anachronism + AI-tell quality check. Reject and (best-effort)
    // regenerate once if the response contains modern tells. Plain words
    // are fine in 1274 — we only flag the obvious AI escapes.
    const ANACHRONISMS = [
      /\bas an AI\b/i,
      /\bI cannot\b/i,
      /\bI'?m sorry\b/i,
      /\bI am unable\b/i,
      /\bcertainly!/i,
      /\bindeed I shall\b/i,
      /\blanguage model\b/i,
      /\bChatGPT\b/i
    ];
    const flagged = ANACHRONISMS.find(re => re.test(dialogue));
    if (flagged) {
      console.warn(`[NpcHandler] CR-4 anachronism flagged for ${npc.name}: "${dialogue.slice(0, 120)}" (matched ${flagged})`);
      // Strip the offending fragment so the rest of the line survives.
      // We don't regenerate inline (would double the latency); the DM can
      // reject via the approval queue.
      dialogue = dialogue.replace(flagged, '').replace(/\s{2,}/g, ' ').trim();
      if (!dialogue || dialogue.length < 4) return null;
    }

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

    // MemPalace integration 3 — significant NPC interactions get
    // persisted to a minable file under sessions/, which the
    // session:ended hook in campaign-service mines into the palace.
    //
    // suggestion.importance is honored if upstream sets it (>7 = save);
    // otherwise we derive significance from keyword presence so the
    // interesting Session-0 beats land in memory without requiring any
    // change to the dialogue generator. Failure-silent.
    try {
      const score = this._scoreDialogueSignificance(suggestion);
      if (score > 7) {
        const mempalace = require('./mempalace-client');
        const npcName = suggestion.npc || suggestion.npcId || 'NPC';
        // No single addressed player in this code path — record the
        // line with the speaker. Future enhancement could associate
        // with the most recent transcript speaker if known.
        const line = `${npcName}: "${(suggestion.text || '').replace(/\s+/g, ' ').trim().slice(0, 400)}"`;
        mempalace.appendMemory(line, { tag: `npc:${suggestion.npcId || 'unknown'}` })
          .catch(() => {});
      }
    } catch (e) {
      // mempalace-client missing or other issue — silent per brief
    }
  }

  /**
   * Heuristic significance score for an NPC dialogue suggestion. Used by
   * the MemPalace integration to decide whether to persist the line for
   * next session's recall. Returns 0–10.
   *
   * Honors suggestion.importance if present; otherwise scores by keyword
   * matches against campaign-critical topics (Vladislav, Necronomicon,
   * Houska, the Letavec, the cellar, southeast pull) plus length.
   */
  _scoreDialogueSignificance(suggestion) {
    if (Number.isFinite(suggestion?.importance)) return Number(suggestion.importance);
    const text = String(suggestion?.text || '').toLowerCase();
    if (!text) return 0;
    let score = 0;
    const keywords = [
      'vladislav', 'necronomicon', 'page', 'houska', 'orava', 'cellar',
      'letavec', 'southeast', 'pieter', 'piotr', 'tomas', 'marta',
      'wolf', 'spawn', 'hunter', 'bloodline', 'patron', 'ancient'
    ];
    for (const kw of keywords) {
      if (text.includes(kw)) score += 2;
    }
    if (text.length > 100) score += 2;
    if (text.length > 200) score += 1;
    // Heavyweight NPCs always interesting for memory
    const id = String(suggestion?.npcId || '').toLowerCase();
    if (id === 'hooded-stranger' || id === 'vladislav' || id === 'tomas') score += 3;
    return Math.min(10, score);
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

    // NPC explicit addressableAs aliases (e.g. Aldous Kern: "the pilgrim", "the man by the door")
    if (Array.isArray(npc.addressableAs)) {
      for (const alias of npc.addressableAs) {
        const a = (alias || '').toLowerCase();
        if (a.length > 2 && text.includes(a)) return true;
      }
    }

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
- Every response MUST contain actual spoken dialogue — words the NPC says out loud
- Format: "[What they say]" — [one brief physical beat if appropriate, optional]
- NEVER respond with only a physical action, stage direction, or narration
- The spoken words are the response. An action beat may follow but never replaces speech.
- Stay in character based on the NPC's personality, knowledge, and disposition
- Use period-appropriate speech — medieval Central European setting
- Keep responses concise (1-3 sentences of dialogue typical, longer for important reveals)
- NPCs must NOT reveal information they would not know or willingly share
- Horror tone: atmospheric and unsettling, never gratuitous
- If the NPC would genuinely not speak, respond with just "SILENCE"`;
  }

  getStats() {
    return {
      pendingQueue: this._pendingQueue.size,
      totalGenerated: this._dialogueId
    };
  }
}

module.exports = NpcHandler;
