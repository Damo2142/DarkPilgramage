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
    this.app.use(express.static(path.join(__dirname, 'public'), { etag: false, lastModified: false, setHeaders: (res) => res.set('Cache-Control', 'no-store') }));
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

    // Proxy combat attack to combat service (so player JS can call same-origin)
    this.app.post('/api/combat/attack', (req, res) => {
      const combatSvc = this.orchestrator.getService('combat');
      if (!combatSvc) return res.status(503).json({ error: 'Combat service unavailable' });
      const { attackerId, targetId, attackRoll, damage, damageType, crit } = req.body || {};
      if (!attackerId || !targetId || typeof attackRoll !== 'number' || typeof damage !== 'number') {
        return res.status(400).json({ error: 'attackerId, targetId, attackRoll, damage required' });
      }
      const result = combatSvc.processAttack(attackerId, targetId, attackRoll, damage, damageType, crit);
      if (!result) return res.status(404).json({ error: 'Attacker or target not found' });
      res.json(result);
    });

    // Proxy combat state for player reconnect
    this.app.get('/api/combat', (req, res) => {
      const combatSvc = this.orchestrator.getService('combat');
      if (!combatSvc) return res.status(503).json({ error: 'Combat service unavailable' });
      res.json(combatSvc._getCombatState());
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

    // Feature 72: QR code join data
    this.app.get('/api/join-info', (req, res) => {
      const os = require('os');
      const interfaces = os.networkInterfaces();
      let ip = '192.168.0.198'; // fallback
      for (const [name, addrs] of Object.entries(interfaces)) {
        for (const addr of addrs) {
          if (addr.family === 'IPv4' && !addr.internal && addr.address.startsWith('192.168.')) {
            ip = addr.address;
          }
        }
      }
      const proto = this.server instanceof https.Server ? 'https' : 'http';
      const port = this.port || 3202;
      const assignments = this.config?.characterAssignments || {};
      const players = Object.keys(assignments);
      res.json({
        baseUrl: `${proto}://${ip}:${port}`,
        players: players.map(p => ({
          name: p,
          url: `${proto}://${ip}:${port}/player/${p}`,
          assigned: !!assignments[p]
        }))
      });
    });

    // Feature 74: Dual-axis alignment tracking
    this.app.post('/api/alignment/:playerId', (req, res) => {
      const { playerId } = req.params;
      const { compassion, ruthlessness, reason } = req.body;
      const current = this.state.get(`players.${playerId}.alignment`) || { compassion: 0, ruthlessness: 0, history: [] };
      if (compassion != null) current.compassion = Math.max(-100, Math.min(100, current.compassion + compassion));
      if (ruthlessness != null) current.ruthlessness = Math.max(-100, Math.min(100, current.ruthlessness + ruthlessness));
      current.history.push({
        compassion: compassion || 0, ruthlessness: ruthlessness || 0,
        reason: reason || 'DM adjustment',
        timestamp: new Date().toISOString()
      });
      // Keep last 50 history entries
      if (current.history.length > 50) current.history = current.history.slice(-50);
      this.state.set(`players.${playerId}.alignment`, current);
      this.bus.dispatch('campaign:alignment_change', { playerId, alignment: current, reason });
      res.json({ ok: true, alignment: { compassion: current.compassion, ruthlessness: current.ruthlessness } });
    });

    this.app.get('/api/alignment/:playerId', (req, res) => {
      const alignment = this.state.get(`players.${req.params.playerId}.alignment`) || { compassion: 0, ruthlessness: 0, history: [] };
      res.json(alignment);
    });

    // Feature 75: Camera engagement data from Chromebooks
    this.app.post('/api/camera/engagement', (req, res) => {
      const { playerId, engagement, expressions } = req.body;
      if (!playerId) return res.status(400).json({ error: 'playerId required' });
      // Store engagement data for AI context
      this.state.set(`players.${playerId}.engagement`, {
        score: engagement || 0,         // 0-100
        expressions: expressions || {}, // { smiling, focused, bored, surprised, scared }
        lastUpdate: Date.now()
      });
      // Feed to AI if significant
      if (engagement != null && engagement < 30) {
        this.bus.dispatch('dm:whisper', {
          text: `${playerId} appears disengaged (engagement: ${engagement}%)`,
          priority: 5, category: 'story'
        });
      }
      res.json({ ok: true });
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

    // Use noServer so dashboard can proxy WS upgrades to us on port 3200
    this.wss = new WebSocketServer({ noServer: true });
    this.wss.on('connection', (ws, req) => this._onConnection(ws, req));

    // Also handle direct connections on our own server (port 3202)
    this.server.on('upgrade', (req, socket, head) => {
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wss.emit('connection', ws, req);
      });
    });

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
        // Filter individual hidden token updates
        try {
          if (statePath.match(/^map\.tokens\.[^.]+$/) && value && value.hidden) return;
          if (statePath.match(/^map\.tokens\.[^.]+\./)) {
            const tid = statePath.split('.')[2];
            const tok = this.state.get(`map.tokens.${tid}`);
            if (tok && tok.hidden) return;
          }
          // Strip NPC names from player view (players see "Unknown" for NPCs)
          if (statePath.match(/^map\.tokens\.[^.]+$/) && value && value.type === 'npc') {
            value = Object.assign({}, value, { name: 'Unknown' });
          }
        } catch (e) {
          console.error('[PlayerBridge] Error filtering state update:', e.message);
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

    // Revelation flash when secrets are revealed (Phase H feature 38)
    this.bus.subscribe('world:secret_revealed', (env) => {
      this._broadcast({
        type: 'horror:effect',
        effect: 'revelation_flash',
        payload: { text: env.data.description || 'A dark truth is revealed...' },
        durationMs: 2500
      });
    }, 'player-bridge');

    // Damage flash on HP loss (Phase H feature 41)
    this.bus.subscribe('combat:attack_result', (env) => {
      const { targetId, hit, damage } = env.data;
      if (hit && damage > 0) {
        const intensity = Math.min(0.5, 0.1 + (damage / 40));
        const shake = Math.min(8, 1 + Math.round(damage / 5));
        this._sendToPlayer(targetId, {
          type: 'horror:effect',
          effect: 'damage_flash',
          payload: { intensity, shake },
          durationMs: 300
        });
      }
    }, 'player-bridge');

    this.bus.subscribe('dm:private_message', (env) => {
      const { playerId, text, durationMs } = env.data;
      if (playerId === 'all') {
        this._broadcast({ type: 'dm:private_message', text, durationMs });
      } else {
        this._sendToPlayer(playerId, { type: 'dm:private_message', text, durationMs });
      }
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

    // Quest journal updates (Feature 47)
    this.bus.subscribe('quest:update', (env) => {
      const { playerId } = env.data;
      if (playerId && playerId !== 'all') {
        this._sendToPlayer(playerId, { type: 'quest:update', quest: env.data.quest, quests: env.data.quests });
      } else {
        this._broadcast({ type: 'quest:update', quest: env.data.quest, quests: env.data.quests });
      }
    }, 'player-bridge');

    // NPC chat reply (Feature 49)
    this.bus.subscribe('npc:chat_reply', (env) => {
      const { playerId, npcId, npcName, text } = env.data;
      this._sendToPlayer(playerId, { type: 'npc:chat_reply', npcId, npcName, text });
    }, 'player-bridge');

    // Handout distribution (Feature 50) — with language gating
    this.bus.subscribe('handout:send', (env) => {
      const { playerId, title, text, image, preview, language } = env.data;

      if (playerId && playerId !== 'all') {
        const msg = this._buildHandoutForPlayer(playerId, { title, text, image, preview, language });
        this._sendToPlayer(playerId, msg);
      } else {
        // Broadcast to all — each player gets a version gated by their languages
        for (const [pid] of this.players) {
          const msg = this._buildHandoutForPlayer(pid, { title, text, image, preview, language });
          this._sendToPlayer(pid, msg);
        }
      }
    }, 'player-bridge');

    // Inspiration (Feature 51)
    this.bus.subscribe('inspiration:grant', (env) => {
      const { playerId, reason } = env.data;
      this._sendToPlayer(playerId, { type: 'inspiration:gain', reason });
      this.state.set(`players.${playerId}.character.inspiration`, true);
    }, 'player-bridge');

    // Push available NPCs to players on session start
    this.bus.subscribe('session:started', () => {
      this._broadcastAvailableNpcs();
    }, 'player-bridge');

    // Forward combat events to all players
    const combatEvents = [
      'combat:started', 'combat:ended', 'combat:next_turn', 'combat:prev_turn',
      'combat:hp_changed', 'combat:initiative_changed', 'combat:condition_changed',
      'combat:combatant_added', 'combat:combatant_removed', 'combat:death_save',
      'combat:attack_result'
    ];
    for (const evt of combatEvents) {
      this.bus.subscribe(evt, (env) => {
        this._broadcast({ type: env.event, data: env.data });
      }, 'player-bridge');
    }
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

    // Broadcast updated player list to all players after a short delay
    setTimeout(() => this._broadcastPlayerList(), 500);

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

    // Build map state for player (filter hidden tokens, hide NPC names)
    let playerMapState = {};
    try {
      const mapState = this.state.get('map') || {};
      playerMapState = { ...mapState };
      if (mapState.tokens) {
        const filtered = {};
        for (const [id, tok] of Object.entries(mapState.tokens)) {
          if (!tok || tok.hidden) continue;
          if (tok.type === 'npc') {
            filtered[id] = Object.assign({}, tok, { name: 'Unknown' });
          } else {
            filtered[id] = tok;
          }
        }
        playerMapState.tokens = filtered;
      }
    } catch (e) {
      console.error('[PlayerBridge] Error building map state:', e.message);
    }

    try {
      ws.send(JSON.stringify({
        type: 'init',
        playerId,
        player: initPlayer,
        scene: sceneState || {},
        combat: combatState || {},
        map: playerMapState
      }));
    } catch (e) {
      console.error('[PlayerBridge] Error sending init:', e.message);
    }

    // Send available NPCs for player chat
    setTimeout(() => this._broadcastAvailableNpcs(), 1000);

    ws.on('message', (raw, isBinary) => {
      // Binary messages are audio chunks
      if (isBinary) {
        this._handleAudioChunk(playerId, raw);
        return;
      }

      // Text messages are JSON
      try {
        const str = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
        const msg = JSON.parse(str);
        this._handlePlayerMessage(playerId, msg);
      } catch (err) {
        console.error(`[PlayerBridge] Bad message from ${playerId}:`, err.message);
      }
    });

    ws.on('close', () => {
      this.state.set(`players.${playerId}.connected`, false);
      this.players.delete(playerId);
      console.log(`[PlayerBridge] ${playerId} disconnected (${this.players.size} players online)`);
      this._broadcastPlayerList();
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

      case 'chat:message': {
        const channel = msg.channel || 'party';
        const fromName = msg.fromName || playerId;
        console.log(`[PlayerBridge] Chat from ${playerId}: channel=${channel} text="${msg.text}"`);

        // Always feed to AI context
        this.bus.dispatch('player:chat', {
          playerId,
          text: msg.text,
          channel
        });

        if (channel === 'party') {
          // Broadcast to all players (including sender for confirmation)
          this._broadcast({
            type: 'chat:party',
            from: playerId,
            fromName,
            text: msg.text
          });
          // Also show on DM dashboard
          this.bus.dispatch('chat:party', {
            from: playerId,
            fromName,
            text: msg.text
          });
        } else if (channel === 'dm') {
          // Send to DM dashboard only
          this.bus.dispatch('chat:to_dm', {
            from: playerId,
            fromName,
            text: msg.text
          });
        } else {
          // Whisper to specific player
          this._sendToPlayer(channel, {
            type: 'chat:whisper',
            from: playerId,
            fromName,
            text: msg.text
          });
        }
        break;
      }

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

      case 'inventory:update':
        this.state.set(`players.${playerId}.character.inventory`, msg.inventory || []);
        if (msg.currency) this.state.set(`players.${playerId}.character.currency`, msg.currency);
        this.bus.dispatch('player:inventory_update', { playerId });
        break;

      case 'spells:update':
        this.state.set(`players.${playerId}.character.spells`, msg.spells || []);
        this.bus.dispatch('player:spells_update', { playerId });
        break;

      case 'spell:aoe':
        this.bus.dispatch('player:spell_aoe', { playerId, spell: msg.spell, aoe: msg.aoe, x: msg.x, y: msg.y, damageType: msg.damageType });
        break;

      case 'npc:chat': {
        // Player wants to talk to an NPC — route to AI for response
        const npcId = msg.npcId;
        const npcState = this.state.get(`npcs.${npcId}`);
        console.log(`[PlayerBridge] ${playerId} talks to NPC ${npcId}: "${msg.text}"`);
        this.bus.dispatch('npc:player_chat', {
          playerId,
          npcId,
          npcName: npcState?.name || npcId,
          text: msg.text
        });
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

  _buildHandoutForPlayer(playerId, handout) {
    const { title, text, image, preview, language } = handout;
    // If no language requirement, send as-is
    if (!language) {
      return { type: 'handout:receive', title, text, image, preview };
    }
    // Check if player knows the required language
    const charData = this.state.get(`players.${playerId}.character`) || {};
    const knownLanguages = (charData.languages || []).map(l => l.toLowerCase());
    const canRead = knownLanguages.includes(language.toLowerCase());

    if (canRead) {
      return { type: 'handout:receive', title, text, image, preview, language, readable: true };
    } else {
      // Player can't read this language — scramble the text
      const scrambled = this._scrambleText(text || '');
      return {
        type: 'handout:receive',
        title: title,
        text: scrambled,
        image: image,
        preview: `Written in ${language} — you cannot read this`,
        language: language,
        readable: false
      };
    }
  }

  _scrambleText(text) {
    // Replace readable text with mysterious glyphs, preserving line breaks and spacing
    const glyphs = 'ᚠᚡᚢᚣᚤᚥᚦᚧᚨᚩᚪᚫᚬᚭᚮᚯᚰᚱᚲᚳᚴᚵᚶᚷᚸᚹᚺᚻᚼᚽᚾᚿᛀᛁᛂᛃᛄᛅᛆᛇᛈᛉᛊᛋᛌᛍ';
    return text.replace(/[a-zA-Z]/g, () => glyphs[Math.floor(Math.random() * glyphs.length)]);
  }

  _broadcastAvailableNpcs() {
    const npcs = this.state.get('npcs') || {};
    const available = Object.entries(npcs)
      .filter(([id, npc]) => npc.status === 'alive')
      .map(([id, npc]) => ({
        id,
        name: npc.name || id,
        disposition: npc.disposition || ''
      }));
    this._broadcast({ type: 'npc:available', npcs: available });
  }

  _broadcastPlayerList() {
    const players = [];
    for (const [id, player] of this.players) {
      const charName = this.state.get(`players.${id}.character.name`);
      players.push({ id, name: charName || id });
    }
    this._broadcast({ type: 'player:list', players });
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
