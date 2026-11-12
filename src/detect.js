'use strict';

const { LANGUAGE_CODES } = require('./languages');

/*
 * Release classification.
 *
 * Torrentio stream objects look like:
 *   name:  "Torrentio\n4k DV | HDR10+"
 *   title: "<release name>\n[<file name>\n]👤 12 💾 3.4 GB ⚙️ 1337x\n[Dual Audio / ]🇬🇧 / 🇹🇷"
 *   behaviorHints.filename: "<file>.mkv"
 *
 * Each release gets a confidence tier for a language:
 *   3 = explicit audio statement (TR Dublaj, DUAL TR, EN-TR, Torrentio "Dual Audio" + exactly EN/TR flags)
 *   2 = strong indication (explicit language list containing Tur, known TR dual-audio group,
 *       MULTi/DUAL marker + Turkish mention or Turkish flag on a short flag list)
 *   1 = weak (only a Turkish flag on a long flag list, or a bare "TR" token) – often subtitles
 *   null = no Turkish audio, or Turkish appears only as subtitles
 *
 * Audio cannot be verified from the actual media file: Torrentio only exposes names and an
 * infoHash, and probing audio tracks would require downloading parts of the torrent.
 * See README "Why not real audio-track verification?".
 */

const FLAG_RE = /\p{Regional_Indicator}{2}/gu;
const MANY_FLAGS = 6;
const LIST_RE = new RegExp(
  `(?<![a-z])(?:${LANGUAGE_CODES.join('|')})(?:[\\s._\\-/,+]+(?:${LANGUAGE_CODES.join('|')})){1,}(?![a-z])`,
  'gi'
);
const DUAL_MARKER_RE = /(?<![a-z0-9])(?:dual|multi|multi\d|dual[\s._-]?audio|multi[\s._-]?audio)(?![a-z])/i;

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function splitTitle(stream) {
  const lines = String(stream.title || stream.description || '').split('\n').map((l) => l.trim()).filter(Boolean);
  let flagLine = '';
  const nameLines = [];
  for (const line of lines) {
    if (/👤|💾|⚙️/.test(line)) continue;
    if (/^(?:dual audio|multi audio|multi subs)\b/i.test(line) || (line.match(FLAG_RE) || []).length && line.replace(FLAG_RE, '').replace(/[\s/]/g, '').length < line.length / 2) {
      flagLine = line;
      continue;
    }
    nameLines.push(line);
  }
  const filename = (stream.behaviorHints && stream.behaviorHints.filename) || '';
  return { release: nameLines.join(' | '), filename, flagLine };
}

function parseQuality(stream, text) {
  const head = String(stream.name || '').split('\n').slice(1).join(' ');
  const all = `${head} ${text}`;
  let res = 'sd';
  if (/\b(?:4k|2160p|uhd)\b/i.test(all)) res = '2160p';
  else if (/\b1080p\b/i.test(all)) res = '1080p';
  else if (/\b720p\b/i.test(all)) res = '720p';
  if (/\b(?:cam|camrip|hdcam|ts|telesync|hdts|tc|scr|screener)\b/i.test(head)) res = 'cam';
  const dv = /\b(?:dv|dovi|dolby[\s._-]?vision)\b/i.test(all);
  const hdr = dv || /\bhdr(?:10\+?|10plus)?\b/i.test(all);
  return { res, hdr, dv };
}

/**
 * @param {object} stream  Torrentio stream
 * @param {object} lang    language definition (see languages/tr.js)
 * @param {object} [opts]  { titleName: string, extraGroups: string[] }
 * @returns {null|{tier:number,dual:boolean,res:string,hdr:boolean,dv:boolean,name:string,why:string[]}}
 */
