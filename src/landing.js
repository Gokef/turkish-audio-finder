'use strict';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function baseUrl(req) {
  const env = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');
  if (env) return env;
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0];
  return `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`;
}

/** Install / configure page. Builds the manifest URL (with optional config) in the browser. */
function landingPage(manifest, req) {
  const base = baseUrl(req);
  const fields = manifest.config.map((f) => {
    if (f.type === 'select') {
      const opts = f.options.map((o) => `<option${o === f.default ? ' selected' : ''}>${esc(o)}</option>`).join('');
      return `<label>${esc(f.title)}<select name="${esc(f.key)}">${opts}</select></label>`;
    }
    return `<label class="cb"><input type="checkbox" name="${esc(f.key)}"> ${esc(f.title)}</label>`;
  }).join('\n');
  const defaults = Object.fromEntries(manifest.config.filter((f) => f.type === 'select').map((f) => [f.key, f.default]));

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(manifest.name)}</title>
<style>
:root{color-scheme:dark;--bg:#0f1115;--card:#181b22;--fg:#e8eaf0;--mut:#9aa3b2;--acc:#e30a17}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif;padding:16px}
main{max-width:560px;margin:0 auto}h1{font-size:1.5rem;margin:.5rem 0}p{color:var(--mut)}
form,.box{background:var(--card);border-radius:12px;padding:16px;margin:16px 0}
label{display:block;margin:0 0 14px;font-size:.95rem}select{display:block;width:100%;margin-top:6px;padding:10px;border-radius:8px;background:#0f1115;color:var(--fg);border:1px solid #2b303b;font-size:1rem}
.cb{display:flex;gap:8px;align-items:center}.btn{display:block;text-align:center;background:var(--acc);color:#fff;text-decoration:none;padding:12px;border-radius:10px;font-weight:600;margin:10px 0;border:0;width:100%;font-size:1rem;cursor:pointer}
.btn.sec{background:#2b303b}code{display:block;word-break:break-all;background:#0f1115;padding:10px;border-radius:8px;font-size:.85rem;margin-top:8px}
</style></head><body><main>
<h1>🇹🇷 ${esc(manifest.name)}</h1>
<p>${esc(manifest.description)}</p>
<form id="f">${fields}</form>
<div class="box">
<a class="btn" id="install" href="#">Install in Stremio</a>
<button class="btn sec" id="copy" type="button">Copy manifest URL</button>
<code id="url"></code>
<p style="font-size:.85rem;margin-bottom:0">Android: copy the URL, open Stremio → Add-ons → paste it into the search box at the top → Install.</p>
</div>
<p style="font-size:.85rem">v${esc(manifest.version)} · <a style="color:var(--mut)" href="/status">scan status</a></p>
</main><script>
const base=${JSON.stringify(base)}, defaults=${JSON.stringify(defaults)};
const f=document.getElementById('f');
function url(){const c={};new FormData(f).forEach((v,k)=>{c[k]=v});
 const isDefault=Object.keys(defaults).every(k=>c[k]===defaults[k])&&!c.hdr;
 return base+(isDefault?'':'/'+encodeURIComponent(JSON.stringify(c)))+'/manifest.json';}
function upd(){const u=url();document.getElementById('url').textContent=u;document.getElementById('install').href=u.replace(/^https?:/,'stremio:');}
f.addEventListener('change',upd);upd();
document.getElementById('copy').onclick=async()=>{try{await navigator.clipboard.writeText(url());document.getElementById('copy').textContent='Copied ✓'}catch(e){prompt('Copy this URL',url())}};
</script></body></html>`;
}

module.exports = { landingPage };
