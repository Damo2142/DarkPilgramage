const fs = require('fs');
const path = require('path');

class MapService {
  constructor() {
    this.name = 'map';
    this.orchestrator = null;
    this.maps = new Map();       // mapId -> map definition
    this.activeMapId = null;
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
