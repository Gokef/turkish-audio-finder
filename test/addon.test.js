'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createAddon, parseUserConfig } = require('../src/addon');
const { getLanguages } = require('../src/languages');
const { sanitizeTorrentioOptions } = require('../src/config');

function fakeStore(titles) {
  return { version: 1, all: () => titles };
}
const rec = (t, rank, f) => ({
  t,
  s: 1,
  r: { tr: { f, n: ['x'] } },
  m: { name: 'N' + rank, rank, genres: ['Drama'], releaseInfo: '2020' },
});

test('catalog filters by mode/quality, paginates and does not duplicate', async () => {
  const titles = {};
  for (let i = 0; i < 250; i++) titles['tt' + (1000 + i)] = rec('movie', i, [[3, 1, i % 2 ? '1080p' : '2160p', i % 2 ? 0 : 1, 0]]);
  titles.tt9 = rec('movie', 999, [[1, 0, '1080p', 0, 0]]); // weak match only
  titles.tt8 = rec('series', 1, [[3, 1, '1080p', 0, 0]]);
  const { builder } = createAddon({ cfg: { pageSize: 100 }, store: fakeStore(titles), languages: getLanguages(['tr']) });
  const iface = builder.getInterface();

  const p1 = await iface.get('catalog', 'movie', 'tr-audio-movie', {});
  const p3 = await iface.get('catalog', 'movie', 'tr-audio-movie', { skip: '200' });
  assert.strictEqual(p1.metas.length, 100);
  assert.strictEqual(p3.metas.length, 50);
  assert.ok(!p1.metas.some((m) => m.id === 'tt9'));
  const ids = new Set([...p1.metas, ...p3.metas].map((m) => m.id));
  assert.strictEqual(ids.size, 150);

  const fourK = await iface.get('catalog', 'movie', 'tr-audio-movie', {}, { quality: '4K only', hdr: 'on' });
  assert.strictEqual(fourK.metas.length, 100);
  assert.ok(fourK.metas.every((m) => Number(m.id.slice(2)) % 2 === 0));

  const lenient = await iface.get('catalog', 'movie', 'tr-audio-movie', { skip: '200' },
    { mode: 'Lenient (more titles, may include false positives)' });
  assert.ok(lenient.metas.some((m) => m.id === 'tt9'));

  const series = await iface.get('catalog', 'series', 'tr-audio-series', {});
  assert.deepStrictEqual(series.metas.map((m) => m.id), ['tt8']);
});

test('unknown config falls back to defaults', () => {
  assert.deepStrictEqual(parseUserConfig({ mode: 'bogus' }), { mode: 'dual', minRes: 'cam', hdrOnly: false, sort: 'rank' });
});

test('debrid credentials are stripped from Torrentio options', () => {
  const out = sanitizeTorrentioOptions('providers=yts,1337x|realdebrid=SECRET123|language=turkish');
  assert.strictEqual(out, 'providers=yts,1337x|language=turkish');
});
