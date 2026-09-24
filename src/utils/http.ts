import { SkillsError } from "../errors";
import { logger } from "./logger";
import { RateLimiter, sleep } from "./rate-limiter";

export interface RequestOptions {
  /** Value for the Accept header. */
  accept?: string;
  /** Extra headers (e.g. Authorization for the v1 API). */
  headers?: Record<string, string>;
  /** Override the per-request timeout. */
  timeoutMs?: number;
}

/** Never wait longer than this for a 429 Retry-After before surfacing RATE_LIMITED. */
const MAX_RETRY_AFTER_WAIT_MS = 15_000;

/**
 * Thin fetch wrapper: identifiable User-Agent, timeout via AbortController,
 * bounded retries with exponential backoff (network errors, timeouts, 5xx),
 * and Retry-After-aware 429 handling. All requests go through the shared
 * RateLimiter so the server stays polite to skills.sh.
 */
export class HttpClient {
  constructor(
    private readonly limiter: RateLimiter,
    private readonly userAgent: string,
    private readonly fetchImpl: typeof globalThis.fetch,
    private readonly timeoutMs: number,
    private readonly backoffBaseMs = 500,
  ) {}

  async get(url: string, opts: RequestOptions = {}, retries = 2): Promise<Response> {
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
    const maxAttempts = retries + 1;
    for (let attempt = 1; ; attempt++) {
      try {
        const response = await this.limiter.run(() => this.fetchOnce(url, timeoutMs, opts));
        if (response.status === 429) {
          const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
          const tooLong = retryAfterMs !== undefined && retryAfterMs > MAX_RETRY_AFTER_WAIT_MS;
          if (attempt >= maxAttempts || tooLong) {
            throw new SkillsError(
              "RATE_LIMITED",
              "skills.sh is rate limiting us (HTTP 429); please retry shortly",
            );
          }
          const waitMs = retryAfterMs ?? this.backoffMs(attempt);
          logger.warn(`429 from ${url}; backing off ${waitMs}ms`);
          await sleep(waitMs);
          continue;
        }
        return response;
      } catch (error) {
        if (!(error instanceof SkillsError)) throw error;
        const retryable =
          error.code === "TIMEOUT" || error.code === "NETWORK_ERROR" || error.code === "UPSTREAM_ERROR";
        if (!retryable || attempt >= maxAttempts) throw error;
        const waitMs = this.backoffMs(attempt);
        logger.warn(
          `${error.code} on attempt ${attempt}/${maxAttempts} for ${url}; retrying in ${waitMs}ms`,
        );
        await sleep(waitMs);
      }
    }
  }

  private async fetchOnce(url: string, timeoutMs: number, opts: RequestOptions): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        method: "GET",
        redirect: "follow",
        signal: controller.signal,
        headers: {
          "User-Agent": this.userAgent,
          Accept: opts.accept ?? "*/*",
          ...(opts.headers ?? {}),
        },
      });
      if (response.status >= 500) {
        // Release the body, then signal a retryable upstream failure.
        await response.text().catch(() => undefined);
        throw new SkillsError("UPSTREAM_ERROR", `skills.sh responded with HTTP ${response.status}`);
      }
      return response;
    } catch (error) {
      if (error instanceof SkillsError) throw error;
      if (isAbortError(error)) {
        throw new SkillsError("TIMEOUT", `request to ${url} timed out after ${timeoutMs}ms`);
      }
      throw new SkillsError("NETWORK_ERROR", `network error requesting ${url}: ${errorMessage(error)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  private backoffMs(attempt: number): number {
    return this.backoffBaseMs * Math.pow(3, attempt - 1);
  }
}

function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number.parseInt(value.trim(), 10);
  if (Number.isFinite(seconds)) return Math.max(0, seconds) * 1000;
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
