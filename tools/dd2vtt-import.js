#!/usr/bin/env node
/**
 * dd2vtt-import.js — Convert Dungeondraft .dd2vtt export to Co-DM map JSON
 *
 * Usage:
 *   node tools/dd2vtt-import.js <input.dd2vtt> <map-id> [map-name]
 *
 * Example:
 *   node tools/dd2vtt-import.js ~/Downloads/ground-floor.dd2vtt pallidhearfloor1 "Pallid Hart — Ground Floor"
 *
 * What it does:
 *   1. Reads the .dd2vtt file (JSON with base64 image + walls + lights + portals)
 *   2. Extracts the PNG image to assets/maps/<map-id>.png
 *   3. Converts walls, lights, portals to Co-DM format
 *   4. Writes config/maps/<map-id>.json (preserves zones/tokens/spawns if file exists)
 *
 * Dungeondraft export settings:
 *   - Pixels per grid: 140 (or whatever you prefer)
 *   - Grid: OFF
 *   - Lighting: OFF
 */

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
if (args.length < 2) {
  console.log('Usage: node tools/dd2vtt-import.js <input.dd2vtt> <map-id> [map-name]');
  console.log('');
  console.log('Example:');
  console.log('  node tools/dd2vtt-import.js ~/Downloads/ground-floor.dd2vtt pallidhearfloor1 "Pallid Hart — Ground Floor"');
  process.exit(1);
}

const inputFile = args[0];
const mapId = args[1];
const mapName = args[2] || mapId;

const ROOT = path.join(__dirname, '..');
const MAPS_DIR = path.join(ROOT, 'config', 'maps');
const ASSETS_DIR = path.join(ROOT, 'assets', 'maps');

// Read and parse dd2vtt
console.log(`Reading ${inputFile}...`);
const raw = fs.readFileSync(inputFile, 'utf8');
const dd2vtt = JSON.parse(raw);

const res = dd2vtt.resolution || {};
const ppg = res.pixels_per_grid || 140;
const mapSizeX = res.map_size?.x || 0;
const mapSizeY = res.map_size?.y || 0;
const originX = res.map_origin?.x || 0;
const originY = res.map_origin?.y || 0;
// Extract image and read actual pixel dimensions from PNG header
let imgWidth = mapSizeX * ppg;  // fallback
let imgHeight = mapSizeY * ppg;

if (dd2vtt.image) {
  const imgPath = path.join(ASSETS_DIR, `${mapId}.png`);
  const imgData = Buffer.from(dd2vtt.image, 'base64');
  fs.writeFileSync(imgPath, imgData);

  // Read actual dimensions from PNG IHDR chunk (bytes 16-23)
  if (imgData[0] === 0x89 && imgData[1] === 0x50) { // PNG magic
    imgWidth = imgData.readUInt32BE(16);
    imgHeight = imgData.readUInt32BE(20);
  }
  console.log(`Image: ${imgPath} (${(imgData.length / 1024 / 1024).toFixed(1)}MB, ${imgWidth}x${imgHeight}px)`);
} else {
  console.log('Warning: No image data in dd2vtt file. Export your map PNG separately.');
  console.log(`Using calculated size: ${imgWidth}x${imgHeight}px`);
}

console.log(`Map: ${mapSizeX}x${mapSizeY} grid squares, ${ppg}px/grid, image ${imgWidth}x${imgHeight}px`);

// Convert walls — dd2vtt stores LoS walls as "line_of_sight" or "walls"
// Coordinates are in grid-square units, convert to pixels for Co-DM
const walls = [];
const rawWalls = dd2vtt.line_of_sight || dd2vtt.walls || [];
for (const wall of rawWalls) {
  // Some dd2vtt files have walls as arrays of points (polylines)
  // Others have {x1,y1,x2,y2} pairs
  if (Array.isArray(wall)) {
    // Polyline: array of {x, y} points — create segments between consecutive points
    for (let i = 0; i < wall.length - 1; i++) {
      walls.push({
        x1: Math.round((wall[i].x - originX) * ppg),
        y1: Math.round((wall[i].y - originY) * ppg),
        x2: Math.round((wall[i+1].x - originX) * ppg),
        y2: Math.round((wall[i+1].y - originY) * ppg),
        type: 'wall'
      });
    }
  } else if (wall.x1 !== undefined) {
    // Already in segment format
    walls.push({
      x1: Math.round((wall.x1 - originX) * ppg),
      y1: Math.round((wall.y1 - originY) * ppg),
      x2: Math.round((wall.x2 - originX) * ppg),
      y2: Math.round((wall.y2 - originY) * ppg),
      type: 'wall'
    });
  }
}
console.log(`Walls: ${walls.length} segments`);

