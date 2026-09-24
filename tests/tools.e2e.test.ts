import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server";
import { AUDIT_BODY, PUBLIC_SEARCH_BODY } from "./fixtures/api";
import {
  ALL_TIME_ENTRIES,
  HOT_ENTRIES,
  OFFICIAL_PAGE_HTML,
  SKILL_PAGE_HTML,
  leaderboardPage,
} from "./fixtures/pages";
import { htmlResponse, jsonResponse, makeService, type FetchHandler } from "./helpers";

const TOOL_NAMES = [
  "get_official_skills",
  "get_skill",
  "get_skill_audits",
  "get_top_skills",
  "search_skills",
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
): Promise<{ client: Client; server: ReturnType<typeof createServer> }> {
  const { service } = makeService(handler);
  const server = createServer(service);
  const client = new Client({ name: "e2e-test-client", version: "1.0.0" });
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

describe("MCP server end-to-end (InMemoryTransport)", () => {
  test("advertises the five skills.sh tools", async () => {
    const pair = await connectClient();
    try {
      const { tools } = await pair.client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual(TOOL_NAMES);
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
