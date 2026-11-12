'use strict';

const int = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
const bool = (v, d) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(String(v)));
const list = (v, d) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : d);

// Torrentio options that would carry debrid credentials. These must never be used by a
// public, shared addon: everyone installing it would be using your account.
const SECRET_KEYS = ['realdebrid', 'alldebrid', 'premiumize', 'debridlink', 'offcloud', 'torbox', 'putio',
  'easydebrid', 'debrider', 'mediafusion', 'apikey', 'token'];

function sanitizeTorrentioOptions(raw) {
  if (!raw) return '';
  const parts = String(raw).replace(/^\/+|\/+$/g, '').split('|').filter(Boolean);
  const kept = [];
  for (const p of parts) {
    const key = p.split('=')[0].toLowerCase();
    if (SECRET_KEYS.some((s) => key.includes(s))) {
      console.warn(`[config] Ignoring Torrentio option "${key}": debrid/secret options are not allowed.`);
      continue;
    }
    kept.push(p);
  }
  return kept.join('|');
}

function load(env = process.env) {
  const languages = list(env.LANGUAGES, ['tr']);
  const cfg = {
    port: int(env.PORT, 7000),
    publicUrl: (env.PUBLIC_URL || env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, ''),
    languages,

    torrentioUrl: (env.TORRENTIO_URL || 'https://torrentio.strem.fun').replace(/\/+$/, ''),
    torrentioOptions: sanitizeTorrentioOptions(env.TORRENTIO_OPTIONS),
    torrentioConcurrency: int(env.TORRENTIO_CONCURRENCY, 2),
    torrentioMinIntervalMs: int(env.TORRENTIO_MIN_INTERVAL_MS, 1500),
    torrentioTimeoutMs: int(env.TORRENTIO_TIMEOUT_MS, 20000),

    cinemetaUrl: (env.CINEMETA_URL || 'https://v3-cinemeta.strem.io').replace(/\/+$/, ''),
    // How deep to crawl Cinemeta (number of titles per source catalog).
    movieTopDepth: int(env.MOVIE_TOP_DEPTH, 8000),
    movieRatingDepth: int(env.MOVIE_RATING_DEPTH, 3000),
    movieYearDepth: int(env.MOVIE_YEAR_DEPTH, 400),
    seriesTopDepth: int(env.SERIES_TOP_DEPTH, 3000),
    seriesRatingDepth: int(env.SERIES_RATING_DEPTH, 1500),
    seriesYearDepth: int(env.SERIES_YEAR_DEPTH, 200),
    yearFrom: int(env.YEAR_FROM, 1990),
    seriesProbeLatest: bool(env.SERIES_PROBE_LATEST, true),

    scannerEnabled: bool(env.SCANNER_ENABLED, true),
    scanIntervalHours: int(env.SCAN_INTERVAL_HOURS, 12),
    rescanPositiveDays: int(env.RESCAN_POSITIVE_DAYS, 14),
    rescanNegativeDays: int(env.RESCAN_NEGATIVE_DAYS, 21),
    rescanRecentNegativeDays: int(env.RESCAN_RECENT_NEGATIVE_DAYS, 5),
    maxScansPerCycle: int(env.MAX_SCANS_PER_CYCLE, 3000),

    storage: env.UPSTASH_REDIS_REST_URL ? 'upstash' : 'file',
    dataDir: env.DATA_DIR || './data',
    upstashUrl: (env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, ''),
    upstashToken: env.UPSTASH_REDIS_REST_TOKEN || '',
    storageKey: env.STORAGE_KEY || 'taf:db:v1',
    verifiedFile: env.VERIFIED_FILE || require('path').resolve(__dirname, '..', 'verified.json'),
    reloadMinutes: int(env.RELOAD_MINUTES, 15),

    extraGroups: { tr: list(env.TR_GROUPS, []) },
    pageSize: 100,
  };
  return cfg;
}

module.exports = { load, sanitizeTorrentioOptions };
