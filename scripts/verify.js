'use strict';

// Verifies the REAL audio tracks of candidate releases using Stremio's own streaming server
// (http://127.0.0.1:11470, part of the Stremio desktop app). For each release it joins the
// torrent, lets ffprobe read the file header (a few MB), records the audio languages, and
// removes the torrent again. Results go to verified.json, which is committed and pushed so
// the GitHub Actions build can hide releases without Turkish audio.
//
//   node scripts/verify.js [--minutes 90] [--concurrency 3] [--no-push] [--db path/to/db.json.gz]
//   node scripts/verify.js --loop --minutes 600     # overnight: keep picking up new scan results

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawn, execFileSync } = require('child_process');
const { releaseKey, loadVerified, classifyProbe } = require('../src/verification');

const ROOT = path.resolve(__dirname, '..');
const SERVER = process.env.STREMIO_SERVER || 'http://127.0.0.1:11470';
const PAGES_DB = process.env.PAGES_DB_URL || 'https://gokef.github.io/turkish-audio-finder/data/db.json.gz';
const VERIFIED_FILE = process.env.VERIFIED_FILE || path.join(ROOT, 'verified.json');
const DAY = 86400000;
const RETRY_UNKNOWN_DAYS = 0.25; // retry "unknown" (no peers yet) after 6 hours
const TRACKERS = ['udp://tracker.opentrackr.org:1337/announce', 'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce', 'udp://open.demonii.com:1337/announce',
  'udp://exodus.desync.com:6969/announce', 'udp://tracker.qu.ax:6969/announce', 'udp://explodie.org:6969/announce',
  'udp://tracker.dler.org:6969/announce'];

