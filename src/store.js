'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/*
 * Scan results database (kept fully in memory, persisted as one gzipped JSON blob).
 *
 * db.titles[id] = {
 *   t: 'movie' | 'series',
 *   s: lastScannedAt (ms),
 *   y: year (for rescan scheduling),
 *   r: { [lang]: { f: [[tier, dual, res, hdr, dv], ...], n: [sample release names] } }  // only if matched
 *   m: { name, poster, releaseInfo, imdbRating, genres, rank }                          // only if matched
 *   fa: foundAt (ms)                                                                    // first time matched
 * }
 */

class FileBackend {
  constructor(dir) {
    this.file = path.resolve(dir, 'db.json.gz');
  }
  async load() {
    try {
      return zlib.gunzipSync(fs.readFileSync(this.file)).toString('utf8');
    } catch (e) {
      if (e.code !== 'ENOENT') console.warn('[store] file load failed:', e.message);
      return null;
    }
  }
  async save(json) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, zlib.gzipSync(json));
    fs.renameSync(tmp, this.file);
  }
  describe() {
    return 'file';
  }
}

/** Upstash Redis via its REST API (free tier, no extra dependency). */
class UpstashBackend {
  constructor(url, token, key) {
    this.url = url;
    this.token = token;
    this.key = key;
  }
  async _cmd(args) {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(30000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.error) throw new Error(`Upstash ${res.status}: ${body.error || 'request failed'}`);
    return body.result;
  }
  async load() {
    const b64 = await this._cmd(['GET', this.key]);
    if (!b64) return null;
    return zlib.gunzipSync(Buffer.from(b64, 'base64')).toString('utf8');
  }
  async save(json) {
    await this._cmd(['SET', this.key, zlib.gzipSync(json).toString('base64')]);
  }
  describe() {
    return 'upstash';
  }
}

class Store {
  constructor(cfg) {
    this.backend = cfg.storage === 'upstash'
      ? new UpstashBackend(cfg.upstashUrl, cfg.upstashToken, cfg.storageKey)
      : new FileBackend(cfg.dataDir);
    this.db = { v: 1, updatedAt: 0, titles: {} };
    this.verifiedFile = cfg.verifiedFile;
    this.verified = {};
    this.dirty = false;
    this.version = 0; // bumps on every change → used to invalidate catalog caches
  }

  async load() {
    if (this.verifiedFile) this.verified = require('./verification').loadVerified(this.verifiedFile);
    try {
      const json = await this.backend.load();
      if (json) {
        const parsed = JSON.parse(json);
        if (parsed && parsed.titles) this.db = parsed;
      }
      this.version++;
      console.log(`[store] loaded ${Object.keys(this.db.titles).length} titles from ${this.backend.describe()}`);
    } catch (e) {
      console.error('[store] load failed, starting empty:', e.message);
    }
  }

  async save() {
    if (!this.dirty) return;
    this.db.updatedAt = Date.now();
    const json = JSON.stringify(this.db);
    try {
      await this.backend.save(json);
      this.dirty = false;
      console.log(`[store] saved ${Object.keys(this.db.titles).length} titles (${Math.round(json.length / 1024)} KB raw)`);
    } catch (e) {
      console.error('[store] save failed:', e.message);
    }
  }

  get(id) {
    return this.db.titles[id];
  }

  put(id, rec) {
    this.db.titles[id] = rec;
    this.dirty = true;
    this.version++;
  }

  all() {
    return this.db.titles;
  }
}

module.exports = { Store };
