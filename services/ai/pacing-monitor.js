/**
 * Pacing Monitor — Phase F
 * Features 28-32: Secret state tracking, clue chain visualization,
 * revelation control, pacing detection, tension curve tracking.
 */

const fs = require('fs');
const path = require('path');

// Target tension curve by story beat
const TENSION_TARGETS = {
  'arrival':        { min: 10, max: 20, target: 15 },
  'inn_welcome':    { min: 15, max: 25, target: 20 },
  'introductions':  { min: 15, max: 30, target: 22 },
  'unease':         { min: 30, max: 45, target: 38 },
  'investigation':  { min: 40, max: 55, target: 48 },
  'first_scare':    { min: 45, max: 60, target: 52 },
  'escalation':     { min: 55, max: 70, target: 62 },
  'dread_rising':   { min: 55, max: 75, target: 65 },
  'discovery':      { min: 60, max: 80, target: 70 },
  'confrontation':  { min: 70, max: 85, target: 78 },
  'climax':         { min: 80, max: 95, target: 88 },
  'resolution':     { min: 30, max: 50, target: 40 }
};

// Default for unknown beats
const DEFAULT_TENSION = { min: 20, max: 60, target: 40 };

class PacingMonitor {
  constructor(gemini, contextBuilder, bus, state, config) {
    this.gemini = gemini;
    this.ctx = contextBuilder;
    this.bus = bus;
    this.state = state;
    this.config = config;

    this._systemPrompt = '';
    this._lastCheckTime = 0;
    this._checkCooldownMs = 90000; // Check every 90s max
    this._segmentsSinceCheck = 0;
    this._checkEveryNSegments = 8;
    this._lastPacingStatus = null;
    this._lastRevelationStatus = null;
    this._tensionHistory = []; // { time, actual, target, beat }
    this._pacingAlerts = []; // history of pacing alerts
    this._stuckSince = null; // timestamp when stuck was first detected

    try {
      this._systemPrompt = fs.readFileSync(
        path.join(__dirname, '..', '..', 'prompts', 'pacing-monitor.md'), 'utf-8'
      );
    } catch (e) {
      this._systemPrompt = 'You are a pacing monitor for a D&D horror campaign. Analyze revelation speed, pacing, and tension.';
    }
  }

  start() {
    // Track tension on dread changes
    this.bus.subscribe('dread:update', () => {
      this._recordTension();
    }, 'pacing-monitor');

    // Track when secrets are revealed
    this.bus.subscribe('world:secret_revealed', (env) => {
      this._onSecretRevealed(env.data);
    }, 'pacing-monitor');

    // Track clue discoveries
    this.bus.subscribe('world:clue_found', (env) => {
      this._onClueFound(env.data);
    }, 'pacing-monitor');

    // Track beats completing
    this.bus.subscribe('story:beat', (env) => {
      this._recordTension();
    }, 'pacing-monitor');

    // Periodic tension recording
    this._tensionInterval = setInterval(() => {
      if (this.state.get('session.status') === 'active') {
        this._recordTension();
      }
    }, 60000);

    console.log('[PacingMonitor] Ready');
  }

  stop() {
    if (this._tensionInterval) clearInterval(this._tensionInterval);
  }

  // ── Called by AI engine on transcript segments ───────────────────────

  async onTranscript(segment) {
    this._segmentsSinceCheck++;
    if (this._segmentsSinceCheck < this._checkEveryNSegments) return;
    this._segmentsSinceCheck = 0;
    if (Date.now() - this._lastCheckTime < this._checkCooldownMs) return;

    await this.evaluate();
  }

  // ── Core evaluation ─────────────────────────────────────────────────

