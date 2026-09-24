import { describe, expect, test } from "bun:test";
import { SkillsError, type SkillsErrorCode } from "../src/errors";
import {
  AUDIT_BODY,
  PUBLIC_SEARCH_BODY,
  V1_DETAIL_BODY,
  V1_SEARCH_BODY,
} from "./fixtures/api";
import {
  ALL_TIME_ENTRIES,
  HOT_ENTRIES,
  OFFICIAL_PAGE_HTML,
  OFFICIAL_PAGE_NO_DATA,
  SKILL_PAGE_HTML,
  TRENDING_ENTRIES,
  leaderboardPage,
} from "./fixtures/pages";
import { htmlResponse, jsonResponse, makeService, type FetchHandler } from "./helpers";

const SKILL_ID = "anthropics/skills/frontend-design";
const SKILL_PAGE_URL = "https://www.skills.sh/anthropics/skills/frontend-design";
const V1_DETAIL_URL = "https://skills.sh/api/v1/skills/anthropics/skills/frontend-design";
const AUDIT_URL = "https://skills.sh/api/v1/skills/audit/vercel-labs/skills/find-skills";

/** Routes every leaderboard page fixture to its matching URL. */
const leaderboardHandler: FetchHandler = (url) => {
  if (url === "https://www.skills.sh/") return htmlResponse(leaderboardPage(ALL_TIME_ENTRIES));
  if (url === "https://www.skills.sh/trending") return htmlResponse(leaderboardPage(TRENDING_ENTRIES));
  if (url === "https://www.skills.sh/hot") return htmlResponse(leaderboardPage(HOT_ENTRIES));
  throw new Error(`unexpected url: ${url}`);
};

/** Asserts that the call rejects with the given SkillsErrorCode and returns the error. */
async function expectSkillsError(call: Promise<unknown>, code: SkillsErrorCode): Promise<SkillsError> {
  let caught: unknown;
  try {
    await call;
  } catch (error) {
    caught = error;
  }
  if (!(caught instanceof SkillsError)) {
    throw new Error(`expected SkillsError with code ${code}, got: ${String(caught)}`);
  }
  expect(caught.code).toBe(code);
  return caught;
}

describe("SkillsApiService.searchSkills (public mode, no token)", () => {
  const searchHandler: FetchHandler = (url) => {
    if (url.startsWith("https://skills.sh/api/search")) return jsonResponse(PUBLIC_SEARCH_BODY);
    throw new Error(`unexpected url: ${url}`);
  };

  test("searches via the public /api/search endpoint and maps results", async () => {
    const { service, calls } = makeService(searchHandler);
    const results = await service.searchSkills("react", 20);
    expect(results.length).toBe(3);
    expect(results[0]?.id).toBe("vercel-labs/json-render/react");
    expect(results[0]?.source).toBe("vercel-labs/json-render");
    expect(results[0]?.installs).toBe(11_446);
    expect(results[0]?.installCommand).toBe(
      "npx skills add https://github.com/vercel-labs/json-render --skill react",
    );
    expect(calls.length).toBe(1);
    expect(calls[0]?.url).toContain("q=react");
    expect(calls[0]?.url).toContain("limit=20");
  });

  test("forwards the owner filter as a URL param", async () => {
    const { service, calls } = makeService(searchHandler);
    await service.searchSkills("react", 5, "vercel-labs");
    expect(calls[0]?.url).toContain("owner=vercel-labs");
    expect(calls[0]?.url).toContain("limit=5");
  });

  test("serves repeat searches from cache without refetching", async () => {
    const { service, calls } = makeService(searchHandler);
    await service.searchSkills("react", 20);
    await service.searchSkills("react", 20);
    expect(calls.length).toBe(1);
  });

  test("maps an upstream 400 to INVALID_INPUT with the upstream message", async () => {
    const { service } = makeService(() =>
      jsonResponse("{\"error\":\"Query must be at least 2 characters\"}", 400),
    );
    const error = await expectSkillsError(service.searchSkills("a", 20), "INVALID_INPUT");
    expect(error.message).toContain("Query must be at least 2 characters");
  });

  test("maps an unrecognized response shape to UPSTREAM_CHANGED", async () => {
    const { service } = makeService(() => jsonResponse("{\"unexpected\":true}"));
    await expectSkillsError(service.searchSkills("react", 20), "UPSTREAM_CHANGED");
  });
});

