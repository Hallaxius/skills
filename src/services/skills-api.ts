import { TtlCache } from "../cache/ttl-cache";
import type { Config } from "../config";
import { SkillsError } from "../errors";
import { parseLeaderboard } from "../parsers/leaderboard.parser";
import { parseOfficial } from "../parsers/official.parser";
import { parseSkillPage } from "../parsers/skill-page.parser";
import type {
  CuratedOwner,
  LeaderboardEntry,
  LeaderboardView,
  SkillAudits,
  SkillDetail,
  SkillFile,
  SearchResult,
} from "../types/domain";
import { type RequestOptions, HttpClient } from "../utils/http";
import { githubInstallCommand } from "../utils/install";
import { logger } from "../utils/logger";
import { parseSkillId, type SkillIdParts } from "../utils/validate";
import { toPublicSearch, toV1Audits, toV1Detail, toV1Search } from "./mappers";

// Cache TTLs follow the upstream Cache-Control policy documented at
// https://skills.sh/docs/api (search 30-60s; detail and curated 5min).
const TTL_SEARCH_MS = 30_000;
const TTL_LEADERBOARD_MS = 60_000;
const TTL_DETAIL_MS = 300_000;
const TTL_OFFICIAL_MS = 300_000;

const LEADERBOARD_PAGES: Record<LeaderboardView, string> = {
  "all-time": "/",
  trending: "/trending",
  hot: "/hot",
};

/** Skill files bundle fetched from the documented v1 API (token required). */
export interface SkillFiles {
  readonly hash: string | null;
  readonly files: readonly SkillFile[] | null;
}

export interface TopSkillsSlice {
  readonly skills: readonly LeaderboardEntry[];
  readonly totalAvailable: number;
}

/**
 * Central client for skills.sh. Every upstream request goes through the
 * shared HttpClient (rate-limited, retried, cached). Data-source strategy:
 *  - search: public /api/search (the endpoint the official CLI uses), or the
 *    documented /api/v1/skills/search when a token is configured;
 *  - leaderboards + official list + skill pages: robots-allowed HTML pages,
 *    parsed from their embedded RSC/JSON-LD data (same datasets as the API);
 *  - audits: /api/v1/skills/audit/{id} (works unauthenticated);
 *  - skill files: /api/v1/skills/{id} (documented v1 API; token required).
 */
export class SkillsApiService {
  private readonly searchCache = new TtlCache<readonly SearchResult[]>(200);
  private readonly leaderboardCache = new TtlCache<readonly LeaderboardEntry[]>(10);
  private readonly detailCache = new TtlCache<SkillDetail>(200);
  private readonly filesCache = new TtlCache<SkillFiles | null>(200);
  private readonly auditsCache = new TtlCache<SkillAudits>(200);
  private readonly officialCache = new TtlCache<readonly CuratedOwner[]>(10);

  constructor(
    private readonly http: HttpClient,
    private readonly config: Config,
  ) {}

  async searchSkills(query: string, limit: number, owner?: string): Promise<readonly SearchResult[]> {
    const mode = this.config.token ? "v1" : "public";
    const key = `search:${mode}:${query.toLowerCase()}:${limit}:${owner ?? ""}`;
    const cached = this.searchCache.get(key);
    if (cached) {
      logger.info(`cache hit: ${key}`);
      return cached;
    }
    const results =
      mode === "v1"
        ? await this.searchV1(query, limit, owner)
        : await this.searchPublic(query, limit, owner);
    this.searchCache.set(key, results, TTL_SEARCH_MS);
    return results;
  }

  async getTopSkills(view: LeaderboardView, limit: number, offset: number): Promise<TopSkillsSlice> {
    const key = `top:${view}`;
    let entries = this.leaderboardCache.get(key);
    if (!entries) {
      const page = LEADERBOARD_PAGES[view];
      const html = await this.requestText(
        `${this.config.pageBaseUrl}${page}`,
        `leaderboard "${view}"`,
      );
      entries = parseLeaderboard(html, view);
      this.leaderboardCache.set(key, entries, TTL_LEADERBOARD_MS);
    }
    return { skills: entries.slice(offset, offset + limit), totalAvailable: entries.length };
  }

