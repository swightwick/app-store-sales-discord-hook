// Run once to find your vendor number:
// ASC_ISSUER_ID=xxx ASC_KEY_ID=xxx ASC_PRIVATE_KEY="$(cat key.p8)" node find-vendor.js

import { createSign } from 'crypto';

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function makeToken() {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(Buffer.from(JSON.stringify({ alg: 'ES256', kid: process.env.ASC_KEY_ID, typ: 'JWT' })));
  const payload = base64url(Buffer.from(JSON.stringify({ iss: process.env.ASC_ISSUER_ID, iat: now, exp: now + 1200, aud: 'appstoreconnect-v1' })));
  const data = `${header}.${payload}`;
  const sign = createSign('SHA256');
  sign.update(data);
  const sig = base64url(sign.sign(process.env.ASC_PRIVATE_KEY.replace(/\\n/g, '\n')));
  return `${data}.${sig}`;
}

const res = await fetch('https://api.appstoreconnect.apple.com/v1/salesReports?filter[frequency]=DAILY&filter[reportType]=SALES&filter[reportSubType]=SUMMARY&filter[vendorNumber]=00000000&filter[reportDate]=2026-01-01', {
  headers: { Authorization: `Bearer ${makeToken()}` },
});

const body = await res.text();

// The error message from Apple contains your real vendor number(s)
const match = body.match(/\d{8,}/g);
console.log('Raw response:', body);
if (match) console.log('\nPossible vendor numbers found:', [...new Set(match)]);
