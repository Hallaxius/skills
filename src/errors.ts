/**
 * Error taxonomy for the whole server. Every failure surfaced to MCP clients
 * is expressed as one of these codes, rendered as `[CODE] message` in tool
 * results (`isError: true`).
 */
export type SkillsErrorCode =
  | "NETWORK_ERROR"
  | "TIMEOUT"
  | "RATE_LIMITED"
  | "NOT_FOUND"
  | "INVALID_INPUT"
  | "PARSE_ERROR"
  | "UPSTREAM_CHANGED"
  | "UPSTREAM_ERROR";

export class SkillsError extends Error {
  readonly code: SkillsErrorCode;

  constructor(code: SkillsErrorCode, message: string) {
    super(message);
    this.name = "SkillsError";
    this.code = code;
  }
}

/** Stable text rendering used inside MCP tool results. */
export function formatErrorForTool(error: unknown): string {
  if (error instanceof SkillsError) {
    return `[${error.code}] ${error.message}`;
  }
  if (error instanceof Error) {
    return `[UPSTREAM_ERROR] unexpected internal error: ${error.message}`;
  }
  return `[UPSTREAM_ERROR] unexpected internal error: ${String(error)}`;
}
