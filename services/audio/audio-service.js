/**
 * Audio Service — Speech-to-Text
 * Supports two backends:
 *   1. Gemini STT (default if GEMINI_API_KEY set) — sends audio to Google Gemini for transcription
 *   2. Local Whisper (fallback) — runs faster-whisper Python worker on CPU
 *
 * Gemini is far more accurate and doesn't tax the local CPU.
 * Set STT_BACKEND=whisper in .env to force local Whisper.
 */

const { spawn } = require('child_process');
const path = require('path');
const readline = require('readline');

class AudioService {
  constructor() {
    this.name = 'audio';
    this.orchestrator = null;

    // Whisper worker (fallback)
    this.whisperProcess = null;
    this.whisperReady = false;
    this._seq = 0;
    this._playerStreaming = new Set();

    // Gemini STT
    this._geminiKey = null;
    this._useGemini = false;
    this._audioBuffers = {}; // playerId -> { chunks: [], totalSamples: 0, lastChunkTime: 0 }
    this._flushInterval = null;
    this._sttReady = false;

    // Config
    this._bufferDurationMs = 4000; // Accumulate 4 seconds before sending to Gemini
    this._sampleRate = 16000;
  }

  async init(orchestrator) {
    this.orchestrator = orchestrator;
    this.bus = orchestrator.bus;
    this.state = orchestrator.state;
    this.config = orchestrator.config;
  }

  async start() {
    this._geminiKey = process.env.GEMINI_API_KEY;
    const forceWhisper = (process.env.STT_BACKEND || '').toLowerCase() === 'whisper';

    if (this._geminiKey && !forceWhisper) {
      // Use Gemini STT
      this._useGemini = true;
      this._sttReady = true;
      console.log('[Audio] Using Gemini STT (Google AI)');

      // Flush timer — check for buffered audio every 500ms
      this._flushInterval = setInterval(() => this._checkFlush(), 500);

    } else {
      // Fall back to local Whisper
      console.log('[Audio] Using local Whisper STT');
      await this._startWhisper();
    }

    // Listen for audio chunks
    this.bus.subscribe('audio:chunk', (env) => {
      this._handleAudioChunk(env.data);
    }, 'audio');

    this.bus.subscribe('audio:player_stream_start', (env) => {
      this._playerStreaming.add(env.data.playerId);
      console.log(`[Audio] ${env.data.playerId} started streaming (${this._playerStreaming.size} active)`);
    }, 'audio');

    this.bus.subscribe('audio:player_stream_stop', (env) => {
      this._playerStreaming.delete(env.data.playerId);
      if (this._useGemini) {
        this._flushPlayer(env.data.playerId);
      } else {
        this._sendToWhisper({ cmd: 'flush', player: env.data.playerId, seq: ++this._seq });
      }
      console.log(`[Audio] ${env.data.playerId} stopped streaming (${this._playerStreaming.size} active)`);
    }, 'audio');

    this.bus.subscribe('audio:dm_chunk', (env) => {
      this._handleAudioChunk({ ...env.data, playerId: 'dm' });
    }, 'audio');

    this.bus.subscribe('session:ended', () => {
      // Flush all buffered audio
      for (const playerId of Object.keys(this._audioBuffers)) {
        this._flushPlayer(playerId);
      }
    }, 'audio');
  }

  // ═══════════════════════════════════════════════════════════════
  // AUDIO CHUNK HANDLING
  // ═══════════════════════════════════════════════════════════════

