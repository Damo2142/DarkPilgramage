/**
 * Context Builder
 * Assembles current game state, recent transcript, and NPC info
 * into a context block the AI can reason about.
 */

class ContextBuilder {
  constructor(state, config) {
    this.state = state;
    this.config = config;
    this._recentTranscript = []; // Rolling buffer
    this._maxTranscriptMinutes = config.ai?.contextWindowMinutes || 5;
  }

  /**
   * Add a transcript segment to the rolling buffer
   */
  addTranscript(segment) {
    this._recentTranscript.push({
      ...segment,
      timestamp: segment.timestamp || Date.now()
    });

    // Trim old entries
    const cutoff = Date.now() - (this._maxTranscriptMinutes * 60 * 1000);
    this._recentTranscript = this._recentTranscript.filter(s => s.timestamp >= cutoff);
  }

  /**
   * Build full context for NPC dialogue generation
   */
  buildNpcContext(npcId) {
    const npc = this.state.get(`npcs.${npcId}`);
    if (!npc) return null;

    const scene = this.state.get('scene') || {};
    const players = this.state.get('players') || {};
    const story = this.state.get('story') || {};
    const atmosphere = this.state.get('atmosphere') || {};

    return {
      scene: this._formatScene(scene),
      npc: this._formatNpc(npcId, npc),
      players: this._formatPlayers(players),
      recentDialogue: this._formatTranscript(),
      storyContext: this._formatStory(story),
      atmosphere: atmosphere.currentProfile || 'default',
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Build context for atmosphere suggestions
   */
  buildAtmosphereContext() {
    const scene = this.state.get('scene') || {};
    const atmosphere = this.state.get('atmosphere') || {};
    const players = this.state.get('players') || {};
    const story = this.state.get('story') || {};

    // Calculate average dread
    const playerList = Object.values(players);
    const avgDread = playerList.length > 0
      ? playerList.reduce((sum, p) => sum + (p.dread?.score || 0), 0) / playerList.length
      : 0;

    return {
      scene: this._formatScene(scene),
      currentProfile: atmosphere.currentProfile || 'default',
      recentDialogue: this._formatTranscript(),
      averageDread: Math.round(avgDread),
      playerDread: Object.fromEntries(
        Object.entries(players).map(([id, p]) => [id, p.dread?.score || 0])
      ),
      storyContext: this._formatStory(story),
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Build context for story beat detection
   */
  buildStoryContext() {
    const story = this.state.get('story') || {};
    const scene = this.state.get('scene') || {};

    return {
      scene: this._formatScene(scene),
      currentAct: story.currentAct || 'unknown',
      beats: (story.beats || []).map(b => ({
        id: b.id,
        name: b.name,
        status: b.status
      })),
      cluesDiscovered: story.cluesDiscovered || [],
      decisions: story.decisions || [],
      recentDialogue: this._formatTranscript(),
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Get the full context as a single string for system prompts
   */
  toPromptString(context) {
    const parts = [];

    if (context.scene) {
      parts.push(`## Current Scene\n${context.scene}`);
    }
    if (context.npc) {
      parts.push(`## Active NPC\n${context.npc}`);
    }
    if (context.players) {
      parts.push(`## Players\n${context.players}`);
    }
    if (context.storyContext) {
      parts.push(`## Story Progress\n${context.storyContext}`);
    }
    if (context.recentDialogue) {
      parts.push(`## Recent Dialogue\n${context.recentDialogue}`);
    }
    if (context.atmosphere) {
      parts.push(`## Atmosphere: ${context.atmosphere}`);
    }
    if (context.averageDread !== undefined) {
      parts.push(`## Average Party Dread: ${context.averageDread}/100`);
    }

    return parts.join('\n\n');
  }

  // === Private formatters ===

  _formatScene(scene) {
    const parts = [];
    if (scene.name) parts.push(`Location: ${scene.name}`);
    if (scene.description) parts.push(scene.description);
    if (scene.weather) parts.push(`Weather: ${scene.weather}`);
    if (scene.timeOfDay) parts.push(`Time: ${scene.timeOfDay}`);
    return parts.join('\n') || 'Unknown location';
  }

  _formatNpc(id, npc) {
    const parts = [
      `Name: ${npc.name || id}`,
      `Role: ${npc.role || 'unknown'}`,
      `Disposition: ${npc.disposition || 'neutral'}`,
      `Location: ${npc.location || 'nearby'}`
    ];
    if (npc.trueIdentity) parts.push(`True Identity: ${npc.trueIdentity}`);
    if (npc.knowledge?.length) parts.push(`Knows: ${npc.knowledge.join('; ')}`);
    if (npc.dialogueHistory?.length) {
      const recent = npc.dialogueHistory.slice(-3);
      parts.push(`Recent dialogue: ${recent.map(d => `"${d}"`).join(' | ')}`);
    }
    return parts.join('\n');
  }

  _formatPlayers(players) {
    return Object.entries(players).map(([id, p]) => {
      const c = p.character || {};
      const hp = c.hp || {};
      const dread = p.dread || {};
      return `${c.name || id}: ${c.race || '?'} ${c.class || '?'} Lv${c.level || 1}, HP ${hp.current || '?'}/${hp.max || '?'}, Dread ${dread.score || 0}/100 (${dread.threshold || 'calm'})`;
    }).join('\n') || 'No players';
  }

  _formatTranscript() {
    if (this._recentTranscript.length === 0) return 'No recent dialogue';

    return this._recentTranscript.map(s => {
      const time = new Date(s.timestamp).toLocaleTimeString('en-US', { hour12: false });
      return `[${time}] ${s.speaker}: ${s.text}`;
    }).join('\n');
  }

  _formatStory(story) {
    const parts = [];
    if (story.currentAct) parts.push(`Current Act: ${story.currentAct}`);

    const pending = (story.beats || []).filter(b => b.status === 'pending');
    const completed = (story.beats || []).filter(b => b.status === 'completed');

    if (completed.length) parts.push(`Completed: ${completed.map(b => b.name).join(', ')}`);
    if (pending.length) parts.push(`Upcoming: ${pending.map(b => b.name).join(', ')}`);
    if (story.cluesDiscovered?.length) parts.push(`Clues found: ${story.cluesDiscovered.join(', ')}`);

    return parts.join('\n') || 'No story tracking active';
  }

  /**
   * Get transcript buffer stats
   */
  getStats() {
    return {
      transcriptEntries: this._recentTranscript.length,
      windowMinutes: this._maxTranscriptMinutes,
      oldestEntry: this._recentTranscript[0]?.timestamp || null
    };
  }
}

module.exports = ContextBuilder;
