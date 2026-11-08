import { PrismaClient } from '@prisma/client';

export * from '@prisma/client';

const globalForPrisma = globalThis as unknown as { __movieshubPrisma?: PrismaClient };

/** Client Prisma partagé (un seul par processus, réutilisé en développement). */
export const prisma: PrismaClient =
  globalForPrisma.__movieshubPrisma ??
  new PrismaClient({
    log: process.env['NODE_ENV'] === 'production' ? ['error'] : ['warn', 'error'],
  });

if (process.env['NODE_ENV'] !== 'production') {
  globalForPrisma.__movieshubPrisma = prisma;
}
