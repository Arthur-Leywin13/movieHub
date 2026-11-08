/**
 * Implémentations Prisma des ports. Fines couches, sans logique métier.
 * NON EXÉCUTÉ dans l'environnement de création (pas de base ni de client généré) :
 * validé par le typecheck de la CI (après `prisma generate`) et par le premier démarrage réel.
 */
import { Prisma, type PrismaClient } from '@prisma/client';
import { ConflictError } from '@movieshub/shared';
import type {
  AdminRecord,
  AdminRepo,
  AuditEntry,
  AuditRepo,
  MediaFileRecord,
  MediaFileRepo,
  NewMediaFile,
  NewSession,
  NewUser,
  SessionRecord,
  SessionRepo,
  UserRecord,
  UserRepo,
} from '../ports.ts';

const toUser = (u: {
  id: string;
  email: string;
  passwordHash: string;
  displayName: string;
  status: UserRecord['status'];
  createdAt: Date;
}): UserRecord => ({
  id: u.id,
  email: u.email,
  passwordHash: u.passwordHash,
  displayName: u.displayName,
  status: u.status,
  createdAt: u.createdAt,
});

export class PrismaUserRepo implements UserRepo {
  private readonly db: PrismaClient;
  constructor(db: PrismaClient) {
    this.db = db;
  }

  async findByEmail(email: string): Promise<UserRecord | null> {
    const u = await this.db.user.findUnique({ where: { email } });
    return u ? toUser(u) : null;
  }

  async findById(id: string): Promise<UserRecord | null> {
    const u = await this.db.user.findUnique({ where: { id } });
    return u ? toUser(u) : null;
  }

  async create(user: NewUser): Promise<UserRecord> {
    try {
      return toUser(await this.db.user.create({ data: user }));
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictError('Cet e-mail est déjà utilisé');
      }
      throw err;
    }
  }

  async touchLogin(id: string, at: Date): Promise<void> {
    await this.db.user.update({ where: { id }, data: { lastLoginAt: at } });
  }

  async updatePasswordHash(id: string, hash: string): Promise<void> {
    await this.db.user.update({ where: { id }, data: { passwordHash: hash } });
  }
}

const toSession = (s: {
  id: string;
  userId: string;
  refreshTokenHash: string;
  previousRefreshTokenHash: string | null;
  expiresAt: Date;
  revokedAt: Date | null;
  deviceName: string | null;
  platform: SessionRecord['platform'];
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: Date;
  lastUsedAt: Date | null;
}): SessionRecord => ({ ...s });

export class PrismaSessionRepo implements SessionRepo {
  private readonly db: PrismaClient;
  constructor(db: PrismaClient) {
    this.db = db;
  }

  async create(s: NewSession): Promise<SessionRecord> {
    return toSession(await this.db.session.create({ data: s }));
  }

  async findById(id: string): Promise<SessionRecord | null> {
    const s = await this.db.session.findUnique({ where: { id } });
    return s ? toSession(s) : null;
  }

  async findByRefreshHash(hash: string): Promise<{ session: SessionRecord; matched: 'current' | 'previous' } | null> {
    const s = await this.db.session.findFirst({
      where: { OR: [{ refreshTokenHash: hash }, { previousRefreshTokenHash: hash }] },
    });
    if (!s) return null;
    return { session: toSession(s), matched: s.refreshTokenHash === hash ? 'current' : 'previous' };
  }

  /** Mise à jour conditionnelle : deux rotations simultanées ne peuvent pas réussir toutes les deux. */
  async rotate(id: string, p: { expectedHash: string; newHash: string; expiresAt: Date; at: Date }): Promise<boolean> {
    const r = await this.db.session.updateMany({
      where: { id, refreshTokenHash: p.expectedHash, revokedAt: null },
      data: {
        previousRefreshTokenHash: p.expectedHash,
        refreshTokenHash: p.newHash,
        expiresAt: p.expiresAt,
        lastUsedAt: p.at,
      },
    });
    return r.count === 1;
  }

