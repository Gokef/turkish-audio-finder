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
const { createProgress } = require('./progress');

const ROOT = path.resolve(__dirname, '..');
const SERVER = process.env.STREMIO_SERVER || 'http://127.0.0.1:11470';
const PAGES_DB = process.env.PAGES_DB_URL || 'https://gokef.github.io/turkish-audio-finder/data/db.json.gz';
const PROGRESS_FILE = process.env.PROGRESS_FILE || path.join(ROOT, 'progress.html');
const VERIFIED_FILE = process.env.VERIFIED_FILE || path.join(ROOT, 'verified.json');
const DAY = 86400000;
const RETRY_UNKNOWN_DAYS = 1 / 24; // retry "unknown" (no peers yet) every hour: peers come and go
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
// How long one pass runs before re-reading scan results (new titles), and how long to wait when idle.
// With a PC-side scan feeding --db, use short values so new titles are picked up within minutes.
const PASS_MINUTES = Number(arg('pass-minutes', 30));
const IDLE_MINUTES = Number(arg('idle-minutes', 20));
// Upload results at most this often (a short pass length shouldn't mean a commit every few minutes).
const PUSH_EVERY_MINUTES = Number(arg('push-minutes', 30));
let lastPushAt = 0;
// --retry-unknown: retry every "couldn't tell" result from before this run, regardless of age.
const RETRY_ALL_UNKNOWN = argv.includes('--retry-unknown');
const STARTED = Date.now();
// Releases with fewer seeders (as reported by Torrentio at scan time) are skipped as dead.
const MIN_SEEDERS = Number(arg('min-seeders', 2));
const HEALTHY_SEEDERS = 5;
// Releases whose only Turkish evidence is a 🇹🇷 flag in a long flag list had Turkish audio in ~3% of
// checks (usually the flag comes from subtitles). They are checked last, only when nothing better is
// queued; --no-weak skips them entirely.
const INCLUDE_WEAK = !argv.includes('--no-weak');
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

/** Kill Stremio's streaming server and start a fresh one (the Stremio window itself stays open). */
async function refreshServer(state, P, why) {
  P.phase("Restarting Stremio's torrent server", why);
  log(`restarting Stremio streaming server (${why})`);
  if (state.child) { try { state.child.kill(); } catch {} state.child = null; }
  try { execFileSync('taskkill', ['/IM', 'stremio-runtime.exe', '/F'], { stdio: 'ignore' }); } catch {}
  await sleep(4000);
  for (let i = 0; i < 10 && !(await serverUp()); i++) await sleep(1000); // the Stremio app may respawn it
  state.child = await ensureServer();
  state.refreshedAt = Date.now();
}

/** Wait for Stremio's server to come back (e.g. app restarted); start it ourselves after 2 minutes. */
async function waitForServer(state, P) {
  if (state.waiting) return state.waiting;
  state.waiting = (async () => {
    P.phase("Waiting for Stremio's torrent server", 'it went offline (Stremio restarted or closed?)');
    log("Stremio server unreachable; waiting");
    for (let i = 0; i < 24; i++) {
      if (await serverUp()) break;
      await sleep(5000);
    }
    if (!(await serverUp())) state.child = await ensureServer();
    log('Stremio server is back');
    P.phase('Checking audio tracks', `${CONCURRENCY} releases at a time`);
  })().finally(() => { state.waiting = null; });
  return state.waiting;
}

async function loadDb() {
  const local = arg('db', null);
  let buf;
  if (local) buf = fs.readFileSync(local);
  for (let i = 1; !buf; i++) {
    try {
      buf = Buffer.from(await (await fetch(PAGES_DB, { signal: AbortSignal.timeout(60000) })).arrayBuffer());
    } catch (e) {
      if (i >= 5) throw e;
      log(`scan results download failed (${e.cause?.code || e.message}); retrying`);
      await sleep(20000 * i);
    }
  }
  return JSON.parse(zlib.gunzipSync(buf).toString('utf8'));
}

