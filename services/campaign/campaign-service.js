/**
 * Campaign Service — Phase N: Between Sessions
 * Features 63-68: AI recaps, session summaries, downtime events,
 * XP tracking, campaign timeline, lore database.
 */

const fs = require('fs');
const path = require('path');

class CampaignService {
  constructor() {
    this.name = 'campaign';
    this.orchestrator = null;
    this.bus = null;
    this.state = null;
    this.gemini = null;

    // Campaign data
    this.timeline = [];          // { id, session, gameDate, realDate, title, description, type, tags }
    this.lore = new Map();       // id -> { id, title, category, content, tags, discoveredBy, session }
    this.downtimeEvents = [];    // { id, description, trigger, effects, fired }
    this.xpLog = [];             // { playerId, amount, reason, session, timestamp }
    this.sessionRecaps = [];     // { session, date, narrative, summary, decisions }

    // Campaign expansion data
    this.futureHooks = [];       // loaded from config/future-hooks.json
    this.settlements = [];       // loaded from config/world/settlements.json
    this.creatures = new Map();  // id -> creature stat block from config/creatures/*.json
    this.arc = null;             // loaded from config/campaign/arc.json
    this.settlementReputation = {}; // settlement id -> { standing, known, events }
  }

  async init(orchestrator) {
    this.orchestrator = orchestrator;
    this.bus = orchestrator.bus;
    this.state = orchestrator.state;
    this.config = orchestrator.config;

    // Get Gemini client from AI engine
    const aiEngine = orchestrator.getService('ai-engine');
    if (aiEngine?.gemini) {
      this.gemini = aiEngine.gemini;
    }

    this._loadFromConfig(this.config);
    this._loadCampaignExpansionData();
    this._loadPersistentData();
    this._setupRoutes();

    // Inject future hooks into AI context builder so the Co-DM is aware
    try {
      const ai = this.orchestrator.getService('ai-engine');
      if (ai?.contextBuilder?.setCampaignFutureHooks) {
        ai.contextBuilder.setCampaignFutureHooks(this.futureHooks);
        console.log(`[Campaign] Injected ${this.futureHooks.length} future hooks into AI context`);
      }
    } catch (e) {
      // ai-engine may not be loaded yet — ignore
    }
  }

  _loadCampaignExpansionData() {
    const cfgRoot = path.join(__dirname, '..', '..', 'config');

    // Future hooks
    try {
      const fhPath = path.join(cfgRoot, 'future-hooks.json');
      if (fs.existsSync(fhPath)) {
        const data = JSON.parse(fs.readFileSync(fhPath, 'utf-8'));
        this.futureHooks = data.hooks || [];
        console.log(`[Campaign] Loaded ${this.futureHooks.length} future hooks`);
      }
    } catch (err) {
      console.error('[Campaign] Failed to load future-hooks.json:', err.message);
    }

    // Settlements
    try {
      const sPath = path.join(cfgRoot, 'world', 'settlements.json');
      if (fs.existsSync(sPath)) {
        const data = JSON.parse(fs.readFileSync(sPath, 'utf-8'));
        this.settlements = data.settlements || [];
        // Initialize settlement reputation entries
        for (const s of this.settlements) {
          if (!this.settlementReputation[s.id]) {
            this.settlementReputation[s.id] = { standing: 0, known: false, events: [] };
          }
        }
        console.log(`[Campaign] Loaded ${this.settlements.length} settlements`);
      }
    } catch (err) {
      console.error('[Campaign] Failed to load settlements.json:', err.message);
    }

    // Creatures
    try {
      const creaturesDir = path.join(cfgRoot, 'creatures');
      if (fs.existsSync(creaturesDir)) {
        const files = fs.readdirSync(creaturesDir).filter(f => f.endsWith('.json'));
        for (const f of files) {
          try {
            const c = JSON.parse(fs.readFileSync(path.join(creaturesDir, f), 'utf-8'));
            if (c.id) this.creatures.set(c.id, c);
          } catch (e) {
            console.error(`[Campaign] Bad creature file ${f}: ${e.message}`);
          }
        }
        console.log(`[Campaign] Loaded ${this.creatures.size} creature stat blocks`);
      }
    } catch (err) {
      console.error('[Campaign] Failed to load creatures:', err.message);
    }

    // Campaign arc
    try {
      const arcPath = path.join(cfgRoot, 'campaign', 'arc.json');
      if (fs.existsSync(arcPath)) {
        this.arc = JSON.parse(fs.readFileSync(arcPath, 'utf-8'));
        console.log(`[Campaign] Loaded campaign arc: ${this.arc.title}`);
      }
    } catch (err) {
      console.error('[Campaign] Failed to load arc.json:', err.message);
    }
  }

