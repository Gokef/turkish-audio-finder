# 🇹🇷 Turkish Audio Finder (Stremio addon)

This addon adds two catalogs to your Stremio home screen:

- **🇹🇷 Turkish Dual-Audio Movies**
- **🇹🇷 Turkish Dual-Audio Series**

## Install (Android or any Stremio)

Open Stremio → **Add-ons** → paste this into the search bar → **Install**:

```
https://gokef.github.io/turkish-audio-finder/manifest.json
```

Other presets, install only one: `…/all/manifest.json` (also Turkish-only dubs), `…/1080p/manifest.json`, `…/4k/manifest.json`. You can also open https://gokef.github.io/turkish-audio-finder/ for install buttons.

**How it's hosted (serverless, free):** `.github/workflows/pages.yml` runs every hour on GitHub Actions. It scans Torrentio, saves the results to `data/db.json.gz` on the `gh-pages` branch, and publishes the manifest and every catalog page as static files on GitHub Pages. You don't need a server or any other account. If GitHub ever pauses the schedule (it does that to inactive repos after 60 days), re-enable it from the repo's **Actions** tab. Static hosting can't take per-user options, which is why there are presets.

### Turkish-only stream list
When you open a title, a **🇹🇷 TR Audio** section appears above Torrentio's streams. It lists only the releases with Turkish audio, labeled "✅ Turkish audio verified (TUR + ENG)" or "❔ not verified yet". These play as plain torrents, without debrid. For series, only the checked episodes get this list: episode 1 of the first and of the latest season. For other episodes, pick the same group (e.g. TURG) in Torrentio's list.

### Real audio-track verification (PC)
`scripts/verify.js` uses the Stremio desktop app's own streaming server (`127.0.0.1:11470`), which ffprobe-reads only the file header, to read each candidate release's actual audio tracks. Results go to `verified.json`, which is committed and pushed. Each push triggers a rebuild:
- Releases with no Turkish track are hidden.
- Verified ones get a ✅ label.
- The `/verified/manifest.json` preset lists only titles with a verified Turkish track.

```bash
node scripts/verify.js --loop --minutes 600 --concurrency 6
```
- If Stremio isn't open, the script starts Stremio's server itself.
- It writes a live `progress.html` page that refreshes every 5 s and also shows the cloud scan's progress.
- Each check briefly joins the torrent, like starting playback, so it downloads and uploads a few MB per release.

Overnight helper: `scripts/windows/watchdog.ps1`, run by a Task Scheduler task every 10 minutes until a given time. While it runs, it:
- keeps the PC awake,
- restarts the checker if it stopped,
- starts a cloud scan if GitHub skipped one.

At the end time it removes its own task.

The Render / server setup below is still supported if you want the configurable version.

---

A background scanner goes through thousands of titles from Cinemeta and asks Torrentio for each one's releases. It then sorts out which releases really have Turkish **audio**, as opposed to Turkish subtitles. The addon only supplies catalogs. When you open a title, the streams still come from your own Torrentio addon, with your own settings and debrid.

```
 Cinemeta catalogs ──► candidate list (≈7–8k titles, de-duplicated, popularity-ranked)
                              │
                              ▼  2 parallel, ≥1.5 s apart, global back-off on 403/429/5xx
 Torrentio /stream/{type}/{id}.json   (series: S1E1 + first episode of latest season)
                              │
                              ▼  detect.js: tier 1–3 per release, subtitles rejected
 results DB (Upstash Redis or local file, gzipped JSON) ──► catalog handler
                                                             (mode / quality / HDR / sort / genre / pagination)
```

---

## 1. What I found (Torrentio and the first version)

I tested Torrentio and Cinemeta with live requests:

