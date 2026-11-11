'use strict';

const UA = 'TurkishAudioFinder/2.0 (+stremio addon)';

class HttpError extends Error {
  constructor(status, url, retryAfter) {
    super(`HTTP ${status}`);
    this.status = status;
    this.url = url;
    this.retryAfter = retryAfter;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * GET JSON with timeout + retries (network errors, 5xx). 403/429 are NOT retried here:
 * they are thrown so callers can back off globally.
 */
async function fetchJson(url, { timeoutMs = 15000, retries = 2, headers = {} } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': UA, accept: 'application/json', ...headers },
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 404) return null;
      if (!res.ok) {
        const ra = Number(res.headers.get('retry-after')) || 0;
        throw new HttpError(res.status, url, ra);
      }
      return await res.json();
    } catch (err) {
      lastErr = err;
      const status = err.status || 0;
      if (status === 403 || status === 429 || (status >= 400 && status < 500)) throw err;
      if (attempt < retries) await sleep(1000 * 2 ** attempt + Math.random() * 500);
    }
  }
  throw lastErr;
}

module.exports = { fetchJson, HttpError, sleep, UA };
