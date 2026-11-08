import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { buildApp } from './app.ts';
import { UploadService } from './admin/upload-service.ts';
import { ActorResolver } from './auth/actor.ts';
import { AuthService } from './auth/auth-service.ts';
import { createHttpServer } from './http/server.ts';
import { FakeR2 } from './testing/fake-r2.ts';
import { CatalogAdminService } from './catalog/admin-service.ts';
import { CatalogReadService } from './catalog/read-service.ts';
import { MemoryCatalogRepo } from './testing/memory-catalog-repo.ts';
import { MemoryAdminRepo, MemoryAuditRepo, MemoryMediaRepo, MemorySessionRepo, MemoryUserRepo } from './testing/memory-repos.ts';

const BOT_TOKEN = 'b'.repeat(40);
const MiB = 1024 * 1024;
const users = new MemoryUserRepo();
const sessions = new MemorySessionRepo();
const admins = new MemoryAdminRepo();
const media = new MemoryMediaRepo();
const audit = new MemoryAuditRepo();
const r2 = new FakeR2();
const auth = new AuthService(
  { users, sessions },
  { accessSecret: 'a'.repeat(40), refreshPepper: 'p'.repeat(40), passwordParams: { N: 2 ** 10, r: 8, p: 1 } },
);
const actors = new ActorResolver({ auth, admins, botServiceToken: BOT_TOKEN });
const uploads = new UploadService({ r2, media, audit, bucket: 'movieshub' });
const catalogRepo = new MemoryCatalogRepo(media);
const catalogAdmin = new CatalogAdminService({ repo: catalogRepo, media, audit });
const catalogRead = new CatalogReadService({ repo: catalogRepo, signer: r2 });
const server = createHttpServer({ router: buildApp({ auth, actors, uploads, catalogAdmin, catalogRead, checkReady: async () => true }), corsOrigins: [] });
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => server.close());

async function call(method: string, path: string, opts: { body?: unknown; token?: string; headers?: Record<string, string> } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(opts.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.headers ?? {}),
    },
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as Record<string, any>) : null };
}

const CREDS = { email: 'alice@exemple.com', password: 'Motdepasse-Solide1', displayName: 'Alice' };
let access = '';
let refresh = '';
let userId = '';

test('santé : /health et /health/ready', async () => {
  assert.deepEqual((await call('GET', '/health')).json, { status: 'ok' });
  assert.equal((await call('GET', '/health/ready')).status, 200);
});

test('inscription : 201, jetons fournis, aucun hash dans la réponse', async () => {
  const r = await call('POST', '/auth/register', { body: { ...CREDS, platform: 'ANDROID', deviceName: 'Galaxy' } });
  assert.equal(r.status, 201);
  assert.ok(r.json?.['accessToken'] && r.json['refreshToken']);
  assert.ok(!JSON.stringify(r.json).includes('scrypt'));
  access = r.json?.['accessToken'];
  refresh = r.json?.['refreshToken'];
  userId = r.json?.['user'].id;
});

test('inscription : validation (e-mail, mot de passe court, champ manquant) et doublon', async () => {
  assert.equal((await call('POST', '/auth/register', { body: { ...CREDS, email: 'pas-un-email' } })).status, 400);
  assert.equal((await call('POST', '/auth/register', { body: { ...CREDS, email: 'b@exemple.com', password: 'court' } })).status, 400);
  assert.equal((await call('POST', '/auth/register', { body: { email: 'c@exemple.com' } })).status, 400);
  assert.equal((await call('POST', '/auth/register', { body: { ...CREDS, platform: 'PLAYSTATION', email: 'd@exemple.com' } })).status, 400);
  assert.equal((await call('POST', '/auth/register', { body: CREDS })).status, 409);
});

test('GET /me : sans jeton 401, jeton falsifié 401, jeton valide 200', async () => {
  assert.equal((await call('GET', '/me')).status, 401);
  assert.equal((await call('GET', '/me', { token: access.slice(0, -3) + 'abc' })).status, 401);
  const ok = await call('GET', '/me', { token: access });
  assert.equal(ok.status, 200);
  assert.equal(ok.json?.['user'].email, 'alice@exemple.com');
});

test('connexion : mauvais mot de passe 401 ; refresh : rotation puis ancien jeton refusé', async () => {
  assert.equal((await call('POST', '/auth/login', { body: { email: CREDS.email, password: 'mauvais-mot-2' } })).status, 401);
  const rot = await call('POST', '/auth/refresh', { body: { refreshToken: refresh } });
  assert.equal(rot.status, 200);
  const again = await call('POST', '/auth/refresh', { body: { refreshToken: refresh } });
  assert.equal(again.status, 409); // dans la fenêtre de grâce : pas de révocation
  access = rot.json?.['accessToken'];
  refresh = rot.json?.['refreshToken'];
  assert.equal((await call('GET', '/me', { token: access })).status, 200);
});

