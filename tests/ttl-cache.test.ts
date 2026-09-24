import { describe, expect, it } from "bun:test";
import { TtlCache } from "../src/cache/ttl-cache";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("TtlCache", () => {
  it("stores and returns values within the TTL", () => {
    const cache = new TtlCache<string>(10);
    cache.set("k", "v", 1_000);
    expect(cache.get("k")).toBe("v");
    expect(cache.size).toBe(1);
  });

  it("expires entries after the TTL", async () => {
    const cache = new TtlCache<string>(10);
    cache.set("k", "v", 30);
    await sleep(70);
    expect(cache.get("k")).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("evicts the oldest entry when at capacity", () => {
    const cache = new TtlCache<string>(2);
    cache.set("a", "1", 1_000);
    cache.set("b", "2", 1_000);
    cache.set("c", "3", 1_000); // evicts "a"
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe("2");
    expect(cache.get("c")).toBe("3");
  });

  it("refreshes recently-read entries (approximate LRU)", () => {
    const cache = new TtlCache<string>(2);
    cache.set("a", "1", 1_000);
    cache.set("b", "2", 1_000);
    cache.get("a"); // refresh "a" — "b" becomes the eviction victim
    cache.set("c", "3", 1_000);
    expect(cache.get("a")).toBe("1");
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("c")).toBe("3");
  });

  it("overwriting a key does not grow the cache", () => {
    const cache = new TtlCache<string>(2);
    cache.set("a", "1", 1_000);
    cache.set("a", "2", 1_000);
    expect(cache.size).toBe(1);
    expect(cache.get("a")).toBe("2");
  });
});
