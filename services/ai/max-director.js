/**
 * Max Director — intervention queue, staging drift detection, language gate
 * monitoring, silence-based delivery.
 *
 * Lives alongside ai-engine. Intercepts whisper events, queues by priority,
 * and delivers at appropriate silence windows. URGENT bypasses always.
 */

const PRIORITIES = ['URGENT', 'HIGH', 'NORMAL', 'LOW'];
const PRIORITY_RANK = { URGENT: 0, HIGH: 1, NORMAL: 2, LOW: 3 };
const EXPIRY_MS = { URGENT: 30000, HIGH: 30000, NORMAL: 120000, LOW: 300000 };

class MaxDirector {
  constructor(orchestrator, bus, state, config) {
    this.orchestrator = orchestrator;
    this.bus = bus;
    this.state = state;
    this.config = config;

    this.queue = [];                  // [{ id, message, priority, timestamp, expiresAt, category }]
    this.maxQueueSize = 3;
    this.lastTranscriptAt = Date.now();
    this.lastDeliveredAt = 0;
    this.tickInterval = null;
    this.driftInterval = null;

    // NPC expected positions from timed events that have fired
    this.expectedPositions = {};      // npcId -> { x, y, source: eventId }

    // Player languages cache for language gate
    this.playerLanguages = {};        // playerId -> [languages]
    this.npcLanguages = {};           // npcId -> [languages]

    // Staging location word list
    this.locationWords = new Set([
      'window', 'door', 'bar', 'fire', 'fireplace', 'corner', 'table',
      'kitchen', 'stairs', 'cellar', 'outside', 'shed', 'hearth',
      'entrance', 'back', 'front'
    ]);
  }

  init() {
    // Whisper interception: when ai-engine or other services dispatch a
    // dm:whisper, route through queue UNLESS it has bypass:true.
    this.bus.subscribe('dm:whisper', (env) => {
      const d = env.data || env;
      if (d._maxRouted) return; // already processed
      if (d.bypass) return;     // explicit bypass

      const priority = (d.priority === 1 || d.priority === 'URGENT') ? 'URGENT'
                      : (d.priority === 2 || d.priority === 'HIGH') ? 'HIGH'
                      : (d.priority === 3 || d.priority === 'NORMAL') ? 'NORMAL'
                      : 'LOW';
      this.enqueue({
        message: d.text || d.message || '',
        priority,
        category: d.category || 'general',
        sourceData: d
      });
    }, 'max-director');

    // Track transcript activity for silence detection
    this.bus.subscribe('transcript:segment', (env) => {
      this.lastTranscriptAt = Date.now();
      this._checkLanguageGate(env.data);
      this._checkStagingMention(env.data);
    }, 'max-director');

    // Track timed events to update expected positions
    this.bus.subscribe('world:timed_event', (env) => {
      this._updateExpectedPositions(env.data);
    }, 'max-director');

    // Load NPC languages from state when available
    this.bus.subscribe('init', () => this._refreshLanguageCache(), 'max-director');

    // Tick queue every 5 seconds
    this.tickInterval = setInterval(() => this._tick(), 5000);

    // Staging drift check every 60 seconds
    this.driftInterval = setInterval(() => this._checkStagingDrift(), 60000);

    console.log('[MaxDirector] Intervention queue, staging drift, language gate active');
  }

  stop() {
    if (this.tickInterval) clearInterval(this.tickInterval);
    if (this.driftInterval) clearInterval(this.driftInterval);
  }

  // ─── Queue management ─────────────────────────────────────────
  enqueue(item) {
    const entry = {
      id: 'max-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      message: item.message,
      priority: item.priority,
      category: item.category,
      timestamp: Date.now(),
      expiresAt: Date.now() + (EXPIRY_MS[item.priority] || EXPIRY_MS.NORMAL),
      sourceData: item.sourceData || null
    };

    // URGENT — deliver immediately, bypass queue
    if (entry.priority === 'URGENT') {
      this._deliver(entry);
      return entry;
    }

    // Queue with cap and dedupe by message+category
    const dupe = this.queue.find(q => q.category === entry.category && q.message === entry.message);
    if (dupe) return dupe;

    this.queue.push(entry);
    // Sort by priority then timestamp
    this.queue.sort((a, b) => {
      const pa = PRIORITY_RANK[a.priority] || 99;
      const pb = PRIORITY_RANK[b.priority] || 99;
      if (pa !== pb) return pa - pb;
      return a.timestamp - b.timestamp;
    });
    // Trim queue
    if (this.queue.length > this.maxQueueSize) {
      // Drop the lowest-priority oldest items
      this.queue = this.queue.slice(0, this.maxQueueSize);
    }
    return entry;
  }

  _tick() {
    // Drop expired items
    const now = Date.now();
    this.queue = this.queue.filter(q => q.expiresAt > now);

    if (!this.queue.length) return;

    const silenceMs = now - this.lastTranscriptAt;
    const next = this.queue[0];

    // HIGH: deliver at 8-second silence
    if (next.priority === 'HIGH' && silenceMs >= 8000) {
      this._deliver(next);
      this.queue.shift();
      return;
    }

    // NORMAL/LOW: deliver at 120-second deep silence
    if ((next.priority === 'NORMAL' || next.priority === 'LOW') && silenceMs >= 120000) {
      this._deliver(next);
      this.queue.shift();
      return;
    }
  }

