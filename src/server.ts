import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { homedir } from "node:os";
import { loadConfig, type Config } from "./config";
import { SkillsApiService } from "./services/skills-api";
import { LocalSkillsService } from "./services/local-skills";
import { GitHubSkillsSource } from "./services/github-skills";
import { registerTools } from "./tools/register";
import { HttpClient } from "./utils/http";
import { logger } from "./utils/logger";
import { RateLimiter } from "./utils/rate-limiter";

export const SERVER_NAME = "skills-sh-mcp";
export const SERVER_VERSION = "1.1.0";

/** Wires the HTTP layer and the skills.sh service (config from the environment). */
export function createSkillsService(config: Config = loadConfig()): SkillsApiService {
  const limiter = new RateLimiter(config.minRequestIntervalMs);
  const userAgent =
    `${SERVER_NAME}/${SERVER_VERSION} (unofficial MCP server for skills.sh; ` +
    "respects robots.txt and rate limits)";
  const http = new HttpClient(limiter, userAgent, fetch, config.requestTimeoutMs);
  return new SkillsApiService(http, config);
}

/** Wires canonical local storage and an optional-auth GitHub source; no I/O until a tool call. */
export function createLocalSkillsService(
  config: Config = loadConfig(),
  fetchImpl: typeof globalThis.fetch = fetch,
): LocalSkillsService {
  const source = new GitHubSkillsSource(fetchImpl, {
    token: config.githubToken,
    minIntervalMs: config.minRequestIntervalMs,
    timeoutMs: config.requestTimeoutMs,
  });
  return new LocalSkillsService({
    projectRoot: config.projectRoot,
    homeDir: config.homeDir ?? homedir(),
    globalStateRoot: config.globalStateRoot,
    allowMutations: config.allowMutations === true,
  }, source);
}

/** Creates the MCP server with all tools registered. */
export function createServer(
  service: SkillsApiService = createSkillsService(),
  localSkills: LocalSkillsService = createLocalSkillsService(),
): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerTools(server, service, localSkills);
  logger.info(`server created: ${SERVER_NAME}@${SERVER_VERSION}`);
  return server;
}
