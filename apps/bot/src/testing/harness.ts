/**
 * Environnement de test : le bot parle à la VRAIE API (serveur HTTP local, dépôts en mémoire) dont le stockage
 * est un serveur S3 local qui vérifie les signatures. Seuls Telegram et la base sont simulés.
 */
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { UploadService } from '../../../api/src/admin/upload-service.ts';
import { buildApp } from '../../../api/src/app.ts';
import { ActorResolver } from '../../../api/src/auth/actor.ts';
import { AuthService } from '../../../api/src/auth/auth-service.ts';
import { CatalogAdminService } from '../../../api/src/catalog/admin-service.ts';
import { CatalogReadService } from '../../../api/src/catalog/read-service.ts';
import { createHttpServer } from '../../../api/src/http/server.ts';
import { R2Client } from '../../../api/src/storage/r2-client.ts';
import { MemoryCatalogRepo } from '../../../api/src/testing/memory-catalog-repo.ts';
import { startMockS3 } from '../../../api/src/testing/mock-s3-server.ts';
import { MemoryAdminRepo, MemoryAuditRepo, MemoryMediaRepo, MemorySessionRepo, MemoryUserRepo } from '../../../api/src/testing/memory-repos.ts';

export const BOT_TOKEN = 'b'.repeat(40);
export const ADMIN_ID = 777;

export async function startApiHarness() {
  const credentials = { accessKeyId: 'LOCALKEY', secretAccessKey: 'local-secret-key-for-tests' };
  const bucket = 'movieshub-test';
  const mock = await startMockS3({ bucket, credentials });
  const r2 = new R2Client({ accountId: 'local', bucket, ...credentials }, { endpoint: { host: mock.host, scheme: 'http' } });
  const media = new MemoryMediaRepo();
  const audit = new MemoryAuditRepo();
  const repo = new MemoryCatalogRepo(media);
  const admins = new MemoryAdminRepo();
  admins.admins.push({ id: 'adm-bot', userId: randomUUID(), telegramId: BigInt(ADMIN_ID), role: 'EDITOR', isActive: true });
  const auth = new AuthService({ users: new MemoryUserRepo(), sessions: new MemorySessionRepo() }, { accessSecret: 'a'.repeat(40), refreshPepper: 'p'.repeat(40), passwordParams: { N: 2 ** 10, r: 8, p: 1 } });
  const actors = new ActorResolver({ auth, admins, botServiceToken: BOT_TOKEN });
  const router = buildApp({
    auth, actors,
    uploads: new UploadService({ r2, media, audit, bucket }),
    catalogAdmin: new CatalogAdminService({ repo, media, audit }),
    catalogRead: new CatalogReadService({ repo, signer: r2 }),
  });
  const server = createHttpServer({ router });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    baseUrl, mock, media, repo, audit, admins,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await mock.close();
    },
  };
}
export type ApiHarness = Awaited<ReturnType<typeof startApiHarness>>;
