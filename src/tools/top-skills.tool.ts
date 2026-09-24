import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SkillsApiService } from "../services/skills-api";
import { runTool } from "./tool-utils";

const inputSchema = z.object({
  view: z
    .enum(["all-time", "trending", "hot"])
    .default("all-time")
    .describe("Which leaderboard to read: all-time, trending, or hot (yesterday's movers)"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(20)
    .describe("Maximum number of skills to return (1-50)"),
  offset: z
    .number()
    .int()
    .min(0)
    .max(290)
    .default(0)
    .describe("Skip this many entries (each leaderboard exposes 300 entries)"),
});

export function registerTopSkillsTool(server: McpServer, service: SkillsApiService): void {
  server.registerTool(
    "get_top_skills",
    {
      title: "Get top skills",
      description:
        "Read a skills.sh leaderboard: all-time most-installed skills, trending, or yesterday's " +
        "hot movers. Entries include install counts and 'npx skills add' install commands for " +
        "GitHub-hosted skills.",
      inputSchema,
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      runTool(async () => {
        const slice = await service.getTopSkills(args.view, args.limit, args.offset);
        return {
          view: args.view,
          offset: args.offset,
          count: slice.skills.length,
          totalAvailable: slice.totalAvailable,
          skills: slice.skills,
        };
      }),
  );
}
