import {
  ConflictError,
  ForbiddenError,
  UnauthorizedError,
} from '@movieshub/shared';
import { signJwt, verifyJwt } from '../security/jwt.ts';
import {
  DEFAULT_SCRYPT_PARAMS,
  assertPasswordPolicy,
  dummyVerify,
  hashPassword,
  needsRehash,
  verifyPassword,
  type ScryptParams,
} from '../security/password.ts';
import { SlidingWindowLimiter } from '../security/rate-limit.ts';
import { generateRefreshToken, hashRefreshToken } from '../security/tokens.ts';
import type { PlatformName, SessionRepo, UserRecord, UserRepo } from '../ports.ts';

export interface ClientContext {
  ip: string;
  userAgent: string | null;
  deviceName?: string | null;
  platform?: PlatformName | null;
}

export interface PublicUser {
  id: string;
  email: string;
  displayName: string;
  createdAt: string;
}

export interface AuthResult {
  user: PublicUser;
  accessToken: string;
  refreshToken: string;
  /** Durée de vie du jeton d'accès, en secondes. */
  expiresIn: number;
}

export interface AuthServiceConfig {
  accessSecret: string;
  /** Secret serveur utilisé pour hacher les refresh tokens (HMAC). */
  refreshPepper: string;
  issuer?: string;
  accessTtlSeconds?: number;
  refreshTtlSeconds?: number;
  /** Fenêtre après une rotation pendant laquelle l'ancien token est refusé sans révoquer la session. */
  refreshGraceSeconds?: number;
  passwordParams?: ScryptParams;
  now?: () => Date;
}

const toPublic = (u: UserRecord): PublicUser => ({
  id: u.id,
  email: u.email,
  displayName: u.displayName,
  createdAt: u.createdAt.toISOString(),
});

export class AuthService {
  private readonly users: UserRepo;
  private readonly sessions: SessionRepo;
  private readonly cfg: Required<Omit<AuthServiceConfig, 'passwordParams'>> & { passwordParams: ScryptParams };
  private readonly loginIp: SlidingWindowLimiter;
  private readonly loginEmail: SlidingWindowLimiter;
  private readonly registerIp: SlidingWindowLimiter;

  constructor(deps: { users: UserRepo; sessions: SessionRepo }, cfg: AuthServiceConfig) {
    this.users = deps.users;
    this.sessions = deps.sessions;
    this.cfg = {
      accessSecret: cfg.accessSecret,
      refreshPepper: cfg.refreshPepper,
      issuer: cfg.issuer ?? 'movieshub',
      accessTtlSeconds: cfg.accessTtlSeconds ?? 15 * 60,
      refreshTtlSeconds: cfg.refreshTtlSeconds ?? 30 * 24 * 3600,
      refreshGraceSeconds: cfg.refreshGraceSeconds ?? 10,
      passwordParams: cfg.passwordParams ?? DEFAULT_SCRYPT_PARAMS,
      now: cfg.now ?? (() => new Date()),
    };
    const clock = (): number => this.cfg.now().getTime();
    this.loginIp = new SlidingWindowLimiter({ max: 30, windowMs: 15 * 60_000, now: clock });
    this.loginEmail = new SlidingWindowLimiter({ max: 5, windowMs: 15 * 60_000, now: clock });
    this.registerIp = new SlidingWindowLimiter({ max: 10, windowMs: 60 * 60_000, now: clock });
  }

