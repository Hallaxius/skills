/**
 * stderr-only logger. NEVER write to stdout — stdout carries the MCP protocol
 * when the server runs on stdio transport.
 *
 * Level is read from SKILLS_LOG_LEVEL on every call:
 * silent | error | warn | info (default) | debug
 */

const PREFIX = "skills-sh-mcp";

export type LogLevel = "silent" | "error" | "warn" | "info" | "debug";

const PRIORITY: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

function configuredLevel(): LogLevel {
  const raw = process.env["SKILLS_LOG_LEVEL"]?.trim().toLowerCase();
  return raw !== undefined && raw in PRIORITY ? (raw as LogLevel) : "info";
}

function write(level: Exclude<LogLevel, "silent">, message: string, data?: unknown): void {
  if (PRIORITY[level] > PRIORITY[configuredLevel()]) return;
  const line = `${new Date().toISOString()} ${PREFIX} ${level.toUpperCase()} ${message}`;
  // console.error writes to stderr in Bun (and Node).
  if (data === undefined) console.error(line);
  else console.error(line, data);
}

export const logger = {
  debug: (message: string, data?: unknown) => write("debug", message, data),
  info: (message: string, data?: unknown) => write("info", message, data),
  warn: (message: string, data?: unknown) => write("warn", message, data),
  error: (message: string, data?: unknown) => write("error", message, data),
} as const;
