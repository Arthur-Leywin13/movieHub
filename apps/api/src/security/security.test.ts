import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { ValidationError } from '@movieshub/shared';
import { assertPasswordPolicy, hashPassword, needsRehash, verifyPassword, DEFAULT_SCRYPT_PARAMS } from './password.ts';
import { signJwt, verifyJwt } from './jwt.ts';
import { generateRefreshToken, hashRefreshToken, safeEqual } from './tokens.ts';
import { SlidingWindowLimiter } from './rate-limit.ts';

const FAST = { N: 2 ** 10, r: 8, p: 1 };

test('password : hash puis vérification, format et sel aléatoire', async () => {
  const h1 = await hashPassword('Motdepasse-Solide1', FAST);
  const h2 = await hashPassword('Motdepasse-Solide1', FAST);
  assert.match(h1, /^scrypt\$1024\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  assert.notEqual(h1, h2);
  assert.equal(await verifyPassword('Motdepasse-Solide1', h1), true);
  assert.equal(await verifyPassword('motdepasse-solide1', h1), false);
  assert.ok(!h1.includes('Motdepasse'));
});

test('password : normalisation Unicode (NFKC) et hash illisible refusé', async () => {
  const h = await hashPassword('ｐａｓｓｗｏｒｄ１２３', FAST);
  assert.equal(await verifyPassword('password123', h), true);
  assert.equal(await verifyPassword('x', 'pas-un-hash'), false);
  assert.equal(await verifyPassword('x', 'scrypt$3$8$1$AAAAAAAAAAAA$AAAA'), false);
});

test('password : needsRehash détecte les paramètres plus faibles', async () => {
  assert.equal(needsRehash(await hashPassword('Motdepasse-Solide1', FAST)), true);
  assert.equal(needsRehash(await hashPassword('Motdepasse-Solide1', FAST), FAST), false);
  assert.equal(needsRehash('garbage'), true);
  assert.deepEqual(DEFAULT_SCRYPT_PARAMS, { N: 32768, r: 8, p: 3 });
});

test('password : paramètres par défaut utilisables (pas de dépassement mémoire, temps raisonnable)', async () => {
  const t0 = Date.now();
  const h = await hashPassword('Motdepasse-Solide1');
  assert.equal(await verifyPassword('Motdepasse-Solide1', h), true);
  const ms = Date.now() - t0;
  console.log(`# scrypt par défaut : hash + vérification en ${ms} ms`);
  assert.ok(ms < 8000, `trop lent : ${ms} ms`);
});

test('password : politique de longueur', () => {
  assert.throws(() => assertPasswordPolicy('court'), ValidationError);
  assert.throws(() => assertPasswordPolicy('a'.repeat(129)), ValidationError);
  assert.throws(() => assertPasswordPolicy('        '), ValidationError);
  assert.throws(() => assertPasswordPolicy(12345678), ValidationError);
  assert.doesNotThrow(() => assertPasswordPolicy('huit-car'));
});

const SECRET = 's'.repeat(40);
const NOW = new Date('2026-11-01T12:00:00Z');

test('jwt : signature puis vérification', () => {
  const t = signJwt({ sub: 'u1', sid: 's1' }, SECRET, { expiresInSeconds: 900, issuer: 'movieshub', now: NOW });
  const p = verifyJwt(t, SECRET, { issuer: 'movieshub', now: new Date(NOW.getTime() + 60_000) });
  assert.equal(p.sub, 'u1');
  assert.equal(p.sid, 's1');
  assert.equal(p.exp - p.iat, 900);
});

test('jwt : expiré, mauvaise clé, mauvais émetteur, charge altérée', () => {
  const t = signJwt({ sub: 'u1', sid: 's1' }, SECRET, { expiresInSeconds: 900, issuer: 'movieshub', now: NOW });
  assert.throws(() => verifyJwt(t, SECRET, { issuer: 'movieshub', now: new Date(NOW.getTime() + 901_000) }), /invalide ou expiré/);
  assert.throws(() => verifyJwt(t, 'autre'.repeat(10), { issuer: 'movieshub', now: NOW }), /invalide/);
  assert.throws(() => verifyJwt(t, SECRET, { issuer: 'autre', now: NOW }), /invalide/);
  const parts = t.split('.');
  const forged = Buffer.from(JSON.stringify({ sub: 'admin', sid: 's1', iss: 'movieshub', iat: 1, exp: 9999999999 })).toString('base64url');
  assert.throws(() => verifyJwt(`${parts[0]}.${forged}.${parts[2]}`, SECRET, { issuer: 'movieshub', now: NOW }), /invalide/);
});

test('jwt : refuse alg=none et tout autre en-tête, même avec une signature valide', () => {
  const body = Buffer.from(JSON.stringify({ sub: 'u1', sid: 's1', iss: 'movieshub', iat: 1, exp: 9999999999 })).toString('base64url');
  const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${body}.`;
  assert.throws(() => verifyJwt(none, SECRET, { issuer: 'movieshub', now: NOW }), /invalide/);
  const h384 = Buffer.from('{"alg":"HS384","typ":"JWT"}').toString('base64url');
  const sig = createHmac('sha384', SECRET).update(`${h384}.${body}`).digest('base64url');
  assert.throws(() => verifyJwt(`${h384}.${body}.${sig}`, SECRET, { issuer: 'movieshub', now: NOW }), /invalide/);
  assert.throws(() => verifyJwt('abc', SECRET, { issuer: 'movieshub' }), /invalide/);
});

test('tokens : refresh aléatoire, hash HMAC dépendant du secret, comparaison sûre', () => {
  const a = generateRefreshToken();
  const b = generateRefreshToken();
  assert.notEqual(a, b);
  assert.ok(a.length >= 64);
  assert.equal(hashRefreshToken(a, 'pepper1'), hashRefreshToken(a, 'pepper1'));
  assert.notEqual(hashRefreshToken(a, 'pepper1'), hashRefreshToken(a, 'pepper2'));
  assert.match(hashRefreshToken(a, 'p'), /^[0-9a-f]{64}$/);
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
});

test('rate limit : fenêtre glissante, retry-after, reset', () => {
  let now = 1_000_000;
  const l = new SlidingWindowLimiter({ max: 3, windowMs: 60_000, now: () => now });
  assert.equal(l.hit('k').allowed, true);
  assert.equal(l.hit('k').allowed, true);
  assert.equal(l.hit('k').allowed, true);
  const blocked = l.hit('k');
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfterSeconds, 60);
  assert.equal(l.hit('autre').allowed, true);
  now += 30_000;
  assert.equal(l.hit('k').retryAfterSeconds, 30);
  now += 31_000;
  assert.equal(l.hit('k').allowed, true);
  l.reset('k');
  assert.equal(l.hit('k').allowed, true);
  assert.throws(() => {
    for (let i = 0; i < 5; i++) l.assert('z');
  }, /Trop de tentatives/);
});