describe("SkillsApiService.searchSkills (v1 mode with token)", () => {
  test("uses the documented v1 search with Bearer auth", async () => {
    const { service, calls } = makeService(
      (url, headers) => {
        if (url.startsWith("https://skills.sh/api/v1/skills/search")) {
          if (headers.authorization !== "Bearer tok-123") throw new Error("missing auth header");
          return jsonResponse(V1_SEARCH_BODY);
        }
        throw new Error(`unexpected url: ${url}`);
      },
      { token: "tok-123" },
    );
    const results = await service.searchSkills("taste", 10);
    expect(results.length).toBe(2);
    expect(results[0]?.id).toBe("vercel-labs/skills/find-skills");
    expect(results[0]?.installCommand).toBe(
      "npx skills add https://github.com/vercel-labs/skills --skill find-skills",
    );
    expect(results[1]?.sourceType).toBe("well-known");
    expect(results[1]?.installCommand).toBe("npx skills add https://uizze.sh");
    expect(results[1]?.isDuplicate).toBe(true);
    expect(calls[0]?.headers.authorization).toBe("Bearer tok-123");
  });

  test("falls back to the public endpoint when the v1 token is rejected", async () => {
    const { service, calls } = makeService(
      (url) => {
        if (url.startsWith("https://skills.sh/api/v1/skills/search")) {
          return jsonResponse("{\"error\":\"unauthorized\"}", 401);
        }
        if (url.startsWith("https://skills.sh/api/search")) return jsonResponse(PUBLIC_SEARCH_BODY);
        throw new Error(`unexpected url: ${url}`);
      },
      { token: "expired" },
    );
    const results = await service.searchSkills("react", 20);
    expect(results.length).toBe(3);
    expect(calls.length).toBe(2);
    expect(calls[1]?.url).toContain("/api/search?");
  });
});

describe("SkillsApiService.getTopSkills", () => {
  test("parses the all-time leaderboard, deriving install commands", async () => {
    const { service } = makeService(leaderboardHandler);
    const slice = await service.getTopSkills("all-time", 3, 0);
    expect(slice.totalAvailable).toBe(3);
    expect(slice.skills.length).toBe(3);
    expect(slice.skills[0]?.skillId).toBe("find-skills");
    expect(slice.skills[0]?.installCommand).toBe(
      "npx skills add https://github.com/vercel-labs/skills --skill find-skills",
    );
    expect(slice.skills[0]?.weeklyInstalls?.length).toBe(8);
    expect(slice.skills[0]?.isOfficial).toBe(true);
    expect(slice.skills[2]?.source).toBe("uizze.sh");
    expect(slice.skills[2]?.installCommand).toBeUndefined();
  });

  test("applies offset and limit to the parsed entries", async () => {
    const { service } = makeService(leaderboardHandler);
    const slice = await service.getTopSkills("all-time", 2, 1);
    expect(slice.totalAvailable).toBe(3);
    expect(slice.skills.length).toBe(2);
    expect(slice.skills[0]?.source).toBe("anthropics/skills");
    const tail = await service.getTopSkills("trending", 10, 1);
    expect(tail.totalAvailable).toBe(2);
    expect(tail.skills.length).toBe(1);
  });

  test("hot view entries carry installsYesterday and change", async () => {
    const { service } = makeService(leaderboardHandler);
    const slice = await service.getTopSkills("hot", 50, 0);
    expect(slice.skills[0]?.installsYesterday).toBe(4211);
    expect(slice.skills[0]?.change).toBe(12);
    expect(slice.skills[1]?.change).toBe(-4);
  });

  test("fetches each view once (cache) across calls", async () => {
    const { service, calls } = makeService(leaderboardHandler);
    await service.getTopSkills("trending", 1, 0);
    await service.getTopSkills("trending", 2, 0);
    await service.getTopSkills("all-time", 1, 0);
    expect(calls.filter((call) => call.url === "https://www.skills.sh/trending").length).toBe(1);
    expect(calls.filter((call) => call.url === "https://www.skills.sh/").length).toBe(1);
  });
});

