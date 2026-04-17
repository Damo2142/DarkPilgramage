/**
 * scripts/test-gregor-slovak-routing.js
 *
 * Verifies that an npc:scripted_speech event carrying _deliveryMode='private'
 * + targetPlayer='ed' + narratorTranslation routes correctly:
 *   - Ed's Chromebook: receives the Slovak text (player:npc_speech to Ed only)
 *   - DM earbud: receives the English translation (dm:whisper priority 1)
 *   - Room speaker: does NOT fire (no npc:approved dispatch)
 *   - Other players: do NOT receive (no player:npc_speech to kim/jen/nick)
 *
 * Runs in isolation by instantiating CommRouter + a mock bus + mock state.
 * No server startup required.
 *
 * Usage: node scripts/test-gregor-slovak-routing.js
 */

const path = require('path');

// Stub the ai-engine dep — comm-router calls getService('ai-engine') for some
// paths but not for scripted_speech; we still provide a shim to avoid crashes.
class MockBus {
  constructor() {
    this.dispatched = [];     // every dispatch recorded here
    this.subscribers = new Map();
  }
  dispatch(event, data) {
    this.dispatched.push({ event, data });
    const subs = this.subscribers.get(event) || [];
    for (const sub of subs) {
      try { sub({ data }); } catch (e) { /* isolated */ }
    }
  }
  subscribe(event, fn) {
    if (!this.subscribers.has(event)) this.subscribers.set(event, []);
    this.subscribers.get(event).push(fn);
  }
}

class MockState {
  constructor(seed) { this._s = seed || {}; }
  get(path) {
    const parts = path.split('.');
    let v = this._s;
    for (const p of parts) {
      if (v == null) return undefined;
      v = v[p];
    }
    return v;
  }
  set(path, value) {
    const parts = path.split('.');
    let obj = this._s;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!obj[parts[i]]) obj[parts[i]] = {};
      obj = obj[parts[i]];
    }
    obj[parts[parts.length - 1]] = value;
  }
}

const MockOrchestrator = {
  getService: (name) => null
};

// Build seed state — Gregor token near Ed's token, Ed speaks Slovak, others don't
const seedState = {
  atmosphere: { currentProfile: 'tavern_warm' },
  map: {
    gridSize: 140,
    tokens: {
      'patron-farmer':  { x: 2800, y: 1500 },
      'ed':             { x: 2940, y: 1500 },  // 1 cell east of Gregor
      'kim':            { x: 1000, y: 1000 },  // far away
      'jen':            { x: 4000, y: 2000 },
      'nick':           { x: 500,  y: 2500 }
    }
  },
  npcs: {
    'patron-farmer': { name: 'Old Gregor', languages: ['slovak'], primaryLanguage: 'slovak', commonFluency: 'broken' }
  },
  players: {
    'ed':   { character: { name: 'Ed', languages: ['common', 'slovak'], primaryLanguage: 'common' } },
    'kim':  { character: { name: 'Zarina', languages: ['common'], primaryLanguage: 'common' } },
    'jen':  { character: { name: 'Marfire', languages: ['common'], primaryLanguage: 'common' } },
    'nick': { character: { name: 'Chazz', languages: ['common'], primaryLanguage: 'common' } }
  }
};

const CommRouter = require('../services/ai/comm-router');
const bus = new MockBus();
const state = new MockState(seedState);
const router = new CommRouter(MockOrchestrator, bus, state, {});
router.init();

// Verify the handler got wired
const subs = router.bus.subscribers.get('npc:scripted_speech');
if (!subs || subs.length === 0) {
  console.error('FATAL: npc:scripted_speech subscriber was not registered.');
  console.error('Check comm-router.start() for the subscribe() call.');
  process.exit(1);
}

// ─── Test: fire the Gregor deathbed event shape ───

const gregorEvent = {
  npcId: 'patron-farmer',
  npc: 'Old Gregor',
  languageId: 'slovak',
  targetPlayer: 'ed',
  _deliveryMode: 'private_to_ed_chromebook_with_english_to_dm_earbud',
  text: "Počúvaj. Tento vak — ide k Matthiasovi.",
  narratorTranslation: "Listen. This bag — it goes to Matthias.",
  languageNote: 'SLOVAK — delivered private to Ed, English to DM earbud.'
};

router.bus.dispatch('npc:scripted_speech', gregorEvent);

// Inspect what was dispatched
const dispatched = router.bus.dispatched;
console.log(`\n→ ${dispatched.length} events dispatched by scripted_speech handler:\n`);
for (const d of dispatched) {
  const short = typeof d.data === 'object' ? Object.keys(d.data).slice(0, 5).join(',') : d.data;
  console.log(`  - ${d.event}   { ${short} }`);
}

// ─── Assertions ───

let passed = 0, failed = 0;
const failures = [];

function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; failures.push(msg); console.log(`  ✗ ${msg}`); }
}

console.log('\n── Expected routing behavior ──');

// 1. Ed's Chromebook receives the Slovak text via player:npc_speech
const edSpeech = dispatched.find(d => d.event === 'player:npc_speech' && d.data.playerId === 'ed');
assert(!!edSpeech, 'Ed receives player:npc_speech');
if (edSpeech) {
  assert(edSpeech.data.text && edSpeech.data.text.includes('Počúvaj'),
    'Ed receives the Slovak text (not the translation)');
}

// 2. Other players do NOT receive this private whisper
const kimSpeech = dispatched.find(d => d.event === 'player:npc_speech' && d.data.playerId === 'kim');
const jenSpeech = dispatched.find(d => d.event === 'player:npc_speech' && d.data.playerId === 'jen');
const nickSpeech = dispatched.find(d => d.event === 'player:npc_speech' && d.data.playerId === 'nick');
assert(!kimSpeech, 'Kim does NOT receive the private Slovak whisper');
assert(!jenSpeech, 'Jen does NOT receive the private Slovak whisper');
assert(!nickSpeech, 'Nick does NOT receive the private Slovak whisper');

// 3. Room speaker does NOT fire — no npc:approved
const approved = dispatched.find(d => d.event === 'npc:approved');
assert(!approved, 'Room speaker NOT triggered (no npc:approved dispatch)');

// 4. DM earbud receives the English narratorTranslation via dm:whisper priority 1
const dmTranslation = dispatched.find(d =>
  d.event === 'dm:whisper' &&
  d.data.priority === 1 &&
  (d.data.text || '').includes('This bag — it goes to Matthias')
);
assert(!!dmTranslation, 'DM earbud receives the English translation (dm:whisper priority 1)');

// ─── Results ───

console.log(`\n══ RESULTS ══`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
if (failed > 0) {
  console.log('\nFailures (these are the gaps that need fixing):');
  failures.forEach(f => console.log(`  • ${f}`));
  process.exit(1);
}
console.log('\nAll routing assertions passed — Gregor Slovak routing is wired correctly.');
process.exit(0);
