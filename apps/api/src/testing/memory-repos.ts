/** Implémentations en mémoire des ports, réservées aux tests. */
import { randomUUID } from 'node:crypto';
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

export class MemoryUserRepo implements UserRepo {
  readonly users = new Map<string, UserRecord>();

  async findByEmail(email: string): Promise<UserRecord | null> {
    return [...this.users.values()].find((u) => u.email === email) ?? null;
  }
  async findById(id: string): Promise<UserRecord | null> {
    return this.users.get(id) ?? null;
  }
  async create(u: NewUser): Promise<UserRecord> {
    if ([...this.users.values()].some((x) => x.email === u.email)) throw new ConflictError('Cet e-mail est déjà utilisé');
    const rec: UserRecord = { id: randomUUID(), ...u, status: 'ACTIVE', createdAt: new Date() };
    this.users.set(rec.id, rec);
    return rec;
  }
  async touchLogin(): Promise<void> {}
  async updatePasswordHash(id: string, hash: string): Promise<void> {
    const u = this.users.get(id);
    if (u) u.passwordHash = hash;
  }
}

export class MemorySessionRepo implements SessionRepo {
  readonly sessions = new Map<string, SessionRecord>();

  async create(s: NewSession): Promise<SessionRecord> {
    const rec: SessionRecord = {
      id: randomUUID(),
      ...s,
      previousRefreshTokenHash: null,
      revokedAt: null,
      createdAt: new Date(),
      lastUsedAt: null,
    };
    this.sessions.set(rec.id, rec);
    return rec;
  }
  async findById(id: string): Promise<SessionRecord | null> {
    return this.sessions.get(id) ?? null;
  }
  async findByRefreshHash(hash: string) {
    for (const session of this.sessions.values()) {
      if (session.refreshTokenHash === hash) return { session, matched: 'current' as const };
      if (session.previousRefreshTokenHash === hash) return { session, matched: 'previous' as const };
    }
    return null;
  }
  async rotate(id: string, p: { expectedHash: string; newHash: string; expiresAt: Date; at: Date }): Promise<boolean> {
    const s = this.sessions.get(id);
    if (!s || s.refreshTokenHash !== p.expectedHash || s.revokedAt) return false;
    s.previousRefreshTokenHash = p.expectedHash;
    s.refreshTokenHash = p.newHash;
    s.expiresAt = p.expiresAt;
    s.lastUsedAt = p.at;
    return true;
  }
  async revoke(id: string, at: Date): Promise<void> {
    const s = this.sessions.get(id);
    if (s && !s.revokedAt) s.revokedAt = at;
  }
  async revokeAllForUser(userId: string, at: Date): Promise<void> {
    for (const s of this.sessions.values()) if (s.userId === userId && !s.revokedAt) s.revokedAt = at;
  }
}

export class MemoryAdminRepo implements AdminRepo {
  readonly admins: AdminRecord[] = [];

  async findByUserId(userId: string): Promise<AdminRecord | null> {
    return this.admins.find((a) => a.userId === userId) ?? null;
  }
  async findByTelegramId(telegramId: bigint): Promise<AdminRecord | null> {
    return this.admins.find((a) => a.telegramId === telegramId) ?? null;
  }
  async count(): Promise<number> {
    return this.admins.length;
  }
  async create(a: { userId: string; telegramId: bigint | null; role: AdminRecord['role'] }): Promise<AdminRecord> {
    const rec: AdminRecord = { id: randomUUID(), ...a, isActive: true };
    this.admins.push(rec);
    return rec;
  }
}

export class MemoryMediaRepo implements MediaFileRepo {
  readonly files = new Map<string, MediaFileRecord>();

  async create(f: NewMediaFile): Promise<MediaFileRecord> {
    const rec: MediaFileRecord = { ...f, status: 'PENDING', createdAt: new Date() };
    this.files.set(rec.id, rec);
    return rec;
  }
  async findById(id: string): Promise<MediaFileRecord | null> {
    return this.files.get(id) ?? null;
  }
  async markReady(id: string, p: { verifiedAt: Date; sizeBytes: number }): Promise<void> {
    const f = this.files.get(id);
    if (f) Object.assign(f, { status: 'READY', sizeBytes: p.sizeBytes, multipartUploadId: null, multipartPartSize: null });
  }
  async markFailed(id: string): Promise<void> {
    const f = this.files.get(id);
    if (f) f.status = 'FAILED';
  }
}

export class MemoryAuditRepo implements AuditRepo {
  readonly entries: AuditEntry[] = [];
  async log(entry: AuditEntry): Promise<void> {
    this.entries.push(entry);
  }
}
