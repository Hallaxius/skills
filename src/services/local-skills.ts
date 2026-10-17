import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, open, readdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { SkillsError } from "../errors";
import type { CheckUpdatesInput, InstallSkillInput, InstalledSkillEntry, ListInstalledInput, LocalSkillsOptions, SkillMutationInput, SkillScope, SkillSnapshot, SkillSource } from "../types/local-skills";
import { GITHUB_SOURCE } from "../utils/install";
import { blobHash, canonicalRoot, checkoutLf, fingerprint, folderHash, MAX_FILE_BYTES, MAX_SKILL_BYTES, optionalStat, preserveCheckoutLineEndings, readBoundedFile, readSkillFiles, safeChild, safeRelativePath, throwIfCancelled, validateSkillName, type LocalFile } from "../utils/skill-files";
import { parseSkillId } from "../utils/validate";
import { logger } from "../utils/logger";

interface ScopePaths {
  root: string;
  agents: string;
  skills: string;
  lockRoot: string;
  lockParts: string[];
  lockPath: string;
}

interface SkillLock extends Record<string, unknown> {
  version: number;
  skills: Record<string, InstalledSkillEntry>;
}

interface LockState {
  raw?: string;
  data: SkillLock;
}

interface Target {
  paths: ScopePaths;
  lock: LockState;
  entry: InstalledSkillEntry;
  path: string;
  files: LocalFile[];
}

interface Assessment {
  status: "update_available" | "up_to_date" | "local_changes" | "unknown" | "unsupported";
  snapshot?: SkillSnapshot;
  reason?: string;
}

export class LocalSkillsService {
  constructor(private readonly options: LocalSkillsOptions, private readonly source?: SkillSource,
    private readonly move: typeof rename = rename) {}

