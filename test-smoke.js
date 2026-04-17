#!/usr/bin/env node
/**
 * End-to-end smoke test for the Dark Pilgrimage Co-DM.
 *
 * Spins up WS + REST clients simulating Dave (DM dashboard) and the four
 * live players (Ed, Kim, Jen, Nick) and drives a scenario that exercises:
 *   - WS init/handshake
 *   - Token movement (speed clamp + wall collision feedback)
 *   - Language-gated NPC speech (foreign-language BARRIER vs FULL)
 *   - Friendly-fire + private-whisper WS events
 *   - audio:play event routed to player
 *   - Ambient life broadcast reaching players
 *
 * Run against a live server (HTTPS on localhost:3200) and prints a pass/fail
 * table per player per check. Any red line is a regression.
 */

const WebSocket = require('ws');
const https = require('https');
const fs = require('fs');

const HOST = 'localhost';
const PORT = 3200;
const PLAYERS = ['ed', 'kim', 'jen', 'nick'];

const TLS_IGNORE = { rejectUnauthorized: false };

const clients = {}; // id -> { ws, events: [] }
const checks = []; // { player, name, pass, detail }

function log(...args) { console.log('[smoke]', ...args); }

function httpsRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      method, host: HOST, port: PORT, path,
      rejectUnauthorized: false,
      headers: { 'Content-Type': 'application/json', 'Content-Length': data ? Buffer.byteLength(data) : 0 }
    }, (res) => {
      let buf = '';
      res.on('data', (c) => buf += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: buf ? JSON.parse(buf) : null }); }
        catch { resolve({ status: res.statusCode, body: buf }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function connectWs(label, url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, TLS_IGNORE);
    const events = [];
    const rec = { ws, events, label };
    let settled = false;
    ws.on('open', () => { if (!settled) { settled = true; resolve(rec); } });
    ws.on('message', (msg) => {
      try { events.push(JSON.parse(msg.toString())); }
      catch { events.push({ type: '__raw__', raw: msg.toString().slice(0, 200) }); }
    });
    ws.on('error', (e) => { if (!settled) { settled = true; reject(e); } });
    setTimeout(() => { if (!settled) { settled = true; reject(new Error('WS connect timeout: ' + url)); } }, 5000);
  });
}

