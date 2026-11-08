import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConflictError, ValidationError } from '@movieshub/shared';
import {
  assertDate, assertHttpsUrl, assertTransition, canTransition, dedupeTexts, normalizeCodes, subtitleFormatFromKey,
  summarizeContentChanges, type ContentSnapshot,
} from './rules.ts';

test('statuts : transitions autorisées et interdites', () => {
  assert.equal(canTransition('DRAFT', 'PUBLISHED'), true);
  assert.equal(canTransition('PUBLISHED', 'UNPUBLISHED'), true);
  assert.equal(canTransition('UNPUBLISHED', 'PUBLISHED'), true);
  assert.equal(canTransition('ARCHIVED', 'DRAFT'), true);
  assert.equal(canTransition('PUBLISHED', 'DRAFT'), false);
  assert.equal(canTransition('PUBLISHED', 'IN_PREPARATION'), false);
  assert.equal(canTransition('ARCHIVED', 'PUBLISHED'), false);
  for (const to of ['DRAFT', 'PUBLISHED', 'ARCHIVED', 'UNPUBLISHED'] as const) assert.equal(canTransition('WITHDRAWN', to), false);
  assert.throws(() => assertTransition('PUBLISHED', 'DRAFT'), ConflictError);
});

test('langues : normalisation, doublons, codes invalides, limite', () => {
  assert.deepEqual(normalizeCodes(['FR', ' fr ', 'Ja', 'pt-BR'], 'x'), ['fr', 'ja', 'pt-br']);
  assert.throws(() => normalizeCodes(['français'], 'x'), ValidationError);
  assert.throws(() => normalizeCodes(['f'], 'x'), ValidationError);
  const many = Array.from({ length: 21 }, (_, i) => `a${String.fromCharCode(97 + i)}`);
  assert.throws(() => normalizeCodes(many, 'x'), /Trop de valeurs/);
});

test('textes : doublons insensibles à la casse, première graphie gardée', () => {
  assert.deepEqual(dedupeTexts([' Akira ', 'AKIRA', '', 'Akira Remastered']), ['Akira', 'Akira Remastered']);
});

const BEFORE: ContentSnapshot = {
  title: 'Akira', description: null, year: 1988, releaseDate: '1988-07-16', altTitles: ['アキラ'],
  genres: [{ slug: 'animation', name: 'Animation' }], audioLanguages: ['fr'], subtitleLanguages: ['fr'],
};

test('résumé : seuls les vrais changements apparaissent', () => {
  assert.deepEqual(summarizeContentChanges(BEFORE, { title: 'Akira', year: 1988, genres: { add: ['animation'] }, audioLanguages: { remove: ['ja'] } }), []);
  const lines = summarizeContentChanges(BEFORE, { title: 'Akira (version restaurée)', audioLanguages: { add: ['ja'] }, genres: { add: ['Science-fiction'], remove: ['ANIMATION'] } });
  assert.deepEqual(lines.map((l) => l.field), ['title', 'genres', 'audioLanguages']);
  assert.deepEqual(lines.find((l) => l.field === 'audioLanguages'), { field: 'audioLanguages', from: ['fr'], to: ['fr', 'ja'] });
  assert.deepEqual(lines.find((l) => l.field === 'genres')?.to, ['Science-fiction']);
});

test('résumé : effacer un champ optionnel est un changement', () => {
  const lines = summarizeContentChanges({ ...BEFORE, description: 'Texte' }, { description: null, releaseDate: null });
  assert.deepEqual(lines.map((l) => [l.field, l.from, l.to]), [['description', 'Texte', null], ['releaseDate', '1988-07-16', null]]);
});

test('dates et liens : validation stricte', () => {
  assert.doesNotThrow(() => assertDate('2026-02-28', 'd'));
  for (const bad of ['2026-02-30', '2026-13-01', '26-01-01', '2026/01/01', '']) assert.throws(() => assertDate(bad, 'd'), ValidationError, bad);
  assert.doesNotThrow(() => assertHttpsUrl('https://www.youtube.com/watch?v=abc', 'u'));
  for (const bad of ['http://x.com/a', 'javascript:alert(1)', 'https://localhost/x', 'pas-un-lien', 'ftp://a.com']) assert.throws(() => assertHttpsUrl(bad, 'u'), ValidationError, bad);
});

test('sous-titres : format déduit de l’extension de la clé', () => {
  assert.equal(subtitleFormatFromKey('subtitle/2026/11/x.srt'), 'SRT');
  assert.equal(subtitleFormatFromKey('a.VTT'), 'WEBVTT');
  assert.equal(subtitleFormatFromKey('a.ass'), 'ASS');
  assert.equal(subtitleFormatFromKey('a.ssa'), 'SSA');
  assert.equal(subtitleFormatFromKey('a.sup'), 'OTHER');
});
