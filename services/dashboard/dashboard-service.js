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
    this.app.use(express.static(path.join(__dirname, 'public')));

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

    this.wss = new WebSocketServer({ server: this.server });
    this.wss.on('connection', (ws) => this._onConnection(ws));

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
