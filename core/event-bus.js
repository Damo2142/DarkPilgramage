const EventEmitter = require('events');

class EventBus extends EventEmitter {
  constructor(logger) {
    super();
    this.setMaxListeners(50);
    this.logger = logger;
    this._eventCount = 0;
  }

  /**
   * Emit an event with automatic logging
   * @param {string} event - Event name (e.g., 'transcript:segment', 'ai:npc_dialogue')
   * @param {object} data - Event payload
   */
  dispatch(event, data = {}) {
    this._eventCount++;
    const envelope = {
      id: this._eventCount,
      event,
      timestamp: Date.now(),
      data
    };

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
      eventTypes: this.eventNames().filter(e => e !== '*')
    };
  }
}

module.exports = EventBus;
