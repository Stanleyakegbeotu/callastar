/**
 * Token-bucket rate limiting, per client address.
 *
 * The point is not abuse in the abstract: an unprotected invitation endpoint is a
 * call-spam engine, and an unprotected lookup endpoint is a way to enumerate
 * which Call IDs are real. Both are limited, and a refusal says only
 * `rate_limited` — never which of the two it was protecting.
 *
 * In-memory, so it is per instance. Behind more than one instance this needs a
 * shared store; the README says so rather than leaving it to be discovered.
 */

interface Bucket {
  tokens: number;
  lastRefill: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private lastSweep = Date.now();
  private readonly capacity: number;
  private readonly refillPerMs: number;

  // Fields assigned explicitly rather than as constructor parameter properties:
  // this service runs straight from TypeScript under Node's type stripping, which
  // erases types but does not transform syntax.
  constructor(capacity: number, refillPerMs: number) {
    this.capacity = capacity;
    this.refillPerMs = refillPerMs;
  }

  /** One unit of work. False means refuse. */
  take(key: string, cost = 1): boolean {
    const now = Date.now();
    this.sweep(now);

    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: this.capacity, lastRefill: now };
      this.buckets.set(key, bucket);
    }

    const elapsed = now - bucket.lastRefill;
    if (elapsed > 0) {
      bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsed * this.refillPerMs);
      bucket.lastRefill = now;
    }

    if (bucket.tokens < cost) return false;
    bucket.tokens -= cost;
    return true;
  }

  /**
   * Drops buckets that have refilled completely.
   *
   * Without this the map grows with every address ever seen, which is a slow
   * memory leak on a long-running service.
   */
  private sweep(now: number): void {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;

    const fullAfterMs = this.capacity / this.refillPerMs;
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.lastRefill > fullAfterMs) this.buckets.delete(key);
    }
  }
}

export function perMinute(count: number): RateLimiter {
  return new RateLimiter(count, count / 60_000);
}

export function perSecond(count: number): RateLimiter {
  return new RateLimiter(count, count / 1_000);
}
