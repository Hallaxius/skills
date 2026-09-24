import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SkillsApiService } from "../services/skills-api";
import { runTool } from "./tool-utils";

const ID_DESCRIPTION =
  'Skill id: "{owner}/{repo}/{skill}" for GitHub skills (e.g. "vercel-labs/skills/find-skills") ' +
  'or "{domain}/{skill}" for well-known skills (e.g. "uizze.sh/ui-taste")';

const inputSchema = z.object({
  id: z.string().min(3).max(200).describe(ID_DESCRIPTION),
  include_files: z
    .boolean()
    .default(false)
    .describe(
      "Also return the skill's file bundle (SKILL.md etc.) — requires VERCEL_OIDC_TOKEN to be configured (see README)",
    ),
});

export function registerSkillDetailTool(server: McpServer, service: SkillsApiService): void {
  server.registerTool(
    "get_skill",
    {
      title: "Get skill details",
      description:
        "Get a skill's details from skills.sh: full description, install count, topics, related " +
        "skills and the 'npx skills add' install command. Optionally includes the skill's files " +
        "(SKILL.md etc.) when VERCEL_OIDC_TOKEN is configured.",
      inputSchema,
      annotations: { readOnlyHint: true },
    },
    async (args) => runTool(() => service.getSkill(args.id, args.include_files)),
  );
}
