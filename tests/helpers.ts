import type { Config } from "../src/config";
import { SkillsApiService } from "../src/services/skills-api";
import { HttpClient } from "../src/utils/http";
import { RateLimiter } from "../src/utils/rate-limiter";

export interface RecordedCall {
  url: string;
  headers: Record<string, string>;
}

export type FetchHandler = (url: string, headers: Record<string, string>) => Response | Promise<Response>;

/** Whatever `fetch` accepts as its input (string | URL | Request under Bun). */
export type FetchInput = Parameters<typeof globalThis.fetch>[0];

/** A fetch stub that records every call (URL + headers) for assertions. */
export function stubFetch(handler: FetchHandler): { fetch: typeof globalThis.fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const impl = (async (input: FetchInput, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    calls.push({ url, headers });
    return handler(url, headers);
  }) as typeof globalThis.fetch;
  return { fetch: impl, calls };
}

/** Builds a real SkillsApiService backed by a stubbed fetch (no network). */
export function makeService(
  handler: FetchHandler,
  configOverrides: Partial<Config> = {},
): { service: SkillsApiService; calls: RecordedCall[] } {
  const { fetch, calls } = stubFetch(handler);
  const limiter = new RateLimiter(0);
  const http = new HttpClient(limiter, "test-agent", fetch, 2_000, 1);
  const config: Config = {
    apiBaseUrl: "https://skills.sh",
    pageBaseUrl: "https://www.skills.sh",
    minRequestIntervalMs: 0,
    requestTimeoutMs: 2_000,
    ...configOverrides,
  };
  return { service: new SkillsApiService(http, config), calls };
}

export function jsonResponse(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { "content-type": "application/json", ...headers } });
}

export function htmlResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/html" } });
}
