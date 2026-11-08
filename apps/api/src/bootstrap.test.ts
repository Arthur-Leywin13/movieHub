import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ValidationError } from '@movieshub/shared';
import { bootstrapAdmin } from './bootstrap.ts';
import { verifyPassword } from './security/password.ts';
import { MemoryAdminRepo, MemoryUserRepo } from './testing/memory-repos.ts';

const FAST = { N: 2 ** 10, r: 8, p: 1 };
const cfg = { email: 'Admin@Exemple.com', password: 'un-mot-de-passe-long', telegramId: 4242n };

test('premier administrateur : compte + fiche SUPER_ADMIN liée à son id Telegram, mot de passe haché', async () => {
  const users = new MemoryUserRepo();
  const admins = new MemoryAdminRepo();
  assert.equal(await bootstrapAdmin({ users, admins, passwordParams: FAST }, cfg), 'created');
  const user = await users.findByEmail('admin@exemple.com');
  assert.ok(user);
  assert.match(user.passwordHash, /^scrypt\$/);
  assert.equal(await verifyPassword(cfg.password, user.passwordHash), true);
  const admin = await admins.findByTelegramId(4242n);
  assert.deepEqual([admin?.role, admin?.isActive, admin?.userId], ['SUPER_ADMIN', true, user.id]);
});

test('sans effet dès qu’un administrateur existe (jamais de recréation ni d’écrasement)', async () => {
  const users = new MemoryUserRepo();
  const admins = new MemoryAdminRepo();
  await bootstrapAdmin({ users, admins, passwordParams: FAST }, cfg);
  assert.equal(await bootstrapAdmin({ users, admins, passwordParams: FAST }, { ...cfg, email: 'autre@exemple.com', telegramId: 1n }), 'skipped');
  assert.equal(await admins.count(), 1);
  assert.equal(await users.findByEmail('autre@exemple.com'), null);
});

test('compte existant : devient administrateur sans que son mot de passe soit changé ; mot de passe faible refusé', async () => {
  const users = new MemoryUserRepo();
  const admins = new MemoryAdminRepo();
  const existing = await users.create({ email: 'admin@exemple.com', passwordHash: 'scrypt$ancien', displayName: 'Déjà là' });
  await bootstrapAdmin({ users, admins, passwordParams: FAST }, cfg);
  assert.equal((await users.findByEmail('admin@exemple.com'))?.passwordHash, 'scrypt$ancien');
  assert.equal((await admins.findByTelegramId(4242n))?.userId, existing.id);

  await assert.rejects(bootstrapAdmin({ users: new MemoryUserRepo(), admins: new MemoryAdminRepo(), passwordParams: FAST }, { ...cfg, password: 'court' }), ValidationError);
});
