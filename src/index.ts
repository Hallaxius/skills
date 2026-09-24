#!/usr/bin/env node
/**
 * Entry point. Runs the MCP server on stdio. Logs go to stderr only —
 * stdout is reserved for the MCP protocol.
 *
 * The shebang is "#!/usr/bin/env node" because the published npm package is
 * executed by npx/npm bin shims under Node. The file itself stays runtime
 * neutral (no Bun-specific APIs), so `bun run src/index.ts` works identically.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server";
import { logger } from "./utils/logger";

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("running on stdio transport");
}

main().catch((error: unknown) => {
  logger.error(`fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  process.exit(1);
});
