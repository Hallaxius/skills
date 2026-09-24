export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Serializes upstream calls and enforces a minimum interval between them.
 * This is one of the mechanisms that keep the server within skills.sh's
 * per-IP rate limits (the ToS allow reasonable API use; we stay conservative).
 */
export class RateLimiter {
  private tail: Promise<void> = Promise.resolve();
  private nextDispatchAt = 0;

  constructor(private readonly minIntervalMs: number) {}

  /** Queues `task` after any pending one, respecting the configured interval. */
  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      const wait = this.nextDispatchAt - Date.now();
      if (wait > 0) await sleep(wait);
      this.nextDispatchAt = Date.now() + this.minIntervalMs;
      return task();
    });
    // Keep the chain alive regardless of task outcome.
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
