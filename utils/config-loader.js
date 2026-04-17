const fs = require('fs');
const path = require('path');

/**
 * Load config with optional session overlay.
 *
 * After the session file is merged onto defaults, any JSON files present
 * in config/session-0-fragments/ are layered on top. Fragments let us
 * add Phase N content (Dominik, Gregor deathbed, etc.) without touching
 * the large session-0.json. Array-valued keys are concatenated, not
 * replaced — so fragments can append timed events, observations, etc.
 *
 * Load order is alphabetical. Name fragments with a prefix like
 * `03-dominik.json`, `04-gregor.json` to control order where necessary.
 *
 * Phase 1 of session0-polish kept the original deepMerge semantics in
 * the rare case a fragment NEEDS to replace an array — that fragment can
 * set its top-level key to an object `{ "__replace__": [...] }` instead
 * of an array (support added if the need comes up; unused so far).
 */
function loadConfig(sessionConfigPath) {
  const defaultPath = path.join(__dirname, '..', 'config', 'default.json');
  const defaults = JSON.parse(fs.readFileSync(defaultPath, 'utf-8'));

  let result = defaults;
  if (sessionConfigPath && fs.existsSync(sessionConfigPath)) {
    const session = JSON.parse(fs.readFileSync(sessionConfigPath, 'utf-8'));
    result = deepMergeWithArrayConcat(defaults, session);
  }

  // Apply session-0-fragments/*.json on top
  const fragmentsDir = path.join(__dirname, '..', 'config', 'session-0-fragments');
  if (fs.existsSync(fragmentsDir) && fs.statSync(fragmentsDir).isDirectory()) {
    const files = fs.readdirSync(fragmentsDir)
      .filter(f => f.endsWith('.json'))
      .sort();
    for (const file of files) {
      const fragPath = path.join(fragmentsDir, file);
      try {
        const frag = JSON.parse(fs.readFileSync(fragPath, 'utf-8'));
        result = deepMergeWithArrayConcat(result, frag);
        console.log(`[config] Merged fragment: ${file}`);
      } catch (e) {
        console.warn(`[config] Failed to load fragment ${file}: ${e.message}`);
      }
    }
  }

  return result;
}

/**
 * Deep merge: objects merge recursively, arrays concatenate, primitives
 * replace. Concatenation on arrays is the key behavioral change from the
 * previous deepMerge (which replaced arrays entirely).
 */
function deepMergeWithArrayConcat(target, source) {
  if (Array.isArray(target) && Array.isArray(source)) {
    return [...target, ...source];
  }
  if (
    target && typeof target === 'object' && !Array.isArray(target) &&
    source && typeof source === 'object' && !Array.isArray(source)
  ) {
    const result = { ...target };
    for (const key of Object.keys(source)) {
      if (key in result) {
        result[key] = deepMergeWithArrayConcat(result[key], source[key]);
      } else {
        result[key] = source[key];
      }
    }
    return result;
  }
  return source;  // primitive or type mismatch — source wins
}

module.exports = { loadConfig };
