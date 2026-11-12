'use strict';

const { analyzeStream } = require('./detect');
const { discover } = require('./cinemeta');
const { sleep } = require('./http');

const DAY = 86400000;

const MAX_RELEASES = 8;
// Bump when the per-release fields change; older records get rescanned first.
const X_VERSION = 2;
const outdated = (l) => !l.x || l.xv !== X_VERSION;

/**
 * Compact per-language summary:
 *   f: de-duplicated feature tuples [tier, dual, res, hdr, dv] (fast catalog filtering)
 *   n: sample release names
 *   x: the best individual releases (for the stream list and audio verification)
 */
function summarize(results) {
  const f = new Map();
  const names = [];
  const tf = (r) => (r.why.includes('torrentio-dual-flag') ? 1 : 0);
  results.sort((a, b) => tf(b) - tf(a) || b.tier - a.tier || b.seeders - a.seeders);
  const x = [];
  const seen = new Set();
  for (const r of results) {
    const key = [r.tier, r.dual ? 1 : 0, r.res, r.hdr ? 1 : 0, r.dv ? 1 : 0];
    f.set(key.join(','), key);
    if (names.length < 3 && !names.includes(r.name)) names.push(r.name);
    const id = `${r.infoHash}:${r.fileIdx ?? ''}`;
    if (r.infoHash && x.length < MAX_RELEASES && !seen.has(id)) {
      seen.add(id);
      x.push({
        h: r.infoHash, i: r.fileIdx, ep: r.ep, t: r.tier, d: r.dual ? 1 : 0, q: r.res,
        hdr: r.hdr ? 1 : 0, dv: r.dv ? 1 : 0, nm: r.name, fn: r.filename, sd: r.seeders,
        // Torrentio labelled it "Dual Audio / 🇬🇧 / 🇹🇷": in practice the most reliable signal.
        tf: r.why.includes('torrentio-dual-flag') ? 1 : 0,
      });
    }
  }
  return { f: [...f.values()], n: names, x, xv: X_VERSION };
}

class Scanner {
  constructor({ cfg, store, torrentio, languages }) {
    this.cfg = cfg;
    this.store = store;
    this.torrentio = torrentio;
    this.languages = languages;
    this.candidates = { movie: [], series: [] };
    this.state = { running: false, phase: 'idle', cycle: 0, scannedThisCycle: 0, queued: 0, matchedThisCycle: 0, lastCycleAt: null, nextCycleAt: null };
    this.stopped = false;
  }

  /** Analyze one title; returns per-language summaries (only languages that matched). */
  async scanTitle(c) {
    const ids = c.type === 'movie' ? [c.id] : [`${c.id}:1:1`];
    if (c.type === 'series' && this.cfg.seriesProbeLatest && c.maxSeason > 1) ids.push(`${c.id}:${c.maxSeason}:1`);

    const found = {};
    for (const sid of ids) {
      const streams = await this.torrentio.streams(c.type, sid);
      for (const lang of this.languages) {
        const extraGroups = this.cfg.extraGroups[lang.code] || [];
        for (const s of streams) {
          const r = analyzeStream(s, lang, { titleName: c.name, extraGroups });
          if (r) {
            if (c.type === 'series') r.ep = sid;
            (found[lang.code] = found[lang.code] || []).push(r);
          }
        }
      }
      // Stop probing more episodes once a strong match is found for every language.
      if (this.languages.every((l) => (found[l.code] || []).some((r) => r.tier >= 2))) break;
    }
    const out = {};
    for (const [code, rs] of Object.entries(found)) out[code] = summarize(rs);
    return out;
  }

  isDue(c, now) {
    const rec = this.store.get(c.id);
    if (!rec) return true;
    const age = now - rec.s;
    if (rec.r) {
      // Older records lack the per-release list (x) needed for streams/verification.
      if (Object.values(rec.r).some(outdated)) return true;
      return age > this.cfg.rescanPositiveDays * DAY;
    }
    const recent = c.year && c.year >= new Date().getFullYear() - 1;
    return age > (recent ? this.cfg.rescanRecentNegativeDays : this.cfg.rescanNegativeDays) * DAY;
  }

