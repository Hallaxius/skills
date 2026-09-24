const NEXT_F_PUSH = /self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g;

/**
 * Reassembles the RSC (React Server Components) flight payload embedded in a
 * skills.sh HTML page. Next.js App Router streams the payload as a sequence of
 * JSON-escaped strings pushed via `self.__next_f.push([1,"…"])`.
 */
export function extractRscPayload(html: string): string {
  const chunks: string[] = [];
  for (const match of html.matchAll(NEXT_F_PUSH)) {
    const escaped = match[1];
    if (escaped === undefined) continue;
    try {
      chunks.push(JSON.parse(`"${escaped}"`) as string);
    } catch {
      // Skip a malformed chunk rather than failing the whole page.
    }
  }
  return chunks.join("");
}

/**
 * Finds `"key":<json>` in an RSC payload and returns the parsed JSON value.
 * Uses bracket matching (string/escape aware) so nested arrays and objects
 * are captured correctly, e.g. `"initialSkills":[{…},{…}]`.
 * Returns undefined when the key is absent or the value is not a JSON
 * object/array (or fails to parse).
 */
export function extractJsonValue(payload: string, key: string): unknown {
  const marker = `"${key}":`;
  const markerAt = payload.indexOf(marker);
  if (markerAt === -1) return undefined;
  const valueStart = skipWhitespace(payload, markerAt + marker.length);
  const first = payload[valueStart];
  if (first !== "[" && first !== "{") return undefined;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = valueStart; i < payload.length; i++) {
    const ch = payload[i];
    if (ch === undefined) break;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "[" || ch === "{") {
      depth++;
    } else if (ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) {
        const slice = payload.slice(valueStart, i + 1);
        try {
          return JSON.parse(slice) as unknown;
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

function skipWhitespace(input: string, from: number): number {
  let i = from;
  while (i < input.length && /\s/.test(input[i] ?? "")) i++;
  return i;
}
