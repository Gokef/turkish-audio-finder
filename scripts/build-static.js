'use strict';

// Builds a fully static Stremio addon (manifest + pre-rendered catalog pages) from the
// scan results, for free hosting on GitHub Pages / any static HTTPS host.
//
//   DATA_DIR=site/data node scripts/build-static.js site [https://user.github.io/repo]
//
// Stremio requests these paths, which map 1:1 to files:
//   /manifest.json
//   /catalog/{type}/{id}.json
//   /catalog/{type}/{id}/skip=100.json
//   /catalog/{type}/{id}/genre=Drama.json
//   /catalog/{type}/{id}/genre=Drama&skip=100.json

const fs = require('fs');
const path = require('path');
const config = require('../src/config');
const { getLanguages } = require('../src/languages');
const { Store } = require('../src/store');
const { createAddon, buildManifest, streamsFor } = require('../src/addon');

// Each preset is a separately installable addon (static hosting can't take per-user options).
const PRESETS = [
  { dir: '', suffix: '', label: 'Dual / Multi audio (recommended)', cfg: {} },
  { dir: 'all', suffix: ' (all Turkish audio)', label: 'All Turkish audio, incl. Turkish-only dubs', cfg: { mode: 'verified' } },
  { dir: '1080p', suffix: ' (1080p+)', label: 'Dual audio, 1080p or better', cfg: { quality: '1080p or better' } },
  { dir: '4k', suffix: ' (4K)', label: 'Dual audio, 4K only', cfg: { quality: '4K only' } },
  { dir: 'verified', suffix: ' (verified)', label: 'Only titles whose Turkish audio track was verified', cfg: { mode: 'confirmed' } },
];

function write(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data));
}

async function main() {
  const out = path.resolve(process.argv[2] || 'site');
  const baseUrl = (process.argv[3] || process.env.PUBLIC_URL || '').replace(/\/+$/, '');
  const cfg = config.load();
  const languages = getLanguages(cfg.languages);
  const store = new Store(cfg);
  await store.load();
  const { builder } = createAddon({ cfg, store, languages });
  const iface = builder.getInterface();
  const base = buildManifest(languages);

  // Remove previous build output (keep data/ and git metadata).
  for (const p of ['catalog', 'stream', 'manifest.json', 'index.html', 'status.json', ...PRESETS.filter((x) => x.dir).map((x) => x.dir)]) {
    fs.rmSync(path.join(out, p), { recursive: true, force: true });
  }

  let files = 0;
  const counts = {};

  // Stream lists (same for every preset): Turkish-audio releases only.
  const streamFiles = [];
  for (const [id, rec] of Object.entries(store.all())) {
    if (!rec.r) continue;
    const ids = new Set();
    if (rec.t === 'movie') ids.add(id);
    else for (const lr of Object.values(rec.r)) for (const x of lr.x || []) if (x.ep) ids.add(x.ep);
    for (const sid of ids) {
      // ":" is not allowed in Windows file names; series stream files are only built on Linux (GitHub Actions).
      if (sid.includes(':') && process.platform === 'win32') continue;
      const streams = streamsFor(store, languages, rec.t, sid);
      if (streams.length) streamFiles.push([`stream/${rec.t}/${sid}.json`, { streams, cacheMaxAge: 3600 }]);
    }
  }
  for (const preset of PRESETS) {
    const root = path.join(out, preset.dir);
    const manifest = {
      ...base,
      id: base.id + (preset.dir ? `.${preset.dir}` : ''),
      name: base.name + preset.suffix,
      catalogs: base.catalogs.map((c) => ({ ...c, name: c.name + preset.suffix })),
      behaviorHints: {},
    };
    delete manifest.config;
    write(path.join(root, 'manifest.json'), manifest);
    files++;
    for (const [rel, body] of streamFiles) {
      write(path.join(root, rel), body);
      files++;
    }

    for (const cat of base.catalogs) {
      const genres = [null, ...cat.extra.find((e) => e.name === 'genre').options];
      for (const genre of genres) {
        const all = [];
        for (let skip = 0; ; skip += cfg.pageSize) {
          const extra = {};
          if (genre) extra.genre = genre;
          if (skip) extra.skip = String(skip);
          const resp = await iface.get('catalog', cat.type, cat.id, extra, preset.cfg);
          const parts = [genre ? `genre=${genre}` : null, skip ? `skip=${skip}` : null].filter(Boolean).join('&');
          const file = path.join(root, 'catalog', cat.type, parts ? `${cat.id}/${parts}.json` : `${cat.id}.json`);
          write(file, { metas: resp.metas, cacheMaxAge: resp.cacheMaxAge });
          files++;
          all.push(...resp.metas);
          // Stop after writing one empty (or short) page so "load more" ends cleanly instead of 404.
          if (resp.metas.length < cfg.pageSize) break;
        }
        if (!genre) counts[`${preset.dir || 'default'}:${cat.type}`] = all.length;
      }
    }
  }

  const titles = Object.values(store.all());
  write(path.join(out, 'status.json'), {
    builtAt: new Date().toISOString(),
    scannedTitles: titles.length,
    candidates: (() => { try { return JSON.parse(fs.readFileSync(path.join(cfg.dataDir, 'scan-state.json'), 'utf8')).candidates; } catch { return undefined; } })(),
    streamFiles: streamFiles.length,
    verifiedReleases: Object.values(store.verified || {}).filter((v) => v.v === 1).length,
    rejectedReleases: Object.values(store.verified || {}).filter((v) => v.v === 0).length,
    catalogSizes: counts,
  });
  write(path.join(out, 'index.html'), landing(base, baseUrl, counts));
  write(path.join(out, '.nojekyll'), '');
  console.log(`[build] wrote ${files} files to ${out}`, JSON.stringify(counts));
}

