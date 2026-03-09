const EventBus = require('./event-bus');
const StateManager = require('./state-manager');
const SessionLogger = require('./session-logger');

class Orchestrator {
  constructor(config) {
    this.config = config;
    this.services = new Map();

    // Core systems
    this.logger = new SessionLogger(config);
    this.bus = new EventBus(this.logger);
    this.state = new StateManager(this.bus, config);

    // Load session config into state if present
    if (config.scene || config.npcs || config.story) {
      this.state.loadSession(config);
      console.log('[Orchestrator] Session config loaded into state');
      if (config.npcs) {
        const npcNames = Object.keys(config.npcs);
        console.log(`[Orchestrator]   NPCs: ${npcNames.join(', ')}`);
      }
      if (config.story?.beats) {
        console.log(`[Orchestrator]   Story beats: ${config.story.beats.length}`);
      }
      if (config.scene?.name) {
        console.log(`[Orchestrator]   Scene: ${config.scene.name}`);
      }
    }

    // Wire up core event handlers
    this._setupCoreHandlers();
  }

  _setupCoreHandlers() {
    // Session lifecycle
    this.bus.subscribe('session:started', (env) => {
      this.logger.open(this.state.get('session.date'));
    }, 'orchestrator');

    this.bus.subscribe('session:ended', async (env) => {
      console.log(`[Orchestrator] Session ended. Duration: ${Math.round(env.data.duration / 60000)}min`);
      this.logger.close();
    }, 'orchestrator');

    // Panic button - kill all effects
    this.bus.subscribe('panic', async () => {
      console.log('[Orchestrator] *** PANIC *** Killing all effects');
      this.state.set('session.status', 'paused');
      this.bus.dispatch('atmo:panic', {});
      this.bus.dispatch('voice:panic', {});
      this.bus.dispatch('player:panic', {});
    }, 'orchestrator');

    // System errors
    this.bus.subscribe('system:error', (env) => {
      console.error(`[Orchestrator] Service error: ${env.data.service} on ${env.data.event}: ${env.data.error}`);
    }, 'orchestrator');
  }

  register(service) {
    if (!service.name) throw new Error('Service must have a name');
    this.services.set(service.name, service);
    console.log(`[Orchestrator] Registered service: ${service.name}`);
  }

  async startAll() {
    console.log('[Orchestrator] Starting Co-DM...');
    console.log(`[Orchestrator] ${this.services.size} services registered`);

    for (const [name, service] of this.services) {
      try {
        console.log(`[Orchestrator] Initializing ${name}...`);
        if (service.init) await service.init(this);
        if (service.start) await service.start();
        console.log(`[Orchestrator]   ✓ ${name} ready`);
      } catch (err) {
        console.error(`[Orchestrator]   ✗ ${name} failed: ${err.message}`);
        this.bus.dispatch('system:error', {
          service: name,
          event: 'startup',
          error: err.message
        });
      }
    }

    console.log('[Orchestrator] Co-DM ready. Awaiting session start.');
    this.bus.dispatch('system:ready', {
      services: this.getHealthReport()
    });
  }

  async stopAll() {
    console.log('[Orchestrator] Shutting down...');
    for (const [name, service] of [...this.services].reverse()) {
      try {
        if (service.stop) await service.stop();
        console.log(`[Orchestrator]   ✓ ${name} stopped`);
      } catch (err) {
        console.error(`[Orchestrator]   ✗ ${name} stop failed: ${err.message}`);
      }
    }
    this.logger.close();
    console.log('[Orchestrator] Shutdown complete.');
  }

  getHealthReport() {
    const report = {};
    for (const [name, service] of this.services) {
      try {
        report[name] = service.getStatus ? service.getStatus() : { status: 'unknown' };
      } catch {
        report[name] = { status: 'error' };
      }
    }
    return report;
  }

  getService(name) {
    return this.services.get(name) || null;
  }
}

module.exports = Orchestrator;