const path = require('path');
const Orchestrator = require('./core/orchestrator');
const DashboardService = require('./services/dashboard/dashboard-service');
const PlayerBridgeService = require('./services/player-bridge/player-bridge-service');
const AudioService = require('./services/audio/audio-service');
const AIEngine = require('./services/ai/ai-engine');
const AtmosphereEngine = require('./services/atmosphere/atmosphere-engine');
const CharacterService = require('./services/characters/character-service');
const MapService = require('./services/map/map-service');
const CombatService = require('./services/combat/combat-service');
const WorldClockService = require('./services/world/world-clock-service');
const VoiceService = require('./services/audio/voice-service');
const SoundService = require('./services/audio/sound-service');
const CampaignService = require('./services/campaign/campaign-service');
const EquipmentService = require('./services/equipment/equipment-service');
const StaminaService = require('./services/stamina/stamina-service');
const LightingService = require('./services/lighting/lighting-service');
const ObservationService = require('./services/observation/observation-service');
const { loadConfig } = require('./utils/config-loader');

// Auto-discover session config: CLI arg > config/session-0.json > defaults only
const sessionConfigPath = process.argv[2]
  || path.join(__dirname, 'config', 'session-0.json');

const config = loadConfig(sessionConfigPath);

console.log('');
console.log('  \u26E7  THE DARK PILGRIMAGE \u2014 CO-DM AGENT');
console.log('  \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550');
console.log('');

const orchestrator = new Orchestrator(config);

orchestrator.register(new CharacterService());
orchestrator.register(new DashboardService());
orchestrator.register(new PlayerBridgeService());
orchestrator.register(new MapService());
orchestrator.register(new CombatService());
orchestrator.register(new WorldClockService());
orchestrator.register(new AudioService());
orchestrator.register(new VoiceService());
orchestrator.register(new SoundService());
orchestrator.register(new AIEngine());
orchestrator.register(new AtmosphereEngine());
orchestrator.register(new CampaignService());
orchestrator.register(new EquipmentService());
orchestrator.register(new StaminaService());
orchestrator.register(new LightingService());
orchestrator.register(new ObservationService());

orchestrator.startAll().catch(err => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});

async function gracefulShutdown(signal) {
  console.log(`\n${signal} received — shutting down...`);
  const forceTimer = setTimeout(() => { console.error('Shutdown timeout — forcing exit'); process.exit(1); }, 8000);
  forceTimer.unref();
  try { await orchestrator.stopAll(); } catch(e) { console.error('Shutdown error:', e); }
  process.exit(0);
}
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('uncaughtException', err => console.error('Uncaught exception:', err));
process.on('unhandledRejection', err => console.error('Unhandled rejection:', err));