  async revoke(id: string, at: Date): Promise<void> {
    await this.db.session.updateMany({ where: { id, revokedAt: null }, data: { revokedAt: at } });
  }

  async revokeAllForUser(userId: string, at: Date): Promise<void> {
    await this.db.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: at } });
  }
}

export class PrismaAdminRepo implements AdminRepo {
  private readonly db: PrismaClient;
  constructor(db: PrismaClient) {
    this.db = db;
  }

  async findByUserId(userId: string): Promise<AdminRecord | null> {
    const a = await this.db.admin.findUnique({ where: { userId } });
    return a ? { id: a.id, userId: a.userId, telegramId: a.telegramId, role: a.role, isActive: a.isActive } : null;
  }

  async findByTelegramId(telegramId: bigint): Promise<AdminRecord | null> {
    const a = await this.db.admin.findUnique({ where: { telegramId } });
    return a ? { id: a.id, userId: a.userId, telegramId: a.telegramId, role: a.role, isActive: a.isActive } : null;
  }

  async count(): Promise<number> {
    return this.db.admin.count();
  }

  async create(input: { userId: string; telegramId: bigint | null; role: AdminRecord['role'] }): Promise<AdminRecord> {
    const a = await this.db.admin.create({ data: input });
    return { id: a.id, userId: a.userId, telegramId: a.telegramId, role: a.role, isActive: a.isActive };
  }
}

const toMedia = (m: {
  id: string;
  bucket: string;
  objectKey: string;
  kind: MediaFileRecord['kind'];
  mimeType: string | null;
  sizeBytes: bigint | null;
  status: MediaFileRecord['status'];
  multipartUploadId: string | null;
  multipartPartSize: number | null;
  uploadedByAdminId: string | null;
  createdAt: Date;
}): MediaFileRecord => ({ ...m, sizeBytes: m.sizeBytes === null ? null : Number(m.sizeBytes) });

export class PrismaMediaFileRepo implements MediaFileRepo {
  private readonly db: PrismaClient;
  constructor(db: PrismaClient) {
    this.db = db;
  }

  async create(f: NewMediaFile): Promise<MediaFileRecord> {
    return toMedia(await this.db.mediaFile.create({ data: { ...f, sizeBytes: BigInt(f.sizeBytes) } }));
  }

  async findById(id: string): Promise<MediaFileRecord | null> {
    const m = await this.db.mediaFile.findUnique({ where: { id } });
    return m ? toMedia(m) : null;
  }

  async markReady(id: string, p: { verifiedAt: Date; sizeBytes: number }): Promise<void> {
    await this.db.mediaFile.update({
      where: { id },
      data: {
        status: 'READY',
        verifiedAt: p.verifiedAt,
        sizeBytes: BigInt(p.sizeBytes),
        multipartUploadId: null,
        multipartPartSize: null,
      },
    });
  }

  async markFailed(id: string): Promise<void> {
    await this.db.mediaFile.update({ where: { id }, data: { status: 'FAILED' } });
  }
}

export class PrismaAuditRepo implements AuditRepo {
  private readonly db: PrismaClient;
  constructor(db: PrismaClient) {
    this.db = db;
  }

  async log(e: AuditEntry): Promise<void> {
    await this.db.auditLog.create({
      data: {
        source: e.source,
        adminId: e.adminId,
        action: e.action,
        entityType: e.entityType,
        entityId: e.entityId,
        oldValues: e.oldValues === undefined ? undefined : (e.oldValues as Prisma.InputJsonValue),
        newValues: e.newValues === undefined ? undefined : (e.newValues as Prisma.InputJsonValue),
        result: e.result,
        errorMessage: e.errorMessage ?? null,
        ipAddress: e.ipAddress ?? null,
        requestId: e.requestId ?? null,
      },
    });
  }
}
