import { RateLimitedError } from '@movieshub/shared';

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

/**
 * Limiteur à fenêtre glissante, en mémoire (un seul processus).
 * Si l'API est un jour répliquée sur plusieurs instances, il faudra un stockage partagé.
 */
export class SlidingWindowLimiter {
  private readonly max: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly maxKeys: number;
  private readonly hits = new Map<string, number[]>();

  constructor(opts: { max: number; windowMs: number; now?: () => number; maxKeys?: number }) {
    this.max = opts.max;
    this.windowMs = opts.windowMs;
    this.now = opts.now ?? Date.now;
    this.maxKeys = opts.maxKeys ?? 10_000;
  }

  /** Enregistre une tentative et indique si elle est autorisée. */
  hit(key: string): RateLimitResult {
    const now = this.now();
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      const oldest = recent[0] ?? now;
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000)) };
    }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > this.maxKeys) this.purge(now);
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
    for (const [k, times] of this.hits) {
      if (times.every((t) => now - t >= this.windowMs)) this.hits.delete(k);
    }
  }
}