  async evaluate() {
    if (!this.gemini.available) return null;

    const context = this._buildPacingContext();
    const contextStr = this.ctx.toPromptString(this.ctx.buildAtmosphereContext());

    const prompt = `${context}\n\n${contextStr}\n\nAnalyze the current revelation state, pacing, and tension. Are players getting information at the right rate? Are they stuck or rushing? Does the tension match the story beat?`;

    const response = await this.gemini.generateJSON(
      this._systemPrompt,
      prompt,
      { maxTokens: 400, temperature: 0.4 }
    );

    this._lastCheckTime = Date.now();
    if (!response) return null;

    // Process revelation status
    if (response.revelation) {
      this._lastRevelationStatus = response.revelation;
      if (response.revelation.confidence >= 0.7 && response.revelation.status !== 'on_track') {
        this._dispatchAlert('revelation', response.revelation);
      }
    }

    // Process pacing status
    if (response.pacing) {
      this._lastPacingStatus = response.pacing;
      if (response.pacing.status === 'stuck') {
        if (!this._stuckSince) this._stuckSince = Date.now();
        const stuckMinutes = Math.round((Date.now() - this._stuckSince) / 60000);
        response.pacing.stuckMinutes = stuckMinutes;
      } else {
        this._stuckSince = null;
      }
      if (response.pacing.confidence >= 0.7 && response.pacing.status !== 'good') {
        this._dispatchAlert('pacing', response.pacing);
      }
    }

    // Process tension
    if (response.tension) {
      this._recordTensionFromAI(response.tension);
      if (response.tension.status !== 'on_track') {
        const diff = Math.abs((response.tension.actual || 0) - (response.tension.target || 0));
        if (diff >= 20) {
          this._dispatchAlert('tension', response.tension);
        }
      }
    }

    // Broadcast full status for dashboard
    this.bus.dispatch('pacing:status', {
      revelation: response.revelation || this._lastRevelationStatus,
      pacing: response.pacing || this._lastPacingStatus,
      tension: response.tension,
      secretProgress: this._getSecretProgress(),
      clueProgress: this._getClueProgress(),
      chainProgress: this._getChainProgress(),
      tensionHistory: this._tensionHistory.slice(-30)
    });

    return response;
  }

  // ── Secret/Clue tracking ────────────────────────────────────────────

  _getSecretProgress() {
    const worldData = this._getWorldData();
    const secrets = worldData.secrets || {};
    const total = Object.keys(secrets).length;
    const revealed = Object.values(secrets).filter(s => s.revealed).length;
    const perPlayer = {};

    // Build per-player knowledge map
    const players = this.state.get('players') || {};
    for (const playerId of Object.keys(players)) {
      perPlayer[playerId] = {
        secretsKnown: 0,
        cluesFound: 0,
        secrets: []
      };
      for (const [sid, s] of Object.entries(secrets)) {
        if (s.discoveredBy && s.discoveredBy[playerId]) {
          perPlayer[playerId].secretsKnown++;
          perPlayer[playerId].secrets.push(sid);
        }
      }
    }

    // Count clues per player
    const clues = worldData.clues || {};
    for (const [cid, c] of Object.entries(clues)) {
      if (c.found && c.foundBy && perPlayer[c.foundBy]) {
        perPlayer[c.foundBy].cluesFound++;
      }
    }

    return { total, revealed, remaining: total - revealed, perPlayer };
  }

  _getClueProgress() {
    const worldData = this._getWorldData();
    const clues = worldData.clues || {};
    const total = Object.keys(clues).length;
    const found = Object.values(clues).filter(c => c.found).length;

    return {
      total,
      found,
      remaining: total - found,
      percent: total > 0 ? Math.round((found / total) * 100) : 0,
      clues: Object.values(clues).map(c => ({
        id: c.id,
        description: c.description,
        found: c.found,
        foundBy: c.foundBy,
        location: c.location,
        dc: c.dc
      }))
    };
  }

  _getChainProgress() {
    const worldData = this._getWorldData();
    const discoveries = worldData.discoveries || {};

    return Object.entries(discoveries).map(([id, d]) => ({
      id,
      description: d.description,
      steps: d.clueChain?.length || 0,
      currentStep: d.currentStep || 0,
      completed: d.completed,
      percent: d.clueChain?.length > 0
        ? Math.round(((d.currentStep || 0) / d.clueChain.length) * 100)
        : 0
    }));
  }

  _getWorldData() {
    // Get world data from state (synced by world-clock-service._syncToState)
    return this.state.get('world') || {};
  }

  // ── Tension curve tracking ──────────────────────────────────────────

