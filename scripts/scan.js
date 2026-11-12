'use strict';

// One-shot scan, for running the scanner outside the web server
// (GitHub Actions, your PC, a cron job). Writes to the same storage as the addon.
//
//   node scripts/scan.js [--max-minutes 300] [--limit 500]

const config = require('../src/config');
const { getLanguages } = require('../src/languages');
const { Store } = require('../src/store');
const { TorrentioClient } = require('../src/torrentio');
const { Scanner } = require('../src/scanner');

const arg = (name, d) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? Number(process.argv[i + 1]) : d;
};

(async () => {
  const cfg = config.load();
  const limit = arg('limit', null);
  if (limit) cfg.maxScansPerCycle = limit;
  const store = new Store(cfg);
  await store.load();
  const torrentio = new TorrentioClient({
    baseUrl: cfg.torrentioUrl,
    options: cfg.torrentioOptions,
    concurrency: cfg.torrentioConcurrency,
    minIntervalMs: cfg.torrentioMinIntervalMs,
    timeoutMs: cfg.torrentioTimeoutMs,
  });
  const scanner = new Scanner({ cfg, store, torrentio, languages: getLanguages(cfg.languages) });
  process.on('SIGINT', () => { scanner.stopped = true; });
  process.on('SIGTERM', () => { scanner.stopped = true; });
  await scanner.runCycle({ maxMinutes: arg('max-minutes', 0) || undefined });
  require('fs').writeFileSync(require('path').join(cfg.dataDir, 'scan-state.json'), JSON.stringify({
    candidates: { movie: scanner.candidates.movie.length, series: scanner.candidates.series.length },
    lastRun: { ...scanner.state, torrentio: torrentio.stats }, at: new Date().toISOString(),
  }));
  console.log(JSON.stringify({ ...scanner.state, torrentio: torrentio.stats }));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
