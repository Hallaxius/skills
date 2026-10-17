import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { LocalSkillsService } from "../services/local-skills";
import { runTool } from "./tool-utils";

const scopeSchema = z
  .enum(["project", "global"])
  .default("project")
  .describe(
    "Canonical .agents scope: project = <SKILLS_PROJECT_ROOT>/.agents/skills; " +
      "global = <home>/.agents/skills (opt-in). project scope requires an explicitly " +
      "configured SKILLS_PROJECT_ROOT; there is no cwd fallback.",
  );

const nameSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/)
  .describe(
    "Skill name: a single portable directory basename (1-100 chars), " +
      "matching /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/. The service also rejects unsafe names.",
  );

const limitSchema = z
  .number()
  .int()
  .min(1)
  .max(100)
  .describe("Maximum number of entries to return (1-100).");

const offsetSchema = z
  .number()
  .int()
  .min(0)
  .max(2_000)
  .default(0)
  .describe("Number of entries to skip (0-2000).");

const dryRunSchema = z
  .boolean()
  .default(true)
  .describe(
    "Preview-only run. Defaults to true; set false to execute. " +
      "The confirmation token is not authentication — it is a freshness check.",
  );

const confirmSchema = z
  .boolean()
  .default(false)
  .describe(
    "Execute the mutation. Defaults to false; must be true together with a " +
      "fresh confirmation_token from a dry run.",
  );

const confirmationTokenSchema = z
  .string()
  .length(64)
  .regex(/^[a-f0-9]{64}$/)
  .optional()
  .describe(
    "Optional 64-character lowercase hex confirmation token from a fresh dry run. " +
      "Not authentication — it binds execution to the previewed skill, lock, and " +
      "upstream state.",
  );

const skillIdSchema = z
  .string()
  .min(5)
  .max(200)
  .describe(
    'skills.sh skill id in the form "{owner}/{repo}/{skill}" — for example ' +
      '"vercel-labs/skills/find-skills". Only GitHub sources can be installed natively; ' +
      'well-known domains such as "uizze.sh/ui-taste" require the official Skills CLI.',
  );

const folderPathSchema = z
  .string()
  .min(1)
  .max(500)
  .optional()
  .describe(
    "Optional repo-relative skill folder (for example \"skills/my-skill\") used only " +
      "to disambiguate when several folders in the repository share the skill name.",
  );

export function registerLocalSkillsTools(
  server: McpServer,
  localSkills: LocalSkillsService,
): void {
  server.registerTool(
    "list_installed_skills",
    {
      title: "List local skills",
      description:
        "List skills installed in a canonical .agents scope (project = " +
        "<SKILLS_PROJECT_ROOT>/.agents/skills; global = ~/.agents/skills, opt-in). " +
        "Read-only: lists directories and lock metadata without writing. " +
        "Project scope requires SKILLS_PROJECT_ROOT; there is no cwd fallback.",
      inputSchema: z.object({
        scope: scopeSchema,
        limit: limitSchema.default(50),
        offset: offsetSchema,
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => runTool(() => localSkills.listInstalled(args)),
  );

  server.registerTool(
    "check_skill_updates",
    {
      title: "Check local skill updates",
      description:
        "Check whether installed skills in a canonical .agents scope have updates " +
        "available (read-only; no writes). global scope is opt-in and reads from the " +
        "configured XDG_STATE_HOME lock or ~/.agents. Requires network to inspect " +
        "the recorded upstream GitHub state. Unsupported or unavailable sources are reported explicitly.",
      inputSchema: z.object({
        scope: scopeSchema,
        name: nameSchema.optional(),
        limit: limitSchema.default(20),
        offset: offsetSchema,
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args, extra) => runTool(() => localSkills.checkUpdates(args, extra.signal)),
  );

  server.registerTool(
    "remove_skill",
    {
      title: "Remove local skill",
      description:
        "Remove a single canonical .agents skill and its lock entry (destructive; " +
        "not idempotent). Defaults to a read-only preview: set dry_run=false, " +
        "confirm=true, and supply the confirmation_token from a fresh dry run to " +
        "execute after human approval. Execution also requires SKILLS_ALLOW_MUTATIONS=true. " +
        "The confirmation token is a freshness check, not authentication.",
      inputSchema: z.object({
        scope: scopeSchema,
        name: nameSchema,
        dry_run: dryRunSchema,
        confirm: confirmSchema,
        confirmation_token: confirmationTokenSchema,
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args, extra) => runTool(() => localSkills.removeSkill(args, extra.signal)),
  );

  server.registerTool(
    "update_skill",
    {
      title: "Update local skill",
      description:
        "Update a single canonical .agents skill from its recorded upstream " +
        "(destructive; not idempotent). Defaults to a read-only preview: set " +
        "dry_run=false, confirm=true, and supply the confirmation_token from a " +
        "fresh dry run to execute after human approval. Execution also requires " +
        "SKILLS_ALLOW_MUTATIONS=true. The token is a freshness check, not authentication. " +
        "Refuses local edits and unsupported sources; never executes bundled scripts.",
      inputSchema: z.object({
        scope: scopeSchema,
        name: nameSchema,
        dry_run: dryRunSchema,
        confirm: confirmSchema,
        confirmation_token: confirmationTokenSchema,
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args, extra) => runTool(() => localSkills.updateSkill(args, extra.signal)),
  );

  server.registerTool(
    "install_skill",
    {
      title: "Install a GitHub skill",
      description:
        "Install one GitHub-sourced skill into a canonical .agents scope as a new " +
        "portable folder (additive; never overwrites an existing skill or lock entry). " +
        "Defaults to a read-only preview with no writes: set dry_run=false, confirm=true, " +
        "and supply the confirmation_token from a fresh dry run to execute after human " +
        "approval. Execution also requires SKILLS_ALLOW_MUTATIONS=true. Downloads immutable " +
        "GitHub blobs that are verified against their hashes before anything is written, and " +
        "never executes bundled scripts. Well-known domains are not installed natively. " +
        "The confirmation token is a freshness check, not authentication.",
      inputSchema: z.object({
        id: skillIdSchema,
        path: folderPathSchema,
        scope: scopeSchema,
        dry_run: dryRunSchema,
        confirm: confirmSchema,
        confirmation_token: confirmationTokenSchema,
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args, extra) => runTool(() => localSkills.installSkill(args, extra.signal)),
  );
}
