/**
 * character-service.js
 * Supports both foundryId (Foundry export) and ddbId (DDB sync) as keys.
 */

const fs = require('fs');
const path = require('path');

class CharacterService {
  constructor() {
    this.name = 'characters';
    this.orchestrator = null;
    this.charactersDir = null;
    this.assignmentsPath = null;
  }

  async init(orchestrator) {
    this.orchestrator = orchestrator;
    this.bus = orchestrator.bus;
    this.state = orchestrator.state;
    this.config = orchestrator.config;
    const configDir = path.resolve(this.config.configDir || './config');
    this.charactersDir = path.join(configDir, 'characters');
    this.assignmentsPath = path.join(configDir, 'character-assignments.json');
    fs.mkdirSync(this.charactersDir, { recursive: true });
  }

  async start() {
    const loaded = this._loadAll();
    console.log('[Characters] Loaded ' + loaded + ' character(s) into game state');
  }

  async stop() {}

  _loadAll() {
    const characters = this._readCharacterFiles();
    const assignments = this._readAssignments();
    let count = 0;
    for (const [playerId, charId] of Object.entries(assignments)) {
      if (playerId.startsWith('_')) continue;
      const char = characters[String(charId)];
      if (!char) {
        console.warn('[Characters] Assignment: player \'' + playerId + '\' -> ID ' + charId + ' not found');
        continue;
      }
      this.state.setPlayer(playerId, { name: playerId, character: char });
      console.log('[Characters] -> ' + playerId + ': ' + char.name + ' (' + char.race + ' ' + char.class + ' ' + char.level + ')');
      count++;
    }
    this.state.set('characters.available', characters);
    return count;
  }

  _readCharacterFiles() {
    const chars = {};
    if (!fs.existsSync(this.charactersDir)) return chars;
    for (const file of fs.readdirSync(this.charactersDir)) {
      if (!file.endsWith('.json')) continue;
      try {
        const data = JSON.parse(fs.readFileSync(path.join(this.charactersDir, file), 'utf8'));
        const id = data.foundryId || data.ddbId || path.basename(file, '.json');
        chars[String(id)] = data;
      } catch (err) {
        console.warn('[Characters] Failed to parse ' + file + ': ' + err.message);
      }
    }
    return chars;
  }

  _readAssignments() {
    if (!fs.existsSync(this.assignmentsPath)) return {};
    try {
      const raw = JSON.parse(fs.readFileSync(this.assignmentsPath, 'utf8'));
      const clean = {};
      for (const [k, v] of Object.entries(raw)) {
        if (!k.startsWith('_')) clean[k] = v;
      }
      return clean;
    } catch (err) {
      console.warn('[Characters] Could not read assignments: ' + err.message);
      return {};
    }
  }

  reload() {
    const loaded = this._loadAll();
    this.bus.dispatch('characters:reloaded', { count: loaded });
    return loaded;
  }

  saveCharacter(id, data) {
    const outPath = path.join(this.charactersDir, id + '.json');
    data._syncedAt = new Date().toISOString();
    fs.writeFileSync(outPath, JSON.stringify(data, null, 2));
    console.log('[Characters] Saved ' + data.name + ' -> config/characters/' + id + '.json');
  }

  getAssignments() { return this._readAssignments(); }

  getCharacter(id) {
    const chars = this._readCharacterFiles();
    return chars[String(id)] || null;
  }

  assign(playerId, charId) {
    const assignments = this._readAssignments();
    assignments[playerId] = String(charId);
    fs.writeFileSync(this.assignmentsPath, JSON.stringify(assignments, null, 2));
    this.reload();
    return assignments;
  }

  unassign(playerId) {
    const assignments = this._readAssignments();
    delete assignments[playerId];
    fs.writeFileSync(this.assignmentsPath, JSON.stringify(assignments, null, 2));
    this.reload();
    return assignments;
  }

  addPlayer(playerId) {
    const assignments = this._readAssignments();
    if (!assignments[playerId]) {
      assignments[playerId] = null;
      fs.writeFileSync(this.assignmentsPath, JSON.stringify(assignments, null, 2));
    }
    return assignments;
  }

  removePlayer(playerId) {
    return this.unassign(playerId);
  }

  getStatus() {
    const chars = this._readCharacterFiles();
    const assignments = this._readAssignments();
    return {
      name: this.name,
      status: 'running',
      charactersLoaded: Object.keys(chars).length,
      characters: Object.values(chars).map(c => ({
        foundryId: c.foundryId,
        ddbId: c.ddbId,
        name: c.name,
        class: c.class,
        level: c.level,
        race: c.race,
        syncedAt: c._syncedAt
      })),
      assignments
    };
  }
}

module.exports = CharacterService;
