import { randomUUID } from 'node:crypto';
import { ConflictError, NotFoundError, ValidationError } from '@movieshub/shared';
import type { AdminActor } from '../auth/actor.ts';
import type { AuditEntry, AuditRepo, MediaFileRecord, MediaFileRepo } from '../ports.ts';
import { buildObjectKey, choosePartSize, expectedPartSize, partCount, resolveUpload, type UploadKind } from '../storage/keys.ts';
import type { R2Client } from '../storage/r2-client.ts';

export type R2Port = Pick<
  R2Client,
  | 'presignPut'
  | 'presignUploadPart'
  | 'createMultipartUpload'
  | 'listParts'
  | 'completeMultipartUpload'
  | 'abortMultipartUpload'
  | 'headObject'
>;

/** Durée de validité des liens d'envoi : assez longue pour un fichier de 2 Go sur une connexion lente. */
export const UPLOAD_URL_TTL_SECONDS = 6 * 3600;

export interface RequestContext {
  ip: string;
  requestId: string;
}

export interface PartLink {
  partNumber: number;
  url: string;
}

export interface UploadInit {
  mediaFileId: string;
  kind: UploadKind;
  multipart: boolean;
  sizeBytes: number;
  expiresInSeconds: number;
  partSize?: number;
  partCount?: number;
  parts?: PartLink[];
  url?: string;
}

export interface UploadStatus {
  mediaFileId: string;
  status: string;
  multipart: boolean;
  expiresInSeconds?: number;
  partSize?: number;
  uploadedParts?: number[];
  missingParts?: PartLink[];
  url?: string;
}

export class UploadService {
  private readonly r2: R2Port;
  private readonly media: MediaFileRepo;
  private readonly audit: AuditRepo;
  private readonly bucket: string;
  private readonly now: () => Date;

  constructor(deps: { r2: R2Port; media: MediaFileRepo; audit: AuditRepo; bucket: string; now?: () => Date }) {
    this.r2 = deps.r2;
    this.media = deps.media;
    this.audit = deps.audit;
    this.bucket = deps.bucket;
    this.now = deps.now ?? (() => new Date());
  }

  private async log(actor: AdminActor, ctx: RequestContext, action: string, id: string | null, newValues: unknown, result: AuditEntry['result'] = 'SUCCESS', errorMessage?: string): Promise<void> {
    // Jamais d'URL pré-signée ni de clé d'accès dans le journal.
    await this.audit.log({
      source: actor.via === 'bot' ? 'TELEGRAM_BOT' : 'DASHBOARD',
      adminId: actor.adminId,
      action,
      entityType: 'MediaFile',
      entityId: id,
      newValues,
      result,
      ...(errorMessage ? { errorMessage } : {}),
      ipAddress: ctx.ip,
      requestId: ctx.requestId,
    });
  }

  private partLinks(m: MediaFileRecord, numbers: number[]): PartLink[] {
    return numbers.map((n) => ({
      partNumber: n,
      url: this.r2.presignUploadPart(m.objectKey, m.multipartUploadId as string, n, UPLOAD_URL_TTL_SECONDS),
    }));
  }

  private async load(id: string): Promise<MediaFileRecord> {
    const m = await this.media.findById(id);
    if (!m || m.status === 'DELETED') throw new NotFoundError('Fichier introuvable');
    return m;
  }

  async init(actor: AdminActor, input: { kind: UploadKind; filename: string; sizeBytes: number }, ctx: RequestContext): Promise<UploadInit> {
    const { rule, ext, mime } = resolveUpload(input.kind, input.filename, input.sizeBytes);
    const id = randomUUID();
    const objectKey = buildObjectKey(input.kind, id, ext, this.now());

    if (!rule.multipart) {
      await this.media.create({
        id, bucket: this.bucket, objectKey, kind: input.kind, mimeType: mime, sizeBytes: input.sizeBytes,
        multipartUploadId: null, multipartPartSize: null, uploadedByAdminId: actor.adminId,
      });
      await this.log(actor, ctx, 'media.upload.init', id, { kind: input.kind, sizeBytes: input.sizeBytes, multipart: false });
      return {
        mediaFileId: id, kind: input.kind, multipart: false, sizeBytes: input.sizeBytes,
        expiresInSeconds: UPLOAD_URL_TTL_SECONDS, url: this.r2.presignPut(objectKey, UPLOAD_URL_TTL_SECONDS),
      };
    }

    const partSize = choosePartSize(input.sizeBytes);
    const count = partCount(input.sizeBytes, partSize);
    const uploadId = await this.r2.createMultipartUpload(objectKey, mime);
    let record: MediaFileRecord;
    try {
      record = await this.media.create({
        id, bucket: this.bucket, objectKey, kind: input.kind, mimeType: mime, sizeBytes: input.sizeBytes,
        multipartUploadId: uploadId, multipartPartSize: partSize, uploadedByAdminId: actor.adminId,
      });
    } catch (err) {
      // Évite un envoi multipart orphelin (qui occuperait de l'espace sans être référencé).
      await this.r2.abortMultipartUpload(objectKey, uploadId).catch(() => undefined);
      throw err;
    }
    await this.log(actor, ctx, 'media.upload.init', id, { kind: input.kind, sizeBytes: input.sizeBytes, multipart: true, partSize, partCount: count });
    return {
      mediaFileId: id, kind: input.kind, multipart: true, sizeBytes: input.sizeBytes, expiresInSeconds: UPLOAD_URL_TTL_SECONDS,
      partSize, partCount: count, parts: this.partLinks(record, Array.from({ length: count }, (_, i) => i + 1)),
    };
  }

