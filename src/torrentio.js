'use strict';

const { fetchJson, sleep } = require('./http');

/**
 * Polite Torrentio client:
 *  - limited concurrency + minimum interval between requests
 *  - global pause (exponential backoff) when Torrentio answers 403/429/5xx
 *  - never logs the full URL (options could be sensitive)
 */
class TorrentioClient {
  constructor({ baseUrl, options, concurrency, minIntervalMs, timeoutMs }) {
    this.base = options ? `${baseUrl}/${options}` : baseUrl;
    this.concurrency = Math.max(1, concurrency);
    this.minIntervalMs = minIntervalMs;
    this.timeoutMs = timeoutMs;
    this.active = 0;
    this.waiters = [];
    this.nextSlot = 0;
    this.pausedUntil = 0;
    this.backoffMs = 0;
    this.stats = { requests: 0, ok: 0, errors: 0, blocked: 0, lastError: null, lastErrorAt: null };
  }

  async _acquire() {
    if (this.active >= this.concurrency) await new Promise((r) => this.waiters.push(r));
    this.active++;
    for (;;) {
      const now = Date.now();
      const wait = Math.max(this.pausedUntil, this.nextSlot) - now;
      if (wait <= 0) break;
      await sleep(wait);
    }
    this.nextSlot = Date.now() + this.minIntervalMs;
  }

  _release() {
    this.active--;
    const w = this.waiters.shift();
    if (w) w();
  }

  isPaused() {
    return Date.now() < this.pausedUntil;
  }

  /** @returns {Promise<Array>} streams (empty array if none). Throws on failure. */
  async streams(type, id) {
    await this._acquire();
    this.stats.requests++;
    try {
      const data = await fetchJson(`${this.base}/stream/${type}/${encodeURIComponent(id)}.json`, {
        timeoutMs: this.timeoutMs,
        retries: 1,
      });
      this.stats.ok++;
      this.backoffMs = 0;
      return (data && Array.isArray(data.streams)) ? data.streams : [];
    } catch (err) {
      this.stats.errors++;
      this.stats.lastError = `${err.status ? 'HTTP ' + err.status : err.name || 'error'} on ${type} ${id}`;
      this.stats.lastErrorAt = new Date().toISOString();
      if (!err.status || err.status === 403 || err.status === 429 || err.status >= 500) {
        if (err.status === 403 || err.status === 429) this.stats.blocked++;
        this.backoffMs = Math.min(Math.max(this.backoffMs * 2, 30000), 30 * 60000);
        const ra = (err.retryAfter || 0) * 1000;
        this.pausedUntil = Date.now() + Math.max(this.backoffMs, ra);
        console.warn(`[torrentio] ${this.stats.lastError}; pausing ${Math.round((this.pausedUntil - Date.now()) / 1000)}s`);
      }
      throw err;
    } finally {
      this._release();
    }
  }
}

module.exports = { TorrentioClient };