  _handleAudioChunk(data) {
    if (!this._sttReady && !this.whisperReady) return;

    const { playerId, audio } = data;
    if (!playerId || !audio) return;

    if (this._useGemini) {
      this._bufferForGemini(playerId, audio);
    } else {
      this._sendToWhisperChunk(playerId, audio);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // GEMINI STT
  // ═══════════════════════════════════════════════════════════════

  _bufferForGemini(playerId, audio) {
    if (!this._audioBuffers[playerId]) {
      this._audioBuffers[playerId] = { chunks: [], totalSamples: 0, lastChunkTime: Date.now() };
    }

    const buf = this._audioBuffers[playerId];

    // Convert incoming audio to Int16 array
    let samples;
    if (Array.isArray(audio)) {
      samples = audio;
    } else if (Buffer.isBuffer(audio)) {
      samples = [];
      for (let i = 0; i < audio.length - 1; i += 2) {
        samples.push(audio.readInt16LE(i));
      }
    } else if (audio instanceof ArrayBuffer) {
      const view = new Int16Array(audio);
      samples = Array.from(view);
    } else {
      return;
    }

    buf.chunks.push(samples);
    buf.totalSamples += samples.length;
    buf.lastChunkTime = Date.now();
  }

  _checkFlush() {
    const now = Date.now();
    for (const [playerId, buf] of Object.entries(this._audioBuffers)) {
      if (buf.totalSamples === 0) continue;

      const durationMs = (buf.totalSamples / this._sampleRate) * 1000;
      const timeSinceLastChunk = now - buf.lastChunkTime;

      // Flush if we have enough audio OR if there's a pause in speech (800ms silence)
      if (durationMs >= this._bufferDurationMs || (durationMs > 500 && timeSinceLastChunk > 800)) {
        this._flushPlayer(playerId);
      }
    }
  }

  async _flushPlayer(playerId) {
    const buf = this._audioBuffers[playerId];
    if (!buf || buf.totalSamples === 0) return;

    // Combine all chunks
    const allSamples = [];
    for (const chunk of buf.chunks) {
      allSamples.push(...chunk);
    }

    // Reset buffer
    buf.chunks = [];
    buf.totalSamples = 0;

    // Skip very short audio (< 500ms)
    const durationMs = (allSamples.length / this._sampleRate) * 1000;
    if (durationMs < 500) return;

    // Convert to WAV bytes
    const wavBuffer = this._createWav(allSamples, this._sampleRate);

    // Send to Gemini
    try {
      const text = await this._geminiTranscribe(wavBuffer, durationMs);
      if (text && text.trim().length > 0) {
        const speaker = playerId === 'dm' ? 'dm' : playerId;
        console.log(`[Audio/Gemini] [${speaker}] (${Math.round(durationMs)}ms) ${text}`);

        this.bus.dispatch('transcript:segment', {
          speaker,
          text: text.trim(),
          confidence: 0.95,
          language: 'en',
          processingMs: 0,
          audioDurationMs: Math.round(durationMs),
          timestamp: Date.now(),
          source: 'gemini'
        });

        if (this.orchestrator.logger) {
          this.orchestrator.logger.logTranscript({ speaker, text: text.trim(), confidence: 0.95 });
        }
      }
    } catch (e) {
      console.error(`[Audio/Gemini] Transcription error: ${e.message}`);
    }
  }

  async _geminiTranscribe(wavBuffer, durationMs) {
    const base64Audio = wavBuffer.toString('base64');

    const body = {
      contents: [{
        parts: [
          {
            inlineData: {
              mimeType: 'audio/wav',
              data: base64Audio
            }
          },
          {
            text: 'Transcribe this audio exactly. Return only the spoken words, nothing else. If the audio is silence or unintelligible, return an empty string. Do not add punctuation beyond what is natural. Do not add commentary.'
          }
        ]
      }],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 200
      }
    };

    const model = 'gemini-2.5-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${this._geminiKey}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000)
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`Gemini ${response.status}: ${errText.slice(0, 200)}`);
    }

