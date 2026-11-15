/**
 * Point d'entrée de l'API : charge la configuration, assemble les services, démarre le serveur.
 * NON EXÉCUTÉ dans l'environnement de création (pas de base, pas de clés R2).
 */
import { EnvError, loadApiEnv } from '@movieshub/config';
import { prisma } from '@movieshub/database';
import { UploadService } from './admin/upload-service.ts';
import { buildApp } from './app.ts';
import { ActorResolver } from './auth/actor.ts';
import { AuthService } from './auth/auth-service.ts';
import { createHttpServer } from './http/server.ts';
import { consoleLogger } from './http/types.ts';
import { PrismaAdminRepo, PrismaAuditRepo, PrismaMediaFileRepo, PrismaSessionRepo, PrismaUserRepo } from './infra/prisma-repos.ts';
import { R2Client } from './storage/r2-client.ts';
import { bootstrapAdmin } from './bootstrap.ts';
import { CatalogAdminService } from './catalog/admin-service.ts';
import { CatalogReadService } from './catalog/read-service.ts';
import { PrismaCatalogRepo } from './infra/prisma-catalog-repo.ts';
import { PrismaUserDataRepo } from './infra/prisma-user-data-repo.ts';
import { UserDataService } from './user/service.ts';
import { ScheduledPublicationService } from './scheduler/service.ts';
import { NotificationService } from './notifications/service.ts';
import { ContentWithdrawalService } from './withdrawals/service.ts';

async function main(): Promise<void> {
  let env;
  try {
    env = loadApiEnv();
  } catch (err) {
    if (err instanceof EnvError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  const admins = new PrismaAdminRepo(prisma);
  const users = new PrismaUserRepo(prisma);
  if (env.bootstrapAdmin) {
    const result = await bootstrapAdmin({ users, admins }, env.bootstrapAdmin);
    consoleLogger.info('Administrateur initial', { result });
  }
  const auth = new AuthService(
    { users, sessions: new PrismaSessionRepo(prisma) },
    // JWT_REFRESH_SECRET sert de clé HMAC pour hacher les refresh tokens en base.
    { accessSecret: env.jwtAccessSecret, refreshPepper: env.jwtRefreshSecret },
  );
  const actors = new ActorResolver({ auth, admins, botServiceToken: env.botServiceToken });
  const r2 = new R2Client({
    accountId: env.r2.accountId,
    accessKeyId: env.r2.accessKeyId,
    secretAccessKey: env.r2.secretAccessKey,
    bucket: env.r2.bucket,
  });
  const media = new PrismaMediaFileRepo(prisma);
  const audit = new PrismaAuditRepo(prisma);
  const uploads = new UploadService({ r2, media, audit, bucket: env.r2.bucket });
  const catalogRepo = new PrismaCatalogRepo(prisma);
  const catalogAdmin = new CatalogAdminService({ repo: catalogRepo, media, audit });
  const userDataRepo = new PrismaUserDataRepo(prisma);
  const catalogRead = new CatalogReadService({ repo: catalogRepo, signer: r2, stats: userDataRepo });
  const userData = new UserDataService({ repo: userDataRepo, catalog: catalogRepo, read: catalogRead, signer: r2, downloadTtlSeconds: env.r2.signedUrlTtlSeconds });
  const scheduledPublications = new ScheduledPublicationService({ prisma });
  const notifications = new NotificationService({ prisma });
  const contentWithdrawals = new ContentWithdrawalService({ prisma });

  const router = buildApp({
    auth,
    actors,
    uploads,
    catalogAdmin,
    catalogRead,
    userData,
    scheduledPublications,
    notifications,
    contentWithdrawals,
    checkReady: async () => {
      await prisma.$queryRaw`SELECT 1`;
      return true;
    },
  });
  const server = createHttpServer({ router, logger: consoleLogger, trustProxy: env.trustProxy, corsOrigins: env.corsOrigins });
  server.listen(env.port, () => consoleLogger.info('API démarrée', { port: env.port, env: env.nodeEnv }));

  // Le scheduler appartient au backend, jamais au bot Telegram. Le verrou SQL
  // SKIP LOCKED permet plusieurs instances API sans double exécution.
  let schedulerRunning = false;
  let withdrawalsRunning = false;
  const runScheduler = async (): Promise<void> => {
    if (schedulerRunning) return;
    schedulerRunning = true;
    try {
      const result = await scheduledPublications.runOnce();
      if (result.claimed > 0) consoleLogger.info('Publications programmées traitées', result);
    } catch (error) {
      consoleLogger.error('Échec du cycle des publications programmées', { error: error instanceof Error ? error.message : 'Erreur inconnue' });
    } finally {
      schedulerRunning = false;
    }
  };
  const schedulerTimer = setInterval(() => void runScheduler(), 5_000);
  void runScheduler();

  const runWithdrawals = async (): Promise<void> => {
    if (withdrawalsRunning) return;
    withdrawalsRunning = true;
    try {
      const result = await contentWithdrawals.runOnce();
      if (result.notices > 0 || result.withdrawn > 0 || result.failed > 0) consoleLogger.info('Retraits de contenus traités', result);
    } catch (error) {
      consoleLogger.error('Échec du cycle des retraits programmés', { error: error instanceof Error ? error.message : 'Erreur inconnue' });
    } finally {
      withdrawalsRunning = false;
    }
  };
  const withdrawalsTimer = setInterval(() => void runWithdrawals(), 5_000);
  void runWithdrawals();

  const shutdown = (signal: string): void => {
    consoleLogger.info('Arrêt demandé', { signal });
    clearInterval(schedulerTimer);
    clearInterval(withdrawalsTimer);
    server.close(() => {
      void prisma.$disconnect().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

void main();
