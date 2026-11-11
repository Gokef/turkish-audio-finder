'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { analyzeStream, releaseMatchesMode } = require('../src/detect');
const tr = require('../src/languages/tr');

const s = (title, quality = '1080p', filename) => ({
  name: `Torrentio\n${quality}`,
  title,
  behaviorHints: filename ? { filename } : {},
});
const a = (title, opts) => analyzeStream(s(title), tr, opts);

test('explicit Turkish dub statements are tier 3', () => {
  for (const t of [
    'Movie.2020.1080p.WEB-DL.TR.Dublaj.x264',
    'Movie (2020) Türkçe Dublaj 1080p',
    'Movie.2020.1080p.BluRay.DUAL.AUDIO.TUR-ENG',
    'Movie 2020 1080p MULTI AUDIO TUR AAC',
    'Movie.2020.1080p.Turkish.Dubbed.WEB',
    'Movie 2020 TR Audio 720p',
    'Movie.2020.720p.Dublajli.HDTV',
  ]) {
    const r = a(t);
    assert.ok(r, t);
    assert.strictEqual(r.tier, 3, t);
  }
});

test('English + Turkish pairs are dual tier 3', () => {
  for (const t of [
    'Inception (2010) 1080p MAX WEB-DL [EN-TR] DDP5.1 H.264-TURG',
    'Movie 2019 TR-ENG 1080p',
    'Movie English + Turkish Audio 1080p',
  ]) {
    const r = a(t);
    assert.ok(r, t);
    assert.strictEqual(r.tier, 3, t);
    assert.ok(r.dual, t);
  }
});

test('Torrentio Dual Audio with EN/TR flags qualifies', () => {
  const r = a('Inception 2010 1080p NF WEB-DL DUAL DDP5 1 H 264-TURG\n👤 3 💾 3.31 GB ⚙️ EXT\nDual Audio / 🇬🇧 / 🇹🇷');
  assert.strictEqual(r.tier, 3);
  assert.ok(releaseMatchesMode(r, 'dual'));
});

test('Turkish subtitles never qualify', () => {
  for (const t of [
    'Breaking Bad S01E01-S05E13 Turkish Sub 480p - LS\n👤 0 💾 11.03 GB ⚙️ ThePirateBay\n🇹🇷',
    'Movie.2020.1080p.WEB-DL.TR.Altyazili',
    'Movie 2020 1080p BluRay Türkçe Altyazı',
    'Movie 2020 1080p Subs: Eng Fre Tur',
    'Movie.2020.1080p.HardSub.TR',
  ]) assert.strictEqual(a(t), null, t);
});

test('subtitles plus a real dub still qualify', () => {
  const r = a('Movie 2020 1080p TR Dublaj + Turkish Subs');
  assert.strictEqual(r.tier, 3);
});

test('English-only and French MULTi releases do not match', () => {
  for (const t of [
    'Interstellar.2014.2160p.UHD.BluRay.x265.10bit.HDR.DTS-HD.MA.5.1-TERMiNAL\n👤 162 💾 33.34 GB ⚙️ RARBG',
    'Movie.2020.MULTi.1080p.BluRay.x264-LOST\n👤 1 💾 1 GB ⚙️ X\nMulti Audio / 🇫🇷',
  ]) assert.strictEqual(a(t), null, t);
});

test('Turkish flag in a long flag list is only weak', () => {
  const r = a('Inception.2010.2160p.MA.WEB-DL.DTS-HD.MA.5.1.DV.HDR.H.265-TheFarm\n👤 26 💾 29 GB ⚙️ TPB\n🇬🇧 / 🇯🇵 / 🇷🇺 / 🇵🇹 / 🇪🇸 / 🇰🇷 / 🇨🇳 / 🇫🇷 / 🇩🇪 / 🇹🇷');
  assert.strictEqual(r.tier, 1);
  assert.ok(!releaseMatchesMode(r, 'dual'));
  assert.ok(!releaseMatchesMode(r, 'verified'));
  assert.ok(releaseMatchesMode(r, 'any'));
});

test('explicit audio language list containing Tur is tier 2 dual', () => {
  const r = a('Inception.2010.Eng.Fre.Ger.Ita.Por.Spa.Cze.Hun.Pol.Rus.Tha.Tur.Chi.Jpn.2160p.BluRay.Hybrid.Remux.DV.HDR');
  assert.strictEqual(r.tier, 2);
  assert.ok(r.dual);
  assert.strictEqual(r.res, '2160p');
  assert.ok(r.hdr && r.dv);
});

test('Turkish-only dub without dual marker: verified mode only', () => {
  const r = a('Movie 2020 1080p WEB-DL Türkçe Dublaj');
  assert.ok(!releaseMatchesMode(r, 'dual'));
  assert.ok(releaseMatchesMode(r, 'verified'));
});

test('title words are ignored (The Turkish Detective)', () => {
  assert.strictEqual(a('The.Turkish.Detective.S01E01.1080p.WEB.H264', { titleName: 'The Turkish Detective' }), null);
});

test('quality parsing uses the Torrentio name line', () => {
  const r = analyzeStream(s('Movie 2020 TR Dublaj', '4k DV | HDR10+'), tr);
  assert.strictEqual(r.res, '2160p');
  assert.ok(r.hdr && r.dv);
});
