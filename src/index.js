import { createSign } from 'crypto';
import { gunzip } from 'zlib';
import { promisify } from 'util';

const gunzipAsync = promisify(gunzip);

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

function summarize(rows) {
  const map = new Map();
  for (const row of rows) {
    const id = row['Apple Identifier'];
    const units = parseInt(row['Units'] ?? '0', 10);
    if (units === 0) continue;
    const title = row['Title'] ?? id;
    const customerPrice = parseFloat(row['Customer Price'] ?? '0');
    const customerCurrency = row['Customer Currency'] ?? 'USD';
    const proceeds = parseFloat(row['Developer Proceeds'] ?? '0');
    const proceedsCurrency = row['Currency of Proceeds'] ?? 'USD';
    if (!map.has(id)) map.set(id, { title, units: 0, rows: [] });
    const entry = map.get(id);
    entry.units += units;
    entry.rows.push({ units, customerPrice, customerCurrency, proceeds, proceedsCurrency });
  }
  return [...map.values()];
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
  const totalUnits = apps.reduce((s, a) => s + a.units, 0);

  let totalGBP = 0;
  const fields = apps.map(app => {
    // Group by price+currency so multiple countries with the same price collapse
    const groups = new Map();
    for (const row of app.rows) {
      const key = `${row.customerCurrency}_${row.customerPrice}`;
      if (!groups.has(key)) groups.set(key, { ...row, units: 0, totalProceeds: 0 });
      const g = groups.get(key);
      g.units += row.units;
      g.totalProceeds += row.proceeds * row.units;
    }

    const lines = [...groups.values()].map(g => {
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
        title: `App Store Sales — ${date}`,
        color: 0x0071e3,
        fields,
        footer: { text: `${totalUnits} total unit${totalUnits !== 1 ? 's' : ''} · ${fmt(totalGBP, 'GBP')} proceeds` },
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

  if (apps.length === 0) {
    console.log(`No sales on ${date}`);
    return;
  }

  await postToDiscord(date, apps);
  console.log(`Posted: ${apps.length} app(s) with sales on ${date}`);
}

main().catch(err => { console.error(err.message); process.exit(1); });
