const fs = require('fs');
const path = require('path');

class SessionLogger {
  constructor(config) {
    this.config = config;
    this.logDir = config?.session?.logDir || './sessions';
    this._transcriptStream = null;
    this._eventStream = null;
    this._sessionDate = null;
    this._eventCount = 0;
    this._transcriptCount = 0;
  }

  /**
   * Open log files for a session date
   */
  open(dateStr) {
    this._sessionDate = dateStr || new Date().toISOString().slice(0, 10);
    const sessionDir = path.join(this.logDir, this._sessionDate);
    fs.mkdirSync(sessionDir, { recursive: true });

    this._transcriptStream = fs.createWriteStream(
      path.join(sessionDir, 'transcript.jsonl'),
      { flags: 'a' }
    );
    this._eventStream = fs.createWriteStream(
      path.join(sessionDir, 'events.jsonl'),
      { flags: 'a' }
    );

    console.log(`[SessionLogger] Logging to ${sessionDir}`);
  }

  /**
   * Log a transcript segment
   */
  logTranscript(segment) {
    if (!this._transcriptStream) return;
    this._transcriptCount++;
    const entry = {
      seq: this._transcriptCount,
      timestamp: Date.now(),
      isoTime: new Date().toISOString(),
      ...segment
    };
    this._transcriptStream.write(JSON.stringify(entry) + '\n');
  }

  /**
   * Log a system event (called by EventBus)
   */
  logEvent(envelope) {
    if (!this._eventStream) return;
    // Don't log state:change events with high frequency paths to avoid noise
    if (envelope.event === 'state:change' && envelope.data?.path === 'session.elapsedMs') {
      return;
    }
    this._eventCount++;
    const entry = {
      seq: this._eventCount,
      isoTime: new Date().toISOString(),
      ...envelope
    };
    this._eventStream.write(JSON.stringify(entry) + '\n');
  }

  /**
   * Close all log streams
   */
  close() {
    if (this._transcriptStream) {
      this._transcriptStream.end();
      this._transcriptStream = null;
    }
    if (this._eventStream) {
      this._eventStream.end();
      this._eventStream = null;
    }
    console.log(`[SessionLogger] Closed. ${this._transcriptCount} transcript entries, ${this._eventCount} events logged.`);
  }

  /**
   * Get log stats
   */
  getStats() {
    return {
      sessionDate: this._sessionDate,
      transcriptEntries: this._transcriptCount,
      eventEntries: this._eventCount,
      active: this._transcriptStream !== null
    };
  }

  /**
   * Read back a session's transcript (for post-session analysis)
   */
  readTranscript(dateStr) {
    const filePath = path.join(this.logDir, dateStr, 'transcript.jsonl');
    if (!fs.existsSync(filePath)) return [];
    const out = [];
    for (const line of fs.readFileSync(filePath, 'utf-8').trim().split('\n')) {
      if (!line) continue;
      try { out.push(JSON.parse(line)); }
      catch (e) { console.warn('[SessionLogger] Skipping malformed transcript line: ' + e.message); }
    }
    return out;
  }

  /**
   * Read back a session's events
   */
  readEvents(dateStr) {
    const filePath = path.join(this.logDir, dateStr, 'events.jsonl');
    if (!fs.existsSync(filePath)) return [];
    const out = [];
    for (const line of fs.readFileSync(filePath, 'utf-8').trim().split('\n')) {
      if (!line) continue;
      try { out.push(JSON.parse(line)); }
      catch (e) { console.warn('[SessionLogger] Skipping malformed event line: ' + e.message); }
    }
    return out;
  }
}

module.exports = SessionLogger;