  _deliver(entry) {
    if (!entry || !entry.message) return;
    this.lastDeliveredAt = Date.now();
    // Re-emit whisper with _maxRouted flag so we don't re-enqueue
    this.bus.dispatch('dm:whisper', {
      text: entry.message,
      priority: entry.priority,
      category: entry.category,
      source: 'max',
      _maxRouted: true,
      useElevenLabs: true
    });
    this.bus.dispatch('voice:speak', {
      text: entry.message,
      profile: 'max',
      device: 'earbud',
      useElevenLabs: true
    });
    this.bus.dispatch('max:delivered', { entry });
    console.log(`[MaxDirector] Delivered ${entry.priority}/${entry.category}: ${entry.message.slice(0, 80)}`);
  }

  // ─── Staging drift detection ─────────────────────────────────
  _updateExpectedPositions(data) {
    if (!data) return;
    if (data.event === 'token:move' && data.data) {
      const d = data.data;
      if (d.entityId && d.to) {
        this.expectedPositions[d.entityId] = { x: d.to.x, y: d.to.y, source: data.id };
      }
    }
  }

  _checkStagingDrift() {
    const tokens = this.state.get('map.tokens') || {};
    const map = this.state.get('map') || {};
    const gs = map.gridSize || 70;
    for (const [entityId, expected] of Object.entries(this.expectedPositions)) {
      const tok = tokens[entityId];
      if (!tok) continue;
      // Convert expected (grid coords) to pixels if needed
      const ex = expected.x < 200 ? expected.x * gs : expected.x;
      const ey = expected.y < 200 ? expected.y * gs : expected.y;
      const dx = tok.x - ex;
      const dy = tok.y - ey;
      const distGrid = Math.sqrt(dx * dx + dy * dy) / gs;
      if (distGrid > 1) {
        this.enqueue({
          message: `Staging drift — ${tok.name || entityId} is off expected position by ${distGrid.toFixed(1)} squares.`,
          priority: 'NORMAL',
          category: 'staging'
        });
      }
    }
  }

  _checkStagingMention(segment) {
    if (!segment || segment.speaker !== 'dm' || !segment.text) return;
    const text = segment.text.toLowerCase();
    // Find NPC names in the text
    const npcs = this.state.get('npcs') || {};
    const tokens = this.state.get('map.tokens') || {};
    for (const [id, n] of Object.entries(npcs)) {
      if (!n || !n.name) continue;
      const firstName = n.name.split(' ')[0].toLowerCase();
      if (firstName.length > 2 && text.includes(firstName)) {
        // Check for location words
        for (const word of this.locationWords) {
          if (text.includes(word)) {
            // Compare to current token location
            const tok = tokens[id];
            if (tok && tok.location) {
              const tokLocLower = (tok.location || '').toLowerCase();
              if (!tokLocLower.includes(word)) {
                this.enqueue({
                  message: `You said ${n.name} at the ${word}. Token still shows ${tok.location || 'elsewhere'}.`,
                  priority: 'HIGH',
                  category: 'staging'
                });
              }
            }
            break;
          }
        }
      }
    }
  }

  // ─── Language gate monitoring ─────────────────────────────────
  _refreshLanguageCache() {
    const players = this.state.get('players') || {};
    for (const [pid, p] of Object.entries(players)) {
      this.playerLanguages[pid] = (p.character?.languages || []).map(l => String(l).toLowerCase());
    }
    const npcs = this.state.get('npcs') || {};
    for (const [nid, n] of Object.entries(npcs)) {
      const langs = n.languages || [];
      this.npcLanguages[nid] = (Array.isArray(langs) ? langs : String(langs).split(/[,;]/)).map(l => String(l).trim().toLowerCase());
    }
  }

  _checkLanguageGate(segment) {
    if (!segment || !segment.text || segment.speaker === 'dm' || segment.speaker === 'system') return;
    const playerId = segment.speaker;
    const playerLangs = this.playerLanguages[playerId] || ['common'];

    // Check if speaking to a specific NPC mentioned by name
    const text = segment.text.toLowerCase();
    const npcs = this.state.get('npcs') || {};
    for (const [nid, n] of Object.entries(npcs)) {
      if (!n || !n.name) continue;
      const firstName = n.name.split(' ')[0].toLowerCase();
      if (firstName.length > 2 && text.includes(firstName)) {
        const npcLangs = this.npcLanguages[nid] || ['common'];
        // Find common language
        const shared = playerLangs.filter(pl => npcLangs.some(nl => nl.includes(pl) || pl.includes(nl)));
        if (!shared.length) {
          this.enqueue({
            message: `${n.name} doesn't share a language with ${segment.characterName || playerId}. They understand the tone, not the words.`,
            priority: 'HIGH',
            category: 'language'
          });
        }
        break;
      }
    }
  }
}

module.exports = MaxDirector;