// A torrent with no peer at all after this long is dead for now: give the slot to the next one.
const NO_PEER_SECONDS = Number(arg('no-peer-seconds', 45));
// Stremio's torrent engine slowly chokes after hundreds of torrents (healthy torrents stop finding
// peers). Restart it every REFRESH_MINUTES, and right away after a pass where nothing could be read.
const REFRESH_MINUTES = Number(arg('refresh-minutes', 0)); // 0 = never (restarting interrupts the Stremio app)

/** Resolves 'no peers' if the engine has found no peer for this torrent after NO_PEER_SECONDS. */
function watchPeers(ih, ctl) {
  let stop = false;
  const p = (async () => {
    const t0 = Date.now();
    while (!stop) {
      await sleep(5000);
      if (stop) return;
      if (Date.now() - t0 < NO_PEER_SECONDS * 1000) continue;
      try {
        const st = await fetch(`${SERVER}/${ih}/stats.json`, { signal: AbortSignal.timeout(4000) }).then((r) => r.json());
        if (st && !st.peers && !st.swarmConnections && !(st.files && st.files.length)) { ctl.abort(new Error('NoPeers')); return; }
        if (st && (st.peers || (st.files && st.files.length))) return; // alive: let the normal timeouts apply
      } catch { /* stats not ready yet */ }
    }
  })();
  return () => { stop = true; return p; };
}

