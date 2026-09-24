/**
 * Smoke test for skills-sh-mcp.
 *
 * Spawns the real server over stdio and makes REAL calls against the live
 * skills.sh website. This script is an MCP *client*, so writing to stdout is
 * fine here; the server itself only ever logs to stderr.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const USE_DIST = process.argv.includes("--dist");
const SERVER_ENTRY = USE_DIST
  ? Bun.fileURLToPath(new URL("../dist/index.js", import.meta.url))
  : Bun.fileURLToPath(new URL("../src/index.ts", import.meta.url));
const PREVIEW_LIMIT = 600;

interface CallOutcome {
  readonly isError: boolean;
  readonly text: string;
}

function outcomeOf(result: unknown): CallOutcome {
  if (typeof result !== "object" || result === null) {
    throw new Error("callTool returned an unexpected shape");
  }
  const root = result as Record<string, unknown>;
  const nested = root.toolResult;
  const source =
    typeof nested === "object" && nested !== null ? (nested as Record<string, unknown>) : root;
  const isError = source.isError === true;
  let text = "";
  if (Array.isArray(source.content)) {
    text = source.content
      .map((block) => {
        if (typeof block === "object" && block !== null && "text" in block) {
          const value = (block as Record<string, unknown>).text;
          return typeof value === "string" ? value : "";
        }
        return "";
      })
      .join("\n");
  }
  return { isError, text };
}

function preview(text: string): string {
  return text.length > PREVIEW_LIMIT ? text.slice(0, PREVIEW_LIMIT) + " ..." : text;
}

const client = new Client({ name: "skills-sh-mcp-smoke", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [SERVER_ENTRY],
  stderr: "inherit",
});

let failures = 0;

async function callAndReport(name: string, args: Record<string, unknown>): Promise<void> {
  console.log(`\n--- tools/call ${name} ${JSON.stringify(args)} ---`);
  const outcome = outcomeOf(await client.callTool({ name, arguments: args }));
  if (outcome.isError) {
    failures += 1;
    console.log(`ERROR\n${outcome.text}`);
  } else {
    console.log(`OK\n${preview(outcome.text)}`);
  }
}

try {
  await client.connect(transport);

  const toolsResult = await client.listTools();
  const names = toolsResult.tools.map((tool) => tool.name).sort();
  console.log(`tools/list -> [${names.join(", ")}]`);
  if (names.length !== 5) {
    failures += 1;
    console.log(`ERROR: expected 5 tools, found ${names.length}`);
  }

  await callAndReport("search_skills", { query: "react", limit: 3 });
  await callAndReport("get_top_skills", { view: "hot", limit: 3 });
  await callAndReport("get_skill", { id: "vercel-labs/skills/find-skills" });
  await callAndReport("get_skill_audits", { id: "vercel-labs/skills/find-skills" });
} catch (error) {
  failures += 1;
  console.error(`smoke test crashed: ${String(error)}`);
} finally {
  await client.close().catch(() => undefined);
}

if (failures > 0) {
  console.error(`\nsmoke FAILED (${failures} failure(s))`);
  process.exit(1);
}
console.log("\nsmoke PASSED: all real MCP calls succeeded");