function analyzeStream(stream, lang, opts = {}) {
  const { release, filename, flagLine } = splitTitle(stream);
  let text = `${release} ${filename}`;

  // Remove the movie/series title itself so "The Turkish Gambit" doesn't count as Turkish.
  if (opts.titleName) {
    const words = opts.titleName.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1);
    if (words.length) {
      const re = new RegExp(words.map(escapeRe).join('[\\s._\\-:,]*'), 'giu');
      text = text.replace(re, ' ');
    }
  }

  // Strip subtitle phrases; remember whether Turkish appeared in them.
  let subtitleHit = false;
  for (const re of lang.subtitlePatterns) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    text = text.replace(g, (m) => {
      if (lang.tokenPattern.test(m) || /altyaz/i.test(m)) subtitleHit = true;
      return ' ';
    });
  }

  const flags = flagLine.match(FLAG_RE) || [];
  const hasFlag = flags.includes(lang.flag);
  const torrentioDual = /^dual audio/i.test(flagLine);
  const torrentioMulti = /^multi audio/i.test(flagLine);
  const nameDual = DUAL_MARKER_RE.test(text);
  const dualMarker = torrentioDual || torrentioMulti || nameDual;

  let tier = 0;
  let dual = false;
  const why = [];
  const bump = (t, reason, isDual) => {
    if (t > tier) tier = t;
    if (isDual) dual = true;
    why.push(reason);
  };

  if (lang.audioPatterns.some((re) => re.test(text))) bump(3, 'explicit-audio', false);
  if (lang.pairPatterns.some((re) => re.test(text))) bump(3, 'language-pair', true);

  const groups = [...lang.groups, ...(opts.extraGroups || [])];
  if (groups.length) {
    const gre = new RegExp(`(?:^|[\\s._\\-\\[(])(?:${groups.map(escapeRe).join('|')})(?:$|[\\s._\\-\\])]|\\.mkv|\\.mp4)`, 'i');
    if (gre.test(release) || gre.test(filename)) bump(dualMarker || hasFlag ? 3 : 2, 'tr-group', true);
  }

  for (const m of text.match(LIST_RE) || []) {
    const codes = m.toLowerCase().split(/[\s._\-/,+]+/);
    if (codes.includes(lang.listCode) && codes.length >= 2) {
      bump(2, 'language-list', true);
      break;
    }
  }

  const token = lang.tokenPattern.test(text);
  if (token && dualMarker) bump(2, 'token+dual-marker', true);
  else if (token) bump(1, 'token', false);

  if (hasFlag) {
    if (torrentioDual && flags.length <= 3) bump(3, 'torrentio-dual-flag', true);
    else if (dualMarker && flags.length <= MANY_FLAGS) bump(2, 'flag+dual-marker', true);
    else bump(1, flags.length > MANY_FLAGS ? 'flag-in-long-list' : 'flag', false);
  }

  if (!tier) return null;
  // Turkish mentioned only as subtitles, nothing stronger → reject.
  if (subtitleHit && tier <= 1) return null;

  if (dualMarker) dual = true;
  const q = parseQuality(stream, `${release} ${filename}`);
  const seeders = parseInt((String(stream.title || '').match(/👤\s*(\d+)/) || [])[1], 10) || 0;
  return {
    tier, dual, ...q, name: release.split(' | ')[0].slice(0, 160), why,
    infoHash: stream.infoHash, fileIdx: stream.fileIdx, filename: filename || undefined, seeders,
  };
}

/** Does a single analyzed release satisfy the user's mode? */
function releaseMatchesMode(r, mode) {
  // Verified by the audio check, or labelled "Dual Audio / 🇬🇧 / 🇹🇷" by Torrentio (correct in 77/77
  // checks so far). Releases the check proved wrong never get here (effectiveReleases drops them).
  if (mode === 'confirmed') return r.verified === true || !!(r.x && r.x.tf);
  if (mode === 'any') return r.tier >= 1;
  if (mode === 'verified') return r.tier >= 2;
  return r.tier >= 2 && r.dual; // 'dual' (default)
}

const RES_RANK = { cam: 0, sd: 1, '720p': 2, '1080p': 3, '2160p': 4 };

function releaseMatchesQuality(r, minRes, hdrOnly) {
  if (hdrOnly && !r.hdr) return false;
  return (RES_RANK[r.res] || 0) >= (RES_RANK[minRes] || 0);
}

module.exports = { analyzeStream, releaseMatchesMode, releaseMatchesQuality, splitTitle, RES_RANK };
