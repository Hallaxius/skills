/**
 * Smoke test for skills-sh-mcp.
 *
 * Spawns the real server over stdio and makes REAL calls against the live
 * skills.sh website. This script is an MCP *client*, so writing to stdout is
 * fine here; the server itself only ever logs to stderr.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const USE_DIST = process.argv.includes("--dist");
const LOCAL_ONLY = process.argv.includes("--local-only");
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
const project = await mkdtemp(join(tmpdir(), "skills-mcp-smoke-"));
const skillPath = join(project, ".agents", "skills", "smoke-example");
await mkdir(skillPath, { recursive: true });
await writeFile(join(skillPath, "SKILL.md"), "stdio smoke fixture\n");
const lock = JSON.stringify({ version: 1, skills: { "smoke-example": { source: "smoke-fixture", sourceType: "local" } } });
await writeFile(join(project, "skills-lock.json"), lock);
const transport = new StdioClientTransport({
  command: USE_DIST ? (process.env["SKILLS_SMOKE_NODE"] ?? "node") : process.execPath,
  args: [SERVER_ENTRY],
  stderr: "inherit",
  env: { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    SKILLS_PROJECT_ROOT: project, SKILLS_ALLOW_MUTATIONS: "false" },
});

let failures = 0;

async function callAndReport(name: string, args: Record<string, unknown>, expectedError?: string): Promise<void> {
  console.log(`\n--- tools/call ${name} ${JSON.stringify(args)} ---`);
  const outcome = outcomeOf(await client.callTool({ name, arguments: args }));
  if (expectedError && outcome.isError && outcome.text.startsWith(`[${expectedError}]`)) {
    console.log(`OK (expected refusal)\n${outcome.text}`);
  } else if (outcome.isError || expectedError) {
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
  const expected = ["check_skill_updates", "get_official_skills", "get_skill", "get_skill_audits", "get_top_skills",
    "install_skill", "list_installed_skills", "remove_skill", "search_skills", "update_skill"];
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    failures += 1;
    console.log(`ERROR: expected the ten supported tools, found ${names.length}`);
  }

  if (!LOCAL_ONLY) {
    await callAndReport("search_skills", { query: "react", limit: 3 });
    await callAndReport("get_top_skills", { view: "hot", limit: 3 });
    await callAndReport("get_skill", { id: "vercel-labs/skills/find-skills" });
    await callAndReport("get_skill_audits", { id: "vercel-labs/skills/find-skills" });
    await callAndReport("get_official_skills", { limit: 2 });
    await callAndReport("install_skill", { id: "vercel-labs/skills/find-skills" });
  }
  await callAndReport("list_installed_skills", { scope: "project" });
  await callAndReport("check_skill_updates", { scope: "project" });
  await callAndReport("remove_skill", { name: "smoke-example" });
  await callAndReport("update_skill", { name: "smoke-example" }, "UNSUPPORTED_SOURCE");
  await callAndReport("install_skill", { id: "uizze.sh/ui-taste" }, "UNSUPPORTED_SOURCE");
  await callAndReport("install_skill", { id: "owner/repo/example", dry_run: false, confirm: true,
    confirmation_token: "0".repeat(64) }, "PERMISSION_DENIED");
  for (const name of ["remove_skill", "update_skill"]) {
    await callAndReport(name, { name: "smoke-example", dry_run: false }, "PERMISSION_DENIED");
  }
  if (await readFile(join(skillPath, "SKILL.md"), "utf8") !== "stdio smoke fixture\n" ||
    await readFile(join(project, "skills-lock.json"), "utf8") !== lock) {
    throw new Error("read-only smoke checks changed the local fixture");
  }
} catch (error) {
  failures += 1;
  console.error(`smoke test crashed: ${String(error)}`);
} finally {
  await client.close().catch(() => undefined);
  await rm(project, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\nsmoke FAILED (${failures} failure(s))`);
  process.exit(1);
}
console.log(`\nsmoke PASSED: ${LOCAL_ONLY ? "local-only" : "live and local"} MCP checks succeeded; local fixture unchanged`);
