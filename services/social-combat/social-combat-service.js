/**
 * Social Combat Service — System D
 * Manages social encounters as structured momentum-based exchanges.
 * Also handles ambient NPC behavior (periodic idle observations).
 *
 * Social combat: momentum -10 to +10, player vs NPC skill checks.
 * Ambient NPCs: every 8-12 minutes, AI generates idle NPC observations.
 */

class SocialCombatService {
  constructor() {
    this.name = 'social-combat';
    this.orchestrator = null;
    this.bus = null;
    this.state = null;

    // Social combat state
    this.socialCombat = {
      active: false,
      npcId: null,
      npcName: null,
      momentum: 0,        // -10 to +10
      round: 0,
      log: [],             // { round, actor, action, skill, roll, npcRoll, shift, momentum, dialogue }
      npcAdvantage: false,  // Some NPCs get advantage on rolls
      npcMinMomentum: -10   // Floor — some NPCs withdraw before losing
    };

    // Ambient NPC behavior
    this._ambientInterval = null;
    this._ambientEnabled = true;
    this._lastAmbientFire = 0;
    this._ambientBaseMinMs = 120000;  // 2 min minimum
    this._ambientBaseMaxMs = 240000;  // 4 min maximum
  }

  async init(orchestrator) {
    this.orchestrator = orchestrator;
    this.bus = orchestrator.bus;
    this.state = orchestrator.state;
    this.config = orchestrator.config;
  }

  async start() {
    this.bus.subscribe('state:session_reset', () => {
      console.log('[SocialCombat] Session reset');
      this._endSocialCombat();
      this._stopAmbientTimer();
    }, 'social-combat');

    // Social combat events
    this.bus.subscribe('social-combat:start', (env) => this._startSocialCombat(env.data), 'social-combat');
    this.bus.subscribe('social-combat:action', (env) => this._processAction(env.data), 'social-combat');
    this.bus.subscribe('social-combat:end', () => this._endSocialCombat(), 'social-combat');

    // Disable ambient during social combat
    this.bus.subscribe('combat:started', () => { this._ambientEnabled = false; }, 'social-combat');
    this.bus.subscribe('combat:ended', () => { this._ambientEnabled = true; }, 'social-combat');

    // Session lifecycle
    this.bus.subscribe('session:started', () => this._startAmbientTimer(), 'social-combat');
    this.bus.subscribe('session:ended', () => this._stopAmbientTimer(), 'social-combat');

    this._setupRoutes();
    this._syncToState();

    console.log('[SocialCombat] Ready');
  }

  async stop() {
    this._stopAmbientTimer();
  }

