import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SkillsApiService } from "../services/skills-api";
import { runTool } from "./tool-utils";

const inputSchema = z.object({
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .describe("Maximum number of owners to return (1-100; the official list has ~100 owners)"),
});

export function registerOfficialSkillsTool(server: McpServer, service: SkillsApiService): void {
  server.registerTool(
    "get_official_skills",
    {
      title: "Get official skills",
      description:
        "Get skills.sh's official/curated directory: trusted owners (Vercel, Anthropic, Microsoft, " +
        "Google, Supabase, Cloudflare, …) with their featured skills and install counts. Same " +
        "dataset as the site's /official page.",
      inputSchema,
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      runTool(async () => {
        const owners = await service.getOfficialSkills(args.limit);
        return { count: owners.length, owners };
      }),
  );
}
