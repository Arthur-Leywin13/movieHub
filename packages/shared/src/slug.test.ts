import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildContentSlug, slugify } from './slug.ts';

test('retire les accents et la ponctuation', () => {
  assert.equal(slugify('Les Misérables'), 'les-miserables');
  assert.equal(slugify("L'Été de Kikujirô (1999)"), 'l-ete-de-kikujiro-1999');
});

test('compacte les séparateurs et rogne les bords', () => {
  assert.equal(slugify('  --Hello   ___ World!! '), 'hello-world');
});

test('conserve les lettres japonaises, dakuten compris', () => {
  assert.equal(slugify('ぼくらの がっこう'), 'ぼくらの-がっこう');
});

test('respecte la longueur max sans tiret final', () => {
  const s = slugify('abc def ghi', 7);
  assert.equal(s, 'abc-def');
  assert.equal(slugify('abc def ghi', 8), 'abc-def');
});

test('slug de contenu : année et valeur de repli', () => {
  assert.equal(buildContentSlug('Akira', 1988), 'akira-1988');
  assert.equal(buildContentSlug('Akira'), 'akira');
  assert.equal(buildContentSlug('!!!', 2020), 'contenu-2020');
});
