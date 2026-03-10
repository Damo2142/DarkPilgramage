const fs = require('fs');
const path = require('path');

class MapService {
  constructor() {
    this.name = 'map';
    this.orchestrator = null;
    this.maps = new Map();       // mapId -> map definition
    this.activeMapId = null;
    this.srdMonsters = [];       // SRD compendium
    this.customActors = new Map(); // slug -> actor data
  }

  async init(orchestrator) {
    this.orchestrator = orchestrator;
    this.bus = orchestrator.bus;
    this.state = orchestrator.state;
    this.config = orchestrator.config;
  }

  async start() {
    this._loadMaps();
    this._loadCompendium();
    this._loadCustomActors();
    this._setupRoutes();
    this._setupEventListeners();

    // Load initial map from scene config if set
    const sceneId = this.state.get('scene.id');
    if (sceneId) {
      // Try to find a map matching the scene
      for (const [id, map] of this.maps) {
        if (sceneId.includes(id) || id.includes(sceneId.split('-')[0])) {
          this._activateMap(id);
          break;
        }
      }
    }

    // If no map activated, load first available
    if (!this.activeMapId && this.maps.size > 0) {
      this._activateMap(this.maps.keys().next().value);
    }

    console.log(`[MapService] ${this.maps.size} map(s) loaded. Active: ${this.activeMapId || 'none'}`);
  }

  _loadMaps() {
    const mapsDir = path.join(__dirname, '..', '..', 'config', 'maps');
    if (!fs.existsSync(mapsDir)) return;

    for (const file of fs.readdirSync(mapsDir)) {
      if (!file.endsWith('.json')) continue;
      try {
        const data = JSON.parse(fs.readFileSync(path.join(mapsDir, file), 'utf8'));
        if (data.id) {
          this.maps.set(data.id, data);
          console.log(`[MapService] Loaded map: ${data.name} (${data.id})`);
        }
      } catch (e) {
        console.warn(`[MapService] Failed to load ${file}: ${e.message}`);
      }
    }
  }

  _loadCompendium() {
    const filePath = path.join(__dirname, '..', '..', 'config', 'srd-monsters.json');
    if (!fs.existsSync(filePath)) { console.log('[MapService] No SRD compendium found'); return; }
    try {
      this.srdMonsters = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      console.log(`[MapService] SRD compendium: ${this.srdMonsters.length} monsters`);
    } catch(e) { console.warn('[MapService] Failed to load SRD compendium:', e.message); }
  }

  _loadCustomActors() {
    const actorsDir = path.join(__dirname, '..', '..', 'config', 'actors');
    if (!fs.existsSync(actorsDir)) return;
    for (const file of fs.readdirSync(actorsDir)) {
      if (!file.endsWith('.json')) continue;
      try {
        const data = JSON.parse(fs.readFileSync(path.join(actorsDir, file), 'utf8'));
        if (data.slug) {
          data.custom = true;
          this.customActors.set(data.slug, data);
        }
      } catch(e) { console.warn(`[MapService] Failed to load actor ${file}:`, e.message); }
    }
    console.log(`[MapService] Custom actors: ${this.customActors.size}`);
  }

  _activateMap(mapId) {
    const map = this.maps.get(mapId);
    if (!map) return false;

    this.activeMapId = mapId;

    // Initialize token state from map definition
    const tokenState = {};
    if (map.tokens) {
      for (const [tokenId, token] of Object.entries(map.tokens)) {
        tokenState[tokenId] = { ...token, id: tokenId };
      }
    }

    // Place connected players at spawn points
    const players = this.state.get('players') || {};
    const spawns = map.playerSpawns?.spread || [];
    let spawnIdx = 0;
    for (const playerId of Object.keys(players)) {
      if (!tokenState[playerId]) {
        const spawn = spawns[spawnIdx] || map.playerSpawns?.default || { x: 280, y: 350 };
        const charData = players[playerId]?.character || {};
        tokenState[playerId] = {
          id: playerId,
          name: charData.name || playerId,
          type: 'pc',
          x: spawn.x,
          y: spawn.y,
          image: `${playerId}.webp`,
          visible: true,
          hp: charData.hp || { current: 20, max: 20 },
          ac: charData.ac || 10
        };
        spawnIdx++;
      }
    }

    // Initialize zone revealed state (default false unless specified)
    const zones = (map.zones || []).map(z => ({
      ...z,
      revealed: z.revealed === true
    }));

    // Store in state manager
    this.state.set('map', {
      id: map.id,
      name: map.name,
      image: map.image,
      gridSize: map.gridSize,
      width: map.width,
      height: map.height,
      zones
    });
    this.state.set('map.tokens', tokenState);

    this.bus.dispatch('map:activated', { mapId: map.id, name: map.name });
    return true;
  }

