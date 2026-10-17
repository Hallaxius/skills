import { SkillsError } from "../errors";
import type { InstalledSkillEntry, ResolvedSkill, SkillFile, SkillSnapshot, SkillSource } from "../types/local-skills";
import { GITHUB_SOURCE } from "../utils/install";
import { RateLimiter } from "../utils/rate-limiter";
import { blobHash, MAX_FILE_BYTES, MAX_SKILL_BYTES, MAX_SKILL_FILES, safeRelativePath, throwIfCancelled } from "../utils/skill-files";

const SHA = /^[a-f0-9]{40}$/;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
// Keep these aligned with the official CLI's copyDirectory/snapshot exclusions.
// https://github.com/vercel-labs/skills/blob/v1.7.2/src/blob.ts
const EXCLUDED_DIRS = new Set([".git", "__pycache__", "__pypackages__"]);

interface GitHubOptions {
  token?: string;
  minIntervalMs?: number;
  timeoutMs?: number;
}

/** Fixed-host, bounded GitHub Git Data requests; no git, npm, shell, or skill execution. */
export class GitHubSkillsSource implements SkillSource {
  private readonly limiter: RateLimiter;

  constructor(private readonly fetchImpl: typeof globalThis.fetch = fetch,
    private readonly options: GitHubOptions = {}) {
    this.limiter = new RateLimiter(options.minIntervalMs ?? 500);
  }

  async latest(entry: InstalledSkillEntry, signal?: AbortSignal): Promise<SkillSnapshot> {
    const { source, folder, ref } = this.location(entry);
    const data = await this.request(`repos/${source}/git/trees/${encodeURIComponent(ref)}?recursive=1`, signal);
    return this.snapshot(data, folder);
  }

  async baseline(entry: InstalledSkillEntry, signal?: AbortSignal): Promise<SkillSnapshot> {
    const { source } = this.location(entry);
    if (!SHA.test(entry.skillFolderHash ?? "")) {
      throw new SkillsError("UNSUPPORTED_SOURCE", "global CLI lock has no valid immutable folder baseline");
    }
    return this.snapshot(await this.request(`repos/${source}/git/trees/${entry.skillFolderHash}?recursive=1`, signal), "");
  }

  async readFile(entry: InstalledSkillEntry, file: SkillFile, signal?: AbortSignal): Promise<Buffer> {
    const { source } = this.location(entry);
    if (!SHA.test(file.sha)) throw new SkillsError("PARSE_ERROR", "invalid GitHub blob hash");
    const data = await this.request(`repos/${source}/git/blobs/${file.sha}`, signal);
    if (!record(data) || data["encoding"] !== "base64" || typeof data["content"] !== "string" ||
      typeof data["size"] !== "number" || data["size"] > MAX_FILE_BYTES || data["size"] < 0) {
      throw new SkillsError("PARSE_ERROR", "GitHub returned an unsupported or oversized blob");
    }
    const content = Buffer.from(data["content"], "base64");
    if (content.length !== data["size"] || content.length > MAX_FILE_BYTES || blobHash(content) !== file.sha ||
      (file.size !== undefined && content.length !== file.size)) {
      throw new SkillsError("UPSTREAM_CHANGED", "GitHub blob content does not match its immutable hash or size");
    }
    return content;
  }