  buildQueue() {
    const now = Date.now();
    const all = [];
    // Interleave movies and series so both catalogs fill up from the start.
    const m = this.candidates.movie;
    const s = this.candidates.series;
    for (let i = 0; i < Math.max(m.length, s.length); i++) {
      if (m[i]) all.push(m[i]);
      if (s[i]) all.push(s[i]);
    }
    const unscanned = all.filter((c) => !this.store.get(c.id));
    const upgrade = all.filter((c) => {
      const rec = this.store.get(c.id);
      return rec && rec.r && Object.values(rec.r).some(outdated);
    });
    const upgradeIds = new Set(upgrade.map((c) => c.id));
    const stale = all.filter((c) => this.store.get(c.id) && !upgradeIds.has(c.id) && this.isDue(c, now))
      .sort((a, b) => this.store.get(a.id).s - this.store.get(b.id).s);
    return [...upgrade, ...unscanned, ...stale].slice(0, this.cfg.maxScansPerCycle);
  }

  /** Refresh stored metadata (rank, rating, poster) for already matched titles. */
  refreshMeta() {
    for (const type of ['movie', 'series']) {
      for (const c of this.candidates[type]) {
        const rec = this.store.get(c.id);
        if (rec && rec.r && rec.m && rec.m.rank !== c.rank) {
          rec.m = metaFrom(c);
          this.store.put(c.id, rec);
        }
      }
    }
  }

  async runCycle({ maxMinutes } = {}) {
    if (this.state.running) return false;
    const deadline = maxMinutes ? Date.now() + maxMinutes * 60000 : Infinity;
    this.state.running = true;
    this.state.cycle++;
    this.state.scannedThisCycle = 0;
    this.state.matchedThisCycle = 0;
    let backlog = false;
    try {
      this.state.phase = 'discovering';
      const [movie, series] = await Promise.all([discover(this.cfg, 'movie'), discover(this.cfg, 'series')]);
      if (movie.length) this.candidates.movie = movie;
      if (series.length) this.candidates.series = series;
      this.refreshMeta();

      const queue = this.buildQueue();
      this.state.queued = queue.length;
      this.state.phase = 'scanning';
      console.log(`[scanner] cycle ${this.state.cycle}: ${queue.length} titles to scan`);

      let idx = 0;
      let sinceSave = 0;
      const worker = async () => {
        while (idx < queue.length && !this.stopped && Date.now() < deadline) {
          const c = queue[idx++];
          try {
            const r = await this.scanTitle(c);
            const prev = this.store.get(c.id);
            const matched = Object.keys(r).length > 0;
            const rec = { t: c.type, s: Date.now(), y: c.year || undefined };
            if (matched) {
              rec.r = r;
              rec.m = metaFrom(c);
              rec.fa = (prev && prev.fa) || Date.now();
              this.state.matchedThisCycle++;
            }
            this.store.put(c.id, rec);
            this.state.scannedThisCycle++;
            if (++sinceSave >= 50) {
              sinceSave = 0;
              await this.store.save();
            }
          } catch (err) {
            // Keep previous result; title stays due and is retried next cycle.
            if (this.torrentio.isPaused()) await sleep(1000);
          }
        }
      };
      await Promise.all(Array.from({ length: this.cfg.torrentioConcurrency }, worker));
      await this.store.save();
      backlog = queue.length >= this.cfg.maxScansPerCycle || idx < queue.length;
      console.log(`[scanner] cycle ${this.state.cycle} done: scanned ${this.state.scannedThisCycle}, matched ${this.state.matchedThisCycle}`);
    } catch (err) {
      console.error('[scanner] cycle failed:', err);
    } finally {
      this.state.running = false;
      this.state.phase = 'idle';
      this.state.lastCycleAt = new Date().toISOString();
    }
    return backlog;
  }

  async loop() {
    for (;;) {
      if (this.stopped) return;
      const backlog = await this.runCycle();
      // Backlog left (first fill, or Torrentio pauses)? Continue soon instead of waiting hours.
      const ms = backlog ? 5 * 60000 : this.cfg.scanIntervalHours * 3600000;
      this.state.nextCycleAt = new Date(Date.now() + ms).toISOString();
      await sleep(ms);
    }
  }
}

function metaFrom(c) {
  return { name: c.name, poster: c.poster, releaseInfo: c.releaseInfo, imdbRating: c.imdbRating, genres: c.genres, rank: c.rank };
}

module.exports = { Scanner, summarize };
