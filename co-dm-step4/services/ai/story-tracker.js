/**
 * Story Beat Tracker
 * Monitors transcript and game state to detect when predefined story beats occur.
 */

const fs = require('fs');
const path = require('path');

class StoryTracker {
  constructor(gemini, contextBuilder, bus, state, config) {
    this.gemini = gemini;
    this.ctx = contextBuilder;
    this.bus = bus;
    this.state = state;
    this.config = config;
    this._lastCheckTime = 0;
    this._checkCooldownMs = 60000; // Check every 60 seconds at most
    this._segmentsSinceCheck = 0;
    this._checkEveryNSegments = 5;
    this._systemPrompt = '';

    try {
      this._systemPrompt = fs.readFileSync(
        path.join(__dirname, '..', '..', 'prompts', 'story-tracker.md'), 'utf-8'
      );
    } catch (e) {
      this._systemPrompt = this._defaultPrompt();
    }
  }

  /**
   * Called after each transcript segment
   */
  async onTranscript(segment) {
    this._segmentsSinceCheck++;
    if (this._segmentsSinceCheck < this._checkEveryNSegments) return;
    this._segmentsSinceCheck = 0;

    if (Date.now() - this._lastCheckTime < this._checkCooldownMs) return;

    await this.evaluate();
  }

  /**
   * Evaluate story progress
   */
  async evaluate() {
    if (!this.gemini.available) return;

    const context = this.ctx.buildStoryContext();
    const pendingBeats = (context.beats || []).filter(b => b.status === 'pending');

    if (pendingBeats.length === 0) return; // No pending beats to detect

    const contextStr = this.ctx.toPromptString(context);
    const beatList = pendingBeats.map(b => `- ${b.id}: ${b.name}`).join('\n');

    const response = await this.gemini.generateJSON(
      this._systemPrompt,
      `${contextStr}\n\nPending story beats:\n${beatList}\n\nBased on the recent dialogue and events, have any of these story beats been triggered? Also, should the DM be nudged about anything?`,
      { maxTokens: 300, temperature: 0.5 }
    );

    if (!response) return;

    this._lastCheckTime = Date.now();

    // Handle detected beats
    if (response.detectedBeats && Array.isArray(response.detectedBeats)) {
      for (const beatId of response.detectedBeats) {
        this._completeBeat(beatId);
      }
    }

    // Handle DM nudge
    if (response.nudge && response.nudge.text) {
      this.bus.dispatch('ai:dm_suggestion', {
        type: response.nudge.type || 'nudge',
        text: response.nudge.text,
        relatedBeat: response.nudge.beatId || null
      });
    }
  }

  /**
   * Mark a beat as completed
   */
  _completeBeat(beatId) {
    const beats = this.state.get('story.beats') || [];
    const beat = beats.find(b => b.id === beatId);

    if (!beat || beat.status === 'completed') return;

    beat.status = 'completed';
    beat.completedAt = Date.now();
    this.state.set('story.beats', beats);

    this.bus.dispatch('story:beat', {
      beatId,
      name: beat.name,
      status: 'completed'
    });

    console.log(`[StoryTracker] Beat completed: ${beat.name}`);
  }

  /**
   * Manually mark a beat (DM override)
   */
  markBeat(beatId, status = 'completed') {
    const beats = this.state.get('story.beats') || [];
    const beat = beats.find(b => b.id === beatId);
    if (!beat) return;

    beat.status = status;
    if (status === 'completed') beat.completedAt = Date.now();
    this.state.set('story.beats', beats);

    this.bus.dispatch('story:beat', { beatId, name: beat.name, status });
  }

  /**
   * Add a clue discovery
   */
  addClue(clue) {
    const clues = this.state.get('story.cluesDiscovered') || [];
    if (!clues.includes(clue)) {
      clues.push(clue);
      this.state.set('story.cluesDiscovered', clues);
      this.bus.dispatch('story:clue', { clue });
    }
  }

  /**
   * Log a player decision
   */
  addDecision(decision) {
    const decisions = this.state.get('story.decisions') || [];
    decisions.push({
      text: decision,
      timestamp: Date.now()
    });
    this.state.set('story.decisions', decisions);
    this.bus.dispatch('story:decision', { decision });
  }

  _defaultPrompt() {
    return `You are a story beat tracker for a gothic horror D&D campaign called "The Dark Pilgrimage."

Your job is to monitor the conversation and detect when predefined story beats have occurred.

RULES:
- Only mark a beat as detected when you're confident it has actually happened
- A beat being discussed or planned doesn't count — it must have occurred in the narrative
- Be conservative — false negatives are better than false positives
- Suggest DM nudges sparingly — only when players seem stuck for more than a few minutes

Respond with JSON:
{
  "detectedBeats": ["beat_id", ...] or [],
  "nudge": { "type": "nudge|reminder|warning", "text": "suggestion for DM", "beatId": "related_beat" } or null
}`;
  }

  getStats() {
    const beats = this.state.get('story.beats') || [];
    return {
      totalBeats: beats.length,
      completed: beats.filter(b => b.status === 'completed').length,
      pending: beats.filter(b => b.status === 'pending').length,
      lastCheck: this._lastCheckTime || null
    };
  }
}

module.exports = StoryTracker;
