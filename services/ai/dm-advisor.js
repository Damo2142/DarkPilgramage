/**
 * DM Advisor
 * Generates read-aloud descriptions, interprets rolls, looks up rules,
 * and feeds environmental details to the DM's earbud.
 * Works alongside existing NPC handler, atmosphere advisor, and story tracker.
 */

class DmAdvisor {
  constructor(gemini, context, bus, state, config) {
    this.gemini = gemini;
    this.context = context;
    this.bus = bus;
    this.state = state;
    this.config = config;
    this._lastEnvironmentalCue = 0;
    this._environmentalCooldownMs = 60000; // 1 min between AI-generated cues
  }

  /**
   * Generate a read-aloud description for a scene, beat, location, or NPC encounter.
   * Called when DM clicks a beat or asks for a description.
   */
  async generateReadAloud(topic, additionalContext) {
    if (!this.gemini.available) return null;

    const gameContext = this.context.buildNpcContext('dm') || {};
    const contextStr = this.context.toPromptString({
      scene: gameContext.scene,
      worldState: gameContext.worldState,
      atmosphere: gameContext.atmosphere
    });

    const prompt = `You are the Co-DM for a gothic horror D&D 5e game set in 1274 Central Europe. Generate a READ-ALOUD description the DM can speak to players.

${contextStr}

Topic: ${topic}
${additionalContext ? `Additional context: ${additionalContext}` : ''}

Write 2-4 sentences of atmospheric, evocative description in second person ("You see...", "The air smells of..."). Gothic horror tone — dread through implication, sensory details, what's WRONG about the scene. No game mechanics. No dialogue. Just pure description the DM reads aloud.`;

    try {
      const result = await this.gemini.generate(prompt);
      if (result) {
        this.bus.dispatch('dm:whisper', {
          text: `READ ALOUD: ${result}`,
          priority: 2,
          category: 'story'
        });
      }
      return result;
    } catch (err) {
      console.error('[DmAdvisor] Read-aloud error:', err.message);
      return null;
    }
  }

  /**
   * Interpret a dice roll result in context.
   * E.g., player rolls 14 Perception in the common room — what do they notice?
   */
  async interpretRoll(skill, total, playerId, location) {
    if (!this.gemini.available) return null;

    // Get relevant clues for this location and skill
    const world = this.state.get('world') || {};
    const clues = world.clues || {};
    const relevantClues = [];
    for (const [id, clue] of Object.entries(clues)) {
      if (clue.found) continue; // Already found
      if (clue.dc && total >= clue.dc) {
        // Check if the method matches
        const methodMatch = !clue.method || clue.method === skill.toLowerCase() ||
          (skill.toLowerCase() === 'perception' && clue.method === 'perception') ||
          (skill.toLowerCase() === 'investigation' && clue.method === 'investigation') ||
          (skill.toLowerCase() === 'investigation' && clue.method === 'search');
        if (methodMatch) {
          relevantClues.push({ id, ...clue });
        }
      }
    }

    const gameContext = this.context.buildNpcContext('dm') || {};

    // If there are matching clues with read-aloud text, use those directly
    if (relevantClues.length > 0) {
      const clue = relevantClues[0]; // Highest priority
      let response = '';

      if (clue.readAloud) {
        response = clue.readAloud;
      } else {
        response = `${skill} ${total}: They find — ${clue.description}`;
      }

      // Mark clue as found
      this.bus.dispatch('clue:found', { clueId: clue.id, playerId });

      this.bus.dispatch('dm:whisper', {
        text: response,
        priority: 2,
        category: 'story'
      });
      return response;
    }

    // No predefined clue — ask AI what they notice
    const prompt = `You are the Co-DM for a gothic horror D&D 5e game.

Scene: ${gameContext.scene || 'unknown'}
${gameContext.worldState || ''}

A player rolled ${total} on a ${skill} check${location ? ' in ' + location : ''}.

What do they notice or find? Be specific to the current scene. If the roll is low (under 10), they notice nothing unusual. If medium (10-14), give a minor atmospheric detail. If high (15+), give something meaningful but not a major revelation. Keep it to 1-2 sentences. Gothic horror tone.`;

    try {
      const result = await this.gemini.generate(prompt);
      if (result) {
        this.bus.dispatch('dm:whisper', {
          text: `${skill} ${total}: ${result}`,
          priority: 3,
          category: 'story'
        });
      }
      return result;
    } catch (err) {
      console.error('[DmAdvisor] Roll interpret error:', err.message);
      return null;
    }
  }

