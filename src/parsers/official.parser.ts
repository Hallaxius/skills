import { SkillsError } from "../errors";
import type { CuratedOwner, CuratedRepo, CuratedSkill } from "../types/domain";
import { asNumber, asString, isRecord } from "../utils/records";
import { extractJsonValue, extractRscPayload } from "./rsc";

/**
 * Parses the /official (curated skills) page. The RSC payload embeds the same
 * dataset as the documented /api/v1/skills/curated endpoint:
 * `{"data":{"owners":[{owner, repos:[{repo, totalInstalls, skills}], …}]}}`.
 */
export function parseOfficial(html: string): readonly CuratedOwner[] {
  const payload = extractRscPayload(html);
  const raw = extractJsonValue(payload, "owners");
  if (!Array.isArray(raw)) {
    throw new SkillsError("UPSTREAM_CHANGED", "could not find curated owners data in the /official page payload");
  }
  const owners: CuratedOwner[] = [];
  for (const item of raw) {
    const owner = toCuratedOwner(item);
    if (owner) owners.push(owner);
  }
  if (owners.length === 0) {
    throw new SkillsError("UPSTREAM_CHANGED", "curated owners data in the /official page had no recognizable entries");
  }
  return owners;
}

function toCuratedOwner(item: unknown): CuratedOwner | undefined {
  if (!isRecord(item)) return undefined;
  const owner = asString(item["owner"]);
  if (!owner) return undefined;

  const repos: CuratedRepo[] = [];
  let computedTotal = 0;
  if (Array.isArray(item["repos"])) {
    for (const repoItem of item["repos"]) {
      const repo = toCuratedRepo(repoItem);
      if (repo) {
        repos.push(repo);
        computedTotal += repo.totalInstalls;
      }
    }
  }
  return {
    owner,
    totalInstalls: asNumber(item["totalInstalls"]) ?? computedTotal,
    featuredRepo: asString(item["featuredRepo"]) ?? repos[0]?.repo ?? "",
    featuredSkill: asString(item["featuredSkill"]) ?? "",
    repos,
  };
}

function toCuratedRepo(item: unknown): CuratedRepo | undefined {
  if (!isRecord(item)) return undefined;
  const repo = asString(item["repo"]);
  if (!repo) return undefined;

  const skills: CuratedSkill[] = [];
  if (Array.isArray(item["skills"])) {
    for (const skillItem of item["skills"]) {
      if (!isRecord(skillItem)) continue;
      const name = asString(skillItem["name"]);
      if (name) skills.push({ name, installs: asNumber(skillItem["installs"]) ?? 0 });
    }
  }
  const totalInstalls =
    asNumber(item["totalInstalls"]) ?? skills.reduce((sum, skill) => sum + skill.installs, 0);
  return { repo, totalInstalls, skills };
}