  _setupRoutes() {
    const dashboard = this.orchestrator.getService('dashboard');
    if (!dashboard?.app) {
      console.warn('[MapService] Dashboard not available for route mounting');
      return;
    }

    const app = dashboard.app;

    // GET /api/map — current active map + tokens
    app.get('/api/map', (req, res) => {
      if (!this.activeMapId) return res.json({ active: false });
      const mapDef = this.maps.get(this.activeMapId);
      const tokens = this.state.get('map.tokens') || {};
      res.json({
        active: true,
        map: {
          id: mapDef.id,
          name: mapDef.name,
          image: mapDef.image,
          gridSize: mapDef.gridSize,
          width: mapDef.width,
          height: mapDef.height,
          zones: this.state.get('map.zones') || mapDef.zones || []
        },
        tokens
      });
    });

    // GET /api/map/list — all available maps
    app.get('/api/map/list', (req, res) => {
      const list = [];
      for (const [id, m] of this.maps) {
        list.push({ id, name: m.name, active: id === this.activeMapId });
      }
      res.json(list);
    });

    // POST /api/map/load/:mapId — switch active map
    app.post('/api/map/load/:mapId', (req, res) => {
      const ok = this._activateMap(req.params.mapId);
      if (!ok) return res.status(404).json({ error: 'Map not found' });
      res.json({ mapId: req.params.mapId });
    });

    // POST /api/map/token/move — move a token
    // body: { tokenId, x, y }
    app.post('/api/map/token/move', (req, res) => {
      const { tokenId, x, y } = req.body || {};
      if (!tokenId || typeof x !== 'number' || typeof y !== 'number') {
        return res.status(400).json({ error: 'tokenId, x, y required' });
      }
      const result = this._moveToken(tokenId, x, y);
      if (!result) return res.status(404).json({ error: 'Token not found' });
      res.json(result);
    });

    // POST /api/map/token/add — add a new token to the map
    // body: { tokenId, name, type, x, y, image, visible, hp, ac }
    app.post('/api/map/token/add', (req, res) => {
      const { tokenId, name, type, x, y } = req.body || {};
      if (!tokenId) return res.status(400).json({ error: 'tokenId required' });

      const token = {
        id: tokenId,
        name: name || tokenId,
        type: type || 'npc',
        x: x || 280,
        y: y || 350,
        image: req.body.image || `${tokenId}.webp`,
        visible: req.body.visible !== false,
        hidden: req.body.hidden || false,
        hp: req.body.hp || { current: 10, max: 10 },
        ac: req.body.ac || 10
      };

      this.state.set(`map.tokens.${tokenId}`, token);
      this.bus.dispatch('map:token_added', { token });
      res.json(token);
    });

    // DELETE /api/map/token/:tokenId — remove a token
    app.delete('/api/map/token/:tokenId', (req, res) => {
      const tokens = this.state.get('map.tokens') || {};
      if (!tokens[req.params.tokenId]) {
        return res.status(404).json({ error: 'Token not found' });
      }
      delete tokens[req.params.tokenId];
      this.state.set('map.tokens', tokens);
      this.bus.dispatch('map:token_removed', { tokenId: req.params.tokenId });
      res.json({ removed: req.params.tokenId });
    });

    // POST /api/map/token/visibility — show/hide a token
    // body: { tokenId, visible }
    app.post('/api/map/token/visibility', (req, res) => {
      const { tokenId, visible } = req.body || {};
      if (!tokenId) return res.status(400).json({ error: 'tokenId required' });

      const token = this.state.get(`map.tokens.${tokenId}`);
      if (!token) return res.status(404).json({ error: 'Token not found' });

      this.state.set(`map.tokens.${tokenId}.visible`, !!visible);
      this.state.set(`map.tokens.${tokenId}.hidden`, !visible);
      this.bus.dispatch('map:token_visibility', { tokenId, visible: !!visible });
      res.json({ tokenId, visible: !!visible });
    });

    // POST /api/map/zone/reveal — reveal or hide a zone
    // body: { zoneId, revealed }
    app.post('/api/map/zone/reveal', (req, res) => {
      const { zoneId, revealed } = req.body || {};
      if (!zoneId) return res.status(400).json({ error: 'zoneId required' });

      const zones = this.state.get('map.zones') || [];
      const idx = zones.findIndex(z => z.id === zoneId);
      if (idx === -1) return res.status(404).json({ error: 'Zone not found' });

      zones[idx].revealed = revealed !== false;
      this.state.set('map.zones', zones);
      this.bus.dispatch('map:zone_revealed', { zoneId, revealed: zones[idx].revealed });
      console.log(`[MapService] Zone ${zoneId} ${zones[idx].revealed ? 'revealed' : 'hidden'}`);
      res.json({ zoneId, revealed: zones[idx].revealed });
    });

    // POST /api/map/zone/reveal-all — reveal or hide all zones
    // body: { revealed }
    app.post('/api/map/zone/reveal-all', (req, res) => {
      const { revealed } = req.body || {};
      const zones = this.state.get('map.zones') || [];
      zones.forEach(z => z.revealed = revealed !== false);
      this.state.set('map.zones', zones);
      this.bus.dispatch('map:zones_all_revealed', { revealed: revealed !== false });
      console.log(`[MapService] All zones ${revealed !== false ? 'revealed' : 'hidden'}`);
      res.json({ revealed: revealed !== false, count: zones.length });
    });

    // POST /api/map/save — save a new or updated map definition
    // body: { id, name, image, gridSize, width, height, zones, tokens, playerSpawns }
    app.post('/api/map/save', (req, res) => {
      const mapData = req.body;
      if (!mapData.id || !mapData.name) return res.status(400).json({ error: 'id and name required' });

      const mapsDir = path.join(__dirname, '..', '..', 'config', 'maps');
      try {
        fs.mkdirSync(mapsDir, { recursive: true });
        fs.writeFileSync(
          path.join(mapsDir, `${mapData.id}.json`),
          JSON.stringify(mapData, null, 2)
        );
        this.maps.set(mapData.id, mapData);
        console.log(`[MapService] Saved map: ${mapData.name} (${mapData.id})`);
        res.json({ saved: mapData.id });
      } catch(e) {
        console.error(`[MapService] Save failed: ${e.message}`);
        res.status(500).json({ error: e.message });
      }
    });

    // POST /api/map/save-state — snapshot current token positions back to map file
    app.post('/api/map/save-state', (req, res) => {
      if (!this.activeMapId) return res.status(400).json({ error: 'No active map' });
      const mapDef = this.maps.get(this.activeMapId);
      if (!mapDef) return res.status(404).json({ error: 'Map not found' });

      const tokens = this.state.get('map.tokens') || {};
      const zones = this.state.get('map.zones') || [];

      // Update map definition with current positions and zone states
      mapDef.tokens = {};
      for (const [id, tok] of Object.entries(tokens)) {
        mapDef.tokens[id] = { ...tok };
        delete mapDef.tokens[id].id; // id is the key
      }
      mapDef.zones = zones;

      const mapsDir = path.join(__dirname, '..', '..', 'config', 'maps');
      try {
        fs.writeFileSync(
          path.join(mapsDir, `${this.activeMapId}.json`),
          JSON.stringify(mapDef, null, 2)
        );
        this.maps.set(this.activeMapId, mapDef);
        console.log(`[MapService] State saved to ${this.activeMapId}`);
        res.json({ saved: this.activeMapId });
      } catch(e) {
        res.status(500).json({ error: e.message });
      }
    });

    // POST /api/map/upload — upload a map image
    const multer = require('multer');
    const upload = multer({
      storage: multer.diskStorage({
        destination: path.join(__dirname, '..', '..', 'assets', 'maps'),
        filename: (req, file, cb) => cb(null, file.originalname)
      }),
      limits: { fileSize: 50 * 1024 * 1024 }
    });
    app.post('/api/map/upload', upload.single('mapImage'), (req, res) => {
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
      console.log(`[MapService] Uploaded map image: ${req.file.originalname} (${Math.round(req.file.size/1024)}KB)`);
      res.json({ filename: req.file.originalname, size: req.file.size });
    });

    // DELETE /api/map/:mapId — delete a map
    app.delete('/api/map/:mapId', (req, res) => {
      const { mapId } = req.params;
      if (mapId === this.activeMapId) return res.status(400).json({ error: 'Cannot delete active map' });
      const mapsDir = path.join(__dirname, '..', '..', 'config', 'maps');
      try {
        const filePath = path.join(mapsDir, `${mapId}.json`);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        this.maps.delete(mapId);
        res.json({ deleted: mapId });
      } catch(e) {
        res.status(500).json({ error: e.message });
      }
    });

    // === ACTOR / COMPENDIUM ROUTES ===

    // GET /api/actors/search?q=werewolf&cr=3&type=beast
    app.get('/api/actors/search', (req, res) => {
      const q = (req.query.q || '').toLowerCase();
      const cr = req.query.cr || '';
      const type = (req.query.type || '').toLowerCase();
      const limit = parseInt(req.query.limit) || 30;

      // Custom actors first, then SRD
      let results = [];

      // Custom actors always included if they match
      for (const [slug, actor] of this.customActors) {
        if (q && !actor.name.toLowerCase().includes(q) && !slug.includes(q)) continue;
        if (cr && actor.challenge_rating !== cr) continue;
        if (type && !actor.type?.toLowerCase().includes(type)) continue;
        results.push({ ...actor, custom: true });
      }

      // SRD monsters
      for (const m of this.srdMonsters) {
        if (q && !m.name.toLowerCase().includes(q) && !(m.slug||'').includes(q)) continue;
        if (cr && m.challenge_rating !== cr) continue;
        if (type && !m.type?.toLowerCase().includes(type)) continue;
        results.push(m);
        if (results.length >= limit) break;
      }

      res.json(results);
    });

    // GET /api/actors/:slug — get full stat block
    app.get('/api/actors/:slug', (req, res) => {
      const { slug } = req.params;
      const custom = this.customActors.get(slug);
      if (custom) return res.json(custom);
      const srd = this.srdMonsters.find(m => m.slug === slug);
      if (srd) return res.json(srd);
      res.status(404).json({ error: 'Actor not found' });
    });

    // POST /api/actors/save — save custom actor
    app.post('/api/actors/save', (req, res) => {
      const actor = req.body;
      if (!actor.slug || !actor.name) return res.status(400).json({ error: 'slug and name required' });
      actor.custom = true;

      const actorsDir = path.join(__dirname, '..', '..', 'config', 'actors');
      try {
        fs.mkdirSync(actorsDir, { recursive: true });
        fs.writeFileSync(path.join(actorsDir, `${actor.slug}.json`), JSON.stringify(actor, null, 2));
        this.customActors.set(actor.slug, actor);
        console.log(`[MapService] Saved custom actor: ${actor.name}`);
        res.json({ saved: actor.slug });
      } catch(e) {
        res.status(500).json({ error: e.message });
      }
    });

    // POST /api/actors/place — place actor on map as token
    app.post('/api/actors/place', (req, res) => {
      const { slug, name, x, y, visible } = req.body || {};
      if (!slug) return res.status(400).json({ error: 'slug required' });

      const actor = this.customActors.get(slug) || this.srdMonsters.find(m => m.slug === slug);
      if (!actor) return res.status(404).json({ error: 'Actor not found' });

      const tokenId = slug + '-' + Date.now().toString(36);
      const gs = this.state.get('map.gridSize') || 70;
      const mapW = this.state.get('map.width') || 1400;
      const mapH = this.state.get('map.height') || 1050;

      const token = {
        id: tokenId,
        name: name || actor.name,
        type: 'npc',
        x: x || Math.floor(mapW / 2 / gs) * gs + gs / 2,
        y: y || Math.floor(mapH / 2 / gs) * gs + gs / 2,
        image: `${slug}.png`,
        visible: visible !== false,
        hidden: visible === false,
        hp: { current: actor.hit_points || 10, max: actor.hit_points || 10 },
        ac: actor.armor_class || 10,
        actorSlug: slug
      };

      this.state.set(`map.tokens.${tokenId}`, token);
      this.bus.dispatch('map:token_added', { token });
      console.log(`[MapService] Placed ${actor.name} on map as ${tokenId}`);
      res.json(token);
    });

    // Serve map assets
    const assetsDir = path.join(__dirname, '..', '..', 'assets');
    const express = require('express');
    app.use('/assets', express.static(assetsDir));
  }

