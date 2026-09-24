/**
 * API response fixtures. PUBLIC_SEARCH_BODY and AUDIT_BODY are REAL responses
 * captured live (2026-09, unauthenticated). V1_* bodies follow the documented
 * shapes from https://skills.sh/docs/api (synthetic values — the v1 API needs
 * a token and could not be probed).
 */

export const PUBLIC_SEARCH_BODY = JSON.stringify({
  query: "react",
  searchType: "fuzzy",
  searchVersion: "algolia",
  skills: [
    { id: "vercel-labs/json-render/react", source: "vercel-labs/json-render", skillId: "react", name: "react", installs: 11446 },
    { id: "lobehub/lobehub/react", source: "lobehub/lobehub", skillId: "react", name: "react", installs: 5516 },
    { id: "mindrally/skills/react", source: "mindrally/skills", skillId: "react", name: "react", installs: 886 },
  ],
  count: 3,
  duration_ms: 208,
  timings_ms: { rate_limit: 12.3, flags: 0.9, visibility: 6.0, retrieval: 198.5, algolia_processing: 135, search: 208, total: 220.3 },
  provider_duration_ms: 198.5,
});

export const AUDIT_BODY = JSON.stringify({
  id: "vercel-labs/skills/find-skills",
  source: "vercel-labs/skills",
  slug: "find-skills",
  audits: [
    {
      provider: "Gen Agent Trust Hub",
      slug: "agent-trust-hub",
      status: "pass",
      summary:
        "This skill facilitates the discovery and installation of agent extensions using a dedicated command-line interface. It includes guidance on verifying the reputation of external packages, which aligns with secure development practices for package management.",
      auditedAt: "2026-09-15T08:00:05.922Z",
      riskLevel: "SAFE",
      categories: ["COMMAND_EXECUTION", "EXTERNAL_DOWNLOADS", "INDIRECT_PROMPT_INJECTION"],
    },
    { provider: "Socket", slug: "socket", status: "pass", summary: "No alerts", auditedAt: "2026-09-15T08:00:19.647Z" },
    { provider: "Snyk", slug: "snyk", status: "warn", summary: "Risk: MEDIUM · 1 issue", auditedAt: "2026-09-15T07:59:46.904821+00:00", riskLevel: "MEDIUM" },
    { provider: "Runlayer", slug: "runlayer", status: "pass", summary: "1 file scanned · No issues", auditedAt: "2026-03-14T07:45:27.566Z", riskLevel: "NONE" },
    { provider: "ZeroLeaks", slug: "zeroleaks", status: "pass", summary: "Score: 93/100 · 2 sections analyzed", auditedAt: "2026-04-16T07:47:59.444Z", riskLevel: "NONE" },
  ],
});

export const V1_SEARCH_BODY = JSON.stringify({
  data: [
    {
      id: "vercel-labs/skills/find-skills",
      slug: "find-skills",
      name: "find-skills",
      source: "vercel-labs/skills",
      installs: 3_539_141,
      sourceType: "github",
      installUrl: "https://github.com/vercel-labs/skills",
      url: "https://skills.sh/vercel-labs/skills/find-skills",
    },
    {
      id: "uizze.sh/ui-taste",
      slug: "ui-taste",
      name: "ui-taste",
      source: "uizze.sh",
      installs: 12_034,
      sourceType: "well-known",
      installUrl: "https://uizze.sh",
      url: "https://skills.sh/site/uizze.sh/ui-taste",
      isDuplicate: true,
    },
  ],
  query: "taste",
  searchType: "semantic",
  count: 2,
  durationMs: 12,
});

export const V1_DETAIL_BODY = JSON.stringify({
  id: "vercel-labs/skills/find-skills",
  source: "vercel-labs/skills",
  slug: "find-skills",
  installs: 3_539_141,
  hash: "a1b2c3d4e5f6",
  files: [
    {
      path: "SKILL.md",
      contents: "---\nname: find-skills\ndescription: Find and install skills for your agent.\n---\n\nFind skills for your agent.",
    },
  ],
});

