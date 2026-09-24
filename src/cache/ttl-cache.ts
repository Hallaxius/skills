interface CacheEntry<T> {
  readonly value: T;
  readonly expiresAt: number;
}

/**
 * Small in-memory TTL cache with approximate LRU (recently read entries are
 * refreshed) and FIFO eviction at capacity. The skills.sh terms of use
 * explicitly encourage caching results on our own infrastructure.
 */
export class TtlCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();

  constructor(private readonly maxEntries = 200) {}

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    // Refresh insertion order so frequently-read keys survive eviction.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T, ttlMs: number): void {
    if (!this.entries.has(key)) {
      this.evictIfFull();
    }
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  get size(): number {
    return this.entries.size;
  }

  private evictIfFull(): void {
    if (this.entries.size < this.maxEntries) return;
    const oldest = this.entries.keys().next();
    if (!oldest.done) this.entries.delete(oldest.value);
  }
}
