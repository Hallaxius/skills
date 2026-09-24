/**
 * HTML fixtures built from REAL skills.sh markup captured 2026-09
 * (RSC chunk format, JSON-LD blocks, chip/related markup verified against
 * live pages).
 */

function nextf(...chunks: string[]): string {
  return chunks
    .map((chunk) => `<script>self.__next_f.push([1,${JSON.stringify(chunk)}])</script>\n`)
    .join("");
}

export const ALL_TIME_ENTRIES = [
  {
    source: "vercel-labs/skills",
    skillId: "find-skills",
    name: "find-skills",
    installs: 3_539_141,
    weeklyInstalls: [11, 12, 13, 14, 15, 16, 17, 18],
    isOfficial: true,
  },
  { source: "anthropics/skills", skillId: "frontend-design", name: "frontend-design", installs: 916_456 },
  { source: "uizze.sh", skillId: "ui-taste", name: "ui-taste", installs: 12_034 },
] as const;

export const TRENDING_ENTRIES = [
  { source: "vercel-labs/skills", skillId: "find-skills", name: "find-skills", installs: 3_539_141 },
  { source: "anthropics/skills", skillId: "frontend-design", name: "frontend-design", installs: 916_456 },
] as const;

export const HOT_ENTRIES = [
  {
    source: "vercel-labs/skills",
    skillId: "find-skills",
    name: "find-skills",
    installs: 3_539_141,
    installsYesterday: 4211,
    change: 12,
  },
  {
    source: "lobehub/lobehub",
    skillId: "react",
    name: "react",
    installs: 5516,
    installsYesterday: 310,
    change: -4,
  },
] as const;

/** Leaderboard page whose RSC payload is deliberately split across two chunks. */
export function leaderboardPage(entries: readonly unknown[]): string {
  const payload = JSON.stringify([["$", "$L57", null, { initialSkills: entries }]]);
  const mid = Math.floor(payload.length / 2);
  return [
    "<!DOCTYPE html><html><head><title>The Agent Skills Directory</title></head><body>",
    "<script>self.__next_f=[0]</script>",
    nextf("1:decoy-chunk-without-json", payload.slice(0, mid)),
    nextf(payload.slice(mid)),
    "</body></html>",
  ].join("\n");
}

export const LEADERBOARD_PAGE_NO_DATA = `<!DOCTYPE html><html><head><title>Skills</title></head><body>${nextf("1:no payload here")}</body></html>`;

/** Skill page for anthropics/skills/frontend-design (real markup structure). */
export const SKILL_PAGE_HTML = `<!DOCTYPE html>
<html><head><title>frontend-design — anthropics/skills</title>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"BreadcrumbList","itemListElement":[{"@type":"ListItem","position":1,"name":"Skills","item":"https://www.skills.sh/"}]}</script>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"WebSite","name":"Skills","alternateName":"The Agent Skills Directory","url":"https://www.skills.sh"}</script>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"SoftwareApplication","name":"frontend-design","description":"Guidance for distinctive, intentional visual design when building new UI or reshaping an existing one. Helps with aesthetic direction, typography, and making choices that do not read as templated defaults.","url":"https://www.skills.sh/anthropics/skills/frontend-design","applicationCategory":"DeveloperApplication","operatingSystem":"Cross-platform","publisher":{"@type":"Organization","name":"anthropics","url":"https://www.skills.sh/anthropics"},"interactionStatistic":{"@type":"InteractionCounter","interactionType":"https://schema.org/InstallAction","userInteractionCount":916456}}</script>
</head><body><main><h1 class="text-3xl font-bold">frontend-design</h1>
<div class="flex flex-wrap gap-2 mb-4"><a class="inline-flex items-center px-2.5 py-1 rounded-full border border-border text-xs text-(--ds-gray-700) hover:bg-(--ds-gray-100)/30 hover:text-foreground transition-colors" href="/topic/design">Design &amp; UI</a></div>
<div class="grid grid-cols-1 lg:grid-cols-12 gap-16"><div class="lg:col-span-8"><pre><code>npx skills add https://github.com/anthropics/skills --skill frontend-design</code></pre></div></div>
<div><div class="flex items-center gap-2 text-sm font-mono uppercase">Related skills</div>
<div class="mb-6"><h2 class="text-xs font-mono uppercase mb-3">More in<!-- --> <a class="hover:text-foreground underline" href="/topic/design">Design &amp; UI</a></h2>
<ul class="divide-y divide-border">
<li><a class="grid grid-cols-1 py-3" href="/vercel-labs/agent-skills/web-design-guidelines"><div class="min-w-0"><h3 class="font-mono text-sm truncate">web-design-guidelines</h3><p class="text-xs mt-0.5 line-clamp-2">Vercel&#x27;s Web Interface Guidelines covering spacing, typography, interaction, and accessibility</p></div><div class="text-right text-xs shrink-0">vercel-labs<!-- -->/<!-- -->agent-skills</div></a></li>
<li><a class="grid grid-cols-1 py-3" href="/site/smithery.ai/mcp-server"><div class="min-w-0"><h3 class="font-mono text-sm truncate">mcp-server</h3><p class="text-xs mt-0.5 line-clamp-2">Build, deploy and inspect MCP servers with Smithery</p></div><div class="text-right text-xs shrink-0">smithery.ai</div></a></li>
</ul></div></div>
</main>
<footer><h3>Topics</h3><ul><li><a href="/topic/react">React</a></li><li><a href="/topic/nextjs">Next.js</a></li><li><a href="/topic/design">Design</a></li><li><a href="/topic/mobile">Mobile</a></li><li><a href="/topic/agent-workflows">Agent workflows</a></li><li><a href="/topic/databases">Databases</a></li><li><a href="/topic/testing">Testing</a></li><li><a href="/topic/marketing">Marketing</a></li></ul></footer>
${nextf("9:static-footer")}
</body></html>`;

export const SKILL_PAGE_NO_JSONLD_HTML = `<!DOCTYPE html><html><head><title>Some skill</title></head><body><main><h1>some-skill</h1>${nextf("3:minimal")}</main></body></html>`;

const OFFICIAL_OWNERS = {
  data: {
    owners: [
      {
        owner: "aave",
        repos: [
          {
            repo: "aave/skills",
            totalInstalls: 10,
            skills: [
              { name: "deleverage", installs: 2 },
              { name: "aave-agent", installs: 8 },
            ],
          },
        ],
        totalInstalls: 10,
        featuredRepo: "aave/skills",
        featuredSkill: "deleverage",
      },
      {
        owner: "vercel-labs",
        repos: [
          {
            repo: "vercel-labs/agent-skills",
            totalInstalls: 53_210,
            skills: [{ name: "vercel-react-best-practices", installs: 40_000 }],
          },
        ],
        totalInstalls: 53_210,
        featuredRepo: "vercel-labs/agent-skills",
        featuredSkill: "vercel-react-best-practices",
      },
    ],
  },
};

export const OFFICIAL_PAGE_HTML = `<!DOCTYPE html><html><head><title>Official skills</title></head><body><div id="root"></div>${nextf(JSON.stringify(OFFICIAL_OWNERS))}</body></html>`;

export const OFFICIAL_PAGE_NO_DATA = `<!DOCTYPE html><html><body>${nextf("5:no owners")}</body></html>`;
