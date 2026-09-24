import { SkillsError } from "../errors";
import type { LeaderboardEntry, LeaderboardView } from "../types/domain";
import { githubInstallCommand } from "../utils/install";
import { asBoolean, asNumber, asNumberArray, asString, isRecord } from "../utils/records";
import { extractJsonValue, extractRscPayload } from "./rsc";

/**
 * Parses a leaderboard page (/, /trending or /hot). The page embeds the
 * initial leaderboard rows (300 entries) in its RSC payload under the
 * `initialSkills` key of the SkillsLeaderboardBySource component.
 */
export function parseLeaderboard(html: string, view: LeaderboardView): readonly LeaderboardEntry[] {
  const payload = extractRscPayload(html);
  const raw = extractJsonValue(payload, "initialSkills");
  if (!Array.isArray(raw)) {
    throw new SkillsError(
      "UPSTREAM_CHANGED",
      `could not find leaderboard data (initialSkills) in the "${view}" page payload`,
    );
  }
  const entries: LeaderboardEntry[] = [];
  for (const item of raw) {
    const entry = toLeaderboardEntry(item);
    if (entry) entries.push(entry);
  }
  if (entries.length === 0) {
    throw new SkillsError("UPSTREAM_CHANGED", `"${view}" page payload had no recognizable leaderboard entries`);
  }
  return entries;
}

function toLeaderboardEntry(item: unknown): LeaderboardEntry | undefined {
  if (!isRecord(item)) return undefined;
  const source = asString(item["source"]);
  const skillId = asString(item["skillId"]);
  const name = asString(item["name"]);
  const installs = asNumber(item["installs"]);
  if (!source || !skillId || !name || installs === undefined) return undefined;

  const weeklyInstalls = asNumberArray(item["weeklyInstalls"]);
  const isOfficial = asBoolean(item["isOfficial"]);
  const installsYesterday = asNumber(item["installsYesterday"]);
  const change = asNumber(item["change"]);
  return {
    id: `${source}/${skillId}`,
    source,
    skillId,
    name,
    installs,
    installCommand: githubInstallCommand(source, skillId),
    ...(weeklyInstalls ? { weeklyInstalls } : {}),
    ...(isOfficial !== undefined ? { isOfficial } : {}),
    ...(installsYesterday !== undefined ? { installsYesterday } : {}),
    ...(change !== undefined ? { change } : {}),
  };
}