| Finding | Consequence |
|---|---|
| Torrentio has **no search or "all releases" endpoint**. It only answers `/stream/{type}/{imdbId}.json` for one title, or one episode. | You can't ask Torrentio for "all Turkish releases". The only reliable approach is to crawl candidate titles and cache the answers, which is what this addon does. |
| Torrentio adds language flags (`🇬🇧 / 🇹🇷`) and "Dual Audio" / "Multi Audio" labels. **The 🇹🇷 flag also shows up on subtitle-only releases.** For example, Breaking Bad's `Turkish Sub 480p` pack carries 🇹🇷. Big remuxes show 20+ flags that usually come from subtitle tracks. | Trusting the flag alone fills the catalog with false positives. The detector cross-checks the flag against the release name and treats long flag lists as weak evidence. |
| Many real Turkish dual-audio releases have **no flag at all**, such as `Inception (2010) … [EN-TR] … -TURG`. | The detector also reads release names itself: TR Dublaj, EN-TR, DUAL TUR, language lists like `Eng.Fre…Tur`, and known groups like TURG. |
| Cinemeta's `v3-cinemeta.strem.io/catalog/...` now answers with a **307 redirect** to `cinemeta-catalogs.strem.io`. Pages hold **50** items, and `top` goes back 5000+ titles. | Requests follow redirects, and the scanner pages through several catalogs (top, imdbRating, per year). |
| Render's free disk is wiped on every restart or deploy, and free services sleep after 15 min without traffic. | Results are stored in **Upstash Redis** (free tier), and an uptime ping keeps the service awake. |

Problems in v1, judged from your description. I haven't seen the ZIP yet, so send it if you want a line-by-line review:

1. **Small catalog.** It only scanned one page of popular titles. v2 crawls about 7–8k titles from several Cinemeta catalogs and keeps going in later cycles.
2. **Scanning on request.** If catalog requests trigger Torrentio lookups, the catalog loads slowly, gets rate-limited, and is empty on cold start. v2 scans in the background and catalog requests only read memory, so they respond in milliseconds.
3. **Cache lost on restart**, which caused a full rescan after every Render restart. v2 persists results.
4. **Naive regex.** `TUR|Turkish` also matches subtitles and title words, such as "The Turkish Detective". v2 strips subtitle phrases and the title's own words first.
5. **No back-off.** Hammering Torrentio gets you blocked. v2 has a global rate limit and exponential back-off.
6. **Private config.** A Torrentio URL containing a debrid key must never be used by a shared addon. v2 rejects debrid options outright.

### Why not real audio-track verification?

Torrentio returns a release name, file name, size, seeders and an **infoHash**, nothing about the actual media streams. Reading the real audio tracks would mean joining the BitTorrent swarm and downloading the start of each video file (the MKV/MP4 header) for thousands of torrents. That is slow, unreliable on free hosting, and amounts to downloading parts of copyrighted files. A debrid service could do it, but that would put your private credentials in a public server. So the addon uses **evidence tiers** instead.

| Tier | Evidence | Example |
|---|---|---|
| 3 | Explicit statement | `TR Dublaj`, `Türkçe Dublaj`, `DUAL AUDIO TUR`, `[EN-TR]`, Torrentio "Dual Audio" with exactly 🇬🇧 🇹🇷 |
| 2 | Strong indication | `Eng.Fre.Ger….Tur.Chi` audio list, TURG group, `MULTi … TR`, 🇹🇷 flag + Dual/Multi on a short flag list |
| 1 | Weak | 🇹🇷 flag inside a long flag list, or a bare `TR` token |
| — | Rejected | Turkish only as subtitles: `Turkish Sub`, `TR Altyazılı`, `Subs: Eng Tur`, `HardSub TR` |

Catalog modes (chosen on the configure page):

- **Dual / Multi audio only** (default): tier ≥ 2 and a dual or multi signal.
- **Any confirmed Turkish audio**: tier ≥ 2, which also includes Turkish-only dubs.
- **Lenient**: tier ≥ 1, more titles with some false positives.

---

## 2. Deploy (free): GitHub → Upstash → Render

You'll need about 15 minutes. All three services have free tiers.

