/**
 * Scene Population Service
 *
 * Auto-populates a map with tokens, items, and encounter triggers when its
 * scene becomes active. Subscribes to the existing `map:activated` event
 * (map-service line 211) and, if a scene config matches the activated map,
 * places everything the scene declares.
 *
 * NOTE on items:
 *   The spec proposes a `map:item_placed` bus event, but no UI currently
 *   listens for it. To avoid building dead infrastructure for April 19,
 *   items are surfaced as a Max-whisper summary instead. Map-marker
 *   rendering can be added post-deadline.
 *
 * State written:
 *   scene.populated.{sceneId} = true   (so we don't double-populate)
 *
 * Events listened to:
 *   map:activated        — { mapId, name }
 *   state:session_reset  — clear populated tracking
 *
 * Events dispatched:
 *   map:token_added      — { tokenId, token } (matches map-service shape)
 *   atmo:change          — { profile, reason, auto, source }
 *   observation:trigger  — { id, ... }
 *   horror:trigger       — { triggerId, amount, reason } (verified — fans out to all players)
 *   dm:whisper           — Max summary
 *   scene:populated      — { sceneId, mapId, tokenCount, itemCount }
 *
 * Encounter triggers in the scene config are stored to state but NOT
 * auto-fired here — combat-service or ambient-life owns when monsters
 * actually engage. We just record them for reference.
 */

const fs = require('fs');
const path = require('path');

class ScenePopulationService {
  constructor() {
    this.name = 'scene-population';
    this.orchestrator = null;
    this.bus = null;
    this.state = null;
    this.scenes = new Map(); // sceneId -> scene definition
  }

  async init(orchestrator) {
    this.orchestrator = orchestrator;
    this.bus = orchestrator.bus;
    this.state = orchestrator.state;
    this.config = orchestrator.config;
  }

  async start() {
    this._loadScenes();

    this.bus.subscribe('map:activated', (env) => {
      try {
        const mapId = env && env.data && env.data.mapId;
        if (mapId) this._onMapActivated(mapId);
      } catch (e) {
        console.warn('[ScenePop] map:activated handler error:', e.message);
      }
    }, 'scene-population');

    this.bus.subscribe('state:session_reset', () => {
      this.state.set('scene.populated', {});
      console.log('[ScenePop] populated state cleared on session reset');
    }, 'scene-population');

    console.log(`[ScenePop] ${this.scenes.size} scene(s) loaded`);
  }

  async stop() {
    // No timers held — nothing to clean up.
  }

  getStatus() {
    const populated = this.state.get('scene.populated') || {};
    return {
      status: 'ok',
      scenes: this.scenes.size,
      populated: Object.keys(populated)
    };
  }

  // ───────────────────────────────────────────────────────────────

