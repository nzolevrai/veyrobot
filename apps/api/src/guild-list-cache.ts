/** Short lived, per-session OAuth data. Concurrent misses share one Discord request. */
export class GuildListCache<T> {
  private readonly entries = new Map<string, { value: T; expiresAt: number }>();
  private readonly inflight = new Map<string, Promise<T>>();
  private readonly limitedUntil = new Map<string, number>();

  constructor(private readonly ttlMs = 10_000, private readonly maxEntries = 1_000, private readonly now = Date.now) {}

  get(key: string, load: () => Promise<T>): Promise<T> {
    const current = this.entries.get(key);
    if (current && current.expiresAt > this.now()) return Promise.resolve(current.value);
    return this.load(key, load);
  }

  /** Forces a fresh permission snapshot while sharing in-flight reads and filling the display/read cache. */
  refresh(key: string, load: () => Promise<T>): Promise<T> {
    return this.load(key, load);
  }

  private load(key: string, load: () => Promise<T>): Promise<T> {
    const now = this.now();
    for (const [entryKey, entry] of this.entries) if (entry.expiresAt <= now) this.entries.delete(entryKey);
    const retryAt = this.limitedUntil.get(key);
    if (retryAt !== undefined) {
      const remainingMs = retryAt - this.now();
      if (remainingMs > 0) return Promise.reject(rateLimited(Math.ceil(remainingMs / 1_000)));
      this.limitedUntil.delete(key);
    }
    const running = this.inflight.get(key);
    if (running) return running;
    if (this.inflight.size >= this.maxEntries) return Promise.reject(Object.assign(new Error('Trop de lectures de serveurs simultanées. Réessayez plus tard.'), { statusCode: 503, code: 'OAUTH_CACHE_CAPACITY' }));
    const request = Promise.resolve().then(load).then(value => {
      const now = this.now();
      for (const [entryKey, entry] of this.entries) if (entry.expiresAt <= now) this.entries.delete(entryKey);
      if (this.entries.size >= this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
      this.entries.set(key, { value, expiresAt: now + this.ttlMs });
      this.limitedUntil.delete(key);
      return value;
    }).catch(error => {
      const failure = error as { statusCode?: number; code?: string; retryAfter?: string };
      if (failure.statusCode === 429 || failure.code === 'DISCORD_RATE_LIMIT') {
        const retryMs = parseRetryAfterMs(failure.retryAfter, this.now());
        this.limitedUntil.set(key, this.now() + retryMs);
        throw rateLimited(Math.ceil(retryMs / 1_000));
      }
      throw error;
    }).finally(() => { this.inflight.delete(key); });
    this.inflight.set(key, request);
    return request;
  }

  delete(key: string): void { this.entries.delete(key); this.limitedUntil.delete(key); }
}

function parseRetryAfterMs(value: string | undefined, now: number): number {
  if (value !== undefined) {
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.max(1_000, Math.ceil(seconds * 1_000));
    const dateMs = Date.parse(value);
    if (Number.isFinite(dateMs)) return Math.max(1_000, dateMs - now);
  }
  // A missing or malformed upstream header still needs a small local backoff to prevent a retry loop.
  return 1_000;
}

function rateLimited(retrySeconds: number): Error & { statusCode: number; code: string; retryAfter: string } {
  return Object.assign(new Error('Discord limite temporairement la lecture des serveurs.'), {
    statusCode: 429,
    code: 'DISCORD_RATE_LIMIT',
    retryAfter: String(Math.max(1, retrySeconds)),
  });
}
