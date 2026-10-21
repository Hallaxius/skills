import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createLocalSkillsService, createServer } from "../src/server";
import { LocalSkillsService } from "../src/services/local-skills";
import type { HeadCommitResolver } from "../src/services/skills-api";
import { loadConfig } from "../src/config";
import type { SkillSource } from "../src/types/local-skills";
import { AUDIT_BODY, PUBLIC_SEARCH_BODY } from "./fixtures/api";
import {
  ALL_TIME_ENTRIES,
  HOT_ENTRIES,
  OFFICIAL_PAGE_HTML,
  SKILL_PAGE_HTML,
  leaderboardPage,
} from "./fixtures/pages";
import { htmlResponse, jsonResponse, makeService, stubFetch, type FetchHandler } from "./helpers";

const TOOL_NAMES = [
  "check_skill_updates",
  "get_official_skills",
  "get_skill",
  "get_skill_audits",
  "get_top_skills",
  "install_skill",
  "list_installed_skills",
  "remove_skill",
  "search_skills",
  "update_skill",
];

/** Covers every endpoint the tools touch, in public (no-token) mode. */
const fullHandler: FetchHandler = (url) => {
  if (url.startsWith("https://skills.sh/api/search")) return jsonResponse(PUBLIC_SEARCH_BODY);
  if (url.startsWith("https://skills.sh/api/v1/skills/audit/")) return jsonResponse(AUDIT_BODY);
  if (url === "https://www.skills.sh/hot") return htmlResponse(leaderboardPage(HOT_ENTRIES));
  if (url === "https://www.skills.sh/official") return htmlResponse(OFFICIAL_PAGE_HTML);
  if (url === "https://www.skills.sh/anthropics/skills/frontend-design") {
    return htmlResponse(SKILL_PAGE_HTML);
  }
  if (url === "https://www.skills.sh/") return htmlResponse(leaderboardPage(ALL_TIME_ENTRIES));
  throw new Error(`unexpected url: ${url}`);
};