// Convert portals (doors/windows) — add as wall segments with type
const portals = [];
for (const portal of (dd2vtt.portals || [])) {
  const bounds = portal.bounds || [];
  if (bounds.length >= 2) {
    const b0 = bounds[0];
    const b1 = bounds[1];
    const px1 = Math.round((b0.x - originX) * ppg);
    const py1 = Math.round((b0.y - originY) * ppg);
    const px2 = Math.round((b1.x - originX) * ppg);
    const py2 = Math.round((b1.y - originY) * ppg);

    // Add to walls array as a door
    walls.push({
      x1: px1, y1: py1,
      x2: px2, y2: py2,
      type: 'door',
      open: !portal.closed,
      locked: false
    });

    // Also store in portals array for Co-DM portal format
    portals.push({
      x: Math.round(((b0.x + b1.x) / 2 - originX) * ppg),
      y: Math.round(((b0.y + b1.y) / 2 - originY) * ppg),
      closed: portal.closed !== false,
      bounds: [
        { x: px1, y: py1 },
        { x: px2, y: py2 }
      ]
    });
  }
}
console.log(`Portals: ${portals.length} doors/windows → added to walls`);
console.log(`Total wall segments: ${walls.length}`);

// Convert lights — dd2vtt lights use position.x/y or x/y in grid-square coordinates
const lights = [];
for (const light of (dd2vtt.lights || [])) {
  const lx = Math.round(((light.position?.x ?? light.x) - originX) * ppg);
  const ly = Math.round(((light.position?.y ?? light.y) - originY) * ppg);
  const range = Math.round((light.range || 4) * ppg); // range in grid squares → pixels
  // Color: dd2vtt uses hex like "ffeccd8b" (ARGB) or "#eccd8b"
  let color = light.color || 'ffeccd8b';
  if (typeof color === 'string' && color.startsWith('#')) {
    color = 'ff' + color.slice(1);
  }
  lights.push({ x: lx, y: ly, range, color });
}
console.log(`Lights: ${lights.length}`);

// Build map JSON — preserve existing zones/tokens/spawns if file exists
const mapFile = path.join(MAPS_DIR, `${mapId}.json`);
let existing = {};
if (fs.existsSync(mapFile)) {
  try {
    existing = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
    console.log(`Existing map file found — preserving zones, tokens, spawns, floorLinks`);
  } catch (e) {
    console.log(`Warning: Could not parse existing ${mapFile}: ${e.message}`);
  }
}

const mapJson = {
  id: mapId,
  name: mapName,
  image: `${mapId}.png`,
  gridSize: ppg,
  width: imgWidth,
  height: imgHeight,
  source: 'dungeondraft',
  dd2vttFormat: 0.3,
  walls,
  lights,
  portals,
  // Preserve existing gameplay data
  zones: existing.zones || [],
  tokens: existing.tokens || {},
  floorLinks: existing.floorLinks || [],
  playerSpawns: existing.playerSpawns || { default: { x: Math.round(imgWidth / 2), y: Math.round(imgHeight / 2) } }
};

fs.writeFileSync(mapFile, JSON.stringify(mapJson, null, 2));
console.log(`\nWrote: ${mapFile}`);
console.log(`\nDone! Map "${mapName}" ready.`);
console.log(`  ${walls.length} walls, ${lights.length} lights, ${portals.length} portals`);
console.log(`  Grid: ${ppg}px/square, ${mapSizeX}x${mapSizeY} squares, ${imgWidth}x${imgHeight}px`);

if (existing.zones?.length) {
  console.log(`  Preserved ${existing.zones.length} zones from existing config`);
}
if (Object.keys(existing.tokens || {}).length) {
  console.log(`  Preserved ${Object.keys(existing.tokens).length} tokens from existing config`);
}

console.log(`\nNext: restart Co-DM or reload the map from the dashboard.`);
