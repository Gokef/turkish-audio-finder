'use strict';

const { fetchJson, sleep } = require('./http');

const PAGE = 50; // Cinemeta returns 50 items per page

/** Compact candidate record kept for every discovered title. */
function toCandidate(m, type) {
  const id = m.imdb_id || m.id;
  if (!id || !/^tt\d+$/.test(id)) return null;
  let maxSeason = 0;
  if (Array.isArray(m.videos)) for (const v of m.videos) if (v.season > maxSeason) maxSeason = v.season;
  const year = parseInt(m.year || m.releaseInfo, 10) || null;
  return {
    id,
    type,
    name: m.name,
    poster: m.poster || `https://images.metahub.space/poster/medium/${id}/img`,
    year,
    releaseInfo: m.releaseInfo || (year ? String(year) : undefined),
    imdbRating: m.imdbRating ? String(m.imdbRating) : undefined,
    genres: Array.isArray(m.genres) ? m.genres.slice(0, 6) : (Array.isArray(m.genre) ? m.genre.slice(0, 6) : []),
    maxSeason: maxSeason || undefined,
  };
}

async function crawl(base, type, catalog, depth, genre, onItem) {
  for (let skip = 0; skip < depth; skip += PAGE) {
    const extra = [genre ? `genre=${encodeURIComponent(genre)}` : null, skip ? `skip=${skip}` : null].filter(Boolean).join('&');
    const url = `${base}/catalog/${type}/${catalog}${extra ? '/' + extra : ''}.json`;
    let data;
    try {
      data = await fetchJson(url, { timeoutMs: 20000, retries: 2 });
    } catch (err) {
      console.warn(`[cinemeta] ${type}/${catalog} ${genre || ''} skip=${skip}: ${err.message}`);
      break;
    }
    const metas = (data && data.metas) || [];
    if (!metas.length) break;
    metas.forEach(onItem);
    if (metas.length < PAGE) break;
    await sleep(150);
  }
}

/**
 * Builds a de-duplicated, popularity-ordered candidate list from several Cinemeta catalogs.
 * Order = rank in "top" first, then highly rated, then per-year lists.
 */
async function discover(cfg, type) {
  const isMovie = type === 'movie';
  const seen = new Map();
  let rank = 0;
  const add = (m) => {
    const c = toCandidate(m, type);
    if (!c || seen.has(c.id)) return;
    c.rank = rank++;
    seen.set(c.id, c);
  };
  const base = cfg.cinemetaUrl;
  await crawl(base, type, 'top', isMovie ? cfg.movieTopDepth : cfg.seriesTopDepth, null, add);
  await crawl(base, type, 'imdbRating', isMovie ? cfg.movieRatingDepth : cfg.seriesRatingDepth, null, add);
  const yearDepth = isMovie ? cfg.movieYearDepth : cfg.seriesYearDepth;
  if (yearDepth > 0) {
    const thisYear = new Date().getFullYear();
    for (let y = thisYear; y >= cfg.yearFrom; y--) await crawl(base, type, 'year', yearDepth, String(y), add);
  }
  console.log(`[cinemeta] discovered ${seen.size} ${type} candidates`);
  return [...seen.values()];
}

module.exports = { discover, toCandidate };
