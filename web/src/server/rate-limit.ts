/**
 * A sliding-window request limit per key, in memory. Good enough for one server process; with
 * several instances (e.g. Vercel scaling out) each instance counts separately, so the effective
 * limit is a multiple of this. A shared store (Postgres or Redis) would fix that.
 */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly clock: () => number = Date.now,
  ) {}

  /** Record one request; false when the key is over its limit (the request is not counted). */
  take(key: string): { ok: boolean; retryAfterS: number } {
    const now = this.clock();
    const since = now - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((t) => t > since);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      const oldest = recent[0] ?? now;
      return {
        ok: false,
        retryAfterS: Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000)),
      };
    }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 10_000) this.sweep(since);
    return { ok: true, retryAfterS: 0 };
  }

  private sweep(since: number) {
    for (const [k, times] of this.hits) {
      if (!times.some((t) => t > since)) this.hits.delete(k);
    }
  }
}
