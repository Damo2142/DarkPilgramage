const EventEmitter = require('events');
const crypto = require('crypto');

// FIX-C3 — events that must NEVER be deduped (high-volume continuous streams,
// or per-frame ticks where every dispatch is a fresh value).
const DEDUP_SKIP_EVENTS = new Set([
  'audio:chunk', 'audio:dm_chunk', 'audio:player_stream_start', 'audio:player_stream_stop',
  'transcript:silence', 'player:camera_frame', 'world:time_update',
  'state:change', 'map:token_moved', 'token:move',
  // Map activation — re-loading the same map should always re-trigger
  // scene-population (NPC reset). Deduping would suppress this.
  'map:activated',
  'system:error', '*',
  // Combat lifecycle events — each turn/round/attack is a discrete event that
  // must never be collapsed with a prior one. Without these exclusions, the
  // second combat:next_turn fingerprint-matches the first within 5s and is
  // dropped, leaving _npcTacticalAI / _executeNpcCombatAction silent for
  // every turn after the first (root cause of F1 in production).
  'combat:next_turn', 'combat:prev_turn', 'combat:started', 'combat:ended',
  'combat:attack_result', 'combat:hp_changed', 'combat:hit_location',
  'combat:condition_changed', 'combat:initiative_changed',
  'combat:combatant_added', 'combat:combatant_removed',
  'combat:death_save', 'combat:morale_break', 'combat:save_required',
  'combat:shock_save_passed', 'combat:shock_failed',
  'combat:player_initiated', 'combat:player_joins',
  'combat:npc_suggestion', 'combat:forced_movement', 'combat:bleeding_tick',
  // Session lifecycle events — two long rests for the same player in the
  // same 5s window (test harness, back-to-back /api/characters/:pid/rest,
  // or DM clicking twice) otherwise fingerprint-match and the second gets
  // dropped, leaving horror decay / ability restores silently skipped.
  'session:long_rest', 'session:short_rest', 'session:started', 'session:ended',
  'session:paused', 'session:resumed', 'state:session_reset', 'state:session_loaded',
  // Private messages and observation triggers — each dispatch is a distinct
  // observation for a distinct player. Dedup fingerprint (text+playerId)
  // would collapse rapid-fire active-look reveals into a single delivery.
  'dm:private_message', 'observation:trigger', 'dm:whisper',
  // Task SAT-002 follow-up — state:flag_set distinguished only by the
  // `flag` field which is not in the fingerprint. Two adjacent flag_sets
  // (e.g., vladislav_named_in_slovak + vladislav_mentioned_bag_warning
  // both dispatched from vladislav-approaches-gregor dispatchEvents)
  // were being deduped as identical. Skip dedup.
  'state:flag_set', 'npc:arrival', 'map:token_added'
]);

class EventBus extends EventEmitter {
  constructor(logger) {
    super();
    this.setMaxListeners(50);
    this.logger = logger;
    this._eventCount = 0;

    // FIX-C3 — server-side dedup. Last 50 event UUIDs with 5 second TTL.
    // Drops content-identical repeats within 5 seconds.
    this._dedupTtlMs = 5000;
    this._dedupMaxEntries = 50;
    this._dedupSeen = []; // [{ uuid, fingerprint, expiresAt }]
    this._dedupDrops = 0;
  }

