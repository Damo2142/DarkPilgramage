#!/usr/bin/env node
/**
 * Alexa Cookie Setup
 * Run this once to authenticate with Amazon and save the cookie.
 *
 * Usage: node services/audio/alexa-setup.js
 *
 * This starts a proxy on port 3201. Open http://<your-ip>:3201 in a browser,
 * log in to your Amazon account, and the cookie will be saved to alexa-cookie.json.
 */

const alexaCookie = require('alexa-cookie2');
const fs = require('fs');
const path = require('path');

const cookieFile = path.join(__dirname, '..', '..', 'alexa-cookie.json');

console.log('');
console.log('  Alexa Cookie Setup');
console.log('  ==================');
console.log('');

// Check if we already have a cookie — test it
if (fs.existsSync(cookieFile)) {
  console.log('  Found existing alexa-cookie.json — delete it to re-authenticate.');
  console.log('  Or run:  rm alexa-cookie.json && node services/audio/alexa-setup.js');
  console.log('');
  process.exit(0);
}

console.log('  Starting proxy login server on port 3201...');
console.log('');
console.log('  Open http://192.168.0.198:3201 in your browser');
console.log('  Log in with your Amazon account');
console.log('  The cookie will be saved automatically');
console.log('');

const options = {
  proxyOwnIp: '192.168.0.198',
  proxyPort: 3201,
  proxyLogLevel: 'warn',
  amazonPage: 'amazon.com',
  setupProxy: true,
  proxyListenBind: '0.0.0.0'
};

alexaCookie.generateAlexaCookie('', options, (err, result) => {
  if (err) {
    // "Please open" message means proxy is running — NOT a real error
    if (err.message && err.message.includes('Please open')) {
      console.log('  Proxy is running! Waiting for you to log in...');
      console.log('');
      // Don't exit — keep proxy alive
      return;
    }
    console.error('  Error:', err.message || err);
    process.exit(1);
    return;
  }

  console.log('');
  console.log('  Login successful!');

  // Save cookie
  const cookieData = {
    cookie: result.cookie,
    macDms: result.macDms || {}
  };
  fs.writeFileSync(cookieFile, JSON.stringify(cookieData, null, 2));
  console.log(`  Cookie saved to ${cookieFile}`);
  console.log('');
  console.log('  Now restart Docker:');
  console.log('    docker compose build --no-cache && docker compose up -d');
  console.log('');
  process.exit(0);
});

// Keep the process alive while waiting for browser login
process.on('SIGINT', () => {
  console.log('\n  Setup cancelled.');
  process.exit(0);
});