async function connectClient(
  handler: FetchHandler = fullHandler,
  github?: HeadCommitResolver,
): Promise<{ client: Client; server: ReturnType<typeof createServer> }> {
  const { service } = makeService(handler, {}, github);
  const server = createServer(service);
  const client = new Client({ name: "e2e-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, server };
}

async function connectLocalClient(
  localSkills: LocalSkillsService,
): Promise<{ client: Client; server: ReturnType<typeof createServer> }> {
  const { service } = makeService((_url) => {
    throw new Error("local tools do not call the skills.sh API");
  });
  const server = createServer(service, localSkills);
  const client = new Client({ name: "e2e-local-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, server };
}

async function closePair(pair: { client: Client; server: ReturnType<typeof createServer> }): Promise<void> {
  await Promise.all([pair.client.close(), pair.server.close()]);
}

/**
 * Extracts `isError` and the first text block from a callTool result.
 * The SDK's return type is a union (full result | compatibility result), so
 * this validates the shape at runtime instead of fighting the union type.
 */
function outcomeOf(result: unknown): { isError: boolean; text: string } {
  if (typeof result !== "object" || result === null || !("content" in result)) {
    throw new Error(`unexpected tool result: ${JSON.stringify(result)}`);
  }
  const content = (result as { content: unknown }).content;
  if (!Array.isArray(content)) {
    throw new Error(`unexpected tool result content: ${JSON.stringify(result)}`);
  }
  const first = content[0];
  if (
    typeof first !== "object" ||
    first === null ||
    (first as { type?: unknown }).type !== "text" ||
    typeof (first as { text?: unknown }).text !== "string"
  ) {
    throw new Error(`expected a text content block, got: ${JSON.stringify(content)}`);
  }
  return {
    isError: (result as { isError?: unknown }).isError === true,
    text: (first as { text: string }).text,
  };
}

const stubSource: SkillSource = {
  async latest() {
    return {
      folderHash: "1".repeat(40),
      files: [{ path: "SKILL.md", sha: "519c15ed8d400dfa4be08f404a5c5b21ad6d4a7a", mode: "100644", size: 8 }],
    };
  },
  async baseline() {
    return {
      folderHash: "2".repeat(40),
      files: [{ path: "SKILL.md", sha: "4b48deed3a433909bfd6b6ab3d4b91348b6af464", mode: "100644", size: 9 }],
    };
  },
  async readFile() {
    return Buffer.from("updated\n");
  },
  async resolve() {
    return {
      entry: { source: "owner/repo", sourceType: "github", skillPath: "skills/example/SKILL.md" },
      snapshot: {
        folderHash: "1".repeat(40),
        files: [{ path: "SKILL.md", sha: "519c15ed8d400dfa4be08f404a5c5b21ad6d4a7a", mode: "100644", size: 8 }],
      },
    };
  },
};

async function installedProject(root: string): Promise<string> {
  const path = join(root, ".agents", "skills", "example");
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "SKILL.md"), "original\n");
  const computedHash = "a719bf92b1c041f4d599ca93f873cfb982b648ab0ea40683d633972716766fef";
  await writeFile(
    join(root, "skills-lock.json"),
    JSON.stringify({ version: 1, skills: {
      example: { source: "owner/repo", sourceType: "github", skillPath: "skills/example/SKILL.md", computedHash, skillFolderHash: "2".repeat(40) },
    } }),
  );
  return path;
}

describe("MCP server end-to-end (InMemoryTransport)", () => {
  test("advertises the ten skills tools (7 readonly + 3 mutating)", async () => {
    const pair = await connectClient();
    try {
      const { tools } = await pair.client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual(TOOL_NAMES);
      expect(tools.filter((tool) => tool.annotations?.readOnlyHint === true)).toHaveLength(7);
      expect(tools.filter((tool) => tool.annotations?.destructiveHint === true)).toHaveLength(2);
    } finally {
      await closePair(pair);
    }
  });

  test("search_skills returns parsed search results", async () => {
    const pair = await connectClient();
    try {
      const out = outcomeOf(
        await pair.client.callTool({ name: "search_skills", arguments: { query: "react", limit: 3 } }),
      );
      expect(out.isError).toBe(false);
      const parsed = JSON.parse(out.text) as Array<{ id: string; installCommand?: string }>;
      expect(parsed.length).toBe(3);
      expect(parsed[0]?.id).toBe("vercel-labs/json-render/react");
      expect(parsed[0]?.installCommand).toContain("npx skills add");
    } finally {
      await closePair(pair);
    }
  });

  test("search_skills applies the default limit", async () => {
    const pair = await connectClient();
    try {
      const out = outcomeOf(await pair.client.callTool({ name: "search_skills", arguments: { query: "react" } }));
      expect(out.isError).toBe(false);
      expect((JSON.parse(out.text) as unknown[]).length).toBe(3);
    } finally {
      await closePair(pair);
    }
  });

  test("get_top_skills returns the hot leaderboard slice", async () => {
    const pair = await connectClient();
    try {
      const out = outcomeOf(
        await pair.client.callTool({ name: "get_top_skills", arguments: { view: "hot", limit: 2 } }),
      );
      expect(out.isError).toBe(false);
      const parsed = JSON.parse(out.text) as {
        view: string;
        offset: number;
        count: number;
        totalAvailable: number;
        skills: Array<{ installsYesterday?: number; change?: number }>;
      };
      expect(parsed.view).toBe("hot");
      expect(parsed.offset).toBe(0);
      expect(parsed.count).toBe(2);
      expect(parsed.totalAvailable).toBe(2);
      expect(parsed.skills[0]?.installsYesterday).toBe(4211);
      expect(parsed.skills[0]?.change).toBe(12);
    } finally {
      await closePair(pair);
    }
  });

  test("get_skill returns the parsed skill detail", async () => {
    const pair = await connectClient();
    try {
      const out = outcomeOf(
        await pair.client.callTool({ name: "get_skill", arguments: { id: "anthropics/skills/frontend-design" } }),
      );
      expect(out.isError).toBe(false);
      const parsed = JSON.parse(out.text) as {
        id: string;
        name: string;
        owner: string;
        installCommand: string | null;
        topics: string[];
        related: unknown[];
      };
      expect(parsed.id).toBe("anthropics/skills/frontend-design");
      expect(parsed.name).toBe("frontend-design");
      expect(parsed.owner).toBe("anthropics");
      expect(parsed.installCommand).toContain("npx skills add");
      expect(parsed.topics).toEqual(["design"]);
      expect(parsed.related.length).toBe(2);
    } finally {
      await closePair(pair);
    }
  });

  test("get_skill_audits returns the audit reports", async () => {
    const pair = await connectClient();
    try {
      const out = outcomeOf(
        await pair.client.callTool({
          name: "get_skill_audits",
          arguments: { id: "vercel-labs/skills/find-skills" },
        }),
      );
      expect(out.isError).toBe(false);
      const parsed = JSON.parse(out.text) as { audits: Array<{ provider: string; status: string }> };
      expect(parsed.audits.length).toBe(5);
      expect(parsed.audits[0]?.provider).toBe("Gen Agent Trust Hub");
    } finally {
      await closePair(pair);
    }
  });

  test("get_skill_audits includes a commit-pinned install command when the repo HEAD resolves", async () => {
    const headSha = "b146008599c31057cef1c145774cea5d5afb30e8";
    const pair = await connectClient(fullHandler, { headCommitSha: async () => headSha });
    try {
      const out = outcomeOf(
        await pair.client.callTool({
          name: "get_skill_audits",
          arguments: { id: "vercel-labs/skills/find-skills" },
        }),
      );
      expect(out.isError).toBe(false);
      const parsed = JSON.parse(out.text) as {
        version?: { commitSha: string; ref: string; installCommand: string; caveat: string };
      };
      expect(parsed.version?.commitSha).toBe(headSha);
      expect(parsed.version?.ref).toBe("HEAD");
      expect(parsed.version?.installCommand).toBe(
        `npx skills add vercel-labs/skills#${headSha}@find-skills`,
      );
      expect(parsed.version?.caveat).toContain("not necessarily");
    } finally {
      await closePair(pair);
    }
  });

  test("get_official_skills returns the curated owners", async () => {
    const pair = await connectClient();
    try {
      const out = outcomeOf(
        await pair.client.callTool({ name: "get_official_skills", arguments: { limit: 5 } }),
      );
      expect(out.isError).toBe(false);
      const parsed = JSON.parse(out.text) as {
        count: number;
        owners: Array<{ owner: string; featuredSkill: string }>;
      };
      expect(parsed.count).toBe(2);
      expect(parsed.owners[0]?.owner).toBe("aave");
      expect(parsed.owners[0]?.featuredSkill).toBe("deleverage");
    } finally {
      await closePair(pair);
    }
  });

  test("get_skill with an invalid id reports [INVALID_INPUT] as a tool error", async () => {
    const pair = await connectClient();
    try {
      const out = outcomeOf(
        await pair.client.callTool({ name: "get_skill", arguments: { id: "definitely not an id" } }),
      );
      expect(out.isError).toBe(true);
      expect(out.text).toContain("[INVALID_INPUT]");
    } finally {
      await closePair(pair);
    }
  });

  test("get_skill include_files without a token reports [INVALID_INPUT] with a hint", async () => {
    const pair = await connectClient();
    try {
      const out = outcomeOf(
        await pair.client.callTool({
          name: "get_skill",
          arguments: { id: "anthropics/skills/frontend-design", include_files: true },
        }),
      );
      expect(out.isError).toBe(true);
      expect(out.text).toContain("[INVALID_INPUT]");
      expect(out.text).toContain("VERCEL_OIDC_TOKEN");
    } finally {
      await closePair(pair);
    }
  });

  test("search_skills returns an input-validation error for a too-short query", async () => {
    const pair = await connectClient();
    try {
      const out = outcomeOf(
        await pair.client.callTool({ name: "search_skills", arguments: { query: "r" } }),
      );
      expect(out.isError).toBe(true);
      expect(out.text).toContain("Input validation error");
    } finally {
      await closePair(pair);
    }
  });

  test("search_skills returns an input-validation error for an out-of-range limit", async () => {
    const pair = await connectClient();
    try {
      const out = outcomeOf(
        await pair.client.callTool({ name: "search_skills", arguments: { query: "react", limit: 500 } }),
      );
      expect(out.isError).toBe(true);
      expect(out.text).toContain("Input validation error");
    } finally {
      await closePair(pair);
    }
  });
});

describe("local skills MCP tools (injected roots, stubbed source)", () => {
  let root: string;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "skills-mcp-e2e-")));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("createLocalSkillsService constructs with project root and mutations off", () => {
    const service = createLocalSkillsService({
      token: undefined,
      apiBaseUrl: "https://skills.sh",
      pageBaseUrl: "https://www.skills.sh",
      minRequestIntervalMs: 0,
      requestTimeoutMs: 2_000,
      projectRoot: root,
      homeDir: undefined,
      globalStateRoot: undefined,
      allowMutations: false,
      githubToken: undefined,
    });
    expect(service).toBeInstanceOf(LocalSkillsService);
  });

  test("the factory checks public GitHub sources without requiring a token", async () => {
    await installedProject(root);
    const upstream = stubFetch((url) => jsonResponse(JSON.stringify(url.includes("/trees/" + "2".repeat(40))
      ? { sha: "2".repeat(40), truncated: false, tree: [
        { path: "SKILL.md", type: "blob", mode: "100644", size: 9, sha: "4b48deed3a433909bfd6b6ab3d4b91348b6af464" },
      ] } : { sha: "3".repeat(40), truncated: false, tree: [
      { path: "skills/example", type: "tree", sha: "1".repeat(40) },
      { path: "skills/example/SKILL.md", type: "blob", mode: "100644", size: 8,
        sha: "519c15ed8d400dfa4be08f404a5c5b21ad6d4a7a" },
    ] })));
    const service = createLocalSkillsService({ ...loadConfig({}), projectRoot: root,
      homeDir: root, minRequestIntervalMs: 0 }, upstream.fetch);
    const result = await service.checkUpdates({ scope: "project", name: "example" });
    expect(result.skills[0]?.status).toBe("update_available");
    expect(upstream.calls[0]?.url).toBe("https://api.github.com/repos/owner/repo/git/trees/HEAD?recursive=1");
    expect(upstream.calls[0]?.headers["authorization"]).toBeUndefined();
  });

  test("local tools default to project scope and their documented pagination limits", async () => {
    const pair = await connectLocalClient(new LocalSkillsService({ projectRoot: root, homeDir: root, allowMutations: false }));
    try {
      const list = outcomeOf(await pair.client.callTool({ name: "list_installed_skills", arguments: {} }));
      const updates = outcomeOf(await pair.client.callTool({ name: "check_skill_updates", arguments: {} }));
      expect(JSON.parse(list.text)).toMatchObject({ scope: "project", limit: 50, offset: 0, total: 0 });
      expect(JSON.parse(updates.text)).toMatchObject({ scope: "project", limit: 20, offset: 0, total: 0 });
    } finally { await closePair(pair); }
  });

  test("list_installed_skills returns empty project scope read-only", async () => {
    const localSkills = new LocalSkillsService({
      projectRoot: root,
      homeDir: join(root, "home"),
      allowMutations: false,
    });
    const pair = await connectLocalClient(localSkills);
    try {
      const out = outcomeOf(
        await pair.client.callTool({
          name: "list_installed_skills",
          arguments: { scope: "project", limit: 10, offset: 0 },
        }),
      );
      expect(out.isError).toBe(false);
      const parsed = JSON.parse(out.text) as { scope: string; total: number; skills: unknown[] };
      expect(parsed.scope).toBe("project");
      expect(parsed.total).toBe(0);
      expect(parsed.skills).toEqual([]);
    } finally {
      await closePair(pair);
    }
  });

  test("list_installed_skills lists one canonical installed skill", async () => {
    await installedProject(root);
    const localSkills = new LocalSkillsService({
      projectRoot: root,
      homeDir: join(root, "home"),
      allowMutations: false,
    });
    const pair = await connectLocalClient(localSkills);
    try {
      const out = outcomeOf(
        await pair.client.callTool({
          name: "list_installed_skills",
          arguments: { scope: "project" },
        }),
      );
      expect(out.isError).toBe(false);
      const parsed = JSON.parse(out.text) as { total: number; skills: Array<{ name: string; scope: string }> };
      expect(parsed.total).toBe(1);
      expect(parsed.skills[0]?.name).toBe("example");
      expect(parsed.skills[0]?.scope).toBe("project");
    } finally {
      await closePair(pair);
    }
  });

  test("list_installed_skills in project scope without a root reports [INVALID_INPUT]", async () => {
    const localSkills = new LocalSkillsService({
      homeDir: join(root, "home"),
      allowMutations: false,
    });
    const pair = await connectLocalClient(localSkills);
    try {
      const out = outcomeOf(
        await pair.client.callTool({ name: "list_installed_skills", arguments: { scope: "project" } }),
      );
      expect(out.isError).toBe(true);
      expect(out.text).toContain("[INVALID_INPUT]");
    } finally {
      await closePair(pair);
    }
  });

  test("check_skill_updates is read-only and reports an update", async () => {
    await installedProject(root);
    const localSkills = new LocalSkillsService({
      projectRoot: root,
      homeDir: join(root, "home"),
      allowMutations: false,
    }, stubSource);
    const pair = await connectLocalClient(localSkills);
    try {
      const out = outcomeOf(
        await pair.client.callTool({
          name: "check_skill_updates",
          arguments: { scope: "project", name: "example", limit: 20, offset: 0 },
        }),
      );
      expect(out.isError).toBe(false);
      const parsed = JSON.parse(out.text) as { skills: Array<{ name: string; status: string }> };
      expect(parsed.skills[0]?.name).toBe("example");
      expect(parsed.skills[0]?.status).toBe("update_available");
    } finally {
      await closePair(pair);
    }
  });

  test("remove_skill defaults to read-only preview with a token", async () => {
    await installedProject(root);
    const localSkills = new LocalSkillsService({
      projectRoot: root,
      homeDir: join(root, "home"),
      allowMutations: false,
    }, stubSource);
    const pair = await connectLocalClient(localSkills);
    try {
      const out = outcomeOf(
        await pair.client.callTool({
          name: "remove_skill",
          arguments: { scope: "project", name: "example" },
        }),
      );
      expect(out.isError).toBe(false);
      const parsed = JSON.parse(out.text) as { status: string; confirmation_token?: string };
      expect(parsed.status).toBe("preview");
      expect(parsed.confirmation_token).toMatch(/^[a-f0-9]{64}$/);
      // Nothing was removed.
      const listOut = outcomeOf(
        await pair.client.callTool({ name: "list_installed_skills", arguments: { scope: "project" } }),
      );
      expect((JSON.parse(listOut.text) as { total: number }).total).toBe(1);
    } finally {
      await closePair(pair);
    }
  });

  test("remove_skill executes removal after a fresh dry run", async () => {
    await installedProject(root);
    const localSkills = new LocalSkillsService({
      projectRoot: root,
      homeDir: join(root, "home"),
      allowMutations: true,
    }, stubSource);
    const pair = await connectLocalClient(localSkills);
    try {
      const preview = outcomeOf(
        await pair.client.callTool({ name: "remove_skill", arguments: { scope: "project", name: "example" } }),
      );
      expect(preview.isError).toBe(false);
      const token = (JSON.parse(preview.text) as { confirmation_token: string }).confirmation_token;
      expect(token).toMatch(/^[a-f0-9]{64}$/);
      const result = outcomeOf(
        await pair.client.callTool({
          name: "remove_skill",
          arguments: { scope: "project", name: "example", dry_run: false, confirm: true, confirmation_token: token },
        }),
      );
      expect(result.isError).toBe(false);
      expect((JSON.parse(result.text) as { status: string }).status).toBe("removed");
      const listOut = outcomeOf(
        await pair.client.callTool({ name: "list_installed_skills", arguments: { scope: "project" } }),
      );
      expect((JSON.parse(listOut.text) as { total: number }).total).toBe(0);
    } finally {
      await closePair(pair);
    }
  });

  test("remove_skill rejects traversal at the MCP schema boundary", async () => {
    const localSkills = new LocalSkillsService({
      projectRoot: root,
      homeDir: join(root, "home"),
      allowMutations: false,
    }, stubSource);
    const pair = await connectLocalClient(localSkills);
    try {
      const out = outcomeOf(
        await pair.client.callTool({
          name: "remove_skill",
          arguments: { scope: "project", name: "../evil" },
        }),
      );
      expect(out.isError).toBe(true);
      expect(out.text).toContain("Input validation error");
    } finally {
      await closePair(pair);
    }
  });

  test("update_skill defaults to a read-only preview", async () => {
    await installedProject(root);
    const localSkills = new LocalSkillsService({
      projectRoot: root,
      homeDir: join(root, "home"),
      allowMutations: false,
    }, stubSource);
    const pair = await connectLocalClient(localSkills);
    try {
      const out = outcomeOf(
        await pair.client.callTool({
          name: "update_skill",
          arguments: { scope: "project", name: "example" },
        }),
      );
      expect(out.isError).toBe(false);
      const parsed = JSON.parse(out.text) as { status: string; confirmation_token?: string };
      expect(parsed.status).toBe("preview");
      expect(parsed.confirmation_token).toMatch(/^[a-f0-9]{64}$/);
      // Nothing changed.
      expect(await readFile(join(root, ".agents", "skills", "example", "SKILL.md"), "utf8")).toBe("original\n");
    } finally {
      await closePair(pair);
    }
  });

  test("update_skill executes only after host opt-in and a matching preview approval", async () => {
    const path = await installedProject(root);
    const pair = await connectLocalClient(new LocalSkillsService({ projectRoot: root, homeDir: root, allowMutations: true }, stubSource));
    try {
      const preview = outcomeOf(await pair.client.callTool({ name: "update_skill", arguments: { name: "example" } }));
      expect(preview.isError).toBe(false);
      const { confirmation_token } = JSON.parse(preview.text) as { confirmation_token: string };
      const result = outcomeOf(await pair.client.callTool({ name: "update_skill", arguments: {
        name: "example", dry_run: false, confirm: true, confirmation_token,
      } }));
      expect(result.isError).toBe(false);
      expect(JSON.parse(result.text).status).toBe("updated");
      expect(await readFile(join(path, "SKILL.md"), "utf8")).toBe("updated\n");
      const check = outcomeOf(await pair.client.callTool({ name: "check_skill_updates", arguments: { name: "example" } }));
      expect(JSON.parse(check.text).skills[0].status).toBe("up_to_date");
    } finally { await closePair(pair); }
  });

  test("install_skill previews by default and requires host opt-in and approval", async () => {
    const pair = await connectLocalClient(
      new LocalSkillsService({ projectRoot: root, homeDir: root, allowMutations: false }, stubSource),
    );
    try {
      const preview = outcomeOf(await pair.client.callTool({ name: "install_skill", arguments: { id: "owner/repo/example" } }));
      expect(preview.isError).toBe(false);
      const parsed = JSON.parse(preview.text) as { status: string; confirmation_token: string };
      expect(parsed.status).toBe("preview");
      expect(parsed.confirmation_token).toMatch(/^[a-f0-9]{64}$/);
      expect(await readdir(root)).toEqual([]);
      const refused = outcomeOf(await pair.client.callTool({ name: "install_skill", arguments: {
        id: "owner/repo/example", dry_run: false, confirm: true, confirmation_token: parsed.confirmation_token,
      } }));
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain("[PERMISSION_DENIED]");
      const wellKnown = outcomeOf(await pair.client.callTool({ name: "install_skill", arguments: { id: "uizze.sh/ui-taste" } }));
      expect(wellKnown.isError).toBe(true);
      expect(wellKnown.text).toContain("[UNSUPPORTED_SOURCE]");
      expect(await readdir(root)).toEqual([]);
    } finally { await closePair(pair); }
  });

  test("install_skill creates the canonical directory and lock entry after approval", async () => {
    const pair = await connectLocalClient(
      new LocalSkillsService({ projectRoot: root, homeDir: root, allowMutations: true }, stubSource),
    );
    try {
      const preview = outcomeOf(await pair.client.callTool({ name: "install_skill", arguments: { id: "owner/repo/example" } }));
      const { confirmation_token } = JSON.parse(preview.text) as { confirmation_token: string };
      const result = outcomeOf(await pair.client.callTool({ name: "install_skill", arguments: {
        id: "owner/repo/example", dry_run: false, confirm: true, confirmation_token,
      } }));
      expect(result.isError).toBe(false);
      expect(JSON.parse(result.text).status).toBe("installed");
      expect(await readFile(join(root, ".agents", "skills", "example", "SKILL.md"), "utf8")).toBe("updated\n");
      const lock = JSON.parse(await readFile(join(root, "skills-lock.json"), "utf8")) as {
        skills: Record<string, { source: string; skillFolderHash: string }>;
      };
      expect(lock.skills.example).toMatchObject({ source: "owner/repo", skillFolderHash: "1".repeat(40) });
      const repeat = outcomeOf(await pair.client.callTool({ name: "install_skill", arguments: { id: "owner/repo/example" } }));
      expect(repeat.isError).toBe(true);
      expect(repeat.text).toContain("[CONFLICT]");
    } finally { await closePair(pair); }
  });
});
