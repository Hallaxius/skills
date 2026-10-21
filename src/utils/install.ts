/**
 * GitHub sources on skills.sh are `owner/repo` pairs with a dot-less owner;
 * well-known sources are single-segment domains (e.g. `uizze.sh`).
 */
export const GITHUB_SOURCE = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

/**
 * Derives the canonical `npx skills add` command for GitHub-hosted skills.
 * Pattern confirmed on real skill pages, e.g.:
 * `npx skills add https://github.com/anthropics/skills --skill frontend-design`
 */
export function githubInstallCommand(source: string, skillId: string): string | undefined {
  if (!GITHUB_SOURCE.test(source)) return undefined;
  return `npx skills add https://github.com/${source} --skill ${skillId}`;
}

const COMMIT_SHA = /^[a-f0-9]{40}$/;

/**
 * Pins a GitHub source to an exact commit in the `#ref` fragment, keeping the
 * `@skill` filter used by the CLI. Abbreviated or non-hex SHAs are refused:
 * the CLI only accepts a full 40-character commit.
 */
export function pinnedInstallCommand(
  source: string,
  skillId: string,
  commitSha: string,
): string | undefined {
  if (!GITHUB_SOURCE.test(source) || !COMMIT_SHA.test(commitSha)) return undefined;
  return `npx skills add ${source}#${commitSha}@${skillId}`;
}
