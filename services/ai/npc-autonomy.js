/**
 * NPC Autonomy Engine
 * Makes NPCs act independently — move, react, pursue goals, change disposition.
 * Operates on timers and event triggers, not just transcript.
 * Works alongside NPC dialogue handler.
 */

class NpcAutonomy {
  constructor(gemini, contextBuilder, bus, state, config) {
    this.gemini = gemini;
    this.ctx = contextBuilder;
    this.bus = bus;
    this.state = state;
    this.config = config;

    // Per-NPC disposition toward each player: { npcId: { playerId: score } }
    this.dispositions = {};

    // Action cooldowns per NPC (prevent spam)
    this._lastAction = {}; // npcId -> timestamp
    this._actionCooldownMs = 30000; // 30s between autonomous actions per NPC

    // Autonomous check interval
    this._autonomyInterval = null;
    this._tickCount = 0;
  }

  start() {
    // Initialize dispositions from config
    const npcs = this.config.npcs || {};
    for (const [npcId, npc] of Object.entries(npcs)) {
      this.dispositions[npcId] = {};
      // Default dispositions
      if (npc.disposition === 'nervous') this.dispositions[npcId]._default = 30;
      else if (npc.disposition === 'agitated') this.dispositions[npcId]._default = 10;
      else if (npc.disposition === 'watchful') this.dispositions[npcId]._default = -20;
      else this.dispositions[npcId]._default = 0;
    }

    // Listen for player interactions that affect disposition
    this.bus.subscribe('npc:approved', (env) => {
      this._onNpcSpoke(env.data);
    }, 'npc-autonomy');

    // Listen for world events that trigger NPC reactions
    this.bus.subscribe('world:timed_event', (env) => {
      this._onTimedEvent(env.data);
    }, 'npc-autonomy');

    this.bus.subscribe('world:clue_found', (env) => {
      this._onClueFound(env.data);
    }, 'npc-autonomy');

    this.bus.subscribe('world:secret_revealed', (env) => {
      this._onSecretRevealed(env.data);
    }, 'npc-autonomy');

    this.bus.subscribe('story:beat', (env) => {
      this._onBeatCompleted(env.data);
    }, 'npc-autonomy');

    // NPC goal timer events from world clock
    this.bus.subscribe('world:npc_goal_timer', (env) => {
      this._onGoalTimer(env.data);
    }, 'npc-autonomy');

    // Periodic autonomy check — every 30 seconds
    this._autonomyInterval = setInterval(() => {
      if (this.state.get('session.status') !== 'active') return;
      this._tickCount++;
      this._autonomyTick();
    }, 30000);

    console.log(`[NpcAutonomy] Initialized with ${Object.keys(this.dispositions).length} NPCs`);
  }

  stop() {
    if (this._autonomyInterval) clearInterval(this._autonomyInterval);
  }

  // ═══════════════════════════════════════════════════════════════
  // DISPOSITION SYSTEM
  // ═══════════════════════════════════════════════════════════════

  getDisposition(npcId, playerId) {
    const npcDisp = this.dispositions[npcId];
    if (!npcDisp) return 0;
    return npcDisp[playerId] ?? npcDisp._default ?? 0;
  }

  adjustDisposition(npcId, playerId, delta, reason) {
    if (!this.dispositions[npcId]) this.dispositions[npcId] = {};
    const current = this.getDisposition(npcId, playerId);
    const newVal = Math.max(-100, Math.min(100, current + delta));
    this.dispositions[npcId][playerId] = newVal;

    this.bus.dispatch('npc:disposition_change', {
      npcId, playerId, oldValue: current, newValue: newVal, delta, reason
    });

    // Whisper significant changes
    if (Math.abs(delta) >= 10) {
      const npc = this.state.get(`npcs.${npcId}`);
      const direction = delta > 0 ? 'warms to' : 'turns against';
      this.bus.dispatch('dm:whisper', {
        text: `${npc?.name || npcId} ${direction} ${playerId} (${newVal > 0 ? '+' : ''}${newVal}). Reason: ${reason}`,
        priority: 4,
        category: 'npc'
      });
    }

    // Update state for AI context
    this.state.set(`npcs.${npcId}.dispositions`, this.dispositions[npcId]);
  }

