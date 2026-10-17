import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { SkillsError } from "../errors";

const RESERVED = /^(?:con(?:in\$|out\$)?|prn|aux|nul|clock\$|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])(?:\.|$)/i;
export const MAX_SKILL_FILES = 256;
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_SKILL_BYTES = 16 * 1024 * 1024;

export interface LocalFile {
  path: string;
  content: Buffer;
  sha: string;
  mode?: string;
}

/** Portable filenames: reject traversal, Windows devices, ADS, and ambiguous suffixes. */
export function safeSegment(value: string): boolean {
  return value.length > 0 && value.length <= 200 && value !== "." && value !== ".." &&
    !/[\x00-\x1f\x7f<>:"/\\|?*]/.test(value) && !/[. ]$/.test(value) && !RESERVED.test(value);
}

export function validateSkillName(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name) || !safeSegment(name)) {
    throw new SkillsError("INVALID_INPUT", "invalid skill name; use a single portable directory name");
  }
}

export async function optionalStat(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new SkillsError("FILESYSTEM_ERROR", "cannot inspect the configured skills directory");
  }
}

/** Resolve the administrator-configured root, never a caller-supplied path. */
export async function canonicalRoot(root: string): Promise<string> {
  if (!isAbsolute(root)) throw new SkillsError("INVALID_INPUT", "configured skill roots must be absolute paths");
  try {
    const path = await realpath(root);
    if (!(await lstat(path)).isDirectory()) throw new Error("not a directory");
    return path;
  } catch {
    throw new SkillsError("FILESYSTEM_ERROR", "configured skill root must be an existing directory");
  }
}

/** Every existing component below the approved root must be plain, not a symlink/junction. */
export async function safeChild(root: string, parts: string[]): Promise<string> {
  let path = root;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (!safeSegment(part)) throw new SkillsError("INVALID_INPUT", "unsafe skill path component");
    path = join(path, part);
    const info = await optionalStat(path);
    if (!info) continue;
    if (info.isSymbolicLink() || (i < parts.length - 1 && !info.isDirectory())) {
      throw new SkillsError("CONFLICT", "refusing a symlink, junction, or non-directory in a managed path");
    }
  }
  return path;
}

export async function readBoundedFile(path: string, maxBytes: number): Promise<Buffer> {
  const info = await optionalStat(path);
  if (!info?.isFile() || info.isSymbolicLink() || info.size > maxBytes) {
    throw new SkillsError("CONFLICT", "expected a bounded regular file, not a symlink or special file");
  }
  // Bound the actual read too: a file can grow after lstat. O_NOFOLLOW also
  // refuses a swapped final symlink on platforms that implement it.
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const current = await handle.stat();
    if (!current.isFile() || current.size > maxBytes) {
      throw new SkillsError("CONFLICT", "expected a bounded regular file");
    }
    const buffer = Buffer.alloc(Math.min(maxBytes + 1, Math.max(current.size + 1, 4096)));
    const chunks: Buffer[] = [];
    let bytes = 0;
    for (;;) {
      const length = Math.min(buffer.length, maxBytes + 1 - bytes);
      const result = await handle.read(buffer, 0, length, null);
      if (result.bytesRead === 0) return Buffer.concat(chunks, bytes);
      bytes += result.bytesRead;
      if (bytes > maxBytes) throw new SkillsError("CONFLICT", "file exceeds the supported size limit");
      chunks.push(Buffer.from(buffer.subarray(0, result.bytesRead)));
    }
  } catch (error) {
    if (error instanceof SkillsError) throw error;
    throw new SkillsError("FILESYSTEM_ERROR", "could not read a managed skill file safely");
  } finally {
    await handle?.close();
  }
}

export function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new SkillsError("CANCELLED", "skill operation was cancelled");
}

export function safeRelativePath(path: string): string[] {
  const parts = path.split("/");
  if (path.length > 500 || parts.length > 20 || parts.some((part) => !safeSegment(part))) {
    throw new SkillsError("CONFLICT", "unsafe or excessively deep skill file path");
  }
  return parts;
}

export function blobHash(content: Buffer): string {
  return createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
}

function textContent(content: Buffer): string | undefined {
  const text = content.toString("utf8");
  return !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text) && Buffer.from(text).equals(content) ? text : undefined;
}

/** Git on Windows can check out LF blobs as CRLF. Only accept that reversible text conversion. */
export function checkoutLf(content: Buffer): Buffer | undefined {
  const text = textContent(content);
  if (text === undefined || !text.includes("\r\n") || /[\r\n]/.test(text.replace(/\r\n/g, ""))) return undefined;
  return Buffer.from(text.replace(/\r\n/g, "\n"));
}

export function preserveCheckoutLineEndings(upstream: Buffer, current?: Buffer): Buffer {
  if (!current || !checkoutLf(current)) return upstream;
  const text = textContent(upstream);
  return text !== undefined && !text.includes("\r") ? Buffer.from(text.replace(/\n/g, "\r\n")) : upstream;
}

/** Matches skills CLI v1's computedHash contract (portable path + bytes, sorted). */
export function folderHash(files: LocalFile[]): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(file.path).update(file.content);
  }
  return hash.digest("hex");
}

/** A framed manifest for preview freshness, independent of the CLI's unframed hash. */
export function fingerprint(files: LocalFile[]): string {
  return createHash("sha256").update(JSON.stringify(files.map((file) =>
    [file.path, file.content.length, file.sha]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))))).digest("hex");
}

export async function readSkillFiles(root: string, signal?: AbortSignal): Promise<LocalFile[]> {
  const files: LocalFile[] = [];
  let bytes = 0;
  let visited = 0;
  const seen = new Set<string>();
  async function walk(parts: string[]): Promise<void> {
    throwIfCancelled(signal);
    for (const entry of await readdir(join(root, ...parts), { withFileTypes: true })) {
      const relative = [...parts, entry.name].join("/");
      safeRelativePath(relative);
      const key = relative.normalize("NFC").toLowerCase();
      if (seen.has(key)) throw new SkillsError("CONFLICT", "local skill contains case/Unicode-colliding paths");
      seen.add(key);
      if (++visited > 1_024) throw new SkillsError("CONFLICT", "too many skill filesystem entries");
      const path = await safeChild(root, [...parts, entry.name]);
      if (entry.isSymbolicLink()) throw new SkillsError("CONFLICT", "skill contains a symlink or junction");
      if (entry.isDirectory()) {
        // These are ignored by the CLI's local hash. Never silently discard user data there.
        if (entry.name === ".git" || entry.name === "node_modules") {
          throw new SkillsError("CONFLICT", "skill contains an unmanaged .git or node_modules directory");
        }
        await walk([...parts, entry.name]);
      } else if (entry.isFile()) {
        const content = await readBoundedFile(path, MAX_FILE_BYTES);
        bytes += content.length;
        if (files.length >= MAX_SKILL_FILES || bytes > MAX_SKILL_BYTES) {
          throw new SkillsError("CONFLICT", "skill exceeds supported file count or total size");
        }
        files.push({ path: relative, content, sha: blobHash(content) });
      } else {
        throw new SkillsError("CONFLICT", "skill contains a special filesystem entry");
      }
    }
  }
  try { await walk([]); } catch (error) {
    if (error instanceof SkillsError) throw error;
    throw new SkillsError("FILESYSTEM_ERROR", "could not read the managed skill directory");
  }
  return files;
}
