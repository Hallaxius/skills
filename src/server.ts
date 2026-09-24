import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig, type Config } from "./config";
import { SkillsApiService } from "./services/skills-api";
import { registerTools } from "./tools/register";
import { HttpClient } from "./utils/http";
import { logger } from "./utils/logger";
import { RateLimiter } from "./utils/rate-limiter";

export const SERVER_NAME = "skills-sh-mcp";
export const SERVER_VERSION = "1.0.0";

/** Wires the HTTP layer and the skills.sh service (config from the environment). */
export function createSkillsService(config: Config = loadConfig()): SkillsApiService {
  const limiter = new RateLimiter(config.minRequestIntervalMs);
  const userAgent =
    `${SERVER_NAME}/${SERVER_VERSION} (unofficial MCP server for skills.sh; ` +
    "respects robots.txt and rate limits)";
  const http = new HttpClient(limiter, userAgent, fetch, config.requestTimeoutMs);
  return new SkillsApiService(http, config);
}

/** Creates the MCP server with all tools registered. */
export function createServer(service: SkillsApiService = createSkillsService()): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerTools(server, service);
  logger.info(`server created: ${SERVER_NAME}@${SERVER_VERSION}`);
  return server;
}
