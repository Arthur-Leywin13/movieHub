import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_AD_FREE_PLANS,
  DEFAULT_PROMO_TOKENS,
  REWARD_DEFAULTS,
  checkTokenSpend,
  entitlementIdsToReplace,
  hasActiveAdFree,
  nextRewardSlot,
  planExpiresAt,
  rewardDay,
  type EntitlementRef,
} from './rewards.ts';

const NOW = new Date('2026-11-01T12:00:00Z');
const later = new Date('2026-11-05T12:00:00Z');
const earlier = new Date('2026-10-30T12:00:00Z');

test('règles validées : 3 pubs/jour, 2 jetons/pub, code promo 15', () => {
  assert.equal(REWARD_DEFAULTS.dailyAdLimit, 3);
  assert.equal(REWARD_DEFAULTS.tokensPerAd, 2);
  assert.equal(DEFAULT_PROMO_TOKENS, 15);
  assert.equal(REWARD_DEFAULTS.dailyAdLimit * REWARD_DEFAULTS.tokensPerAd, 6);
});

test('plans validés : 10 jetons = 1 j, 30 = 7 j, 60 = 14 j', () => {
  assert.deepEqual(
    DEFAULT_AD_FREE_PLANS.map((p) => [p.tokenCost, p.durationDays]),
    [[10, 1], [30, 7], [60, 14]],
  );
  assert.equal(new Set(DEFAULT_AD_FREE_PLANS.map((p) => p.code)).size, 3);
});

test('rewardDay : le jour suit le fuseau d’Haïti (UTC-4 en été, UTC-5 en hiver)', () => {
  assert.equal(rewardDay(new Date('2026-10-30T03:30:00Z')), '2026-10-29');
  assert.equal(rewardDay(new Date('2026-10-30T04:30:00Z')), '2026-10-30');
  assert.equal(rewardDay(new Date('2026-01-15T04:30:00Z')), '2026-01-14');
  assert.equal(rewardDay(new Date('2026-01-15T05:30:00Z')), '2026-01-15');
});

test('rewardDay : fuseau explicite', () => {
  assert.equal(rewardDay(new Date('2026-10-30T23:30:00Z'), 'UTC'), '2026-10-30');
  assert.equal(rewardDay(new Date('2026-10-30T23:30:00Z'), 'Asia/Tokyo'), '2026-10-31');
});

test('nextRewardSlot : premier emplacement libre, null quand le plafond est atteint', () => {
  assert.equal(nextRewardSlot([], 3), 1);
  assert.equal(nextRewardSlot([1], 3), 2);
  assert.equal(nextRewardSlot([1, 3], 3), 2);
  assert.equal(nextRewardSlot([1, 2, 3], 3), null);
  assert.equal(nextRewardSlot([], 0), null);
});

test('checkTokenSpend : suffisant, juste, insuffisant', () => {
  assert.deepEqual(checkTokenSpend(15, 10), { ok: true, balanceAfter: 5 });
  assert.deepEqual(checkTokenSpend(10, 10), { ok: true, balanceAfter: 0 });
  assert.deepEqual(checkTokenSpend(6, 10), { ok: false, reason: 'INSUFFICIENT_TOKENS', missing: 4 });
});

test('planExpiresAt : ajoute des jours de 24 h', () => {
  assert.equal(planExpiresAt(new Date('2026-11-01T00:00:00Z'), 7).toISOString(), '2026-11-08T00:00:00.000Z');
});

const ent = (id: string, source: EntitlementRef['source'], status: EntitlementRef['status'], expiresAt: Date | null): EntitlementRef => ({
  id,
  source,
  status,
  expiresAt,
});

test('remplacement : seul le plan par jetons actif est annulé', () => {
  const list = [
    ent('tok-actif', 'TOKEN_PLAN', 'ACTIVE', later),
    ent('tok-expire', 'TOKEN_PLAN', 'ACTIVE', earlier),
    ent('tok-revoque', 'TOKEN_PLAN', 'REVOKED', later),
    ent('don', 'PAYMENT', 'ACTIVE', null),
    ent('admin', 'ADMIN_GRANT', 'ACTIVE', later),
  ];
  assert.deepEqual(entitlementIdsToReplace(list, NOW), ['tok-actif']);
});

test('remplacement : rien à annuler sans plan par jetons actif', () => {
  assert.deepEqual(entitlementIdsToReplace([ent('don', 'PAYMENT', 'ACTIVE', null)], NOW), []);
  assert.deepEqual(entitlementIdsToReplace([], NOW), []);
});

test('hasActiveAdFree : actif, expiré, révoqué, permanent', () => {
  assert.equal(hasActiveAdFree([ent('a', 'TOKEN_PLAN', 'ACTIVE', later)], NOW), true);
  assert.equal(hasActiveAdFree([ent('a', 'TOKEN_PLAN', 'ACTIVE', earlier)], NOW), false);
  assert.equal(hasActiveAdFree([ent('a', 'PAYMENT', 'REVOKED', null)], NOW), false);
  assert.equal(hasActiveAdFree([ent('a', 'PAYMENT', 'ACTIVE', null)], NOW), true);
  assert.equal(hasActiveAdFree([], NOW), false);
});
