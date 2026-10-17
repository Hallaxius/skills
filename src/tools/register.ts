import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SkillsApiService } from "../services/skills-api";
import type { LocalSkillsService } from "../services/local-skills";
import { registerOfficialSkillsTool } from "./official-skills.tool";
import { registerSearchSkillsTool } from "./search-skills.tool";
import { registerSkillAuditsTool } from "./skill-audits.tool";
import { registerSkillDetailTool } from "./skill-detail.tool";
import { registerTopSkillsTool } from "./top-skills.tool";
import { registerLocalSkillsTools } from "./local-skills.tool";

export function registerTools(
  server: McpServer,
  service: SkillsApiService,
  localSkills: LocalSkillsService,
): void {
  registerSearchSkillsTool(server, service);
  registerTopSkillsTool(server, service);
  registerSkillDetailTool(server, service);
  registerSkillAuditsTool(server, service);
  registerOfficialSkillsTool(server, service);
  registerLocalSkillsTools(server, localSkills);
}