test('admin : utilisateur simple refusé (403), sans jeton 401', async () => {
  assert.equal((await call('POST', '/admin/uploads', { body: { kind: 'IMAGE', filename: 'a.png', sizeBytes: 10 } })).status, 401);
  assert.equal((await call('POST', '/admin/uploads', { token: access, body: { kind: 'IMAGE', filename: 'a.png', sizeBytes: 10 } })).status, 403);
});

test('admin par jeton : envoi d’une vidéo multipart bout en bout, puis publication', async () => {
  admins.admins.push({ id: 'adm1', userId, telegramId: 777n, role: 'EDITOR', isActive: true });
  const init = await call('POST', '/admin/uploads', { token: access, body: { kind: 'VIDEO', filename: 'Film.mkv', sizeBytes: 40 * MiB } });
  assert.equal(init.status, 201);
  assert.equal(init.json?.['partCount'], 3);
  assert.equal(init.json?.['parts'].length, 3);
  const id = init.json?.['mediaFileId'] as string;
  const uploadId = [...r2.uploads.keys()][0] as string;

  r2.putPart(uploadId, 1, 16 * MiB);
  const st = await call('GET', `/admin/uploads/${id}`, { token: access });
  assert.deepEqual(st.json?.['uploadedParts'], [1]);
  assert.equal(st.json?.['missingParts'].length, 2);

  const early = await call('POST', `/admin/uploads/${id}/complete`, { token: access });
  assert.equal(early.status, 400);
  assert.deepEqual(early.json?.['error'].details.missingParts, [2, 3]);

  r2.putPart(uploadId, 2, 16 * MiB);
  r2.putPart(uploadId, 3, 8 * MiB);
  const done = await call('POST', `/admin/uploads/${id}/complete`, { token: access });
  assert.equal(done.status, 200);
  assert.deepEqual(done.json, { mediaFileId: id, status: 'READY', sizeBytes: 40 * MiB });
});

test('admin via le bot : jeton de service + id Telegram ; mauvais id = 403 ; @username = 401', async () => {
  const headers = { authorization: `Bot ${BOT_TOKEN}`, 'x-telegram-user-id': '777' };
  const ok = await call('POST', '/admin/uploads', { headers, body: { kind: 'SUBTITLE', filename: 'fr.srt', sizeBytes: 100 } });
  assert.equal(ok.status, 201);
  assert.equal(ok.json?.['multipart'], false);
  assert.equal((await call('POST', '/admin/uploads', { headers: { ...headers, 'x-telegram-user-id': '999' }, body: { kind: 'SUBTITLE', filename: 'fr.srt', sizeBytes: 100 } })).status, 403);
  assert.equal((await call('POST', '/admin/uploads', { headers: { ...headers, 'x-telegram-user-id': '@alice' }, body: { kind: 'SUBTITLE', filename: 'fr.srt', sizeBytes: 100 } })).status, 401);
  assert.equal((await call('POST', '/admin/uploads', { headers: { ...headers, authorization: 'Bot faux' }, body: { kind: 'SUBTITLE', filename: 'fr.srt', sizeBytes: 100 } })).status, 401);
});

test('admin : rôle MODERATOR refusé ; admin désactivé refusé immédiatement ; id invalide 400', async () => {
  const a = admins.admins[0];
  if (!a) throw new Error('admin manquant');
  a.role = 'MODERATOR';
  assert.equal((await call('POST', '/admin/uploads', { token: access, body: { kind: 'IMAGE', filename: 'a.png', sizeBytes: 10 } })).status, 403);
  a.role = 'EDITOR';
  assert.equal((await call('GET', '/admin/uploads/pas-un-uuid', { token: access })).status, 400);
  a.isActive = false;
  assert.equal((await call('GET', '/admin/uploads/0a1b2c3d-0000-4000-8000-000000000001', { token: access })).status, 403);
  a.isActive = true;
  assert.equal((await call('GET', '/admin/uploads/0a1b2c3d-0000-4000-8000-000000000001', { token: access })).status, 404);
});

test('audit : actions enregistrées avec la bonne source, sans aucune URL signée', () => {
  const sources = new Set(audit.entries.map((e) => e.source));
  assert.ok(sources.has('DASHBOARD') && sources.has('TELEGRAM_BOT'));
  assert.ok(audit.entries.every((e) => e.adminId === 'adm1' && e.requestId));
  assert.ok(!JSON.stringify(audit.entries).includes('https://'));
});

test('déconnexion : refresh révoqué, jeton d’accès rejeté dès la révocation de la session', async () => {
  assert.equal((await call('POST', '/auth/logout', { body: { refreshToken: refresh } })).status, 204);
  assert.equal((await call('POST', '/auth/refresh', { body: { refreshToken: refresh } })).status, 401);
  assert.equal((await call('GET', '/me', { token: access })).status, 401);
});
