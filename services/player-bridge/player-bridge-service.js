const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');
const { WebSocketServer } = require('ws');
const path = require('path');

class PlayerBridgeService {
  constructor() {
    this.name = 'player-bridge';
    this.orchestrator = null;
    this.app = null;
    this.server = null;
    this.wss = null;
    this.players = new Map();
  }

  async init(orchestrator) {
    this.orchestrator = orchestrator;
    this.bus = orchestrator.bus;
    this.state = orchestrator.state;
    this.config = orchestrator.config;
  }

  async start() {
    const port = this.config.playerBridge?.port || 3202;

    this.app = express();
    this.app.use(express.json());
    this.app.use(express.static(path.join(__dirname, 'public')));
    this.app.use('/assets', express.static(path.join(__dirname, '..', '..', 'assets')));

    this.app.get('/player/:playerId', (req, res) => {
      res.sendFile(path.join(__dirname, 'public', 'index.html'));
    });

    // REST endpoint for HP changes (more reliable than WS send)
    this.app.post('/api/hp/:playerId', (req, res) => {
      const { playerId } = req.params;
      const { delta } = req.body || {};
      if (typeof delta !== 'number') return res.status(400).json({ error: 'delta required' });

      let charHp = this.state.get(`players.${playerId}.character.hp`);
      if (!charHp || typeof charHp.max !== 'number') {
        const charData = this._lookupCharacter(playerId);
        if (charData?.hp) {
          this.state.set(`players.${playerId}.character`, charData);
          charHp = charData.hp;
        } else {
          charHp = { current: 0, max: 20 };
        }
      }
      const cur = typeof charHp.current === 'number' ? charHp.current : 0;
      const max = typeof charHp.max === 'number' ? charHp.max : 20;
      const newHp = Math.max(0, Math.min(max, cur + delta));
      this.state.set(`players.${playerId}.character.hp.current`, newHp);
      this.bus.dispatch('hp:update', { playerId, current: newHp, max });
      console.log(`[PlayerBridge] ${playerId} HP: ${cur} -> ${newHp} (delta ${delta})`);
      res.json({ current: newHp, max });
    });

    this.app.get('/api/players', (req, res) => {
      const roster = {};
      for (const [id, p] of this.players) {
        roster[id] = {
          connected: p.ws.readyState === 1,
          connectedAt: p.connectedAt,
          audioStreaming: p.audioStreaming || false
        };
      }
      res.json(roster);
    });

    // Try HTTPS, fall back to HTTP
    try {
      const sslKey = fs.readFileSync(path.join(__dirname, '..', '..', 'key.pem'));
      const sslCert = fs.readFileSync(path.join(__dirname, '..', '..', 'cert.pem'));
      this.server = https.createServer({ key: sslKey, cert: sslCert }, this.app);
      console.log('[PlayerBridge] Using HTTPS');
    } catch(e) {
      this.server = http.createServer(this.app);
      console.log('[PlayerBridge] Using HTTP (no certs found)');
    }

    this.wss = new WebSocketServer({ server: this.server });
    this.wss.on('connection', (ws, req) => this._onConnection(ws, req));

    this._setupEventListeners();

    return new Promise((resolve) => {
      this.server.listen(port, '0.0.0.0', () => {
        const proto = this.server instanceof https.Server ? 'https' : 'http';
        console.log(`[PlayerBridge] Player app: ${proto}://0.0.0.0:${port}/player/{name}`);
        resolve();
      });
    });
  }

  _lookupCharacter(playerId) {
    try {
      const charSvc = this.orchestrator.getService('characters');
      if (!charSvc) return null;
      const assignments = charSvc.getAssignments();
      const charId = assignments[playerId];
      if (!charId) return null;
      return charSvc.getCharacter(charId);
    } catch(e) {
      console.warn('[PlayerBridge] Could not load character for ' + playerId + ':', e.message);
      return null;
    }
  }

  _pushCharactersToPlayers() {
    for (const [playerId] of this.players) {
      const char = this._lookupCharacter(playerId);
      if (char) {
        this.state.set(`players.${playerId}.character`, char);
        this._sendToPlayer(playerId, { type: 'character:update', character: char });
        console.log('[PlayerBridge] Pushed character update to ' + playerId + ': ' + char.name);
      }
    }
  }