  _getCurrentBeat() {
    const beats = this.state.get('story.beats') || [];
    // Find the most recently completed beat
    const completed = beats.filter(b => b.status === 'completed');
    const pending = beats.filter(b => b.status === 'pending');

    if (completed.length === 0) return pending[0]?.id || 'arrival';

    // Current beat is the first pending one (what we're working toward)
    // or the last completed one if all done
    return pending[0]?.id || completed[completed.length - 1]?.id || 'arrival';
  }

  _getTargetTension() {
    const beatId = this._getCurrentBeat();
    return TENSION_TARGETS[beatId] || DEFAULT_TENSION;
  }

  _getActualTension() {
    const players = this.state.get('players') || {};
    const scores = Object.values(players)
      .map(p => p.dread?.score || 0)
      .filter(s => s >= 0);

    if (scores.length === 0) return 0;
    return Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
  }

  _recordTension() {
    const actual = this._getActualTension();
    const target = this._getTargetTension();
    const beat = this._getCurrentBeat();

    this._tensionHistory.push({
      time: Date.now(),
      actual,
      target: target.target,
      targetMin: target.min,
      targetMax: target.max,
      beat
    });

    // Keep last 120 entries (2 hours at 1/min)
    if (this._tensionHistory.length > 120) this._tensionHistory.shift();
  }

  _recordTensionFromAI(tensionData) {
    if (tensionData.actual !== undefined) {
      const target = this._getTargetTension();
      this._tensionHistory.push({
        time: Date.now(),
        actual: tensionData.actual,
        target: target.target,
        targetMin: target.min,
        targetMax: target.max,
        beat: this._getCurrentBeat(),
        aiAssessed: true
      });
      if (this._tensionHistory.length > 120) this._tensionHistory.shift();
    }
  }

  // ── Event handlers ──────────────────────────────────────────────────

  _onSecretRevealed(data) {
    const progress = this._getSecretProgress();
    const percent = progress.total > 0
      ? Math.round((progress.revealed / progress.total) * 100)
      : 0;

    this.bus.dispatch('dm:whisper', {
      text: `Secret revealed: ${progress.revealed}/${progress.total} (${percent}%). ${progress.remaining} secrets remain hidden.`,
      priority: 4,
      category: 'pacing-log',
      _maxRouted: true,         // CR-4 — log-only, never spoken
      logOnly: true
    });

    // Check for revelation speed
    const beats = this.state.get('story.beats') || [];
    const completedBeats = beats.filter(b => b.status === 'completed').length;
    const totalBeats = beats.length;
    const beatProgress = totalBeats > 0 ? completedBeats / totalBeats : 0;
    const secretProgress = progress.total > 0 ? progress.revealed / progress.total : 0;

    // If secrets are way ahead of beat progress, warn
    if (secretProgress > beatProgress + 0.3 && progress.revealed >= 2) {
      this._dispatchAlert('revelation', {
        status: 'too_fast',
        confidence: 0.8,
        message: `Secrets are revealing faster than the story is progressing. ${progress.revealed} secrets revealed but only ${completedBeats}/${totalBeats} beats complete.`,
        suggestion: 'Slow down reveals. Let players digest what they know before giving more.'
      });
    }
  }

  _onClueFound(data) {
    const clueProgress = this._getClueProgress();
    const chainProgress = this._getChainProgress();

    // Notify DM of chain advancement
    for (const chain of chainProgress) {
      if (!chain.completed && chain.currentStep > 0) {
        this.bus.dispatch('dm:whisper', {
          text: `Discovery chain "${chain.id}": step ${chain.currentStep}/${chain.steps} (${chain.percent}%)`,
          priority: 4,
          category: 'pacing-log',
          _maxRouted: true,    // CR-4 — log-only, never spoken
          logOnly: true
        });
      }
    }
  }

  // ── Alert dispatch ──────────────────────────────────────────────────