  getStatus() {
    return {
      status: 'ok',
      socialCombatActive: this.socialCombat.active,
      ambientEnabled: this._ambientEnabled,
      momentum: this.socialCombat.momentum
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // SOCIAL COMBAT
  // ═══════════════════════════════════════════════════════════════

  _startSocialCombat(data) {
    const { npcId, npcName } = data;
    if (this.socialCombat.active) {
      this._endSocialCombat();
    }

    // Load NPC-specific rules
    const npcRules = this._getNpcRules(npcId);

    this.socialCombat = {
      active: true,
      npcId,
      npcName: npcName || npcId,
      momentum: 0,
      round: 0,
      log: [],
      npcAdvantage: npcRules.advantage || false,
      npcMinMomentum: npcRules.minMomentum != null ? npcRules.minMomentum : -10
    };

    this._ambientEnabled = false; // Disable ambient during social combat

    this.bus.dispatch('social-combat:started', {
      npcId,
      npcName: this.socialCombat.npcName,
      npcAdvantage: this.socialCombat.npcAdvantage
    });

    this.bus.dispatch('dm:whisper', {
      text: `Social encounter begun with ${this.socialCombat.npcName}. Momentum at 0. Player actions: Persuade (CHA), Deceive (CHA+Deception), Intimidate (CHA/STR), Insight (WIS), Recall (INT).`,
      priority: 2,
      category: 'social-combat'
    });

    this._syncToState();
    console.log(`[SocialCombat] Started with ${npcName || npcId}`);
  }

  _getNpcRules(npcId) {
    // Vladislav-specific rules
    if (npcId === 'hooded-stranger' || npcId === 'vladislav') {
      return {
        advantage: true,
        minMomentum: -3, // Never lets momentum drop below -3
        goal: 'probe for information about Barry without revealing recognition'
      };
    }
    return { advantage: false, minMomentum: -10 };
  }

  /**
   * Process a social combat action.
   * data: { playerId, action, skill, roll, modifier }
   * action: 'persuade', 'deceive', 'intimidate', 'insight', 'recall'
   */
  async _processAction(data) {
    if (!this.socialCombat.active) return;

    const { playerId, action, skill, roll, modifier } = data;
    this.socialCombat.round++;

    // Calculate player total
    const playerTotal = (roll || 0) + (modifier || 0);

    // NPC opposing check
    let npcRoll = Math.floor(Math.random() * 20) + 1;
    if (this.socialCombat.npcAdvantage) {
      const secondRoll = Math.floor(Math.random() * 20) + 1;
      npcRoll = Math.max(npcRoll, secondRoll);
    }

    // NPC modifier based on skill opposition
    const npcMod = this._getNpcModifier(this.socialCombat.npcId, action);
    const npcTotal = npcRoll + npcMod;

    // Calculate momentum shift
    const diff = playerTotal - npcTotal;
    let shift = 0;
    if (diff >= 5) shift = 3;        // Player wins by 5+
    else if (diff > 0) shift = 1;    // Player wins
    else if (diff === 0) shift = 0;  // Tie
    else if (diff > -5) shift = -1;  // NPC wins
    else shift = -3;                  // NPC wins by 5+

    const oldMomentum = this.socialCombat.momentum;
    this.socialCombat.momentum = Math.max(-10, Math.min(10,
      this.socialCombat.momentum + shift
    ));

    // Enforce NPC minimum momentum
    if (this.socialCombat.momentum < this.socialCombat.npcMinMomentum) {
      this.socialCombat.momentum = this.socialCombat.npcMinMomentum;
      // NPC withdraws with contempt
      this.bus.dispatch('dm:whisper', {
        text: `${this.socialCombat.npcName} withdraws — they will not be pushed further. They leave with contempt, not defeat.`,
        priority: 2,
        category: 'social-combat'
      });
    }

    // Log the exchange
    const entry = {
      round: this.socialCombat.round,
      playerId,
      action,
      skill: skill || action,
      playerRoll: roll,
      playerTotal,
      npcRoll,
      npcTotal,
      shift,
      momentum: this.socialCombat.momentum,
      dialogue: null // Will be filled by AI
    };
    this.socialCombat.log.push(entry);

    // Generate NPC dialogue response
    const dialogue = await this._generateNpcDialogue(entry);
    entry.dialogue = dialogue;

    // Check for Vladislav insight during social combat
    if (action === 'insight' && playerTotal >= 18) {
      const npcId = this.socialCombat.npcId;
      if (npcId === 'hooded-stranger' || npcId === 'vladislav') {
        // Private observation to the insightful player
        this.bus.dispatch('dm:private_message', {
          playerId,
          text: 'He is not trying to win this conversation. He is learning something.',
          durationMs: 45000,
          style: 'observation'
        });
      }
    }

    // Dispatch result
    this.bus.dispatch('social-combat:result', {
      ...entry,
      dialogue,
      npcName: this.socialCombat.npcName
    });

    // Check for conclusion
    if (this.socialCombat.momentum >= 10) {
      this.bus.dispatch('dm:whisper', {
        text: `Social combat COMPLETE — players win. Momentum +10. ${this.socialCombat.npcName} concedes fully.`,
        priority: 1,
        category: 'social-combat'
      });
    } else if (this.socialCombat.momentum >= 5) {
      this.bus.dispatch('dm:whisper', {
        text: `Momentum at +${this.socialCombat.momentum} — players gaining significant ground.`,
        priority: 3,
        category: 'social-combat'
      });
    } else if (this.socialCombat.momentum <= -5) {
      this.bus.dispatch('dm:whisper', {
        text: `Momentum at ${this.socialCombat.momentum} — ${this.socialCombat.npcName} has the upper hand.`,
        priority: 3,
        category: 'social-combat'
      });
    } else if (this.socialCombat.momentum <= -10) {
      this.bus.dispatch('dm:whisper', {
        text: `Social combat COMPLETE — ${this.socialCombat.npcName} wins on their terms. Momentum -10.`,
        priority: 1,
        category: 'social-combat'
      });
    }

    this._syncToState();
    console.log(`[SocialCombat] R${entry.round}: ${playerId} ${action} (${playerTotal}) vs ${this.socialCombat.npcName} (${npcTotal}) → shift ${shift > 0 ? '+' : ''}${shift}, momentum ${this.socialCombat.momentum}`);
  }

  _getNpcModifier(npcId, action) {
    // Vladislav: high CHA, high WIS, high INT
    if (npcId === 'hooded-stranger' || npcId === 'vladislav') {
      const mods = { persuade: 7, deceive: 9, intimidate: 8, insight: 6, recall: 5 };
      return mods[action] || 6;
    }
    // Tomas: average CHA, moderate WIS
    if (npcId === 'tomas') {
      const mods = { persuade: 2, deceive: 1, intimidate: 3, insight: 2, recall: 0 };
      return mods[action] || 1;
    }
    // Marta: moderate CHA, high WIS (perceptive innkeeper)
    if (npcId === 'marta') {
      const mods = { persuade: 3, deceive: 1, intimidate: -1, insight: 4, recall: 1 };
      return mods[action] || 2;
    }
    return 2; // Default NPC modifier
  }

  async _generateNpcDialogue(entry) {
    const aiEngine = this.orchestrator.getService('ai-engine');
    if (!aiEngine?.gemini?.available) return null;

    const npcId = this.socialCombat.npcId;
    const momentum = this.socialCombat.momentum;
    const tone = momentum >= 3 ? 'grudging, uncomfortable, losing ground' :
                 momentum <= -3 ? 'contemptuous, confident, in control' :
                 'measured, probing, careful';

    try {
      const prompt = `You are ${this.socialCombat.npcName} in a social encounter. The player just used ${entry.action}. The momentum is ${momentum}/10 (positive = players winning). Your tone should be: ${tone}.

Generate ONE line of spoken dialogue (in quotation marks) that this NPC would say right now. Keep it under 30 words. Start with the quotation mark.`;

      const context = aiEngine.context?.buildNpcContext?.(npcId);
      const systemPrompt = `You are a gothic horror NPC. Respond with ONE line of dialogue only, in quotation marks. ${tone}`;

      const response = await aiEngine.gemini.generate(systemPrompt, prompt, { maxTokens: 100, temperature: 0.8 });
      return response?.trim() || null;
    } catch (e) {
      console.warn(`[SocialCombat] Dialogue generation failed: ${e.message}`);
      return null;
    }
  }

  _endSocialCombat() {
    if (!this.socialCombat.active) return;

    const result = {
      npcId: this.socialCombat.npcId,
      npcName: this.socialCombat.npcName,
      finalMomentum: this.socialCombat.momentum,
      rounds: this.socialCombat.round,
      outcome: this.socialCombat.momentum >= 5 ? 'player_win' :
               this.socialCombat.momentum <= -5 ? 'npc_win' : 'draw'
    };

    this.bus.dispatch('social-combat:ended', result);
    this._ambientEnabled = true;

    console.log(`[SocialCombat] Ended: ${result.outcome} (momentum ${result.finalMomentum})`);

    this.socialCombat = {
      active: false, npcId: null, npcName: null,
      momentum: 0, round: 0, log: [],
      npcAdvantage: false, npcMinMomentum: -10
    };

    this._syncToState();
  }

  // ═══════════════════════════════════════════════════════════════
  // AMBIENT NPC BEHAVIOR
  // ═══════════════════════════════════════════════════════════════

  _startAmbientTimer() {
    this._stopAmbientTimer();
    // Random interval: 8-12 minutes (480000-720000ms)
    this._scheduleNextAmbient();
  }

  _stopAmbientTimer() {
    if (this._ambientInterval) {
      clearTimeout(this._ambientInterval);
      this._ambientInterval = null;
    }
  }

  _scheduleNextAmbient() {
    // Horror score scales frequency: higher horror = more frequent ambient behavior
    // Average horror across all players, 0-100
    const horrorService = this.orchestrator?.getService('horror');
    const horrorScores = horrorService?.horrorScores || {};
    const scores = Object.values(horrorScores);
    const avgHorror = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;

    // Scale: horror 0 = full interval, horror 100 = half interval
    const scale = 1 - (avgHorror / 200); // 1.0 at horror 0, 0.5 at horror 100
    const minMs = Math.floor(this._ambientBaseMinMs * scale);
    const maxMs = Math.floor(this._ambientBaseMaxMs * scale);
    const intervalMs = minMs + Math.floor(Math.random() * (maxMs - minMs));

    this._ambientInterval = setTimeout(() => {
      this._fireAmbientObservation();
      this._scheduleNextAmbient();
    }, intervalMs);
  }

  async _fireAmbientObservation() {
    if (!this._ambientEnabled) return;
    if (this.socialCombat.active) return;
    if (this.state.get('session.status') !== 'active') return;
    if (this.state.get('combat.active')) return;

    // Don't fire during timed event resolution
    const now = Date.now();
    if (now - this._lastAmbientFire < 30000) return; // Min 30s between
    this._lastAmbientFire = now;

    // Pick an active NPC
    const npcs = this.config.npcs || {};
    const activeNpcs = Object.entries(npcs).filter(([, npc]) =>
      npc.status === 'alive' || npc.status === 'active' || !npc.status
    );

    if (activeNpcs.length === 0) return;

    const [npcId, npc] = activeNpcs[Math.floor(Math.random() * activeNpcs.length)];
    const npcName = npc.name || npcId;

    // Try AI generation
    const aiEngine = this.orchestrator.getService('ai-engine');
    if (aiEngine?.gemini?.available) {
      try {
        const gameTime = this.state.get('world.gameTime') || '';
        const prompt = `What is ${npcName} doing right now? They are in a tavern common room. The game time is ${gameTime}. Their personality: ${npc.disposition || 'neutral'}. Their current goal: ${npc.goals?.[0]?.goal || 'survive the night'}.

Generate ONE ambient observation sentence about what they are doing. Format: "${npcName} [action]". Keep it under 20 words. Do NOT include dialogue.`;

        const response = await aiEngine.gemini.generate(
          'You describe NPC idle behavior in a gothic horror tavern. One sentence only.',
          prompt,
          { maxTokens: 60, temperature: 0.9 }
        );

        if (response) {
          const text = response.trim();
          this.bus.dispatch('dm:whisper', {
            text: `Ambient — ${npcName}: ${text}`,
            priority: 5,
            category: 'ambient'
          });
          // Also send to all player screens as atmospheric flavor
          this.bus.dispatch('ambient:observation', {
            npcId, npcName, text, timestamp: Date.now()
          });
          console.log(`[SocialCombat] Ambient: ${npcName} — ${text.substring(0, 60)}...`);
          return;
        }
      } catch (e) {
        // Fallback to pre-built
      }
    }

    // Fallback ambient observations
    const fallbacks = {
      'marta': [
        'polishes the same glass she has been holding for ten minutes',
        'glances at the cellar door and quickly looks away',
        'wipes down the bar with sharp, nervous movements',
        'pours herself a drink, stares at it, does not drink',
        'flinches at a creak from upstairs, then forces a smile',
        'moves a candle closer to the bar, as if the light itself is a comfort',
        'whispers something to herself — sounds like a prayer',
        'drops a glass behind the bar. Catches it. Her hands are shaking'
      ],
      'tomas': [
        'drums his fingers on the table in an irregular rhythm',
        'pulls his collar tighter and stares at the window',
        'counts something under his breath, loses count, starts again',
        'scratches at his forearm through his sleeve',
        'stands abruptly, walks to the window, sits back down',
        'sniffs the air and his jaw tightens',
        'checks the door latch for the third time',
        'tilts his head toward the cellar, nostrils flaring'
      ],
      'hooded-stranger': [
        'has not moved. The shadows around him seem deeper',
        'tilts his head, listening to something no one else can hear',
        'his hand rests on the table — the fingers are very long',
        'the faintest smile. Gone before you can be sure',
        'his eyes catch the firelight for an instant. The reflection is wrong',
        'a moth lands on his sleeve. It dies immediately',
        'turns his head exactly toward whoever last mentioned the cellar',
        'the candle nearest him gutters and dims, though there is no draft'
      ],
      'patron-farmer': [
        'stares into his stew. Has not taken a single bite',
        'mutters about his grandmother and crosses himself',
        'shakes his head slowly, as if confirming something terrible',
        'looks at the stranger\'s corner and goes pale',
        'grips the edge of the table until his knuckles whiten',
        'whispers to no one: "Same as the goats. Same as the goats."'
      ],
      'patron-merchant': [
        'checks his coin purse again. Counts under his breath',
        'eyes the door, calculating the distance to his horse',
        'takes a long drink and refills immediately',
        'leans toward the nearest player and whispers: "We should leave at first light"',
        'flinches at the wind and pulls his coat tighter',
        'rearranges his goods under the table for the fourth time'
      ],
      'patron-pilgrim': [
        'his lips move in prayer. The words are barely audible',
        'clutches his holy symbol and closes his eyes',
        'opens his eyes and stares at the stranger\'s corner with undisguised fear',
        'reaches for the flask at his belt, hesitates, then resumes praying',
        'the candle beside him burns steady and tall while others flicker',
        'makes the sign of the cross toward the cellar door'
      ],
      'patron-minstrel': [
        'runs her fingers across the lute strings without playing',
        'watches everyone with those sharp, clever eyes',
        'scribbles something in a small journal, then closes it quickly',
        'hums a melody under her breath — something old and minor-key',
        'tilts her head, listening to the building creak and settle',
        'catches your eye and raises an eyebrow as if to say: "you see it too?"'
      ]
    };

    const npcFallbacks = fallbacks[npcId] || ['sits quietly, watching the room'];
    const text = npcFallbacks[Math.floor(Math.random() * npcFallbacks.length)];

    this.bus.dispatch('dm:whisper', {
      text: `Ambient — ${npcName}: ${text}`,
      priority: 5,
      category: 'ambient'
    });

    // Also send to all player screens
    this.bus.dispatch('ambient:observation', {
      npcId, npcName, text, timestamp: Date.now()
    });

    console.log(`[SocialCombat] Ambient (fallback): ${npcName} — ${text}`);
  }

  // ═══════════════════════════════════════════════════════════════
  // STATE SYNC
  // ═══════════════════════════════════════════════════════════════

  _syncToState() {
    this.state.set('socialCombat', {
      active: this.socialCombat.active,
      npcId: this.socialCombat.npcId,
      npcName: this.socialCombat.npcName,
      momentum: this.socialCombat.momentum,
      round: this.socialCombat.round,
      lastExchange: this.socialCombat.log.length > 0
        ? this.socialCombat.log[this.socialCombat.log.length - 1]
        : null,
      ambientEnabled: this._ambientEnabled
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // API ROUTES
  // ═══════════════════════════════════════════════════════════════

  _setupRoutes() {
    const app = this.orchestrator.getService('dashboard')?.app;
    if (!app) return;

    // GET /api/social-combat — current state
    app.get('/api/social-combat', (req, res) => {
      res.json({
        ...this.socialCombat,
        log: this.socialCombat.log.slice(-10) // Last 10 entries
      });
    });

    // POST /api/social-combat/start — begin social encounter
    app.post('/api/social-combat/start', (req, res) => {
      const { npcId, npcName } = req.body;
      if (!npcId) return res.status(400).json({ error: 'npcId required' });
      this._startSocialCombat({ npcId, npcName: npcName || npcId });
      res.json({ ok: true, state: this.socialCombat });
    });

    // POST /api/social-combat/action — player makes a social action
    app.post('/api/social-combat/action', async (req, res) => {
      const { playerId, action, skill, roll, modifier } = req.body;
      if (!playerId || !action) return res.status(400).json({ error: 'playerId and action required' });
      await this._processAction({ playerId, action, skill, roll: roll || 0, modifier: modifier || 0 });
      res.json({
        ok: true,
        momentum: this.socialCombat.momentum,
        round: this.socialCombat.round,
        lastExchange: this.socialCombat.log[this.socialCombat.log.length - 1]
      });
    });

    // POST /api/social-combat/end — end social encounter
    app.post('/api/social-combat/end', (req, res) => {
      this._endSocialCombat();
      res.json({ ok: true });
    });

    // POST /api/social-combat/momentum — manually adjust momentum
    app.post('/api/social-combat/momentum', (req, res) => {
      const { value } = req.body;
      if (value == null) return res.status(400).json({ error: 'value required' });
      this.socialCombat.momentum = Math.max(-10, Math.min(10, value));
      this._syncToState();
      res.json({ ok: true, momentum: this.socialCombat.momentum });
    });

    // POST /api/social-combat/ambient-toggle — toggle ambient NPC behavior
    app.post('/api/social-combat/ambient-toggle', (req, res) => {
      this._ambientEnabled = !this._ambientEnabled;
      res.json({ ok: true, ambientEnabled: this._ambientEnabled });
    });
  }
}

module.exports = SocialCombatService;
