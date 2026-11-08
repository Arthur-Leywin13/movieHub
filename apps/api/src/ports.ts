/**
 * Ports (interfaces) d'accès aux données. Les services dépendent de ces interfaces, pas de Prisma :
 * ils sont testables sans base, et l'implémentation Prisma (src/infra) reste une fine couche.
 */

export type UserStatusName = 'ACTIVE' | 'SUSPENDED' | 'DELETED';
export type PlatformName = 'ANDROID' | 'WEB';
export type AdminRoleName = 'SUPER_ADMIN' | 'ADMIN' | 'EDITOR' | 'MODERATOR';
export type MediaKindName = 'VIDEO' | 'IMAGE' | 'TRAILER_VIDEO' | 'SUBTITLE' | 'OTHER';
export type MediaStatusName = 'PENDING' | 'READY' | 'FAILED' | 'DELETED';

export interface UserRecord {
  id: string;
  email: string;
  passwordHash: string;
  displayName: string;
  status: UserStatusName;
  createdAt: Date;
}

export interface NewUser {
  email: string;
  passwordHash: string;
  displayName: string;
}

export interface UserRepo {
  findByEmail(email: string): Promise<UserRecord | null>;
  findById(id: string): Promise<UserRecord | null>;
  /** Doit lever ConflictError si l'e-mail existe déjà. */
  create(user: NewUser): Promise<UserRecord>;
  touchLogin(id: string, at: Date): Promise<void>;
  updatePasswordHash(id: string, hash: string): Promise<void>;
}

export interface SessionRecord {
  id: string;
  userId: string;
  refreshTokenHash: string;
  previousRefreshTokenHash: string | null;
  expiresAt: Date;
  revokedAt: Date | null;
  deviceName: string | null;
  platform: PlatformName | null;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: Date;
  /** Mis à jour à chaque rotation : sert aussi d'horodatage de la dernière rotation. */
  lastUsedAt: Date | null;
}

export interface NewSession {
  userId: string;
  refreshTokenHash: string;
  expiresAt: Date;
  deviceName: string | null;
  platform: PlatformName | null;
  ipAddress: string | null;
  userAgent: string | null;
}

export interface SessionRepo {
  create(session: NewSession): Promise<SessionRecord>;
  findById(id: string): Promise<SessionRecord | null>;
  findByRefreshHash(hash: string): Promise<{ session: SessionRecord; matched: 'current' | 'previous' } | null>;
  /** Rotation conditionnelle : ne s'applique que si le hash courant vaut encore expectedHash. */
  rotate(id: string, p: { expectedHash: string; newHash: string; expiresAt: Date; at: Date }): Promise<boolean>;
  revoke(id: string, at: Date): Promise<void>;
  revokeAllForUser(userId: string, at: Date): Promise<void>;
}

export interface AdminRecord {
  id: string;
  userId: string;
  telegramId: bigint | null;
  role: AdminRoleName;
  isActive: boolean;
}

export interface AdminRepo {
  findByUserId(userId: string): Promise<AdminRecord | null>;
  findByTelegramId(telegramId: bigint): Promise<AdminRecord | null>;
  count(): Promise<number>;
  create(a: { userId: string; telegramId: bigint | null; role: AdminRoleName }): Promise<AdminRecord>;
}

export interface MediaFileRecord {
  id: string;
  bucket: string;
  objectKey: string;
  kind: MediaKindName;
  mimeType: string | null;
  sizeBytes: number | null;
  status: MediaStatusName;
  multipartUploadId: string | null;
  multipartPartSize: number | null;
  uploadedByAdminId: string | null;
  createdAt: Date;
}

export interface NewMediaFile {
  id: string;
  bucket: string;
  objectKey: string;
  kind: MediaKindName;
  mimeType: string;
  sizeBytes: number;
  multipartUploadId: string | null;
  multipartPartSize: number | null;
  uploadedByAdminId: string;
}

export interface MediaFileRepo {
  create(file: NewMediaFile): Promise<MediaFileRecord>;
  findById(id: string): Promise<MediaFileRecord | null>;
  /** Passe en READY et efface les champs d'envoi multipart. */
  markReady(id: string, p: { verifiedAt: Date; sizeBytes: number }): Promise<void>;
  markFailed(id: string): Promise<void>;
}

export type AuditSourceName = 'DASHBOARD' | 'TELEGRAM_BOT' | 'API' | 'SYSTEM';

export interface AuditEntry {
  source: AuditSourceName;
  adminId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  oldValues?: unknown;
  newValues?: unknown;
  result: 'SUCCESS' | 'FAILURE';
  errorMessage?: string;
  ipAddress?: string;
  requestId?: string;
}

export interface AuditRepo {
  log(entry: AuditEntry): Promise<void>;
}