  async listInstalled(input: ListInstalledInput) {
    const paths = await this.paths(input.scope);
    const lock = await this.readLock(paths, input.scope);
    const skills = [];
    const warnings: string[] = [];
    const directory = await optionalStat(paths.skills);
    if (directory) {
      if (!directory.isDirectory()) throw new SkillsError("CONFLICT", "canonical skills path is not a directory");
      const entries = await readdir(paths.skills, { withFileTypes: true }).catch(() => {
        throw new SkillsError("FILESYSTEM_ERROR", "cannot list the configured skills directory");
      });
      if (entries.length > 2_000) throw new SkillsError("CONFLICT", "too many skill directories (maximum 2000)");
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        try { validateSkillName(entry.name); } catch { continue; }
        const marker = await optionalStat(join(paths.skills, entry.name, "SKILL.md"));
        if (!marker?.isFile() || marker.isSymbolicLink()) continue;
        const metadata = Object.hasOwn(lock.data.skills, entry.name) ? lock.data.skills[entry.name] : undefined;
        skills.push({ name: entry.name, scope: input.scope, path: join(paths.skills, entry.name),
          managed: metadata !== undefined, source: metadata?.source, sourceType: metadata?.sourceType,
          skillPath: metadata?.skillPath, ref: metadata?.ref });
      }
    }
    if (!lock.raw && skills.length) warnings.push("No CLI lock file; untracked skills cannot be mutated safely.");
    const offset = input.offset ?? 0;
    const limit = input.limit ?? 50;
    return { scope: input.scope, directory: paths.skills, total: skills.length, offset, limit,
      skills: skills.slice(offset, offset + limit), warnings };
  }

  async removeSkill(input: SkillMutationInput, signal?: AbortSignal) {
    this.authorize(input);
    const target = await this.target(input, signal);
    const confirmation_token = this.token("remove", input, target);
    const result = { status: "preview", name: input.name, scope: input.scope, path: target.path,
      source: target.entry.source, files: target.files.length, confirmation_token,
      warnings: ["Only the canonical .agents skill is removed; other agents' copies or links are not modified."] };
    if (input.dry_run !== false) return result;
    this.confirm(input, confirmation_token);
    await this.commit(input, target, undefined, undefined, signal);
    return { ...result, status: "removed" };
  }

  async checkUpdates(input: CheckUpdatesInput, signal?: AbortSignal) {
    if (input.name) validateSkillName(input.name);
    const inventory = await this.listInstalled({ scope: input.scope, limit: 2_000 });
    const selected = input.name ? inventory.skills.filter((skill) => skill.name === input.name) : inventory.skills;
    if (input.name && !selected.length) throw new SkillsError("NOT_FOUND", "skill is not installed in this canonical scope");
    const offset = input.offset ?? 0;
    const limit = input.limit ?? 20;
    const skills = [];
    for (const skill of selected.slice(offset, offset + limit)) {
      throwIfCancelled(signal);
      try {
        const target = await this.target({ scope: input.scope, name: skill.name }, signal);
        const assessment = await this.assess(target, input.scope, signal);
        skills.push({ name: skill.name, scope: input.scope, path: skill.path, source: skill.source,
          status: assessment.status, reason: assessment.reason, latest_hash: assessment.snapshot?.folderHash });
      } catch (error) {
        throwIfCancelled(signal);
        skills.push({ name: skill.name, scope: input.scope, path: skill.path, source: skill.source,
          status: "unknown", reason: error instanceof SkillsError ? `[${error.code}] ${error.message}` : "could not inspect skill" });
      }
    }
    return { scope: input.scope, total: selected.length, offset, limit, skills };
  }

  async updateSkill(input: SkillMutationInput, signal?: AbortSignal) {
    this.authorize(input);
    const target = await this.target(input, signal);
    const assessment = await this.assess(target, input.scope, signal);
    if (assessment.status === "unsupported") throw new SkillsError("UNSUPPORTED_SOURCE", assessment.reason!);
    if (!assessment.snapshot || assessment.status === "local_changes" || assessment.status === "unknown") {
      throw new SkillsError("CONFLICT", assessment.reason ?? "cannot prove a safe update baseline");
    }
    const snapshot = assessment.snapshot;
    const confirmation_token = this.token("update", input, target, snapshot.folderHash);
    const result = { status: assessment.status === "up_to_date" ? "up_to_date" : "preview",
      name: input.name, scope: input.scope, path: target.path, source: target.entry.source,
      files: snapshot.files.length, latest_hash: snapshot.folderHash, confirmation_token,
      warnings: ["Only the canonical .agents skill is updated; other agents' copies or links are not modified.",
        "Existing uniform CRLF text files retain their line endings; new files use upstream bytes.",
        "Upstream skill instructions and scripts are untrusted content; no bundled script is executed."] };
    if (input.dry_run !== false) return result;
    this.confirm(input, confirmation_token);
    if (assessment.status === "up_to_date") return result;

    const files = await this.download(target.entry, snapshot, target.files, signal);
    const entry = { ...target.entry, ...(input.scope === "project"
      ? { computedHash: folderHash(files), skillFolderHash: snapshot.folderHash }
      : { skillFolderHash: snapshot.folderHash, updatedAt: new Date().toISOString() }) };
    await this.commit(input, target, files, entry, signal);
    return { ...result, status: "updated" };
  }

  async installSkill(input: InstallSkillInput, signal?: AbortSignal) {
    this.authorizeMutation(input);
    const source = this.source;
    if (!source?.resolve) {
      throw new SkillsError("UNSUPPORTED_SOURCE", "installation needs the configured GitHub source; it is not available in this environment");
    }
    const parts = parseSkillId(input.id);
    if (!parts) {
      throw new SkillsError("INVALID_INPUT", 'invalid skill id; expected "{owner}/{repo}/{skill}" (e.g. vercel-labs/skills/find-skills)');
    }
    if (!GITHUB_SOURCE.test(parts.source) || [".", ".."].includes(parts.source.split("/")[1]!)) {
      throw new SkillsError("UNSUPPORTED_SOURCE", "install supports GitHub sources only ({owner}/{repo}/{skill}); well-known domains are installed with the official CLI");
    }
    validateSkillName(parts.slug);
    const paths = await this.paths(input.scope);
    const lock = await this.readLock(paths, input.scope);
    const resolved = await source.resolve(parts.source, parts.slug, input.path, signal);
    const skillPath = resolved.entry.skillPath;
    if (typeof skillPath !== "string" || (skillPath !== "SKILL.md" && !skillPath.endsWith("/SKILL.md"))) {
      throw new SkillsError("UNSUPPORTED_SOURCE", "the resolved skill path must be a repo-relative path ending in SKILL.md");
    }
    safeRelativePath(skillPath);
    const folder = skillPath === "SKILL.md" ? "" : skillPath.slice(0, -9);
    const name = folder ? folder.split("/").at(-1)! : parts.source.split("/")[1]!;
    validateSkillName(name);
    const path = await safeChild(paths.root, [".agents", "skills", name]);
    const lockName = Object.keys(lock.data.skills).find((key) => portableName(key) === portableName(name));
    if (lockName !== undefined) {
      throw new SkillsError("CONFLICT", `"${lockName}" already has a lock entry in this scope; remove it before installing`);
    }
    const existing = (await readdir(paths.skills).catch(() => [] as string[]))
      .find((entry) => portableName(entry) === portableName(name));
    if (existing !== undefined || await optionalStat(path)) {
      throw new SkillsError("CONFLICT", `the canonical skill directory for "${existing ?? name}" already exists; remove it before installing`);
    }
    const mutation: SkillMutationInput = { scope: input.scope, name, dry_run: input.dry_run,
      confirm: input.confirm, confirmation_token: input.confirmation_token };
    const confirmation_token = this.token("install", mutation,
      { paths, lock, entry: resolved.entry, path, files: [] },
      `${parts.source}\n${skillPath}\n${resolved.snapshot.folderHash}`);
    const bytes = resolved.snapshot.files.reduce((total, file) => total + (file.size ?? 0), 0);
    const result = { status: "preview", name, scope: input.scope, path, directory: paths.skills,
      source: parts.source, sourceType: "github", skillPath: resolved.entry.skillPath,
      latest_hash: resolved.snapshot.folderHash, files: resolved.snapshot.files.length, bytes, confirmation_token,
      warnings: ["Only the canonical .agents skill is created; other agents' copies or links are not modified.",
        "Existing directories and lock entries are never overwritten; install refuses a name collision.",
        "Upstream skill instructions and scripts are untrusted content; no bundled script is executed."] };
    if (input.dry_run !== false) return result;
    this.confirm(mutation, confirmation_token);
    const files = await this.download(resolved.entry, resolved.snapshot, undefined, signal);
    throwIfCancelled(signal);
    const entry: InstalledSkillEntry = { source: parts.source, sourceType: "github", skillPath: resolved.entry.skillPath,
      skillFolderHash: resolved.snapshot.folderHash,
      ...(input.scope === "global" ? { updatedAt: new Date().toISOString() } : {}) };
    await this.ensureDirectory(paths.agents);
    await this.ensureDirectory(paths.skills);
    await this.ensureDirectory(dirname(paths.lockPath));
    await this.commit(mutation, { paths, lock, entry: resolved.entry, path, files: [] }, files, entry, signal, "create");
    return { ...result, status: "installed" };
  }

  /** Fetch every immutable blob and verify it before it can be written. */
  private async download(entry: InstalledSkillEntry, snapshot: SkillSnapshot, current: LocalFile[] | undefined,
    signal?: AbortSignal): Promise<LocalFile[]> {
    const source = this.source;
    if (!source) throw new SkillsError("UNSUPPORTED_SOURCE", "no upstream source is configured");
    const files: LocalFile[] = [];
    let bytes = 0;
    for (const file of snapshot.files) {
      throwIfCancelled(signal);
      const content = await source.readFile(entry, file, signal);
      if (content.length > MAX_FILE_BYTES || blobHash(content) !== file.sha) {
        throw new SkillsError("UPSTREAM_CHANGED", "downloaded skill does not match its bounded immutable snapshot");
      }
      const currentFile = current?.find((local) => local.path.normalize("NFC") === file.path.normalize("NFC"));
      const stored = preserveCheckoutLineEndings(content, currentFile?.content);
      bytes += stored.length;
      if (stored.length > MAX_FILE_BYTES || bytes > MAX_SKILL_BYTES) {
        throw new SkillsError("CONFLICT", "skill exceeds supported size limits after checkout conversion");
      }
      files.push({ path: file.path, content: stored, sha: blobHash(stored), mode: file.mode });
    }
    return files;
  }

  private async ensureDirectory(path: string): Promise<void> {
    const info = await optionalStat(path);
    if (info) {
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new SkillsError("CONFLICT", "refusing a symlink, junction, or non-directory in a managed path");
      }
      return;
    }
    try { await mkdir(path, { recursive: true }); }
    catch { throw new SkillsError("FILESYSTEM_ERROR", "cannot create the configured skills directory"); }
  }

  private async assess(target: Target, scope: SkillScope, signal?: AbortSignal): Promise<Assessment> {
    if (!this.source || target.entry.sourceType !== "github" || typeof target.entry.skillPath !== "string") {
      return { status: "unsupported", reason: "updates support GitHub CLI entries with a recorded SKILL.md path only" };
    }
    if (scope === "project") {
      if (!/^[a-f0-9]{64}$/.test(target.entry.computedHash ?? "")) return { status: "unknown", reason: "CLI lock has no valid local content baseline" };
      if (folderHash(target.files) !== target.entry.computedHash) return { status: "local_changes", reason: "local content differs from the CLI lock; it will not be overwritten" };
    } else if (!/^[a-f0-9]{40}$/.test(target.entry.skillFolderHash ?? "")) {
      return { status: "unknown", reason: "CLI lock has no valid immutable GitHub folder baseline" };
    }
    const snapshot = await this.source.latest(target.entry, signal);
    if (/^[a-f0-9]{40}$/.test(target.entry.skillFolderHash ?? "")) {
      const baseline = snapshot.folderHash === target.entry.skillFolderHash ? snapshot : await this.source.baseline(target.entry, signal);
      if (!sameFiles(target.files, baseline.files, true)) return { status: "local_changes", snapshot, reason: "local content differs from the installed GitHub tree; it will not be overwritten" };
      return { status: snapshot.folderHash === target.entry.skillFolderHash ? "up_to_date" : "update_available", snapshot };
    }
    if (sameFiles(target.files, snapshot.files, true)) return { status: "up_to_date", snapshot };
    // CLI v1 concatenates unframed paths and bytes: equality cannot prove the old file tree.
    return { status: "unknown", reason: "the legacy project CLI hash cannot prove the original installed tree; local files differ from current upstream, so updating could overwrite edits" };
  }

  private authorize(input: SkillMutationInput): void {
    validateSkillName(input.name);
    this.authorizeMutation(input);
  }

  private authorizeMutation(input: Pick<SkillMutationInput, "dry_run" | "confirm" | "confirmation_token">): void {
    if (input.dry_run !== false) return;
    if (!this.options.allowMutations) {
      throw new SkillsError("PERMISSION_DENIED", "local mutations are disabled; set SKILLS_ALLOW_MUTATIONS=true in the server environment");
    }
    if (!input.confirm || !/^[a-f0-9]{64}$/.test(input.confirmation_token ?? "")) {
      throw new SkillsError("PERMISSION_DENIED", "execution requires confirm=true and the confirmation_token from a fresh dry run");
    }
  }

  private confirm(input: SkillMutationInput, token: string): void {
    if (input.confirmation_token !== token) {
      throw new SkillsError("CONFLICT", "the skill, lock, or upstream changed after preview; run a fresh dry run");
    }
  }

  private token(operation: string, input: SkillMutationInput, target: Target, remoteHash = ""): string {
    return createHash("sha256").update(JSON.stringify([operation, input.scope, input.name,
      target.path, target.lock.raw, fingerprint(target.files), remoteHash])).digest("hex");
  }

  private async target(input: Pick<SkillMutationInput, "name" | "scope">, signal?: AbortSignal): Promise<Target> {
    throwIfCancelled(signal);
    validateSkillName(input.name);
    const paths = await this.paths(input.scope);
    const lock = await this.readLock(paths, input.scope);
    if (!Object.hasOwn(lock.data.skills, input.name)) {
      throw new SkillsError("CONFLICT", "skill has no entry in this scope's CLI lock; refusing to mutate an untracked directory");
    }
    const path = await safeChild(paths.root, [".agents", "skills", input.name]);
    if (!(await optionalStat(path))?.isDirectory()) throw new SkillsError("NOT_FOUND", "canonical skill directory was not found");
    await readBoundedFile(await safeChild(path, ["SKILL.md"]), 2 * 1024 * 1024);
    return { paths, lock, entry: lock.data.skills[input.name]!, path, files: await readSkillFiles(path, signal) };
  }

  /** Staged renames with exception rollback. Other writers must respect the guard.
   *  `replace` swaps an existing directory; `create` installs a brand-new skill. */
  private async commit(input: SkillMutationInput, original: Target, nextFiles?: LocalFile[],
    nextEntry?: InstalledSkillEntry, signal?: AbortSignal, mode: "replace" | "create" = "replace"): Promise<void> {
    const { paths } = original;
    const guardPath = await safeChild(paths.root, [".agents", ".skills-mcp.lock"]);
    const owner = randomUUID();
    try {
      const handle = await open(guardPath, "wx", 0o600);
      try { await handle.writeFile(owner); } finally { await handle.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new SkillsError("CONFLICT", "another local mutation is active; do not remove its guard until its owner has stopped");
      }
      throw new SkillsError("FILESYSTEM_ERROR", "cannot acquire the local mutation guard");
    }
    let transaction: string | undefined;
    let moved = false;
    let replaced = false;
    let committed = false;
    let preserveRecovery = false;
    let temporaryLock: string | undefined;
    try {
      const current = mode === "replace" ? await this.target(input, signal) : undefined;
      if (current) {
        if (current.lock.raw !== original.lock.raw || fingerprint(current.files) !== fingerprint(original.files)) {
          throw new SkillsError("CONFLICT", "local skill or lock changed during the operation; nothing was committed");
        }
      }
      const latestState = current?.lock ?? await this.readLock(paths, input.scope);
      if (!current && (latestState.raw !== original.lock.raw || await optionalStat(original.path))) {
        throw new SkillsError("CONFLICT", "the target directory or lock changed during the operation; nothing was committed");
      }
      transaction = await mkdtemp(join(paths.agents, ".skills-mcp-txn-"));
      const next = join(transaction, "next");
      if (nextFiles) {
        await mkdir(next);
        for (const file of nextFiles) {
          const destination = await safeChild(next, file.path.split("/"));
          await mkdir(dirname(destination), { recursive: true });
          await writeFile(destination, file.content, { flag: "wx", mode: file.mode === "100755" ? 0o755 : 0o644 });
        }
        const staged = await readSkillFiles(next, signal);
        if (!sameFiles(staged, nextFiles)) throw new SkillsError("CONFLICT", "staged files do not match the approved snapshot");
        // Hash actual filesystem spellings: some filesystems normalize Unicode names.
        if (nextEntry && input.scope === "project") nextEntry = { ...nextEntry, computedHash: folderHash(staged) };
      }
      const skills = { ...latestState.data.skills };
      if (nextEntry) skills[input.name] = nextEntry;
      else delete skills[input.name];
      const data = { ...latestState.data, skills: Object.fromEntries(Object.entries(skills).sort(([a], [b]) => a.localeCompare(b))) };
      const serializedLock = JSON.stringify(data, null, 2) + "\n";
      if (Buffer.byteLength(serializedLock) > 2 * 1024 * 1024) {
        throw new SkillsError("CONFLICT", "updated CLI lock exceeds the supported 2 MiB size limit; nothing was committed");
      }
      await writeFile(join(transaction, "recovery.json"), JSON.stringify({ version: 1, owner,
        operation: mode === "create" ? "install" : nextFiles ? "update" : "remove", scope: input.scope, name: input.name,
        skillPath: original.path, lockPath: paths.lockPath, originalLock: original.lock.raw,
      }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      temporaryLock = join(dirname(paths.lockPath), `.skills-mcp-${owner}.tmp`);
      await writeFile(temporaryLock, serializedLock, { flag: "wx", mode: 0o600 });
      throwIfCancelled(signal);
      await safeChild(paths.root, [".agents", "skills", input.name]);
      await safeChild(paths.lockRoot, paths.lockParts);
      const latestLock = await this.readLock(paths, input.scope);
      if (latestLock.raw !== original.lock.raw) {
        throw new SkillsError("CONFLICT", "the CLI lock changed before commit; nothing was committed");
      }
      if (mode === "replace") {
        if (fingerprint(await readSkillFiles(original.path, signal)) !== fingerprint(original.files)) {
          throw new SkillsError("CONFLICT", "local skill changed before commit; nothing was committed");
        }
        await this.move(original.path, join(transaction, "previous"));
        moved = true;
      } else if (await optionalStat(original.path)) {
        throw new SkillsError("CONFLICT", "the target directory appeared before commit; nothing was committed");
      }
      if (nextFiles) { await this.move(next, original.path); replaced = true; moved = true; }
      // Do not observe cancellation halfway through the two-file commit/rollback section.
      if ((await this.readLock(paths, input.scope)).raw !== original.lock.raw) {
        throw new SkillsError("CONFLICT", "CLI lock changed during commit");
      }
      await this.move(temporaryLock, paths.lockPath);
      temporaryLock = undefined;
      committed = true;
    } catch (error) {
      if (moved && !committed && transaction) {
        try {
          if (replaced) await this.move(original.path, join(transaction, "failed"));
          if (mode === "replace") await this.move(join(transaction, "previous"), original.path);
        } catch {
          preserveRecovery = true;
          throw new SkillsError("FILESYSTEM_ERROR", `rollback could not finish; preserve the recovery directory: ${transaction}`);
        }
      }
      if (error instanceof SkillsError) throw error;
      throw new SkillsError("FILESYSTEM_ERROR", "could not commit local skill changes; the original skill was retained or restored");
    } finally {
      if (temporaryLock && !preserveRecovery) await unlink(temporaryLock).catch(() => logger.warn("temporary skills lock needs manual cleanup"));
      else if (temporaryLock) logger.warn(`staged skills lock preserved for recovery: ${temporaryLock}`);
      if (transaction && !preserveRecovery) await rm(transaction, { recursive: true, force: true })
        .catch(() => logger.warn(`skills transaction needs manual cleanup: ${transaction}`));
      if (!preserveRecovery) {
        try {
          if ((await readBoundedFile(guardPath, 100)).toString() === owner) await unlink(guardPath);
        } catch { logger.warn("local mutation guard needs manual inspection"); }
      }
    }
  }

  private async paths(scope: SkillScope): Promise<ScopePaths> {
    const configured = scope === "global" ? this.options.homeDir : this.options.projectRoot;
    if (!configured) throw new SkillsError("INVALID_INPUT", "set SKILLS_PROJECT_ROOT explicitly before using project scope");
    const root = await canonicalRoot(configured);
    const agents = await safeChild(root, [".agents"]);
    const skills = await safeChild(root, [".agents", "skills"]);
    const lockRoot = scope === "global" && this.options.globalStateRoot
      ? await canonicalRoot(this.options.globalStateRoot) : root;
    const lockParts = scope === "project" ? ["skills-lock.json"] :
      this.options.globalStateRoot ? ["skills", ".skill-lock.json"] : [".agents", ".skill-lock.json"];
    return { root, agents, skills, lockRoot, lockParts, lockPath: await safeChild(lockRoot, lockParts) };
  }

  private async readLock(paths: ScopePaths, scope: SkillScope): Promise<LockState> {
    const version = scope === "project" ? 1 : 3;
    if (!await optionalStat(paths.lockPath)) return { data: { version, skills: {} } };
    const raw = (await readBoundedFile(paths.lockPath, 2 * 1024 * 1024)).toString("utf8");
    let data: unknown;
    try { data = JSON.parse(raw); } catch { throw new SkillsError("PARSE_ERROR", "invalid skills lock JSON; refusing to overwrite it"); }
    if (!isRecord(data) || data["version"] !== version || !isRecord(data["skills"]) ||
      Object.values(data["skills"]).some((entry) => !isRecord(entry) ||
        typeof entry["source"] !== "string" || typeof entry["sourceType"] !== "string")) {
      throw new SkillsError("PARSE_ERROR", `unsupported skills lock; expected version ${version} with source metadata`);
    }
    return { raw, data: data as SkillLock };
  }
}

/** Case- and normalization-insensitive comparison key for portable directory names. */
function portableName(value: string): string {
  return value.normalize("NFC").toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameFiles(files: LocalFile[], remote: readonly { path: string; sha: string }[], allowCheckout = false): boolean {
  const expected = new Map(remote.map((file) => [file.path.normalize("NFC"), file.sha]));
  const seen = new Set<string>();
  return expected.size === remote.length && expected.size === files.length && files.every((file) => {
    const key = file.path.normalize("NFC");
    if (seen.has(key)) return false;
    seen.add(key);
    const sha = expected.get(key);
    if (sha === file.sha) return true;
    const normalized = sha && allowCheckout ? checkoutLf(file.content) : undefined;
    return normalized !== undefined && blobHash(normalized) === sha;
  });
}