  _fingerprint(event, data) {
    // Build a stable fingerprint from the event name + a few key fields.
    // We deliberately keep this short — full JSON.stringify of large objects
    // is expensive and large objects are rarely literal duplicates anyway.
    if (!data || typeof data !== 'object') return event;
    const parts = [event];
    // `id` is critical for events where the id IS the discriminator —
    // observation:trigger, combat events keyed on combatant id, etc.
    // Without it, 21 distinct observation:trigger dispatches for different
    // eventIds collapse to one and 20 are silently dropped.
    if (data.id != null)           parts.push('id=' + data.id);
    if (data.text != null)         parts.push('t=' + String(data.text).slice(0, 200));
    if (data.message != null)      parts.push('m=' + String(data.message).slice(0, 200));
    if (data.npcId != null)        parts.push('n=' + data.npcId);
    if (data.npc != null)          parts.push('N=' + data.npc);
    if (data.playerId != null)     parts.push('p=' + data.playerId);
    if (data.tokenId != null)      parts.push('tk=' + data.tokenId);
    if (data.targetId != null)     parts.push('tg=' + data.targetId);
    if (data.channel != null)      parts.push('c=' + data.channel);
    if (data.priority != null)     parts.push('pr=' + data.priority);
    if (data.category != null)     parts.push('cat=' + data.category);
    if (data.profile != null)      parts.push('pf=' + data.profile);
    if (data.zoneId != null)       parts.push('z=' + data.zoneId);
    // For observation:trigger, targetPlayer scopes the fanout; include it
    // so active-look from Kim and Nick produce distinct fingerprints.
    if (data.targetPlayer != null) parts.push('tp=' + data.targetPlayer);
    return parts.join('|');
  }

  _isDuplicate(event, data) {
    if (DEDUP_SKIP_EVENTS.has(event)) return false;
    const now = Date.now();
    // Sweep expired entries
    if (this._dedupSeen.length > 0 && this._dedupSeen[0].expiresAt < now) {
      this._dedupSeen = this._dedupSeen.filter(e => e.expiresAt > now);
    }
    const fp = this._fingerprint(event, data);
    for (let i = this._dedupSeen.length - 1; i >= 0; i--) {
      if (this._dedupSeen[i].fingerprint === fp) return true;
    }
    return false;
  }

  _recordDispatch(event, data, uuid) {
    if (DEDUP_SKIP_EVENTS.has(event)) return;
    const fp = this._fingerprint(event, data);
    this._dedupSeen.push({ uuid, fingerprint: fp, expiresAt: Date.now() + this._dedupTtlMs });
    if (this._dedupSeen.length > this._dedupMaxEntries) {
      this._dedupSeen.splice(0, this._dedupSeen.length - this._dedupMaxEntries);
    }
  }

  /**
   * Emit an event with automatic logging.
   * FIX-C3 — assigns a UUID and drops content-identical repeats within 5s.
   * @param {string} event - Event name
   * @param {object} data - Event payload
   */
  dispatch(event, data = {}) {
    if (this._isDuplicate(event, data)) {
      this._dedupDrops++;
      // Quiet log so we can still see the dedup activity
      if (this._dedupDrops <= 5 || this._dedupDrops % 25 === 0) {
        console.log(`[EventBus] DEDUP dropped "${event}" (total drops: ${this._dedupDrops})`);
      }
      return null;
    }
    this._eventCount++;
    const uuid = crypto.randomUUID ? crypto.randomUUID() : String(this._eventCount) + '-' + Date.now();
    const envelope = {
      id: this._eventCount,
      uuid,
      event,
      timestamp: Date.now(),
      data
    };

    this._recordDispatch(event, data, uuid);

    if (this.logger) {
      this.logger.logEvent(envelope);
    }

    this.emit(event, envelope);
    this.emit('*', envelope); // wildcard listeners (dashboard, logger)
    return envelope;
  }

  /**
   * Subscribe to an event with automatic error handling
   */
  subscribe(event, handler, serviceName = 'unknown') {
    const wrappedHandler = async (envelope) => {
      try {
        await handler(envelope);
      } catch (err) {
        console.error(`[EventBus] Error in ${serviceName} handling "${event}":`, err.message);
        this.dispatch('system:error', {
          service: serviceName,
          event,
          error: err.message
        });
      }
    };
    this.on(event, wrappedHandler);
    return () => this.off(event, wrappedHandler);
  }

  getStats() {
    return {
      totalEvents: this._eventCount,
      listenerCount: this.eventNames().reduce((sum, e) => sum + this.listenerCount(e), 0),
      eventTypes: this.eventNames().filter(e => e !== '*'),
      dedupDrops: this._dedupDrops,
      dedupTrackedEntries: this._dedupSeen.length
    };
  }
}

module.exports = EventBus;
