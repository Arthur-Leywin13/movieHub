import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConflictError, ForbiddenError, RateLimitedError, UnauthorizedError, ValidationError } from '@movieshub/shared';
import { MemoryAdminRepo, MemorySessionRepo, MemoryUserRepo } from '../testing/memory-repos.ts';
import { ActorResolver, requireRole } from './actor.ts';
import { AuthService } from './auth-service.ts';
import type { HttpRequest } from '../http/types.ts';

const FAST = { N: 2 ** 10, r: 8, p: 1 };
const CTX = { ip: '10.0.0.1', userAgent: 'test' };

function setup() {
  const clock = { now: new Date('2026-11-01T12:00:00Z') };
  const users = new MemoryUserRepo();
  const sessions = new MemorySessionRepo();
  const auth = new AuthService(
    { users, sessions },
    { accessSecret: 'a'.repeat(40), refreshPepper: 'p'.repeat(40), passwordParams: FAST, now: () => clock.now },
  );
  return { clock, users, sessions, auth };
}
const adv = (clock: { now: Date }, seconds: number): void => {
  clock.now = new Date(clock.now.getTime() + seconds * 1000);
};
const REG = { email: 'Bob@Exemple.com', password: 'Motdepasse-Solide1', displayName: 'Bob' };

test('inscription : e-mail normalisé, hash scrypt stocké, jetons émis', async () => {
  const { auth, users } = setup();
  const r = await auth.register(REG, CTX);
  assert.equal(r.user.email, 'bob@exemple.com');
  assert.equal(r.expiresIn, 900);
  assert.ok(r.accessToken.split('.').length === 3);
  const stored = [...users.users.values()][0];
  assert.match(stored?.passwordHash ?? '', /^scrypt\$/);
  assert.ok(!JSON.stringify(r).includes('scrypt'));
  assert.ok(!('passwordHash' in r.user));
});

test('inscription : doublon (casse différente), mot de passe faible', async () => {
  const { auth } = setup();
  await auth.register(REG, CTX);
  await assert.rejects(auth.register({ ...REG, email: 'BOB@exemple.COM' }, CTX), ConflictError);
  await assert.rejects(auth.register({ ...REG, email: 'x@y.fr', password: 'court' }, CTX), ValidationError);
});

test('connexion : bon mot de passe, mauvais mot de passe, inconnu → même erreur', async () => {
  const { auth } = setup();
  await auth.register(REG, CTX);
  const ok = await auth.login({ email: 'bob@exemple.com', password: REG.password }, CTX);
  assert.ok(ok.refreshToken);
  const wrong = await auth.login({ email: 'bob@exemple.com', password: 'mauvais-mot-2' }, CTX).catch((e: unknown) => e);
  const unknown = await auth.login({ email: 'nul@exemple.com', password: 'mauvais-mot-2' }, CTX).catch((e: unknown) => e);
  assert.ok(wrong instanceof UnauthorizedError && unknown instanceof UnauthorizedError);
  assert.equal((wrong as Error).message, (unknown as Error).message);
});

test('connexion : compte suspendu refusé, compte supprimé = identifiants invalides', async () => {
  const { auth, users } = setup();
  await auth.register(REG, CTX);
  const u = [...users.users.values()][0];
  if (!u) throw new Error('utilisateur manquant');
  u.status = 'SUSPENDED';
  await assert.rejects(auth.login({ email: u.email, password: REG.password }, CTX), ForbiddenError);
  u.status = 'DELETED';
  await assert.rejects(auth.login({ email: u.email, password: REG.password }, CTX), /Identifiants invalides/);
});

test('connexion : limite par e-mail (5 essais) puis déblocage après la fenêtre', async () => {
  const { auth, clock } = setup();
  await auth.register(REG, CTX);
  for (let i = 0; i < 5; i++) {
    await assert.rejects(auth.login({ email: 'bob@exemple.com', password: 'mauvais-mot-2' }, CTX), UnauthorizedError);
  }
  await assert.rejects(auth.login({ email: 'bob@exemple.com', password: REG.password }, CTX), RateLimitedError);
  adv(clock, 16 * 60);
  assert.ok((await auth.login({ email: 'bob@exemple.com', password: REG.password }, CTX)).accessToken);
});

