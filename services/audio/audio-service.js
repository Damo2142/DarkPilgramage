const { spawn } = require('child_process');
const path = require('path');
const readline = require('readline');

class AudioService {
  constructor() {
    this.name = 'audio';
    this.orchestrator = null;
    this.whisperProcess = null;
    this.whisperReady = false;
    this._seq = 0;
    this._playerStreaming = new Set();
  }

  async init(orchestrator) {
    this.orchestrator = orchestrator;
    this.bus = orchestrator.bus;
    this.state = orchestrator.state;
    this.config = orchestrator.config;
  }

  async start() {
    // Start the Python Whisper worker
    await this._startWhisper();

    // Listen for audio chunks from Player Bridge
    this.bus.subscribe('audio:chunk', (env) => {
      this._handleAudioChunk(env.data);
    }, 'audio');

    // Listen for player stream start/stop
    this.bus.subscribe('audio:player_stream_start', (env) => {
      this._playerStreaming.add(env.data.playerId);
      console.log(`[Audio] ${env.data.playerId} started streaming (${this._playerStreaming.size} active)`);
    }, 'audio');

    this.bus.subscribe('audio:player_stream_stop', (env) => {
      this._playerStreaming.delete(env.data.playerId);
      // Flush any remaining audio for this player
      this._sendToWhisper({ cmd: 'flush', player: env.data.playerId, seq: ++this._seq });
      console.log(`[Audio] ${env.data.playerId} stopped streaming (${this._playerStreaming.size} active)`);
    }, 'audio');

    // Handle DM audio (from Android tablet)
    this.bus.subscribe('audio:dm_chunk', (env) => {
      this._handleAudioChunk({ ...env.data, playerId: 'dm' });
    }, 'audio');

    // On session end, flush all
    this.bus.subscribe('session:ended', () => {
      for (const player of this._playerStreaming) {
        this._sendToWhisper({ cmd: 'flush', player, seq: ++this._seq });
      }
    }, 'audio');
  }

  async _startWhisper() {
    const workerPath = path.join(__dirname, 'whisper-worker.py');
    const whisperModel = this.config.audio?.whisperModel || 'base.en';
    const vadThreshold = this.config.audio?.vadThreshold || 0.5;

    console.log(`[Audio] Starting Whisper worker (model: ${whisperModel})...`);

    this.whisperProcess = spawn('python3', ['-u', workerPath], {
      env: {
        ...process.env,
        WHISPER_MODEL: whisperModel,
        VAD_THRESHOLD: String(vadThreshold),
        PYTHONUNBUFFERED: '1'
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    // Read JSON lines from stdout
    const rl = readline.createInterface({ input: this.whisperProcess.stdout });
    rl.on('line', (line) => {
      try {
        const msg = JSON.parse(line);
        this._handleWhisperMessage(msg);
      } catch (e) {
        console.error('[Audio] Bad JSON from Whisper:', line.slice(0, 100));
      }
    });

    // Log stderr (worker's log messages)
    const stderrRl = readline.createInterface({ input: this.whisperProcess.stderr });
    stderrRl.on('line', (line) => {
      console.log(`[Audio/Whisper] ${line}`);
    });

    this.whisperProcess.on('exit', (code) => {
      console.log(`[Audio] Whisper worker exited with code ${code}`);
      this.whisperReady = false;

      // Auto-restart after 3 seconds if not shutting down
      if (this.state.get('session.status') !== 'ended') {
        console.log('[Audio] Restarting Whisper worker in 3s...');
        setTimeout(() => this._startWhisper(), 3000);
      }
    });

    // Wait for ready signal (with timeout)
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        console.log('[Audio] Whisper worker startup timeout — continuing without transcription');
        resolve();
      }, 60000); // 60s timeout for model download on first run

      const checkReady = () => {
        if (this.whisperReady) {
          clearTimeout(timeout);
          resolve();
        } else {
          setTimeout(checkReady, 200);
        }
      };
      checkReady();
    });
  }

  _handleWhisperMessage(msg) {
    switch (msg.cmd) {
      case 'ready':
        this.whisperReady = true;
        console.log(`[Audio] Whisper ready (model: ${msg.model}, VAD: ${msg.vad})`);
        this.bus.dispatch('audio:whisper_ready', { model: msg.model, vad: msg.vad });
        break;

      case 'result':
        // Got a transcription result
        const speaker = msg.player === 'dm' ? 'dm' : msg.player;
        this.bus.dispatch('transcript:segment', {
          speaker,
          text: msg.text,
          confidence: msg.confidence,
          language: msg.language,
          processingMs: msg.processing_ms,
          audioDurationMs: msg.audio_duration_ms,
          timestamp: Date.now()
        });

        // Also log to session logger
        if (this.orchestrator.logger) {
          this.orchestrator.logger.logTranscript({
            speaker,
            text: msg.text,
            confidence: msg.confidence
          });
        }
        break;

      case 'silence':
        this.bus.dispatch('transcript:silence', {
          speaker: msg.player,
          durationMs: msg.duration_ms
        });
        break;

      case 'empty':
        // Whisper returned no text — audio was noise/unintelligible
        break;

      case 'pong':
        break;
    }
  }

  _handleAudioChunk(data) {
    if (!this.whisperReady) return;

    const { playerId, audio } = data;

    // Convert the raw buffer to base64 for the JSON protocol
    let audioB64;
    if (Buffer.isBuffer(audio)) {
      audioB64 = audio.toString('base64');
    } else if (audio instanceof ArrayBuffer) {
      audioB64 = Buffer.from(audio).toString('base64');
    } else {
      return; // Unknown format
    }

    this._sendToWhisper({
      cmd: 'transcribe',
      player: playerId,
      audio_b64: audioB64,
      seq: ++this._seq
    });
  }

  _sendToWhisper(msg) {
    if (this.whisperProcess && this.whisperProcess.stdin.writable) {
      this.whisperProcess.stdin.write(JSON.stringify(msg) + '\n');
    }
  }

  async stop() {
    if (this.whisperProcess) {
      this._sendToWhisper({ cmd: 'shutdown' });
      // Give it a moment to clean up
      await new Promise(resolve => setTimeout(resolve, 1000));
      this.whisperProcess.kill();
      this.whisperProcess = null;
    }
  }

  getStatus() {
    return {
      status: this.whisperReady ? 'running' : 'starting',
      whisperReady: this.whisperReady,
      activeStreams: this._playerStreaming.size,
      streamingPlayers: [...this._playerStreaming],
      model: this.config.audio?.whisperModel || 'base.en'
    };
  }
}

module.exports = AudioService;
