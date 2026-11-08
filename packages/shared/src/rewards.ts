/**
 * Règles métier des jetons et du sans-pub, validées par le propriétaire du projet.
 * Fonctions pures (aucun accès base) : l'API les utilise dans ses transactions.
 */

export const REWARD_DEFAULTS = {
  /** Pubs récompensées créditées par jour. */
  dailyAdLimit: 3,
  /** Jetons par pub récompensée. */
  tokensPerAd: 2,
  /** Fuseau qui définit le « jour » du plafond (modifiable dans AppSetting). */
  dayTimeZone: 'America/Port-au-Prince',
} as const;

export const DEFAULT_PROMO_TOKENS = 15;

export interface AdFreePlanDefinition {
  code: string;
  name: string;
  tokenCost: number;
  durationDays: number;
  sortOrder: number;
}

export const DEFAULT_AD_FREE_PLANS: readonly AdFreePlanDefinition[] = [
  { code: 'DAY_1', name: '1 jour sans publicité', tokenCost: 10, durationDays: 1, sortOrder: 1 },
  { code: 'DAYS_7', name: '7 jours sans publicité', tokenCost: 30, durationDays: 7, sortOrder: 2 },
  { code: 'DAYS_14', name: '14 jours sans publicité', tokenCost: 60, durationDays: 14, sortOrder: 3 },
];

/** Jour calendaire (AAAA-MM-JJ) d'un instant dans un fuseau IANA. */
export function rewardDay(at: Date, timeZone: string = REWARD_DEFAULTS.dayTimeZone): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(at);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Plus petit emplacement libre entre 1 et `limit`, ou null si le plafond du jour est atteint. */
export function nextRewardSlot(usedSlots: readonly number[], limit: number): number | null {
  for (let slot = 1; slot <= limit; slot++) {
    if (!usedSlots.includes(slot)) return slot;
  }
  return null;
}

export type SpendCheck =
  | { ok: true; balanceAfter: number }
  | { ok: false; reason: 'INSUFFICIENT_TOKENS'; missing: number };

export function checkTokenSpend(balance: number, cost: number): SpendCheck {
  if (balance >= cost) return { ok: true, balanceAfter: balance - cost };
  return { ok: false, reason: 'INSUFFICIENT_TOKENS', missing: cost - balance };
}

export function planExpiresAt(from: Date, durationDays: number): Date {
  return new Date(from.getTime() + durationDays * 86_400_000);
}

export type EntitlementSourceName = 'PAYMENT' | 'ADMIN_GRANT' | 'TOKEN_PLAN';
export type EntitlementStatusName = 'ACTIVE' | 'EXPIRED' | 'REVOKED';

export interface EntitlementRef {
  id: string;
  source: EntitlementSourceName;
  status: EntitlementStatusName;
  expiresAt: Date | null;
}

/**
 * Un nouveau plan par jetons annule le plan par jetons encore actif.
 * Les droits issus d'un don ou accordés par un admin ne sont jamais touchés.
 */
export function entitlementIdsToReplace(existing: readonly EntitlementRef[], now: Date): string[] {
  return existing
    .filter((e) => e.source === 'TOKEN_PLAN' && e.status === 'ACTIVE' && (e.expiresAt === null || e.expiresAt > now))
    .map((e) => e.id);
}

/** Vrai si au moins un droit actif et non expiré existe : aucune publicité ne doit être servie. */
export function hasActiveAdFree(existing: readonly EntitlementRef[], now: Date): boolean {
  return existing.some((e) => e.status === 'ACTIVE' && (e.expiresAt === null || e.expiresAt > now));
}
