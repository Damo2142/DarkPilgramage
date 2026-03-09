const fs = require('fs');
const path = require('path');

class MapService {
  constructor() {
    this.name = 'map';
    this.orchestrator = null;
    this.maps = new Map();       // mapId -> map definition
    this.activeMapId = null;
  }

  async init(orchestrator) {
    this.orchestrator = orchestrator;
    this.bus = orchestrator.bus;
    this.state = orchestrator.state;
    this.config = orchestrator.config;
  }

  async start() {
    this._loadMaps();
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

    // Store in state manager
    this.state.set('map', {
      id: map.id,
      name: map.name,
      image: map.image,
      gridSize: map.gridSize,
      width: map.width,
      height: map.height,
      zones: map.zones || []
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
          zones: mapDef.zones || []
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
    const snappedX = Math.round(x / grid) * grid;
    const snappedY = Math.round(y / grid) * grid;

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
