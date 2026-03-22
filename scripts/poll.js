// scripts/poll.js — odpala sie co 5 minut przez GitHub Actions
// Wymaga zmiennych srodowiskowych ustawionych w GitHub Secrets

const crypto = require('crypto');

const ICU_API_KEY    = process.env.ICU_API_KEY;
const ICU_ATHLETE_ID = process.env.ICU_ATHLETE_ID;
const VAPID_PUBLIC   = process.env.VAPID_PUBLIC;
const VAPID_PRIVATE  = process.env.VAPID_PRIVATE;
const GIST_TOKEN     = process.env.GIST_TOKEN;
const GIST_ID        = process.env.GIST_ID;
const MY_ATHLETE_ID  = ICU_ATHLETE_ID;

if (!ICU_API_KEY || !GIST_TOKEN || !GIST_ID) {
  console.error('Brak wymaganych zmiennych srodowiskowych!');
  console.error('Ustaw w GitHub: Settings -> Secrets -> Actions:');
  console.error('  ICU_API_KEY, ICU_ATHLETE_ID, VAPID_PUBLIC, VAPID_PRIVATE, GIST_TOKEN, GIST_ID');
  process.exit(1);
}

// ── Gist DB ───────────────────────────────────────────────
async function gistRead() {
  const r = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
    headers: { Authorization: `Bearer ${GIST_TOKEN}`, 'User-Agent': 'intervals-link' }
  });
  if (!r.ok) throw new Error('Gist read HTTP ' + r.status);
  const j = await r.json();
  const content = j.files['db.json'] && j.files['db.json'].content;
  if (!content) return { subscriptions: {}, seen: {} };
  try { return JSON.parse(content); } catch(e) { return { subscriptions: {}, seen: {} }; }
}