  /** Resolve one skill folder in a repository's default-branch tree (install only). */
  async resolve(source: string, skill: string, folder: string | undefined, signal?: AbortSignal): Promise<ResolvedSkill> {
    if (!GITHUB_SOURCE.test(source) || [".", ".."].includes(source.split("/")[1]!) ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(skill)) {
      throw new SkillsError("UNSUPPORTED_SOURCE", "install requires a GitHub {owner}/{repo} source and a portable skill name");
    }
    if (folder !== undefined) safeRelativePath(folder);
    const data = await this.request(`repos/${source}/git/trees/HEAD?recursive=1`, signal);
    if (!record(data) || !SHA.test(String(data["sha"])) || !Array.isArray(data["tree"]) || data["truncated"] !== false) {
      throw new SkillsError("PARSE_ERROR", "GitHub tree is invalid or truncated; refusing an incomplete snapshot");
    }
    let resolved = folder;
    if (resolved === undefined) {
      const wanted = skill.normalize("NFC").toLowerCase();
      const candidates = new Set<string>();
      for (const entry of data["tree"]) {
        if (!record(entry) || typeof entry["path"] !== "string" || entry["type"] !== "blob") continue;
        const path = entry["path"];
        if (path !== "SKILL.md" && !path.endsWith("/SKILL.md")) continue;
        const candidate = path === "SKILL.md" ? "" : path.slice(0, -9);
        const basename = candidate ? candidate.split("/").at(-1)! : source.split("/")[1]!;
        if (basename.normalize("NFC").toLowerCase() === wanted) candidates.add(candidate);
      }
      if (candidates.size === 0) {
        throw new SkillsError("NOT_FOUND", `no folder containing SKILL.md is named "${skill}" in ${source}`);
      }
      if (candidates.size > 1) {
        const list = [...candidates].sort();
        throw new SkillsError("CONFLICT", `multiple skill folders match "${skill}" in ${source}: ` +
          `${list.slice(0, 5).join(", ")}${list.length > 5 ? ", ..." : ""}; pass the repo-relative "path" to choose one`);
      }
      resolved = [...candidates][0]!;
    }
    const snapshot = this.snapshot(data, resolved);
    return { entry: { source, sourceType: "github", skillPath: resolved ? `${resolved}/SKILL.md` : "SKILL.md" }, snapshot };
  }

  private location(entry: InstalledSkillEntry) {
    if (entry.sourceType !== "github" || !GITHUB_SOURCE.test(entry.source) ||
      [".", ".."].includes(entry.source.split("/")[1]!) || typeof entry.skillPath !== "string" ||
      !(entry.skillPath === "SKILL.md" || entry.skillPath.endsWith("/SKILL.md"))) {
      throw new SkillsError("UNSUPPORTED_SOURCE", "updates require a GitHub CLI lock entry with a recorded SKILL.md path");
    }
    safeRelativePath(entry.skillPath);
    if (entry.ref !== undefined && (typeof entry.ref !== "string" || entry.ref.length === 0 ||
      entry.ref.length > 200 || /[\x00-\x1f\x7f]/.test(entry.ref))) {
      throw new SkillsError("UNSUPPORTED_SOURCE", "invalid recorded GitHub ref");
    }
    return { source: entry.source, folder: entry.skillPath === "SKILL.md" ? "" : entry.skillPath.slice(0, -9),
      ref: entry.ref ?? "HEAD" };
  }