  async start() {
    // Auto-generate recap on session end
    this.bus.subscribe('session:ended', async (env) => {
      await this._generateSessionRecap(env.data);
    }, 'campaign');

    // Track timeline events from story beats
    this.bus.subscribe('story:beat', (env) => {
      if (env.data?.beatId && env.data?.status === 'completed') {
        this.addTimelineEntry({
          title: env.data.beatName || env.data.beatId,
          description: `Beat completed: ${env.data.beatName || env.data.beatId}`,
          type: 'story',
          tags: ['beat']
        });
      }
    }, 'campaign');

    // Track reputation changes on timeline
    this.bus.subscribe('campaign:reputation_change', (env) => {
      if (env.data?.tierChanged) {
        this.addTimelineEntry({
          title: `Reputation: ${env.data.factionName} → ${env.data.tier}`,
          description: `${env.data.reason} (${env.data.oldScore} → ${env.data.newScore})`,
          type: 'reputation',
          tags: ['faction', env.data.factionId]
        });
      }
    }, 'campaign');

    // Track secret reveals on timeline
    this.bus.subscribe('secret:reveal', (env) => {
      this.addTimelineEntry({
        title: `Secret revealed: ${env.data.secretId}`,
        description: `Discovered by ${env.data.playerId || 'party'} via ${env.data.method || 'unknown'}`,
        type: 'discovery',
        tags: ['secret']
      });
    }, 'campaign');

    // Track deaths on timeline
    this.bus.subscribe('combat:hp_changed', (env) => {
      if (env.data?.hp?.current <= 0 && env.data?.combatantName) {
        this.addTimelineEntry({
          title: `${env.data.combatantName} falls`,
          description: `${env.data.combatantName} dropped to 0 HP`,
          type: 'combat',
          tags: ['death']
        });
      }
    }, 'campaign');

    console.log(`[Campaign] Ready — ${this.timeline.length} timeline entries, ${this.lore.size} lore entries, ${this.downtimeEvents.length} downtime events`);
  }

  async stop() {
    this._savePersistentData();
  }