  _moveToken(tokenId, x, y) {
    const token = this.state.get(`map.tokens.${tokenId}`);
    if (!token) return null;

    // Snap to grid
    const mapDef = this.maps.get(this.activeMapId);
    const grid = mapDef?.gridSize || 70;
    const half = grid / 2;
    const snappedX = Math.floor((x - half) / grid) * grid + half;
    const snappedY = Math.floor((y - half) / grid) * grid + half;

    const oldX = token.x;
    const oldY = token.y;

    this.state.set(`map.tokens.${tokenId}.x`, snappedX);
    this.state.set(`map.tokens.${tokenId}.y`, snappedY);

    // Check if token entered a new zone
    const zone = this._getZoneAt(snappedX, snappedY);
    const oldZone = this._getZoneAt(oldX, oldY);
    if (zone?.id !== oldZone?.id) {
      this.bus.dispatch('map:zone_enter', {
        tokenId,
        zone: zone || null,
        previousZone: oldZone || null
      });
    }

    this.bus.dispatch('map:token_moved', {
      tokenId,
      x: snappedX,
      y: snappedY,
      oldX,
      oldY
    });

    return { tokenId, x: snappedX, y: snappedY };
  }

  _getZoneAt(x, y) {
    const mapDef = this.maps.get(this.activeMapId);
    if (!mapDef?.zones) return null;
    for (const zone of mapDef.zones) {
      if (x >= zone.x && x < zone.x + zone.w && y >= zone.y && y < zone.y + zone.h) {
        return zone;
      }
    }
    return null;
  }