  /** Reprise après coupure : liste les morceaux déjà reçus et redonne des liens pour les manquants. */
  async status(actor: AdminActor, id: string): Promise<UploadStatus> {
    void actor;
    const m = await this.load(id);
    const base = { mediaFileId: m.id, status: m.status, multipart: m.multipartUploadId !== null };
    if (m.status !== 'PENDING') return base;
    if (m.multipartUploadId === null) {
      return { ...base, expiresInSeconds: UPLOAD_URL_TTL_SECONDS, url: this.r2.presignPut(m.objectKey, UPLOAD_URL_TTL_SECONDS) };
    }
    const total = m.sizeBytes as number;
    const partSize = m.multipartPartSize as number;
    const listed = await this.r2.listParts(m.objectKey, m.multipartUploadId);
    const ok = new Set(listed.filter((p) => p.sizeBytes === expectedPartSize(total, partSize, p.partNumber)).map((p) => p.partNumber));
    const missing = Array.from({ length: partCount(total, partSize) }, (_, i) => i + 1).filter((n) => !ok.has(n));
    return {
      ...base, partSize, expiresInSeconds: UPLOAD_URL_TTL_SECONDS,
      uploadedParts: [...ok].sort((a, b) => a - b), missingParts: this.partLinks(m, missing),
    };
  }

  async complete(actor: AdminActor, id: string, ctx: RequestContext): Promise<{ mediaFileId: string; status: 'READY'; sizeBytes: number }> {
    const m = await this.load(id);
    if (m.status === 'READY') return { mediaFileId: m.id, status: 'READY', sizeBytes: m.sizeBytes as number };
    if (m.status === 'FAILED') throw new ConflictError('Envoi échoué ou annulé : recommencez un nouvel envoi');
    const expected = m.sizeBytes as number;

    if (m.multipartUploadId !== null) {
      const partSize = m.multipartPartSize as number;
      const count = partCount(expected, partSize);
      const byNumber = new Map((await this.r2.listParts(m.objectKey, m.multipartUploadId)).map((p) => [p.partNumber, p]));
      const wanted = Array.from({ length: count }, (_, i) => i + 1);
      const bad = wanted.filter((n) => byNumber.get(n)?.sizeBytes !== expectedPartSize(expected, partSize, n));
      if (bad.length > 0) throw new ValidationError('Envoi incomplet ou morceaux de taille inattendue', { missingParts: bad });
      await this.r2.completeMultipartUpload(m.objectKey, m.multipartUploadId, wanted.map((n) => byNumber.get(n) as NonNullable<ReturnType<typeof byNumber.get>>));
    }

    const head = await this.r2.headObject(m.objectKey);
    // Fichier pas encore arrivé : réessayable (le fichier reste PENDING).
    if (!head) throw new ValidationError('Fichier non reçu : terminez l’envoi puis réessayez', { expected });
    // Taille incorrecte : échec définitif (fichier tronqué ou différent de celui annoncé).
    if (head.sizeBytes !== expected) {
      await this.media.markFailed(m.id);
      await this.log(actor, ctx, 'media.upload.complete', m.id, { expected, received: head.sizeBytes }, 'FAILURE', 'Taille finale inattendue');
      throw new ValidationError('Taille du fichier différente de celle annoncée', { expected, received: head.sizeBytes });
    }
    await this.media.markReady(m.id, { verifiedAt: this.now(), sizeBytes: head.sizeBytes });
    await this.log(actor, ctx, 'media.upload.complete', m.id, { sizeBytes: head.sizeBytes });
    return { mediaFileId: m.id, status: 'READY', sizeBytes: head.sizeBytes };
  }

  async abort(actor: AdminActor, id: string, ctx: RequestContext): Promise<void> {
    const m = await this.load(id);
    if (m.status === 'READY') throw new ConflictError('Fichier déjà publié : la suppression est une opération distincte');
    if (m.status === 'PENDING' && m.multipartUploadId !== null) {
      await this.r2.abortMultipartUpload(m.objectKey, m.multipartUploadId);
    }
    await this.media.markFailed(m.id);
    await this.log(actor, ctx, 'media.upload.abort', m.id, {});
  }
}