test('connexion : mise à niveau du hash si les paramètres sont plus faibles', async () => {
  const { users, sessions, clock } = setup();
  const strongerAuth = new AuthService(
    { users, sessions },
    { accessSecret: 'a'.repeat(40), refreshPepper: 'p'.repeat(40), passwordParams: { N: 2 ** 11, r: 8, p: 1 }, now: () => clock.now },
  );
  const { auth } = { auth: new AuthService({ users, sessions }, { accessSecret: 'a'.repeat(40), refreshPepper: 'p'.repeat(40), passwordParams: FAST, now: () => clock.now }) };
  await auth.register(REG, CTX);
  const before = [...users.users.values()][0]?.passwordHash;
  await strongerAuth.login({ email: 'bob@exemple.com', password: REG.password }, CTX);
  const after = [...users.users.values()][0]?.passwordHash;
  assert.match(before ?? '', /^scrypt\$1024\$/);
  assert.match(after ?? '', /^scrypt\$2048\$/);
});

test('jeton d’accès : valide puis expiré après 15 minutes', async () => {
  const { auth, clock } = setup();
  const r = await auth.register(REG, CTX);
  assert.equal(auth.authenticate(r.accessToken).userId, r.user.id);
  adv(clock, 15 * 60 + 1);
  assert.throws(() => auth.authenticate(r.accessToken), UnauthorizedError);
});

test('refresh : rotation, ancien token refusé, nouveau token valable', async () => {
  const { auth, clock } = setup();
  const r1 = await auth.register(REG, CTX);
  adv(clock, 60);
  const r2 = await auth.refresh(r1.refreshToken);
  assert.notEqual(r2.refreshToken, r1.refreshToken);
  assert.notEqual(r2.accessToken, r1.accessToken);
  assert.equal(auth.authenticate(r2.accessToken).sessionId, auth.authenticate(r1.accessToken).sessionId);
  adv(clock, 60);
  const r3 = await auth.refresh(r2.refreshToken);
  assert.ok(r3.refreshToken);
});

test('refresh : double envoi simultané → 409 sans révoquer la session', async () => {
  const { auth, clock } = setup();
  const r1 = await auth.register(REG, CTX);
  adv(clock, 60);
  const r2 = await auth.refresh(r1.refreshToken);
  adv(clock, 3);
  await assert.rejects(auth.refresh(r1.refreshToken), ConflictError);
  assert.ok((await auth.refresh(r2.refreshToken)).refreshToken);
});

test('refresh : réutilisation tardive d’un ancien token → toutes les sessions révoquées', async () => {
  const { auth, clock, sessions } = setup();
  const r1 = await auth.register(REG, CTX);
  const other = await auth.login({ email: 'bob@exemple.com', password: REG.password }, { ...CTX, deviceName: 'autre' });
  adv(clock, 60);
  const r2 = await auth.refresh(r1.refreshToken);
  adv(clock, 60);
  await assert.rejects(auth.refresh(r1.refreshToken), /Session révoquée/);
  await assert.rejects(auth.refresh(r2.refreshToken), UnauthorizedError);
  await assert.rejects(auth.refresh(other.refreshToken), UnauthorizedError);
  assert.ok([...sessions.sessions.values()].every((s) => s.revokedAt));
});

test('refresh : token inconnu, session expirée (30 jours), compte suspendu', async () => {
  const { auth, clock, users } = setup();
  await assert.rejects(auth.refresh('inconnu'), UnauthorizedError);
  const r = await auth.register(REG, CTX);
  adv(clock, 31 * 24 * 3600);
  await assert.rejects(auth.refresh(r.refreshToken), /expirée/);

  const fresh = setup();
  const r2 = await fresh.auth.register(REG, CTX);
  const u = [...fresh.users.users.values()][0];
  if (u) u.status = 'SUSPENDED';
  await assert.rejects(fresh.auth.refresh(r2.refreshToken), UnauthorizedError);
  void users;
});

test('déconnexion : idempotente, révoque la session ; logoutAll révoque tout', async () => {
  const { auth } = setup();
  const r = await auth.register(REG, CTX);
  await auth.logout(r.refreshToken);
  await auth.logout(r.refreshToken);
  await auth.logout('inconnu');
  await assert.rejects(auth.refresh(r.refreshToken), UnauthorizedError);
  const a = await auth.login({ email: 'bob@exemple.com', password: REG.password }, CTX);
  const b = await auth.login({ email: 'bob@exemple.com', password: REG.password }, CTX);
  await auth.logoutAll(a.user.id);
  await assert.rejects(auth.refresh(a.refreshToken), UnauthorizedError);
  await assert.rejects(auth.refresh(b.refreshToken), UnauthorizedError);
});