### Step 1: Put the code on GitHub
1. Create a new repository on github.com, for example `turkish-audio-finder`. It can be private.
2. Upload this folder's contents (`node_modules` and `data` aren't needed):
   ```bash
   git init
   ```
   ```bash
   git add . && git commit -m "Turkish Audio Finder v2"
   ```
   ```bash
   git branch -M main && git remote add origin https://github.com/YOUR-USER/turkish-audio-finder.git && git push -u origin main
   ```
   You can also drag the files into GitHub's "Upload files" page.

### Step 2: Create the free Upstash Redis database (stores scan results)
1. Sign up at https://console.upstash.com → **Create Database** → Redis → pick a region close to your Render region (e.g. eu-central-1 / Frankfurt) → Free plan.
2. Open the database → **REST API** section → copy `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`.

### Step 3: Deploy on Render
1. https://dashboard.render.com → **New** → **Blueprint** → connect your GitHub repo. Render reads `render.yaml`.
   (Or **New → Web Service**: Runtime *Node*, Build `npm ci --omit=dev`, Start `node server.js`, Health check path `/health`, Plan *Free*.)
2. When asked for environment variables, paste the two Upstash values.
3. Deploy. Your URL will look like `https://turkish-audio-finder-xxxx.onrender.com`.
4. Check it:
   - `https://YOUR-APP.onrender.com/manifest.json` shows JSON.
   - `https://YOUR-APP.onrender.com/status` shows scan progress (`scannedTitles`, `matched`).

### Step 4: Keep it awake (needed on the free plan)
A free Render service sleeps after 15 minutes without HTTP traffic, and **the scanner stops while it sleeps**. Waking up also takes about 50 s, which can make Stremio show the catalog as empty.
- Create a free monitor at https://uptimerobot.com or https://cron-job.org that requests `https://YOUR-APP.onrender.com/health` **every 10 minutes**.
- One always-on service uses about 730 h/month, which fits inside Render's 750 free instance hours.
- If you'd rather pay: Render Starter ($7/mo) never sleeps.

### Scan timeline
The first full pass over about 8k titles takes roughly **5–8 hours**, at about 2,400 Torrentio requests per hour (series need up to two). The catalogs fill up gradually, most popular titles first. After that:

- Matched titles are rechecked every 14 days.
- Unmatched titles are rechecked every 21 days, or every 5 days for titles from the last two years, since dubs arrive later.

---

## 3. Install in Stremio on Android

1. On your phone, open `https://YOUR-APP.onrender.com/` in a browser.
2. Pick your options: which releases count, minimum quality (720p / 1080p / 4K), HDR only, and sort order.
3. Tap **Install in Stremio**, which opens the Stremio app → **Install**.
   - If the button does nothing, tap **Copy manifest URL**. In Stremio go to **Add-ons** (puzzle icon), paste the URL into the search bar at the top, then tap **Install**.
4. Go back to the Stremio home screen (Board) and scroll: the two 🇹🇷 rows are there. Tap **See all** for the full, paginated list.
5. Make sure **Torrentio** is still installed, since it supplies the actual streams when you open a title.

To change options later, open the configure page again, pick new options, and reinstall (uninstall the old copy first).

---

## 4. Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` | – | Persistent storage. **Strongly recommended on Render.** Without them, results go to `DATA_DIR`. |
| `DATA_DIR` | `./data` | File storage location (local or Docker volume) |
| `PUBLIC_URL` | `RENDER_EXTERNAL_URL` | Base URL shown on the install page |
| `TORRENTIO_URL` | `https://torrentio.strem.fun` | Torrentio base |
| `TORRENTIO_OPTIONS` | empty | Public options only, e.g. `providers=yts,eztv,1337x,thepiratebay`. **Debrid keys are rejected.** |
| `TORRENTIO_CONCURRENCY` | 2 | Parallel Torrentio requests |
| `TORRENTIO_MIN_INTERVAL_MS` | 1500 | Minimum gap between requests |
| `SCANNER_ENABLED` | true | Set to `false` if you scan elsewhere (see §5) |
| `SCAN_INTERVAL_HOURS` | 12 | Pause between cycles once the backlog is done |
| `MAX_SCANS_PER_CYCLE` | 3000 | Titles per cycle |
| `RESCAN_POSITIVE_DAYS` / `RESCAN_NEGATIVE_DAYS` / `RESCAN_RECENT_NEGATIVE_DAYS` | 14 / 21 / 5 | Recheck intervals |
| `MOVIE_TOP_DEPTH`, `MOVIE_RATING_DEPTH`, `MOVIE_YEAR_DEPTH` | 8000, 3000, 400 | Catalog size: titles taken from each Cinemeta catalog (the year catalog is taken per year) |
| `SERIES_TOP_DEPTH`, `SERIES_RATING_DEPTH`, `SERIES_YEAR_DEPTH` | 3000, 1500, 200 | Same for series |
| `YEAR_FROM` | 1990 | Oldest year crawled by the per-year catalog |
| `SERIES_PROBE_LATEST` | true | Also check episode 1 of the latest season |
| `LANGUAGES` | `tr` | Enabled languages (see §6) |
| `TR_GROUPS` | – | Extra Turkish dual-audio release groups, comma-separated |