  getStatus() {
    return {
      status: 'ok',
      timelineEntries: this.timeline.length,
      loreEntries: this.lore.size,
      downtimeEvents: this.downtimeEvents.length,
      sessionRecaps: this.sessionRecaps.length,
      xpEntries: this.xpLog.length,
      futureHooks: this.futureHooks.length,
      settlements: this.settlements.length,
      creatures: this.creatures.size,
      arc: this.arc?.title || null
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // CONFIG & PERSISTENCE
  // ═══════════════════════════════════════════════════════════════

  _loadFromConfig(config) {
    // Downtime events from session config
    if (config.campaign?.downtimeEvents) {
      for (const evt of config.campaign.downtimeEvents) {
        this.downtimeEvents.push({
          id: evt.id,
          description: evt.description,
          trigger: evt.trigger || 'between_sessions', // between_sessions | on_rest | timed
          effects: evt.effects || [],
          fired: false,
          condition: evt.condition || null
        });
      }
    }

    // Lore from config
    if (config.campaign?.lore) {
      for (const entry of config.campaign.lore) {
        this.lore.set(entry.id, {
          id: entry.id,
          title: entry.title,
          category: entry.category || 'general', // history, geography, religion, magic, creature, npc, item
          content: entry.content,
          tags: entry.tags || [],
          discoveredBy: entry.discoveredBy || [],
          session: entry.session || 0,
          hidden: entry.hidden || false
        });
      }
    }

    // Timeline seed
    if (config.campaign?.timeline) {
      for (const t of config.campaign.timeline) {
        this.timeline.push({
          id: t.id || `tl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          session: t.session || 0,
          gameDate: t.gameDate || null,
          realDate: t.realDate || null,
          title: t.title,
          description: t.description || '',
          type: t.type || 'event',
          tags: t.tags || []
        });
      }
    }
  }

  _loadPersistentData() {
    const dataDir = path.join(this.config?.session?.logDir || './sessions', 'campaign');
    try {
      // Timeline
      const tlPath = path.join(dataDir, 'timeline.json');
      if (fs.existsSync(tlPath)) {
        const saved = JSON.parse(fs.readFileSync(tlPath, 'utf-8'));
        // Merge with config entries (avoid duplicates by id)
        const existingIds = new Set(this.timeline.map(t => t.id));
        for (const t of saved) {
          if (!existingIds.has(t.id)) this.timeline.push(t);
        }
      }

      // Lore
      const lorePath = path.join(dataDir, 'lore.json');
      if (fs.existsSync(lorePath)) {
        const saved = JSON.parse(fs.readFileSync(lorePath, 'utf-8'));
        for (const entry of saved) {
          if (!this.lore.has(entry.id)) this.lore.set(entry.id, entry);
        }
      }

      // XP log
      const xpPath = path.join(dataDir, 'xp-log.json');
      if (fs.existsSync(xpPath)) {
        this.xpLog = JSON.parse(fs.readFileSync(xpPath, 'utf-8'));
      }

      // Session recaps
      const recapPath = path.join(dataDir, 'recaps.json');
      if (fs.existsSync(recapPath)) {
        this.sessionRecaps = JSON.parse(fs.readFileSync(recapPath, 'utf-8'));
      }

      console.log(`[Campaign] Loaded persistent data from ${dataDir}`);
    } catch (err) {
      // First run — no data yet
    }
  }

  _savePersistentData() {
    const dataDir = path.join(this.config?.session?.logDir || './sessions', 'campaign');
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(path.join(dataDir, 'timeline.json'), JSON.stringify(this.timeline, null, 2));
      fs.writeFileSync(path.join(dataDir, 'lore.json'), JSON.stringify(Array.from(this.lore.values()), null, 2));
      fs.writeFileSync(path.join(dataDir, 'xp-log.json'), JSON.stringify(this.xpLog, null, 2));
      fs.writeFileSync(path.join(dataDir, 'recaps.json'), JSON.stringify(this.sessionRecaps, null, 2));
      console.log(`[Campaign] Saved persistent data to ${dataDir}`);
    } catch (err) {
      console.error('[Campaign] Save failed:', err.message);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // FEATURE 63 — AI NARRATIVE SESSION RECAP
  // ═══════════════════════════════════════════════════════════════

  async _generateSessionRecap(sessionData) {
    const logger = this.orchestrator.logger;
    const sessionDate = this.state.get('session.date') || new Date().toISOString().slice(0, 10);

    // Read transcript and events
    const transcript = logger.readTranscript(sessionDate);
    const events = logger.readEvents(sessionDate);

    if (!transcript.length && !events.length) {
      console.log('[Campaign] No transcript/events to recap');
      return;
    }

    // Build recap context
    const transcriptText = transcript.slice(-200).map(t =>
      `[${t.speaker || 'unknown'}]: ${t.text || ''}`
    ).join('\n');

    const storyState = this.state.get('story') || {};
    const worldState = this.state.get('world') || {};
    const players = this.state.get('players') || {};

    const contextParts = [
      `Session date: ${sessionDate}`,
      `Duration: ${Math.round((sessionData?.duration || 0) / 60000)} minutes`,
      `Completed beats: ${(storyState.beats || []).filter(b => b.status === 'completed').map(b => b.name).join(', ') || 'none'}`,
      `Secrets revealed: ${Object.values(worldState.secrets || {}).filter(s => s.revealed).map(s => s.description).join('; ') || 'none'}`,
      `Clues found: ${Object.values(worldState.clues || {}).filter(c => c.found).map(c => c.description).join('; ') || 'none'}`,
      `Players: ${Object.entries(players).map(([id, p]) => `${p.character?.name || id} (Dread: ${p.dread?.score || 0})`).join(', ')}`
    ];

    // Try AI generation
    if (this.gemini?.available) {
      try {
        const prompt = fs.readFileSync(path.join(__dirname, '..', '..', 'prompts', 'session-summary.md'), 'utf-8');
        const userPrompt = `${contextParts.join('\n')}\n\n--- TRANSCRIPT (last 200 entries) ---\n${transcriptText}`;

        const response = await this.gemini.generate(prompt, userPrompt, {
          maxTokens: 2000,
          temperature: 0.7
        });

        if (response) {
          const recap = {
            session: sessionData?.sessionId || sessionDate,
            date: sessionDate,
            narrative: response,
            generatedAt: new Date().toISOString()
          };
          this.sessionRecaps.push(recap);
          this._savePersistentData();

          this.bus.dispatch('campaign:recap_generated', { recap });
          console.log(`[Campaign] Session recap generated (${response.length} chars)`);
          return recap;
        }
      } catch (err) {
        console.error('[Campaign] AI recap generation failed:', err.message);
      }
    }

    // Fallback — structured summary without AI
    const recap = {
      session: sessionData?.sessionId || sessionDate,
      date: sessionDate,
      narrative: this._buildBasicRecap(storyState, worldState, players, sessionData),
      generatedAt: new Date().toISOString(),
      aiGenerated: false
    };
    this.sessionRecaps.push(recap);
    this._savePersistentData();
    return recap;
  }

  _buildBasicRecap(story, world, players, sessionData) {
    const parts = [`## Session ${sessionData?.sessionId || 'Unknown'}\n`];

    const completed = (story.beats || []).filter(b => b.status === 'completed');
    if (completed.length) {
      parts.push(`**Story Progress:** ${completed.map(b => b.name).join(', ')}`);
    }

    const revealed = Object.values(world.secrets || {}).filter(s => s.revealed);
    if (revealed.length) {
      parts.push(`**Secrets Revealed:** ${revealed.map(s => s.description).join('; ')}`);
    }

    const found = Object.values(world.clues || {}).filter(c => c.found);
    if (found.length) {
      parts.push(`**Clues Found:** ${found.map(c => c.description).join('; ')}`);
    }

    const playerSummaries = Object.entries(players).map(([id, p]) => {
      const name = p.character?.name || id;
      const dread = p.dread?.score || 0;
      return `${name}: Dread ${dread}/100`;
    });
    if (playerSummaries.length) {
      parts.push(`**Players:** ${playerSummaries.join(', ')}`);
    }

    return parts.join('\n\n');
  }

  // ═══════════════════════════════════════════════════════════════
  // FEATURE 65 — DOWNTIME EVENTS
  // ═══════════════════════════════════════════════════════════════

  runDowntimeEvents() {
    const results = [];
    for (const evt of this.downtimeEvents) {
      if (evt.fired) continue;
      if (evt.trigger !== 'between_sessions') continue;

      // Fire the event
      evt.fired = true;
      results.push({ id: evt.id, description: evt.description });

      // Execute effects
      for (const effect of evt.effects) {
        if (effect.event) {
          this.bus.dispatch(effect.event, effect.data || {});
        }
      }

      // Add to timeline
      this.addTimelineEntry({
        title: `Downtime: ${evt.description}`,
        type: 'downtime',
        tags: ['between-sessions']
      });
    }

    if (results.length) {
      this._savePersistentData();
      this.bus.dispatch('campaign:downtime_complete', { events: results });
    }

    return results;
  }

  async generateDowntimeNarrative() {
    if (!this.gemini?.available) return null;

    const worldState = this.state.get('world') || {};
    const hooks = worldState.futureHooks || {};
    const rep = worldState.reputation || {};

    const prompt = `You are narrating what happens in the world between D&D sessions in "The Dark Pilgrimage," a gothic horror campaign set in 1274 Central Europe.

Based on the current world state, generate 2-3 short downtime events — things that happen in the world while the players are away. These should:
- Advance NPC agendas
- Reflect consequences of player actions
- Build tension for the next session
- Reference active story hooks when appropriate

Keep each event to 1-2 sentences. Format as JSON array: [{"title": "...", "description": "...", "effects": []}]`;

    const context = [
      `Active hooks: ${Object.values(hooks).filter(h => h.status !== 'paid_off').map(h => h.description).join('; ')}`,
      `Faction standing: ${Object.values(rep).map(f => `${f.name}: ${f.score}`).join(', ')}`,
      `World state: ${JSON.stringify(worldState).slice(0, 1000)}`
    ].join('\n');

    try {
      const response = await this.gemini.generate(prompt, context, { maxTokens: 800, temperature: 0.9 });
      if (response) {
        // Try to parse JSON from response
        const jsonMatch = response.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          const events = JSON.parse(jsonMatch[0]);
          for (const evt of events) {
            this.addTimelineEntry({
              title: evt.title,
              description: evt.description,
              type: 'downtime',
              tags: ['ai-generated', 'between-sessions']
            });
          }
          this._savePersistentData();
          return events;
        }
      }
    } catch (err) {
      console.error('[Campaign] Downtime narrative failed:', err.message);
    }
    return null;
  }

  // ═══════════════════════════════════════════════════════════════
  // FEATURE 66 — XP / LEVEL-UP TRACKING
  // ═══════════════════════════════════════════════════════════════

  awardXP(playerId, amount, reason) {
    const entry = {
      playerId,
      amount,
      reason,
      session: this.state.get('session.id') || null,
      timestamp: new Date().toISOString()
    };
    this.xpLog.push(entry);

    // Update player state
    const currentXP = this.state.get(`players.${playerId}.character.xp`) || 0;
    const newXP = currentXP + amount;
    this.state.set(`players.${playerId}.character.xp`, newXP);

    // Check level threshold
    const level = this.state.get(`players.${playerId}.character.level`) || 1;
    const nextLevelXP = this._xpForLevel(level + 1);
    const leveledUp = newXP >= nextLevelXP;

    if (leveledUp) {
      this.bus.dispatch('dm:whisper', {
        text: `${playerId} has enough XP to level up! (${newXP}/${nextLevelXP} XP, level ${level} → ${level + 1})`,
        priority: 3, category: 'story'
      });
      this.bus.dispatch('player:horror_effect', {
        type: 'revelation_flash',
        playerId,
        payload: { color: '#c9a84c', durationMs: 1500 }
      });
    }

    this.bus.dispatch('campaign:xp_awarded', {
      playerId, amount, reason, totalXP: newXP, leveledUp
    });

    this._savePersistentData();
    return { playerId, amount, totalXP: newXP, leveledUp, nextLevelXP };
  }

  getPlayerXP(playerId) {
    const xp = this.state.get(`players.${playerId}.character.xp`) || 0;
    const level = this.state.get(`players.${playerId}.character.level`) || 1;
    const nextLevelXP = this._xpForLevel(level + 1);
    const history = this.xpLog.filter(e => e.playerId === playerId);
    return { xp, level, nextLevelXP, progress: xp / nextLevelXP, history };
  }

  _xpForLevel(level) {
    // D&D 5e XP thresholds
    const thresholds = {
      1: 0, 2: 300, 3: 900, 4: 2700, 5: 6500, 6: 14000,
      7: 23000, 8: 34000, 9: 48000, 10: 64000, 11: 85000,
      12: 100000, 13: 120000, 14: 140000, 15: 165000,
      16: 195000, 17: 225000, 18: 265000, 19: 305000, 20: 355000
    };
    return thresholds[level] || 999999;
  }

  // ═══════════════════════════════════════════════════════════════
  // FEATURE 67 — CAMPAIGN TIMELINE
  // ═══════════════════════════════════════════════════════════════

  addTimelineEntry(data) {
    const entry = {
      id: data.id || `tl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      session: data.session || this.state.get('session.id') || null,
      gameDate: data.gameDate || this.state.get('world.gameTime') || null,
      realDate: new Date().toISOString(),
      title: data.title,
      description: data.description || '',
      type: data.type || 'event', // story, combat, discovery, reputation, downtime, custom
      tags: data.tags || []
    };
    this.timeline.push(entry);
    this._savePersistentData();
    return entry;
  }

  getTimeline(filters) {
    let results = [...this.timeline];
    if (filters?.session) results = results.filter(t => t.session === filters.session);
    if (filters?.type) results = results.filter(t => t.type === filters.type);
    if (filters?.tag) results = results.filter(t => t.tags.includes(filters.tag));
    return results.sort((a, b) => (a.realDate || '').localeCompare(b.realDate || ''));
  }

  // ═══════════════════════════════════════════════════════════════
  // FEATURE 68 — LORE DATABASE
  // ═══════════════════════════════════════════════════════════════

  addLore(data) {
    const id = data.id || `lore-${Date.now()}`;
    const entry = {
      id,
      title: data.title,
      category: data.category || 'general',
      content: data.content,
      tags: data.tags || [],
      discoveredBy: data.discoveredBy || [],
      session: data.session || this.state.get('session.id') || null,
      hidden: data.hidden || false,
      createdAt: new Date().toISOString()
    };
    this.lore.set(id, entry);
    this._savePersistentData();
    return entry;
  }

  getLore(filters) {
    let results = Array.from(this.lore.values());
    if (filters?.category) results = results.filter(l => l.category === filters.category);
    if (filters?.tag) results = results.filter(l => l.tags.includes(filters.tag));
    if (filters?.search) {
      const q = filters.search.toLowerCase();
      results = results.filter(l =>
        l.title.toLowerCase().includes(q) ||
        l.content.toLowerCase().includes(q) ||
        l.tags.some(t => t.toLowerCase().includes(q))
      );
    }
    if (filters?.visibleOnly) results = results.filter(l => !l.hidden);
    return results;
  }

  getPlayerLore(playerId) {
    // Lore entries this player has discovered
    return Array.from(this.lore.values()).filter(l =>
      !l.hidden && (l.discoveredBy.length === 0 || l.discoveredBy.includes(playerId))
    );
  }

  // ═══════════════════════════════════════════════════════════════
  // ROUTES
  // ═══════════════════════════════════════════════════════════════

  _setupRoutes() {
    const app = this.orchestrator.getService('dashboard')?.app;
    if (!app) return;

    // --- Recaps ---
    app.get('/api/campaign/recaps', (req, res) => {
      res.json(this.sessionRecaps);
    });

    app.post('/api/campaign/recap/generate', async (req, res) => {
      const recap = await this._generateSessionRecap({
        sessionId: this.state.get('session.id'),
        duration: this.state.get('session.elapsedMs')
      });
      res.json({ ok: true, recap });
    });

    // --- Downtime ---
    app.get('/api/campaign/downtime', (req, res) => {
      res.json(this.downtimeEvents);
    });

    app.post('/api/campaign/downtime/run', async (req, res) => {
      const results = this.runDowntimeEvents();
      res.json({ ok: true, events: results });
    });

    app.post('/api/campaign/downtime/generate', async (req, res) => {
      const events = await this.generateDowntimeNarrative();
      res.json({ ok: true, events });
    });

    // --- XP ---
    app.get('/api/campaign/xp', (req, res) => {
      const players = this.state.get('players') || {};
      const result = {};
      for (const pid of Object.keys(players)) {
        result[pid] = this.getPlayerXP(pid);
      }
      res.json(result);
    });

    app.post('/api/campaign/xp', (req, res) => {
      const { playerId, amount, reason } = req.body;
      if (!playerId || !amount) return res.status(400).json({ error: 'playerId and amount required' });
      const result = this.awardXP(playerId, parseInt(amount), reason || 'DM award');
      res.json({ ok: true, ...result });
    });

    app.post('/api/campaign/xp/party', (req, res) => {
      const { amount, reason } = req.body;
      if (!amount) return res.status(400).json({ error: 'amount required' });
      const players = this.state.get('players') || {};
      const results = [];
      for (const pid of Object.keys(players)) {
        results.push(this.awardXP(pid, parseInt(amount), reason || 'Party XP'));
      }
      res.json({ ok: true, results });
    });

    // --- Timeline ---
    app.get('/api/campaign/timeline', (req, res) => {
      res.json(this.getTimeline({
        session: req.query.session,
        type: req.query.type,
        tag: req.query.tag
      }));
    });

    app.post('/api/campaign/timeline', (req, res) => {
      const { title, description, type, tags } = req.body;
      if (!title) return res.status(400).json({ error: 'title required' });
      const entry = this.addTimelineEntry({ title, description, type, tags });
      res.json({ ok: true, entry });
    });

    // --- Lore ---
    app.get('/api/campaign/lore', (req, res) => {
      res.json(this.getLore({
        category: req.query.category,
        tag: req.query.tag,
        search: req.query.search
      }));
    });

    app.get('/api/campaign/lore/:id', (req, res) => {
      const entry = this.lore.get(req.params.id);
      if (!entry) return res.status(404).json({ error: 'lore not found' });
      res.json(entry);
    });

    app.post('/api/campaign/lore', (req, res) => {
      const { title, category, content, tags, hidden } = req.body;
      if (!title || !content) return res.status(400).json({ error: 'title and content required' });
      const entry = this.addLore({ title, category, content, tags, hidden });
      res.json({ ok: true, entry });
    });

    app.get('/api/campaign/lore/player/:playerId', (req, res) => {
      res.json(this.getPlayerLore(req.params.playerId));
    });

    // --- Future Hooks ---
    app.get('/api/future-hooks', (req, res) => {
      // Sorted by payoff session ascending
      const sortKey = (h) => {
        const s = (h.payoffSession || '').toString();
        const m = s.match(/(\d+)/);
        return m ? parseInt(m[1]) : 999;
      };
      const sorted = [...this.futureHooks].sort((a, b) => sortKey(a) - sortKey(b));
      res.json(sorted);
    });

    app.get('/api/future-hooks/:id', (req, res) => {
      const hook = this.futureHooks.find(h => h.id === req.params.id);
      if (!hook) return res.status(404).json({ error: 'hook not found' });
      res.json(hook);
    });

    // --- Settlements ---
    app.get('/api/settlements', (req, res) => {
      // Merge reputation into each
      const merged = this.settlements.map(s => ({
        ...s,
        reputation: this.settlementReputation[s.id] || { standing: 0, known: false, events: [] }
      }));
      res.json(merged);
    });

    app.get('/api/settlements/:id', (req, res) => {
      const s = this.settlements.find(x => x.id === req.params.id);
      if (!s) return res.status(404).json({ error: 'settlement not found' });
      res.json({ ...s, reputation: this.settlementReputation[s.id] || { standing: 0, known: false, events: [] } });
    });

    app.post('/api/settlements/:id/reputation', (req, res) => {
      const { delta, reason } = req.body;
      if (!this.settlementReputation[req.params.id]) {
        this.settlementReputation[req.params.id] = { standing: 0, known: false, events: [] };
      }
      const rep = this.settlementReputation[req.params.id];
      rep.standing += parseInt(delta || 0);
      rep.known = true;
      rep.events.push({ delta, reason, timestamp: new Date().toISOString() });
      this.bus.dispatch('campaign:settlement_reputation_change', { settlementId: req.params.id, delta, reason, newStanding: rep.standing });
      res.json({ ok: true, reputation: rep });
    });

    // --- Creatures ---
    app.get('/api/creatures', (req, res) => {
      res.json(Array.from(this.creatures.values()));
    });

    app.get('/api/creatures/:id', (req, res) => {
      const c = this.creatures.get(req.params.id);
      if (!c) return res.status(404).json({ error: 'creature not found' });
      res.json(c);
    });

    // --- Campaign arc ---
    app.get('/api/campaign/arc', (req, res) => {
      res.json(this.arc || {});
    });

    // --- Full campaign state ---
    app.get('/api/campaign', (req, res) => {
      res.json({
        timeline: this.timeline.slice(-50),
        lore: Array.from(this.lore.values()).map(l => ({ id: l.id, title: l.title, category: l.category, hidden: l.hidden })),
        recaps: this.sessionRecaps.slice(-5),
        xp: (() => {
          const players = this.state.get('players') || {};
          const result = {};
          for (const pid of Object.keys(players)) { result[pid] = this.getPlayerXP(pid); }
          return result;
        })(),
        downtimeEvents: this.downtimeEvents.filter(e => !e.fired).length,
        futureHooks: this.futureHooks.length,
        settlements: this.settlements.length,
        creatures: this.creatures.size,
        arc: this.arc ? { title: this.arc.title, currentAct: 1 } : null,
        settlementReputation: this.settlementReputation
      });
    });
  }
}

module.exports = CampaignService;
