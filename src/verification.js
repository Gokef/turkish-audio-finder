'use strict';

const fs = require('fs');

/*
 * Real audio-track verification results, produced by scripts/verify.js (runs on a PC with
 * Stremio's streaming server, which reads the file headers with ffprobe).
 *
 * verified.json = {
 *   "<infoHash>:<fileIdx>": { v: 1 | 0 | -1, a: ["tur","eng"], at: <ms>, e?: "error" }
 * }
 *   v = 1  Turkish audio track present
 *   v = 0  audio tracks read, none Turkish  -> release is hidden
 *   v = -1 could not tell (no peers, timeout, untagged tracks)
 */

const releaseKey = (x) => `${x.h}:${x.i ?? ''}`;

function loadVerified(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn('[verify] cannot read', file, e.message);
    return {};
  }
}

/**
 * Per-language record -> list of releases with verification applied.
 * Falls back to the compact feature list (f) for records scanned before releases were stored.
 */
function effectiveReleases(langRec, verified = {}) {
  if (!langRec.x) {
    return langRec.f.map(([tier, dual, res, hdr, dv]) => ({ tier, dual: !!dual, res, hdr: !!hdr, dv: !!dv, verified: null }));
  }
  const out = [];
  for (const x of langRec.x) {
    const v = verified[releaseKey(x)];
    const base = { tier: x.t, dual: !!x.d, res: x.q, hdr: !!x.hdr, dv: !!x.dv, verified: null, x };
    if (v && v.v === 0) continue; // proven: no Turkish audio
    if (v && v.v === 1) {
      out.push({ ...base, tier: 4, dual: (v.a || []).length >= 2, verified: true, audio: v.a || [] });
    } else {
      out.push(base);
    }
  }
  return out;
}

/** Classify ffprobe output from Stremio's /hlsv2/probe. */
function classifyProbe(probe, langCodes = ['tur', 'tr'], titleRe = /t[uü]rk/i) {
  const audio = ((probe && probe.streams) || []).filter((s) => s.track === 'audio' || s.codec_type === 'audio');
  const langs = audio.map((s) => (s.language || s.lang || '').toLowerCase());
  const a = audio.map((s, i) => langs[i] || (s.title ? `?${s.title}` : '?'));
  if (!audio.length) return { v: -1, a, e: 'no audio streams' };
  const hasTr = audio.some((s, i) => langCodes.includes(langs[i]) || titleRe.test(s.title || ''));
  if (hasTr) return { v: 1, a };
  const allTagged = langs.every((l) => l && l !== 'und');
  if (allTagged) return { v: 0, a };
  return { v: -1, a, e: 'untagged audio' };
}

module.exports = { releaseKey, loadVerified, effectiveReleases, classifyProbe };
