import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SkillsApiService } from "../services/skills-api";
import { runTool } from "./tool-utils";

const inputSchema = z.object({
  id: z
    .string()
    .min(3)
    .max(200)
    .describe(
      'Skill id: "{owner}/{repo}/{skill}" for GitHub skills (e.g. "vercel-labs/skills/find-skills") or "{domain}/{skill}" for well-known skills (e.g. "uizze.sh/ui-taste")',
    ),
});

export function registerSkillAuditsTool(server: McpServer, service: SkillsApiService): void {
  server.registerTool(
    "get_skill_audits",
    {
      title: "Get skill security audits",
      description:
        "Get the security audit reports recorded for a skill on skills.sh (providers include " +
        "Agent Trust Hub, Socket, Snyk, Runlayer and ZeroLeaks), with per-audit status " +
        "(pass/warn/fail), summary and risk level. Audits are generated automatically after a " +
        "skill's first install; a skill with no audits returns NOT_FOUND.",
      inputSchema,
      annotations: { readOnlyHint: true },
    },
    async (args) => runTool(() => service.getSkillAudits(args.id)),
  );
}
