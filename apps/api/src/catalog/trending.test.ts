import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TRENDING, daysAgo, isoDay, parseWeights, rankTrending } from './trending.ts';

test('pondérations : défauts, valeurs valides, valeurs invalides ignorées une à une', () => {
  assert.deepEqual(parseWeights(null), DEFAULT_TRENDING);
  assert.deepEqual(parseWeights({ views: 2, downloads: 0, favorites: 1, plays: 4, windowDays: 14 }), { views: 2, downloads: 0, favorites: 1, plays: 4, windowDays: 14 });
  assert.deepEqual(parseWeights({ views: -1, downloads: 'x', favorites: 5000, windowDays: 0.5 }), DEFAULT_TRENDING);
  assert.equal(parseWeights({ windowDays: 61 }).windowDays, 7);
});

test('classement : score pondéré, zéro exclu, égalité départagée de façon stable', () => {
  const rows = [
    { contentId: 'b', views: 10, downloads: 0, favorites: 0, plays: 0 },
    { contentId: 'a', views: 0, downloads: 2, favorites: 0, plays: 0 },
    { contentId: 'z', views: 0, downloads: 0, favorites: 0, plays: 0 },
    { contentId: 'c', views: 0, downloads: 0, favorites: 0, plays: 5 },
  ];
  assert.deepEqual(rankTrending(rows, DEFAULT_TRENDING).map((r) => [r.contentId, r.score]), [['a', 10], ['b', 10], ['c', 10]]);
  assert.deepEqual(rankTrending(rows, { ...DEFAULT_TRENDING, plays: 100 }).map((r) => r.contentId), ['c', 'a', 'b']);
});

test('jours : AAAA-MM-JJ et fenêtre glissante', () => {
  const d = new Date('2026-11-05T23:59:59Z');
  assert.equal(isoDay(d), '2026-11-05');
  assert.equal(daysAgo(d, 6), '2026-10-30');
  assert.equal(daysAgo(d, 0), '2026-11-05');
});
