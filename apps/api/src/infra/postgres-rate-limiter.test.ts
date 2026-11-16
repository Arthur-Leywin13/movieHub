import assert from 'node:assert/strict';
import test from 'node:test';
import type { PrismaClient } from '@prisma/client';
import { RateLimitedError } from '@movieshub/shared';
import { PostgresRateLimiter } from './postgres-rate-limiter.ts';

function fakeDb(hitCount: number) {
  const calls: Array<{ query: string; values: unknown[] }> = [];
  const db = {
    $queryRawUnsafe: async (query: string, ...values: unknown[]) => {
      calls.push({ query, values });
      return [{ hitCount, windowStartedAt: new Date(Date.now() - 1_000) }];
    },
    $executeRawUnsafe: async (query: string, ...values: unknown[]) => {
      calls.push({ query, values });
      return 1;
    },
  };
  return { db: db as unknown as PrismaClient, calls };
}

test('PostgreSQL limiter uses an atomic upsert and never stores the raw identifier', async () => {
  const { db, calls } = fakeDb(1);
  const limiter = new PostgresRateLimiter(db, 'p'.repeat(40), { max: 5, windowMs: 60_000 });

  await limiter.assert('email:person@example.com');

  assert.equal(calls.length, 1);
  assert.match(calls[0]?.query ?? '', /ON CONFLICT/);
  assert.match(calls[0]?.query ?? '', /DELETE FROM "AuthRateLimitBucket"/);
  assert.notEqual(calls[0]?.values[0], 'email:person@example.com');
  assert.equal(calls[0]?.values[1], 60_000);
  assert.equal(calls[0]?.values[2], 6);
});

test('PostgreSQL limiter blocks when the atomic counter exceeds the limit', async () => {
  const { db } = fakeDb(6);
  const limiter = new PostgresRateLimiter(db, 'p'.repeat(40), { max: 5, windowMs: 60_000 });

  await assert.rejects(limiter.assert('ip:127.0.0.1'), RateLimitedError);
});

test('PostgreSQL limiter validates its configuration', () => {
  const { db } = fakeDb(1);
  assert.throws(() => new PostgresRateLimiter(db, 'short', { max: 5, windowMs: 60_000 }), RangeError);
  assert.throws(() => new PostgresRateLimiter(db, 'p'.repeat(40), { max: 0, windowMs: 60_000 }), RangeError);
  assert.throws(() => new PostgresRateLimiter(db, 'p'.repeat(40), { max: 5, windowMs: 0 }), RangeError);
});
