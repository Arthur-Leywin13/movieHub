import { createHmac } from 'node:crypto';
import { RateLimitedError } from '@movieshub/shared';
import type { PrismaClient } from '@prisma/client';
import type { RateLimiter } from '../security/rate-limit.ts';

/**
 * Limiteur à fenêtre fixe partagé par toutes les instances API via PostgreSQL.
 * L'UPSERT incrémente atomiquement le compteur ; les identifiants sont HMACés
 * avant stockage afin de ne pas exposer IP ou e-mails dans la table.
 */
export class PostgresRateLimiter implements RateLimiter {
  private readonly db: PrismaClient;
  private readonly pepper: string;
  private readonly max: number;
  private readonly windowMs: number;
  private readonly namespace: string;
  private callsSinceCleanup = 0;

  constructor(db: PrismaClient, pepper: string, opts: { max: number; windowMs: number; namespace: string }) {
    if (!Number.isSafeInteger(opts.max) || opts.max < 1) throw new RangeError('max doit être un entier positif');
    if (!Number.isSafeInteger(opts.windowMs) || opts.windowMs < 1) throw new RangeError('windowMs doit être un entier positif');
    if (pepper.length < 32) throw new RangeError('pepper doit contenir au moins 32 caractères');
    if (!opts.namespace.trim()) throw new RangeError('namespace ne doit pas être vide');
    this.db = db;
    this.pepper = pepper;
    this.max = opts.max;
    this.windowMs = opts.windowMs;
    this.namespace = opts.namespace;
  }

  private key(value: string): string {
    return createHmac('sha256', this.pepper).update(this.namespace).update(':').update(value).digest('hex');
  }

  async assert(value: string): Promise<void> {
    const key = this.key(value);
    const rows = await this.db.$queryRawUnsafe<Array<{ hitCount: number; windowStartedAt: Date }>>(
      `INSERT INTO "AuthRateLimitBucket" ("bucketKey", "windowStartedAt", "hitCount", "expiresAt")
       VALUES ($1, NOW(), 1, NOW() + ($2 * INTERVAL '1 millisecond'))
       ON CONFLICT ("bucketKey") DO UPDATE SET
         "hitCount" = CASE
           WHEN "AuthRateLimitBucket"."windowStartedAt" <= NOW() - ($2 * INTERVAL '1 millisecond') THEN 1
           ELSE LEAST("AuthRateLimitBucket"."hitCount" + 1, $3)
         END,
         "windowStartedAt" = CASE
           WHEN "AuthRateLimitBucket"."windowStartedAt" <= NOW() - ($2 * INTERVAL '1 millisecond') THEN NOW()
           ELSE "AuthRateLimitBucket"."windowStartedAt"
         END,
         "expiresAt" = CASE
           WHEN "AuthRateLimitBucket"."windowStartedAt" <= NOW() - ($2 * INTERVAL '1 millisecond')
             THEN NOW() + ($2 * INTERVAL '1 millisecond')
           ELSE "AuthRateLimitBucket"."expiresAt"
         END
       RETURNING "hitCount", "windowStartedAt"`,
      key,
      this.windowMs,
      this.max + 1,
    );
    const row = rows[0];
    if (!row) throw new Error('Le limiteur PostgreSQL n’a retourné aucun résultat');
    this.callsSinceCleanup += 1;
    if (this.callsSinceCleanup >= 100) {
      this.callsSinceCleanup = 0;
      await this.db.$executeRawUnsafe(
        `DELETE FROM "AuthRateLimitBucket"
         WHERE ctid IN (
           SELECT ctid FROM "AuthRateLimitBucket"
           WHERE "expiresAt" <= NOW()
           LIMIT 500
         )`,
      );
    }
    if (row.hitCount > this.max) {
      const retryAfterSeconds = Math.max(1, Math.ceil((row.windowStartedAt.getTime() + this.windowMs - Date.now()) / 1000));
      throw new RateLimitedError(`Trop de tentatives. Réessayez dans ${retryAfterSeconds} s.`);
    }
  }

  async reset(value: string): Promise<void> {
    await this.db.$executeRawUnsafe(
      'DELETE FROM "AuthRateLimitBucket" WHERE "bucketKey" = $1',
      this.key(value),
    );
  }
}
