/**
 * Domain types shared across the server.
 *
 * Identifiers: a skill on skills.sh is identified by `{source}/{slug}` where
 * `source` is either a GitHub `owner/repo` pair (e.g. `vercel-labs/skills`)
 * or a well-known domain (e.g. `uizze.sh`). Example ids:
 * `vercel-labs/skills/find-skills` and `uizze.sh/ui-taste`.
 */

/** Leaderboard views exposed by the site's homepage, /trending and /hot. */
export type LeaderboardView = "all-time" | "trending" | "hot";

export interface SearchResult {
  /** Canonical id: `{source}/{skillId}`. */
  readonly id: string;
  /** GitHub `owner/repo` or well-known domain. */
  readonly source: string;
  readonly skillId: string;
  readonly name: string;
  /** Deduplicated install count. */
  readonly installs: number;
  /** `npx skills add …` command (GitHub-hosted skills only, derived). */
  readonly installCommand?: string;
  /** v1-API-only extras (present when VERCEL_OIDC_TOKEN is configured). */
  readonly sourceType?: "github" | "well-known";
  readonly installUrl?: string;
  readonly url?: string;
  readonly isDuplicate?: boolean;
}

export interface LeaderboardEntry {
  readonly id: string;
  readonly source: string;
  readonly skillId: string;
  readonly name: string;
  readonly installs: number;
  readonly installCommand?: string;
  /** Homepage (all-time) view: last ~8 weekly install counts. */
  readonly weeklyInstalls?: readonly number[];
  readonly isOfficial?: boolean;
  /** /hot view extras. */
  readonly installsYesterday?: number;
  readonly change?: number;
}

export interface RelatedSkill {
  readonly id: string;
  readonly name: string;
  readonly description: string;
}

export interface SkillFile {
  readonly path: string;
  readonly contents: string;
}

export interface SkillDetail {
  readonly id: string;
  readonly source: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  /** Publisher (owner or domain) from the page's JSON-LD. */
  readonly owner: string;
  readonly installs: number;
  readonly url: string;
  readonly installCommand: string | null;
  readonly topics: readonly string[];
  readonly related: readonly RelatedSkill[];
  /** Present when include_files was requested and a token is configured. */
  readonly files?: readonly SkillFile[] | null;
  readonly hash?: string | null;
  readonly filesNote?: string;
}

export interface SkillAudit {
  readonly provider: string;
  readonly slug: string;
  readonly status: "pass" | "warn" | "fail";
  readonly summary: string;
  readonly auditedAt: string;
  /** Raw upstream risk label — observed values include NONE, LOW, SAFE, MEDIUM, HIGH, CRITICAL. */
  readonly riskLevel?: string;
  readonly categories?: readonly string[];
}

export interface SkillAudits {
  readonly id: string;
  readonly source: string;
  readonly slug: string;
  readonly audits: readonly SkillAudit[];
}

export interface CuratedSkill {
  readonly name: string;
  readonly installs: number;
}

export interface CuratedRepo {
  readonly repo: string;
  readonly totalInstalls: number;
  readonly skills: readonly CuratedSkill[];
}

export interface CuratedOwner {
  readonly owner: string;
  readonly totalInstalls: number;
  readonly featuredRepo: string;
  readonly featuredSkill: string;
  readonly repos: readonly CuratedRepo[];
}