describe("SkillsApiService.getSkill", () => {
  test("parses the skill page into a normalized detail", async () => {
    const { service, calls } = makeService((url) => {
      if (url === SKILL_PAGE_URL) return htmlResponse(SKILL_PAGE_HTML);
      throw new Error(`unexpected url: ${url}`);
    });
    const detail = await service.getSkill(SKILL_ID, false);
    expect(detail.id).toBe(SKILL_ID);
    expect(detail.source).toBe("anthropics/skills");
    expect(detail.slug).toBe("frontend-design");
    expect(detail.name).toBe("frontend-design");
    expect(detail.owner).toBe("anthropics");
    expect(detail.installs).toBe(916_456);
    expect(detail.url).toBe(SKILL_PAGE_URL);
    expect(detail.installCommand).toBe(
      "npx skills add https://github.com/anthropics/skills --skill frontend-design",
    );
    expect(detail.topics).toEqual(["design"]);
    expect(detail.related.length).toBe(2);
    expect(detail.related[0]?.id).toBe("vercel-labs/agent-skills/web-design-guidelines");
    expect(detail.related[0]?.description).toContain("spacing, typography, interaction, and accessibility");
    expect(detail.related[1]?.id).toBe("smithery.ai/mcp-server");
    expect(calls.length).toBe(1);
  });

  test("rejects malformed ids with INVALID_INPUT before any fetch", async () => {
    const { service, calls } = makeService(() => {
      throw new Error("should never fetch");
    });
    await expectSkillsError(service.getSkill("definitely not an id", false), "INVALID_INPUT");
    expect(calls.length).toBe(0);
  });

  test("maps a missing skill page to NOT_FOUND", async () => {
    const { service } = makeService(() => htmlResponse("gone", 404));
    await expectSkillsError(service.getSkill(SKILL_ID, false), "NOT_FOUND");
  });

  test("include_files without a token explains how to enable it", async () => {
    const { service } = makeService((url) => {
      if (url === SKILL_PAGE_URL) return htmlResponse(SKILL_PAGE_HTML);
      throw new Error(`unexpected url: ${url}`);
    });
    const error = await expectSkillsError(service.getSkill(SKILL_ID, true), "INVALID_INPUT");
    expect(error.message).toContain("VERCEL_OIDC_TOKEN");
  });

  test("include_files with a token attaches the v1 file bundle", async () => {
    const { service, calls } = makeService(
      (url, headers) => {
        if (url === SKILL_PAGE_URL) return htmlResponse(SKILL_PAGE_HTML);
        if (url === V1_DETAIL_URL) {
          if (headers.authorization !== "Bearer tok") throw new Error("missing auth header");
          return jsonResponse(V1_DETAIL_BODY);
        }
        throw new Error(`unexpected url: ${url}`);
      },
      { token: "tok" },
    );
    const detail = await service.getSkill(SKILL_ID, true);
    expect(detail.files?.length).toBe(1);
    expect(detail.files?.[0]?.path).toBe("SKILL.md");
    expect(detail.files?.[0]?.contents).toContain("name: find-skills");
    expect(detail.hash).toBe("a1b2c3d4e5f6");
    expect(detail.filesNote).toBeUndefined();
    expect(calls[1]?.url).toBe(V1_DETAIL_URL);
  });

  test("reports filesNote when the v1 API has no published bundle (404)", async () => {
    const { service } = makeService(
      (url) => {
        if (url === SKILL_PAGE_URL) return htmlResponse(SKILL_PAGE_HTML);
        if (url === V1_DETAIL_URL) return jsonResponse("{\"error\":\"not found\"}", 404);
        throw new Error(`unexpected url: ${url}`);
      },
      { token: "tok" },
    );
    const detail = await service.getSkill(SKILL_ID, true);
    expect(detail.files).toBeNull();
    expect(detail.hash).toBeNull();
    expect(detail.filesNote).toContain("no published file bundle");
  });
});