  /**
   * Look up a D&D 5e rule and whisper a concise summary.
   */
  async lookupRule(query) {
    if (!this.gemini.available) return null;

    const prompt = `You are a D&D 5e rules expert. A DM needs a quick rules reference during a game.

Question: "${query}"

Give a concise, accurate answer (2-3 sentences max). Include specific numbers, DCs, damage dice, etc. If it's a contested check, say what each side rolls. If there are edge cases that matter in play, mention them briefly. This will be spoken into the DM's earbud, so be direct.`;

    try {
      const result = await this.gemini.generate(prompt);
      if (result) {
        this.bus.dispatch('dm:whisper', {
          text: `RULE: ${result}`,
          priority: 2,
          category: 'story'
        });
      }
      return result;
    } catch (err) {
      console.error('[DmAdvisor] Rules lookup error:', err.message);
      return null;
    }
  }

  /**
   * Generate a proactive environmental detail based on current game state.
   * Called periodically or when the AI detects a lull.
   */
  async generateEnvironmentalDetail() {
    if (!this.gemini.available) return null;

    const now = Date.now();
    if (now - this._lastEnvironmentalCue < this._environmentalCooldownMs) return null;
    this._lastEnvironmentalCue = now;

    const gameContext = this.context.buildNpcContext('dm') || {};
    const contextStr = this.context.toPromptString({
      scene: gameContext.scene,
      worldState: gameContext.worldState,
      mapState: gameContext.mapState,
      atmosphere: gameContext.atmosphere
    });

    const prompt = `You are the Co-DM for a gothic horror D&D 5e game.

${contextStr}

Generate a single small environmental detail the DM can drop into the current scene. Something subtle and atmospheric — a sound, a smell, a trick of the light, a small thing that's slightly wrong. One sentence. Gothic horror tone. Not a major plot point, just flavor that builds tension.`;

    try {
      const result = await this.gemini.generate(prompt);
      if (result) {
        this.bus.dispatch('dm:whisper', {
          text: result,
          priority: 5,
          category: 'atmosphere'
        });
      }
      return result;
    } catch (err) {
      console.error('[DmAdvisor] Environmental detail error:', err.message);
      return null;
    }
  }

  /**
   * Evaluate a transcript segment for opportunities to help the DM.
   * Called by AI engine on every transcript input.
   */
  async onTranscript(segment) {
    // Check if this is a roll result that needs interpretation
    const rollMatch = segment.text?.match(/\[Rolled?\s+(\w+)\s*(?:check|save)?\s*=?\s*(\d+)\]/i);
    if (rollMatch) {
      const skill = rollMatch[1];
      const total = parseInt(rollMatch[2]);
      await this.interpretRoll(skill, total, segment.speaker);
      return;
    }

    // Check if DM is asking for a description
    const descMatch = segment.text?.match(/describe\s+(?:the\s+)?(.+)/i);
    if (descMatch && segment.speaker === 'dm') {
      await this.generateReadAloud(descMatch[1]);
      return;
    }

    // Check if DM is asking about rules
    const ruleMatch = segment.text?.match(/(?:how does|what (?:is|are)|rules? for)\s+(.+)/i);
    if (ruleMatch && segment.speaker === 'dm') {
      await this.lookupRule(ruleMatch[1]);
      return;
    }
  }

  getStats() {
    return {
      lastEnvironmentalCue: this._lastEnvironmentalCue
    };
  }
}

module.exports = DmAdvisor;
