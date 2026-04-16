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

    // Section 5 — Dry run player mode
    // /player/dryrun serves the player bridge UI; client-side dryrun=1 query
    // engages dry run badge and test buttons. Character selected at runtime.
    this.app.get('/player/dryrun', (req, res) => {
      res.sendFile(path.join(__dirname, '..', 'player-bridge', 'public', 'index.html'));
    });

    // Panel pop-out routes — serve individual panel pages
    this.app.get('/panel/:panelId', (req, res) => {
      // All panels use the same wrapper — panelId is read client-side from URL
      res.sendFile(path.join(__dirname, 'public', 'panel-window.html'));
    });

    // Tablet map route — touch-optimized full-screen map
    this.app.get('/tablet', (req, res) => {
      res.sendFile(path.join(__dirname, 'public', 'tablet.html'));
    });

    // /table — projection display for the player-facing screen
    this.app.get('/table', (req, res) => {
      res.sendFile(path.join(__dirname, 'public', 'table.html'));
    });

    // /classic-source — raw index.html for dm.html / dm-ref.html to fetch
    this.app.get('/classic-source', (req, res) => {
      res.set('Cache-Control', 'no-store');
      res.sendFile(path.join(__dirname, 'public', 'index.html'));
    });

    // /dm — three-display DM interface center (laptop)
    // Each route serves its OWN physical HTML file. Map element is removed
    // from the DOM in dm.html and dm-ref.html — not just CSS-hidden.
    this.app.get('/dm', (req, res) => {
      res.sendFile(path.join(__dirname, 'public', 'dm.html'));
    });
    this.app.get('/dm/map', (req, res) => {
      res.sendFile(path.join(__dirname, 'public', 'dm-map.html'));
    });
    this.app.get('/dm/ref', (req, res) => {
      res.sendFile(path.join(__dirname, 'public', 'dm-ref.html'));
    });
    // /dm/brief — DM session reference page (built in S7)
    this.app.get('/dm/brief', (req, res) => {
      const briefPath = path.join(__dirname, '..', '..', 'sessions', 'current-brief.html');
      const fs = require('fs');
      if (fs.existsSync(briefPath)) {
        res.sendFile(briefPath);
      } else {
        res.send('<html><body style="background:#141210;color:#c8b89a;font-family:serif;padding:40px;"><h1>Session brief not yet generated</h1><p>Click Start Session to generate.</p></body></html>');
      }
    });

    // Dashboard launcher (new main page)
    this.app.get('/launcher', (req, res) => {
      res.sendFile(path.join(__dirname, 'public', 'launcher.html'));
    });

    // /dm/classic — original dashboard accessible from the new three-display nav.
    // Same file as /classic; both routes serve it unchanged so the DM has a fallback
    // for any control not yet surfaced in the new layout.
    this.app.get('/dm/classic', (req, res) => {
      res.sendFile(path.join(__dirname, 'public', 'index.html'));
    });

    // Legacy dashboard preserved at /classic
    this.app.get('/classic', (req, res) => {
      res.sendFile(path.join(__dirname, 'public', 'index.html'));
    });

    this.app.use('/assets', express.static(path.join(__dirname, '..', '..', 'assets')));
    this.app.use('/sounds', express.static(path.join(__dirname, '..', '..', 'assets', 'sounds')));

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
    // Layout persistence API
    this.app.get('/api/layout', (req, res) => {
      const layout = this.state.get('dashboard.layout') || { panels: {} };
      res.json(layout);
    });

    this.app.post('/api/layout/save', (req, res) => {
      const layout = req.body;
      if (!layout || typeof layout !== 'object') return res.status(400).json({ error: 'layout object required' });
      this.state.set('dashboard.layout', layout);
      res.json({ ok: true });
    });

    // FIX-B9 — minimal /health endpoint for watchdog. Returns 200 OK as long
    // as the express server is responding. Used by ~/dark-pilgrimage/watchdog.sh
    this.app.get('/health', (req, res) => {
      res.status(200).type('text/plain').send('ok');
    });

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

    // Returns raw session config (session-0.json + future expansion configs).
    // dm-ref.html uses this to pick up patron NPCs which live at config root,
    // not under config.npcs (and therefore aren't loaded into state.npcs).
    this.app.get('/api/session-config', (req, res) => {
      res.json(this.config || {});
    });

    // ── MemPalace integration 4 — search the palace from the UI ──
    // GET /api/mempalace/search?q={query}&room={room}&results={n}
    // Failure-silent: if the CLI is missing, returns { ok:false, recall:null }.
    this.app.get('/api/mempalace/search', async (req, res) => {
      const q = req.query?.q;
      if (!q || typeof q !== 'string') {
        return res.status(400).json({ ok: false, error: 'q required' });
      }
      try {
        const mempalace = require('../ai/mempalace-client');
        const recall = await mempalace.search(q, {
          room: req.query.room,
          results: Math.max(1, Math.min(10, parseInt(req.query.results, 10) || 3))
        });
        res.json({ ok: true, query: q, recall });
      } catch (e) {
        res.json({ ok: false, query: q, recall: null, error: e.message });
      }
    });

    // ─── Latency telemetry (CR-3) ───────────────────────────────
    // Tracks Max audio pipeline latency. Populated by voice-service via
    // the max:latency event the dashboard subscribes to via wildcard.
    this._latencySamples = [];
    this.bus.subscribe('max:latency', (env) => {
      const d = env.data || {};
      this._latencySamples.push({ ms: d.latencyMs, at: Date.now(), text: d.text });
      if (this._latencySamples.length > 100) this._latencySamples.shift();
    }, 'dashboard');

    this.app.get('/api/latency/max', (req, res) => {
      const samples = this._latencySamples;
      if (!samples.length) return res.json({ samples: 0 });
      const sorted = samples.map(s => s.ms).sort((a, b) => a - b);
      const avg = Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length);
      const median = sorted[Math.floor(sorted.length / 2)];
      const p95 = sorted[Math.floor(sorted.length * 0.95)] || sorted[sorted.length - 1];
      res.json({ samples: sorted.length, avgMs: avg, medianMs: median, p95Ms: p95, recent: samples.slice(-5) });
    });

    // ─── Heal endpoints (FIX-H1 / FIX-J1) ───────────────────────
    // The /dm/ref Tools tab and player cards call these on port 3200.
    // The actual implementation lives in player-bridge — we delegate
    // by calling the service method directly. No HTTP hop.
    const _healHelper = () => this.orchestrator.getService('player-bridge');

    this.app.post('/api/players/:playerId/heal', (req, res) => {
      try {
        const svc = _healHelper();
        if (!svc || typeof svc._healPlayer !== 'function') return res.status(503).json({ error: 'player-bridge unavailable' });
        const amount = parseInt((req.body || {}).amount, 10);
        if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'amount required' });
        const result = svc._healPlayer(req.params.playerId, amount, false);
        if (!result) return res.status(404).json({ error: 'player not found' });
        res.json(result);
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    this.app.post('/api/players/:playerId/full-rest', (req, res) => {
      try {
        const svc = _healHelper();
        if (!svc || typeof svc._healPlayer !== 'function') return res.status(503).json({ error: 'player-bridge unavailable' });
        const result = svc._healPlayer(req.params.playerId, 0, true);
        if (!result) return res.status(404).json({ error: 'player not found' });
        res.json(result);
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    this.app.post('/api/players/:playerId/clear-wounds', (req, res) => {
      try {
        const wounds = { head: 0, torso: 0, leftArm: 0, rightArm: 0, leftLeg: 0, rightLeg: 0 };
        this.state.set('players.' + req.params.playerId + '.wounds', wounds);
        this.bus.dispatch('wounds:updated', { playerId: req.params.playerId, wounds, reason: 'dm-clear' });
        const charName = this.state.get('players.' + req.params.playerId + '.character.name') || req.params.playerId;
        this.bus.dispatch('dm:whisper', {
          text: charName + ' wound state cleared by DM.',
          priority: 3, category: 'heal', source: 'dm-clear-wounds'
        });
        res.json({ ok: true, playerId: req.params.playerId, wounds });
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    this.app.post('/api/players/heal-all', (req, res) => {
      try {
        const svc = _healHelper();
        if (!svc || typeof svc._healPlayer !== 'function') return res.status(503).json({ error: 'player-bridge unavailable' });
        const players = this.state.get('players') || {};
        const results = [];
        for (const [pid, p] of Object.entries(players)) {
          if (!p || p.absent || p.notYetArrived) continue;
          const r = svc._healPlayer(pid, 0, true);
          if (r) results.push(r);
        }
        res.json({ ok: true, healed: results.length, results });
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    this.app.post('/api/players/heal-selected', (req, res) => {
      try {
        const svc = _healHelper();
        if (!svc || typeof svc._healPlayer !== 'function') return res.status(503).json({ error: 'player-bridge unavailable' });
        const { playerIds } = req.body || {};
        if (!Array.isArray(playerIds)) return res.status(400).json({ error: 'playerIds array required' });
        const results = [];
        for (const pid of playerIds) {
          const r = svc._healPlayer(pid, 0, true);
          if (r) results.push(r);
        }
        res.json({ ok: true, healed: results.length, results });
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // ─── Service restart API (CR-5) ─────────────────────────────
    this.app.get('/api/services', (req, res) => {
      try {
        const list = this.orchestrator.listServices ? this.orchestrator.listServices() : [];
        res.json({ services: list });
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    this.app.post('/api/services/:name/restart', async (req, res) => {
      try {
        const name = req.params.name;
        if (!this.orchestrator.restartService) {
          return res.status(503).json({ error: 'orchestrator does not support restart' });
        }
        const result = await this.orchestrator.restartService(name);
        res.json(result);
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // ─── Max pause / volume API (FIX-C2) ────────────────────────
    this.app.post('/api/max/pause', (req, res) => {
      try {
        const { durationSec } = req.body || {};
        const ms = (durationSec || 300) * 1000;
        const voiceSvc = this.orchestrator.getService('voice');
        if (voiceSvc && typeof voiceSvc.pauseMax === 'function') voiceSvc.pauseMax(ms);
        const aiEngine = this.orchestrator.getService('ai-engine');
        const md = aiEngine && aiEngine.maxDirector;
        if (md && typeof md.setPaused === 'function') md.setPaused(true, ms);
        res.json({ ok: true, durationMs: ms, until: Date.now() + ms });
      } catch (e) { res.status(500).json({ error: e.message }); }
    });
    this.app.post('/api/max/acknowledge', (req, res) => {
      try {
        const aiEngine = this.orchestrator.getService('ai-engine');
        const md = aiEngine && aiEngine.maxDirector;
        if (md && typeof md.acknowledge === 'function') md.acknowledge();
        res.json({ ok: true });
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    this.app.post('/api/max/resume', (req, res) => {
      try {
        const voiceSvc = this.orchestrator.getService('voice');
        if (voiceSvc && typeof voiceSvc.resumeMax === 'function') voiceSvc.resumeMax();
        const aiEngine = this.orchestrator.getService('ai-engine');
        const md = aiEngine && aiEngine.maxDirector;
        if (md && typeof md.setPaused === 'function') md.setPaused(false);
        res.json({ ok: true });
      } catch (e) { res.status(500).json({ error: e.message }); }
    });
    this.app.get('/api/max/status', (req, res) => {
      try {
        const voiceSvc = this.orchestrator.getService('voice');
        const aiEngine = this.orchestrator.getService('ai-engine');
        const md = aiEngine && aiEngine.maxDirector;
        res.json({
          paused: voiceSvc && voiceSvc.isMaxPaused ? voiceSvc.isMaxPaused() : false,
          pausedUntil: voiceSvc ? voiceSvc._maxPausedUntil || 0 : 0,
          volume: voiceSvc ? (voiceSvc._maxVolume != null ? voiceSvc._maxVolume : 0.7) : 0.7,
          throttleMs: md ? md.activeThrottleMs : null,
          queueLength: md ? (md.queue || []).length : 0
        });
      } catch (e) { res.status(500).json({ error: e.message }); }
    });
    this.app.post('/api/max/volume', (req, res) => {
      try {
        const { volume } = req.body || {};
        const v = Math.max(0, Math.min(1, parseFloat(volume)));
        const voiceSvc = this.orchestrator.getService('voice');
        if (voiceSvc) {
          voiceSvc._maxVolume = v;
          if (this.bus) this.bus.dispatch('max:volume', { volume: v });
        }
        res.json({ ok: true, volume: v });
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // Diagnostic — exercise the browser-side Max audio path using a
    // pre-existing MP3 from the cache. Bypasses the max-director queue,
    // throttle, and ElevenLabs. Returns the URL dispatched so the DM can
    // verify it in the whisper log + browser console.
    this.app.post('/api/max/test-audio', (req, res) => {
      try {
        const fs = require('fs');
        const path = require('path');
        const maxDir = path.join(__dirname, '..', '..', 'assets', 'sounds', 'max');
        let filename = null;
        if (fs.existsSync(maxDir)) {
          const files = fs.readdirSync(maxDir).filter(f => f.endsWith('.mp3'));
          if (files.length) filename = files.sort().reverse()[0]; // latest by name/time
        }
        if (!filename) {
          return res.status(404).json({ ok: false, error: 'no max MP3s available — send one real Max line first' });
        }
        const url = '/assets/sounds/max/' + filename;
        if (this.bus) {
          this.bus.dispatch('max:audio', {
            url,
            text: 'TEST — browser audio pipeline diagnostic',
            priority: 'high',
            source: 'max-test',
            latencyMs: 0
          });
        }
        res.json({ ok: true, url, filename });
      } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
    });

    // ─── ElevenLabs / Voice palette health API ─────────────────
    this.app.get('/api/voice/health', (req, res) => {
      try {
        const voiceSvc = this.orchestrator.getService('voice');
        if (!voiceSvc) return res.status(503).json({ error: 'voice service unavailable' });
        res.json({
          elevenLabs: voiceSvc.elevenLabsHealth || { status: 'UNKNOWN' },
          palette: voiceSvc.voicePaletteStatus ? voiceSvc.voicePaletteStatus() : {}
        });
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    this.app.post('/api/voice/health/refresh', async (req, res) => {
      try {
        const voiceSvc = this.orchestrator.getService('voice');
        if (!voiceSvc || typeof voiceSvc.checkElevenLabsHealth !== 'function') {
          return res.status(503).json({ error: 'voice service unavailable' });
        }
        const h = await voiceSvc.checkElevenLabsHealth(true);
        res.json({ ok: true, elevenLabs: h, palette: voiceSvc.voicePaletteStatus() });
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // ─── Language management API (Tools tab) ───────────────────
    this.app.get('/api/languages', (req, res) => {
      try {
        const fs = require('fs');
        const path = require('path');
        const p = path.join(__dirname, '..', '..', 'config', 'languages.json');
        if (!fs.existsSync(p)) return res.json({ languages: [] });
        const data = JSON.parse(fs.readFileSync(p, 'utf8'));
        res.json(data);
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    this.app.get('/api/languages/npcs', (req, res) => {
      try {
        const result = [];
        const seen = {};
        const collect = (id, n) => {
          if (!n || seen[id]) return;
          seen[id] = true;
          if (!n.languages && !n.primaryLanguage) return;
          result.push({
            id,
            name: n.name || id,
            languages: n.languages || [],
            primaryLanguage: n.primaryLanguage || null,
            commonFluency: n.commonFluency || null,
            languageNote: n.languageNote || null,
            specialLanguageRules: n.specialLanguageRules || null
          });
        };
        const npcs = (this.state && this.state.get('npcs')) || {};
        for (const [id, n] of Object.entries(npcs)) collect(id, n);
        const cfg = this.config || {};
        for (const k of Object.keys(cfg)) {
          if (k === 'npcs') {
            const cn = cfg.npcs || {};
            for (const [id, n] of Object.entries(cn)) collect(id, n);
          } else if (k.startsWith('patron-') || ['marta', 'tomas', 'vladislav', 'piotr', 'aldous', 'katya'].includes(k)) {
            collect(k, cfg[k]);
          }
        }
        res.json({ npcs: result });
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    this.app.get('/api/languages/players', (req, res) => {
      try {
        const players = (this.state && this.state.get('players')) || {};
        const result = [];
        for (const [pid, p] of Object.entries(players)) {
          const ch = p && p.character;
          if (!ch) continue;
          const langs = ch.languageStructured || (ch.languages || []).map(l => typeof l === 'string' ? { id: l.toLowerCase(), displayName: l, fluency: 'fluent' } : l);
          result.push({
            id: pid,
            characterName: ch.name || pid,
            languages: langs,
            languageNote: ch.languageNote || null
          });
        }
        res.json({ players: result });
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    this.app.post('/api/languages/preview', (req, res) => {
      try {
        const { npcId, playerId, languageId } = req.body || {};
        if (!npcId || !playerId) return res.status(400).json({ error: 'npcId and playerId required' });
        const aiEngine = this.orchestrator && this.orchestrator.getService && this.orchestrator.getService('ai-engine');
        const commRouter = aiEngine && aiEngine.commRouter;
        if (!commRouter || typeof commRouter.resolveLanguage !== 'function') {
          return res.status(503).json({ error: 'comm-router not available' });
        }
        const result = commRouter.resolveLanguage(npcId, playerId, { languageId: languageId || null });
        res.json({ npcId, playerId, languageId: languageId || '(npc primary)', result });
      } catch (e) { res.status(500).json({ error: e.message }); }
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

    // Session save/reset/resume
    this.app.post('/api/session/reset', (req, res) => {
      this.state.resetSession(this.config);
      // FIX-J1 — wounds + HP + stamina full reset on session reset.
      // Characters are reloaded after resetSession; give them a tick
      // and then call campaign-service to restore everyone to full.
      setTimeout(() => {
        try {
          const camp = this.orchestrator.getService('campaign');
          if (camp && typeof camp._restoreAllPlayersToFull === 'function') {
            camp._restoreAllPlayersToFull('session-reset');
          }
        } catch (e) { console.warn('[Dashboard] reset full-restore error:', e.message); }
      }, 100);
      res.json({ status: 'reset' });
    });

    this.app.post('/api/session/resume-save', (req, res) => {
      const { savePath } = req.body || {};
      const logDir = this.config?.session?.logDir || './sessions';
      const path = require('path');
      const target = savePath
        ? path.join(logDir, 'saves', savePath)
        : path.join(logDir, 'saves', 'latest-save.json');
      const result = this.state.resumeFromSave(target);
      if (result) {
        res.json({ status: 'resumed', savedAt: result.savedAt });
      } else {
        res.json({ error: 'No save file found or resume failed' });
      }
    });

    this.app.get('/api/session/saves', (req, res) => {
      res.json({ saves: this.state.listSaves() });
    });

    this.app.post('/api/panic', (req, res) => {
      this.bus.dispatch('panic', {});
      res.json({ status: 'panic triggered' });
    });

    // POST /api/session/arrive — trigger arrival sequence for a player
    this.app.post('/api/session/arrive', (req, res) => {
      const { playerId } = req.body || {};
      if (!playerId) return res.status(400).json({ error: 'playerId required' });

      const arrived = this.state.get('session.arrived') || [];
      if (arrived.includes(playerId)) {
        return res.status(400).json({ error: 'Player already arrived' });
      }

      const charData = this.state.get(`players.${playerId}.character`) || {};
      const charName = charData.name || playerId;

      // Count already-arrived players + patrons
      const patronCount = 4; // Marta + Vladislav + Tomas + patrons visible in common room
      const arrivedCount = arrived.length;
      const othersInside = arrivedCount + patronCount;

      // 1. Send private message to arriving player
      this.bus.dispatch('dm:private_message', {
        playerId,
        text: `You push through the door into warmth and firelight. A cramped common room — low ceiling, dark wood. A dying fire. A woman behind the bar who stares at you. A hooded figure in the far corner who doesn't look up. ${othersInside} other ${othersInside === 1 ? 'traveler is' : 'travelers are'} already here.`,
        durationMs: 15000
      });

      // 2. Notify already-arrived players about the newcomer
      const brief = charData.race ? `a ${charData.race} ${charData.class || 'traveler'}` : 'a weary traveler';
      for (const arrivedId of arrived) {
        this.bus.dispatch('dm:private_message', {
          playerId: arrivedId,
          text: `The door crashes open. Wind and snow blast in. A figure stumbles through — ${charName}, ${brief}. They force the door shut and stand there, shaking off the cold.`,
          durationMs: 10000
        });
      }

      // 3. Whisper to DM earbud
      const newTotal = arrivedCount + 1;
      const totalPlayers = Object.keys(this.state.get('players') || {}).length;
      this.bus.dispatch('dm:whisper', {
        text: `${charName} has arrived. ${newTotal} of ${totalPlayers} players now in the tavern.`,
        priority: 3,
        category: 'story'
      });

      // 4. Broadcast chat message
      this.bus.dispatch('chat:party', {
        from: 'system',
        fromName: 'Narrator',
        text: `${charName} pushes through the tavern door, bringing a gust of cold wind.`
      });

      // 5. Track arrival state
      arrived.push(playerId);
      this.state.set('session.arrived', arrived);

      console.log(`[Dashboard] Player arrived: ${charName} (${newTotal}/${totalPlayers})`);
      res.json({ ok: true, charName, arrived: arrived.length, total: totalPlayers });
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

    // Section 6 — Narrator whisper to specific player
    // body: { playerId, text }
    this.app.post('/api/narrator/whisper', (req, res) => {
      const { playerId, text } = req.body || {};
      if (!playerId || !text) return res.status(400).json({ error: 'playerId and text required' });
      this.bus.dispatch('narrator:whisper_player', { playerId, text });
      res.json({ ok: true });
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
      res.json({ ...conf, hasCookie: !!(process.env.COBALT_COOKIE || process.env.DDB_COBALT_TOKEN), lastSync: svc._lastSync });
    });

    // GET /api/ddb/status — current cookie/auth status
    this.app.get('/api/ddb/status', (req, res) => {
      const svc = this.orchestrator.getService('characters');
      if (!svc) return res.status(503).json({ error: 'Character service not running' });
      res.json({
        status: svc.getDdbStatus(),
        hasCookie: !!(process.env.COBALT_COOKIE || process.env.DDB_COBALT_TOKEN),
        statusUpdatedAt: this.state.get('ddb.statusUpdatedAt') || null
      });
    });

    // POST /api/ddb/cookie — save cobalt session cookie
    // body: { cookie }
    this.app.post('/api/ddb/cookie', (req, res) => {
      const svc = this.orchestrator.getService('characters');
      if (!svc) return res.status(503).json({ error: 'Character service not running' });
      const { cookie } = req.body || {};
      if (!cookie) return res.status(400).json({ error: 'cookie required' });
      try {
        svc.saveCobaltCookie(cookie);
        res.json({ ok: true, status: svc.getDdbStatus() });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    // POST /api/ddb/check-health — manually trigger cookie health check
    this.app.post('/api/ddb/check-health', async (req, res) => {
      const svc = this.orchestrator.getService('characters');
      if (!svc) return res.status(503).json({ error: 'Character service not running' });
      await svc._checkDdbCookieHealth();
      res.json({ status: svc.getDdbStatus() });
    });

    // Alias for /api/characters/sync used by dm-ref tools tab
    this.app.post('/api/characters/sync', async (req, res) => {
      const svc = this.orchestrator.getService('characters');
      if (!svc) return res.status(503).json({ error: 'Character service not running' });
      try {
        const result = await svc.ddbSyncAll();
        res.json(result);
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    // Alias for /api/characters/reload
    this.app.post('/api/characters/reload', (req, res) => {
      const svc = this.orchestrator.getService('characters');
      if (!svc) return res.status(503).json({ error: 'Character service not running' });
      const count = svc.reload();
      res.json({ ok: true, count });
    });

    // Alias for /api/characters/assign
    this.app.post('/api/characters/assign', (req, res) => {
      const svc = this.orchestrator.getService('characters');
      if (!svc) return res.status(503).json({ error: 'Character service not running' });
      const { playerId, characterId } = req.body || {};
      if (!playerId) return res.status(400).json({ error: 'playerId required' });
      try {
        const fs = require('fs');
        const path = require('path');
        const aPath = path.join(__dirname, '..', '..', 'config', 'character-assignments.json');
        let assignments = {};
        if (fs.existsSync(aPath)) {
          try { assignments = JSON.parse(fs.readFileSync(aPath, 'utf8')); } catch (e) {}
        }
        if (characterId) assignments[playerId] = String(characterId);
        else delete assignments[playerId];
        fs.writeFileSync(aPath, JSON.stringify(assignments, null, 2));
        svc.reload();
        res.json({ ok: true, assignments });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
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

    // ── Anonymous players toggle (proxied to player bridge) ────────────────
    this.app.post('/api/players/anonymous', (req, res) => {
      const playerBridge = this.orchestrator.getService('player-bridge');
      if (!playerBridge) return res.status(503).json({ error: 'Player bridge unavailable' });
      playerBridge.app.handle(req, res);
    });
    this.app.get('/api/players/anonymous', (req, res) => {
      const playerBridge = this.orchestrator.getService('player-bridge');
      if (!playerBridge) return res.status(503).json({ error: 'Player bridge unavailable' });
      playerBridge.app.handle(req, res);
    });

    // ── Combat attack routes (proxied to combat service) ───────────────────
    // These are defined here rather than in combat-service to ensure they're
    // registered before the server starts listening.

    // POST /api/combat/attack — process an attack (check AC, apply damage)
    this.app.post('/api/combat/attack', (req, res) => {
      const combatSvc = this.orchestrator.getService('combat');
      if (!combatSvc) return res.status(503).json({ error: 'Combat service unavailable' });
      const { attackerId, targetId, attackRoll, damage, damageType, crit, weaponName, magical, silvered } = req.body || {};
      if (!attackerId || !targetId || typeof attackRoll !== 'number' || typeof damage !== 'number') {
        return res.status(400).json({ error: 'attackerId, targetId, attackRoll, and damage required' });
      }
      const result = combatSvc.processAttack(attackerId, targetId, attackRoll, damage, damageType, crit, weaponName || null, !!magical, !!silvered);
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

    // ── Sound Library routes ──────────────────────────────────────────
    // GET /api/sounds — list all available sounds
    this.app.get('/api/sounds', (req, res) => {
      const svc = this.orchestrator.getService('sound');
      if (!svc) return res.json({ sounds: [] });
      res.json({ sounds: svc.listSounds() });
    });

    // POST /api/sounds/generate — generate a custom sound
    this.app.post('/api/sounds/generate', async (req, res) => {
      const svc = this.orchestrator.getService('sound');
      if (!svc) return res.status(503).json({ error: 'Sound service not running' });
      const { name, prompt, duration, loop } = req.body || {};
      if (!name || !prompt) return res.status(400).json({ error: 'name and prompt required' });
      const safeName = name.replace(/[^a-z0-9_-]/gi, '_').toLowerCase();
      const file = await svc.generate(safeName, prompt, duration, loop);
      if (!file) return res.status(500).json({ error: 'Generation failed' });
      res.json({ name: safeName, file });
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
      case 'voice:speak':
        this.bus.dispatch('voice:speak', { text: msg.text, profile: msg.profile, device: msg.device });
        break;
      case 'audio:sfx':
        this.bus.dispatch('audio:sfx', { effect: msg.effect, device: msg.device, surround: msg.surround });
        break;
      case 'codm:read_aloud':
        this.bus.dispatch('codm:read_aloud', { text: (msg.data && msg.data.text) || msg.text || '' });
        break;
      case 'audio:dm_chunk':
        this.bus.dispatch('audio:dm_chunk', msg.data || msg);
        break;
      case 'audio:dm_flush':
        this.bus.dispatch('audio:dm_chunk', { cmd: 'flush', playerId: 'dm' });
        break;
      case 'voice:list_devices':
        this.bus.dispatch('voice:list_devices', {});
        break;
      case 'quest:update':
        this.bus.dispatch('quest:update', { playerId: msg.playerId || 'all', quest: msg.quest, quests: msg.quests });
        break;
      case 'handout:send':
        this.bus.dispatch('handout:send', { playerId: msg.playerId || 'all', title: msg.title, text: msg.text, image: msg.image, preview: msg.preview });
        break;
      case 'inspiration:grant':
        this.bus.dispatch('inspiration:grant', { playerId: msg.playerId, reason: msg.reason });
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