  _loadScenes() {
    const dir = path.join(__dirname, '..', '..', 'config', 'scenes');
    if (!fs.existsSync(dir)) {
      console.log('[ScenePop] No config/scenes/ directory — nothing to load');
      return;
    }
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.json')) continue;
      try {
        const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
        if (data && data.id) {
          this.scenes.set(data.id, data);
          console.log(`[ScenePop] Loaded scene: ${data.name || data.id} (${data.id})`);
        }
      } catch (e) {
        console.warn(`[ScenePop] Failed to load ${file}: ${e.message}`);
      }
    }
  }

  _onMapActivated(mapId) {
    // Find a scene whose `map` field matches the activated mapId
    let scene = null;
    for (const [, s] of this.scenes) {
      if (s.map === mapId) { scene = s; break; }
    }
    if (!scene) return; // No scene declared for this map — silent no-op

    // Always snap NPC/creature tokens back to their scene-defined starting
    // positions when the map activates. _activateMap in map-service wipes
    // map.tokens to PC-only state on every activation, so scene-pop must
    // re-create NPC tokens (even if this scene was populated earlier in
    // the session). The scene.populated flag still guards the one-time
    // side-effects (items whisper, encounter triggers, onEnter).
    this._resetNpcPositionsToScene(scene);

    const populated = this.state.get('scene.populated') || {};
    if (populated[scene.id]) {
      console.log(`[ScenePop] Scene ${scene.id} side-effects already fired — NPCs re-placed at scene defaults, skipping full populate`);
      return;
    }

    this._populate(scene);
  }

  // Reset NPC positions (or re-create NPC tokens if map.tokens was wiped
  // by a map re-activation). Preserves PC tokens completely. For existing
  // NPC tokens, only x/y is updated — HP/conditions/visibility preserved.
  _resetNpcPositionsToScene(scene) {
    let moved = 0, recreated = 0, skippedDead = 0;
    for (const t of (scene.tokens || [])) {
      if (!t || !t.id) continue;
      if ((t.type || 'npc') === 'pc') continue; // scenes don't own PC positions
      // Never re-place a dead NPC. Death is recorded in state.npcs.<id>.dead
      // by combat-service on kill; that flag survives map-token wipes so a
      // scene reload does not resurrect corpses.
      if (this.state.get(`npcs.${t.id}.dead`) === true) { skippedDead++; continue; }
      const existing = this.state.get(`map.tokens.${t.id}`);
      if (!existing) {
        // Token missing — recreate from scene definition (happens after
        // _activateMap wipes map.tokens).
        const token = {
          id: t.id,
          tokenId: t.id,
          actorSlug: t.actorSlug || t.id,
          name: t.name || t.id,
          type: t.type || 'npc',
          x: t.x,
          y: t.y,
          hidden: t.hidden === true,
          visible: t.hidden !== true,
          hp: t.hp || { current: 10, max: 10 },
          ac: t.ac || 10,
          image: t.image || `${t.actorSlug || t.id}.webp`,
          publicName: t.publicName || '',
          nameRevealedToPlayers: t.nameRevealedToPlayers === true,
          scenePlaced: true
        };
        this.state.set(`map.tokens.${t.id}`, token);
        this.bus.dispatch('map:token_added', { tokenId: t.id, token });
        recreated++;
        continue;
      }
      if (existing.type === 'pc') continue;
      if (existing.x === t.x && existing.y === t.y) continue;
      const updated = { ...existing, x: t.x, y: t.y };
      this.state.set(`map.tokens.${t.id}`, updated);
      this.bus.dispatch('map:token_moved', { tokenId: t.id, x: t.x, y: t.y, reason: 'scene-reset' });
      moved++;
    }
    if (moved || recreated || skippedDead) console.log(`[ScenePop] Scene "${scene.id}": ${recreated} NPC token(s) re-placed, ${moved} repositioned to scene defaults` + (skippedDead ? `, ${skippedDead} dead NPC(s) left buried` : ''));
  }

  _populate(scene) {
    const tokens = scene.tokens || [];
    const items = scene.items || [];
    const encounters = scene.encounters || [];
    const onEnter = scene.onEnter || {};

    let tokensPlaced = 0;
    for (const t of tokens) {
      if (!t || !t.id) continue;
      // Skip if already on the map (e.g. saved-state load)
      const existing = this.state.get(`map.tokens.${t.id}`);
      if (existing) continue;
      // Don't resurrect dead NPCs on first populate after map switch either.
      if (this.state.get(`npcs.${t.id}.dead`) === true) continue;

      const token = {
        id: t.id,
        tokenId: t.id,
        actorSlug: t.actorSlug || t.id,
        name: t.name || t.id,
        type: t.type || 'npc',
        x: t.x,
        y: t.y,
        hidden: t.hidden === true,
        visible: t.hidden !== true,
        hp: t.hp || { current: 10, max: 10 },
        ac: t.ac || 10,
        image: t.image || `${t.actorSlug || t.id}.webp`,
        publicName: t.publicName || '',
        nameRevealedToPlayers: t.nameRevealedToPlayers === true,
        scenePlaced: true
      };
      this.state.set(`map.tokens.${t.id}`, token);
      this.bus.dispatch('map:token_added', { tokenId: t.id, token });
      tokensPlaced++;
    }

    // Items — whisper Max with what is in the scene; no map markers yet.
    if (items.length > 0) {
      const lines = items.map(it => {
        const dc = (it.findDC != null) ? ` (DC ${it.findDC}${it.findMethod ? ' — ' + it.findMethod : ''})` : '';
        const tag = it.importance ? `[${it.importance}] ` : '';
        return `  • ${tag}${it.name}${dc}: ${it.description || ''}${it.mechanical ? ' — ' + it.mechanical : ''}`;
      }).join('\n');
      this._whisper(`Scene "${scene.name || scene.id}" items present:\n${lines}`, 3, 'story');
    }

    // Encounter triggers — record but don't fire
    if (encounters.length > 0) {
      this.state.set(`scene.${scene.id}.encounters`, encounters);
      const summary = encounters.map(e =>
        `  • ${e.id} (trigger: ${e.trigger}${e.condition ? ' — ' + e.condition : ''}${e.automatic ? ' — AUTO' : ''})`
      ).join('\n');
      this._whisper(`Scene "${scene.name || scene.id}" encounter triggers registered:\n${summary}`, 3, 'story');
    }

    // onEnter side effects
    if (onEnter.maxWhisper) this._whisper(onEnter.maxWhisper, 2, 'story');
    if (onEnter.atmosphereProfile) {
      this.bus.dispatch('atmo:change', {
        profile: onEnter.atmosphereProfile,
        reason: `Scene onEnter: ${scene.id}`,
        auto: true,
        source: 'scene-population'
      });
    }
    if (onEnter.observationId) {
      this.bus.dispatch('observation:trigger', { id: onEnter.observationId });
    }
    if (Array.isArray(onEnter.dispatchOnEnter)) {
      for (const evt of onEnter.dispatchOnEnter) {
        if (typeof evt === 'string') this.bus.dispatch(evt, { source: 'scene-population', sceneId: scene.id });
      }
    }
    if (onEnter.horrorDelta && Number(onEnter.horrorDelta) !== 0) {
      // horror-service subscribes to `horror:trigger`. With no playerId,
      // it routes to _triggerForAllPlayers(triggerId, amount); passing
      // a unique triggerId with `amount` makes amount win over the
      // default table value.
      this.bus.dispatch('horror:trigger', {
        triggerId: `scene_enter:${scene.id}`,
        amount: Number(onEnter.horrorDelta),
        reason: `scene enter: ${scene.id}`
      });
    }

    // Mark populated
    const populated = this.state.get('scene.populated') || {};
    populated[scene.id] = true;
    this.state.set('scene.populated', populated);

    this.bus.dispatch('scene:populated', {
      sceneId: scene.id,
      mapId: scene.map,
      tokenCount: tokensPlaced,
      itemCount: items.length,
      encounterCount: encounters.length
    });

    console.log(`[ScenePop] Populated "${scene.id}" — ${tokensPlaced} tokens, ${items.length} items, ${encounters.length} encounter triggers`);
  }

  _whisper(text, priority, category) {
    this.bus.dispatch('dm:whisper', {
      text,
      priority: priority || 3,
      category: category || 'story',
      source: 'scene-population'
    });
  }
}

module.exports = ScenePopulationService;