    const result = await response.json();
    const text = result.candidates?.[0]?.content?.parts?.[0]?.text || '';
    return text;
  }

  _createWav(samples, sampleRate) {
    const numChannels = 1;
    const bitsPerSample = 16;
    const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
    const blockAlign = numChannels * (bitsPerSample / 8);
    const dataSize = samples.length * (bitsPerSample / 8);
    const headerSize = 44;
    const fileSize = headerSize + dataSize;

    const buffer = Buffer.alloc(fileSize);
    let offset = 0;

    // RIFF header
    buffer.write('RIFF', offset); offset += 4;
    buffer.writeUInt32LE(fileSize - 8, offset); offset += 4;
    buffer.write('WAVE', offset); offset += 4;

    // fmt chunk
    buffer.write('fmt ', offset); offset += 4;
    buffer.writeUInt32LE(16, offset); offset += 4;        // chunk size
    buffer.writeUInt16LE(1, offset); offset += 2;         // PCM format
    buffer.writeUInt16LE(numChannels, offset); offset += 2;
    buffer.writeUInt32LE(sampleRate, offset); offset += 4;
    buffer.writeUInt32LE(byteRate, offset); offset += 4;
    buffer.writeUInt16LE(blockAlign, offset); offset += 2;
    buffer.writeUInt16LE(bitsPerSample, offset); offset += 2;

    // data chunk
    buffer.write('data', offset); offset += 4;
    buffer.writeUInt32LE(dataSize, offset); offset += 4;

    // Write samples
    for (let i = 0; i < samples.length; i++) {
      buffer.writeInt16LE(Math.max(-32768, Math.min(32767, samples[i])), offset);
      offset += 2;
    }

    return buffer;
  }

  // ═══════════════════════════════════════════════════════════════
  // LOCAL WHISPER (fallback)
  // ═══════════════════════════════════════════════════════════════

  _sendToWhisperChunk(playerId, audio) {
    if (!this.whisperReady) return;

    let audioB64;
    if (Buffer.isBuffer(audio)) {
      audioB64 = audio.toString('base64');
    } else if (audio instanceof ArrayBuffer) {
      audioB64 = Buffer.from(audio).toString('base64');
    } else if (Array.isArray(audio)) {
      const buf = Buffer.alloc(audio.length * 2);
      for (let i = 0; i < audio.length; i++) { buf.writeInt16LE(audio[i], i * 2); }
      audioB64 = buf.toString('base64');
    } else {
      return;
    }

    this._sendToWhisper({
      cmd: 'transcribe',
      player: playerId,
      audio_b64: audioB64,
      seq: ++this._seq
    });
  }

  async _startWhisper() {
    const workerPath = path.join(__dirname, 'whisper-worker.py');
    const whisperModel = process.env.WHISPER_MODEL || this.config.audio?.whisperModel || 'base.en';
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

    const rl = readline.createInterface({ input: this.whisperProcess.stdout });
    rl.on('line', (line) => {
      try {
        const msg = JSON.parse(line);
        this._handleWhisperMessage(msg);
      } catch (e) {
        console.error('[Audio] Bad JSON from Whisper:', line.slice(0, 100));
      }
    });

    const stderrRl = readline.createInterface({ input: this.whisperProcess.stderr });
    stderrRl.on('line', (line) => {
      console.log(`[Audio/Whisper] ${line}`);
    });

    this.whisperProcess.on('exit', (code) => {
      console.log(`[Audio] Whisper worker exited with code ${code}`);
      this.whisperReady = false;
      if (this.state.get('session.status') !== 'ended') {
        console.log('[Audio] Restarting Whisper worker in 3s...');
        setTimeout(() => this._startWhisper(), 3000);
      }
    });

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        console.log('[Audio] Whisper worker startup timeout — continuing without transcription');
        resolve();
      }, 60000);

      const checkReady = () => {
        if (this.whisperReady) { clearTimeout(timeout); resolve(); }
        else setTimeout(checkReady, 200);
      };
      checkReady();
    });
  }

  _handleWhisperMessage(msg) {
    switch (msg.cmd) {
      case 'ready':
        this.whisperReady = true;
        this._sttReady = true;
        console.log(`[Audio] Whisper ready (model: ${msg.model}, VAD: ${msg.vad})`);
        this.bus.dispatch('audio:whisper_ready', { model: msg.model, vad: msg.vad });
        break;

      case 'result': {
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
        if (this.orchestrator.logger) {
          this.orchestrator.logger.logTranscript({ speaker, text: msg.text, confidence: msg.confidence });
        }
        break;
      }

      case 'silence':
        this.bus.dispatch('transcript:silence', { speaker: msg.player, durationMs: msg.duration_ms });
        break;

      case 'empty':
      case 'pong':
        break;
    }
  }

  _sendToWhisper(msg) {
    if (this.whisperProcess && this.whisperProcess.stdin.writable) {
      this.whisperProcess.stdin.write(JSON.stringify(msg) + '\n');
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // LIFECYCLE
  // ═══════════════════════════════════════════════════════════════

  async stop() {
    if (this._flushInterval) { clearInterval(this._flushInterval); this._flushInterval = null; }
    // Flush remaining audio
    for (const playerId of Object.keys(this._audioBuffers)) {
      await this._flushPlayer(playerId);
    }
    if (this.whisperProcess) {
      this._sendToWhisper({ cmd: 'shutdown' });
      await new Promise(resolve => setTimeout(resolve, 1000));
      this.whisperProcess.kill();
      this.whisperProcess = null;
    }
  }

  getStatus() {
    return {
      status: this._sttReady || this.whisperReady ? 'running' : 'starting',
      backend: this._useGemini ? 'gemini' : 'whisper',
      whisperReady: this.whisperReady,
      geminiReady: this._useGemini,
      activeStreams: this._playerStreaming.size,
      streamingPlayers: [...this._playerStreaming],
      model: this._useGemini ? 'gemini-2.0-flash' : (process.env.WHISPER_MODEL || this.config.audio?.whisperModel || 'base.en')
    };
  }
}

module.exports = AudioService;
