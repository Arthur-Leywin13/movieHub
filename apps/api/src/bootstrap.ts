import { assertPasswordPolicy, hashPassword, type ScryptParams } from './security/password.ts';
import type { AdminRepo, UserRepo } from './ports.ts';

/**
 * Crée le premier administrateur (SUPER_ADMIN) s'il n'en existe aucun.
 * Sans effet dès qu'un administrateur existe : les variables peuvent rester en place sans risque
 * (elles ne permettent jamais de recréer ni d'écraser un compte).
 */
export async function bootstrapAdmin(
  deps: { users: UserRepo; admins: AdminRepo; passwordParams?: ScryptParams },
  cfg: { email: string; password: string; telegramId: bigint },
): Promise<'created' | 'skipped'> {
  if ((await deps.admins.count()) > 0) return 'skipped';
  assertPasswordPolicy(cfg.password);
  const email = cfg.email.trim().toLowerCase();
  const user =
    (await deps.users.findByEmail(email)) ??
    (await deps.users.create({ email, passwordHash: await hashPassword(cfg.password, deps.passwordParams), displayName: 'Administrateur' }));
  await deps.admins.create({ userId: user.id, telegramId: cfg.telegramId, role: 'SUPER_ADMIN' });
  return 'created';
}
