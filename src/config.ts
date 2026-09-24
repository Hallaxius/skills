/** Environment-driven configuration. */

export interface Config {
  /**
   * Optional Vercel OIDC token enabling the documented v1 API
   * (semantic search + skill file contents). Obtained via
   * `vercel link && vercel env pull` (VERCEL_OIDC_TOKEN, ~12h validity).
   */
  readonly token?: string;
  /** Base URL for JSON APIs (apex serves the API). */
  readonly apiBaseUrl: string;
  /** Base URL for HTML pages (apex 308-redirects to www). */
  readonly pageBaseUrl: string;
  /** Minimum interval between two upstream requests, in ms. */
  readonly minRequestIntervalMs: number;
  /** Per-request timeout, in ms. */
  readonly requestTimeoutMs: number;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const token = env["VERCEL_OIDC_TOKEN"]?.trim() || undefined;
  return {
    token,
    apiBaseUrl: "https://skills.sh",
    pageBaseUrl: "https://www.skills.sh",
    minRequestIntervalMs: intFromEnv(env, "SKILLS_MIN_INTERVAL_MS", 500, 0, 60_000),
    requestTimeoutMs: intFromEnv(env, "SKILLS_TIMEOUT_MS", 10_000, 1_000, 60_000),
  };
}

function intFromEnv(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}