  _setupEventListeners() {
    this.bus.subscribe('player:horror_effect', (env) => {
      const { playerId, type, payload, durationMs } = env.data;
      if (playerId === 'all') {
        this._broadcast({ type: 'horror:effect', effect: type, payload, durationMs });
      } else {
        this._sendToPlayer(playerId, { type: 'horror:effect', effect: type, payload, durationMs });
      }
    }, 'player-bridge');

    this.bus.subscribe('state:change', (env) => {
      const { path: statePath, value } = env.data;

      if (statePath.startsWith('players.')) {
        const parts = statePath.split('.');
        const playerId = parts[1];
        const subPath = parts.slice(2).join('.');
        this._sendToPlayer(playerId, {
          type: 'state:update',
          path: subPath,
          value
        });
      }

      if (statePath.startsWith('scene.') || statePath.startsWith('combat.') || statePath.startsWith('map.')) {
        // Filter hidden tokens from player view
        if (statePath === 'map.tokens' && typeof value === 'object') {
          const filtered = {};
          for (const [id, tok] of Object.entries(value)) {
            if (!tok.hidden) filtered[id] = tok;
          }
          this._broadcast({ type: 'state:update', path: statePath, value: filtered });
          return;
        }
        this._broadcast({ type: 'state:update', path: statePath, value });
      }
    }, 'player-bridge');

    this.bus.subscribe('dread:update', (env) => {
      const { playerId, score, threshold } = env.data;
      this._sendToPlayer(playerId, {
        type: 'dread:update',
        score,
        threshold
      });
    }, 'player-bridge');

    this.bus.subscribe('player:panic', () => {
      this._broadcast({ type: 'horror:clear' });
    }, 'player-bridge');

    this.bus.subscribe('npc:approved', (env) => {
      this._broadcast({
        type: 'npc:dialogue',
        npc: env.data.npc,
        text: env.data.text
      });
    }, 'player-bridge');

    this.bus.subscribe('characters:imported', () => this._pushCharactersToPlayers(), 'player-bridge');
    this.bus.subscribe('characters:reloaded', () => this._pushCharactersToPlayers(), 'player-bridge');
  }

  _onConnection(ws, req) {
    const params = new URL(req.url, 'http://localhost').searchParams;
    const playerId = params.get('player');

    if (!playerId) {
      ws.send(JSON.stringify({ type: 'error', message: 'No player ID provided' }));
      ws.close();
      return;
    }

    const existing = this.players.get(playerId);
    if (existing && existing.ws.readyState === 1) {
      existing.ws.close();
    }

    this.players.set(playerId, {
      ws,
      connectedAt: Date.now(),
      audioStreaming: false
    });

    this.state.set(`players.${playerId}.connected`, true);
    this.state.set(`players.${playerId}.deviceId`, playerId);

    console.log(`[PlayerBridge] ${playerId} connected (${this.players.size} players online)`);
    this.bus.dispatch('player:connected', { playerId });

    const playerState = this.state.get(`players.${playerId}`);
    const sceneState = this.state.get('scene');
    const combatState = this.state.get('combat');

    const characterData = this._lookupCharacter(playerId);
    if (characterData) {
      // Preserve current HP from state if player is reconnecting
      const existingHp = this.state.get(`players.${playerId}.character.hp`);
      if (existingHp && typeof existingHp.current === 'number') {
        characterData.hp = { ...characterData.hp, current: existingHp.current };
      }
      this.state.set(`players.${playerId}.character`, characterData);
      console.log('[PlayerBridge] Sending character ' + characterData.name + ' to ' + playerId);
    }
    const initPlayer = Object.assign({}, playerState || {}, characterData ? { character: characterData } : {});

    // Build map state for player (filter hidden tokens)
    const mapState = this.state.get('map') || {};
    const playerMapState = { ...mapState };
    if (mapState.tokens) {
      const filtered = {};
      for (const [id, tok] of Object.entries(mapState.tokens)) {
        if (!tok.hidden) filtered[id] = tok;
      }
      playerMapState.tokens = filtered;
    }

    ws.send(JSON.stringify({
      type: 'init',
      playerId,
      player: initPlayer,
      scene: sceneState || {},
      combat: combatState || {},
      map: playerMapState
    }));

    ws.on('message', (raw) => {
      if (Buffer.isBuffer(raw) || raw instanceof ArrayBuffer) {
        this._handleAudioChunk(playerId, raw);
        return;
      }

      try {
        const msg = JSON.parse(raw.toString());
        this._handlePlayerMessage(playerId, msg);
      } catch (err) {
        console.error(`[PlayerBridge] Bad message from ${playerId}:`, err.message);
      }
    });

    ws.on('close', () => {
      this.state.set(`players.${playerId}.connected`, false);
      this.players.delete(playerId);
      console.log(`[PlayerBridge] ${playerId} disconnected (${this.players.size} players online)`);
      this.bus.dispatch('player:disconnected', { playerId });
    });
  }

