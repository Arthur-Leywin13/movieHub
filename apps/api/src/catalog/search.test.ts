import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeText, scoreMatch, similarity, tokens, tsPrefixQuery } from './search.ts';

test('normalisation : accents, casse, ponctuation, espaces', () => {
  assert.equal(normalizeText("  L'Été  de Kikujirô (1999) "), 'l ete de kikujiro 1999');
  assert.equal(normalizeText('Dune : Deuxième partie'), 'dune deuxieme partie');
  assert.deepEqual(tokens('Spider-Man: No Way Home'), ['spider', 'man', 'no', 'way', 'home']);
  assert.equal(normalizeText('ぼくらの'), 'ぼくらの');
});

test('similarité de trigrammes : identique = 1, proche > 0.3, éloigné < 0.3', () => {
  assert.equal(similarity('miserables', 'miserables'), 1);
  assert.ok(similarity('miserables', 'miserbles') > 0.3);
  assert.ok(similarity('avatar', 'interstellar') < 0.3);
  assert.equal(similarity('', 'abc'), 0);
});

test('requête plein texte : préfixes, 8 jetons maximum, aucun caractère de syntaxe', () => {
  assert.equal(tsPrefixQuery('Les Mis'), 'les:* & mis:*');
  assert.equal(tsPrefixQuery("a'b | c & (d)!"), 'a:* & b:* & c:* & d:*');
  assert.equal(tsPrefixQuery('   '), null);
  assert.equal(tsPrefixQuery('1 2 3 4 5 6 7 8 9 10')!.split('&').length, 8);
});

test('score : titre exact > préfixe > mots > faute de frappe > description ; hors sujet = 0', () => {
  const t = ['Les Misérables'];
  const exact = scoreMatch('les miserables', t, null);
  const prefix = scoreMatch('les miser', t, null);
  const words = scoreMatch('miser les', t, null);
  const typo = scoreMatch('les miserbles', t, null);
  const desc = scoreMatch('guerre', t, 'Une histoire de guerre et de paix');
  assert.equal(exact, 1);
  assert.equal(prefix, 0.95);
  assert.equal(words, 0.8);
  assert.ok(typo >= 0.3 && typo < words, `faute de frappe : ${typo}`);
  assert.equal(desc, 0.6);
  assert.equal(scoreMatch('interstellar', t, null), 0);
  assert.equal(scoreMatch('   ', t, null), 0);
});

test('score : un titre alternatif compte, sans accent ni casse', () => {
  assert.equal(scoreMatch('attack on titan', ['Shingeki no Kyojin', 'Attack on Titan'], null), 1);
  assert.ok(scoreMatch('ATTAQUE DES TITANS', ['Shingeki no Kyojin', "L’Attaque des Titans"], null) >= 0.8);
});
