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
      mapState: this._formatMapState(),
      worldState: this._formatWorldState(),
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
      mapState: this._formatMapState(),
      worldState: this._formatWorldState(),
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
      mapState: this._formatMapState(),
      worldState: this._formatWorldState(),
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
    if (context.mapState) {
      parts.push(`## Map & Positions\n${context.mapState}`);
    }
    if (context.worldState) {
      parts.push(`## World State\n${context.worldState}`);
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

  _formatMapState() {
    const map = this.state.get('map') || {};
    if (!map.id) return 'No map loaded';

    const tokens = map.tokens || {};
    const zones = map.zones || [];
    const gs = map.gridSize || 70;
    const parts = [`Active Map: ${map.name || map.id} (${Math.round(map.width/gs)}x${Math.round(map.height/gs)} grid)`];

    // Token positions — convert pixel coords to grid squares
    const tokenList = Object.entries(tokens);
    if (tokenList.length) {
      parts.push('Token positions (grid x,y):');
      for (const [id, tok] of tokenList) {
        const gx = Math.round((tok.x || 0) / gs);
        const gy = Math.round((tok.y || 0) / gs);
        const hp = tok.hp ? ` HP:${tok.hp.current}/${tok.hp.max}` : '';
        const hidden = tok.hidden ? ' [HIDDEN]' : '';
        // Check which zone the token is in
        let inZone = '';
        for (const z of zones) {
          if (z.points) {
            // Polygon zone — skip for now (complex)
          } else if (z.x != null && z.width != null) {
            if (tok.x >= z.x && tok.x <= z.x + z.width && tok.y >= z.y && tok.y <= z.y + z.height) {
              inZone = ` in "${z.name || z.id}"`;
              break;
            }
          }
        }
        parts.push(`  ${tok.name || id}: (${gx},${gy})${hp}${hidden}${inZone}`);
      }
    }

    // Zones
    if (zones.length) {
      parts.push('Map zones: ' + zones.map(z => z.name || z.id).join(', '));
    }

    // Include tokens from non-active maps (so AI always knows where everyone is)
    try {
      const mapSvc = this._getMapService();
      if (mapSvc) {
        for (const [mapId, mapDef] of mapSvc.maps) {
          if (mapId === map.id) continue; // Already included above
          const otherTokens = mapDef.tokens || {};
          const otherEntries = Object.entries(otherTokens);
          if (otherEntries.length) {
            const mgs = mapDef.gridSize || 70;
            parts.push(`\nOther Map: ${mapDef.name || mapId}`);
            for (const [id, tok] of otherEntries) {
              const gx = Math.round((tok.x || 0) / mgs);
              const gy = Math.round((tok.y || 0) / mgs);
              const hp = tok.hp ? ` HP:${tok.hp.current}/${tok.hp.max}` : '';
              const hidden = tok.hidden ? ' [HIDDEN]' : '';
              parts.push(`  ${tok.name || id}: (${gx},${gy})${hp}${hidden}`);
            }
          }
        }
      }
    } catch (e) {
      // Map service not available — skip cross-map tokens
    }

    return parts.join('\n');
  }

  _getMapService() {
    // Access map service via state's orchestrator reference if available
    if (this._mapService) return this._mapService;
    return null;
  }

  setMapService(mapSvc) {
    this._mapService = mapSvc;
  }

  /**
   * Inject the campaign future hooks list (loaded by campaign service)
   * so AI prompts can reference all planted seeds.
   */
  setCampaignFutureHooks(hooks) {
    this._campaignFutureHooks = hooks || [];
  }

  _formatWorldState() {
    const world = this.state.get('world') || {};
    const parts = [];

    // Game time
    if (world.gameTime) {
      const gt = new Date(world.gameTime);
      const h = gt.getHours().toString().padStart(2, '0');
      const m = gt.getMinutes().toString().padStart(2, '0');
      parts.push(`Game time: ${h}:${m}`);
    }

    // Secrets — what's revealed and what isn't
    const secrets = world.secrets || {};
    const unrevealed = [];
    const revealed = [];
    for (const [id, s] of Object.entries(secrets)) {
      if (s.revealed) {
        revealed.push(`${id}: ${s.description} (discovered by: ${s.discoveredBy?.join(', ') || 'unknown'})`);
      } else {
        unrevealed.push(`${id}: ${s.description} (known by NPCs: ${s.knownBy?.join(', ') || 'none'})`);
      }
    }
    if (unrevealed.length) parts.push(`UNREVEALED secrets:\n  ${unrevealed.join('\n  ')}`);
    if (revealed.length) parts.push(`Revealed secrets:\n  ${revealed.join('\n  ')}`);

    // Clues
    const clues = world.clues || {};
    const foundClues = [];
    const unfoundClues = [];
    for (const [id, c] of Object.entries(clues)) {
      if (c.found) {
        foundClues.push(`${id}: ${c.description}`);
      } else {
        unfoundClues.push(`${id}: ${c.description} (${c.location || 'somewhere'})`);
      }
    }
    if (foundClues.length) parts.push(`Clues found: ${foundClues.join('; ')}`);
    if (unfoundClues.length) parts.push(`Clues NOT found: ${unfoundClues.join('; ')}`);

    // NPC goals
    const goals = world.npcGoals || {};
    for (const [npcId, goalList] of Object.entries(goals)) {
      const active = (goalList || []).filter(g => g.status === 'active' || g.status === 'pending');
      if (active.length) {
        parts.push(`${npcId} goals: ${active.map(g => `[${g.status}] ${g.goal}`).join('; ')}`);
      }
    }

    // Future hooks (for AI to reference/foreshadow)
    const hooks = world.futureHooks || {};
    const activeHooks = Object.values(hooks).filter(h => h.status !== 'paid_off' && h.status !== 'abandoned');
    if (activeHooks.length) {
      parts.push(`Active story hooks: ${activeHooks.map(h => `[${h.status}] ${h.description}`).join('; ')}`);
    }

    // Campaign expansion future hooks (loaded from config/future-hooks.json by campaign service)
    const campaignHooks = this._campaignFutureHooks || [];
    if (campaignHooks.length) {
      const summaries = campaignHooks.map(h =>
        `${h.title} (${h.creature}) [${h.status}] payoff:${h.payoffSession || '?'} — ${h.description?.slice(0, 200) || ''}`
      );
      parts.push(`Campaign Future Hooks (DM-only context):\n  ${summaries.join('\n  ')}`);
    }

    // Current settlement and active threats
    const journey = this.state.get('journey');
    if (journey && journey.active) {
      parts.push(`Active Journey: ${journey.origin} -> ${journey.destination} (day ${journey.daysTraveled + 1}, ${journey.daysRemaining} remaining, terrain: ${journey.currentTerrain}, weather: ${journey.currentWeather})`);
      if (journey.campChoice) parts.push(`Camp choice: ${journey.campChoice}`);
      if (journey.complications?.length) parts.push(`Journey complications: ${journey.complications.map(c => c.description).join('; ')}`);
    }

    // Vladislav special context — he is aware of False Hydra, Penitent, Letavec
    parts.push('AI behavioral guidance: Vladislav has hydraAwareness and penitentAversion flags. Never contradict his knowledge of the False Hydra (he knows, finds it useful) or his disturbance at the Penitent (he will not go near infected creatures). He knows about the Noční Letavec and trades information for leverage in social combat. Aldous Kern\'s journal references "W." consistently across every interaction. Henryk should mention boot wax casually at some point.');

    // Reputation
    const rep = world.reputation || {};
    const factions = Object.values(rep);
    if (factions.length) {
      parts.push(`Faction standing: ${factions.map(f => `${f.name}: ${f.score} (${f.tier})`).join(', ')}`);
    }

    // Backstory hooks to weave in
    const backstories = world.backstories || {};
    for (const [pid, bs] of Object.entries(backstories)) {
      if (bs.activeHooks > 0) {
        parts.push(`Player ${pid} has ${bs.activeHooks} un-integrated backstory hook(s), themes: ${(bs.themes || []).join(', ')}`);
      }
    }

    return parts.join('\n') || 'No world state';
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
      const bs = c.backstory || {};
      const app = c.appearance || {};
      const parts = [];
      parts.push(`${c.name || id}: ${c.race || '?'} ${c.class || '?'} Lv${c.level || 1}, HP ${hp.current || '?'}/${hp.max || '?'}, Dread ${dread.score || 0}/100 (${dread.threshold || 'calm'})`);
      if (c.patron) parts.push(`  Subclass/Patron: ${c.patron}`);
      if (c.background) parts.push(`  Background: ${c.background}`);
      if (app.faith) parts.push(`  Faith: ${app.faith}`);
      if (bs.personalityTraits) parts.push(`  Personality: ${bs.personalityTraits}`);
      if (bs.ideals) parts.push(`  Ideals: ${bs.ideals}`);
      if (bs.bonds) parts.push(`  Bonds: ${bs.bonds}`);
      if (bs.flaws) parts.push(`  Flaws: ${bs.flaws}`);
      if (bs.backstoryText) parts.push(`  Backstory: ${bs.backstoryText.slice(0, 500)}`);
      if (bs.allies) parts.push(`  Allies: ${bs.allies.slice(0, 300)}`);
      if (bs.organizations) parts.push(`  Organizations: ${bs.organizations.slice(0, 300)}`);
      if (bs.enemies) parts.push(`  Enemies: ${bs.enemies.slice(0, 300)}`);
      return parts.join('\n');
    }).join('\n\n') || 'No players';
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