describe("SkillsApiService.getSkillAudits", () => {
  test("maps the real audit payload, preserving raw risk levels and categories", async () => {
    const { service } = makeService((url) => {
      if (url === AUDIT_URL) return jsonResponse(AUDIT_BODY);
      throw new Error(`unexpected url: ${url}`);
    });
    const audits = await service.getSkillAudits("vercel-labs/skills/find-skills");
    expect(audits.id).toBe("vercel-labs/skills/find-skills");
    expect(audits.source).toBe("vercel-labs/skills");
    expect(audits.slug).toBe("find-skills");
    expect(audits.audits.length).toBe(5);
    const trustHub = audits.audits[0];
    expect(trustHub?.provider).toBe("Gen Agent Trust Hub");
    expect(trustHub?.riskLevel).toBe("SAFE");
    expect(trustHub?.categories?.length).toBe(3);
    const socket = audits.audits.find((audit) => audit.provider === "Socket");
    expect(socket?.riskLevel).toBeUndefined();
    const snyk = audits.audits.find((audit) => audit.provider === "Snyk");
    expect(snyk?.status).toBe("warn");
    expect(snyk?.riskLevel).toBe("MEDIUM");
  });

  test("builds well-known audit URLs from {domain}/{skill} ids", async () => {
    const wellKnownUrl = "https://skills.sh/api/v1/skills/audit/smithery.ai/mcp-server";
    const { service, calls } = makeService((url) => {
      if (url === wellKnownUrl) return jsonResponse(AUDIT_BODY);
      throw new Error(`unexpected url: ${url}`);
    });
    await service.getSkillAudits("smithery.ai/mcp-server");
    expect(calls[0]?.url).toBe(wellKnownUrl);
  });

  test("404 becomes a friendly NOT_FOUND explaining when audits appear", async () => {
    const { service } = makeService(() => jsonResponse("{\"error\":\"not found\"}", 404));
    const error = await expectSkillsError(
      service.getSkillAudits("vercel-labs/skills/find-skills"),
      "NOT_FOUND",
    );
    expect(error.message).toContain("generated automatically after a skill's first install");
  });

  test("serves repeat audit lookups from cache", async () => {
    const { service, calls } = makeService((url) => {
      if (url === AUDIT_URL) return jsonResponse(AUDIT_BODY);
      throw new Error(`unexpected url: ${url}`);
    });
    await service.getSkillAudits("vercel-labs/skills/find-skills");
    await service.getSkillAudits("vercel-labs/skills/find-skills");
    expect(calls.length).toBe(1);
  });
});

describe("SkillsApiService.getOfficialSkills", () => {
  const officialHandler: FetchHandler = (url) => {
    if (url === "https://www.skills.sh/official") return htmlResponse(OFFICIAL_PAGE_HTML);
    throw new Error(`unexpected url: ${url}`);
  };

  test("parses the curated owner list and slices by limit", async () => {
    const { service } = makeService(officialHandler);
    const first = await service.getOfficialSkills(1);
    expect(first.length).toBe(1);
    expect(first[0]?.owner).toBe("aave");
    expect(first[0]?.featuredRepo).toBe("aave/skills");
    expect(first[0]?.featuredSkill).toBe("deleverage");
    expect(first[0]?.repos[0]?.skills.length).toBe(2);
    const all = await service.getOfficialSkills(100);
    expect(all.length).toBe(2);
    expect(all[1]?.owner).toBe("vercel-labs");
    expect(all[1]?.totalInstalls).toBe(53_210);
  });

  test("fetches the official page once (cache) across calls", async () => {
    const { service, calls } = makeService(officialHandler);
    await service.getOfficialSkills(5);
    await service.getOfficialSkills(10);
    expect(calls.length).toBe(1);
  });

  test("maps missing curated data to UPSTREAM_CHANGED", async () => {
    const { service } = makeService((url) => {
      if (url === "https://www.skills.sh/official") return htmlResponse(OFFICIAL_PAGE_NO_DATA);
      throw new Error(`unexpected url: ${url}`);
    });
    await expectSkillsError(service.getOfficialSkills(20), "UPSTREAM_CHANGED");
  });
});
