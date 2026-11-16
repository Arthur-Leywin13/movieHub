import { RateLimitedError } from '@movieshub/shared';

export interface RateLimiter {
  assert(key: string): void | Promise<void>;
  reset(key: string): void | Promise<void>;
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

/**
 * Limiteur à fenêtre glissante, en mémoire (un seul processus).
 * Si l'API est répliquée, un stockage partagé est nécessaire pour appliquer
 * une limite cohérente entre les instances.
 */
export class SlidingWindowLimiter implements RateLimiter {
  private readonly max: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly maxKeys: number;
  private readonly hits = new Map<string, number[]>();

  constructor(opts: { max: number; windowMs: number; now?: () => number; maxKeys?: number }) {
    if (!Number.isSafeInteger(opts.max) || opts.max < 1) {
      throw new RangeError('max doit être un entier positif');
    }
    if (!Number.isFinite(opts.windowMs) || opts.windowMs <= 0) {
      throw new RangeError('windowMs doit être positif');
    }
    const maxKeys = opts.maxKeys ?? 10_000;
    if (!Number.isSafeInteger(maxKeys) || maxKeys < 1) {
      throw new RangeError('maxKeys doit être un entier positif');
    }

    this.max = opts.max;
    this.windowMs = opts.windowMs;
    this.now = opts.now ?? Date.now;
    this.maxKeys = maxKeys;
  }

  /** Enregistre une tentative et indique si elle est autorisée. */
  hit(key: string): RateLimitResult {
    const now = this.now();
    const existing = this.hits.get(key);
    const recent = (existing ?? []).filter((t) => now - t < this.windowMs);

    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      const oldest = recent[0] ?? now;
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000)),
      };
    }

    // Libère d'abord les fenêtres expirées avant d'ajouter une nouvelle clé.
    if (!existing && this.hits.size >= this.maxKeys) {
      this.purge(now);
    }

    // Le nombre de clés reste strictement borné. En cas de forte cardinalité,
    // on retire la clé dont la dernière activité est la plus ancienne.
    if (!existing && this.hits.size >= this.maxKeys) {
      this.evictOldest();
    }

    recent.push(now);
    this.hits.set(key, recent);
    return { allowed: true, retryAfterSeconds: 0 };
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  /** Lève une RateLimitedError si la limite est dépassée. */
  assert(key: string): void {
    const r = this.hit(key);
    if (!r.allowed) throw new RateLimitedError(`Trop de tentatives. Réessayez dans ${r.retryAfterSeconds} s.`);
  }

  private purge(now: number): void {
    for (const [key, times] of this.hits) {
      const recent = times.filter((t) => now - t < this.windowMs);
      if (recent.length === 0) this.hits.delete(key);
      else if (recent.length !== times.length) this.hits.set(key, recent);
    }
  }

  private evictOldest(): void {
    let oldestKey: string | undefined;
    let oldestActivity = Number.POSITIVE_INFINITY;

    for (const [key, times] of this.hits) {
      const lastActivity = times[times.length - 1] ?? Number.NEGATIVE_INFINITY;
      if (lastActivity < oldestActivity) {
        oldestActivity = lastActivity;
        oldestKey = key;
      }
    }

    if (oldestKey !== undefined) this.hits.delete(oldestKey);
  }
}
