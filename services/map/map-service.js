const fs = require('fs');
const path = require('path');

class MapService {
  constructor() {
    this.name = 'map';
    this.orchestrator = null;
    this.maps = new Map();       // mapId -> map definition
    this.activeMapId = null;
    this.playerMapAssignment = {};  // playerId -> mapId (which floor each player is on)
    this.srdMonsters = [];       // SRD compendium
    this.srdEquipment = [];      // SRD equipment
    this.srdSpells = [];         // SRD spells
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
    this._loadEquipment();
    this._loadSpells();
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

  _loadEquipment() {
    const filePath = path.join(__dirname, '..', '..', 'config', 'srd-equipment.json');
    if (!fs.existsSync(filePath)) { console.log('[MapService] No SRD equipment found'); return; }
    try {
      this.srdEquipment = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      console.log(`[MapService] SRD equipment: ${this.srdEquipment.length} items`);
    } catch(e) { console.warn('[MapService] Failed to load SRD equipment:', e.message); }
  }

  _loadSpells() {
    const filePath = path.join(__dirname, '..', '..', 'config', 'srd-spells.json');
    if (!fs.existsSync(filePath)) { console.log('[MapService] No SRD spells found'); return; }
    try {
      this.srdSpells = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      console.log(`[MapService] SRD spells: ${this.srdSpells.length} spells`);
    } catch(e) { console.warn('[MapService] Failed to load SRD spells:', e.message); }
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

    // Place only players assigned to THIS map at spawn points
    // If no assignments exist yet (first load), assign all players to this map
    const players = this.state.get('players') || {};
    const hasAnyAssignment = Object.keys(this.playerMapAssignment).length > 0;
    const spawns = map.playerSpawns?.spread || [];
    let spawnIdx = 0;
    for (const playerId of Object.keys(players)) {
      // Only add player token if they're assigned to this map (or no assignments yet)
      const assignedMap = this.playerMapAssignment[playerId];
      if (!hasAnyAssignment || assignedMap === mapId) {
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
        // Track assignment
        this.playerMapAssignment[playerId] = mapId;
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
      zones,
      walls: (map.walls || []).filter(w => w.x1 !== null),
      lights: map.lights || []
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
          zones: this.state.get('map.zones') || mapDef.zones || [],
          walls: this.state.get('map.walls') || (mapDef.walls || []).filter(w => w.x1 !== null),
          lights: mapDef.lights || []
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

    // POST /api/map/floor-transition — move tokens to another map (Feature 71)
    app.post('/api/map/floor-transition', (req, res) => {
      const { targetMapId, tokenIds, spawnPoint } = req.body;
      if (!targetMapId) return res.status(400).json({ error: 'targetMapId required' });
      const result = this.transitionFloor(targetMapId, tokenIds, spawnPoint);
      if (result.error) return res.status(404).json(result);
      res.json(result);
    });

    // GET /api/map/floor-links — get zones that link to other maps
    app.get('/api/map/floor-links', (req, res) => {
      res.json(this.getFloorLinks());
    });

    // GET /api/map/player-assignments — which map each player is on
    app.get('/api/map/player-assignments', (req, res) => {
      res.json(this.playerMapAssignment);
    });

    // POST /api/map/player-assignment — assign a player to a map
    // body: { playerId, mapId }
    app.post('/api/map/player-assignment', (req, res) => {
      const { playerId, mapId } = req.body || {};
      if (!playerId || !mapId) return res.status(400).json({ error: 'playerId and mapId required' });
      this.playerMapAssignment[playerId] = mapId;

      // Push the target map's full state to the player
      const targetMap = this.maps.get(mapId);
      if (targetMap) {
        // Build map state matching what loadFromState expects
        const mapState = {
          id: mapId,
          name: targetMap.name,
          image: targetMap.image,
          gridSize: targetMap.gridSize || 70,
          width: targetMap.width || 1400,
          height: targetMap.height || 1050,
          walls: targetMap.walls || [],
          lights: targetMap.lights || [],
          zones: targetMap.zones || [],
          tokens: {}
        };
        // Include tokens from the target map's definition (these aren't in state if DM is on a different map)
        if (targetMap.tokens) {
          for (const [tid, tok] of Object.entries(targetMap.tokens)) {
            if (!tok.hidden) {
              mapState.tokens[tid] = tok.type === 'npc' ? { ...tok, name: 'Unknown' } : tok;
            }
          }
        }
        // Include tokens from state that are assigned to this map
        const allTokens = this.state.get('map.tokens') || {};
        for (const [tid, tok] of Object.entries(allTokens)) {
          const tokMap = this.playerMapAssignment[tid] || this.activeMapId;
          if (tokMap === mapId && !tok.hidden) {
            mapState.tokens[tid] = tok.type === 'npc' ? { ...tok, name: 'Unknown' } : tok;
          }
        }
        // Ensure the player's own token is included
        if (!mapState.tokens[playerId]) {
          // Check state first, then map def
          const stateTok = allTokens[playerId];
          const mapTok = targetMap.tokens?.[playerId];
          if (stateTok) mapState.tokens[playerId] = stateTok;
          else if (mapTok) mapState.tokens[playerId] = mapTok;
        }
        this.bus.dispatch('map:player_map_change', { playerId, mapState });
        console.log(`[MapService] Pushed map ${mapId} (${targetMap.name}) to player ${playerId} — ${mapState.walls.length} walls, ${mapState.lights.length} lights`);
      }

      res.json({ playerId, mapId });
    });

    // GET /api/map/walls — get walls for active map
    app.get('/api/map/walls', (req, res) => {
      if (!this.activeMapId) return res.json([]);
      const mapDef = this.maps.get(this.activeMapId);
      res.json(mapDef?.walls || []);
    });

    // POST /api/map/walls/toggle-door — open/close a door
    // body: { index, playerId? (for lock picking), dmOverride? }
    app.post('/api/map/walls/toggle-door', (req, res) => {
      if (!this.activeMapId) return res.status(400).json({ error: 'No active map' });
      const mapDef = this.maps.get(this.activeMapId);
      if (!mapDef?.walls) return res.status(404).json({ error: 'No walls' });

      const { index, playerId, dmOverride } = req.body;
      if (index == null || !mapDef.walls[index]) return res.status(400).json({ error: 'Invalid wall index' });

      const wall = mapDef.walls[index];
      if (wall.type !== 'door') return res.status(400).json({ error: 'Not a door' });

      // If door is locked and player is trying to open (not DM override)
      if (wall.locked && wall.lockDC && !wall.open && !dmOverride) {
        if (!playerId) {
          return res.json({ index, locked: true, lockDC: wall.lockDC, message: 'Door is locked (DC ' + wall.lockDC + ')' });
        }
        // Auto-roll thieves' tools / sleight-of-hand check
        const charData = this.state.get(`players.${playerId}.character`);
        const skillData = charData?.skills?.['sleight-of-hand'];
        const modifier = skillData ? skillData.modifier : 0;
        const roll = Math.floor(Math.random() * 20) + 1;
        const total = roll + modifier;
        const success = total >= wall.lockDC;
        const modStr = modifier >= 0 ? '+' + modifier : '' + modifier;

        this.bus.dispatch('dm:whisper', {
          text: `${charData?.name || playerId} picks lock DC${wall.lockDC}: d20(${roll}) ${modStr} = ${total} — ${success ? 'SUCCESS' : 'FAIL'}`,
          priority: 2, category: 'rules'
        });

        if (success) {
          wall.locked = false;
          wall.open = true;
          // Broadcast updated walls for dynamic lighting
          this.state.set('map.walls', mapDef.walls.filter(w => w.x1 !== null));
          this.bus.dispatch('dm:private_message', {
            playerId, text: 'You pick the lock! The door opens.', durationMs: 4000
          });
          // Notify nearby players they hear the door
          this._notifyNearDoor(wall, mapDef, playerId);
          return res.json({ index, open: true, unlocked: true, roll, total, dc: wall.lockDC });
        } else {
          this.bus.dispatch('dm:private_message', {
            playerId, text: 'The lock holds firm.', durationMs: 3000
          });
          // Nearby players might hear the failed attempt (rattling)
          this._notifyNearDoor(wall, mapDef, playerId, true);
          return res.json({ index, open: false, unlocked: false, roll, total, dc: wall.lockDC });
        }
      }

      // Normal toggle (unlocked or DM override)
      if (dmOverride && wall.locked) wall.locked = false;
      wall.open = !wall.open;
      console.log(`[MapService] Door ${index} ${wall.open ? 'opened' : 'closed'}`);

      // Broadcast updated walls for dynamic lighting
      this.state.set('map.walls', mapDef.walls.filter(w => w.x1 !== null));

      // Notify nearby players (within hearing range of the door)
      this._notifyNearDoor(wall, mapDef);

      res.json({ index, open: wall.open });
    });

    // POST /api/map/walls — save walls for active map
    app.post('/api/map/walls', (req, res) => {
      if (!this.activeMapId) return res.status(400).json({ error: 'No active map' });
      const mapDef = this.maps.get(this.activeMapId);
      if (!mapDef) return res.status(404).json({ error: 'Map not found' });

      mapDef.walls = req.body.walls || [];
      // Persist to file
      const mapsDir = path.join(__dirname, '..', '..', 'config', 'maps');
      try {
        fs.writeFileSync(path.join(mapsDir, `${this.activeMapId}.json`), JSON.stringify(mapDef, null, 2));
        this.maps.set(this.activeMapId, mapDef);
        // Broadcast updated walls for dynamic lighting
        this.state.set('map.walls', mapDef.walls.filter(w => w.x1 !== null));
        console.log(`[MapService] Saved ${mapDef.walls.length} walls to ${this.activeMapId}`);
        res.json({ saved: mapDef.walls.length });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    // DELETE /api/map/:mapId — delete a map config and optionally its image
    app.delete('/api/map/:mapId', (req, res) => {
      const mapId = req.params.mapId;
      const mapDef = this.maps.get(mapId);
      if (!mapDef) return res.status(404).json({ error: 'Map not found' });

      // Remove config file
      const configPath = path.join(__dirname, '..', '..', 'config', 'maps', `${mapId}.json`);
      if (fs.existsSync(configPath)) fs.unlinkSync(configPath);

      // Remove image if it exists
      if (mapDef.image) {
        const imgPath = path.join(__dirname, '..', '..', 'assets', 'maps', mapDef.image);
        if (fs.existsSync(imgPath)) fs.unlinkSync(imgPath);
      }

      this.maps.delete(mapId);

      // If this was the active map, deactivate
      if (this.activeMapId === mapId) {
        this.activeMapId = null;
        this.state.set('map', null);
        this.bus.dispatch('map:unloaded', { mapId });
      }

      console.log(`[MapService] Deleted map: ${mapDef.name} (${mapId})`);
      res.json({ deleted: mapId, name: mapDef.name });
    });

    // POST /api/map/token/move — move a token
    // body: { tokenId, x, y }
    app.post('/api/map/token/move', (req, res) => {
      const { tokenId, x, y, force } = req.body || {};
      if (!tokenId || typeof x !== 'number' || typeof y !== 'number') {
        return res.status(400).json({ error: 'tokenId, x, y required' });
      }
      const result = this._moveToken(tokenId, x, y, { force: force !== false });
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

    // POST /api/map/token/reveal-to-players — toggle whether players see this NPC token on /table
    // body: { tokenId, revealed }
    app.post('/api/map/token/reveal-to-players', (req, res) => {
      const { tokenId, revealed } = req.body || {};
      if (!tokenId) return res.status(400).json({ error: 'tokenId required' });
      const token = this.state.get(`map.tokens.${tokenId}`);
      if (!token) return res.status(404).json({ error: 'Token not found' });
      this.state.set(`map.tokens.${tokenId}.revealedToPlayers`, !!revealed);
      this.bus.dispatch('map:token_reveal_changed', { tokenId, revealed: !!revealed });
      res.json({ tokenId, revealedToPlayers: !!revealed });
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

    // POST /api/map/zone/add — create a new zone (rect or polygon)
    // body: { name, x, y, w, h } for rect OR { name, points: [{x,y},...] } for polygon
    app.post('/api/map/zone/add', (req, res) => {
      const { name, x, y, w, h, points } = req.body || {};
      if (!name) return res.status(400).json({ error: 'name required' });
      if (!points && (x == null || y == null || w == null || h == null)) {
        return res.status(400).json({ error: 'name + (x,y,w,h) or (points) required' });
      }
      const zones = this.state.get('map.zones') || [];
      const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '');
      let zone;
      if (points && Array.isArray(points) && points.length >= 3) {
        zone = { id, name, points, revealed: false };
        console.log(`[MapService] Polygon zone added: ${name} (${points.length} vertices)`);
      } else {
        zone = { id, name, x, y, w, h, revealed: false };
        console.log(`[MapService] Zone added: ${name} (${w}x${h} at ${x},${y})`);
      }
      zones.push(zone);
      this.state.set('map.zones', zones);
      this.bus.dispatch('map:zone_added', zone);
      res.json(zone);
    });

    // DELETE /api/map/zone/:zoneId — remove a zone
    app.delete('/api/map/zone/:zoneId', (req, res) => {
      const zones = this.state.get('map.zones') || [];
      const idx = zones.findIndex(z => z.id === req.params.zoneId);
      if (idx === -1) return res.status(404).json({ error: 'Zone not found' });
      const removed = zones.splice(idx, 1)[0];
      this.state.set('map.zones', zones);
      this.bus.dispatch('map:zone_removed', removed);
      console.log(`[MapService] Zone removed: ${removed.name}`);
      res.json({ removed: removed.id });
    });

    // === LIGHT MANAGEMENT ===

    // POST /api/map/light/add — add a light source
    app.post('/api/map/light/add', (req, res) => {
      const { x, y, range, color } = req.body || {};
      if (x == null || y == null) return res.status(400).json({ error: 'x, y required' });
      const lights = this.state.get('map.lights') || [];
      const light = { x, y, range: range || 700, color: color || 'ffeccd8b' };
      lights.push(light);
      this.state.set('map.lights', lights);
      // Also update map definition
      const mapDef = this.maps.get(this.activeMapId);
      if (mapDef) mapDef.lights = lights;
      this.bus.dispatch('map:light_added', { light, index: lights.length - 1 });
      res.json({ index: lights.length - 1, light });
    });

    // POST /api/map/light/update — update a light source
    app.post('/api/map/light/update', (req, res) => {
      const { index, x, y, range, color, enabled } = req.body || {};
      if (index == null) return res.status(400).json({ error: 'index required' });
      const lights = this.state.get('map.lights') || [];
      if (index < 0 || index >= lights.length) return res.status(404).json({ error: 'Light not found' });
      if (x != null) lights[index].x = x;
      if (y != null) lights[index].y = y;
      if (range != null) lights[index].range = range;
      if (color != null) lights[index].color = color;
      if (enabled !== undefined) lights[index].enabled = enabled;
      this.state.set('map.lights', lights);
      const mapDef = this.maps.get(this.activeMapId);
      if (mapDef) mapDef.lights = lights;
      res.json({ index, light: lights[index] });
    });

    // DELETE /api/map/light/:index — remove a light
    app.delete('/api/map/light/:index', (req, res) => {
      const index = parseInt(req.params.index);
      const lights = this.state.get('map.lights') || [];
      if (isNaN(index) || index < 0 || index >= lights.length) return res.status(404).json({ error: 'Light not found' });
      const removed = lights.splice(index, 1)[0];
      this.state.set('map.lights', lights);
      const mapDef = this.maps.get(this.activeMapId);
      if (mapDef) mapDef.lights = lights;
      res.json({ removed, remaining: lights.length });
    });

    // POST /api/map/lights/save — persist lights to map file
    app.post('/api/map/lights/save', (req, res) => {
      if (!this.activeMapId) return res.status(400).json({ error: 'No active map' });
      const mapDef = this.maps.get(this.activeMapId);
      if (!mapDef) return res.status(404).json({ error: 'Map not found' });
      const lights = this.state.get('map.lights') || [];
      mapDef.lights = lights;
      const mapsDir = path.join(__dirname, '..', '..', 'config', 'maps');
      try {
        fs.writeFileSync(path.join(mapsDir, `${this.activeMapId}.json`), JSON.stringify(mapDef, null, 2));
        this.maps.set(this.activeMapId, mapDef);
        console.log(`[MapService] Saved ${lights.length} lights to ${this.activeMapId}`);
        res.json({ saved: lights.length });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
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

      // Save lights from state
      const lights = this.state.get('map.lights');
      if (lights) mapDef.lights = lights;

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

    // GET /api/actors/named — list all custom/named NPC actors
    app.get('/api/actors/named', (req, res) => {
      const actors = [];
      for (const [slug, actor] of this.customActors) {
        actors.push({ slug, name: actor.name, challenge_rating: actor.challenge_rating, type: actor.type || '', custom: true });
      }
      actors.sort((a, b) => a.name.localeCompare(b.name));
      res.json(actors);
    });

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

    // POST /api/actors/place-all — place all custom actors on map in a grid layout
    app.post('/api/actors/place-all', (req, res) => {
      const gs = this.state.get('map.gridSize') || 70;
      const mapW = this.state.get('map.width') || 1400;
      const mapH = this.state.get('map.height') || 1050;
      const existing = this.state.get('map.tokens') || {};

      // Get all custom actors not already on the map
      const actors = [];
      for (const [slug, actor] of this.customActors) {
        const alreadyPlaced = Object.values(existing).some(t => t.actorSlug === slug);
        if (!alreadyPlaced) actors.push({ slug, actor });
      }

      if (!actors.length) return res.json({ placed: [], message: 'All actors already on map' });

      // Place in a grid starting from top-left, spaced by grid size
      const cols = Math.max(1, Math.floor(mapW / gs) - 1);
      const placed = [];
      actors.forEach(({ slug, actor }, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const x = (col + 1) * gs + gs / 2;
        const y = (row + 1) * gs + gs / 2;
        const tokenId = slug + '-' + Date.now().toString(36) + i;
        const token = {
          id: tokenId, name: actor.name, type: 'npc',
          x, y, image: `${slug}.png`,
          visible: true, hidden: false,
          hp: { current: actor.hit_points || 10, max: actor.hit_points || 10 },
          ac: actor.armor_class || 10,
          actorSlug: slug
        };
        this.state.set(`map.tokens.${tokenId}`, token);
        this.bus.dispatch('map:token_added', { token });
        placed.push(token.name);
      });

      console.log(`[MapService] Placed ${placed.length} actors on map`);
      res.json({ placed, count: placed.length });
    });

    // POST /api/map/import-dd2vtt — import a Dungeondraft .dd2vtt (Universal VTT) file
    // Extracts the embedded PNG, creates map config, and registers the map
    const importUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });
    app.post('/api/map/import-dd2vtt', importUpload.single('dd2vtt'), (req, res) => {
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

      try {
        const dd2vtt = JSON.parse(req.file.buffer.toString('utf8'));
        const resolution = dd2vtt.resolution || {};
        const mapSize = resolution.map_size || { x: 20, y: 20 };
        const ppg = resolution.pixels_per_grid || 140;

        // Derive map ID from filename
        const baseName = path.basename(req.file.originalname, path.extname(req.file.originalname));
        const mapId = (req.body.mapId || baseName).replace(/[^a-z0-9-]/gi, '-').toLowerCase();
        const mapName = req.body.mapName || baseName.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

        // Extract and save the embedded PNG image
        if (!dd2vtt.image) return res.status(400).json({ error: 'No image data in dd2vtt file' });
        const imgBuffer = Buffer.from(dd2vtt.image, 'base64');
        const imgFilename = `${mapId}.png`;
        const imgPath = path.join(__dirname, '..', '..', 'assets', 'maps', imgFilename);
        fs.mkdirSync(path.dirname(imgPath), { recursive: true });
        fs.writeFileSync(imgPath, imgBuffer);
        console.log(`[MapService] Extracted map image: ${imgFilename} (${Math.round(imgBuffer.length / 1024)}KB)`);

        // Build map config
        const gridSize = ppg;
        const widthPx = Math.round(mapSize.x * ppg);
        const heightPx = Math.round(mapSize.y * ppg);

        // Convert line_of_sight walls (grid coords → pixel coords)
        const walls = [];
        if (Array.isArray(dd2vtt.line_of_sight)) {
          for (let i = 0; i < dd2vtt.line_of_sight.length - 1; i += 2) {
            const p1 = dd2vtt.line_of_sight[i];
            const p2 = dd2vtt.line_of_sight[i + 1];
            if (p1 && p2) {
              walls.push({
                x1: Math.round(p1.x * ppg), y1: Math.round(p1.y * ppg),
                x2: Math.round(p2.x * ppg), y2: Math.round(p2.y * ppg)
              });
            }
          }
        }

        // Convert lights (grid coords → pixel coords)
        const lights = [];
        if (Array.isArray(dd2vtt.lights)) {
          for (const light of dd2vtt.lights) {
            lights.push({
              x: Math.round(light.position.x * ppg),
              y: Math.round(light.position.y * ppg),
              range: Math.round(light.range * ppg),
              color: light.color || '#fff5e0'
            });
          }
        }

        // Convert portals/doors (grid coords → pixel coords)
        const portals = [];
        if (Array.isArray(dd2vtt.portals)) {
          for (const portal of dd2vtt.portals) {
            portals.push({
              x: Math.round(portal.position.x * ppg),
              y: Math.round(portal.position.y * ppg),
              closed: portal.closed || false,
              bounds: (portal.bounds || []).map(p => ({
                x: Math.round(p.x * ppg),
                y: Math.round(p.y * ppg)
              }))
            });
          }
        }

        const mapDef = {
          id: mapId,
          name: mapName,
          image: imgFilename,
          gridSize,
          width: widthPx,
          height: heightPx,
          source: 'dungeondraft',
          dd2vttFormat: dd2vtt.format || null,
          walls,
          lights,
          portals,
          zones: [],
          tokens: {},
          playerSpawns: {
            default: { x: Math.round(widthPx / 2 / gridSize) * gridSize + gridSize / 2, y: Math.round(heightPx / 2 / gridSize) * gridSize + gridSize / 2 }
          }
        };

        // Save map config
        const mapsDir = path.join(__dirname, '..', '..', 'config', 'maps');
        fs.mkdirSync(mapsDir, { recursive: true });
        fs.writeFileSync(path.join(mapsDir, `${mapId}.json`), JSON.stringify(mapDef, null, 2));
        this.maps.set(mapId, mapDef);

        console.log(`[MapService] Imported dd2vtt: ${mapName} (${mapSize.x}x${mapSize.y} grid, ${walls.length} walls, ${lights.length} lights, ${portals.length} portals)`);
        res.json({
          mapId,
          name: mapName,
          image: imgFilename,
          gridSize,
          width: widthPx,
          height: heightPx,
          walls: walls.length,
          lights: lights.length,
          portals: portals.length
        });
      } catch (e) {
        console.error(`[MapService] dd2vtt import failed:`, e.message);
        res.status(400).json({ error: `Import failed: ${e.message}` });
      }
    });

    // === EQUIPMENT / SRD ITEM ROUTES ===

    // GET /api/equipment/search?q=longsword&type=weapon
    app.get('/api/equipment/search', (req, res) => {
      const q = (req.query.q || '').toLowerCase();
      const type = (req.query.type || '').toLowerCase();
      const limit = parseInt(req.query.limit) || 50;

      let results = this.srdEquipment.filter(item => {
        if (q && !item.name.toLowerCase().includes(q)) return false;
        if (type && item.type !== type && item.subtype !== type) return false;
        return true;
      });

      res.json(results.slice(0, limit));
    });

    // GET /api/equipment/:name — get full item data by exact name
    app.get('/api/equipment/:name', (req, res) => {
      const name = decodeURIComponent(req.params.name).toLowerCase();
      const item = this.srdEquipment.find(i => i.name.toLowerCase() === name);
      if (!item) return res.status(404).json({ error: 'Item not found' });
      res.json(item);
    });

    // === SPELL ROUTES ===

    // GET /api/spells/search?q=fireball&level=3&class=Wizard
    app.get('/api/spells/search', (req, res) => {
      const q = (req.query.q || '').toLowerCase();
      const level = req.query.level != null ? parseInt(req.query.level) : null;
      const cls = (req.query.class || '').toLowerCase();
      const limit = parseInt(req.query.limit) || 50;

      let results = this.srdSpells.filter(spell => {
        if (q && !spell.name.toLowerCase().includes(q)) return false;
        if (level !== null && !isNaN(level) && spell.level !== level) return false;
        if (cls && !(spell.classes || []).some(c => c.toLowerCase().includes(cls))) return false;
        return true;
      });

      res.json(results.slice(0, limit));
    });

    // GET /api/spells/:name — get full spell data
    app.get('/api/spells/:name', (req, res) => {
      const name = decodeURIComponent(req.params.name).toLowerCase();
      const spell = this.srdSpells.find(s => s.name.toLowerCase() === name);
      if (!spell) return res.status(404).json({ error: 'Spell not found' });
      res.json(spell);
    });

    // Serve map assets
    const assetsDir = path.join(__dirname, '..', '..', 'assets');
    const express = require('express');
    app.use('/assets', express.static(assetsDir));
  }

  _moveToken(tokenId, x, y, opts = {}) {
    let token = this.state.get(`map.tokens.${tokenId}`);

    // Determine which map this token is on (need this before we have the token object)
    const playerMapId = this.playerMapAssignment[tokenId]
      ? this.playerMapAssignment[tokenId] : this.activeMapId;
    const isOnActiveMap = playerMapId === this.activeMapId;

    // If token not in state (DM viewing different map), use map definition
    if (!token) {
      const fallbackMap = this.maps.get(playerMapId);
      if (fallbackMap?.tokens?.[tokenId]) {
        token = fallbackMap.tokens[tokenId];
      } else {
        return null;
      }
    }

    const mapDef = this.maps.get(playerMapId);
    const grid = mapDef?.gridSize || 70;
    const half = grid / 2;
    let snappedX = Math.floor((x - half) / grid) * grid + half;
    let snappedY = Math.floor((y - half) / grid) * grid + half;

    const oldX = token.x;
    const oldY = token.y;

    // Movement rate enforcement (PC tokens only, during combat)
    if (token.type === 'pc') {
      const combat = this.state.get('combat');
      if (combat && combat.active) {
        const charData = this.state.get(`players.${tokenId}.character`);
        const speed = charData?.speed || 30;
        const maxSquares = Math.floor(speed / 5);
        const dx = Math.abs(snappedX - oldX) / grid;
        const dy = Math.abs(snappedY - oldY) / grid;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > maxSquares) {
          // Clamp to max movement range
          const scale = maxSquares / dist;
          snappedX = Math.floor((oldX + (snappedX - oldX) * scale - half) / grid) * grid + half;
          snappedY = Math.floor((oldY + (snappedY - oldY) * scale - half) / grid) * grid + half;
          this.bus.dispatch('dm:whisper', {
            text: `${token.name} tried to move ${Math.round(dist * 5)}ft but speed is ${speed}ft — clamped`,
            priority: 4, category: 'rules'
          });
        }
      }
    }

    // Wall collision check — block movement through walls (player moves only, not DM)
    if (!opts.force && mapDef?.walls && mapDef.walls.length > 0) {
      if (this._pathBlockedByWall(oldX, oldY, snappedX, snappedY, mapDef.walls)) {
        // Movement blocked — stay at old position
        this.bus.dispatch('dm:whisper', {
          text: `${token.name} movement blocked by wall`,
          priority: 5, category: 'rules'
        });
        return { tokenId, x: oldX, y: oldY, blocked: true };
      }
    }

    // Update state (only if token is on the DM's active map)
    if (isOnActiveMap) {
      this.state.set(`map.tokens.${tokenId}.x`, snappedX);
      this.state.set(`map.tokens.${tokenId}.y`, snappedY);
    }
    // Always update map definition so position persists across map switches
    if (mapDef?.tokens?.[tokenId]) {
      mapDef.tokens[tokenId].x = snappedX;
      mapDef.tokens[tokenId].y = snappedY;
    }

    // Check if token entered a new zone (only on active map — zones use activeMapId internally)
    if (isOnActiveMap) {
      const zone = this._getZoneAt(snappedX, snappedY);
      const oldZone = this._getZoneAt(oldX, oldY);
      if (zone?.id !== oldZone?.id) {
        this.bus.dispatch('map:zone_enter', {
          tokenId,
          zone: zone || null,
          previousZone: oldZone || null
        });
      }
    }

    // Dynamic lighting replaces zone-based fog reveal — vision computed client-side

    this.bus.dispatch('map:token_moved', {
      tokenId,
      x: snappedX,
      y: snappedY,
      oldX,
      oldY,
      duration: opts.duration || 0,
      reason: opts.reason || 'manual',
      hidden: !!opts.hidden
    });

    return { tokenId, x: snappedX, y: snappedY };
  }

  _getZoneAt(x, y) {
    const mapDef = this.maps.get(this.activeMapId);
    if (!mapDef?.zones) return null;
    for (const zone of mapDef.zones) {
      if (zone.points && zone.points.length >= 3) {
        // Point-in-polygon (ray casting)
        if (this._pointInPolygon(x, y, zone.points)) return zone;
      } else {
        if (x >= zone.x && x < zone.x + zone.w && y >= zone.y && y < zone.y + zone.h) return zone;
      }
    }
    return null;
  }

  _pointInPolygon(px, py, pts) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const xi = pts[i].x, yi = pts[i].y;
      const xj = pts[j].x, yj = pts[j].y;
      if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
    return inside;
  }

  /**
   * Check if a movement path is blocked by any wall segment (line-line intersection)
   * Walls block movement unless they are open doors.
   * Windows always block movement. Doors block when closed.
   */
  _pathBlockedByWall(x1, y1, x2, y2, walls) {
    for (const wall of walls) {
      const type = wall.type || 'wall';
      // Open doors don't block movement
      if (type === 'door' && wall.open) continue;
      // All other walls/doors/windows block movement
      if (this._linesIntersect(x1, y1, x2, y2, wall.x1, wall.y1, wall.x2, wall.y2)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Check if vision is blocked by walls between two points.
   * Windows and open doors allow vision through. Closed doors and walls block.
   */
  _visionBlockedByWall(x1, y1, x2, y2, walls) {
    for (const wall of walls) {
      const type = wall.type || 'wall';
      // Windows allow vision through
      if (type === 'window') continue;
      // Open doors allow vision through
      if (type === 'door' && wall.open) continue;
      // Walls and closed doors block vision
      if (this._linesIntersect(x1, y1, x2, y2, wall.x1, wall.y1, wall.x2, wall.y2)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Line segment intersection test
   * t = parameter along movement path (0=start, 1=end)
   * u = parameter along wall segment (0=start, 1=end)
   * Tight epsilon on t (don't block if token starts/ends right on a wall)
   * Include wall endpoints (u >= 0, u <= 1) so adjacent wall/door segments have no gaps
   */
  _linesIntersect(ax1, ay1, ax2, ay2, bx1, by1, bx2, by2) {
    const dax = ax2 - ax1, day = ay2 - ay1;
    const dbx = bx2 - bx1, dby = by2 - by1;
    const d = dax * dby - day * dbx;
    if (Math.abs(d) < 0.0001) return false;
    const t = ((bx1 - ax1) * dby - (by1 - ay1) * dbx) / d;
    const u = ((bx1 - ax1) * day - (by1 - ay1) * dax) / d;
    return t > 0.01 && t < 0.99 && u >= -0.001 && u <= 1.001;
  }

  /**
   * Notify players near a door about sounds.
   * Hearing range: 60ft (12 squares) through open air, 30ft (6 squares) through walls.
   * @param {object} wall - the door wall object
   * @param {object} mapDef - the map definition
   * @param {string} excludePlayer - player who caused the sound (already knows)
   * @param {boolean} failedAttempt - true if this is a failed lock pick (quieter)
   */
  _notifyNearDoor(wall, mapDef, excludePlayer, failedAttempt) {
    const doorX = (wall.x1 + wall.x2) / 2;
    const doorY = (wall.y1 + wall.y2) / 2;
    const grid = mapDef.gridSize || 140;
    const hearingRange = (failedAttempt ? 20 : 60) / 5 * grid; // 20ft for rattling, 60ft for open/close

    // Check all PC tokens on this map
    const allTokens = this.state.get('map.tokens') || {};
    for (const [tokenId, tok] of Object.entries(allTokens)) {
      if (tok.type !== 'pc') continue;
      if (tokenId === excludePlayer) continue;
      // Check the token is on the same map
      const tokMap = this.playerMapAssignment[tokenId] || this.activeMapId;
      if (tokMap !== mapDef.id) continue;

      const dx = tok.x - doorX, dy = tok.y - doorY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > hearingRange) continue;

      // Player is in range — pick message based on distance and wall blocking
      const wallsBetween = this._visionBlockedByWall(tok.x, tok.y, doorX, doorY, mapDef.walls || []);
      let text;
      if (failedAttempt) {
        text = wallsBetween
          ? 'You hear faint metallic scratching nearby...'
          : 'You hear someone fiddling with a lock...';
      } else if (wall.open) {
        text = wallsBetween
          ? 'You hear a door creak open somewhere nearby.'
          : 'A door creaks open nearby.';
      } else {
        text = wallsBetween
          ? 'You hear a door slam shut somewhere nearby.'
          : 'A door slams shut nearby.';
      }

      this.bus.dispatch('dm:private_message', {
        playerId: tokenId, text, durationMs: 4000
      });
    }

    // Always tell the DM
    const doorLabel = `Door ${mapDef.walls.indexOf(wall) + 1}`;
    const action = failedAttempt ? 'lock pick attempt (failed)' : (wall.open ? 'opened' : 'closed');
    this.bus.dispatch('dm:whisper', {
      text: `${doorLabel} ${action}` + (excludePlayer ? ` by ${excludePlayer}` : ''),
      priority: 5, category: 'environment'
    });
  }

  /**
   * Auto-reveal fog zones based on token vision range
   * Called after token movement — reveals zones the token can see into
   */
  _checkVisionReveal(tokenId, x, y) {
    const token = this.state.get(`map.tokens.${tokenId}`);
    if (!token || token.type !== 'pc') return;

    const mapDef = this.maps.get(this.activeMapId);
    if (!mapDef) return;
    const grid = mapDef.gridSize || 70;

    // Get vision range from character data (darkvision or normal)
    const charData = this.state.get(`players.${tokenId}.character`);
    const darkvision = charData?.senses?.darkvision || 0;
    const normalVision = 60; // Default 60ft normal vision in lit areas
    const visionFt = Math.max(normalVision, darkvision);
    const visionPx = (visionFt / 5) * grid;

    const zones = this.state.get('map.zones') || [];
    let changed = false;

    for (const zone of zones) {
      if (zone.revealed) continue;

      // Calculate distance from token to zone center
      let zCenterX, zCenterY;
      if (zone.points && zone.points.length >= 3) {
        zCenterX = zone.points.reduce((s, p) => s + p.x, 0) / zone.points.length;
        zCenterY = zone.points.reduce((s, p) => s + p.y, 0) / zone.points.length;
      } else {
        zCenterX = zone.x + (zone.w || 0) / 2;
        zCenterY = zone.y + (zone.h || 0) / 2;
      }

      const dist = Math.sqrt((x - zCenterX) ** 2 + (y - zCenterY) ** 2);
      if (dist <= visionPx) {
        // Check if line of sight is blocked by walls (vision rules — windows/open doors allow)
        const blocked = mapDef.walls?.length > 0 &&
          this._visionBlockedByWall(x, y, zCenterX, zCenterY, mapDef.walls);
        if (!blocked) {
          zone.revealed = true;
          changed = true;
          console.log(`[MapService] Vision reveal: ${token.name} sees ${zone.name || zone.id}`);
        }
      }
    }

    if (changed) {
      this.state.set('map.zones', zones);
      this.bus.dispatch('map:zones_vision_revealed', { tokenId, mapId: this.activeMapId });
    }
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

    // When a new player connects, add their token if they're assigned to the active map
    this.bus.subscribe('player:connected', (env) => {
      const { playerId } = env.data;
      if (!this.activeMapId) return;

      // Skip absent / not yet arrived players — no token until present
      const playerState = this.state.get(`players.${playerId}`) || {};
      if (playerState.absent || playerState.notYetArrived) {
        console.log(`[MapService] Skipping token creation for absent player: ${playerId}`);
        return;
      }

      // If player has no map assignment, assign them to the active map
      if (!this.playerMapAssignment[playerId]) {
        this.playerMapAssignment[playerId] = this.activeMapId;
      }

      // Only add token if player is assigned to the currently active map
      if (this.playerMapAssignment[playerId] !== this.activeMapId) return;

      const existing = this.state.get(`map.tokens.${playerId}`);
      if (existing) return;

      this._addPlayerToken(playerId);
    }, 'map');

    // When a player is marked present (returning from absent), add their token
    this.bus.subscribe('player:absent_changed', (env) => {
      const { playerId, absent } = env.data || {};
      if (absent) {
        // Mark as absent — remove existing token
        const existing = this.state.get(`map.tokens.${playerId}`);
        if (existing) {
          const tokens = this.state.get('map.tokens') || {};
          delete tokens[playerId];
          this.state.set('map.tokens', tokens);
          this.bus.dispatch('map:token_removed', { tokenId: playerId });
          console.log(`[MapService] Removed token for absent player: ${playerId}`);
        }
      } else {
        // Mark as present — add token if not already there
        const playerState = this.state.get(`players.${playerId}`) || {};
        if (playerState.notYetArrived) return; // still not arrived
        const existing = this.state.get(`map.tokens.${playerId}`);
        if (!existing && this.activeMapId) {
          this._addPlayerToken(playerId);
        }
      }
    }, 'map');

    // Character assignment updates token name/HP
    this.bus.subscribe('characters:imported', () => this._syncPlayerTokens(), 'map');
    this.bus.subscribe('characters:reloaded', () => this._syncPlayerTokens(), 'map');
    this.bus.subscribe('characters:loaded', () => this._syncPlayerTokens(), 'map');

    // Auto-perception: check zones when tokens enter them
    this.bus.subscribe('map:zone_enter', (env) => {
      this._handleZonePerceptionCheck(env.data);
    }, 'map');

    // Section 3 — Autonomous token movement via token:move event
    // Allows AI Co-DM and timed events to move tokens with animation duration.
    this.bus.subscribe('token:move', (env) => {
      const { entityId, to, duration, hidden, reason } = env.data || {};
      if (!entityId || !to) return;
      const token = this.state.get(`map.tokens.${entityId}`);
      if (!token) {
        console.log(`[MapService] token:move: no token for ${entityId}`);
        return;
      }
      const gs = this.state.get('map.gridSize') || 70;
      // Convert grid coords to pixels if values look like grid coords
      const px = to.x < 200 ? to.x * gs : to.x;
      const py = to.y < 200 ? to.y * gs : to.y;
      this._moveToken(entityId, px, py, {
        force: true,
        duration: duration || 600,
        reason: reason || 'autonomous',
        hidden: !!hidden
      });
    }, 'map');

    this.bus.subscribe('token:hide', (env) => {
      const id = env.data?.entityId || env.data?.tokenId;
      if (!id) return;
      const tok = this.state.get(`map.tokens.${id}`);
      if (tok) {
        this.state.set(`map.tokens.${id}.hidden`, true);
        this.bus.dispatch('map:token_full_update', { tokenId: id });
      }
    }, 'map');
  }

  _syncPlayerTokens() {
    if (!this.activeMapId) return;
    const players = this.state.get('players') || {};
    for (const [playerId, pData] of Object.entries(players)) {
      // Remove tokens for absent / not-yet-arrived players
      if (pData.absent || pData.notYetArrived) {
        const existing = this.state.get(`map.tokens.${playerId}`);
        if (existing) {
          const tokens = this.state.get('map.tokens') || {};
          delete tokens[playerId];
          this.state.set('map.tokens', tokens);
          this.bus.dispatch('map:token_removed', { tokenId: playerId });
        }
        continue;
      }
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

  _addPlayerToken(playerId) {
    if (!this.activeMapId) return;
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
    console.log(`[MapService] Added token for player ${playerId} on ${this.activeMapId}`);
    return token;
  }

  // ═══════════════════════════════════════════════════════════════
  // AUTO-PERCEPTION — Zone-triggered skill checks
  // ═══════════════════════════════════════════════════════════════

  /**
   * When a player token enters a zone, check for auto-perception triggers.
   * Rolls d20 + skill modifier vs DC, sends results to player and DM.
   */
  _handleZonePerceptionCheck(data) {
    const { tokenId, zone } = data;
    if (!zone) return;

    // Only trigger for player tokens
    const token = this.state.get(`map.tokens.${tokenId}`);
    if (!token || token.type !== 'pc') return;

    // Get the zone definition from the map file (not state — state zones may not have checks)
    const mapDef = this.maps.get(this.activeMapId);
    if (!mapDef) return;

    const zoneDef = (mapDef.zones || []).find(z => z.id === zone.id);
    if (!zoneDef || !zoneDef.checks || !zoneDef.checks.length) return;

    const playerId = tokenId;
    const charData = this.state.get(`players.${playerId}.character`);
    if (!charData) return;

    const charName = charData.name || playerId;

    for (const check of zoneDef.checks) {
      // Check if already triggered for this player
      if (!check.triggered) check.triggered = [];
      if (check.triggerOnce && check.triggered.includes(playerId)) continue;

      // Get skill modifier from character data
      const skillKey = check.skill.toLowerCase();
      const skillData = charData.skills ? charData.skills[skillKey] : null;
      const modifier = skillData ? skillData.modifier : 0;

      // Roll d20
      const roll = Math.floor(Math.random() * 20) + 1;
      const total = roll + modifier;
      const success = total >= check.dc;
      const modStr = modifier >= 0 ? '+' + modifier : '' + modifier;

      // Mark as triggered
      check.triggered.push(playerId);

      // Always whisper the roll result to DM
      const resultStr = success ? 'SUCCESS' : 'FAIL';
      this.bus.dispatch('dm:whisper', {
        text: `${charName} entered ${zone.name || zone.id} — ${check.skill} check: rolled ${roll} ${modStr} = ${total} vs DC ${check.dc} — ${resultStr}`,
        priority: 3,
        category: 'story'
      });

      if (success) {
        // Send success text to player
        if (check.successText) {
          this.bus.dispatch('dm:private_message', {
            playerId,
            text: check.successText,
            durationMs: 12000
          });
        }
        // Auto-send handout if check has a document/handout defined
        if (check.handout) {
          this.bus.dispatch('handout:send', {
            playerId,
            title: check.handout.title || 'Found Document',
            text: check.handout.text || check.successText,
            image: check.handout.image || null,
            preview: (check.handout.text || check.successText || '').slice(0, 80)
          });
        }
        // Send detailed DM whisper if provided
        if (check.dmWhisper) {
          this.bus.dispatch('dm:whisper', {
            text: check.dmWhisper,
            priority: 2,
            category: 'story'
          });
        }
      } else {
        // Send fail text to player (only if failText is not null)
        if (check.failText) {
          this.bus.dispatch('dm:private_message', {
            playerId,
            text: check.failText,
            durationMs: 8000
          });
        }
      }

      console.log(`[MapService] Auto-check: ${charName} in ${zone.name || zone.id} — ${check.skill} ${total} vs DC ${check.dc} — ${resultStr}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // FEATURE 71 — MULTI-LEVEL MAPS (Floor Transitions)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Transition tokens from current map to a target map.
   * Preserves HP, conditions, and other token state.
   * @param {string} targetMapId - Map to transition to
   * @param {string[]} tokenIds - Tokens to move (empty = all PCs)
   * @param {object} spawnPoint - Optional {x, y} override on target map
   */
  transitionFloor(targetMapId, tokenIds, spawnPoint) {
    const targetMap = this.maps.get(targetMapId);
    if (!targetMap) return { error: 'Target map not found' };

    const currentTokens = this.state.get('map.tokens') || {};

    // If no token ids specified, move all PCs
    if (!tokenIds || !tokenIds.length) {
      tokenIds = Object.entries(currentTokens)
        .filter(([id, t]) => t.type === 'pc')
        .map(([id]) => id);
    }

    // Capture token state before transition
    const migratingTokens = {};
    for (const tid of tokenIds) {
      if (currentTokens[tid]) {
        migratingTokens[tid] = { ...currentTokens[tid] };
      }
    }

    // Activate the target map (this resets tokens to map defaults)
    this._activateMap(targetMapId);

    // Re-inject migrating tokens at spawn points
    const newTokens = this.state.get('map.tokens') || {};
    const spawns = targetMap.playerSpawns?.spread || [];
    const defaultSpawn = spawnPoint || targetMap.playerSpawns?.default || { x: 280, y: 350 };
    let spawnIdx = 0;

    for (const [tid, tok] of Object.entries(migratingTokens)) {
      const spawn = spawnPoint || spawns[spawnIdx] || defaultSpawn;
      newTokens[tid] = {
        ...tok,
        x: spawn.x,
        y: spawn.y
      };
      // Update player map assignment
      if (tok.type === 'pc') {
        this.playerMapAssignment[tid] = targetMapId;
      }
      spawnIdx++;
    }

    this.state.set('map.tokens', newTokens);

    this.bus.dispatch('map:floor_transition', {
      from: this.activeMapId,
      to: targetMapId,
      tokens: tokenIds
    });

    console.log(`[MapService] Floor transition: ${tokenIds.length} tokens → ${targetMapId}`);
    return { ok: true, mapId: targetMapId, movedTokens: tokenIds };
  }

  /**
   * Get linked floors for the current map (zones with transitionTo)
   */
  getFloorLinks() {
    const mapDef = this.maps.get(this.activeMapId);
    if (!mapDef) return [];

    const links = [];
    // Check zones with transitionTo
    for (const zone of (mapDef.zones || [])) {
      if (zone.transitionTo) {
        const targetMap = this.maps.get(zone.transitionTo);
        links.push({
          zoneId: zone.id,
          zoneName: zone.name || zone.id,
          targetMapId: zone.transitionTo,
          targetMapName: targetMap?.name || zone.transitionTo,
          x: zone.x, y: zone.y
        });
      }
    }
    // Check floorLinks array in map definition
    for (const link of (mapDef.floorLinks || [])) {
      const targetMapId = link.targetMapId || link.targetMap;
      if (!targetMapId) continue;
      const targetMap = this.maps.get(targetMapId);
      links.push({
        label: link.label || link.name || 'Floor Link',
        targetMapId,
        targetMapName: targetMap?.name || targetMapId,
        x: link.x, y: link.y,
        spawnPoint: link.spawnPoint || null
      });
    }
    return links;
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