  private snapshot(data: unknown, folder: string): SkillSnapshot {
    if (!record(data) || !SHA.test(String(data["sha"])) || !Array.isArray(data["tree"]) || data["truncated"] !== false) {
      throw new SkillsError("PARSE_ERROR", "GitHub tree is invalid or truncated; refusing an incomplete snapshot");
    }
    const tree = data["tree"];
    const root = folder ? tree.find((entry) => record(entry) && entry["type"] === "tree" && entry["path"] === folder) : data;
    if (!record(root) || !SHA.test(String(root["sha"]))) throw new SkillsError("NOT_FOUND", "recorded skill folder no longer exists upstream");
    const files: SkillFile[] = [];
    const seen = new Set<string>();
    const components = new Map<string, { path: string; file: boolean }>();
    let bytes = 0;
    for (const entry of tree) {
      if (!record(entry) || typeof entry["path"] !== "string") throw new SkillsError("PARSE_ERROR", "invalid GitHub tree entry");
      if (folder && !entry["path"].startsWith(folder + "/")) continue;
      const path = folder ? entry["path"].slice(folder.length + 1) : entry["path"];
      const parts = safeRelativePath(path);
      if (parts.at(-1) === "metadata.json" || parts.some((part) => EXCLUDED_DIRS.has(part))) continue;
      for (let i = 0; i < parts.length; i++) {
        const component = parts.slice(0, i + 1).join("/");
        const file = i === parts.length - 1 && entry["type"] !== "tree";
        const key = component.normalize("NFC").toLowerCase();
        const previous = components.get(key);
        if (previous && (previous.path !== component || previous.file !== file)) {
          throw new SkillsError("CONFLICT", "upstream has case/Unicode-colliding paths or file/directory collisions");
        }
        components.set(key, { path: component, file });
      }
      if (entry["type"] === "tree") continue;
      if (parts.includes("node_modules") || entry["type"] !== "blob" ||
        (entry["mode"] !== "100644" && entry["mode"] !== "100755")) {
        throw new SkillsError("CONFLICT", "upstream skill contains a symlink, submodule, or unsupported entry");
      }
      if (!SHA.test(String(entry["sha"])) || (entry["size"] !== undefined &&
        (typeof entry["size"] !== "number" || !Number.isSafeInteger(entry["size"]) || entry["size"] < 0 || entry["size"] > MAX_FILE_BYTES))) {
        throw new SkillsError("PARSE_ERROR", "invalid or oversized GitHub file metadata");
      }
      const key = path.normalize("NFC").toLowerCase();
      if (seen.has(key)) throw new SkillsError("CONFLICT", "upstream has duplicate or case-colliding file paths");
      seen.add(key);
      bytes += typeof entry["size"] === "number" ? entry["size"] : 0;
      if (files.length >= MAX_SKILL_FILES || bytes > MAX_SKILL_BYTES) throw new SkillsError("CONFLICT", "upstream skill exceeds supported size limits");
      files.push({ path, sha: String(entry["sha"]), mode: entry["mode"],
        ...(typeof entry["size"] === "number" ? { size: entry["size"] } : {}) });
    }
    if (!files.some((file) => file.path === "SKILL.md")) throw new SkillsError("NOT_FOUND", "upstream snapshot has no SKILL.md");
    return { folderHash: String(root["sha"]), files };
  }

  private async request(endpoint: string, signal?: AbortSignal): Promise<unknown> {
    return this.limiter.run(async () => {
      throwIfCancelled(signal);
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal?.addEventListener("abort", abort, { once: true });
      const timeoutMs = this.options.timeoutMs ?? 10_000;
      const timer = setTimeout(abort, timeoutMs);
      try {
        const response = await this.fetchImpl(`https://api.github.com/${endpoint}`, {
          method: "GET", redirect: "error", signal: controller.signal,
          headers: { Accept: "application/vnd.github+json", "User-Agent": "skills-sh-mcp/1.1.0",
            ...(this.options.token ? { Authorization: `Bearer ${this.options.token}` } : {}) },
        });
        if (!response.ok) {
          await response.body?.cancel();
          if (response.status === 429 || (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0")) {
            throw new SkillsError("RATE_LIMITED", "GitHub API rate limit reached; retry later or configure GITHUB_TOKEN");
          }
          throw new SkillsError(response.status === 404 ? "NOT_FOUND" : "UPSTREAM_ERROR", `GitHub API returned HTTP ${response.status}`);
        }
        if (!response.body) throw new SkillsError("PARSE_ERROR", "GitHub returned an empty response");
        const reader = response.body.getReader();
        const chunks: Buffer[] = [];
        let bytes = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > MAX_RESPONSE_BYTES) {
              await reader.cancel();
              throw new SkillsError("PARSE_ERROR", "GitHub response exceeds the supported size limit");
            }
            chunks.push(Buffer.from(value));
          }
        } finally { reader.releaseLock(); }
        try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
        catch { throw new SkillsError("PARSE_ERROR", "GitHub returned invalid JSON"); }
      } catch (error) {
        throwIfCancelled(signal);
        if (error instanceof SkillsError) throw error;
        if (controller.signal.aborted) throw new SkillsError("TIMEOUT", `GitHub request timed out after ${timeoutMs}ms`);
        throw new SkillsError("NETWORK_ERROR", "GitHub request failed (redirects are not followed)");
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      }
    });
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