  _handlePlayerMessage(playerId, msg) {
    console.log(`[PlayerBridge] Message from ${playerId}: ${msg.type}`);
    switch (msg.type) {
      case 'audio:start':
        const player = this.players.get(playerId);
        if (player) player.audioStreaming = true;
        this.bus.dispatch('audio:player_stream_start', {
          playerId,
          sampleRate: msg.sampleRate || 16000
        });
        break;

      case 'audio:stop':
        const p = this.players.get(playerId);
        if (p) p.audioStreaming = false;
        this.bus.dispatch('audio:player_stream_stop', { playerId });
        break;

      case 'roll:result':
        this.bus.dispatch('player:roll', {
          playerId,
          rollType: msg.rollType,
          formula: msg.formula,
          result: msg.result,
          total: msg.total
        });
        break;

      case 'chat:message':
        this.bus.dispatch('player:chat', {
          playerId,
          text: msg.text,
          whisperTo: msg.whisperTo || null
        });
        break;

      case 'action:hp': {
        // Read HP from state; fall back to character service if not yet in state
        let charHp = this.state.get(`players.${playerId}.character.hp`);
        if (!charHp || typeof charHp.max !== 'number') {
          const charData = this._lookupCharacter(playerId);
          if (charData?.hp) {
            this.state.set(`players.${playerId}.character`, charData);
            charHp = charData.hp;
          } else {
            charHp = {};
          }
        }
        const cur   = typeof charHp.current === 'number' ? charHp.current : 0;
        const max   = typeof charHp.max     === 'number' ? charHp.max     : 20;
        const newHp = Math.max(0, Math.min(max, cur + msg.delta));
        this.state.set(`players.${playerId}.character.hp.current`, newHp);
        this.bus.dispatch('hp:update', { playerId, current: newHp, max });
        console.log(`[PlayerBridge] ${playerId} HP: ${cur} -> ${newHp}`);
        break;
      }

      case 'map:move_token': {
        // Players can only move their own token
        if (msg.tokenId !== playerId) {
          console.log(`[PlayerBridge] ${playerId} tried to move ${msg.tokenId} — denied`);
          break;
        }
        const mapSvc = this.orchestrator.getService('map');
        if (mapSvc) mapSvc._moveToken(msg.tokenId, msg.x, msg.y);
        break;
      }

      case 'ping':
        this._sendToPlayer(playerId, { type: 'pong', ts: Date.now() });
        break;

      default:
        console.log(`[PlayerBridge] Unknown message from ${playerId}: ${msg.type}`);
    }
  }

  _handleAudioChunk(playerId, audioData) {
    this.bus.dispatch('audio:chunk', {
      playerId,
      audio: audioData,
      timestamp: Date.now()
    });
  }

  _sendToPlayer(playerId, data) {
    const player = this.players.get(playerId);
    if (player && player.ws.readyState === 1) {
      player.ws.send(JSON.stringify(data));
    }
  }

  _broadcast(data) {
    const json = JSON.stringify(data);
    for (const [id, player] of this.players) {
      if (player.ws.readyState === 1) {
        player.ws.send(json);
      }
    }
  }

  async stop() {
    if (this.wss) this.wss.close();
    if (this.server) this.server.close();
  }

  getStatus() {
    return {
      status: this.server?.listening ? 'running' : 'stopped',
      connectedPlayers: this.players.size,
      players: [...this.players.keys()],
      port: this.config.playerBridge?.port || 3202
    };
  }
}

module.exports = PlayerBridgeService;
