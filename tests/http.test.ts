import { describe, expect, test } from "bun:test";
import { SkillsError } from "../src/errors";
import { HttpClient } from "../src/utils/http";
import { RateLimiter } from "../src/utils/rate-limiter";
import { jsonResponse, stubFetch, type FetchHandler, type FetchInput } from "./helpers";

const URL_UNDER_TEST = "https://skills.sh/api/search?q=react";

function makeClient(
  handler: FetchHandler,
  opts: { timeoutMs?: number; backoffBaseMs?: number; limiter?: RateLimiter } = {},
): { client: HttpClient; calls: ReturnType<typeof stubFetch>["calls"] } {
  const { fetch, calls } = stubFetch(handler);
  const limiter = opts.limiter ?? new RateLimiter(0);
  const client = new HttpClient(limiter, "test-agent", fetch, opts.timeoutMs ?? 2_000, opts.backoffBaseMs ?? 1);
  return { client, calls };
}

function statusResponse(status: number, headers: Record<string, string> = {}): Response {
  return new Response("", { status, headers });
}

/** Asserts that a request fails and returns the thrown error. */
async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected the request to fail");
    },
    (error: unknown) => error,
  );
}

describe("HttpClient.get", () => {
  test("returns the response and sends User-Agent, Accept and extra headers", async () => {
    const { client, calls } = makeClient(() => jsonResponse("{}"));
    const response = await client.get(URL_UNDER_TEST, {
      accept: "application/json",
      headers: { Authorization: "Bearer tok" },
    });
    expect(response.status).toBe(200);
    expect(calls.length).toBe(1);
    expect(calls[0]?.headers["user-agent"]).toBe("test-agent");
    expect(calls[0]?.headers.accept).toBe("application/json");
    expect(calls[0]?.headers.authorization).toBe("Bearer tok");
  });

  test("defaults Accept to */*", async () => {
    const { client, calls } = makeClient(() => jsonResponse("{}"));
    await client.get(URL_UNDER_TEST);
    expect(calls[0]?.headers.accept).toBe("*/*");
  });

  test("retries a 5xx and succeeds on the next attempt", async () => {
    let call = 0;
    const { client, calls } = makeClient(() => {
      call += 1;
      return call === 1 ? statusResponse(500) : jsonResponse("{\"ok\":true}");
    });
    const response = await client.get(URL_UNDER_TEST);
    expect(response.status).toBe(200);
    expect(calls.length).toBe(2);
  });

  test("surfaces UPSTREAM_ERROR after exhausting retries on persistent 5xx", async () => {
    const { client, calls } = makeClient(() => statusResponse(503));
    const error = (await failureOf(client.get(URL_UNDER_TEST))) as SkillsError;
    expect(error).toBeInstanceOf(SkillsError);
    expect(error.code).toBe("UPSTREAM_ERROR");
    expect(calls.length).toBe(3);
  });

  test("honors Retry-After: 0 on a 429 and retries", async () => {
    let call = 0;
    const { client, calls } = makeClient(() => {
      call += 1;
      return call === 1 ? statusResponse(429, { "retry-after": "0" }) : jsonResponse("{}");
    });
    const response = await client.get(URL_UNDER_TEST);
    expect(response.status).toBe(200);
    expect(calls.length).toBe(2);
  });

  test("surfaces RATE_LIMITED immediately when Retry-After is too long", async () => {
    const { client, calls } = makeClient(() => statusResponse(429, { "retry-after": "999" }));
    const error = (await failureOf(client.get(URL_UNDER_TEST))) as SkillsError;
    expect(error.code).toBe("RATE_LIMITED");
    expect(calls.length).toBe(1);
  });

  test("surfaces RATE_LIMITED after consecutive 429s", async () => {
    const { client, calls } = makeClient(() => statusResponse(429, { "retry-after": "0" }));
    const error = (await failureOf(client.get(URL_UNDER_TEST, {}, 1))) as SkillsError;
    expect(error.code).toBe("RATE_LIMITED");
    expect(calls.length).toBe(2);
  });

  test("aborts a hung request with TIMEOUT", async () => {
    const hungFetch = (async (_input: FetchInput, init?: RequestInit): Promise<Response> => {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    }) as typeof globalThis.fetch;
    const client = new HttpClient(new RateLimiter(0), "test-agent", hungFetch, 30, 1);
    const error = (await failureOf(client.get(URL_UNDER_TEST, {}, 0))) as SkillsError;
    expect(error).toBeInstanceOf(SkillsError);
    expect(error.code).toBe("TIMEOUT");
  });

  test("maps a throwing fetch to NETWORK_ERROR", async () => {
    const { client } = makeClient(() => {
      throw new TypeError("fetch failed");
    });
    const error = (await failureOf(client.get(URL_UNDER_TEST, {}, 0))) as SkillsError;
    expect(error).toBeInstanceOf(SkillsError);
    expect(error.code).toBe("NETWORK_ERROR");
  });

  test("spreads concurrent requests at least minIntervalMs apart", async () => {
    const dispatchTimes: number[] = [];
    const { client } = makeClient(
      () => {
        dispatchTimes.push(Date.now());
        return jsonResponse("{}");
      },
      { limiter: new RateLimiter(20) },
    );
    await Promise.all([client.get(URL_UNDER_TEST), client.get(URL_UNDER_TEST), client.get(URL_UNDER_TEST)]);
    expect(dispatchTimes.length).toBe(3);
    expect(dispatchTimes[1]! - dispatchTimes[0]!).toBeGreaterThanOrEqual(15);
    expect(dispatchTimes[2]! - dispatchTimes[1]!).toBeGreaterThanOrEqual(15);
  });
});