async function probeRelease(x, { patient = false } = {}) {
  const ih = x.h.toLowerCase();
  const ctl = new AbortController();
  const stopWatch = watchPeers(ih, ctl);
  try {
    const created = await fetch(`${SERVER}/${ih}/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ torrent: { infoHash: ih }, peerSearch: { sources: [`dht:${ih}`, ...TRACKERS.map((t) => `tracker:${t}`)], min: 20, max: 80 } }),
      // Seeded torrents deliver their metadata within seconds; don't block a slot on dead ones.
      signal: AbortSignal.any([ctl.signal, AbortSignal.timeout(patient ? 150000 : 45000)]),
    }).then((r) => r.json());
    stopWatch();
    let idx = x.i;
    if (!Number.isInteger(idx)) {
      // Single-file torrent or unknown index: take the largest file.
      const files = created.files || [];
      idx = files.reduce((best, f, i) => (f.length > (files[best] || { length: -1 }).length ? i : best), 0);
    }
    const media = `${SERVER}/${ih}/${idx}`;
    const res = await fetch(`${SERVER}/hlsv2/probe?mediaURL=${encodeURIComponent(media)}`, { signal: AbortSignal.timeout(patient ? 120000 : 60000) });
    if (!res.ok) return { v: -1, a: [], e: `probe HTTP ${res.status}` };
    return classifyProbe(await res.json());
  } catch (e) {
    if (ctl.signal.aborted) return { v: -1, a: [], e: 'no peers' };
    // Stremio's server itself is unreachable (app restarting/closed): not a result, retry later.
    if (e.name !== 'TimeoutError' && !(await serverUp())) return null;
    return { v: -1, a: [], e: e.name === 'TimeoutError' ? 'timeout (no peers?)' : e.message };
  } finally {
    stopWatch();
    fetch(`${SERVER}/${ih}/remove`).catch(() => {});
  }
}

/** Titles with at least one release whose Turkish audio track was confirmed. */
function confirmedTitles(db, verified) {
  const out = [];
  for (const [id, rec] of Object.entries(db.titles)) {
    if (!rec.r || !rec.m) continue;
    let at = 0;
    for (const lr of Object.values(rec.r)) {
      for (const x of lr.x || []) {
        const v = verified[releaseKey(x)];
        if (v && v.v === 1) at = Math.max(at, v.at || 0);
      }
    }
    if (at) out.push({ id, type: rec.t, name: rec.m.name, year: rec.m.releaseInfo, poster: rec.m.poster, at });
  }
  return out;
}

function buildQueue(db, verified) {
  const now = Date.now();
  const titles = Object.entries(db.titles)
    .filter(([, r]) => r.r && r.m)
    .sort((a, b) => (a[1].m.rank ?? 1e9) - (b[1].m.rank ?? 1e9));
  const items = [];
  for (const [id, rec] of titles) {
    for (const lr of Object.values(rec.r)) {
      for (const x of lr.x || []) {
        const v = verified[releaseKey(x)];
        const retryNow = v && v.v === -1 && (now - v.at >= RETRY_UNKNOWN_DAYS * DAY * 2 ** Math.min((v.n || 1) - 1, 5) || (RETRY_ALL_UNKNOWN && v.at < STARTED));
        if (v && !retryNow) continue;
        if ((x.sd || 0) < MIN_SEEDERS) continue; // dead torrent: skip
        const weak = x.t < 2 && !x.tf;
        if (weak && !INCLUDE_WEAK) continue; // flag-only: almost never real Turkish audio
        items.push({ id, type: rec.t, name: rec.m.name, year: rec.m.releaseInfo, poster: rec.m.poster, x, retry: !!v, weak });
      }
    }
  }
  // Order:
  //  1. titles not confirmed yet before titles that already have a confirmed release
  //  2. one release per title first (each title's best candidate), so new titles reach the list fast
  //  3. well-seeded first, never-tried before retries, "Dual Audio / 🇬🇧 / 🇹🇷" label, confidence, seeders
  const healthy = (it) => ((it.x.sd || 0) >= HEALTHY_SEEDERS ? 1 : 0);
  const quality = (a, b) => healthy(b) - healthy(a) || a.retry - b.retry || (b.x.tf || 0) - (a.x.tf || 0)
    || b.x.t - a.x.t || (b.x.sd || 0) - (a.x.sd || 0);
  const confirmed = new Set(confirmedTitles(db, verified).map((c) => c.id));
  const byTitle = new Map();
  for (const it of items) (byTitle.get(it.id) || byTitle.set(it.id, []).get(it.id)).push(it);
  for (const list of byTitle.values()) list.sort(quality).forEach((it, i) => { it.nth = i; });
  // Slow ones last: never-tried before retries of peerless releases, strong before weak,
  // well-seeded (5+) before low-seeded; then unconfirmed titles, one release per title first.
  items.sort((a, b) => a.retry - b.retry || a.weak - b.weak || healthy(b) - healthy(a)
    || confirmed.has(a.id) - confirmed.has(b.id) || a.nth - b.nth || quality(a, b));
  return items;
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Network git commands are retried: some home DNS servers fail intermittently. */
function gitRetry(args, tries = 5) {
  for (let i = 1; ; i++) {
    try {
      return execFileSync('git', args, { cwd: ROOT, stdio: 'pipe' }).toString().trim();
    } catch (e) {
      if (i >= tries) throw e;
      sleepSync(15000 * i);
    }
  }
}

function gitPublish() {
  const git = (...a) => execFileSync('git', a, { cwd: ROOT, stdio: 'pipe' }).toString().trim();
  try {
    git('add', 'verified.json');
    if (git('status', '--porcelain', 'verified.json')) git('commit', '-m', 'Update audio verification results');
    // Push whenever local commits exist, including ones whose earlier push failed.
    gitRetry(['fetch', 'origin', 'main']);
    if (git('rev-list', '--count', 'origin/main..HEAD') === '0') return log('nothing to push');
    git('rebase', '-X', 'theirs', 'origin/main');
    gitRetry(['push', 'origin', 'HEAD:main']);
    log('pushed verified.json');
    return true;
  } catch (e) {
    log('git publish failed:', (e.stderr || e.message).toString().slice(0, 300));
    try { git('rebase', '--abort'); } catch { /* not rebasing */ }
  }
}

async function pass(deadline, state, P) {
  P.phase('Looking for new titles', 'downloading the latest scan results');
  if (PUSH) {
    try {
      gitRetry(['pull', '--rebase', '--autostash', 'origin', 'main'], 3);
    } catch (e) {
      log('git pull failed (continuing):', (e.stderr || e.message).toString().slice(0, 200));
    }
  }
  const verified = loadVerified(VERIFIED_FILE);
  const db = await loadDb();
  const queue = buildQueue(db, verified);
  P.setConfirmed(confirmedTitles(db, verified));
  log(`db: ${Object.keys(db.titles).length} titles; ${queue.length} releases to verify; ${Object.keys(verified).length} already known`);
  const perTitle = {};
  for (const it of queue) perTitle[it.id] = (perTitle[it.id] || 0) + 1;
  P.batch(queue.length, Object.keys(verified).length, perTitle);
  if (!queue.length) return 0;

  if (!state.refreshedAt) state.refreshedAt = Date.now();
  if (REFRESH_MINUTES > 0 && state.lastPassDead) await refreshServer(state, P, 'last pass could not read any torrent');
  else if (REFRESH_MINUTES > 0 && Date.now() - state.refreshedAt > REFRESH_MINUTES * 60000) await refreshServer(state, P, `routine, every ${REFRESH_MINUTES} min`);
  else if (!state.child) {
    P.phase('Starting Stremio server');
    state.child = await ensureServer();
  }
  P.phase('Checking audio tracks', `${CONCURRENCY} releases at a time`);
  // In loop mode, publish results at least every 30 minutes.
  const passEnd = LOOP ? Math.min(deadline, Date.now() + PASS_MINUTES * 60000) : deadline;
  const save = () => fs.writeFileSync(VERIFIED_FILE, JSON.stringify(verified, null, 0).replace(/},"/g, '},\n"'));
  let idx = 0;
  let done = 0;
  const stats = { yes: 0, no: 0, unknown: 0 };
  const worker = async () => {
    while (idx < queue.length && Date.now() < passEnd) {
      const item = queue[idx++];
      const { name, x } = item;
      const k = releaseKey(x);
      P.start(k, name, x.nm, item);
      const r = await probeRelease(x, { patient: item.retry });
      if (r === null) {
        P.drop(k);
        queue.push(item); // check again once the server is back
        await waitForServer(state, P);
        continue;
      }
      P.finish(k, name, x.nm, r, item);
      if (r.v === 1) P.addConfirmed(item.id, item.type, name, item.year, item.poster);
      const prev = verified[releaseKey(x)];
      verified[releaseKey(x)] = { ...r, at: Date.now(), ...(r.v === -1 ? { n: ((prev && prev.v === -1 && prev.n) || 0) + 1 } : {}) };
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
  state.lastPassDead = done >= 20 && stats.yes + stats.no === 0;
  const pushDue = !LOOP || Date.now() - lastPushAt >= PUSH_EVERY_MINUTES * 60000 || Date.now() >= deadline - 60000;
  if (PUSH && pushDue) {
    P.phase('Uploading results to GitHub');
    if (gitPublish()) P.pushed();
    lastPushAt = Date.now();
  }
  return done;
}

(async () => {
  const deadline = Date.now() + MINUTES * 60000;
  const state = { child: null };
  const P = createProgress({ file: PROGRESS_FILE, deadline });
  log('progress page:', PROGRESS_FILE);
  try {
    do {
      const n = await pass(deadline, state, P);
      if (LOOP && Date.now() < deadline && !n) {
        log(`nothing new to verify; waiting ${IDLE_MINUTES} min for new scan results`);
        P.phase('Waiting for new scan results', 'the cloud scan publishes new titles every hour');
        P.nextCheck(Date.now() + IDLE_MINUTES * 60000);
        await sleep(Math.min(IDLE_MINUTES * 60000, Math.max(0, deadline - Date.now())));
      }
    } while (LOOP && Date.now() < deadline);
  } finally {
    if (state.child) state.child.kill();
    P.stop('Finished for tonight');
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