To make the catalog bigger, raise the depth values. More titles means a longer first pass.

---

## 5. Optional: scan on GitHub Actions instead of Render

Use this if Torrentio starts blocking Render's IPs (`/status` would show `torrentio.blocked` rising) or you want the Render service to only serve catalogs:

1. In GitHub → repo → Settings → Secrets → Actions, add `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`.
2. Start `.github/workflows/scan.yml` by hand from the Actions tab, or uncomment its `schedule` block to run it every 8 hours.
3. On Render set `SCANNER_ENABLED=false`. The addon reloads results from Upstash every 15 minutes.

Run only one scanner at a time, because both write to the same key.

You can also scan from your own PC: `node scripts/scan.js --max-minutes 120` with the Upstash variables set.

---

## 6. Adding another language

1. Copy `src/languages/tr.js` to e.g. `de.js`, then change `code`, `flag`, `catalogNames`, the patterns, `listCode` (`ger`) and `groups`.
2. Register it in `src/languages/index.js`.
3. Set `LANGUAGES=tr,de`.

Each language gets its own two catalogs. One Torrentio request per title serves every language.

---

## 7. Local development

```bash
npm install
```
```bash
npm test
```
```bash
npm start
```
Open http://127.0.0.1:7000/. To install it in Stremio desktop, use `http://127.0.0.1:7000/manifest.json`. For a quick small scan, set `MOVIE_TOP_DEPTH=100 SERIES_TOP_DEPTH=50` and the other depth values to `0`.

Docker:
```bash
docker build -t taf . && docker run -p 7000:7000 -v taf-data:/app/data taf
```

### Endpoints
- `/manifest.json`, `/{config}/manifest.json`: the Stremio manifest
- `/catalog/{type}/{id}[/genre=…&skip=…].json`: catalogs (100 per page)
- `/` or `/configure`: install and configure page
- `/status`: scan progress (no secrets)
- `/health`: uptime ping

### Project layout
```
server.js              express + SDK router, /status, /health, starts the scanner
src/config.js          env parsing, strips debrid secrets from Torrentio options
src/http.js            fetch with timeout/retries
src/cinemeta.js        candidate discovery (top / imdbRating / per-year, de-duplicated)
src/torrentio.js       rate-limited Torrentio client with global back-off
src/detect.js          release classifier (tiers, subtitles, quality/HDR parsing)
src/languages/tr.js    Turkish patterns
src/scanner.js         scheduling, rescans, persistence
src/store.js           file / Upstash storage
src/addon.js           manifest + catalog handler (filters, sort, genre, pagination)
src/landing.js         configure/install page
scripts/scan.js        one-shot scanner (GitHub Actions / PC)
test/                  node:test unit tests
```

## Limits
- Only titles that appear in Cinemeta's catalogs are scanned. Obscure titles outside the crawl depth won't show up.
- Detection relies on release naming conventions, so a release without any Turkish marker can't be found.
- Results are only as current as the last scan. New dubs show up within the recheck intervals.
- If Torrentio is down or blocks the server, the catalogs keep showing the last known results.
