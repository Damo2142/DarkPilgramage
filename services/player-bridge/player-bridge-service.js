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
    this.playerMaps = {};  // playerId -> mapId (which map each player is viewing)
    this._bootTime = Date.now().toString(36); // unique per server start
    this.anonymousPlayers = true; // Hide PC names from other players until DM reveals
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

    // FIX-H1 — DM heal API. Heals one player by N HP and N stamina
    // simultaneously. body: { amount: number }. Capped at max.
    this.app.post('/api/players/:playerId/heal', (req, res) => {
      const { playerId } = req.params;
      const amount = parseInt((req.body || {}).amount, 10);
      if (!Number.isFinite(amount) || amount <= 0) {
        return res.status(400).json({ error: 'amount (positive number) required' });
      }
      const result = this._healPlayer(playerId, amount, false);
      if (!result) return res.status(404).json({ error: 'player not found' });
      res.json(result);
    });

    // FIX-H1 — Full rest. Restores HP and stamina to max.
    this.app.post('/api/players/:playerId/full-rest', (req, res) => {
      const { playerId } = req.params;
      const result = this._healPlayer(playerId, 0, true);
      if (!result) return res.status(404).json({ error: 'player not found' });
      res.json(result);
    });

    // FIX-H1 — Heal All present players to full
    this.app.post('/api/players/heal-all', (req, res) => {
      const players = this.state.get('players') || {};
      const results = [];
      for (const [pid, p] of Object.entries(players)) {
        if (!p || p.absent || p.notYetArrived) continue;
        const r = this._healPlayer(pid, 0, true);
        if (r) results.push(r);
      }
      res.json({ ok: true, healed: results.length, results });
    });

    // FIX-J1 — Clear wounds only (HP/stamina untouched)
    this.app.post('/api/players/:playerId/clear-wounds', (req, res) => {
      const { playerId } = req.params;
      const wounds = { head: 0, torso: 0, leftArm: 0, rightArm: 0, leftLeg: 0, rightLeg: 0 };
      this.state.set('players.' + playerId + '.wounds', wounds);
      this.bus.dispatch('wounds:updated', { playerId, wounds, reason: 'dm-clear' });
      const charName = this.state.get('players.' + playerId + '.character.name') || playerId;
      this.bus.dispatch('dm:whisper', {
        text: charName + ' wound state cleared by DM.',
        priority: 3, category: 'heal', source: 'dm-clear-wounds'
      });
      res.json({ ok: true, playerId, wounds });
    });

    // FIX-H1 — Heal selected list to full. body: { playerIds: ['kim','jerome'] }
    this.app.post('/api/players/heal-selected', (req, res) => {
      const { playerIds } = req.body || {};
      if (!Array.isArray(playerIds)) return res.status(400).json({ error: 'playerIds array required' });
      const results = [];
      for (const pid of playerIds) {
        const r = this._healPlayer(pid, 0, true);
        if (r) results.push(r);
      }
      res.json({ ok: true, healed: results.length, results });
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

    // Toggle anonymous player names on/off (DM control)
    this.app.post('/api/players/anonymous', (req, res) => {
      const { enabled } = req.body || {};
      this.anonymousPlayers = enabled !== false;
      console.log(`[PlayerBridge] Anonymous players: ${this.anonymousPlayers}`);
      // Re-send full map state to all players so names update immediately
      const mapState = this.state.get('map') || {};
      for (const [pid] of this.players) {
        const filtered = { ...mapState };
        if (filtered.tokens) {
          const ft = {};
          for (const [id, tok] of Object.entries(filtered.tokens)) {
            if (!tok || tok.hidden) continue;
            let safe = tok.type === 'npc' ? { ...tok, name: 'Unknown' } : tok;
            safe = this._anonymizeToken(safe, pid);
            ft[id] = safe;
          }
          filtered.tokens = ft;
        }
        this._sendToPlayer(pid, { type: 'map:full_update', map: filtered });
      }
      res.json({ anonymousPlayers: this.anonymousPlayers });
    });

    this.app.get('/api/players/anonymous', (req, res) => {
      res.json({ anonymousPlayers: this.anonymousPlayers });
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

  _updateTokenLight(playerId, inventory) {
    // 5e light sources: torch (20ft bright/20ft dim), lantern (30/30), lamp (15/30), candle (5/5)
    const lightItems = {
      'torch': { bright: 20, dim: 20 },
      'lantern': { bright: 30, dim: 30 },
      'hooded lantern': { bright: 30, dim: 30 },
      'bullseye lantern': { bright: 60, dim: 60 },
      'lamp': { bright: 15, dim: 30 },
      'candle': { bright: 5, dim: 5 },
      'light': { bright: 20, dim: 20 }  // Light cantrip
    };
    let bestLight = null;
    for (const item of inventory) {
      if (!item.equipped) continue;
      const name = (item.name || '').toLowerCase();
      for (const [key, val] of Object.entries(lightItems)) {
        if (name.includes(key)) {
          if (!bestLight || val.bright > bestLight.bright) bestLight = { ...val, name: item.name };
        }
      }
    }
    const gs = this.state.get('map.gridSize') || 70;
    if (bestLight) {
      const lightData = {
        bright: (bestLight.bright / 5) * gs,
        dim: (bestLight.dim / 5) * gs
      };
      this.state.set(`map.tokens.${playerId}.light`, lightData);
      console.log(`[PlayerBridge] Token light for ${playerId}: bright=${lightData.bright}px dim=${lightData.dim}px (${bestLight.name || 'unknown'})`);
    } else {
      this.state.set(`map.tokens.${playerId}.light`, null);
    }
  }

  _persistCharacterField(playerId, field, value) {
    try {
      const charSvc = this.orchestrator.getService('characters');
      if (!charSvc) return;
      const assignments = charSvc.getAssignments();
      const charId = assignments[playerId];
      if (!charId) return;
      const char = charSvc.getCharacter(charId);
      if (!char) return;
      char[field] = value;
      charSvc.saveCharacter(String(charId), char);
    } catch (e) {
      console.warn(`[PlayerBridge] Could not persist ${field} for ${playerId}:`, e.message);
    }
  }

  _pushCharactersToPlayers() {
    for (const [playerId] of this.players) {
      const char = this._lookupCharacter(playerId);
      if (char) {
        this.state.set(`players.${playerId}.character`, char);
        // Ensure PC token exists with proper type and darkvision for dynamic lighting
        const existing = this.state.get(`map.tokens.${playerId}`);
        const dvRange = char.senses?.darkvision || (char.features?.some(f => f.name === 'Darkvision') ? 60 : 0);
        if (!existing || !existing.type) {
          // Token stub or missing — set full PC token properties
          const mapState = this.state.get('map') || {};
          const spawns = mapState.playerSpawns?.spread || [];
          const spawn = spawns[0] || mapState.playerSpawns?.default || { x: 280, y: 350 };
          this.state.set(`map.tokens.${playerId}`, {
            ...(existing || {}),
            id: playerId,
            name: char.name || playerId,
            type: 'pc',
            x: existing?.x || spawn.x,
            y: existing?.y || spawn.y,
            image: `${playerId}.webp`,
            visible: true,
            hp: char.hp || { current: 20, max: 20 },
            ac: char.ac || 10,
            darkvision: dvRange
          });
        } else {
          this.state.set(`map.tokens.${playerId}.darkvision`, dvRange);
        }
        // Update token light from equipped items
        if (char.inventory) this._updateTokenLight(playerId, char.inventory);
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

    // Section 3 — Window perception flash (intercept hits)
    this.bus.subscribe('player:perception_flash', (env) => {
      const { playerId, description, margin, waypoint } = env.data || {};
      if (!playerId) return;
      this._sendToPlayer(playerId, {
        type: 'perception:flash',
        description,
        margin,
        waypoint
      });
    }, 'player-bridge');

    // Section 6 — NPC speech routed to specific player by proximity tier
    this.bus.subscribe('player:npc_speech', (env) => {
      const d = env.data || {};
      if (!d.playerId) return;
      this._sendToPlayer(d.playerId, {
        type: 'npc:speech',
        npcId: d.npcId,
        npcName: d.npcName,
        text: d.text,
        tier: d.tier || 'FULL'
      });
    }, 'player-bridge');

    // FIX-D — private NPC audio (ElevenLabs MP3) routed to one player only
    this.bus.subscribe('npc:audio:player', (env) => {
      const d = env.data || {};
      if (!d.playerId) return;
      this._sendToPlayer(d.playerId, {
        type: 'npc:audio',
        npc: d.npc || 'NPC',
        text: d.text || '',
        url: d.url || null,
        fallback: !!d.fallback
      });
    }, 'player-bridge');

    // Section 6 — Player to player private message
    this.bus.subscribe('player:p2p_message', (env) => {
      const d = env.data || {};
      if (!d.toPlayerId) return;
      this._sendToPlayer(d.toPlayerId, {
        type: 'chat:p2p',
        from: d.fromPlayerId,
        fromName: d.fromName,
        text: d.text
      });
    }, 'player-bridge');

    // Section 6 — Narrator whisper to specific player
    this.bus.subscribe('narrator:whisper_player', (env) => {
      const d = env.data || {};
      if (!d.playerId) return;
      this._sendToPlayer(d.playerId, {
        type: 'narrator:whisper',
        text: d.text
      });
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

      // Forward full map replacement (path='map' without dot)
      // Only send to players assigned to this map — don't disrupt players on other maps
      if (statePath === 'map' && typeof value === 'object' && value) {
        const newMapId = value.id;
        // Per-player filtering: each player gets their own view of tokens
        for (const [pid] of this.players) {
          if (this.playerMaps[pid] === newMapId || !this.playerMaps[pid]) {
            this.playerMaps[pid] = newMapId;
            const filtered = { ...value };
            if (filtered.tokens) {
              const ft = {};
              for (const [id, tok] of Object.entries(filtered.tokens)) {
                if (!tok || tok.hidden) continue;
                let safe = tok.type === 'npc' ? { ...tok, name: 'Unknown' } : tok;
                safe = this._anonymizeToken(safe, pid);
                ft[id] = safe;
              }
              filtered.tokens = ft;
            }
            this._sendToPlayer(pid, { type: 'map:full_update', map: filtered });
          }
        }
        return;
      }

      if (statePath.startsWith('scene.') || statePath.startsWith('combat.')) {
        this._broadcast({ type: 'state:update', path: statePath, value });
      }

      if (statePath.startsWith('map.')) {
        // Map changes only go to players on the DM's active map
        const activeMapId = this.state.get('map.id');

        // Filter hidden tokens
        try {
          if (statePath.match(/^map\.tokens\.[^.]+$/) && value && value.hidden) return;
          if (statePath.match(/^map\.tokens\.[^.]+\./)) {
            const tid = statePath.split('.')[2];
            const tok = this.state.get(`map.tokens.${tid}`);
            if (tok && tok.hidden) return;
          }
        } catch (e) {
          console.error('[PlayerBridge] Error filtering state update:', e.message);
        }

        // Per-player token filtering (NPC names + anonymous PC names)
        for (const [pid] of this.players) {
          if (this.playerMaps[pid] !== activeMapId) continue;
          const msg = { type: 'state:update', path: statePath, value };

          if (statePath === 'map.tokens' && typeof value === 'object') {
            const filtered = {};
            for (const [id, tok] of Object.entries(value)) {
              if (tok.hidden) continue;
              let safe = tok.type === 'npc' ? { ...tok, name: 'Unknown' } : tok;
              safe = this._anonymizeToken(safe, pid);
              filtered[id] = safe;
            }
            msg.value = filtered;
          } else if (statePath.match(/^map\.tokens\.[^.]+$/) && value) {
            if (value.type === 'npc') {
              msg.value = { ...value, name: 'Unknown' };
            } else {
              msg.value = this._anonymizeToken(value, pid);
            }
          }

          this._sendToPlayer(pid, msg);
        }
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

    // ── Build 6 — narrative-only combat updates for player Chromebooks ──
    //
    // Players never see HP numbers, DCs, or condition labels standing alone.
    // They see gothic description text, a colored border flash for
    // "your turn" and "save required", and nothing else. The DM screen is
    // where the numbers live.

    // Wound narrative on HP change — only pushed to the affected PC
    this.bus.subscribe('combat:hp_changed', (env) => {
      const { combat, combatantId, newHp } = env.data || {};
      if (!combat || !combatantId) return;
      const combatant = (combat.turnOrder || []).find(c => c && c.id === combatantId);
      if (!combatant || combatant.type !== 'pc') return;
      const maxHp = combatant.hp?.max ?? 1;
      const description = this._getWoundDescription(newHp, maxHp);
      if (!description) return;
      this._sendToPlayer(combatantId, {
        type: 'combat:wound_update',
        description
      });
    }, 'player-bridge');

    // Save required — whoever must save gets a gold-border flash + save
    // type + narrative cause. DC is deliberately NOT included.
    this.bus.subscribe('combat:save_required', (env) => {
      const d = env.data || {};
      if (!d.playerId) return;
      this._sendToPlayer(d.playerId, {
        type: 'combat:save_required',
        saveType: d.saveType || 'Constitution',
        cause: d.cause || 'Something is happening to you.'
        // intentionally: no DC
      });
    }, 'player-bridge');

    // Condition narrative on add/remove — only for PC combatants.
    // combat-service sends { combatantId, conditions, toggled } —
    // whether the toggle added or removed is determined by whether
    // `toggled` is currently in `conditions`.
    this.bus.subscribe('combat:condition_changed', (env) => {
      const d = env.data || {};
      const { combat, combatantId, conditions, toggled } = d;
      if (!combat || !combatantId || !toggled) return;
      const combatant = (combat.turnOrder || []).find(c => c && c.id === combatantId);
      if (!combatant || combatant.type !== 'pc') return;
      const active = Array.isArray(conditions) && conditions.includes(toggled);
      this._sendToPlayer(combatantId, {
        type: 'combat:condition_update',
        condition: toggled,
        narrative: this._getConditionNarrative(toggled),
        active
      });
    }, 'player-bridge');

    // Your-turn flash — only for PC combatants. Spell status is a
    // narrative summary of magic remaining; no counts/slot numbers.
    this.bus.subscribe('combat:next_turn', (env) => {
      const d = env.data || {};
      const combatant = d.combatant
        || (d.combat && d.combat.turnOrder && d.combat.turnOrder[d.combat.currentTurn]);
      if (!combatant || combatant.type !== 'pc') return;
      const playerId = combatant.id;
      const pState = this.state.get(`players.${playerId}`) || {};
      const spellStatus = this._getSpellSlotDescription(pState.character);
      this._sendToPlayer(playerId, {
        type: 'combat:your_turn',
        spellStatus,
        movementFeet: pState.character?.speed || 30
      });
    }, 'player-bridge');

    // Addition 2 — telepathy:touch fires for all three sources
    // (Vladislav, Letavec, Page). Style determines presentation:
    //   'gold-flash' = save success — gold border + italic text
    //   'silent'     = save failure with sensation/thought — italic text in CONDITION tab, no border
    //   null         = information stolen — DM whisper only, nothing to player
    this.bus.subscribe('telepathy:touch', (env) => {
      const data = env.data || {};
      if (!data.playerId) return;
      const { playerId, style, text } = data;
      if (!style) return; // information mode — DM whisper only
      this._sendToPlayer(playerId, {
        type: 'telepathy:touch',
        style,
        text: text || ''
      });
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

    // Ambient life events — broadcast to all players
    this.bus.subscribe('ambient:observation', (env) => {
      this._broadcast({
        type: 'ambient:observation',
        npcName: env.data.npcName,
        text: env.data.text
      });
    }, 'player-bridge');

    this.bus.subscribe('ambient:environment', (env) => {
      this._broadcast({
        type: 'ambient:environment',
        text: env.data.text,
        tier: env.data.tier
      });
    }, 'player-bridge');

    this.bus.subscribe('ambient:dwell_reaction', (env) => {
      // Send dwell reaction only to the lingering player
      const { playerId, npcName, text } = env.data;
      this._sendToPlayer(playerId, {
        type: 'ambient:dwell_reaction',
        npcName, text
      });
    }, 'player-bridge');

    this.bus.subscribe('ambient:performance', (env) => {
      this._broadcast({
        type: 'ambient:performance',
        npcName: env.data.npcName,
        title: env.data.title,
        content: env.data.content,
        perfType: env.data.type
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

    // Camera frame relay: forward player camera frames to dashboard
    this.bus.subscribe('player:camera_frame', (env) => {
      // Forward to dashboard clients only (not other players)
      const dashSvc = this.orchestrator.getService('dashboard');
      if (dashSvc) {
        dashSvc._broadcast({ type: 'player:camera_frame', playerId: env.data.playerId, frame: env.data.frame });
      }
    }, 'player-bridge');

    // Stamina updates to players
    this.bus.subscribe('stamina:updated', (env) => {
      const { playerId } = env.data;
      if (playerId) {
        this._sendToPlayer(playerId, { type: 'stamina:updated', data: env.data });
      }
    }, 'player-bridge');

    // Equipment condition updates
    this.bus.subscribe('equipment:updated', (env) => {
      const { playerId } = env.data;
      if (playerId) {
        this._sendToPlayer(playerId, { type: 'equipment:updated', data: env.data });
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

    // Forward audio events to remote players (SFX/ambience streaming)
    this.bus.subscribe('audio:play_sound', (env) => {
      const { url, volume, category } = env.data;
      this._broadcast({ type: 'audio:play', url, volume, category });
    }, 'player-bridge');

    this.bus.subscribe('audio:ambience_change', (env) => {
      const { url, volume, crossfade } = env.data;
      this._broadcast({ type: 'audio:ambience', url, volume, crossfade });
    }, 'player-bridge');

    // Forward map events only to players on the activated map
    this.bus.subscribe('map:activated', (env) => {
      try {
        const mapState = this.state.get('map') || {};
        const activatedMapId = mapState.id;
        // Per-player filtering for anonymous mode
        for (const [pid] of this.players) {
          if (this.playerMaps[pid] === activatedMapId) {
            const filtered = { ...mapState };
            if (filtered.tokens) {
              const ft = {};
              for (const [id, tok] of Object.entries(filtered.tokens)) {
                if (!tok || tok.hidden) continue;
                let safe = tok.type === 'npc' ? { ...tok, name: 'Unknown' } : tok;
                safe = this._anonymizeToken(safe, pid);
                ft[id] = safe;
              }
              filtered.tokens = ft;
            }
            this._sendToPlayer(pid, { type: 'map:full_update', map: filtered });
          }
        }
      } catch (e) {
        console.error('[PlayerBridge] Error broadcasting map:activated:', e.message);
      }
    }, 'player-bridge');

    this.bus.subscribe('map:token_added', (env) => {
      const { token } = env.data;
      if (!token || token.hidden) return;
      const activeMapId = this.state.get('map.id');
      for (const [pid] of this.players) {
        if (this.playerMaps[pid] === activeMapId) {
          let safe = token.type === 'npc' ? { ...token, name: 'Unknown' } : token;
          safe = this._anonymizeToken(safe, pid);
          this._sendToPlayer(pid, { type: 'map:token_added', token: safe });
        }
      }
    }, 'player-bridge');

    // Player assigned to a different map — send them the full map state
    this.bus.subscribe('map:player_map_change', (env) => {
      const { playerId, mapState } = env.data;
      if (this.players.has(playerId)) {
        this.playerMaps[playerId] = mapState.id;
        const filtered = { ...mapState };
        if (filtered.tokens) {
          filtered.tokens = this._anonymizeTokens(filtered.tokens, playerId);
        }
        this._sendToPlayer(playerId, { type: 'map:full_update', map: filtered });
        console.log(`[PlayerBridge] Sent map ${mapState.id} to ${playerId}`);
      }
    }, 'player-bridge');

    this.bus.subscribe('map:token_removed', (env) => {
      const activeMapId = this.state.get('map.id');
      for (const [pid] of this.players) {
        if (this.playerMaps[pid] === activeMapId) {
          this._sendToPlayer(pid, { type: 'map:token_removed', tokenId: env.data.tokenId });
        }
      }
    }, 'player-bridge');

    // H4 — mid-session visibility toggle. The state:change path-routed
    // handler silently drops hidden=true updates, so a DM toggling
    // visibility through /api/map/token/visibility had no effect on
    // player clients. Translate the event into add/remove messages.
    this.bus.subscribe('map:token_visibility', (env) => {
      const { tokenId, visible } = env.data || {};
      if (!tokenId) return;
      const activeMapId = this.state.get('map.id');
      if (visible) {
        const token = this.state.get(`map.tokens.${tokenId}`);
        if (!token) return;
        for (const [pid] of this.players) {
          if (this.playerMaps[pid] !== activeMapId) continue;
          let safe = token.type === 'npc' ? { ...token, name: 'Unknown' } : token;
          safe = this._anonymizeToken(safe, pid);
          this._sendToPlayer(pid, { type: 'map:token_added', token: safe });
        }
      } else {
        for (const [pid] of this.players) {
          if (this.playerMaps[pid] !== activeMapId) continue;
          this._sendToPlayer(pid, { type: 'map:token_removed', tokenId });
        }
      }
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
    const isDryRun = params.get('dryrun') === '1';

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
      audioStreaming: false,
      dryRun: isDryRun
    });

    if (isDryRun) {
      console.log(`[PlayerBridge] DRY RUN connection: ${playerId} — actions will not persist`);
    }

    this.state.set(`players.${playerId}.connected`, true);
    this.state.set(`players.${playerId}.deviceId`, playerId);

    // Track which map this player is on
    const mapSvc = this.orchestrator.getService('map');
    const activeMapId = this.state.get('map.id');
    this.playerMaps[playerId] = (mapSvc?.playerMapAssignment?.[playerId]) || activeMapId || null;

    console.log(`[PlayerBridge] ${playerId} connected (${this.players.size} players online, map: ${this.playerMaps[playerId]})`);
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
      // Preserve inventory equipped/attuned state from state if reconnecting
      const existingInv = this.state.get(`players.${playerId}.character.inventory`);
      if (existingInv && Array.isArray(existingInv) && existingInv.length > 0) {
        // Merge equipped/attuned flags from state into fresh character data by item name
        const stateMap = {};
        for (const item of existingInv) {
          if (item.name) stateMap[item.name] = { equipped: item.equipped, attuned: item.attuned };
        }
        for (const item of (characterData.inventory || [])) {
          const saved = stateMap[item.name];
          if (saved) {
            if (saved.equipped) item.equipped = true;
            if (saved.attuned) item.attuned = true;
          }
        }
      }
      this.state.set(`players.${playerId}.character`, characterData);
      console.log('[PlayerBridge] Sending character ' + characterData.name + ' to ' + playerId);
      // Update token light from equipped light sources on connect
      if (characterData.inventory) {
        this._updateTokenLight(playerId, characterData.inventory);
      }
    }
    const initPlayer = Object.assign({}, playerState || {}, characterData ? { character: characterData } : {});

    // Build map state for player (use their assigned map, not necessarily DM's active map)
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
            filtered[id] = this._anonymizeToken(tok, playerId);
          }
        }
        playerMapState.tokens = filtered;
      }
    } catch (e) {
      console.error('[PlayerBridge] Error building map state:', e.message);
    }

    try {
      const initMsg = JSON.stringify({
        type: 'init',
        playerId,
        serverBoot: this._bootTime,
        player: initPlayer,
        scene: sceneState || {},
        combat: combatState || {},
        map: playerMapState
      });
      console.log(`[PlayerBridge] Sending init to ${playerId} (${initMsg.length} bytes, hasChar=${!!characterData})`);
      ws.send(initMsg);
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

    ws.on('error', (err) => {
      console.error(`[PlayerBridge] WS error for ${playerId}:`, err.message);
    });

    ws.on('close', (code, reason) => {
      console.log(`[PlayerBridge] ${playerId} WS close code=${code} reason=${reason || 'none'}`);
      this.state.set(`players.${playerId}.connected`, false);
      this.players.delete(playerId);
      console.log(`[PlayerBridge] ${playerId} disconnected (${this.players.size} players online)`);
      this._broadcastPlayerList();
      this.bus.dispatch('player:disconnected', { playerId });
    });
  }

  _handlePlayerMessage(playerId, msg) {
    // FIX-B6 — server-side WS dedup. Drop duplicate semantic events that
    // arrive within 2 seconds of an identical one from the same player.
    // Also honor an explicit msg.seq if the client supplies one.
    if (this._isDuplicateWsMessage(playerId, msg)) {
      console.log(`[PlayerBridge] DEDUPED ${playerId} ${msg.type} (duplicate within 2s)`);
      return;
    }
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

      case 'audio:chunk':
        // Player mic audio — dispatch for transcription
        this.bus.dispatch('audio:chunk', {
          playerId,
          audio: msg.data?.audio || msg.audio,
          sampleRate: msg.data?.sampleRate || msg.sampleRate || 16000
        });
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
        if (mapSvc) {
          const result = mapSvc._moveToken(msg.tokenId, msg.x, msg.y);
          if (result && result.blocked) {
            // Movement was blocked by wall — send rejection so client snaps back
            this._sendToPlayer(playerId, {
              type: 'map:move_rejected',
              tokenId: msg.tokenId,
              x: result.x,
              y: result.y,
              reason: 'wall'
            });
          }
        }
        break;
      }

      case 'map:token_facing': {
        // Players can only change their own token's facing
        if (msg.tokenId !== playerId) break;
        const facing = typeof msg.facing === 'number' ? msg.facing : 0;
        this.state.set(`map.tokens.${playerId}.facing`, facing);
        // Broadcast facing change to all players
        this.bus.dispatch('map:token_facing', { tokenId: playerId, facing });
        break;
      }

      case 'inventory:update':
        this.state.set(`players.${playerId}.character.inventory`, msg.inventory || []);
        if (msg.currency) this.state.set(`players.${playerId}.character.currency`, msg.currency);
        this.bus.dispatch('player:inventory_update', { playerId });
        // Update token light from equipped light sources (torch, lantern, etc.)
        this._updateTokenLight(playerId, msg.inventory || []);
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

      case 'speak': {
        // System 8: Auto-detect NPC name in player speech and route accordingly
        const text = (msg.text || '').trim();
        if (!text) break;
        const npcs = this.state.get('npcs') || {};
        let matchedNpcId = null;
        let matchedNpcName = null;
        const lowerText = text.toLowerCase();
        // Check for NPC names in the message
        for (const [nid, npc] of Object.entries(npcs)) {
          const name = (npc.name || nid).toLowerCase();
          if (lowerText.includes(name)) {
            matchedNpcId = nid;
            matchedNpcName = npc.name || nid;
            break;
          }
        }
        // Also check for 'spurt'
        if (!matchedNpcId && lowerText.includes('spurt')) {
          matchedNpcId = 'spurt';
          matchedNpcName = 'Spurt';
        }

        if (matchedNpcId) {
          console.log(`[PlayerBridge] ${playerId} speaks to ${matchedNpcName}: "${text}"`);
          this.bus.dispatch('npc:player_chat', {
            playerId, npcId: matchedNpcId, npcName: matchedNpcName, text
          });
        } else {
          // No NPC detected — treat as party chat
          this.bus.dispatch('chat:party', { from: playerId, fromName: this.state.get(`players.${playerId}.character.name`) || playerId, text });
          this._broadcast({ type: 'chat:party', from: playerId, fromName: this.state.get(`players.${playerId}.character.name`) || playerId, text });
        }
        break;
      }

      case 'camera:frame':
        // System 9: Player sends camera JPEG snapshot
        this.bus.dispatch('player:camera_frame', { playerId, frame: msg.frame });
        break;

      case 'ping':
        this._sendToPlayer(playerId, { type: 'pong', ts: Date.now() });
        break;

      default:
        console.log(`[PlayerBridge] Unknown message from ${playerId}: ${msg.type}`);
    }
  }

  // FIX-H1 — Heal a single player by `amount` HP and `amount` stamina,
  // OR fully restore both if fullRest is true. Dispatches hp:update and
  // stamina:set events and a max:audio whisper for critical recoveries.
  _healPlayer(playerId, amount, fullRest) {
    const playerState = this.state.get(`players.${playerId}`);
    if (!playerState) return null;
    const charHp = this.state.get(`players.${playerId}.character.hp`);
    if (!charHp || typeof charHp.max !== 'number') return null;

    const hpBefore = typeof charHp.current === 'number' ? charHp.current : 0;
    const hpMax = charHp.max;
    const hpAmount = fullRest ? hpMax : Math.max(0, Math.min(amount, hpMax - hpBefore));
    const newHp = fullRest ? hpMax : Math.min(hpMax, hpBefore + hpAmount);
    this.state.set(`players.${playerId}.character.hp.current`, newHp);
    this.bus.dispatch('hp:update', { playerId, current: newHp, max: hpMax, source: fullRest ? 'full-rest' : 'dm-heal' });

    // Stamina recovery — same amount as HP
    const stam = this.state.get(`players.${playerId}.stamina`);
    let newStam = null;
    if (stam && typeof stam.max === 'number') {
      const stamBefore = typeof stam.current === 'number' ? stam.current : 0;
      newStam = fullRest ? stam.max : Math.min(stam.max, stamBefore + (amount || 0));
      stam.current = newStam;
      // Recompute state
      const pct = newStam / stam.max;
      let st = 'fresh';
      if (pct <= 0) st = 'collapsed';
      else if (pct < 0.12) st = 'spent';
      else if (pct < 0.35) st = 'exhausted';
      else if (pct < 0.60) st = 'winded';
      stam.state = st;
      this.state.set(`players.${playerId}.stamina`, stam);
      this.bus.dispatch('stamina:updated', { playerId, current: newStam, max: stam.max, state: stam.state, reason: fullRest ? 'full-rest' : 'dm-heal' });
    }

    // Reset wound tiers on full rest
    if (fullRest) {
      const wounds = { head: 0, torso: 0, leftArm: 0, rightArm: 0, leftLeg: 0, rightLeg: 0 };
      this.state.set(`players.${playerId}.wounds`, wounds);
      this.bus.dispatch('wounds:updated', { playerId, wounds, reason: 'full-rest' });
    }

    const charName = (playerState.character && playerState.character.name) || playerId;
    const wasCritical = hpBefore <= Math.max(1, hpMax * 0.2);
    const text = fullRest
      ? charName + ' is fully restored. HP and stamina back to maximum.'
      : charName + ' is restored. HP and stamina both recovered (' + hpBefore + ' → ' + newHp + ').';
    this.bus.dispatch('dm:whisper', {
      text,
      priority: wasCritical ? 1 : 3,
      category: 'heal',
      source: 'dm-heal'
    });
    console.log('[PlayerBridge] HEAL ' + playerId + (fullRest ? ' FULL REST' : ' +' + amount) + ' → HP ' + newHp + '/' + hpMax + (newStam != null ? ' STAM ' + newStam + '/' + (stam && stam.max) : ''));
    return { playerId, hp: { before: hpBefore, after: newHp, max: hpMax }, stamina: stam ? { current: newStam, max: stam.max, state: stam.state } : null, fullRest: !!fullRest };
  }

  // FIX-B6/C3 — duplicate WS message detection.
  // Skips audio:chunk and audio:start/stop (high-volume continuous events),
  // and skips ping/pong. Everything else is fingerprinted by
  // (type + key fields) and dropped if seen within 3 seconds. Honors an
  // explicit msg.seq from the client to drop literal repeats of the same id.
  _isDuplicateWsMessage(playerId, msg) {
    if (!msg || !msg.type) return false;
    // Skip dedup for streaming / housekeeping events
    const SKIP = new Set(['audio:chunk', 'audio:start', 'audio:stop', 'ping', 'pong', 'camera:frame']);
    if (SKIP.has(msg.type)) return false;
    this._wsDedup = this._wsDedup || {};
    const bucket = this._wsDedup[playerId] = this._wsDedup[playerId] || { recent: {}, seqSeen: {} };
    const now = Date.now();
    // Honor explicit client sequence id (drop literal repeats)
    if (msg.seq != null) {
      const key = msg.type + ':' + msg.seq;
      if (bucket.seqSeen[key] && (now - bucket.seqSeen[key]) < 60 * 1000) return true;
      bucket.seqSeen[key] = now;
    }
    // Content fingerprint dedup
    let fp = msg.type;
    if (msg.text) fp += '|' + String(msg.text).slice(0, 200);
    if (msg.npcId) fp += '|' + msg.npcId;
    if (msg.targetId) fp += '|' + msg.targetId;
    if (msg.tokenId) fp += '|' + msg.tokenId;
    if (msg.channel) fp += '|' + msg.channel;
    const last = bucket.recent[fp];
    if (last && (now - last) < 3000) return true;
    bucket.recent[fp] = now;
    // Sweep stale entries periodically
    if (Object.keys(bucket.recent).length > 60) {
      for (const [k, t] of Object.entries(bucket.recent)) {
        if (now - t > 10 * 1000) delete bucket.recent[k];
      }
    }
    return false;
  }

  _handleAudioChunk(playerId, audioData) {
    // FIX5 — sampled debug log so we can see mic audio reaching the bus
    // without flooding logs. One log line per 50 chunks per player.
    this._micDebugCounters = this._micDebugCounters || {};
    this._micDebugCounters[playerId] = (this._micDebugCounters[playerId] || 0) + 1;
    if (this._micDebugCounters[playerId] % 50 === 1) {
      const sz = audioData && (audioData.byteLength || audioData.length || 0);
      console.log('[MIC-AUDIO]', playerId, 'chunk #' + this._micDebugCounters[playerId], sz + ' bytes');
    }
    this.bus.dispatch('audio:chunk', {
      playerId,
      audio: audioData,
      timestamp: Date.now()
    });
  }

  // Anonymize token name: other PCs become "Traveler" when anonymous mode is on
  _anonymizeToken(tok, forPlayerId) {
    if (!this.anonymousPlayers) return tok;
    if (!tok || tok.type !== 'pc') return tok;
    // Each player sees their own name
    if (tok.id === forPlayerId) return tok;
    return { ...tok, name: 'Traveler' };
  }

  _anonymizeTokens(tokens, forPlayerId) {
    if (!tokens) return tokens;
    const result = {};
    for (const [id, tok] of Object.entries(tokens)) {
      result[id] = this._anonymizeToken(tok, forPlayerId);
    }
    return result;
  }

  _sendToPlayer(playerId, data) {
    const player = this.players.get(playerId);
    if (player && player.ws.readyState === 1) {
      player.ws.send(JSON.stringify(data));
    }
  }

  // ── Build 6 — narrative helpers for player-facing combat ──
  // These produce gothic description text only. No numbers ever appear in
  // the returned strings — HP brackets, DCs, and slot counts are never
  // exposed to the player Chromebook.

  _getWoundDescription(currentHp, maxHp) {
    const max = Number(maxHp);
    if (!Number.isFinite(max) || max <= 0) return null;
    const pct = Number(currentHp) / max;
    if (pct > 0.75) return null; // feels fine — no update
    if (pct > 0.50) return 'You are bleeding. Not badly. But you feel it.';
    if (pct > 0.25) return 'Something is wrong. Your body is failing you. Every movement costs.';
    if (pct > 0.10) return 'You are badly hurt. You do not know how much longer you can continue.';
    if (pct > 0)    return 'You are dying. Something in you knows it.';
    return 'You are down.';
  }

  _getSpellSlotDescription(character) {
    const slots = character && character.spellSlots;
    if (!slots || typeof slots !== 'object') return null;
    // spellSlots on DDB-synced characters is {levelN: {total, used, remaining}}
    // On hand-authored locals it may be {levelN: {total, used, remaining}} too
    // or even null. Only fire when we can read remaining vs total.
    let total = 0, remaining = 0, hasAny = false;
    for (const k of Object.keys(slots)) {
      const v = slots[k];
      if (!v || typeof v !== 'object') continue;
      if (Number.isFinite(v.total))     { total     += v.total;     hasAny = true; }
      if (Number.isFinite(v.remaining)) { remaining += v.remaining; }
    }
    if (!hasAny || total <= 0) return null;
    const pct = remaining / total;
    if (pct >= 1.0) return 'Your magic feels full.';
    if (pct >= 0.5) return 'Your magic feels strained.';
    if (pct >= 0.1) return 'You have very little left.';
    return 'Your magic is spent.';
  }

  _getConditionNarrative(condition) {
    const narratives = {
      poisoned:    'Your blood burns. Something wrong moves through you.',
      grappled:    'You cannot break free.',
      prone:       'You are on the ground.',
      frightened:  'Your body will not obey. Everything in you says run.',
      paralyzed:   'You cannot move. You cannot speak. You are completely aware.',
      charmed:     'Something about them feels different. More reasonable. More right.',
      blinded:     'Darkness. Complete and immediate.',
      stunned:     'The world does not make sense for a moment.',
      exhaustion:  'You are running out of something that does not come back easily.',
      unconscious: 'You are down. Make your death saves.'
    };
    const key = String(condition || '').toLowerCase();
    return narratives[key] || `You are ${condition}.`;
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
