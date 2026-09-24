import { describe, expect, it } from "bun:test";
import { RateLimiter, sleep } from "../src/utils/rate-limiter";

describe("RateLimiter", () => {
  it("enforces the minimum interval between dispatches", async () => {
    const limiter = new RateLimiter(40);
    const dispatches: number[] = [];
    const task = () => {
      dispatches.push(Date.now());
      return Promise.resolve("ok");
    };
    await Promise.all([limiter.run(task), limiter.run(task), limiter.run(task)]);
    expect(dispatches).toHaveLength(3);
    const gap01 = dispatches[1]! - dispatches[0]!;
    const gap12 = dispatches[2]! - dispatches[1]!;
    // Allow a small clock-scheduling slop below the configured interval.
    expect(gap01).toBeGreaterThanOrEqual(35);
    expect(gap12).toBeGreaterThanOrEqual(35);
  });

  it("serializes tasks: the second starts only after the first finishes", async () => {
    const limiter = new RateLimiter(0);
    const events: string[] = [];
    const first = limiter.run(async () => {
      events.push("1:start");
      await sleep(30);
      events.push("1:end");
    });
    const second = limiter.run(async () => {
      events.push("2:start");
    });
    await Promise.all([first, second]);
    expect(events).toEqual(["1:start", "1:end", "2:start"]);
  });

  it("keeps the queue usable after a failing task", async () => {
    const limiter = new RateLimiter(0);
    const failing = limiter.run(async () => {
      throw new Error("boom");
    });
    await expect(failing).rejects.toThrow("boom");
    await expect(limiter.run(() => Promise.resolve("fine"))).resolves.toBe("fine");
  });
});
