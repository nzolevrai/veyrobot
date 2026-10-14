/** Short lived, per-session OAuth data. Concurrent misses share one Discord request. */
export class GuildListCache<T> {
  private readonly entries = new Map<string, { value: T; expiresAt: number }>();
  private readonly inflight = new Map<string, Promise<T>>();

  constructor(private readonly ttlMs = 10_000, private readonly maxEntries = 1_000, private readonly now = Date.now) {}

  get(key: string, load: () => Promise<T>): Promise<T> {
    const current = this.entries.get(key);
    if (current && current.expiresAt > this.now()) return Promise.resolve(current.value);
    if (current) this.entries.delete(key);
    const running = this.inflight.get(key);
    if (running) return running;
    if (this.inflight.size >= this.maxEntries) return Promise.reject(Object.assign(new Error('Trop de lectures de serveurs simultanées. Réessayez plus tard.'), { statusCode: 503, code: 'OAUTH_CACHE_CAPACITY' }));
    const request = load().then(value => {
      const now = this.now();
      for (const [entryKey, entry] of this.entries) if (entry.expiresAt <= now) this.entries.delete(entryKey);
      if (this.entries.size >= this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
      this.entries.set(key, { value, expiresAt: now + this.ttlMs });
      return value;
    }).finally(() => { this.inflight.delete(key); });
    this.inflight.set(key, request);
    return request;
  }

  delete(key: string): void { this.entries.delete(key); }
}