  _dispatchAlert(type, data) {
    const alert = {
      type,
      status: data.status,
      message: data.message,
      suggestion: data.suggestion || null,
      confidence: data.confidence || 0,
      time: Date.now()
    };

    // Avoid duplicate alerts within 3 minutes
    const recentSame = this._pacingAlerts.find(a =>
      a.type === type && a.status === data.status &&
      Date.now() - a.time < 180000
    );
    if (recentSame) return;

    this._pacingAlerts.push(alert);
    if (this._pacingAlerts.length > 50) this._pacingAlerts.shift();

    // CR-4 — pacing alerts ([TENSION] / [REVELATION] / [PACING]) are
    // log-only. They go to the DM dashboard panel via pacing:alert and
    // dm:whisper, but the dm:whisper is tagged _maxRouted so the
    // max-director never enqueues them and they NEVER reach the earbud.
    // The DM reads pacing in the whisper log; Max never speaks them aloud.
    const prefix = type === 'revelation' ? '📊' : type === 'pacing' ? '⏱' : '📈';
    this.bus.dispatch('dm:whisper', {
      text: `${prefix} [${type.toUpperCase()}] ${data.message}${data.suggestion ? ' Suggestion: ' + data.suggestion : ''}`,
      priority: 4,            // LOW — only matters if explicitly fetched
      category: 'pacing-log',
      _maxRouted: true,       // bypass max-director enqueue + voice
      logOnly: true
    });

    // Dispatch for dashboard panel
    this.bus.dispatch('pacing:alert', alert);
  }

  // ── Context for AI evaluation ───────────────────────────────────────

  _buildPacingContext() {
    const secretProgress = this._getSecretProgress();
    const clueProgress = this._getClueProgress();
    const chainProgress = this._getChainProgress();
    const tension = this._getTargetTension();
    const actual = this._getActualTension();
    const beat = this._getCurrentBeat();

    const parts = [];
    parts.push('## Information State');
    parts.push(`Secrets: ${secretProgress.revealed}/${secretProgress.total} revealed`);
    parts.push(`Clues: ${clueProgress.found}/${clueProgress.total} found (${clueProgress.percent}%)`);

    // Per-player knowledge
    for (const [pid, pk] of Object.entries(secretProgress.perPlayer)) {
      parts.push(`  ${pid}: ${pk.secretsKnown} secrets, ${pk.cluesFound} clues`);
    }

    // Chain progress
    for (const chain of chainProgress) {
      parts.push(`Chain "${chain.id}": ${chain.currentStep}/${chain.steps} (${chain.percent}%) ${chain.completed ? 'COMPLETE' : ''}`);
    }

    parts.push('\n## Tension Curve');
    parts.push(`Current beat: ${beat}`);
    parts.push(`Target tension: ${tension.min}-${tension.max} (ideal: ${tension.target})`);
    parts.push(`Actual average dread: ${actual}`);

    // Recent tension history
    const recent = this._tensionHistory.slice(-5);
    if (recent.length) {
      parts.push('Recent tension: ' + recent.map(t =>
        `${Math.round((Date.now() - t.time) / 60000)}min ago: ${t.actual}/${t.target}`
      ).join(', '));
    }

    // Story progress
    const beats = this.state.get('story.beats') || [];
    const completedBeats = beats.filter(b => b.status === 'completed');
    const pendingBeats = beats.filter(b => b.status === 'pending');
    parts.push(`\nBeats completed: ${completedBeats.length}/${beats.length}`);
    if (completedBeats.length) parts.push(`  Completed: ${completedBeats.map(b => b.name).join(', ')}`);
    if (pendingBeats.length) parts.push(`  Pending: ${pendingBeats.map(b => b.name).join(', ')}`);

    return parts.join('\n');
  }

  // ── Stats ───────────────────────────────────────────────────────────

  getStats() {
    return {
      revelation: this._lastRevelationStatus,
      pacing: this._lastPacingStatus,
      actualTension: this._getActualTension(),
      targetTension: this._getTargetTension(),
      currentBeat: this._getCurrentBeat(),
      alertCount: this._pacingAlerts.length,
      tensionHistoryLength: this._tensionHistory.length,
      stuckSince: this._stuckSince,
      secretProgress: this._getSecretProgress(),
      clueProgress: this._getClueProgress()
    };
  }
}

module.exports = PacingMonitor;
