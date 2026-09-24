/**
 * stderr-only logger. NEVER write to stdout — stdout carries the MCP protocol
 * when the server runs on stdio transport.
 */

const PREFIX = "skills-sh-mcp";

function write(level: string, message: string, data?: unknown): void {
  const line = `${new Date().toISOString()} ${PREFIX} ${level} ${message}`;
  // console.error writes to stderr in Bun (and Node).
  if (data === undefined) console.error(line);
  else console.error(line, data);
}

export const logger = {
  info: (message: string, data?: unknown) => write("INFO", message, data),
  warn: (message: string, data?: unknown) => write("WARN", message, data),
  error: (message: string, data?: unknown) => write("ERROR", message, data),
} as const;