  async getSkill(id: string, includeFiles: boolean): Promise<SkillDetail> {
    const parts = this.parseIdOrThrow(id);
    const key = `skill:${parts.source}/${parts.slug}`;
    let detail = this.detailCache.get(key);
    if (!detail) {
      const url = `${this.config.pageBaseUrl}${parts.pagePath}`;
      const html = await this.requestText(url, `skill "${id}"`);
      const parsed = parseSkillPage(html);
      detail = {
        id: `${parts.source}/${parts.slug}`,
        source: parts.source,
        slug: parts.slug,
        name: parsed.name,
        description: parsed.description,
        owner: parsed.owner,
        installs: parsed.installs,
        url,
        installCommand: parsed.installCommand ?? githubInstallCommand(parts.source, parts.slug) ?? null,
        topics: parsed.topics,
        related: parsed.related,
      };
      this.detailCache.set(key, detail, TTL_DETAIL_MS);
    }
    if (!includeFiles) return detail;
    if (!this.config.token) {
      throw new SkillsError(
        "INVALID_INPUT",
        "include_files requires the documented v1 API — set VERCEL_OIDC_TOKEN (see README). Skill metadata above is available without a token.",
      );
    }
    const files = await this.fetchSkillFiles(id, parts);
    return {
      ...detail,
      files: files.files,
      hash: files.hash,
      filesNote:
        files.files === null
          ? "the v1 API reports no published file bundle for this skill"
          : undefined,
    };
  }

  async getSkillAudits(id: string): Promise<SkillAudits> {
    const parts = this.parseIdOrThrow(id);
    const key = `audits:${parts.source}/${parts.slug}`;
    const cached = this.auditsCache.get(key);
    if (cached) return cached;
    const url = `${this.config.apiBaseUrl}/api/v1/skills/audit/${parts.source}/${parts.slug}`;
    try {
      const audits = await this.requestJson(url, {}, toV1Audits, `audits for "${id}"`);
      this.auditsCache.set(key, audits, TTL_DETAIL_MS);
      return audits;
    } catch (error) {
      if (error instanceof SkillsError && error.code === "NOT_FOUND") {
        throw new SkillsError(
          "NOT_FOUND",
          `no security audits recorded for "${id}" yet — audits are generated automatically after a skill's first install`,
        );
      }
      throw error;
    }
  }

  async getOfficialSkills(limit: number): Promise<readonly CuratedOwner[]> {
    const key = "official";
    let owners = this.officialCache.get(key);
    if (!owners) {
      const html = await this.requestText(`${this.config.pageBaseUrl}/official`, "official/curated list");
      owners = parseOfficial(html);
      this.officialCache.set(key, owners, TTL_OFFICIAL_MS);
    }
    return owners.slice(0, limit);
  }

  private async searchPublic(query: string, limit: number, owner?: string): Promise<readonly SearchResult[]> {
    const url = this.buildUrl("/api/search", {
      q: query,
      limit: String(limit),
      ...(owner ? { owner } : {}),
    });
    return this.requestJson(url, {}, toPublicSearch, "skill search");
  }

  private async searchV1(query: string, limit: number, owner?: string): Promise<readonly SearchResult[]> {
    const url = this.buildUrl("/api/v1/skills/search", {
      q: query,
      limit: String(limit),
      ...(owner ? { owner } : {}),
    });
    try {
      return await this.requestJson(url, { headers: this.authHeaders() }, toV1Search, "skill search");
    } catch (error) {
      // Tokens expire (~12h); degrade gracefully to the public endpoint.
      if (
        error instanceof SkillsError &&
        error.code === "UPSTREAM_ERROR" &&
        error.message.includes("authentication failed")
      ) {
        logger.warn("v1 search rejected the token; falling back to public /api/search");
        return this.searchPublic(query, limit, owner);
      }
      throw error;
    }
  }