  private async issueSession(user: UserRecord, ctx: ClientContext): Promise<AuthResult> {
    const now = this.cfg.now();
    const refreshToken = generateRefreshToken();
    const session = await this.sessions.create({
      userId: user.id,
      refreshTokenHash: hashRefreshToken(refreshToken, this.cfg.refreshPepper),
      expiresAt: new Date(now.getTime() + this.cfg.refreshTtlSeconds * 1000),
      deviceName: ctx.deviceName ?? null,
      platform: ctx.platform ?? null,
      ipAddress: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return this.buildResult(user, session.id, refreshToken);
  }

  private buildResult(user: UserRecord, sessionId: string, refreshToken: string): AuthResult {
    const accessToken = signJwt({ sub: user.id, sid: sessionId }, this.cfg.accessSecret, {
      expiresInSeconds: this.cfg.accessTtlSeconds,
      issuer: this.cfg.issuer,
      now: this.cfg.now(),
    });
    return { user: toPublic(user), accessToken, refreshToken, expiresIn: this.cfg.accessTtlSeconds };
  }

  async register(input: { email: string; password: string; displayName: string }, ctx: ClientContext): Promise<AuthResult> {
    this.registerIp.assert(`ip:${ctx.ip}`);
    assertPasswordPolicy(input.password);
    const email = input.email.trim().toLowerCase();
    if (await this.users.findByEmail(email)) throw new ConflictError('Cet e-mail est déjà utilisé');
    const passwordHash = await hashPassword(input.password, this.cfg.passwordParams);
    const user = await this.users.create({ email, passwordHash, displayName: input.displayName });
    return this.issueSession(user, ctx);
  }

  async login(input: { email: string; password: string }, ctx: ClientContext): Promise<AuthResult> {
    const email = input.email.trim().toLowerCase();
    this.loginIp.assert(`ip:${ctx.ip}`);
    this.loginEmail.assert(`email:${email}`);

    const user = await this.users.findByEmail(email);
    if (!user) {
      await dummyVerify(input.password, this.cfg.passwordParams);
      throw new UnauthorizedError('Identifiants invalides');
    }
    if (!(await verifyPassword(input.password, user.passwordHash)) || user.status === 'DELETED') {
      throw new UnauthorizedError('Identifiants invalides');
    }
    if (user.status === 'SUSPENDED') throw new ForbiddenError('Compte suspendu');

    this.loginEmail.reset(`email:${email}`);
    if (needsRehash(user.passwordHash, this.cfg.passwordParams)) {
      await this.users.updatePasswordHash(user.id, await hashPassword(input.password, this.cfg.passwordParams));
    }
    await this.users.touchLogin(user.id, this.cfg.now());
    return this.issueSession(user, ctx);
  }

  /**
   * Rotation du refresh token. Un ancien token présenté après la fenêtre de grâce signale un vol
   * probable : toutes les sessions de l'utilisateur sont révoquées.
   */
  async refresh(refreshToken: string): Promise<AuthResult> {
    const now = this.cfg.now();
    const hash = hashRefreshToken(refreshToken, this.cfg.refreshPepper);
    const found = await this.sessions.findByRefreshHash(hash);
    if (!found) throw new UnauthorizedError('Session invalide');
    const { session, matched } = found;

    if (session.revokedAt || session.expiresAt <= now) throw new UnauthorizedError('Session expirée');

    if (matched === 'previous') {
      const rotatedAt = session.lastUsedAt ?? session.createdAt;
      if (now.getTime() - rotatedAt.getTime() < this.cfg.refreshGraceSeconds * 1000) {
        throw new ConflictError('Jeton déjà renouvelé : utilisez le nouveau jeton');
      }
      await this.sessions.revokeAllForUser(session.userId, now);
      throw new UnauthorizedError('Session révoquée');
    }

    const user = await this.users.findById(session.userId);
    if (!user || user.status !== 'ACTIVE') {
      await this.sessions.revoke(session.id, now);
      throw new UnauthorizedError('Session invalide');
    }

    const newToken = generateRefreshToken();
    const rotated = await this.sessions.rotate(session.id, {
      expectedHash: hash,
      newHash: hashRefreshToken(newToken, this.cfg.refreshPepper),
      expiresAt: new Date(now.getTime() + this.cfg.refreshTtlSeconds * 1000),
      at: now,
    });
    if (!rotated) throw new ConflictError('Jeton déjà renouvelé : utilisez le nouveau jeton');
    return this.buildResult(user, session.id, newToken);
  }

  /** Idempotent : un token inconnu ne provoque pas d'erreur. */
  async logout(refreshToken: string): Promise<void> {
    const found = await this.sessions.findByRefreshHash(hashRefreshToken(refreshToken, this.cfg.refreshPepper));
    if (found) await this.sessions.revoke(found.session.id, this.cfg.now());
  }

  async logoutAll(userId: string): Promise<void> {
    await this.sessions.revokeAllForUser(userId, this.cfg.now());
  }

  /** Vérifie la signature et l'expiration du jeton d'accès, sans accès base. */
  authenticate(accessToken: string): { userId: string; sessionId: string } {
    const p = verifyJwt(accessToken, this.cfg.accessSecret, { issuer: this.cfg.issuer, now: this.cfg.now() });
    return { userId: p.sub, sessionId: p.sid };
  }

  /** Vérification « fraîche » (base) : session non révoquée/expirée et compte actif. */
  async assertSessionActive(sessionId: string): Promise<UserRecord> {
    const session = await this.sessions.findById(sessionId);
    if (!session || session.revokedAt || session.expiresAt <= this.cfg.now()) {
      throw new UnauthorizedError('Session expirée');
    }
    const user = await this.users.findById(session.userId);
    if (!user || user.status === 'DELETED') throw new UnauthorizedError('Session invalide');
    if (user.status === 'SUSPENDED') throw new ForbiddenError('Compte suspendu');
    return user;
  }

  async me(userId: string): Promise<PublicUser> {
    const user = await this.users.findById(userId);
    if (!user) throw new UnauthorizedError('Session invalide');
    return toPublic(user);
  }
}