function landing(manifest, baseUrl, counts) {
  const rows = PRESETS.map((p) => {
    const rel = `${p.dir ? p.dir + '/' : ''}manifest.json`;
    const n = `${counts[`${p.dir || 'default'}:movie`] || 0} movies · ${counts[`${p.dir || 'default'}:series`] || 0} series`;
    return `<div class="box"><b>${p.label}</b><small>${n}</small>
<a class="btn" data-rel="${rel}" href="#">Install in Stremio</a>
<button class="btn sec" data-copy="${rel}">Copy link</button><code data-url="${rel}"></code></div>`;
  }).join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Turkish Audio Finder</title>
<style>:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#0f1115;color:#e8eaf0;font:16px/1.5 system-ui,sans-serif;padding:16px}
main{max-width:560px;margin:0 auto}p,small{color:#9aa3b2}small{display:block}.box{background:#181b22;border-radius:12px;padding:16px;margin:14px 0}
.btn{display:block;text-align:center;background:#e30a17;color:#fff;text-decoration:none;padding:11px;border-radius:10px;font-weight:600;margin:10px 0 0;border:0;width:100%;font-size:1rem;cursor:pointer}
.btn.sec{background:#2b303b}code{display:block;word-break:break-all;background:#0f1115;padding:8px;border-radius:8px;font-size:.8rem;margin-top:8px}</style></head>
<body><main><h1>🇹🇷 ${manifest.name}</h1><p>${manifest.description}</p>
<p>Android: tap <b>Copy link</b>, open Stremio → Add-ons → paste into the search bar → Install. Install only one of these.</p>
${rows}
<p><small>Updated automatically every few hours · <a style="color:#9aa3b2" href="status.json">status</a></small></p></main>
<script>const base=${JSON.stringify(baseUrl)}||location.href.replace(/[^/]*$/,'').replace(/\\/$/,'');
const u=r=>base+'/'+r;document.querySelectorAll('[data-url]').forEach(e=>e.textContent=u(e.dataset.url));
document.querySelectorAll('[data-rel]').forEach(e=>e.href=u(e.dataset.rel).replace(/^https?:/,'stremio:'));
document.querySelectorAll('[data-copy]').forEach(b=>b.onclick=async()=>{try{await navigator.clipboard.writeText(u(b.dataset.copy));b.textContent='Copied ✓'}catch(e){prompt('Copy this link',u(b.dataset.copy))}});</script>
</body></html>`;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