  // ═══════════════════════════════════════════════════════════════
  // AUTONOMOUS ACTIONS
  // ═══════════════════════════════════════════════════════════════

  async _autonomyTick() {
    if (!this.gemini.available) return;

    const npcs = this.state.get('npcs') || {};
    const trustLevel = this.state.get('session.aiTrustLevel') || 'manual';
    const worldGoals = this.state.get('world.npcGoals') || {};

    for (const [npcId, npc] of Object.entries(npcs)) {
      if (npc.status !== 'alive') continue;

      // Check cooldown
      const lastAction = this._lastAction[npcId] || 0;
      if (Date.now() - lastAction < this._actionCooldownMs) continue;

      // Check if NPC has active goals
      const goals = worldGoals[npcId] || [];
      const activeGoals = goals.filter(g => g.status === 'active');

      if (activeGoals.length === 0) continue;

      // Ask AI what this NPC would do
      await this._evaluateNpcAction(npcId, npc, activeGoals, trustLevel);
    }
  }

  async _evaluateNpcAction(npcId, npc, activeGoals, trustLevel) {
    const context = this.ctx.buildNpcContext(npcId);
    if (!context) return;

    const contextStr = this.ctx.toPromptString(context);
    const goalStr = activeGoals.map(g => `- [P${g.priority}] ${g.goal}`).join('\n');

    // Get dialogue hints if available
    const configNpc = this.config.npcs?.[npcId];
    const hintsStr = configNpc?.dialogueHints
      ? '\nDialogue hints:\n' + Object.entries(configNpc.dialogueHints).map(([topic, hint]) => `  ${topic}: ${hint}`).join('\n')
      : '';

    const prompt = `You are the AI controlling ${npc.name} in a gothic horror D&D game.

${contextStr}

Active goals:
${goalStr}
${hintsStr}

Based on the current situation, what would ${npc.name} do RIGHT NOW? Consider:
- Their personality and disposition
- Their goals and urgency
- What players are doing and where they are
- What would be most dramatic and interesting

Respond with JSON:
{
  "action": "speak" | "move" | "observe" | "nothing",
  "urgency": 1-10,
  "intent": "brief description of what they intend (whispered to DM before executing)",
  "dialogue": "what they say (if action is speak, otherwise null)",
  "moveTo": "zone or position description (if action is move, otherwise null)",
  "reason": "why they're doing this"
}

If the NPC would not act right now, use action "nothing".`;

    try {
      const response = await this.gemini.generateJSON(
        'You control NPCs in a D&D game. Return valid JSON only.',
        prompt,
        { maxTokens: 300, temperature: 0.8 }
      );

      if (!response || response.action === 'nothing') return;

      this._lastAction[npcId] = Date.now();

      // Always whisper intent to DM first
      if (response.intent) {
        this.bus.dispatch('dm:whisper', {
          text: `[${npc.name}] Intent: ${response.intent}`,
          priority: 3,
          category: 'npc'
        });
      }

      // Execute based on trust level
      if (trustLevel === 'autopilot') {
        await this._executeNpcAction(npcId, npc, response);
      } else if (trustLevel === 'assisted' && response.urgency >= 7) {
        // Auto-execute high-urgency actions in assisted mode
        await this._executeNpcAction(npcId, npc, response);
      } else {
        // Queue for DM — just the whisper is enough, DM decides
        this.bus.dispatch('ai:npc_action', {
          npcId,
          npc: npc.name,
          action: response.action,
          intent: response.intent,
          dialogue: response.dialogue,
          moveTo: response.moveTo,
          urgency: response.urgency,
          reason: response.reason
        });
      }
    } catch (err) {
      console.error(`[NpcAutonomy] Action eval error for ${npcId}:`, err.message);
    }
  }