  private async fetchSkillFiles(id: string, parts: SkillIdParts): Promise<SkillFiles> {
    const key = `skill-files:${parts.source}/${parts.slug}`;
    const cached = this.filesCache.get(key);
    if (cached) return cached;
    const url = `${this.config.apiBaseUrl}/api/v1/skills/${parts.source}/${parts.slug}`;
    let files: SkillFiles | null;
    try {
      files = await this.requestJson(url, { headers: this.authHeaders() }, toV1Detail, `files for "${id}"`);
    } catch (error) {
      if (error instanceof SkillsError && error.code === "NOT_FOUND") {
        files = { hash: null, files: null };
      } else {
        throw error;
      }
    }
    this.filesCache.set(key, files, TTL_DETAIL_MS);
    return files;
  }

  private parseIdOrThrow(id: string): SkillIdParts {
    const parts = parseSkillId(id);
    if (!parts) {
      throw new SkillsError(
        "INVALID_INPUT",
        `invalid skill id "${id}" — expected "{owner}/{repo}/{skill}" (e.g. vercel-labs/skills/find-skills) or "{domain}/{skill}" for well-known skills (e.g. uizze.sh/ui-taste)`,
      );
    }
    return parts;
  }

  private authHeaders(): Record<string, string> | undefined {
    return this.config.token ? { Authorization: `Bearer ${this.config.token}` } : undefined;
  }

  private buildUrl(path: string, params: Record<string, string>): string {
    const url = new URL(`${this.config.apiBaseUrl}${path}`);
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
    return url.toString();
  }

  private async requestJson<T>(
    url: string,
    opts: RequestOptions,
    map: (body: unknown) => T | undefined,
    context: string,
  ): Promise<T> {
    const response = await this.http.get(url, { accept: "application/json", ...opts });
    if (response.status === 404) throw new SkillsError("NOT_FOUND", `${context}: not found`);
    if (response.status === 400) {
      throw new SkillsError("INVALID_INPUT", `${context}: ${await upstreamErrorMessage(response)}`);
    }
    if (response.status === 401 || response.status === 403) {
      throw new SkillsError(
        "UPSTREAM_ERROR",
        `${context}: authentication failed (HTTP ${response.status}) — check VERCEL_OIDC_TOKEN`,
      );
    }
    if (!response.ok) {
      throw new SkillsError("UPSTREAM_ERROR", `${context}: unexpected HTTP ${response.status}`);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new SkillsError("PARSE_ERROR", `${context}: response was not valid JSON`);
    }
    const mapped = map(body);
    if (mapped === undefined) {
      throw new SkillsError("UPSTREAM_CHANGED", `${context}: response shape was not recognized`);
    }
    return mapped;
  }

  private async requestText(url: string, context: string): Promise<string> {
    const response = await this.http.get(url, { accept: "text/html" });
    if (response.status === 404) throw new SkillsError("NOT_FOUND", `${context}: not found`);
    if (!response.ok) {
      throw new SkillsError("UPSTREAM_ERROR", `${context}: unexpected HTTP ${response.status}`);
    }
    return response.text();
  }
}

/** Best-effort extraction of an upstream error message from a JSON error body. */
async function upstreamErrorMessage(response: Response): Promise<string> {
  const raw = await response.text().catch(() => "");
  try {
    const body = JSON.parse(raw) as unknown;
    if (typeof body === "object" && body !== null) {
      const record = body as Record<string, unknown>;
      const message = record["message"];
      const error = record["error"];
      if (typeof message === "string" && message) return message;
      if (typeof error === "string" && error) return error;
    }
  } catch {
    // fall through to raw text
  }
  return raw.slice(0, 200) || "invalid request";
}