async function gistWrite(data) {
  const r = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${GIST_TOKEN}`,
      'User-Agent': 'intervals-link',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      files: { 'db.json': { content: JSON.stringify(data, null, 2) } }
    })
  });
  if (!r.ok) throw new Error('Gist write HTTP ' + r.status);
}

// ── intervals.icu ─────────────────────────────────────────
async function icuGet(url) {
  const r = await fetch(url, {
    headers: {
      Authorization: 'Basic ' + Buffer.from('API_KEY:' + ICU_API_KEY).toString('base64'),
      Accept: 'application/json'
    }
  });
  if (!r.ok) throw new Error('ICU HTTP ' + r.status + ' ' + url);
  return r.json();
}

// ── Web Push ──────────────────────────────────────────────
function b64url(str) {
  return Buffer.from(str).toString('base64url');
}
function bufToB64url(buf) {
  return Buffer.from(buf).toString('base64url');
}
function b64urlToBuf(s) {
  return Buffer.from(s, 'base64url');
}

async function buildVapidJwt(audience) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64url(JSON.stringify({ aud: audience, exp: now + 86400, sub: 'mailto:push@intervals-link.app' }));
  const sigInput = `${header}.${claims}`;

  const privKey = crypto.createPrivateKey({
    key: Buffer.concat([
      Buffer.from('308141020100301306072a8648ce3d020106082a8648ce3d030107042730250201010420', 'hex'),
      b64urlToBuf(VAPID_PRIVATE)
    ]),
    format: 'der',
    type: 'pkcs8'
  });

  const sig = crypto.sign('SHA256', Buffer.from(sigInput), { key: privKey, dsaEncoding: 'ieee-p1363' });
  return `${sigInput}.${bufToB64url(sig)}`;
}

async function sendWebPush(subscription, payload) {
  const endpoint = subscription.endpoint;
  const audience = new URL(endpoint).origin;
  const jwt = await buildVapidJwt(audience);
  const body = JSON.stringify(payload);

  const r = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `vapid t=${jwt},k=${VAPID_PUBLIC}`,
      'Content-Type': 'application/json',
      TTL: '86400',
      Urgency: 'normal',
    },
    body
  });
  console.log('  Push status:', r.status, payload.title.slice(0, 40));
  return r.status;
}

// ── Main ──────────────────────────────────────────────────
async function main() {
  console.log('=== intervals.icu poll', new Date().toISOString(), '===');

  // Wczytaj dane z Gist
  const db = await gistRead();
  if (!db.subscriptions) db.subscriptions = {};
  if (!db.seen) db.seen = {};

  const subEntries = Object.entries(db.subscriptions);
  if (!subEntries.length) {
    console.log('Brak subskrypcji push — zaloguj sie na stronie i wlacz push.');
    return;
  }

  const days = 3;
  const today = new Date();
  const from = new Date(today); from.setDate(from.getDate() - days);
  const oldest = from.toISOString().slice(0, 10);
  const newest = new Date(today.getTime() + 7 * 86400000).toISOString().slice(0, 10);
  const base = `https://intervals.icu/api/v1/athlete/${ICU_ATHLETE_ID}`;

  if (!db.seen[ICU_ATHLETE_ID]) db.seen[ICU_ATHLETE_ID] = {};
  const seen = db.seen[ICU_ATHLETE_ID];
  const newNotifs = [];

  // 1. Nowe zaplanowane treningi
  try {
    const evs = await icuGet(`${base}/events?oldest=${oldest}&newest=${newest}&category=WORKOUT`);
    for (const ev of (evs || [])) {
      const k = 'w:' + ev.id;
      if (!seen[k]) {
        seen[k] = 1;
        newNotifs.push({
          title: '🏃 Nowy trening: ' + (ev.name || 'Trening'),
          body:  (ev.description || '').replace(/<[^>]*>/g, '').slice(0, 100) || ev.type || '',
          tag:   k
        });
        console.log('  Nowy trening:', ev.name);
      }
    }
  } catch(e) { console.error('  [events]', e.message); }

  // 2. Oceny trenera
  try {
    const acts = await icuGet(`${base}/activities?oldest=${oldest}&newest=${newest}`);
    for (const a of (acts || [])) {
      const note = a.coach_note || a.icu_coach_note || '';
      const tick = a.coach_tick;
      if ((tick != null && tick !== 0) || note.trim()) {
        const k = 't:' + a.id;
        if (!seen[k]) {
          seen[k] = 1;
          newNotifs.push({
            title: '⭐ Ocena ' + (tick ? tick + '/5' : '') + ': ' + (a.name || 'Aktywnosc'),
            body:  note.trim() || 'Ocena trenera: ' + tick + '/5',
            tag:   k
          });
          console.log('  Nowa ocena:', a.name, 'tick:', tick);
        }
      }
    }
  } catch(e) { console.error('  [activities]', e.message); }

  // 3. Wiadomosci — tylko OTRZYMANE (filtruj wlasne)
  try {
    const chats = await icuGet('https://intervals.icu/api/v1/chats');
    const cutoff = new Date(today); cutoff.setDate(cutoff.getDate() - days);
    for (const chat of (chats || [])) {
      if (new Date(chat.updated || 0) < cutoff) continue;
      try {
        const msgs = await icuGet(`https://intervals.icu/api/v1/chats/${chat.id}/messages?limit=5`);
        for (const m of (msgs || [])) {
          // Pominij wiadomosci wyslane przez siebie
          if (m.athlete_id === ICU_ATHLETE_ID || m.athlete_id === MY_ATHLETE_ID) continue;
          const k = 'm:' + (m.id || m.created);
          if (!seen[k]) {
            seen[k] = 1;
            newNotifs.push({
              title: '💬 ' + (m.name || chat.name || 'Nowa wiadomosc'),
              body:  (m.content || m.text || '').replace(/<[^>]*>/g, '').slice(0, 100),
              tag:   k
            });
            console.log('  Nowa wiadomosc od:', m.name, 'w:', chat.name);
          }
        }
      } catch(e) { /* pominij blad dla pojedynczego chatu */ }
    }
  } catch(e) { console.error('  [chats]', e.message); }

  // Zapisz seen do Gist
  db.seen[ICU_ATHLETE_ID] = seen;

  // Wyslij push do wszystkich subskrybentow
  if (newNotifs.length > 0) {
    console.log('  Wysylam', newNotifs.length, 'powiadomien...');
    for (const [subId, subData] of subEntries) {
      if (!subData.subscription || !subData.subscription.endpoint) continue;
      for (const notif of newNotifs) {
        try {
          const status = await sendWebPush(subData.subscription, notif);
          if (status === 410 || status === 404) {
            console.log('  Subskrypcja wygasla, usuwam:', subId);
            delete db.subscriptions[subId];
          }
        } catch(e) { console.error('  Push error:', e.message); }
      }
    }
  } else {
    console.log('  Brak nowych zdarzen.');
  }

  // Zapisz zaktualizowana baze do Gist
  await gistWrite(db);
  console.log('=== Gotowe ===');
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