const argv = process.argv.slice(2);
const arg = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const MINUTES = Number(arg('minutes', 90));
const CONCURRENCY = Number(arg('concurrency', 3));
const PUSH = !argv.includes('--no-push');
const LOOP = argv.includes('--loop');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function serverUp() {
  try {
    const r = await fetch(`${SERVER}/settings`, { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch {
    return false;
  }
}

/** Start Stremio's streaming server headless if the app isn't running. Returns the child or null. */
async function ensureServer() {
  if (await serverUp()) return null;
  const dir = process.env.STREMIO_DIR || path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Stremio');
  const runtime = path.join(dir, 'stremio-runtime.exe');
  if (!fs.existsSync(runtime)) throw new Error(`Stremio not found at ${dir} (set STREMIO_DIR)`);
  log('starting Stremio streaming server');
  const child = spawn(runtime, ['server.js'], { cwd: dir, detached: false, stdio: 'ignore', windowsHide: true });
  for (let i = 0; i < 40; i++) {
    await sleep(1000);
    if (await serverUp()) return child;
  }
  child.kill();
  throw new Error('Stremio streaming server did not start');
}

async function loadDb() {
  const local = arg('db', null);
  const buf = local ? fs.readFileSync(local) : Buffer.from(await (await fetch(PAGES_DB, { signal: AbortSignal.timeout(60000) })).arrayBuffer());
  return JSON.parse(zlib.gunzipSync(buf).toString('utf8'));
}

async function probeRelease(x) {
  const ih = x.h.toLowerCase();
  try {
    const created = await fetch(`${SERVER}/${ih}/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ torrent: { infoHash: ih }, peerSearch: { sources: [`dht:${ih}`, ...TRACKERS.map((t) => `tracker:${t}`)], min: 20, max: 80 } }),
      signal: AbortSignal.timeout(120000),
    }).then((r) => r.json());
    let idx = x.i;
    if (!Number.isInteger(idx)) {
      // Single-file torrent or unknown index: take the largest file.
      const files = created.files || [];
      idx = files.reduce((best, f, i) => (f.length > (files[best] || { length: -1 }).length ? i : best), 0);
    }
    const media = `${SERVER}/${ih}/${idx}`;
    const res = await fetch(`${SERVER}/hlsv2/probe?mediaURL=${encodeURIComponent(media)}`, { signal: AbortSignal.timeout(90000) });
    if (!res.ok) return { v: -1, a: [], e: `probe HTTP ${res.status}` };
    return classifyProbe(await res.json());
  } catch (e) {
    return { v: -1, a: [], e: e.name === 'TimeoutError' ? 'timeout (no peers?)' : e.message };
  } finally {
    fetch(`${SERVER}/${ih}/remove`).catch(() => {});
  }
}

function buildQueue(db, verified) {
  const now = Date.now();
  const titles = Object.entries(db.titles)
    .filter(([, r]) => r.r && r.m)
    .sort((a, b) => (a[1].m.rank ?? 1e9) - (b[1].m.rank ?? 1e9));
  const strong = [];
  const weak = [];
  for (const [id, rec] of titles) {
    for (const lr of Object.values(rec.r)) {
      for (const x of lr.x || []) {
        const v = verified[releaseKey(x)];
        if (v && (v.v !== -1 || now - v.at < RETRY_UNKNOWN_DAYS * DAY)) continue;
        if (!x.sd) continue; // no seeders -> cannot probe
        (x.t >= 2 ? strong : weak).push({ id, name: rec.m.name, x });
      }
    }
  }
  // Releases that put a title in the catalog first, then weak ones (a pass can promote them).
  return [...strong, ...weak];
}

function gitPublish() {
  const git = (...a) => execFileSync('git', a, { cwd: ROOT, stdio: 'pipe' }).toString().trim();
  try {
    git('add', 'verified.json');
    if (!git('status', '--porcelain', 'verified.json')) return log('nothing to push');
    git('commit', '-m', 'Update audio verification results');
    git('pull', '--rebase', '-X', 'theirs', 'origin', 'main');
    git('push', 'origin', 'HEAD:main');
    log('pushed verified.json');
  } catch (e) {
    log('git publish failed:', (e.stderr || e.message).toString().slice(0, 300));
  }
}

async function pass(deadline, state) {
  if (PUSH) {
    try {
      execFileSync('git', ['pull', '--rebase', 'origin', 'main'], { cwd: ROOT, stdio: 'pipe' });
    } catch (e) {
      log('git pull failed (continuing):', (e.stderr || e.message).toString().slice(0, 200));
    }
  }
  const verified = loadVerified(VERIFIED_FILE);
  const db = await loadDb();
  const queue = buildQueue(db, verified);
  log(`db: ${Object.keys(db.titles).length} titles; ${queue.length} releases to verify; ${Object.keys(verified).length} already known`);
  if (!queue.length) return 0;

  if (!state.child) state.child = await ensureServer();
  // In loop mode, publish results at least every 30 minutes.
  const passEnd = LOOP ? Math.min(deadline, Date.now() + 30 * 60000) : deadline;
  const save = () => fs.writeFileSync(VERIFIED_FILE, JSON.stringify(verified, null, 0).replace(/},"/g, '},\n"'));
  let idx = 0;
  let done = 0;
  const stats = { yes: 0, no: 0, unknown: 0 };
  const worker = async () => {
    while (idx < queue.length && Date.now() < passEnd) {
      const { name, x } = queue[idx++];
      const r = await probeRelease(x);
      verified[releaseKey(x)] = { ...r, at: Date.now() };
      stats[r.v === 1 ? 'yes' : r.v === 0 ? 'no' : 'unknown']++;
      log(`${r.v === 1 ? 'TR ✓' : r.v === 0 ? 'no TR' : '  ?  '} | ${name} | ${x.nm.slice(0, 70)} | ${r.a.join(',')}${r.e ? ' | ' + r.e : ''}`);
      if (++done % 10 === 0) save();
    }
  };
  try {
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  } finally {
    save();
  }
  log(`pass done: ${done} probed`, JSON.stringify(stats));
  if (PUSH) gitPublish();
  return done;
}

(async () => {
  const deadline = Date.now() + MINUTES * 60000;
  const state = { child: null };
  try {
    do {
      const n = await pass(deadline, state);
      if (LOOP && Date.now() < deadline && !n) {
        log('nothing new to verify; waiting 20 min for new scan results');
        await sleep(Math.min(20 * 60000, Math.max(0, deadline - Date.now())));
      }
    } while (LOOP && Date.now() < deadline);
  } finally {
    if (state.child) state.child.kill();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