  async _executeNpcAction(npcId, npc, action) {
    if (action.action === 'speak' && action.dialogue) {
      // Generate and auto-approve dialogue
      this.bus.dispatch('npc:approved', {
        id: `auto-${Date.now()}`,
        npc: npc.name,
        npcId,
        text: action.dialogue,
        voiceProfile: npc.voiceProfile || null,
        autoApproved: true
      });

      // Add to dialogue history
      const history = npc.dialogueHistory || [];
      history.push(action.dialogue);
      if (history.length > 10) history.shift();
      this.state.set(`npcs.${npcId}.dialogueHistory`, history);
    }

    if (action.action === 'move' && action.moveTo) {
      // Update NPC location in state
      this.state.set(`npcs.${npcId}.location`, action.moveTo);

      // Try to move token on map
      this._moveNpcToken(npcId, action.moveTo);

      this.bus.dispatch('dm:whisper', {
        text: `${npc.name} moves to: ${action.moveTo}`,
        priority: 3,
        category: 'npc'
      });
    }

    if (action.action === 'observe') {
      this.bus.dispatch('dm:whisper', {
        text: `${npc.name} is watching: ${action.reason || action.intent}`,
        priority: 4,
        category: 'npc'
      });
    }
  }

  /**
   * Attempt to move an NPC token to a named zone on the map
   */
  _moveNpcToken(npcId, destination) {
    const tokens = this.state.get('map.tokens') || {};
    const zones = this.state.get('map.zones') || [];
    const gs = this.state.get('map.gridSize') || 70;

    // Find the NPC's token
    let tokenId = null;
    for (const [id, tok] of Object.entries(tokens)) {
      if (tok.actorSlug === npcId || tok.slug === npcId || id.startsWith(npcId)) {
        tokenId = id;
        break;
      }
    }
    if (!tokenId) return;

    // Find destination zone
    const destLower = destination.toLowerCase();
    const zone = zones.find(z =>
      (z.name || '').toLowerCase().includes(destLower) ||
      (z.id || '').toLowerCase().includes(destLower)
    );

    if (zone) {
      // Move to center of zone
      let x, y;
      if (zone.points) {
        // Polygon — average of vertices
        x = zone.points.reduce((s, p) => s + p.x, 0) / zone.points.length;
        y = zone.points.reduce((s, p) => s + p.y, 0) / zone.points.length;
      } else {
        x = zone.x + zone.w / 2;
        y = zone.y + zone.h / 2;
      }

      // Snap to grid
      x = Math.round(x / gs) * gs + gs / 2;
      y = Math.round(y / gs) * gs + gs / 2;

      this.bus.dispatch('token:move', { entityId: tokenId, to: { x, y } });
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // EVENT REACTIONS
  // ═══════════════════════════════════════════════════════════════

  async _onTimedEvent(eventData) {
    // NPCs react to world events
    const npcs = this.state.get('npcs') || {};

    // Moonrise affects Tomas
    if (eventData.id === 'moonrise') {
      const tomas = npcs.tomas;
      if (tomas && tomas.status === 'alive') {
        this.state.set('npcs.tomas.disposition', 'desperate');
        this.bus.dispatch('dm:whisper', {
          text: 'Tomas feels the moon rise. His agitation spikes dramatically. He MUST reach the cellar.',
          priority: 2,
          category: 'story'
        });
      }
    }

    // Dawn forces Vladislav to retreat
    if (eventData.id === 'dawn') {
      const vladislav = npcs['hooded-stranger'];
      if (vladislav && vladislav.status === 'alive') {
        this.bus.dispatch('dm:whisper', {
          text: 'Dawn approaches. Vladislav must reach his coffin or flee. He becomes desperate and dangerous.',
          priority: 1,
          category: 'story'
        });
      }
    }
  }

  _onClueFound(data) {
    // NPCs react when players find clues near them
    const npcs = this.state.get('npcs') || {};

    // If cellar-related clue found, Vladislav gets nervous
    if (data.clueId?.includes('cellar') && npcs['hooded-stranger']?.status === 'alive') {
      this.bus.dispatch('dm:whisper', {
        text: 'Vladislav noticed the players investigating the cellar. He shifts in his seat — barely perceptible, but his grip tightens.',
        priority: 3,
        category: 'npc'
      });
    }

    // If Tomas-related clue found, he reacts
    if (data.clueId?.includes('tomas') && npcs.tomas?.status === 'alive') {
      this.bus.dispatch('dm:whisper', {
        text: 'Tomas pulls his sleeve down quickly. If the player makes eye contact, his face goes pale.',
        priority: 3,
        category: 'npc'
      });
    }
  }

  _onSecretRevealed(data) {
    // Major NPC reactions to secret reveals
    const npcs = this.state.get('npcs') || {};

    if (data.secretId === 'vladislav_is_vampire' && npcs['hooded-stranger']?.status === 'alive') {
      this.state.set('npcs.hooded-stranger.disposition', 'hostile');
      this.bus.dispatch('dm:whisper', {
        text: 'Vladislav knows he has been discovered. He stands slowly. The shadows around him deepen. He will fight or flee — his protect_lair goal is now CRITICAL.',
        priority: 1,
        category: 'story'
      });
    }

    if (data.secretId === 'tomas_is_werewolf' && npcs.tomas?.status === 'alive') {
      this.state.set('npcs.tomas.disposition', 'terrified');
      this.bus.dispatch('dm:whisper', {
        text: 'Tomas is exposed. He looks at the players with raw terror. "Please... you don\'t understand... I didn\'t choose this..." He is not hostile — he is begging.',
        priority: 1,
        category: 'story'
      });
    }
  }

  _onBeatCompleted(data) {
    // Activate relevant NPC goals when beats complete
    // (World clock also does this, but we add NPC-specific reactions)
    const npcs = this.state.get('npcs') || {};

    if (data.beatId === 'escalation') {
      // All NPCs react to escalation
      if (npcs.marta?.status === 'alive') {
        this.bus.dispatch('dm:whisper', {
          text: 'Marta is on the verge of breaking down. She grips the bar with white knuckles. One more scare and she tells everything.',
          priority: 3,
          category: 'npc'
        });
      }
    }
  }

  _onNpcSpoke(data) {
    // Track that an NPC spoke — affects pacing
    this.ctx.addTranscript({
      speaker: data.npc,
      text: data.text,
      timestamp: Date.now()
    });
  }

  async _onGoalTimer(data) {
    // An NPC goal timer expired — they must act now
    const { npcId, goalId, goal, actions } = data;
    const npc = this.state.get(`npcs.${npcId}`);
    if (!npc || npc.status !== 'alive') return;

    this.bus.dispatch('dm:whisper', {
      text: `URGENT: ${npc.name}'s goal "${goal}" timer expired. They will now: ${(actions || []).join(', ')}`,
      priority: 1,
      category: 'story'
    });

    // In autopilot, execute the action
    const trustLevel = this.state.get('session.aiTrustLevel') || 'manual';
    if (trustLevel === 'autopilot') {
      // Generate urgent dialogue/action
      await this._evaluateNpcAction(npcId, npc, [{ goal, priority: 0, status: 'active' }], trustLevel);
    }
  }

  getStats() {
    return {
      dispositions: Object.keys(this.dispositions).length,
      tickCount: this._tickCount,
      lastActions: Object.fromEntries(
        Object.entries(this._lastAction).map(([id, ts]) => [id, Date.now() - ts])
      )
    };
  }
}

module.exports = NpcAutonomy;
