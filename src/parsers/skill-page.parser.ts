import { SkillsError } from "../errors";
import type { RelatedSkill } from "../types/domain";
import { asNumber, asString, isRecord } from "../utils/records";

export interface ParsedSkillPage {
  readonly name: string;
  readonly description: string;
  /** Publisher name from JSON-LD (owner or domain). */
  readonly owner: string;
  readonly installs: number;
  readonly installCommand: string | null;
  readonly topics: readonly string[];
  readonly related: readonly RelatedSkill[];
}

// All patterns below were verified against real pages (2026-09).
const LD_JSON_RE = /<script type="application\/ld\+json">(.*?)<\/script>/gs;
const INSTALL_COMMAND_RE = /\bnpx skills add [^\s<"']+(?: --skill [^\s<"']+)?/;
// Topic chips rendered under the h1 (rounded-full pill links) — NOT the footer topic list.
const TOPIC_CHIP_RE = /<a class="inline-flex items-center px-2\.5 py-1 rounded-full[^"]*" href="\/topic\/([a-z0-9-]+)"/g;
// "More in <Topic>" heading inside the related-skills section.
const MORE_IN_TOPIC_RE = /More in(?:<!-- -->|\s)*<a[^>]+href="\/topic\/([a-z0-9-]+)"/g;
// Related-skill list items: anchor containing an <h3> (name) and <p> (description).
const RELATED_RE =
  /<a[^>]*href="\/((?:[A-Za-z0-9._-]+\/){2}[A-Za-z0-9._-]+)"[^>]*>(?:(?!<\/a>)[\s\S])*?<h3[^>]*>([^<]+)<\/h3>(?:(?!<\/a>)[\s\S])*?<p[^>]*>([^<]*)<\/p>/g;

const MAX_TOPICS = 20;
const MAX_RELATED = 20;

/**
 * Parses a skill page (`/{owner}/{repo}/{skill}` or `/site/{domain}/{skill}`).
 * Primary source: the page's JSON-LD SoftwareApplication block (full, untruncated
 * description + install count). Install command, topic chips and related skills
 * come from the rendered HTML.
 */
export function parseSkillPage(html: string): ParsedSkillPage {
  const jsonLd = findSoftwareApplication(html);
  if (!jsonLd) {
    throw new SkillsError("UPSTREAM_CHANGED", "skill page is missing its JSON-LD SoftwareApplication metadata");
  }
  const name = asString(jsonLd["name"]);
  const description = asString(jsonLd["description"]);
  if (!name || !description) {
    throw new SkillsError("UPSTREAM_CHANGED", "skill page JSON-LD lacks name/description");
  }
  const publisher = isRecord(jsonLd["publisher"]) ? (asString(jsonLd["publisher"]["name"]) ?? "") : "";
  const installs = isRecord(jsonLd["interactionStatistic"])
    ? (asNumber(jsonLd["interactionStatistic"]["userInteractionCount"]) ?? 0)
    : 0;

  return {
    name,
    description,
    owner: publisher,
    installs,
    installCommand: findInstallCommand(html),
    topics: findTopics(html),
    related: findRelatedSkills(html),
  };
}

function findSoftwareApplication(html: string): Record<string, unknown> | undefined {
  for (const match of html.matchAll(LD_JSON_RE)) {
    const raw = match[1];
    if (raw === undefined) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      continue;
    }
    if (isRecord(parsed) && parsed["@type"] === "SoftwareApplication") return parsed;
  }
  return undefined;
}

function findInstallCommand(html: string): string | null {
  const match = INSTALL_COMMAND_RE.exec(html);
  if (!match) return null;
  // The command also appears (escaped) in the RSC payload; strip stray escapes.
  return match[0].replace(/[\\'"]+$/u, "").trim();
}

function findTopics(html: string): readonly string[] {
  const topics: string[] = [];
  const seen = new Set<string>();
  const push = (slug: string): void => {
    if (seen.has(slug) || topics.length >= MAX_TOPICS) return;
    seen.add(slug);
    topics.push(slug);
  };
  for (const match of html.matchAll(TOPIC_CHIP_RE)) {
    const slug = match[1];
    if (slug) push(slug);
  }
  for (const match of html.matchAll(MORE_IN_TOPIC_RE)) {
    const slug = match[1];
    if (slug) push(slug);
  }
  return topics;
}

function findRelatedSkills(html: string): readonly RelatedSkill[] {
  const related: RelatedSkill[] = [];
  const seen = new Set<string>();
  for (const match of html.matchAll(RELATED_RE)) {
    const path = match[1];
    const name = match[2];
    const description = match[3];
    if (path === undefined || name === undefined || description === undefined) continue;
    // `/site/{domain}/{skill}` links carry the well-known id as `{domain}/{skill}`.
    const segments = path.split("/");
    let id = path;
    if (segments[0] === "site" && segments.length === 3) {
      id = `${segments[1] ?? ""}/${segments[2] ?? ""}`;
    }
    if (seen.has(id) || related.length >= MAX_RELATED) continue;
    seen.add(id);
    related.push({
      id,
      name: decodeEntities(name.trim()),
      description: decodeEntities(description.trim()),
    });
  }
  return related;
}

function decodeEntities(text: string): string {
  return text
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#x27;", "'")
    .replaceAll("&#39;", "'")
    .replaceAll("&nbsp;", " ");
}
