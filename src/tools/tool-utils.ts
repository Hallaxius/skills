import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { formatErrorForTool } from "../errors";
import { logger } from "../utils/logger";

/** Serializes a tool payload as a single text block. */
export function jsonResult(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

/**
 * Runs a tool handler, converting any thrown error into a stable
 * `[CODE] message` text result with isError: true (recoverable failures are
 * reported as tool results, not protocol errors).
 */
export async function runTool(task: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return jsonResult(await task());
  } catch (error) {
    logger.error("tool call failed", error);
    return { content: [{ type: "text", text: formatErrorForTool(error) }], isError: true };
  }
}
