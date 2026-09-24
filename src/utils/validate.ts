/**
 * Skill-id validation. Ids are `{source}/{slug}`:
 *  - GitHub:   `{owner}/{repo}/{skill}`   e.g. `vercel-labs/skills/find-skills`
 *  - Well-known: `{domain}/{skill}`        e.g. `uizze.sh/ui-taste` (page: /site/{domain}/{skill})
 *
 * No user-supplied URLs are ever accepted — request URLs are assembled only
 * from these validated segments, which keeps every outbound request on
 * skills.sh (no SSRF surface).
 */

export interface SkillIdParts {
  /** `owner/repo` or the domain. */
  readonly source: string;
  readonly slug: string;
  /** Path of the skill page relative to the site root. */
  readonly pagePath: string;
}

const MAX_ID_LENGTH = 200;
// 2–100 chars, starts/ends alphanumeric, middle may contain . _ -, no "..".
const SEGMENT_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98})[A-Za-z0-9]$/;

export function parseSkillId(input: string): SkillIdParts | undefined {
  const trimmed = input.trim().replace(/^\/+|\/+$/g, "");
  if (trimmed.length === 0 || trimmed.length > MAX_ID_LENGTH) return undefined;
  const segments = trimmed.split("/");

  const [seg0 = "", seg1 = "", seg2 = ""] = segments;
  if (segments.length === 3) {
    // GitHub-style: owner/repo/skill (owners never contain dots).
    if (validSegment(seg0) && !seg0.includes(".") && validSegment(seg1) && validSegment(seg2)) {
      return { source: `${seg0}/${seg1}`, slug: seg2, pagePath: `/${seg0}/${seg1}/${seg2}` };
    }
  }
  if (segments.length === 2) {
    // Well-known: domain/skill (domains contain a dot).
    if (validSegment(seg0) && seg0.includes(".") && validSegment(seg1)) {
      return { source: seg0, slug: seg1, pagePath: `/site/${seg0}/${seg1}` };
    }
  }
  return undefined;
}

function validSegment(segment: string): boolean {
  return SEGMENT_RE.test(segment) && !segment.includes("..");
}
