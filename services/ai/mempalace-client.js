/**
 * MemPalace client — async, silent-fail wrappers around the `mempalace` CLI.
 *
 * Design constraints (from the integration brief):
 *   - All CLI calls are async via child_process.execFile — never block the event loop
 *   - Failures must be silent — if the CLI is missing, times out, or returns non-zero,
 *     callers get null/false and the system continues normally
 *   - Every public method has a hard timeout so a hung CLI cannot starve request handlers
 *
 * Public surface:
 *   search(query, opts)      -> Promise<string|null>  compact PALACE RECALL snippet
 *   mine(dir, opts)          -> Promise<boolean>      fire-and-forget, returns true on success
 *   appendMemory(line, opts) -> Promise<string|null>  writes a minable line; no CLI needed
 *   isAvailable()            -> Promise<boolean>      one-shot probe cached for the process lifetime
 *
 * Note on appendMemory: the installed mempalace CLI exposes
 *   init, mine, search, compress, wake-up, split, hook, instructions, repair, mcp,
 *   migrate, status
 * There is NO `add` subcommand. To add a single memory line we append to a
 * minable file under sessions/ so the session:ended `mine` pass picks it up.
 * This keeps every palace mutation flowing through one entrypoint (`mine`)
 * and avoids inventing a CLI feature that doesn't exist.
 */

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const MEMPALACE_BIN = process.env.MEMPALACE_BIN || 'mempalace';
const DEFAULT_WING = 'co_dm';

// Repo root — the co-dm directory. sessions/ lives directly under it.
const CODM_ROOT = path.resolve(__dirname, '..', '..');
const SESSIONS_DIR = path.join(CODM_ROOT, 'sessions');

// Cached availability probe (null = unknown, true/false once probed)
let _available = null;

function _run(args, timeoutMs) {
  return new Promise((resolve) => {
    const child = execFile(MEMPALACE_BIN, args, {
      timeout: timeoutMs,
      maxBuffer: 2 * 1024 * 1024
    }, (err, stdout, stderr) => {
      if (err) {
        // ENOENT / timeout / non-zero exit — all treated as "not available right now"
        resolve({ ok: false, stdout: '', stderr: (err && err.message) || '' });
        return;
      }
      resolve({ ok: true, stdout: stdout || '', stderr: stderr || '' });
    });
    // Belt-and-braces: if the process ignores SIGTERM, force-kill on hard timeout
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) {} }, timeoutMs + 500).unref?.();
    }
  });
}

async function isAvailable() {
  if (_available !== null) return _available;
  // `mempalace status` loads ChromaDB on startup — measured ~2.0s cold.
  // Allow 5s so a mildly-loaded box doesn't flake the probe. Result is
  // cached for the process lifetime so this runs at most once.
  const { ok } = await _run(['status'], 5000);
  _available = ok;
  return _available;
}

/**
 * Parse `mempalace search` human-readable output into a compact recall block.
 * We extract per-result: source filename + first non-empty snippet line.
 * Caller passes `maxChars` to bound the final string — defaults to ~800 chars
 * (≈200 tokens).
 */
function _compressSearchOutput(raw, maxChars) {
  if (!raw || typeof raw !== 'string') return null;
  const lines = raw.split('\n');
  const results = [];
  let current = null;
  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '');
    // New result marker: "  [N] wing / room"
    const m = line.match(/^\s*\[(\d+)\]\s+\S+\s*\/\s*(\S+)/);
    if (m) {
      if (current) results.push(current);
      current = { idx: m[1], room: m[2], source: null, snippet: null };
      continue;
    }
    if (!current) continue;
    const src = line.match(/^\s*Source:\s*(.+)$/);
    if (src) { current.source = src[1].trim(); continue; }
    // The "Match:" line is skipped. The snippet is the first non-empty, non-divider
    // content line after Match.
    if (!current.snippet && line.trim() && !/^\s*Match:/.test(line) && !/^\s*──/.test(line)) {
      current.snippet = line.trim().slice(0, 240);
    }
  }
  if (current) results.push(current);
  if (!results.length) return null;

  const compact = results.map(r => {
    const src = r.source || 'palace';
    const snip = r.snippet || '';
    return `- ${src}: ${snip}`;
  }).join('\n');

  if (compact.length > maxChars) return compact.slice(0, maxChars - 1) + '…';
  return compact;
}

/**
 * Search the palace and return a compact recall string (or null).
 * @param {string} query
 * @param {object} [opts]
 * @param {string} [opts.wing=co_dm]
 * @param {string} [opts.room]
 * @param {number} [opts.results=3]
 * @param {number} [opts.timeoutMs=8000]
 * @param {number} [opts.maxChars=800]  ~200 tokens worth
 */
async function search(query, opts = {}) {
  if (!query || typeof query !== 'string') return null;
  if (!(await isAvailable())) return null;

  const wing = opts.wing || DEFAULT_WING;
  const args = ['search', query, '--wing', wing, '--results', String(opts.results || 3)];
  if (opts.room) args.push('--room', opts.room);

  // ChromaDB startup plus embed+search adds up; 8s gives margin on a
  // loaded VM without risking a wedged caller.
  const { ok, stdout } = await _run(args, opts.timeoutMs || 8000);
  if (!ok) return null;
  return _compressSearchOutput(stdout, opts.maxChars || 800);
}

/**
 * Mine a directory into the palace. Fire-and-forget — returns true on exit 0.
 */
async function mine(dir, opts = {}) {
  if (!dir) return false;
  if (!(await isAvailable())) return false;

  const wing = opts.wing || DEFAULT_WING;
  const args = ['mine', dir, '--wing', wing];
  if (opts.room) args.push('--room', opts.room);
  if (opts.mode) args.push('--mode', opts.mode);

  const { ok } = await _run(args, opts.timeoutMs || 60000);
  return ok;
}

/**
 * Append a single memory line to a minable file under sessions/. The next
 * session:ended mine pass will pick it up and ingest it into the palace.
 * Returns the path written, or null on failure (filesystem errors only).
 *
 * @param {string} line
 * @param {object} [opts]
 * @param {string} [opts.subdir='npc-memories']
 * @param {string} [opts.tag]  optional label prepended
 */
async function appendMemory(line, opts = {}) {
  if (!line || typeof line !== 'string') return null;
  const subdir = opts.subdir || 'npc-memories';
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const dir = path.join(SESSIONS_DIR, subdir);
  const file = path.join(dir, `${date}.md`);
  const stamp = new Date().toISOString();
  const prefix = opts.tag ? `[${stamp}] [${opts.tag}] ` : `[${stamp}] `;
  try {
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.appendFile(file, prefix + line.trim() + '\n');
    return file;
  } catch (e) {
    // Silent per brief — but one log line helps debug if the dir is unwritable
    console.warn('[MemPalace] appendMemory failed:', e.message);
    return null;
  }
}

module.exports = {
  isAvailable,
  search,
  mine,
  appendMemory,
  // exported for tests / diagnostics
  _compressSearchOutput,
  SESSIONS_DIR
};