  _setupEventListeners() {
    // When HP updates, sync to map token
    this.bus.subscribe('hp:update', (env) => {
      const { playerId, current, max } = env.data;
      const token = this.state.get(`map.tokens.${playerId}`);
      if (token) {
        this.state.set(`map.tokens.${playerId}.hp`, { current, max });
      }
    }, 'map');

    // When a new player connects, add their token if not present
    this.bus.subscribe('player:connected', (env) => {
      const { playerId } = env.data;
      if (!this.activeMapId) return;
      const existing = this.state.get(`map.tokens.${playerId}`);
      if (existing) return;

      const mapDef = this.maps.get(this.activeMapId);
      const tokens = this.state.get('map.tokens') || {};
      const pcCount = Object.values(tokens).filter(t => t.type === 'pc').length;
      const spawns = mapDef?.playerSpawns?.spread || [];
      const spawn = spawns[pcCount] || mapDef?.playerSpawns?.default || { x: 280, y: 350 };

      const charData = this.state.get(`players.${playerId}.character`) || {};
      const token = {
        id: playerId,
        name: charData.name || playerId,
        type: 'pc',
        x: spawn.x,
        y: spawn.y,
        image: `${playerId}.webp`,
        visible: true,
        hp: charData.hp || { current: 20, max: 20 },
        ac: charData.ac || 10
      };

      this.state.set(`map.tokens.${playerId}`, token);
      this.bus.dispatch('map:token_added', { token });
      console.log(`[MapService] Added token for player ${playerId}`);
    }, 'map');

    // Character assignment updates token name/HP
    this.bus.subscribe('characters:imported', () => this._syncPlayerTokens(), 'map');
    this.bus.subscribe('characters:reloaded', () => this._syncPlayerTokens(), 'map');
  }

  _syncPlayerTokens() {
    if (!this.activeMapId) return;
    const players = this.state.get('players') || {};
    for (const [playerId, pData] of Object.entries(players)) {
      const token = this.state.get(`map.tokens.${playerId}`);
      if (!token || token.type !== 'pc') continue;
      if (pData.character?.name) {
        this.state.set(`map.tokens.${playerId}.name`, pData.character.name);
      }
      if (pData.character?.hp) {
        this.state.set(`map.tokens.${playerId}.hp`, pData.character.hp);
      }
    }
  }

  async stop() {
    console.log('[MapService] Stopped');
  }

  getStatus() {
    return {
      status: 'running',
      activeMap: this.activeMapId,
      mapCount: this.maps.size,
      tokenCount: Object.keys(this.state.get('map.tokens') || {}).length
    };
  }
}

module.exports = MapService;
