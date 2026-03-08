/**
 * Atmosphere Advisor
 * Monitors transcript and game state to suggest atmosphere changes.
 */

const fs = require('fs');
const path = require('path');

class AtmosphereAdvisor {
  constructor(gemini, contextBuilder, bus, state, config) {
    this.gemini = gemini;
    this.ctx = contextBuilder;
    this.bus = bus;
    this.state = state;
    this.config = config;
    this._lastSuggestionTime = 0;
    this._cooldownMs = 30000; // Don't suggest more than once per 30 seconds
    this._systemPrompt = '';
    this._profiles = {};
    this._segmentsSinceCheck = 0;
    this._checkEveryNSegments = 3; // Check atmosphere every 3 transcript segments

    // Load prompt
    try {
      this._systemPrompt = fs.readFileSync(
        path.join(__dirname, '..', '..', 'prompts', 'atmosphere-advisor.md'), 'utf-8'
      );
    } catch (e) {
      this._systemPrompt = this._defaultPrompt();
    }

    // Load available profiles
    this._loadProfiles();
  }

  _loadProfiles() {
    const profileDir = path.join(__dirname, '..', '..', 'config', 'atmosphere-profiles');
    try {
      const files = fs.readdirSync(profileDir).filter(f => f.endsWith('.json'));
      for (const file of files) {
        const name = file.replace('.json', '');
        this._profiles[name] = JSON.parse(
          fs.readFileSync(path.join(profileDir, file), 'utf-8')
        );
      }
      console.log(`[AtmosphereAdvisor] Loaded ${Object.keys(this._profiles).length} profiles`);
    } catch (e) {
      console.warn('[AtmosphereAdvisor] No atmosphere profiles found');
    }
  }

  /**
   * Called after each transcript segment
   */
  async onTranscript(segment) {
    this._segmentsSinceCheck++;

    if (this._segmentsSinceCheck < this._checkEveryNSegments) return;
    this._segmentsSinceCheck = 0;

    // Cooldown check
    if (Date.now() - this._lastSuggestionTime < this._cooldownMs) return;

    await this.evaluate();
  }

  /**
   * Evaluate current state and suggest atmosphere changes
   */
  async evaluate() {
    if (!this.gemini.available) return;

    const context = this.ctx.buildAtmosphereContext();
    const contextStr = this.ctx.toPromptString(context);

    const profileNames = Object.keys(this._profiles);
    const profileList = profileNames.length > 0
      ? `Available profiles: ${profileNames.join(', ')}`
      : 'No predefined profiles available';

    const response = await this.gemini.generateJSON(
      this._systemPrompt,
      `${contextStr}\n\n${profileList}\n\nCurrent profile: ${context.currentProfile}\nAverage party dread: ${context.averageDread}/100\n\nShould the atmosphere change? Respond with JSON.`,
      { maxTokens: 200, temperature: 0.6 }
    );

    if (!response) return;

    // response should be { shouldChange: bool, profile: "name", reason: "...", confidence: 0.0-1.0 }
    if (response.shouldChange && response.profile) {
      this._lastSuggestionTime = Date.now();

      const suggestion = {
        profile: response.profile,
        reason: response.reason || 'Narrative shift detected',
        confidence: response.confidence || 0.5,
        currentProfile: context.currentProfile
      };

      // Check trust level
      const trustLevel = this.state.get('session.aiTrustLevel') || 'manual';

      if (trustLevel === 'autopilot' || (trustLevel === 'assisted' && suggestion.confidence >= 0.8)) {
        // Auto-execute
        this.bus.dispatch('atmo:change', {
          profile: suggestion.profile,
          reason: suggestion.reason,
          auto: true
        });
      } else {
        // Suggest to DM
        this.bus.dispatch('ai:atmosphere', suggestion);
      }
    }
  }

  /**
   * Get a profile's settings
   */
  getProfile(name) {
    return this._profiles[name] || null;
  }

  getProfileNames() {
    return Object.keys(this._profiles);
  }

  _defaultPrompt() {
    return `You are an atmosphere advisor for a gothic horror D&D campaign called "The Dark Pilgrimage" set in 1274 Central Europe.

Your job is to monitor the narrative and suggest when the atmosphere should shift.

RULES:
- Only suggest changes when the narrative tone genuinely shifts
- Don't change atmosphere too frequently — let scenes breathe
- Horror should build gradually, not spike constantly
- Consider player Dread levels — high Dread means less additional pressure needed
- Match atmosphere to narrative: calm conversation = warm, tension building = tense, danger = terror

Respond with JSON: { "shouldChange": true/false, "profile": "profile_name", "reason": "brief explanation", "confidence": 0.0-1.0 }

If no change needed: { "shouldChange": false }`;
  }

  getStats() {
    return {
      profileCount: Object.keys(this._profiles).length,
      lastSuggestion: this._lastSuggestionTime || null,
      cooldownMs: this._cooldownMs
    };
  }
}

module.exports = AtmosphereAdvisor;
