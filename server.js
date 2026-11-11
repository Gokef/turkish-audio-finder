'use strict';

const express = require('express');
const { getRouter } = require('stremio-addon-sdk');
const config = require('./src/config');
const { getLanguages } = require('./src/languages');
const { Store } = require('./src/store');
const { TorrentioClient } = require('./src/torrentio');
const { Scanner } = require('./src/scanner');
const { createAddon } = require('./src/addon');
const { landingPage } = require('./src/landing');

async function main() {
  const cfg = config.load();
  const languages = getLanguages(cfg.languages);
  const store = new Store(cfg);
  await store.load();

  const torrentio = new TorrentioClient({
    baseUrl: cfg.torrentioUrl,
    options: cfg.torrentioOptions,
    concurrency: cfg.torrentioConcurrency,
    minIntervalMs: cfg.torrentioMinIntervalMs,
    timeoutMs: cfg.torrentioTimeoutMs,
  });
  const scanner = new Scanner({ cfg, store, torrentio, languages });
  const { builder, manifest } = createAddon({ cfg, store, languages });

  const app = express();
  app.disable('x-powered-by');

  app.get('/health', (_req, res) => res.json({ ok: true }));

  app.get('/status', (_req, res) => {
    const titles = Object.values(store.all());
    const count = (type) => titles.filter((t) => t.t === type && t.r).length;
    res.json({
      version: manifest.version,
      storage: store.backend.describe(),
      scannedTitles: titles.length,
      matched: { movie: count('movie'), series: count('series') },
      candidates: { movie: scanner.candidates.movie.length, series: scanner.candidates.series.length },
      scanner: { enabled: cfg.scannerEnabled, ...scanner.state },
      torrentio: { paused: torrentio.isPaused(), ...torrentio.stats },
      dbUpdatedAt: store.db.updatedAt ? new Date(store.db.updatedAt).toISOString() : null,
    });
  });

  app.get(['/', '/configure', '/:config/configure'], (req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(landingPage(manifest, req));
  });

  app.use(getRouter(builder.getInterface()));

  app.listen(cfg.port, () => {
    console.log(`[server] listening on :${cfg.port}  manifest: ${cfg.publicUrl || `http://127.0.0.1:${cfg.port}`}/manifest.json`);
  });

  if (cfg.scannerEnabled) {
    scanner.loop();
  } else if (cfg.storage === 'upstash') {
    // Scanning happens elsewhere (e.g. GitHub Actions); just pick up new results periodically.
    setInterval(() => store.load(), cfg.reloadMinutes * 60000).unref();
  }

  const shutdown = async () => {
    scanner.stopped = true;
    await store.save();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
