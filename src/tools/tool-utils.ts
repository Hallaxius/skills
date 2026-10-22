import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { SkillsError, formatErrorForTool } from "../errors";
import { logger } from "../utils/logger";

/** Serializes a tool payload as a single text block. */
export function jsonResult(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

/**
 * Runs a tool handler, converting any thrown error into a stable
 * `[CODE] message` text result with isError: true (recoverable failures are
 * reported as tool results, not protocol errors).
 *
 * Expected `SkillsError`s are client-facing outcomes, so they are logged at
 * debug level without a stack trace; only unexpected failures are logged as
 * errors, where the stack trace helps diagnose a real bug.
 */
export async function runTool(task: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return jsonResult(await task());
  } catch (error) {
    if (error instanceof SkillsError) {
      logger.debug(`tool call failed: ${formatErrorForTool(error)}`);
    } else {
      logger.error("tool call failed", error);
    }
    return { content: [{ type: "text", text: formatErrorForTool(error) }], isError: true };
  }
}
