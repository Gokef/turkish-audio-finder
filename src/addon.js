'use strict';

const { addonBuilder } = require('stremio-addon-sdk');
const { releaseMatchesMode, releaseMatchesQuality } = require('./detect');
const pkg = require('../package.json');

const GENRES = ['Action', 'Adventure', 'Animation', 'Biography', 'Comedy', 'Crime', 'Documentary', 'Drama', 'Family',
  'Fantasy', 'History', 'Horror', 'Mystery', 'Romance', 'Sci-Fi', 'Sport', 'Thriller', 'War', 'Western'];

// User-facing option labels (Stremio's config form sends back the label text).
const MODE = {
  'Dual / Multi audio only (recommended)': 'dual',
  'Any confirmed Turkish audio (also Turkish-only dubs)': 'verified',
  'Lenient (more titles, may include false positives)': 'any',
};
const QUALITY = { 'Any quality': 'cam', '720p or better': '720p', '1080p or better': '1080p', '4K only': '2160p' };
const SORT = { Popularity: 'rank', 'IMDb rating': 'rating', 'Newest first': 'year', 'Recently found': 'found' };

function parseUserConfig(config) {
  const c = config || {};
  const on = (v) => v === true || v === 'on' || v === 'checked' || v === 'true';
  return {
    mode: MODE[c.mode] || (Object.values(MODE).includes(c.mode) ? c.mode : 'dual'),
    minRes: QUALITY[c.quality] || 'cam',
    hdrOnly: on(c.hdr),
    sort: SORT[c.sort] || 'rank',
  };
}

function buildManifest(languages) {
  const catalogs = [];
  for (const lang of languages) {
    for (const type of ['movie', 'series']) {
      catalogs.push({
        type,
        id: `${lang.code}-audio-${type}`,
        name: lang.catalogNames[type],
        extra: [{ name: 'genre', options: GENRES, isRequired: false }, { name: 'skip', isRequired: false }],
      });
    }
  }
  return {
    id: 'community.turkish-audio-finder',
    version: pkg.version,
    name: 'Turkish Audio Finder',
    description: 'Catalogs of movies and series that have Turkish (dual) audio releases on Torrentio. '
      + 'Streams still come from your own Torrentio addon.',
    resources: ['catalog'],
    types: ['movie', 'series'],
    catalogs,
    behaviorHints: { configurable: true, configurationRequired: false },
    config: [
      { key: 'mode', type: 'select', title: 'Which releases count', options: Object.keys(MODE), default: Object.keys(MODE)[0] },
      { key: 'quality', type: 'select', title: 'Minimum quality of the Turkish release', options: Object.keys(QUALITY), default: 'Any quality' },
      { key: 'hdr', type: 'checkbox', title: 'Only titles with an HDR / Dolby Vision Turkish release' },
      { key: 'sort', type: 'select', title: 'Sort order', options: Object.keys(SORT), default: 'Popularity' },
    ],
  };
}

/** Builds (and caches per store version) the filtered, sorted list for a catalog. */
function createCatalogIndex(store) {
  const cache = new Map();
  let cacheVersion = -1;

  return function list(langCode, type, uc, genre) {
    if (cacheVersion !== store.version) {
      cache.clear();
      cacheVersion = store.version;
    }
    const key = [langCode, type, uc.mode, uc.minRes, uc.hdrOnly, uc.sort, genre || ''].join('|');
    if (cache.has(key)) return cache.get(key);

    const items = [];
    for (const [id, rec] of Object.entries(store.all())) {
      if (rec.t !== type || !rec.r || !rec.m) continue;
      const lr = rec.r[langCode];
      if (!lr) continue;
      if (genre && !(rec.m.genres || []).includes(genre)) continue;
      const releases = lr.f.map(([tier, dual, res, hdr, dv]) => ({ tier, dual: !!dual, res, hdr: !!hdr, dv: !!dv }))
        .filter((r) => releaseMatchesMode(r, uc.mode) && releaseMatchesQuality(r, uc.minRes, uc.hdrOnly));
      if (!releases.length) continue;
      items.push({ id, rec, releases, names: lr.n || [] });
    }

    const num = (v) => parseFloat(v) || 0;
    const sorters = {
      rank: (a, b) => (a.rec.m.rank ?? 1e9) - (b.rec.m.rank ?? 1e9),
      rating: (a, b) => num(b.rec.m.imdbRating) - num(a.rec.m.imdbRating),
      year: (a, b) => num(b.rec.m.releaseInfo) - num(a.rec.m.releaseInfo) || (a.rec.m.rank ?? 1e9) - (b.rec.m.rank ?? 1e9),
      found: (a, b) => (b.rec.fa || 0) - (a.rec.fa || 0),
    };
    items.sort(sorters[uc.sort] || sorters.rank);

    const metas = items.map(({ id, rec, releases, names }) => toMetaPreview(id, type, rec, releases, names));
    cache.set(key, metas);
    return metas;
  };
}

const RES_LABEL = { '2160p': '4K', '1080p': '1080p', '720p': '720p', sd: 'SD', cam: 'CAM' };

function toMetaPreview(id, type, rec, releases, names) {
  const best = releases.reduce((a, b) => (rank(b) > rank(a) ? b : a));
  const resList = [...new Set(releases.map((r) => RES_LABEL[r.res]))].join(' / ');
  const tags = [resList, releases.some((r) => r.hdr) ? 'HDR' : null, best.dual ? 'Dual audio' : 'Turkish audio'].filter(Boolean);
  return {
    id,
    type,
    name: rec.m.name,
    poster: rec.m.poster,
    posterShape: 'poster',
    releaseInfo: rec.m.releaseInfo,
    imdbRating: rec.m.imdbRating,
    genres: rec.m.genres,
    description: `🇹🇷 ${tags.join(' · ')}${names.length ? `\nExample: ${names[0]}` : ''}`,
  };
}

function rank(r) {
  return r.tier * 10 + ({ cam: 0, sd: 1, '720p': 2, '1080p': 3, '2160p': 4 }[r.res] || 0);
}

function createAddon({ cfg, store, languages }) {
  const manifest = buildManifest(languages);
  const builder = new addonBuilder(manifest);
  const list = createCatalogIndex(store);
  const catalogIds = new Map(manifest.catalogs.map((c) => [c.id, c]));

  builder.defineCatalogHandler(async ({ type, id, extra, config }) => {
    const cat = catalogIds.get(id);
    if (!cat || cat.type !== type) return { metas: [] };
    const langCode = id.split('-')[0];
    const uc = parseUserConfig(config);
    const all = list(langCode, type, uc, extra && extra.genre);
    const skip = Math.max(0, parseInt((extra && extra.skip) || 0, 10) || 0);
    return {
      metas: all.slice(skip, skip + cfg.pageSize),
      cacheMaxAge: 30 * 60,
      staleRevalidate: 6 * 3600,
      staleError: 7 * 24 * 3600,
    };
  });

  return { builder, manifest };
}

module.exports = { createAddon, buildManifest, parseUserConfig, createCatalogIndex, MODE, QUALITY, SORT };