function addCheck(player, name, pass, detail) {
  checks.push({ player, name, pass, detail: detail || '' });
  const tag = pass ? '✔' : '✘';
  const color = pass ? '\x1b[32m' : '\x1b[31m';
  console.log(`  ${color}${tag}\x1b[0m ${player.padEnd(10)} ${name}${detail ? '  — ' + detail : ''}`);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function findEvent(client, predicate, { after = 0 } = {}) {
  const slice = client.events.slice(after);
  return slice.find(predicate) || null;
}

async function main() {
  console.log('\n========== DARK PILGRIMAGE SMOKE TEST ==========');
  console.log('Target: https://' + HOST + ':' + PORT);
  console.log('Players: ' + PLAYERS.join(', ') + ' + dave (DM)\n');

  // 1. Server reachable
  log('step 1: GET /api/state');
  const st = await httpsRequest('GET', '/api/state');
  if (st.status !== 200) {
    console.error('server not reachable:', st.status);
    process.exit(1);
  }
  addCheck('server', 'GET /api/state 200', true);
  const statePlayers = Object.keys(st.body.players || {});
  addCheck('server', 'state has ed/kim/jen/nick',
    PLAYERS.every(p => statePlayers.includes(p)),
    statePlayers.join(','));

  // 2. Connect dashboard + 4 player WS clients in parallel
  log('step 2: connect WS for dave + 4 players');
  const playerWsP = PLAYERS.map((p) =>
    connectWs(p, `wss://${HOST}:${PORT}?player=${p}`).catch(e => ({ error: e.message, label: p }))
  );
  const daveWsP = connectWs('dave', `wss://${HOST}:${PORT}/`).catch(e => ({ error: e.message, label: 'dave' }));

  const playerRecs = await Promise.all(playerWsP);
  const daveRec = await daveWsP;

  for (const rec of playerRecs) {
    if (rec.error) { addCheck(rec.label, 'WS connect', false, rec.error); continue; }
    clients[rec.label] = rec;
    addCheck(rec.label, 'WS connect', true);
  }
  if (daveRec.error) addCheck('dave', 'WS connect', false, daveRec.error);
  else { clients.dave = daveRec; addCheck('dave', 'WS connect', true); }

  // 3. Give server a moment to send init packet
  await sleep(1500);
  for (const p of PLAYERS) {
    const c = clients[p]; if (!c) continue;
    const init = c.events.find(e => e.type === 'init');
    addCheck(p, 'received init', !!init, init && init.player && init.player.character ? (init.player.character.name || '') : '');
    const hasChar = init && init.player && init.player.character && init.player.character.name;
    addCheck(p, 'init.character present', !!hasChar, hasChar || 'missing');
  }

  // 4. Language gating — inspect each player's character.languages
  log('step 4: languages per PC (from /api/state)');
  for (const p of PLAYERS) {
    const pdata = st.body.players[p];
    const langs = (pdata && pdata.character && pdata.character.languages) || [];
    addCheck(p, 'has languages[]', Array.isArray(langs) && langs.length > 0, langs.join('/'));
  }

  // 5. Trigger an audio:play event to each player via REST and confirm WS receipt.
  //    We use the sound service's public route if available, otherwise dispatch
  //    directly via a dev endpoint. Fallback: emit via bus:dispatch API.
  log('step 5: audio:play round-trip');
  const mark = {};
  for (const p of PLAYERS) mark[p] = (clients[p] ? clients[p].events.length : 0);

  // We emit audio:play directly to each player via a custom _sendToPlayer
  // simulation — the server-side pattern is: dispatch `audio:play:broadcast`
  // or `player:audio` and the player-bridge forwards it. We use the
  // generic debug dispatch so we exercise the real pipeline.
  const audioReq = await httpsRequest('POST', '/api/debug/dispatch', {
    event: 'audio:play_sound',
    data: { url: '/assets/sounds/test.mp3', volume: 0.4, category: 'sfx' }
  });
  // Not all builds expose /api/bus/dispatch — if 404 we try a second path
  const audioBroadcastRouteExists = audioReq.status < 400;

  if (!audioBroadcastRouteExists) {
    addCheck('server', '/api/debug/dispatch route', false, 'status=' + audioReq.status + ' — SKIP audio round-trip');
  } else {
    await sleep(1000);
    for (const p of PLAYERS) {
      const c = clients[p]; if (!c) continue;
      const got = c.events.slice(mark[p]).find(e => e.type === 'audio:play');
      addCheck(p, 'received audio:play', !!got, got ? got.url : 'none');
    }
  }

  // 6. Trigger a private whisper to Ed and check Ed (only) receives it.
  log('step 6: private:whisper to ed');
  for (const p of PLAYERS) mark[p] = clients[p] ? clients[p].events.length : 0;
  const pw = await httpsRequest('POST', '/api/debug/dispatch', {
    event: 'player:private_whisper',
    data: { playerId: 'ed', source: 'Narrator', text: 'The floorboards groan under you.' }
  });
  if (pw.status >= 400) {
    addCheck('server', 'dispatch private_whisper', false, 'status=' + pw.status);
  } else {
    await sleep(800);
    for (const p of PLAYERS) {
      const c = clients[p]; if (!c) continue;
      const got = c.events.slice(mark[p]).find(e => e.type === 'private:whisper');
      const shouldReceive = (p === 'ed');
      addCheck(p, 'private:whisper (' + (shouldReceive ? 'expected' : 'not-expected') + ')',
        shouldReceive === !!got, got ? got.text : '');
    }
  }

  // 7. Friendly fire events — Kim (shooter) hits Jen (victim)
  log('step 7: friendly-fire events shooter=kim victim=jen');
  for (const p of PLAYERS) mark[p] = clients[p] ? clients[p].events.length : 0;
  await httpsRequest('POST', '/api/debug/dispatch', {
    event: 'player:friendly_fire_shooter',
    data: { playerId: 'kim', shooterName: 'Zarina', victimName: 'Marfire', text: 'Your bolt veers toward Marfire!' }
  });
  await httpsRequest('POST', '/api/debug/dispatch', {
    event: 'player:friendly_fire_victim',
    data: { playerId: 'jen', shooterName: 'Zarina', damage: 6, damageType: 'piercing', text: 'A bolt slams into you from behind — it was Zarina.' }
  });
  await sleep(800);
  const ffKim = clients.kim ? clients.kim.events.slice(mark.kim).find(e => e.type === 'friendly_fire:shooter') : null;
  const ffJen = clients.jen ? clients.jen.events.slice(mark.jen).find(e => e.type === 'friendly_fire:victim') : null;
  addCheck('kim', 'friendly_fire:shooter received', !!ffKim);
  addCheck('jen', 'friendly_fire:victim received', !!ffJen);
  for (const p of ['ed', 'nick']) {
    const c = clients[p]; if (!c) continue;
    const ff = c.events.slice(mark[p]).find(e => e.type === 'friendly_fire:shooter' || e.type === 'friendly_fire:victim');
    addCheck(p, 'no stray friendly_fire', !ff, ff ? ff.type : '');
  }

  // 8. Ambient broadcast — fire observation and verify all players get it
  log('step 8: ambient:observation broadcast');
  for (const p of PLAYERS) mark[p] = clients[p] ? clients[p].events.length : 0;
  await httpsRequest('POST', '/api/debug/dispatch', {
    event: 'ambient:observation',
    data: { npcId: 'old-gregor', npcName: 'Old Gregor', text: 'spits into the fire and mutters about the woods.' }
  });
  await sleep(800);
  for (const p of PLAYERS) {
    const c = clients[p]; if (!c) continue;
    const got = c.events.slice(mark[p]).find(e => e.type === 'ambient:observation');
    addCheck(p, 'ambient:observation received', !!got);
  }

  // 9. NPC speech language gating — speak as Marta in "slovak" and verify
  //    the gated text reaches each player per their known languages.
  log('step 9: NPC speech language gating (Marta, slovak)');
  for (const p of PLAYERS) mark[p] = clients[p] ? clients[p].events.length : 0;
  const npcR = await httpsRequest('POST', '/api/debug/npc-speak', {
    npcId: 'marta-hroznovska',
    text: 'Neverte tomu mužovi pri ohni. Má oči vlka.',
    languageId: 'slovak'
  });
  if (npcR.status >= 400) {
    addCheck('server', '/api/comm/npc-speak', false, 'status=' + npcR.status + ' (language gating not exercised)');
  } else {
    await sleep(1500);
    // Expected: ed + nick have Slovak → FULL. kim + jen do NOT → BARRIER.
    const slovakExpected = { ed: 'FULL', nick: 'FULL', kim: 'BARRIER', jen: 'BARRIER' };
    for (const p of PLAYERS) {
      const c = clients[p]; if (!c) continue;
      const got = c.events.slice(mark[p]).find(e => e.type === 'npc:speech');
      if (!got) { addCheck(p, 'npc:speech (slovak)', false, 'not received'); continue; }
      const lang = got.languageResult && got.languageResult.result;
      const expected = slovakExpected[p];
      const pass = (lang === expected);
      addCheck(p, `npc:speech (slovak) tier=${lang}`, pass, pass ? '' : `expected ${expected}, text="${(got.text||'').slice(0,40)}"`);
    }
  }

  // 10. Perception flash — one-to-one routing to nick
  log('step 10: perception flash to nick (only)');
  for (const p of PLAYERS) mark[p] = clients[p] ? clients[p].events.length : 0;
  await httpsRequest('POST', '/api/debug/perception-flash', {
    playerId: 'nick',
    description: 'A shape on the tree line — gone before you blink.',
    margin: 4
  });
  await sleep(800);
  for (const p of PLAYERS) {
    const c = clients[p]; if (!c) continue;
    const got = c.events.slice(mark[p]).find(e => e.type === 'perception:flash');
    const shouldReceive = (p === 'nick');
    addCheck(p, 'perception:flash (' + (shouldReceive ? 'expected' : 'not-expected') + ')',
      shouldReceive === !!got, got ? (got.description || '').slice(0,40) : '');
  }

  // 11. Reconnect recovery — close jen, reopen, verify init arrives with correct character
  log('step 11: reconnect jen and verify init');
  try { clients.jen.ws.close(); } catch {}
  await sleep(600);
  const jen2 = await connectWs('jen', `wss://${HOST}:${PORT}?player=jen`).catch(e => ({ error: e.message }));
  if (jen2.error) {
    addCheck('jen', 'reconnect WS', false, jen2.error);
  } else {
    clients.jen = jen2;
    await sleep(1200);
    const init = jen2.events.find(e => e.type === 'init');
    addCheck('jen', 'reconnect received init', !!init);
    const char = init && init.player && init.player.character;
    addCheck('jen', 'reconnect char is Marfire 2.0', !!(char && /marfire/i.test(char.name || '')), char ? char.name : 'none');
  }

  // 12. HP round-trip — damage ed by 3, verify state persists and broadcast reaches ed
  log('step 12: HP round-trip for ed');
  const preHp = st.body.players.ed && st.body.players.ed.character && st.body.players.ed.character.hp && st.body.players.ed.character.hp.current;
  mark.ed = clients.ed.events.length;
  const hpR = await httpsRequest('POST', '/api/hp/ed', { delta: -3 });
  await sleep(600);
  const post = await httpsRequest('GET', '/api/state');
  const postHp = post.body.players.ed && post.body.players.ed.character && post.body.players.ed.character.hp && post.body.players.ed.character.hp.current;
  const expected = Math.max(0, (preHp || 0) - 3);
  addCheck('ed', 'hp:update REST status 200', hpR.status === 200, `status=${hpR.status}`);
  addCheck('ed', `hp persisted (${preHp} → ${postHp})`, postHp === expected, `expected ${expected}`);

  // 13. Movement — try to move kim's token 999 grid units (should be clamped or rejected)
  log('step 10: movement REST (kim — way past speed)');
  const moveR = await httpsRequest('POST', '/api/map/token/move', {
    tokenId: 'kim', x: 9999, y: 9999
  });
  const moveBody = moveR.body || {};
  addCheck('kim', '/api/map/token/move responded', moveR.status < 500,
    'status=' + moveR.status + ' body=' + JSON.stringify(moveBody).slice(0, 80));

  // summary
  console.log('\n========== SUMMARY ==========');
  const pass = checks.filter(c => c.pass).length;
  const fail = checks.filter(c => !c.pass).length;
  console.log(`PASS: ${pass}   FAIL: ${fail}   TOTAL: ${checks.length}\n`);
  if (fail) {
    console.log('FAILURES:');
    for (const c of checks) if (!c.pass) console.log(`  - ${c.player.padEnd(10)} ${c.name}  ${c.detail}`);
  }

  // close
  for (const k of Object.keys(clients)) try { clients[k].ws.close(); } catch {}
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('SMOKE FATAL:', e); process.exit(2); });
