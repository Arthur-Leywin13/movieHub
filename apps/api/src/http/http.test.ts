import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { ValidationError } from '@movieshub/shared';
import { Router } from './router.ts';
import { createHttpServer } from './server.ts';
import { asObject, email, int, oneOf, optStr, str, uuidParam } from './validation.ts';

test('routeur : littéral, paramètres décodés, méthode non autorisée, 404', () => {
  const r = new Router()
    .add('GET', '/a/:id', () => ({ status: 200 }))
    .add('POST', '/a/:id', () => ({ status: 201 }))
    .add('GET', '/health', () => ({ status: 200 }));
  const m = r.match('GET', '/a/x%20y/');
  assert.equal(m.kind, 'found');
  if (m.kind === 'found') assert.deepEqual(m.params, { id: 'x y' });
  assert.deepEqual(r.match('DELETE', '/a/1'), { kind: 'method_not_allowed', allowed: ['GET', 'POST'] });
  assert.deepEqual(r.match('GET', '/nope'), { kind: 'not_found' });
  assert.deepEqual(r.match('GET', '/a/%E0%A4%A'), { kind: 'not_found' });
});

test('validation : champs texte, e-mail normalisé, entiers, énumérations, uuid', () => {
  const o = asObject({ n: '  Bob  ', e: ' Bob@Exemple.COM ', i: 5, k: 'A' });
  assert.equal(str(o, 'n'), 'Bob');
  assert.equal(email(o, 'e'), 'bob@exemple.com');
  assert.equal(int(o, 'i', { min: 1, max: 10 }), 5);
  assert.equal(oneOf(o, 'k', ['A', 'B'] as const), 'A');
  assert.equal(optStr(o, 'absent'), undefined);
  assert.throws(() => asObject([]), ValidationError);
  assert.throws(() => asObject('x'), ValidationError);
  assert.throws(() => str({ n: 5 }, 'n'), ValidationError);
  assert.throws(() => str({ n: 'x'.repeat(10) }, 'n', { max: 5 }), /trop long/);
  assert.throws(() => email({ e: 'pas-un-email' }, 'e'), /e-mail invalide/);
  assert.throws(() => int({ i: 1.5 }, 'i', { min: 0, max: 9 }), ValidationError);
  assert.throws(() => int({ i: 99 }, 'i', { min: 0, max: 9 }), /entre/);
  assert.throws(() => oneOf({ k: 'Z' }, 'k', ['A'] as const), ValidationError);
  assert.equal(uuidParam('0A1B2C3D-0000-4000-8000-000000000001'), '0a1b2c3d-0000-4000-8000-000000000001');
  assert.throws(() => uuidParam('../etc/passwd'), ValidationError);
});

const router = new Router()
  .add('GET', '/ok', () => ({ status: 200, body: { ok: true } }))
  .add('POST', '/echo', (req) => ({ status: 200, body: { body: req.body, ip: req.ip } }))
  .add('GET', '/boom', () => {
    throw new Error('mot de passe postgres://u:secret@db');
  })
  .add('GET', '/vide', () => ({ status: 204 }));

const server = createHttpServer({ router, maxBodyBytes: 100, corsOrigins: ['https://admin.exemple.com'], trustProxy: false });
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => server.close());

test('serveur : réponse JSON, en-têtes de sécurité, identifiant de requête', async () => {
  const res = await fetch(`${base}/ok`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.match(res.headers.get('x-request-id') ?? '', /^[0-9a-f-]{36}$/);
});

test('serveur : 404, 405 avec Allow, 204 sans corps', async () => {
  const nf = await fetch(`${base}/inconnu`);
  assert.equal(nf.status, 404);
  assert.equal(((await nf.json()) as { error: { code: string } }).error.code, 'NOT_FOUND');
  const na = await fetch(`${base}/ok`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(na.status, 405);
  assert.equal(na.headers.get('allow'), 'GET');
  const empty = await fetch(`${base}/vide`);
  assert.equal(empty.status, 204);
  assert.equal(await empty.text(), '');
});

test('serveur : corps JSON, JSON invalide, mauvais Content-Type, corps trop gros', async () => {
  const ok = await fetch(`${base}/echo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":1}' });
  const j = (await ok.json()) as { body: unknown; ip: string };
  assert.deepEqual(j.body, { a: 1 });
  assert.match(j.ip, /127\.0\.0\.1/);
  const bad = await fetch(`${base}/echo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{pas json' });
  assert.equal(bad.status, 400);
  const ct = await fetch(`${base}/echo`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' });
  assert.equal(ct.status, 415);
  const big = await fetch(`${base}/echo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ x: 'y'.repeat(300) }) });
  assert.equal(big.status, 413);
});

test('serveur : une erreur inattendue ne divulgue rien (500 générique)', async () => {
  const res = await fetch(`${base}/boom`);
  assert.equal(res.status, 500);
  const text = await res.text();
  assert.ok(!text.includes('secret'));
  assert.ok(!text.includes('postgres'));
  assert.equal((JSON.parse(text) as { error: { code: string } }).error.code, 'INTERNAL_ERROR');
});

test('serveur : CORS — origine autorisée, origine refusée, pré-vol OPTIONS', async () => {
  const allowed = await fetch(`${base}/ok`, { headers: { origin: 'https://admin.exemple.com' } });
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://admin.exemple.com');
  assert.equal(allowed.headers.get('vary'), 'Origin');
  const denied = await fetch(`${base}/ok`, { headers: { origin: 'https://pirate.example' } });
  assert.equal(denied.headers.get('access-control-allow-origin'), null);
  const pre = await fetch(`${base}/echo`, { method: 'OPTIONS', headers: { origin: 'https://admin.exemple.com' } });
  assert.equal(pre.status, 204);
  assert.match(pre.headers.get('access-control-allow-headers') ?? '', /authorization/);
  const preDenied = await fetch(`${base}/echo`, { method: 'OPTIONS', headers: { origin: 'https://pirate.example' } });
  assert.equal(preDenied.status, 204);
  assert.equal(preDenied.headers.get('access-control-allow-origin'), null);
  assert.equal(preDenied.headers.get('access-control-allow-methods'), null);
});

test('serveur : X-Forwarded-For ignoré sans trustProxy', async () => {
  const res = await fetch(`${base}/echo`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '1.2.3.4' },
    body: '{}',
  });
  assert.ok(!(((await res.json()) as { ip: string }).ip).includes('1.2.3.4'));
});
