import type { AdminActor } from '../auth/actor.ts';
import { CatalogAdminService } from '../catalog/admin-service.ts';
import { CatalogReadService } from '../catalog/read-service.ts';
import type { MediaKindName } from '../ports.ts';
import { FakeR2 } from './fake-r2.ts';
import { MemoryCatalogRepo } from './memory-catalog-repo.ts';
import { MemoryAuditRepo, MemoryMediaRepo } from './memory-repos.ts';

export const ACTOR: AdminActor = { kind: 'admin', userId: 'u1', adminId: 'adm1', role: 'EDITOR', via: 'jwt', telegramId: null };
export const CTX = { ip: '127.0.0.1', requestId: 'req-test' };

export function catalogFixture() {
  const media = new MemoryMediaRepo();
  const audit = new MemoryAuditRepo();
  const repo = new MemoryCatalogRepo(media);
  const r2 = new FakeR2();
  const admin = new CatalogAdminService({ repo, media, audit, now: () => new Date('2026-11-01T12:00:00Z') });
  const read = new CatalogReadService({ repo, signer: r2 });
  let n = 0;
  /** Crée un fichier R2 déjà « prêt » (envoi terminé) du type demandé. */
  const readyMedia = async (kind: MediaKindName, ext: string, status: 'READY' | 'PENDING' = 'READY'): Promise<string> => {
    const id = crypto.randomUUID();
    const dir = { VIDEO: 'video', TRAILER_VIDEO: 'trailer', IMAGE: 'image', SUBTITLE: 'subtitle', OTHER: 'other' }[kind];
    await media.create({
      id, bucket: 'b', objectKey: `${dir}/2026/11/${id}.${ext}`, kind, mimeType: 'x/y', sizeBytes: 1000 + ++n,
      multipartUploadId: null, multipartPartSize: null, uploadedByAdminId: 'adm1',
    });
    if (status === 'READY') await media.markReady(id, { verifiedAt: new Date(), sizeBytes: 1000 + n });
    return id;
  };
  return { media, audit, repo, admin, read, readyMedia, r2 };
}
