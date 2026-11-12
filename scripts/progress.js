'use strict';

// Live progress page for the PC audio checker (plus the cloud scan's progress).
//
// progress.html is written once; the checker rewrites progress-data.js every 2 s. The page
// re-loads that small script in place (works from file://, no full-page refresh, so scrolling
// and the selected tab stay put).

const fs = require('fs');
const path = require('path');

const PAGES_STATUS = process.env.PAGES_STATUS_URL || 'https://gokef.github.io/turkish-audio-finder/status.json';
const RUNS_API = process.env.RUNS_API_URL || 'https://api.github.com/repos/Gokef/turkish-audio-finder/actions/runs?per_page=5';

function createProgress({ file, deadline, startedAt = Date.now() }) {
  const dataFile = path.join(path.dirname(file), 'progress-data.js');
  const s = {
    phase: 'Starting',
    detail: '',
    queueTotal: 0,
    queueDone: 0,
    titleTotal: 0,
    titlesDone: 0,
    titleLeft: new Map(),
    focus: null,
    session: { yes: 0, no: 0, unknown: 0 },
    knownBefore: 0,
    current: new Map(),
    recent: [],
    confirmed: new Map(),
    lastPush: null,
    nextCheck: null,
    cloud: null,
    runs: null,
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

  function snapshot() {
    const c = s.cloud || {};
    const run = (s.runs || [])[0];
    return {
      now: Date.now(),
      startedAt,
      deadline,
      phase: s.phase,
      detail: s.detail,
      queueTotal: s.queueTotal,
      queueDone: s.queueDone,
      titleTotal: s.titleTotal,
      titlesDone: s.titlesDone,
      focus: s.focus,
      session: s.session,
      knownBefore: s.knownBefore,
      current: [...s.current.values()],
      recent: s.recent.slice(0, 25),
      confirmed: [...s.confirmed.values()].sort((a, b) => (b.at || 0) - (a.at || 0)),
      lastPush: s.lastPush,
      nextCheck: s.nextCheck,
      cloud: {
        scanned: c.scannedTitles || 0,
        candidates: c.candidates ? c.candidates.movie + c.candidates.series : null,
        sizes: c.catalogSizes || {},
        builtAt: c.builtAt || null,
        run: run ? { status: run.status, conclusion: run.conclusion, started: run.run_started_at || run.created_at } : null,
      },
    };
  }

  function writeData() {
    try {
      fs.writeFileSync(dataFile, `window.__progress(${JSON.stringify(snapshot())});`);
    } catch { /* ignore */ }
  }

  try {
    fs.writeFileSync(file, PAGE);
  } catch { /* ignore */ }
  pollCloud().then(writeData);
  const t1 = setInterval(writeData, 2000);
  const t2 = setInterval(pollCloud, 120000);
  writeData();

  return {
    phase(p, detail = '') { s.phase = p; s.detail = detail; writeData(); },
    batch(total, knownBefore, perTitle = {}) {
      s.queueTotal = total; s.queueDone = 0; s.knownBefore = knownBefore;
      s.titleLeft = new Map(Object.entries(perTitle)); s.titleTotal = s.titleLeft.size; s.titlesDone = 0;
    },
    start(key, name, release, item = {}) {
      const now = Date.now();
      s.current.set(key, { name, release, since: now, poster: item.poster, type: item.type });
      s.focus = { id: item.id, name, release, type: item.type, year: item.year, poster: item.poster, since: now };
    },
    drop(key) { s.current.delete(key); },
    setConfirmed(list) { for (const c of list) if (!s.confirmed.has(c.id)) s.confirmed.set(c.id, c); },
    addConfirmed(id, type, name, year, poster) {
      if (!s.confirmed.has(id)) s.confirmed.set(id, { id, type, name, year, poster, at: Date.now(), isNew: true });
    },
    finish(key, name, release, r, item = {}) {
      s.current.delete(key);
      s.queueDone++;
      if (item.id && s.titleLeft.has(item.id)) {
        const left = s.titleLeft.get(item.id) - 1;
        if (left <= 0) { s.titleLeft.delete(item.id); s.titlesDone++; } else s.titleLeft.set(item.id, left);
      }
      s.session[r.v === 1 ? 'yes' : r.v === 0 ? 'no' : 'unknown']++;
      s.recent.unshift({ v: r.v, name, release, audio: (r.a || []).join(', '), err: r.e, at: Date.now() });
      s.recent.length = Math.min(s.recent.length, 40);
    },
    pushed() { s.lastPush = Date.now(); },
    nextCheck(t) { s.nextCheck = t; },
    stop(msg) { s.phase = msg; s.current.clear(); writeData(); clearInterval(t1); clearInterval(t2); },
  };
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Turkish Audio Finder</title>
<style>
:root{
  --bg:#0b0d12;--panel:#141821;--panel2:#1a1f2b;--line:#252b38;--fg:#eef0f5;--mut:#8b93a5;--dim:#5d6578;
  --red:#e30a17;--red2:#ff4d58;--green:#22c55e;--amber:#f5b301;--blue:#4f8cff;
  --r:16px;
}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 "Segoe UI Variable","Segoe UI",system-ui,sans-serif}
body{background:radial-gradient(1200px 500px at 10% -10%,#e30a1722,transparent 60%),radial-gradient(900px 400px at 110% 0%,#4f8cff18,transparent 60%),var(--bg);min-height:100vh}
main{max-width:1180px;margin:0 auto;padding:28px 20px 60px}
a{color:inherit}
.top{display:flex;align-items:center;gap:16px;flex-wrap:wrap;margin-bottom:22px}
.logo{width:46px;height:46px;border-radius:14px;background:linear-gradient(135deg,var(--red),#9b0610);display:grid;place-items:center;font-size:24px;box-shadow:0 8px 24px #e30a1744}
.top h1{font-size:20px;margin:0;letter-spacing:.2px}
.top .sub{color:var(--mut);font-size:13px}
.status{margin-left:auto;display:flex;align-items:center;gap:10px;background:var(--panel);border:1px solid var(--line);padding:8px 14px;border-radius:999px}
.dot{width:10px;height:10px;border-radius:50%;background:var(--green);box-shadow:0 0 0 0 #22c55e88;animation:pulse 1.6s infinite}
.dot.wait{background:var(--amber);animation:none}.dot.off{background:var(--dim);animation:none}
@keyframes pulse{0%{box-shadow:0 0 0 0 #22c55e88}70%{box-shadow:0 0 0 10px #22c55e00}100%{box-shadow:0 0 0 0 #22c55e00}}
.status b{font-weight:600}.status small{color:var(--mut)}
.tiles{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:14px}
.tile{background:var(--panel);border:1px solid var(--line);border-radius:var(--r);padding:16px 18px;position:relative;overflow:hidden}
.tile .k{color:var(--mut);font-size:12.5px;display:flex;align-items:center;gap:6px}
.tile .v{font-size:32px;font-weight:700;letter-spacing:-.5px;margin-top:4px;font-variant-numeric:tabular-nums}
.tile .s{color:var(--dim);font-size:12px}
.tile::after{content:"";position:absolute;inset:auto -30px -30px auto;width:90px;height:90px;border-radius:50%;opacity:.12}
.t-green::after{background:var(--green)}.t-red::after{background:var(--red)}.t-amber::after{background:var(--amber)}.t-blue::after{background:var(--blue)}
.grid{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(0,1fr);gap:14px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:var(--r);padding:18px;min-width:0}
.card h2{font-size:13px;text-transform:uppercase;letter-spacing:.8px;color:var(--mut);margin:0 0 14px;font-weight:600;display:flex;align-items:center;gap:8px}
.card h2 .pill{margin-left:auto;text-transform:none;letter-spacing:0;font-weight:500}
.pill{background:var(--panel2);border:1px solid var(--line);border-radius:999px;padding:2px 10px;font-size:12px;color:var(--mut)}
.bar{height:10px;background:var(--panel2);border-radius:999px;overflow:hidden;margin:10px 0 8px}
.bar i{display:block;height:100%;border-radius:999px;background:linear-gradient(90deg,var(--red),var(--red2));transition:width .6s ease}
.bar.blue i{background:linear-gradient(90deg,#2f6fe4,var(--blue))}
.row{display:flex;justify-content:space-between;gap:10px;color:var(--mut);font-size:13px;flex-wrap:wrap}
.row b{color:var(--fg);font-weight:600}
.now{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:minmax(0,1fr);gap:8px}
.now li{display:flex;gap:12px;align-items:center;background:var(--panel2);border-radius:12px;padding:9px 12px}
.spin{width:16px;height:16px;border:2px solid var(--line);border-top-color:var(--red2);border-radius:50%;animation:spin .9s linear infinite;flex:none}
@keyframes spin{to{transform:rotate(360deg)}}
.now .t{min-width:0;flex:1}.now .t b{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.now .t small{display:block;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.now .sec{color:var(--mut);font-variant-numeric:tabular-nums;font-size:12px}
.empty{color:var(--dim);font-size:13px;padding:6px 2px}
.res{list-style:none;margin:0;padding:0;max-height:360px;overflow:auto}
.res li{display:grid;grid-template-columns:22px minmax(0,1fr) auto;gap:10px;padding:8px 2px;border-top:1px solid var(--line);align-items:start}
.res li:first-child{border-top:0}
.res .n{min-width:0}.res .n b{display:block;font-weight:600}.res .n small{display:block;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.res .a{color:var(--mut);font-size:12px;text-align:right;white-space:nowrap}
.tag{display:inline-block;font-size:11px;padding:1px 7px;border-radius:999px;margin-left:6px;vertical-align:1px}
.tag.tr{background:#22c55e22;color:#7ee2a2}.tag.no{background:#e30a1722;color:#ff8a92}.tag.uk{background:#f5b30122;color:#ffd666}
.section{margin-top:14px}
.tabs{display:flex;gap:6px;margin-left:auto}
.tabs button{background:var(--panel2);color:var(--mut);border:1px solid var(--line);border-radius:999px;padding:5px 12px;font:inherit;font-size:12.5px;cursor:pointer}
.tabs button.on{background:var(--fg);color:#111;border-color:var(--fg)}
.posters{display:grid;grid-template-columns:repeat(auto-fill,minmax(112px,1fr));gap:12px;max-height:620px;overflow:auto;padding-right:4px}
.poster{position:relative;border-radius:12px;overflow:hidden;background:var(--panel2);aspect-ratio:2/3;text-decoration:none;border:1px solid var(--line);transition:transform .15s}
.poster:hover{transform:translateY(-2px)}
.poster img{position:relative;z-index:1;width:100%;height:100%;object-fit:cover;display:block}
.poster .cap{z-index:2;position:absolute;inset:auto 0 0 0;padding:22px 8px 7px;background:linear-gradient(transparent,#000d);font-size:11.5px;line-height:1.25}
.poster .cap b{display:block;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.poster .cap small{color:#bbb}
.poster .new{z-index:2;position:absolute;top:6px;left:6px;background:var(--red);color:#fff;font-size:10px;font-weight:700;padding:2px 6px;border-radius:6px;letter-spacing:.4px}
.poster .ph{position:absolute;inset:0;display:grid;place-items:center;color:var(--dim);font-size:28px}
.hero{display:flex;gap:16px;align-items:stretch;background:var(--panel2);border:1px solid var(--line);border-radius:14px;padding:12px;margin-bottom:16px}
.hero .hp{width:86px;flex:none;aspect-ratio:2/3;border-radius:10px;overflow:hidden;background:#0006;position:relative;display:grid;place-items:center;font-size:30px;color:var(--dim)}
.hero .hp img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.hero .hi{flex:1;min-width:0;display:flex;flex-direction:column;justify-content:center}
.hero .lbl{color:var(--red2);font-size:11.5px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;display:flex;align-items:center;gap:8px}
.hero .ht{font-size:20px;font-weight:700;margin:2px 0 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hero .hs{color:var(--dim);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bar.big{height:14px}.bar.thin{height:6px;margin:6px 0}
.kv{display:grid;grid-template-columns:auto 1fr;gap:8px 14px;font-size:13px;color:var(--mut)}.kv b{color:var(--fg);text-align:right;font-weight:600}
.done{display:flex;align-items:center;gap:10px;background:#22c55e14;border:1px solid #22c55e33;color:#9be7b6;border-radius:12px;padding:10px 12px;margin-bottom:14px;font-size:13px}
.foot{color:var(--dim);font-size:12px;margin-top:18px;text-align:center}
@media (max-width:900px){.tiles{grid-template-columns:repeat(2,1fr)}.grid{grid-template-columns:1fr}.status{margin-left:0}}
</style></head>
<body><main>
  <div class="top">
    <div class="logo">🇹🇷</div>
    <div><h1>Turkish Audio Finder</h1><div class="sub" id="sub">Connecting to the checker…</div></div>
    <div class="status"><span class="dot" id="dot"></span><div><b id="phase">Starting</b><br><small id="detail"></small></div></div>
  </div>

  <div class="tiles">
    <div class="tile t-green"><div class="k">✅ Confirmed titles</div><div class="v" id="kConf">–</div><div class="s" id="kConfS"></div></div>
    <div class="tile t-blue"><div class="k">🔎 Releases checked</div><div class="v" id="kChecked">–</div><div class="s" id="kCheckedS"></div></div>
    <div class="tile t-red"><div class="k">❌ Hidden (no Turkish)</div><div class="v" id="kNo">–</div><div class="s">this session</div></div>
    <div class="tile t-amber"><div class="k">❔ Couldn't tell</div><div class="v" id="kUnk">–</div><div class="s">retried later</div></div>
  </div>

  <div class="grid">
    <div class="card">
      <h2>Audio check on this PC <span class="pill" id="rate"></span></h2>
      <div class="hero">
        <div class="hp" id="hPoster">🎬</div>
        <div class="hi">
          <div class="lbl"><span class="spin" id="hSpin"></span><span id="hLbl">Now checking</span></div>
          <div class="ht" id="hName">–</div>
          <div class="hs" id="hRel"></div>
          <div class="bar big"><i id="tBar" style="width:0"></i></div>
          <div class="row"><span>Title <b id="tNum">0</b> of <b id="tTot">0</b> in this batch</span><span id="tPct"></span></div>
        </div>
      </div>
      <div class="bar thin"><i id="qBar" style="width:0"></i></div>
      <div class="row"><span><b id="qDone">0</b> of <b id="qTotal">0</b> releases</span><span id="qEta"></span></div>
      <div class="row" style="margin-top:4px"><span id="push"></span><span id="stopAt"></span></div>
      <h2 style="margin-top:20px">Checking right now <span class="pill" id="nowCount"></span></h2>
      <ul class="now" id="now"></ul>
    </div>
    <div class="card">
      <h2>Cloud scan · GitHub <span class="pill" id="runPill"></span></h2>
      <div class="done" id="cDone">☁️ <span id="cDoneTxt">–</span></div>
      <div class="kv">
        <span>In your Stremio list</span><b><span id="cMovies">–</span> movies · <span id="cSeries">–</span> TV shows</b>
        <span>Last published</span><b id="cBuilt">–</b>
        <span>Next update</span><b id="cNext">–</b>
      </div>
      <h2 style="margin-top:20px">Latest results</h2>
      <ul class="res" id="res"></ul>
    </div>
  </div>

  <div class="card section">
    <h2>✅ Confirmed with Turkish audio <span class="pill" id="confPill"></span>
      <span class="tabs"><button data-t="all" class="on">All</button><button data-t="movie">🎬 Movies</button><button data-t="series">📺 TV shows</button></span>
    </h2>
    <div class="posters" id="posters"></div>
  </div>

  <div class="foot" id="foot">Updates live every 2 seconds</div>
</main>
<script>
let D=null, tab='all', lastConfKey='';
const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const fmt=n=>Number(n||0).toLocaleString();
const clock=t=>t?new Date(t).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}):'–';
const dur=ms=>{if(!(ms>0))return '0m';const m=Math.round(ms/60000);return m>=60?Math.floor(m/60)+'h '+(m%60)+'m':m+'m'};
document.querySelectorAll('.tabs button').forEach(b=>b.onclick=()=>{tab=b.dataset.t;document.querySelectorAll('.tabs button').forEach(x=>x.classList.toggle('on',x===b));lastConfKey='';draw();});

window.__progress=d=>{D=d;draw();};
function poll(){const s=document.createElement('script');s.src='progress-data.js?t='+Date.now();s.onload=s.onerror=()=>s.remove();document.body.appendChild(s);}
setInterval(poll,2000);poll();
setInterval(()=>{ if(D) drawNow(); },1000);

function draw(){
  if(!D) return;
  const age=Date.now()-D.now, stale=age>30000;
  const p=D.phase||'';
  $('phase').textContent=stale?'Checker not running':p;
  $('detail').textContent=stale?'last update '+clock(D.now)+' — the watchdog restarts it within 10 min':(D.detail||'');
  $('dot').className='dot'+(stale?' off':/Checking/.test(p)?'':' wait');
  $('sub').textContent='Running since '+clock(D.startedAt)+' · stops '+(new Date(D.deadline).toDateString()===new Date().toDateString()?'today':'tomorrow')+' at '+clock(D.deadline)+' ('+dur(D.deadline-Date.now())+' left)';

  const conf=D.confirmed||[], cm=conf.filter(c=>c.type==='movie').length, cs=conf.length-cm, cn=conf.filter(c=>c.isNew).length;
  $('kConf').textContent=fmt(conf.length);$('kConfS').textContent=cm+' movies · '+cs+' TV shows'+(cn?' · '+cn+' new':'');
  const ses=D.session, done=ses.yes+ses.no+ses.unknown;
  $('kChecked').textContent=fmt(D.knownBefore+done);$('kCheckedS').textContent=fmt(done)+' this session';
  $('kNo').textContent=fmt(ses.no);$('kUnk').textContent=fmt(ses.unknown);

  const pct=D.queueTotal?Math.round(D.queueDone/D.queueTotal*100):0;
  $('qBar').style.width=pct+'%';$('qDone').textContent=fmt(D.queueDone);$('qTotal').textContent=fmt(D.queueTotal);
  const rate=done/Math.max(1/60,(D.now-D.startedAt)/3600000), left=Math.max(0,D.queueTotal-D.queueDone);
  $('rate').textContent=done>=10?Math.round(rate)+' / hour':'warming up';
  $('qEta').textContent=left&&rate>0&&done>=10?'~'+dur(left/rate*3600000)+' left · '+pct+'%':(D.queueTotal?pct+'%':'');
  $('push').textContent='Uploaded: '+(D.lastPush?clock(D.lastPush):'not yet')+' · every 30 min';
  $('stopAt').textContent=D.nextCheck&&/Waiting/.test(p)?'next look '+clock(D.nextCheck):'';

  const c=D.cloud, tot=c.candidates||10900, cp=Math.min(100,Math.round(c.scanned/tot*100));
  $('cDoneTxt').textContent=!c.builtAt?'Loading cloud status…':cp>=99?'All '+fmt(tot)+' titles scanned. Now only re-checking for new releases.':'Scanned '+fmt(Math.min(c.scanned,tot))+' of '+fmt(tot)+' titles ('+cp+'%)';
  $('cMovies').textContent=c.sizes['default:movie']??'–';$('cSeries').textContent=c.sizes['default:series']??'–';$('cBuilt').textContent=clock(c.builtAt);
  $('cNext').textContent=c.run&&c.run.status!=='completed'?'publishing ~'+clock(new Date(c.run.started).getTime()+55*60000):'within the hour';
  $('runPill').textContent=!c.run?'':c.run.status!=='completed'?'● scanning since '+clock(c.run.started):c.run.conclusion==='success'?'idle · next within 1h':'last run '+c.run.conclusion;

  $('res').innerHTML=(D.recent||[]).map(r=>'<li><span>'+(r.v===1?'✅':r.v===0?'❌':'❔')+'</span><div class="n"><b>'+esc(r.name)
    +(r.v===1?'<span class="tag tr">'+esc(r.audio)+'</span>':r.v===0?'<span class="tag no">'+esc(r.audio||'no Turkish')+'</span>':'<span class="tag uk">'+esc(r.err||'unknown')+'</span>')
    +'</b><small>'+esc(r.release)+'</small></div><span class="a">'+clock(r.at)+'</span></li>').join('')||'<div class="empty">No results yet</div>';

  const list=conf.filter(x=>tab==='all'||x.type===tab), key=tab+'|'+list.length+'|'+cn;
  $('confPill').textContent=list.length+' shown';
  if(key!==lastConfKey){
    lastConfKey=key;
    $('posters').innerHTML=list.map(x=>'<a class="poster" target="_blank" href="https://www.imdb.com/title/'+x.id+'/" title="'+esc(x.name)+'">'
      +'<span class="ph">'+(x.type==='movie'?'🎬':'📺')+'</span>'
      +(x.poster?'<img loading="lazy" src="'+esc(x.poster)+'" onerror="this.remove()">':'')
      +(x.isNew?'<span class="new">NEW</span>':'')
      +'<div class="cap"><b>'+esc(x.name)+'</b><small>'+esc(x.year||'')+' · '+(x.type==='movie'?'Movie':'TV')+'</small></div></a>').join('')||'<div class="empty">None yet</div>';
  }
  drawNow();
}
function drawNow(){
  const f=D.focus, running=(D.current||[]).length>0;
  const tn=Math.min(D.titleTotal,D.titlesDone+(running?1:0)), tp=D.titleTotal?Math.round(D.titlesDone/D.titleTotal*100):0;
  $('tBar').style.width=tp+'%';$('tNum').textContent=fmt(tn);$('tTot').textContent=fmt(D.titleTotal);$('tPct').textContent=D.titleTotal?tp+'%':'';
  $('hSpin').style.display=running?'':'none';
  $('hLbl').textContent=running?'Now checking':'Last checked';
  if(f){
    $('hName').textContent=f.name+(f.year?' ('+f.year+')':'');
    $('hRel').textContent=f.release+(running?' · '+Math.max(0,Math.round((Date.now()-f.since)/1000))+'s':'');
    const key=f.id+'|'+(f.poster||'');
    if($('hPoster').dataset.k!==key){$('hPoster').dataset.k=key;$('hPoster').innerHTML=(f.type==='series'?'📺':'🎬')+(f.poster?'<img src="'+esc(f.poster)+'" onerror="this.remove()">':'');}
  } else { $('hName').textContent=/Waiting/.test(D.phase)?'Waiting for new titles':'–'; $('hRel').textContent=''; }
  const cur=D.current||[];
  $('nowCount').textContent=cur.length?cur.length+' running':'';
  $('now').innerHTML=cur.map(x=>'<li><span class="spin"></span><div class="t"><b>'+esc(x.name)+'</b><small>'+esc(x.release)+'</small></div><span class="sec">'+Math.max(0,Math.round((Date.now()-x.since)/1000))+'s</span></li>').join('')||'<div class="empty">Nothing right now</div>';
}
</script>
</body></html>`;

module.exports = { createProgress };