test('assertSessionActive : session révoquée refusée immédiatement', async () => {
  const { auth } = setup();
  const r = await auth.register(REG, CTX);
  const { sessionId } = auth.authenticate(r.accessToken);
  assert.equal((await auth.assertSessionActive(sessionId)).email, 'bob@exemple.com');
  await auth.logout(r.refreshToken);
  await assert.rejects(auth.assertSessionActive(sessionId), UnauthorizedError);
});

// ---- ActorResolver ----
const BOT_TOKEN = 'b'.repeat(40);
const req = (headers: Record<string, string>): HttpRequest => ({
  method: 'GET', path: '/', query: new URLSearchParams(), headers, body: undefined, params: {}, ip: '1.1.1.1', requestId: 'r',
});

async function actorSetup() {
  const s = setup();
  const admins = new MemoryAdminRepo();
  const resolver = new ActorResolver({ auth: s.auth, admins, botServiceToken: BOT_TOKEN });
  const r = await s.auth.register(REG, CTX);
  return { ...s, admins, resolver, r };
}

test('acteur : utilisateur simple accepté sur user(), refusé sur admin()', async () => {
  const { resolver, r } = await actorSetup();
  const actor = await resolver.user(req({ authorization: `Bearer ${r.accessToken}` }));
  assert.equal(actor.userId, r.user.id);
  await assert.rejects(resolver.admin(req({ authorization: `Bearer ${r.accessToken}` })), ForbiddenError);
  await assert.rejects(resolver.user(req({})), UnauthorizedError);
  await assert.rejects(resolver.user(req({ authorization: 'Bearer faux.jeton.ici' })), UnauthorizedError);
});

test('acteur : admin par jeton (dashboard), désactivé = refusé immédiatement', async () => {
  const { resolver, r, admins } = await actorSetup();
  admins.admins.push({ id: 'adm1', userId: r.user.id, telegramId: 123456789n, role: 'EDITOR', isActive: true });
  const a = await resolver.admin(req({ authorization: `Bearer ${r.accessToken}` }));
  assert.deepEqual([a.via, a.role, a.adminId], ['jwt', 'EDITOR', 'adm1']);
  const rec = admins.admins[0];
  if (rec) rec.isActive = false;
  await assert.rejects(resolver.admin(req({ authorization: `Bearer ${r.accessToken}` })), ForbiddenError);
});

test('acteur : admin via le bot (jeton de service + id Telegram numérique)', async () => {
  const { resolver, r, admins } = await actorSetup();
  admins.admins.push({ id: 'adm1', userId: r.user.id, telegramId: 123456789n, role: 'ADMIN', isActive: true });
  const ok = await resolver.admin(req({ authorization: `Bot ${BOT_TOKEN}`, 'x-telegram-user-id': '123456789' }));
  assert.deepEqual([ok.via, ok.role, ok.telegramId], ['bot', 'ADMIN', 123456789n]);
  await assert.rejects(resolver.admin(req({ authorization: 'Bot mauvais-jeton', 'x-telegram-user-id': '123456789' })), UnauthorizedError);
  await assert.rejects(resolver.admin(req({ authorization: `Bot ${BOT_TOKEN}`, 'x-telegram-user-id': '@pirate' })), UnauthorizedError);
  await assert.rejects(resolver.admin(req({ authorization: `Bot ${BOT_TOKEN}` })), UnauthorizedError);
  await assert.rejects(resolver.admin(req({ authorization: `Bot ${BOT_TOKEN}`, 'x-telegram-user-id': '999' })), ForbiddenError);
});

test('rôles : MODERATOR ne peut pas gérer le catalogue, EDITOR oui', () => {
  const base = { kind: 'admin' as const, userId: 'u', adminId: 'a', via: 'jwt' as const, telegramId: null };
  assert.doesNotThrow(() => requireRole({ ...base, role: 'EDITOR' }, ['SUPER_ADMIN', 'ADMIN', 'EDITOR']));
  assert.throws(() => requireRole({ ...base, role: 'MODERATOR' }, ['SUPER_ADMIN', 'ADMIN', 'EDITOR']), ForbiddenError);
});
