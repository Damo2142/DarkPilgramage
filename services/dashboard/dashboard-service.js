const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');
const { WebSocketServer } = require('ws');
const path = require('path');

class DashboardService {
  constructor() {
    this.name = 'dashboard';
    this.orchestrator = null;
    this.app = null;
    this.server = null;
    this.wss = null;
    this.clients = new Set();
  }

  async init(orchestrator) {
    this.orchestrator = orchestrator;
    this.bus = orchestrator.bus;
    this.state = orchestrator.state;
    this.config = orchestrator.config;
  }

  async start() {
    const port = this.config.server.port || 3200;
    const host = this.config.server.host || '0.0.0.0';

    this.app = express();
    this.app.use(express.json());
    this.app.use(express.static(path.join(__dirname, 'public'), { etag: false, lastModified: false, setHeaders: (res) => res.set('Cache-Control', 'no-store') }));

    // Serve player bridge UI from dashboard port too (avoids separate cert acceptance)
    this.app.get('/player/:playerId', (req, res) => {
      res.sendFile(path.join(__dirname, '..', 'player-bridge', 'public', 'index.html'));
    });
    this.app.use('/assets', express.static(path.join(__dirname, '..', '..', 'assets')));

    this._setupRoutes();

    try {
      const sslKey = fs.readFileSync(path.join(__dirname, '..', '..', 'key.pem'));
      const sslCert = fs.readFileSync(path.join(__dirname, '..', '..', 'cert.pem'));
      this.server = https.createServer({ key: sslKey, cert: sslCert }, this.app);
      console.log('[Dashboard] Using HTTPS');
    } catch(e) {
      this.server = http.createServer(this.app);
      console.log('[Dashboard] Using HTTP (no certs found)');
    }

    this.wss = new WebSocketServer({ noServer: true });
    this.wss.on('connection', (ws) => this._onConnection(ws));

    // Route WS upgrades: ?player= goes to player-bridge, otherwise dashboard
    this.server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url, 'http://localhost');
      const playerId = url.searchParams.get('player');
      if (playerId) {
        // Delegate to player-bridge WSS
        const playerBridge = this.orchestrator.getService('player-bridge');
        if (playerBridge && playerBridge.wss) {
          playerBridge.wss.handleUpgrade(req, socket, head, (ws) => {
            playerBridge.wss.emit('connection', ws, req);
          });
        } else {
          socket.destroy();
        }
      } else {
        this.wss.handleUpgrade(req, socket, head, (ws) => {
          this.wss.emit('connection', ws, req);
        });
      }
    });

    this.bus.subscribe('*', (envelope) => {
      this._broadcast({ type: envelope.event, ...envelope });
    }, 'dashboard');

    return new Promise((resolve) => {
      this.server.listen(port, host, () => {
        const proto = this.server instanceof https.Server ? 'https' : 'http';
        console.log(`[Dashboard] Web UI: ${proto}://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
        resolve();
      });
    });
  }

  _setupRoutes() {
    this.app.get('/api/health', (req, res) => {
      res.json({
        status: 'ok',
        uptime: process.uptime(),
        services: this.orchestrator.getHealthReport(),
        eventBus: this.bus.getStats(),
        logger: this.orchestrator.logger.getStats()
      });
    });

    this.app.get('/api/state', (req, res) => {
      res.json(this.state.snapshot());
    });

    this.app.post('/api/session/start', (req, res) => {
      const sessionId = this.state.startSession();
      res.json({ sessionId });
    });

    this.app.post('/api/session/pause', (req, res) => {
      this.state.pauseSession();
      res.json({ status: 'paused' });
    });

    this.app.post('/api/session/resume', (req, res) => {
      this.state.resumeSession();
      res.json({ status: 'active' });
    });

    this.app.post('/api/session/end', (req, res) => {
      this.state.endSession();
      res.json({ status: 'ended' });
    });

    this.app.post('/api/panic', (req, res) => {
      this.bus.dispatch('panic', {});
      res.json({ status: 'panic triggered' });
    });

    this.app.post('/api/state/set', (req, res) => {
      const { path, value } = req.body;
      if (!path) return res.status(400).json({ error: 'path required' });
      this.state.set(path, value);
      res.json({ path, value });
    });

    this.app.post('/api/trust', (req, res) => {
      const { level } = req.body;
      if (!['manual', 'assisted', 'autopilot'].includes(level)) {
        return res.status(400).json({ error: 'Invalid trust level' });
      }
      this.state.set('session.aiTrustLevel', level);
      this.bus.dispatch('config:trust_level', { level });
      res.json({ trustLevel: level });
    });

    // POST /api/transcript — manual transcript input (feeds AI like mic would)
    this.app.post('/api/transcript', (req, res) => {
      const { speaker, text } = req.body;
      if (!text) return res.status(400).json({ error: 'text required' });

      // Dispatch as transcript:segment — same event Whisper STT produces
      this.bus.dispatch('transcript:segment', {
        speaker: speaker || 'dm',
        text: text,
        timestamp: Date.now(),
        confidence: 1.0,
        source: 'manual'
      });

      res.json({ ok: true });
    });

    // POST /api/codm/ask — ask the Co-DM a question (rules, description, advice)
    this.app.post('/api/codm/ask', async (req, res) => {
      const { question } = req.body;
      if (!question) return res.status(400).json({ error: 'question required' });

      const aiEngine = this.orchestrator.getService('ai-engine');
      if (!aiEngine || !aiEngine.gemini || !aiEngine.gemini.available) {
        return res.json({ error: 'AI not available — check GEMINI_API_KEY' });
      }

      try {
        // Build context for the question
        const context = aiEngine.context.buildNpcContext('dm') || {};
        const contextStr = aiEngine.context.toPromptString({
          scene: context.scene,
          players: context.players,
          storyContext: context.storyContext,
          mapState: context.mapState,
          worldState: context.worldState,
          atmosphere: context.atmosphere
        });

        const prompt = `You are the Co-DM — an AI assistant helping a human DM run a gothic horror D&D 5e game set in 1274 Central Europe.

${contextStr}

The DM asks: "${question}"

Answer concisely (2-4 sentences). If it's a rules question, give the D&D 5e rule. If it's a description request, write atmospheric read-aloud text. If it's advice, suggest what to do based on the current game state. Be direct and useful — this will be spoken into the DM's earbud.`;

        const answer = await aiEngine.gemini.generate(prompt);
        if (answer) {
          // Also whisper the answer
          this.bus.dispatch('dm:whisper', {
            text: answer,
            priority: 2,
            category: 'story'
          });
          res.json({ answer });
        } else {
          res.json({ error: 'No response from AI' });
        }
      } catch (err) {
        console.error('[Dashboard] Co-DM ask error:', err.message);
        res.json({ error: err.message });
      }
    });

    // POST /api/codm/read-aloud — generate a read-aloud description
    this.app.post('/api/codm/read-aloud', async (req, res) => {
      const { topic, context: additionalContext } = req.body;
      if (!topic) return res.status(400).json({ error: 'topic required' });

      const aiEngine = this.orchestrator.getService('ai-engine');
      if (!aiEngine?.advisor) return res.json({ error: 'AI not available' });

      const result = await aiEngine.advisor.generateReadAloud(topic, additionalContext);
      res.json({ text: result || 'No description generated' });
    });

    // POST /api/codm/interpret-roll — interpret a roll result
    this.app.post('/api/codm/interpret-roll', async (req, res) => {
      const { skill, total, playerId, location } = req.body;
      if (!skill || total == null) return res.status(400).json({ error: 'skill and total required' });

      const aiEngine = this.orchestrator.getService('ai-engine');
      if (!aiEngine?.advisor) return res.json({ error: 'AI not available' });

      const result = await aiEngine.advisor.interpretRoll(skill, parseInt(total), playerId, location);
      res.json({ text: result || 'No interpretation generated' });
    });

    // POST /api/codm/rule — look up a D&D rule
    this.app.post('/api/codm/rule', async (req, res) => {
      const { query } = req.body;
      if (!query) return res.status(400).json({ error: 'query required' });

      const aiEngine = this.orchestrator.getService('ai-engine');
      if (!aiEngine?.advisor) return res.json({ error: 'AI not available' });

      const result = await aiEngine.advisor.lookupRule(query);
      res.json({ text: result || 'No rule found' });
    });

    this.app.post('/api/dread/:playerId', (req, res) => {
      const { playerId } = req.params;
      const { score } = req.body;
      const result = this.state.updateDread(playerId, score);
      res.json(result);
    });

    this.app.post('/api/atmosphere/:profile', (req, res) => {
      const profile = req.params.profile;
      this.bus.dispatch('atmo:change', { profile, reason: 'DM manual', auto: false });
      res.json({ profile });
    });

    // ── Character / DDB routes ─────────────────────────────────────────────
    // GET  /api/characters          — list synced characters + assignments
    this.app.get('/api/characters', (req, res) => {
      const svc = this.orchestrator.getService('characters');
      if (!svc) return res.json({ characters: [], assignments: {} });
      res.json(svc.getStatus());
    });

    // DELETE /api/characters/:charId — delete a character from the system
    this.app.delete('/api/characters/:charId', (req, res) => {
      const svc = this.orchestrator.getService('characters');
      if (!svc) return res.status(503).json({ error: 'Character service not running' });
      const deleted = svc.deleteCharacter(req.params.charId);
      if (!deleted) return res.status(404).json({ error: 'Character not found' });
      res.json({ deleted: req.params.charId });
    });

    // POST /api/characters/reload   — reload JSON files into game state (no restart)
    this.app.post('/api/characters/reload', (req, res) => {
      const svc = this.orchestrator.getService('characters');
      if (!svc) return res.status(503).json({ error: 'Character service not running' });
      const count = svc.reload();
      res.json({ reloaded: count });
    });

    // POST /api/characters/assign   — assign player → DDB character
    // body: { playerId, ddbId }
    this.app.post('/api/characters/assign', (req, res) => {
      const { playerId, ddbId } = req.body || {};
      if (!playerId || !ddbId) return res.status(400).json({ error: 'playerId and ddbId required' });
      const svc = this.orchestrator.getService('characters');
      if (!svc) return res.status(503).json({ error: 'Character service not running' });
      const assignments = svc.assign(playerId, ddbId);
      res.json({ assignments });
    });

    // DELETE /api/characters/assign/:playerId
    this.app.delete('/api/characters/assign/:playerId', (req, res) => {
      const svc = this.orchestrator.getService('characters');
      if (!svc) return res.status(503).json({ error: 'Character service not running' });
      const assignments = svc.unassign(req.params.playerId);
      res.json({ assignments });
    });

    // POST /api/players/add — add a player slot
    this.app.post('/api/players/add', (req, res) => {
      const { playerId } = req.body || {};
      if (!playerId) return res.status(400).json({ error: 'playerId required' });
      const svc = this.orchestrator.getService('characters');
      if (svc) svc.addPlayer(playerId);
      // Also init in state
      if (!this.state.get('players.' + playerId)) {
        this.state.set('players.' + playerId, { name: playerId, connected: false });
      }
      console.log('[Dashboard] Player slot added: ' + playerId);
      res.json({ playerId, url: '/player/' + playerId });
    });

    // DELETE /api/players/:playerId — remove a player slot
    this.app.delete('/api/players/:playerId', (req, res) => {
      const { playerId } = req.params;
      const svc = this.orchestrator.getService('characters');
      if (svc) svc.removePlayer(playerId);
      // Remove from state
      const players = this.state.get('players') || {};
      delete players[playerId];
      this.state.set('players', players);
      console.log('[Dashboard] Player slot removed: ' + playerId);
      res.json({ removed: playerId });
    });

    // ── DDB Sync routes ─────────────────────────────────────────────────

    // GET /api/ddb/config — get DDB sync configuration
    this.app.get('/api/ddb/config', (req, res) => {
      const svc = this.orchestrator.getService('characters');
      if (!svc) return res.status(503).json({ error: 'Character service not running' });
      const conf = svc._readDdbConfig();
      res.json({ ...conf, hasCookie: !!process.env.COBALT_COOKIE, lastSync: svc._lastSync });
    });

    // POST /api/ddb/config — save DDB sync configuration
    // body: { characterIds: ['12345', '67890'] }
    this.app.post('/api/ddb/config', (req, res) => {
      const svc = this.orchestrator.getService('characters');
      if (!svc) return res.status(503).json({ error: 'Character service not running' });
      const { characterIds } = req.body || {};
      if (!Array.isArray(characterIds)) return res.status(400).json({ error: 'characterIds array required' });
      svc.saveDdbConfig({ characterIds: characterIds.map(String).filter(Boolean) });
      res.json({ saved: true, characterIds });
    });

    // POST /api/ddb/sync — sync ALL configured characters from DDB
    this.app.post('/api/ddb/sync', async (req, res) => {
      const svc = this.orchestrator.getService('characters');
      if (!svc) return res.status(503).json({ error: 'Character service not running' });
      try {
        const result = await svc.ddbSyncAll();
        res.json(result);
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    // POST /api/ddb/sync/:ddbId — sync ONE character from DDB
    this.app.post('/api/ddb/sync/:ddbId', async (req, res) => {
      const svc = this.orchestrator.getService('characters');
      if (!svc) return res.status(503).json({ error: 'Character service not running' });
      try {
        const char = await svc.ddbSyncOne(req.params.ddbId);
        svc.reload();
        res.json({ synced: char.name, character: { name: char.name, class: char.class, level: char.level, race: char.race } });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    // POST /api/ddb/push — push HP/slots back to DDB for ALL players
    this.app.post('/api/ddb/push', async (req, res) => {
      const svc = this.orchestrator.getService('characters');
      if (!svc) return res.status(503).json({ error: 'Character service not running' });
      try {
        const results = await svc.ddbPushAll();
        res.json({ pushed: true, results });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    // POST /api/ddb/push/:playerId — push HP/slots back to DDB for one player
    this.app.post('/api/ddb/push/:playerId', async (req, res) => {
      const svc = this.orchestrator.getService('characters');
      if (!svc) return res.status(503).json({ error: 'Character service not running' });
      try {
        const result = await svc.ddbPushPlayer(req.params.playerId);
        res.json({ pushed: true, result });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    // POST /api/characters/import  — receive character data pushed from Foundry module
    // body: { characters: [ { foundryId, name, ... } ] }
    this.app.post('/api/characters/import', (req, res) => {
      const { characters } = req.body || {};
      if (!Array.isArray(characters) || !characters.length) {
        return res.status(400).json({ error: 'characters array required' });
      }
      const svc = this.orchestrator.getService('characters');
      if (!svc) return res.status(503).json({ error: 'Character service not running' });

      let saved = 0;
      for (const char of characters) {
        if (!char.foundryId && !char.name) continue;
        const id = char.foundryId || char.name.replace(/\s+/g, '-').toLowerCase();
        svc.saveCharacter(id, char);
        saved++;
      }

      // Reload all into game state
      svc.reload();
      this.bus.dispatch('characters:imported', { count: saved });
      console.log(`[Dashboard] Foundry pushed ${saved} character(s)`);
      res.json({ saved });
    });

    // ── Player HP route (so player page works from port 3200) ──────────────
    this.app.post('/api/hp/:playerId', (req, res) => {
      const playerBridge = this.orchestrator.getService('player-bridge');
      if (!playerBridge) return res.status(503).json({ error: 'Player bridge unavailable' });
      // Forward to player bridge's app
      playerBridge.app.handle(req, res);
    });

    // ── Combat attack routes (proxied to combat service) ───────────────────
    // These are defined here rather than in combat-service to ensure they're
    // registered before the server starts listening.

    // POST /api/combat/attack — process an attack (check AC, apply damage)
    this.app.post('/api/combat/attack', (req, res) => {
      const combatSvc = this.orchestrator.getService('combat');
      if (!combatSvc) return res.status(503).json({ error: 'Combat service unavailable' });
      const { attackerId, targetId, attackRoll, damage, damageType, crit } = req.body || {};
      if (!attackerId || !targetId || typeof attackRoll !== 'number' || typeof damage !== 'number') {
        return res.status(400).json({ error: 'attackerId, targetId, attackRoll, and damage required' });
      }
      const result = combatSvc.processAttack(attackerId, targetId, attackRoll, damage, damageType, crit);
      if (!result) return res.status(404).json({ error: 'Attacker or target not found in combat' });
      res.json(result);
    });

    // POST /api/combat/npc-roll — DM rolls an NPC action (server-side dice)
    this.app.post('/api/combat/npc-roll', (req, res) => {
      const combatSvc = this.orchestrator.getService('combat');
      if (!combatSvc) return res.status(503).json({ error: 'Combat service unavailable' });
      const { combatantId, actionIndex } = req.body || {};
      if (!combatantId || typeof actionIndex !== 'number') {
        return res.status(400).json({ error: 'combatantId and actionIndex required' });
      }
      const result = combatSvc.rollNpcAction(combatantId, actionIndex);
      if (!result) return res.status(404).json({ error: 'Combatant or action not found' });
      if (result.error) return res.status(400).json(result);
      res.json(result);
    });

    // GET /api/combat/actions/:combatantId — get available actions for a combatant
    this.app.get('/api/combat/actions/:combatantId', (req, res) => {
      const combatSvc = this.orchestrator.getService('combat');
      if (!combatSvc) return res.status(503).json({ error: 'Combat service unavailable' });
      const actions = combatSvc.getActions(req.params.combatantId);
      res.json(actions);
    });
  }

  _onConnection(ws) {
    this.clients.add(ws);
    console.log(`[Dashboard] Client connected (${this.clients.size} total)`);

    ws.send(JSON.stringify({
      type: 'init',
      state: this.state.snapshot(),
      services: this.orchestrator.getHealthReport()
    }));

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        this._handleClientMessage(msg, ws);
      } catch (err) {
        console.error('[Dashboard] Bad message:', err.message);
      }
    });

    ws.on('close', () => {
      this.clients.delete(ws);
      console.log(`[Dashboard] Client disconnected (${this.clients.size} total)`);
    });
  }

  _handleClientMessage(msg, ws) {
    switch (msg.type) {
      case 'session:start':
        this.state.startSession();
        break;
      case 'session:pause':
        this.state.pauseSession();
        break;
      case 'session:resume':
        this.state.resumeSession();
        break;
      case 'session:end':
        this.state.endSession();
        break;
      case 'panic':
        this.bus.dispatch('panic', {});
        break;
      case 'config:trust_level':
        this.state.set('session.aiTrustLevel', msg.level);
        this.bus.dispatch('config:trust_level', { level: msg.level });
        break;
      case 'npc:approve':
      case 'npc:reject':
      case 'npc:edit':
        this.bus.dispatch(msg.type, msg);
        break;
      case 'npc:manual':
        this.bus.dispatch('npc:manual', { npc: msg.npc, text: msg.text });
        break;
      case 'atmo:change':
      case 'atmo:light':
      case 'atmo:sound':
        this.bus.dispatch(msg.type, msg);
        break;
      case 'player:horror':
        this.bus.dispatch('player:horror_effect', {
          playerId: msg.playerId || 'all',
          type: msg.horrorType || msg.payload?.type || 'whisper',
          payload: msg.payload || {},
          durationMs: msg.durationMs || 5000
        });
        break;
      case 'story:mark_beat':
        this.bus.dispatch('story:mark_beat', { beatId: msg.beatId, status: msg.status });
        break;
      case 'story:add_clue':
        this.bus.dispatch('story:add_clue', { clue: msg.clue });
        break;
      case 'dm:private_message':
        this.bus.dispatch('dm:private_message', {
          playerId: msg.playerId,
          text: msg.text,
          durationMs: msg.durationMs || 8000
        });
        break;
      case 'dm:broadcast_chat':
        this.bus.dispatch('dm:private_message', {
          playerId: 'all',
          text: msg.text,
          durationMs: 8000
        });
        break;
      case 'npc:execute_action':
        this.bus.dispatch('npc:execute_action', msg);
        break;
      case 'spurt:speak':
        this.bus.dispatch('spurt:speak', { prompt: msg.prompt || '', type: msg.spurtType || 'dialogue' });
        break;
      case 'spurt:wild_surge':
        this.bus.dispatch('spurt:wild_surge', {});
        break;
      case 'spurt:approve_action':
        this.bus.dispatch('spurt:approve_action', msg);
        break;
      default:
        console.log(`[Dashboard] Unknown message type: ${msg.type}`);
    }
  }

  _broadcast(data) {
    const json = JSON.stringify(data);
    for (const ws of this.clients) {
      if (ws.readyState === 1) ws.send(json);
    }
  }

  async stop() {
    if (this.wss) this.wss.close();
    if (this.server) this.server.close();
  }

  getStatus() {
    return {
      status: this.server?.listening ? 'running' : 'stopped',
      connectedClients: this.clients.size,
      port: this.config.server.port
    };
  }
}

module.exports = DashboardService;
