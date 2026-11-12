'use strict';

// Writes a self-refreshing progress page (progress.html) for the PC audio checker,
// including the cloud scan's progress (read from GitHub Pages + the public GitHub API).

const fs = require('fs');

const PAGES_STATUS = process.env.PAGES_STATUS_URL || 'https://gokef.github.io/turkish-audio-finder/status.json';
const RUNS_API = process.env.RUNS_API_URL || 'https://api.github.com/repos/Gokef/turkish-audio-finder/actions/runs?per_page=5';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const dur = (ms) => {
  if (!(ms > 0)) return '0m';
  const m = Math.round(ms / 60000);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
};
const clock = (t) => (t ? new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '–');

function createProgress({ file, deadline, startedAt = Date.now() }) {
  const s = {
    phase: 'Starting',
    detail: '',
    queueTotal: 0,
    queueDone: 0,
    session: { yes: 0, no: 0, unknown: 0 },
    knownBefore: 0,
    current: new Map(),
    recent: [],
    lastPush: null,
    nextCheck: null,
    cloud: null,
    runs: null,
    totals: null,
  };

  async function pollCloud() {
    try {
      s.cloud = await (await fetch(`${PAGES_STATUS}?t=${Date.now()}`, { signal: AbortSignal.timeout(15000) })).json();
    } catch { /* keep last */ }
    try {
      const j = await (await fetch(RUNS_API, { headers: { 'user-agent': 'taf-progress' }, signal: AbortSignal.timeout(15000) })).json();
      s.runs = (j.workflow_runs || []).filter((r) => r.name === 'scan-and-publish');
    } catch { /* keep last */ }
  }

  function render() {
    const now = Date.now();
    const checkedSession = s.session.yes + s.session.no + s.session.unknown;
    const rate = checkedSession / Math.max(1, (now - startedAt) / 3600000);
    const left = Math.max(0, s.queueTotal - s.queueDone);
    const pct = s.queueTotal ? Math.round((s.queueDone / s.queueTotal) * 100) : 0;

    const c = s.cloud || {};
    const cand = c.candidates ? c.candidates.movie + c.candidates.series : 10700;
    const scanned = c.scannedTitles || 0;
    const scanPct = Math.min(100, Math.round((scanned / cand) * 100));
    const sizes = c.catalogSizes || {};
    const run = (s.runs || [])[0];
    const runText = !run ? 'unknown'
      : run.status === 'completed' ? `idle — last run ${run.conclusion}, next one within 2h`
        : `scanning now (started ${clock(run.run_started_at || run.created_at)}, publishes ~${clock(new Date(run.run_started_at || run.created_at).getTime() + 115 * 60000)})`;

    const cur = [...s.current.values()].map((x) => `<li><b>${esc(x.name)}</b><br><small>${esc(x.release)} · ${Math.round((now - x.since) / 1000)}s</small></li>`).join('')
      || '<li><small>nothing right now</small></li>';
    const rec = s.recent.slice(0, 15).map((r) => `<tr><td>${r.v === 1 ? '✅' : r.v === 0 ? '❌' : '❔'}</td><td>${esc(r.name)}<br><small>${esc(r.release)}</small></td><td><small>${esc(r.audio || r.err || '')}</small></td><td><small>${clock(r.at)}</small></td></tr>`).join('');

    const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="5">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${pct}% · Turkish Audio Finder</title>
<style>:root{color-scheme:dark}body{margin:0;background:#0f1115;color:#e8eaf0;font:15px/1.45 system-ui,sans-serif;padding:16px}
main{max-width:760px;margin:0 auto}h1{font-size:1.3rem;margin:0 0 4px}h2{font-size:1rem;margin:0 0 10px;color:#9aa3b2;font-weight:600}
.card{background:#181b22;border-radius:12px;padding:16px;margin:12px 0}.bar{height:12px;background:#2b303b;border-radius:6px;overflow:hidden;margin:8px 0}
.bar i{display:block;height:100%;background:#e30a17}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px}
.n{font-size:1.5rem;font-weight:700}small,.m{color:#9aa3b2}ul{margin:0;padding-left:18px}li{margin:4px 0}table{width:100%;border-collapse:collapse}
td{padding:6px 4px;border-top:1px solid #2b303b;vertical-align:top}.ph{display:inline-block;background:#2b303b;border-radius:20px;padding:2px 10px;font-size:.85rem}</style></head>
<body><main><h1>🇹🇷 Turkish Audio Finder — progress</h1>
<div class="m">Updated ${clock(now)} · refreshes every 5 s · checker stops at ${clock(deadline)} (${dur(deadline - now)} left)</div>

<div class="card"><h2>Audio check on this PC</h2>
<span class="ph">${esc(s.phase)}</span> <small>${esc(s.detail)}</small>
<div class="bar"><i style="width:${pct}%"></i></div>
<small>${s.queueDone} of ${s.queueTotal} releases in this batch · ${left} left${rate > 0 && left ? ` · ~${dur((left / rate) * 3600000)} at ${Math.round(rate)}/h` : ''}</small>
<div class="grid" style="margin-top:12px">
<div><div class="n">${s.session.yes}</div><small>✅ Turkish audio found</small></div>
<div><div class="n">${s.session.no}</div><small>❌ no Turkish audio (hidden)</small></div>
<div><div class="n">${s.session.unknown}</div><small>❔ couldn't tell (retried later)</small></div>
<div><div class="n">${s.knownBefore + checkedSession}</div><small>releases checked in total</small></div>
</div>
<p class="m" style="margin-bottom:0">Results uploaded: ${s.lastPush ? clock(s.lastPush) : 'not yet'} · uploads every 30 min${s.nextCheck ? ` · next look for new titles ${clock(s.nextCheck)}` : ''}</p></div>

<div class="card"><h2>Checking right now</h2><ul>${cur}</ul></div>

<div class="card"><h2>Cloud scan (GitHub)</h2>
<div class="bar"><i style="width:${scanPct}%"></i></div>
<small>${scanned} of ~${cand} titles scanned (${scanPct}%) · ${esc(runText)}</small>
<p style="margin:10px 0 0">In your Stremio catalogs now: <b>${sizes['default:movie'] ?? '–'}</b> movies · <b>${sizes['default:series'] ?? '–'}</b> series
<br><small>Verified-only list: ${sizes['verified:movie'] ?? 0} movies · ${sizes['verified:series'] ?? 0} series · last published ${clock(c.builtAt)}</small></p></div>

<div class="card"><h2>Latest results</h2><table>${rec || '<tr><td><small>none yet</small></td></tr>'}</table></div>
</main></body></html>`;
    try {
      fs.writeFileSync(file, html);
    } catch { /* ignore */ }
  }

  pollCloud().then(render);
  const t1 = setInterval(render, 3000);
  const t2 = setInterval(pollCloud, 120000);
  render();

  return {
    phase(p, detail = '') { s.phase = p; s.detail = detail; render(); },
    batch(total, knownBefore) { s.queueTotal = total; s.queueDone = 0; s.knownBefore = knownBefore; },
    start(key, name, release) { s.current.set(key, { name, release, since: Date.now() }); },
    finish(key, name, release, r) {
      s.current.delete(key);
      s.queueDone++;
      s.session[r.v === 1 ? 'yes' : r.v === 0 ? 'no' : 'unknown']++;
      s.recent.unshift({ v: r.v, name, release, audio: (r.a || []).join(', '), err: r.e, at: Date.now() });
      s.recent.length = Math.min(s.recent.length, 30);
    },
    pushed() { s.lastPush = Date.now(); },
    nextCheck(t) { s.nextCheck = t; },
    stop(msg) { s.phase = msg; s.current.clear(); render(); clearInterval(t1); clearInterval(t2); },
  };
}

module.exports = { createProgress };
