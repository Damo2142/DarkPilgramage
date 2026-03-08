const Orchestrator = require('./core/orchestrator');
const DashboardService = require('./services/dashboard/dashboard-service');
const PlayerBridgeService = require('./services/player-bridge/player-bridge-service');
const AudioService = require('./services/audio/audio-service');
const AIEngine = require('./services/ai/ai-engine');
const AtmosphereEngine = require('./services/atmosphere/atmosphere-engine');
const { loadConfig } = require('./utils/config-loader');

// Load config (pass session config path as CLI arg if desired)
const sessionConfigPath = process.argv[2] || null;
const config = loadConfig(sessionConfigPath);

console.log('');
console.log('  ⛧  THE DARK PILGRIMAGE — CO-DM AGENT');
console.log('  ═══════════════════════════════════════');
console.log('');

// Create orchestrator
const orchestrator = new Orchestrator(config);

// Register services (order matters — they start in registration order)
orchestrator.register(new DashboardService());
orchestrator.register(new PlayerBridgeService());
orchestrator.register(new AudioService());
orchestrator.register(new AIEngine());
orchestrator.register(new AtmosphereEngine());

// Future services:
// orchestrator.register(new VoiceService());
// orchestrator.register(new FoundryBridge());

// Start everything
orchestrator.startAll().catch(err => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\nReceived SIGINT...');
  await orchestrator.stopAll();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\nReceived SIGTERM...');
  await orchestrator.stopAll();
  process.exit(0);
});

// Unhandled errors
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});