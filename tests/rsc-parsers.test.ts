import { describe, expect, it } from "bun:test";
import { SkillsError } from "../src/errors";
import { extractJsonValue, extractRscPayload } from "../src/parsers/rsc";
import { parseLeaderboard } from "../src/parsers/leaderboard.parser";
import { parseSkillPage } from "../src/parsers/skill-page.parser";
import { parseOfficial } from "../src/parsers/official.parser";
import {
  ALL_TIME_ENTRIES,
  HOT_ENTRIES,
  LEADERBOARD_PAGE_NO_DATA,
  OFFICIAL_PAGE_HTML,
  OFFICIAL_PAGE_NO_DATA,
  SKILL_PAGE_HTML,
  SKILL_PAGE_NO_JSONLD_HTML,
  TRENDING_ENTRIES,
  leaderboardPage,
} from "./fixtures/pages";

describe("extractRscPayload", () => {
  it("joins chunks in order and unescapes JSON strings", () => {
    const SAY = 'he said "hi" ';
    const html = [
      `<script>self.__next_f.push([1,${JSON.stringify(SAY)}])</script>`,
      `<script>self.__next_f.push([1,${JSON.stringify("world")}])</script>`,
    ].join("");
    expect(extractRscPayload(html)).toBe('he said "hi" world');
  });

  it("skips malformed chunks", () => {
    const html = `<script>self.__next_f.push([1,"\\u0041ok"])</script><script>self.__next_f.push([1,"\\qbad"])</script>`;
    // The "\\q" escape is invalid JSON — the chunk is dropped, not fatal.
    expect(extractRscPayload(html)).toBe("Aok");
  });
});

describe("extractJsonValue", () => {
  const payload = 'pre{"initialSkills":[{"a":"x]y","b":[1,2,{"c":"}"}]}]}post';

  it("captures nested arrays/objects with tricky string content", () => {
    expect(extractJsonValue(payload, "initialSkills")).toEqual([{ a: "x]y", b: [1, 2, { c: "}" }] }]);
  });

  it("returns undefined for missing keys and non-container values", () => {
    expect(extractJsonValue(payload, "nope")).toBeUndefined();
    expect(extractJsonValue('{"plain":"string"}', "plain")).toBeUndefined();
    expect(extractJsonValue('{"broken":[1,2', "broken")).toBeUndefined();
  });
});

describe("parseLeaderboard", () => {
  it("parses the all-time view with weeklyInstalls, isOfficial and install commands", () => {
    const entries = parseLeaderboard(leaderboardPage(ALL_TIME_ENTRIES), "all-time");
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({
      id: "vercel-labs/skills/find-skills",
      source: "vercel-labs/skills",
      skillId: "find-skills",
      name: "find-skills",
      installs: 3_539_141,
      weeklyInstalls: [11, 12, 13, 14, 15, 16, 17, 18],
      isOfficial: true,
      installCommand: "npx skills add https://github.com/vercel-labs/skills --skill find-skills",
    });
    // Well-known domain sources get no derived GitHub install command.
    expect(entries[2]?.installCommand).toBeUndefined();
    expect(entries[2]?.id).toBe("uizze.sh/ui-taste");
  });

  it("parses the trending view (no optional fields)", () => {
    const entries = parseLeaderboard(leaderboardPage(TRENDING_ENTRIES), "trending");
    expect(entries).toHaveLength(2);
    expect(entries[0]?.weeklyInstalls).toBeUndefined();
    expect(entries[0]?.isOfficial).toBeUndefined();
  });

  it("parses the hot view with installsYesterday and change", () => {
    const entries = parseLeaderboard(leaderboardPage(HOT_ENTRIES), "hot");
    expect(entries[0]).toMatchObject({ installsYesterday: 4211, change: 12 });
    expect(entries[1]).toMatchObject({ installsYesterday: 310, change: -4 });
  });

  it("throws UPSTREAM_CHANGED when initialSkills is absent", () => {
    try {
      parseLeaderboard(LEADERBOARD_PAGE_NO_DATA, "trending");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(SkillsError);
      expect((error as SkillsError).code).toBe("UPSTREAM_CHANGED");
    }
  });
});

describe("parseSkillPage", () => {
  it("extracts metadata from JSON-LD, skipping decoy blocks", () => {
    const parsed = parseSkillPage(SKILL_PAGE_HTML);
    expect(parsed.name).toBe("frontend-design");
    expect(parsed.description).toContain("intentional visual design");
    expect(parsed.owner).toBe("anthropics");
    expect(parsed.installs).toBe(916_456);
  });

  it("extracts the install command from the rendered code block", () => {
    const parsed = parseSkillPage(SKILL_PAGE_HTML);
    expect(parsed.installCommand).toBe(
      "npx skills add https://github.com/anthropics/skills --skill frontend-design",
    );
  });

  it("extracts only the skill's own topic chips (never the footer topic list)", () => {
    const parsed = parseSkillPage(SKILL_PAGE_HTML);
    expect(parsed.topics).toEqual(["design"]);
  });

  it("extracts related skills, decoding entities and normalizing /site/ links", () => {
    const parsed = parseSkillPage(SKILL_PAGE_HTML);
    expect(parsed.related).toHaveLength(2);
    expect(parsed.related[0]).toEqual({
      id: "vercel-labs/agent-skills/web-design-guidelines",
      name: "web-design-guidelines",
      description: "Vercel's Web Interface Guidelines covering spacing, typography, interaction, and accessibility",
    });
    expect(parsed.related[1]?.id).toBe("smithery.ai/mcp-server");
  });

  it("throws UPSTREAM_CHANGED when the JSON-LD block is missing", () => {
    try {
      parseSkillPage(SKILL_PAGE_NO_JSONLD_HTML);
      expect.unreachable();
    } catch (error) {
      expect((error as SkillsError).code).toBe("UPSTREAM_CHANGED");
    }
  });
});

describe("parseOfficial", () => {
  it("parses owners with repos, skills and featured fields", () => {
    const owners = parseOfficial(OFFICIAL_PAGE_HTML);
    expect(owners).toHaveLength(2);
    expect(owners[0]).toMatchObject({
      owner: "aave",
      totalInstalls: 10,
      featuredRepo: "aave/skills",
      featuredSkill: "deleverage",
    });
    expect(owners[0]?.repos[0]?.skills).toEqual([
      { name: "deleverage", installs: 2 },
      { name: "aave-agent", installs: 8 },
    ]);
    expect(owners[1]?.repos[0]?.totalInstalls).toBe(53_210);
  });

  it("throws UPSTREAM_CHANGED when owners data is absent", () => {
    try {
      parseOfficial(OFFICIAL_PAGE_NO_DATA);
      expect.unreachable();
    } catch (error) {
      expect((error as SkillsError).code).toBe("UPSTREAM_CHANGED");
    }
  });
});
