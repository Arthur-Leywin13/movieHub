import { ForbiddenError, UnauthorizedError } from '@movieshub/shared';
import type { HttpRequest } from '../http/types.ts';
import { safeEqual } from '../security/tokens.ts';
import type { AdminRepo, AdminRoleName } from '../ports.ts';
import type { AuthService } from './auth-service.ts';

export interface UserActor {
  kind: 'user';
  userId: string;
  sessionId: string;
}

export interface AdminActor {
  kind: 'admin';
  userId: string;
  adminId: string;
  role: AdminRoleName;
  via: 'jwt' | 'bot';
  telegramId: bigint | null;
}

/** Rôles autorisés à gérer le catalogue et les médias. */
export const CATALOG_ROLES: readonly AdminRoleName[] = ['SUPER_ADMIN', 'ADMIN', 'EDITOR'];

export function requireRole(actor: AdminActor, allowed: readonly AdminRoleName[]): void {
  if (!allowed.includes(actor.role)) throw new ForbiddenError('Droits insuffisants');
}

/**
 * Identifie l'appelant. Deux voies pour un administrateur :
 *  - dashboard : « Authorization: Bearer <jeton d'accès> » d'un utilisateur ayant une fiche Admin ;
 *  - bot Telegram : « Authorization: Bot <BOT_SERVICE_TOKEN> » + « X-Telegram-User-Id » (id numérique,
 *    jamais le @username), vérifié contre Admin.telegramId.
 * Les droits sont relus en base à chaque requête (un admin désactivé perd l'accès immédiatement).
 */
export class ActorResolver {
  private readonly auth: AuthService;
  private readonly admins: AdminRepo;
  private readonly botServiceToken: string;

  constructor(deps: { auth: AuthService; admins: AdminRepo; botServiceToken: string }) {
    this.auth = deps.auth;
    this.admins = deps.admins;
    this.botServiceToken = deps.botServiceToken;
  }

  async user(req: HttpRequest): Promise<UserActor> {
    const header = req.headers['authorization'] ?? '';
    if (!header.startsWith('Bearer ')) throw new UnauthorizedError('Authentification requise');
    const { userId, sessionId } = this.auth.authenticate(header.slice(7).trim());
    await this.auth.assertSessionActive(sessionId);
    return { kind: 'user', userId, sessionId };
  }

  async admin(req: HttpRequest): Promise<AdminActor> {
    const header = req.headers['authorization'] ?? '';

    if (header.startsWith('Bot ')) {
      if (!safeEqual(header.slice(4).trim(), this.botServiceToken)) throw new UnauthorizedError('Authentification requise');
      const raw = req.headers['x-telegram-user-id'] ?? '';
      if (!/^\d{1,20}$/.test(raw)) throw new UnauthorizedError('Identifiant Telegram requis');
      const admin = await this.admins.findByTelegramId(BigInt(raw));
      if (!admin || !admin.isActive) throw new ForbiddenError('Accès administrateur requis');
      return { kind: 'admin', userId: admin.userId, adminId: admin.id, role: admin.role, via: 'bot', telegramId: admin.telegramId };
    }

    const actor = await this.user(req);
    const admin = await this.admins.findByUserId(actor.userId);
    if (!admin || !admin.isActive) throw new ForbiddenError('Accès administrateur requis');
    return { kind: 'admin', userId: actor.userId, adminId: admin.id, role: admin.role, via: 'jwt', telegramId: admin.telegramId };
  }
}
