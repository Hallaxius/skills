import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SkillsApiService } from "../services/skills-api";
import { registerOfficialSkillsTool } from "./official-skills.tool";
import { registerSearchSkillsTool } from "./search-skills.tool";
import { registerSkillAuditsTool } from "./skill-audits.tool";
import { registerSkillDetailTool } from "./skill-detail.tool";
import { registerTopSkillsTool } from "./top-skills.tool";

export function registerTools(server: McpServer, service: SkillsApiService): void {
  registerSearchSkillsTool(server, service);
  registerTopSkillsTool(server, service);
  registerSkillDetailTool(server, service);
  registerSkillAuditsTool(server, service);
  registerOfficialSkillsTool(server, service);
}
