const fs = require('fs');
const path = require('path');

/**
 * Load config with optional session overlay
 */
function loadConfig(sessionConfigPath) {
  const defaultPath = path.join(__dirname, '..', 'config', 'default.json');
  const defaults = JSON.parse(fs.readFileSync(defaultPath, 'utf-8'));

  if (sessionConfigPath && fs.existsSync(sessionConfigPath)) {
    const session = JSON.parse(fs.readFileSync(sessionConfigPath, 'utf-8'));
    return deepMerge(defaults, session);
  }

  return defaults;
}

function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(target[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

module.exports = { loadConfig };
