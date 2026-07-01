import { createSign } from 'crypto';
import { gunzip } from 'zlib';
import { promisify } from 'util';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { fileURLToPath } from 'url';
import path from 'path';

const gunzipAsync = promisify(gunzip);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_PATH = path.join(__dirname, '..', 'state', 'sales-state.json');

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function makeToken() {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(Buffer.from(JSON.stringify({
    alg: 'ES256',
    kid: process.env.ASC_KEY_ID,
    typ: 'JWT',
  })));
  const payload = base64url(Buffer.from(JSON.stringify({
    iss: process.env.ASC_ISSUER_ID,
    iat: now,
    exp: now + 1200,
    aud: 'appstoreconnect-v1',
  })));
  const data = `${header}.${payload}`;
  const sign = createSign('SHA256');
  sign.update(data);
  const key = process.env.ASC_PRIVATE_KEY.replace(/\\n/g, '\n');
  // JWT ES256 requires IEEE P1363 format (r||s), not DER
  const sig = base64url(sign.sign({ key, dsaEncoding: 'ieee-p1363' }));
  return `${data}.${sig}`;
}

async function fetchReport(date) {
  const params = new URLSearchParams({
    'filter[frequency]': 'DAILY',
    'filter[reportType]': 'SALES',
    'filter[reportSubType]': 'SUMMARY',
    'filter[vendorNumber]': process.env.ASC_VENDOR_NUMBER,
    'filter[reportDate]': date,
  });

  const res = await fetch(`https://api.appstoreconnect.apple.com/v1/salesReports?${params}`, {
    headers: {
      Authorization: `Bearer ${makeToken()}`,
      'Accept-Encoding': 'gzip',
    },
  });

  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ASC API ${res.status}: ${body}`);
  }

  const buf = Buffer.from(await res.arrayBuffer());
  return (await gunzipAsync(buf)).toString('utf-8');
}

function parseReport(tsv) {
  const lines = tsv.trim().split('\n');
  const headers = lines[0].split('\t');
  return lines
    .slice(1)
    .filter(l => l.trim())
    .map(line => Object.fromEntries(headers.map((h, i) => [h, line.split('\t')[i] ?? ''])));
}

// Groups rows by app, then by price+currency, so repeated runs can be diffed
// against the previous run's cumulative unit counts per group.
function summarize(rows) {
  const apps = new Map();
  for (const row of rows) {
    const id = row['Apple Identifier'];
    const units = parseInt(row['Units'] ?? '0', 10);
    if (units === 0) continue;
    const title = row['Title'] ?? id;
    const customerPrice = parseFloat(row['Customer Price'] ?? '0');
    const customerCurrency = row['Customer Currency'] ?? 'USD';
    const proceeds = parseFloat(row['Developer Proceeds'] ?? '0');
    const proceedsCurrency = row['Currency of Proceeds'] ?? 'USD';

    if (!apps.has(id)) apps.set(id, { title, groups: new Map() });
    const groups = apps.get(id).groups;
    const key = `${customerCurrency}_${customerPrice}`;
    if (!groups.has(key)) {
      groups.set(key, { customerPrice, customerCurrency, proceedsCurrency, units: 0, totalProceeds: 0 });
    }
    const g = groups.get(key);
    g.units += units;
    g.totalProceeds += proceeds * units;
  }
  return apps;
}

async function loadState() {
  try {
    return JSON.parse(await readFile(STATE_PATH, 'utf-8'));
  } catch {
    return null;
  }
}

async function saveState(date, apps) {
  const serialized = {};
  for (const [id, app] of apps) {
    const groups = {};
    for (const [key, g] of app.groups) groups[key] = g.units;
    serialized[id] = { title: app.title, groups };
  }
  await mkdir(path.dirname(STATE_PATH), { recursive: true });
  await writeFile(STATE_PATH, JSON.stringify({ date, apps: serialized }, null, 2) + '\n');
}

// Returns only the units/proceeds not seen in a previous run for this date.
function diffAgainstPrevious(apps, previousApps) {
  const delta = [];
  for (const [id, app] of apps) {
    const prevGroups = previousApps[id]?.groups ?? {};
    const groups = [];
    for (const [key, g] of app.groups) {
      const prevUnits = prevGroups[key] ?? 0;
      const newUnits = g.units - prevUnits;
      if (newUnits <= 0) continue;
      const proceedsPerUnit = g.totalProceeds / g.units;
      groups.push({
        customerPrice: g.customerPrice,
        customerCurrency: g.customerCurrency,
        proceedsCurrency: g.proceedsCurrency,
        units: newUnits,
        totalProceeds: proceedsPerUnit * newUnits,
      });
    }
    if (groups.length) delta.push({ title: app.title, groups });
  }
  return delta;
}

async function getGBPRates() {
  try {
    const res = await fetch('https://api.frankfurter.app/latest?from=GBP');
    if (!res.ok) return {};
    return (await res.json()).rates ?? {};
  } catch {
    return {};
  }
}

function toGBP(amount, currency, rates) {
  if (currency === 'GBP') return amount;
  const rate = rates[currency];
  return rate != null ? amount / rate : null;
}

function fmt(amount, currency) {
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(amount);
}

async function postToDiscord(date, apps) {
  const gbpRates = await getGBPRates();
  const totalUnits = apps.reduce((s, a) => s + a.groups.reduce((gs, g) => gs + g.units, 0), 0);

  let totalGBP = 0;
  const fields = apps.map(app => {
    const lines = app.groups.map(g => {
      const gbp = toGBP(g.totalProceeds, g.proceedsCurrency, gbpRates);
      if (gbp != null) totalGBP += gbp;
      const priceStr = fmt(g.customerPrice, g.customerCurrency);
      const gbpStr = gbp != null && g.customerCurrency !== 'GBP' ? ` (${fmt(gbp, 'GBP')} proceeds)` : '';
      return `**${g.units}×** ${priceStr}${gbpStr}`;
    });

    return { name: app.title, value: lines.join('\n'), inline: false };
  });

  const res = await fetch(process.env.DISCORD_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      embeds: [{
        title: `New App Store Sales — ${date}`,
        color: 0x0071e3,
        fields,
        footer: { text: `${totalUnits} new unit${totalUnits !== 1 ? 's' : ''} · ${fmt(totalGBP, 'GBP')} proceeds` },
      }],
    }),
  });

  if (!res.ok) throw new Error(`Discord webhook failed: ${res.status}`);
}

async function main() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  const date = d.toISOString().slice(0, 10);

  console.log(`Checking report for ${date}...`);
  const tsv = await fetchReport(date);

  if (!tsv) {
    console.log(`No sales on ${date}`);
    return;
  }

  const apps = summarize(parseReport(tsv));

  if (apps.size === 0) {
    console.log(`No sales on ${date}`);
    return;
  }

  const previous = await loadState();
  const previousApps = previous?.date === date ? previous.apps : {};
  const delta = diffAgainstPrevious(apps, previousApps);

  // Save the full cumulative state now so the next run's diff is correct,
  // regardless of whether there was anything new to post this time.
  await saveState(date, apps);

  if (delta.length === 0) {
    console.log(`No new sales since last check on ${date}`);
    return;
  }

  await postToDiscord(date, delta);
  console.log(`Posted: new sales in ${delta.length} app(s) on ${date}`);
}

main().catch(err => { console.error(err.message); process.exit(1); });
