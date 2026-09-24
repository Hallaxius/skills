import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SkillsApiService } from "../services/skills-api";
import { runTool } from "./tool-utils";

/** Matches the owner validation used by the official `skills` CLI. */
const OWNER_RE = /^[a-z0-9](?:[a-z0-9-]{0,38})$/i;

const inputSchema = z.object({
  query: z
    .string()
    .min(1)
    .max(100)
    .refine((value) => value.trim().length >= 2, {
      message: "query must be at least 2 characters (after trimming)",
    })
    .describe("Search keywords, e.g. 'react hooks' or 'design'"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(20)
    .describe("Maximum number of results to return (1-50)"),
  owner: z
    .string()
    .regex(OWNER_RE, { message: "owner must be a GitHub owner/organization name" })
    .optional()
    .describe("Restrict results to a GitHub owner/organization, e.g. 'anthropics'"),
});

export function registerSearchSkillsTool(server: McpServer, service: SkillsApiService): void {
  server.registerTool(
    "search_skills",
    {
      title: "Search skills",
      description:
        "Search skills.sh (the Agent Skills Directory) for skills by keyword. Returns matching " +
        "skills with install counts and a ready-to-use 'npx skills add' install command for " +
        "GitHub-hosted skills. Use the id from results ({source}/{skillId}) with get_skill for details.",
      inputSchema,
      annotations: { readOnlyHint: true },
    },
    async (args) => runTool(() => service.searchSkills(args.query.trim(), args.limit, args.owner)),
  );
}
