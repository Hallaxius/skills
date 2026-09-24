import type { SkillAudits, SkillFile, SearchResult } from "../types/domain";
import { githubInstallCommand } from "../utils/install";
import { asNumber, asString, asStringArray, isRecord } from "../utils/records";

/**
 * Shape validation for raw skills.sh API responses. Each mapper returns
 * undefined when the payload does not match the expected contract, which the
 * service surfaces as UPSTREAM_CHANGED.
 */

/** GET /api/search (public). */
export function toPublicSearch(body: unknown): readonly SearchResult[] | undefined {
  if (!isRecord(body) || !Array.isArray(body["skills"])) return undefined;
  const results: SearchResult[] = [];
  for (const item of body["skills"]) {
    if (!isRecord(item)) continue;
    const source = asString(item["source"]);
    const skillId = asString(item["skillId"]);
    const name = asString(item["name"]);
    if (!source || !skillId || !name) continue;
    results.push({
      id: asString(item["id"]) ?? `${source}/${skillId}`,
      source,
      skillId,
      name,
      installs: asNumber(item["installs"]) ?? 0,
      installCommand: githubInstallCommand(source, skillId),
    });
  }
  return results;
}

/** GET /api/v1/skills/search (documented v1 API; needs token). */
export function toV1Search(body: unknown): readonly SearchResult[] | undefined {
  if (!isRecord(body) || !Array.isArray(body["data"])) return undefined;
  const results: SearchResult[] = [];
  for (const item of body["data"]) {
    if (!isRecord(item)) continue;
    const id = asString(item["id"]);
    const slug = asString(item["slug"]);
    const name = asString(item["name"]);
    const source = asString(item["source"]);
    if (!id || !slug || !name || !source) continue;
    const sourceType = item["sourceType"] === "well-known" ? "well-known" : "github";
    const installUrl = asString(item["installUrl"]);
    const installCommand =
      sourceType === "github" && installUrl
        ? `npx skills add ${installUrl} --skill ${slug}`
        : installUrl
          ? `npx skills add ${installUrl}`
          : undefined;
    results.push({
      id,
      source,
      skillId: slug,
      name,
      installs: asNumber(item["installs"]) ?? 0,
      installCommand,
      sourceType,
      installUrl,
      url: asString(item["url"]),
      isDuplicate: item["isDuplicate"] === true ? true : undefined,
    });
  }
  return results;
}

/** GET /api/v1/skills/{id} (documented v1 API; needs token). */
export function toV1Detail(
  body: unknown,
): { id: string; hash: string | null; files: readonly SkillFile[] | null } | undefined {
  if (!isRecord(body)) return undefined;
  const id = asString(body["id"]);
  const source = asString(body["source"]);
  const slug = asString(body["slug"]);
  if (!id || !source || !slug) return undefined;
  const hash = typeof body["hash"] === "string" ? body["hash"] : null;
  const rawFiles = body["files"];
  let files: readonly SkillFile[] | null = null;
  if (Array.isArray(rawFiles)) {
    files = rawFiles
      .map((file) => {
        if (!isRecord(file)) return undefined;
        const path = asString(file["path"]);
        const contents = typeof file["contents"] === "string" ? file["contents"] : undefined;
        return path && contents !== undefined ? { path, contents } : undefined;
      })
      .filter((file): file is SkillFile => file !== undefined);
  }
  return { id, hash, files };
}

/** GET /api/v1/skills/audit/{id} (works unauthenticated). */
export function toV1Audits(body: unknown): SkillAudits | undefined {
  if (!isRecord(body)) return undefined;
  const id = asString(body["id"]);
  const source = asString(body["source"]);
  const slug = asString(body["slug"]);
  const rawAudits = body["audits"];
  if (!id || !source || !slug || !Array.isArray(rawAudits)) return undefined;

  const audits: SkillAudits["audits"][number][] = [];
  for (const item of rawAudits) {
    if (!isRecord(item)) continue;
    const provider = asString(item["provider"]);
    const auditSlug = asString(item["slug"]);
    const status = item["status"];
    const summary = asString(item["summary"]);
    const auditedAt = asString(item["auditedAt"]);
    if (!provider || !auditSlug || !summary || !auditedAt) continue;
    if (status !== "pass" && status !== "warn" && status !== "fail") continue;
    audits.push({
      provider,
      slug: auditSlug,
      status,
      summary,
      auditedAt,
      riskLevel: asString(item["riskLevel"]),
      categories: asStringArray(item["categories"]),
    });
  }
  return { id, source, slug, audits };
}
