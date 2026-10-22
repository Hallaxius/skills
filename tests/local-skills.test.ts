import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { LocalSkillsService } from "../src/services/local-skills";
import { SkillsError } from "../src/errors";
import type { SkillSource } from "../src/types/local-skills";

const OLD_HASH = "a719bf92b1c041f4d599ca93f873cfb982b648ab0ea40683d633972716766fef";
const NEW_HASH = "6a6ca34597d6b3d398f93f86cd69176f880b46dd26673676e1fc0f9cb95b08ed";
const OLD_BLOB = "4b48deed3a433909bfd6b6ab3d4b91348b6af464";
const NEW_BLOB = "519c15ed8d400dfa4be08f404a5c5b21ad6d4a7a";
const source: SkillSource = {
  async latest() { return { folderHash: "1".repeat(40), files: [{ path: "SKILL.md", sha: NEW_BLOB, mode: "100644", size: 8 }] }; },
  async baseline() { return { folderHash: "2".repeat(40), files: [{ path: "SKILL.md", sha: OLD_BLOB, mode: "100644", size: 9 }] }; },
  async readFile() { return Buffer.from("updated\n"); },
};

describe("local skills", () => {
  let root: string;
  let project: string;
  let home: string;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "skills-mcp-test-")));
    project = join(root, "project");
    home = join(root, "home");
    await mkdir(project);
    await mkdir(home);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("lists only canonical skills in the requested scope without changing the lock", async () => {
    const path = join(project, ".agents", "skills", "example");
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "SKILL.md"), "---\nname: example\n---\nInstructions\n");
    const lock = JSON.stringify({ version: 1, skills: {
      example: { source: "owner/repo", sourceType: "github", skillPath: "skills/example/SKILL.md", computedHash: "abc" },
    } });
    await writeFile(join(project, "skills-lock.json"), lock);
    const service = new LocalSkillsService({ projectRoot: project, homeDir: home, allowMutations: false });

    const result = await service.listInstalled({ scope: "project" });

    expect(result.skills).toEqual([expect.objectContaining({ name: "example", path, source: "owner/repo", managed: true })]);
    expect(result.total).toBe(1);
    expect((await service.listInstalled({ scope: "global" })).skills).toEqual([]);
    expect(await readFile(join(project, "skills-lock.json"), "utf8")).toBe(lock);
  });

  async function installed() {
    const path = join(project, ".agents", "skills", "example");
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "SKILL.md"), "original\n");
    await writeFile(join(project, "skills-lock.json"), JSON.stringify({ version: 1, skills: {
      example: { source: "owner/repo", sourceType: "github", skillPath: "skills/example/SKILL.md", computedHash: OLD_HASH, skillFolderHash: "2".repeat(40) },
      other: { source: "other/repo", sourceType: "github", extra: "retain" },
    }, extra: "preserve" }));
    return path;
  }

  test("removal defaults to a read-only preview and execution requires host opt-in", async () => {
    const path = await installed();
    const service = new LocalSkillsService({ projectRoot: project, homeDir: home, allowMutations: false });
    const preview = await service.removeSkill({ name: "example", scope: "project" });
    expect(preview.status).toBe("preview");
    expect(preview.confirmation_token).toMatch(/^[a-f0-9]{64}$/);
    expect(await readFile(join(path, "SKILL.md"), "utf8")).toBe("original\n");
    await expect(service.removeSkill({ name: "example", scope: "project", dry_run: false,
      confirm: true, confirmation_token: preview.confirmation_token })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });

  test("confirmed removal changes only one canonical skill and its lock entry", async () => {
    const path = await installed();
    const service = new LocalSkillsService({ projectRoot: project, homeDir: home, allowMutations: true });
    const preview = await service.removeSkill({ name: "example", scope: "project" });
    const result = await service.removeSkill({ name: "example", scope: "project", dry_run: false,
      confirm: true, confirmation_token: preview.confirmation_token });
    expect(result.status).toBe("removed");
    await expect(readFile(join(path, "SKILL.md"))).rejects.toMatchObject({ code: "ENOENT" });
    const lock = JSON.parse(await readFile(join(project, "skills-lock.json"), "utf8"));
    expect(lock.skills).toEqual({ other: { source: "other/repo", sourceType: "github", extra: "retain" } });
    expect(lock.extra).toBe("preserve");
  });

  test("checks updates without writing and distinguishes local edits", async () => {
    const path = await installed();
    const lock = await readFile(join(project, "skills-lock.json"), "utf8");
    const service = new LocalSkillsService({ projectRoot: project, homeDir: home, allowMutations: false }, source);
    const result = await service.checkUpdates({ scope: "project", name: "example" });
    expect(result.skills[0]?.status).toBe("update_available");
    expect(await readFile(join(project, "skills-lock.json"), "utf8")).toBe(lock);
    expect(await readFile(join(path, "SKILL.md"), "utf8")).toBe("original\n");

    await writeFile(join(path, "SKILL.md"), "my local changes\n");
    expect((await service.checkUpdates({ scope: "project", name: "example" })).skills[0]?.status).toBe("local_changes");
  });

  test("refuses a legacy project hash that cannot prove the original file boundaries", async () => {
    const path = await installed();
    // The CLI hash of SKILL.md='old\n' plus z.txt='keep\n' is identical to this edited single file.
    await writeFile(join(path, "SKILL.md"), "old\nz.txtkeep\n");
    const lock = JSON.stringify({ version: 1, skills: { example: { source: "owner/repo", sourceType: "github",
      skillPath: "skills/example/SKILL.md", computedHash: "6c27913f2cd6163f9cc60b9d4b6a0836f0c7b96c80c4868928683bb88f52a1dd" } } });
    await writeFile(join(project, "skills-lock.json"), lock);
    const service = new LocalSkillsService({ projectRoot: project, homeDir: home, allowMutations: true }, source);
    expect((await service.checkUpdates({ scope: "project", name: "example" })).skills[0]?.status).toBe("unknown");
    await expect(service.updateSkill({ scope: "project", name: "example" })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(service.updateSkill({ scope: "project", name: "example", dry_run: false, confirm: true,
      confirmation_token: "0".repeat(64) })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await readFile(join(path, "SKILL.md"), "utf8")).toBe("old\nz.txtkeep\n");
    expect(await readFile(join(project, "skills-lock.json"), "utf8")).toBe(lock);
  });

  test("a legacy project matching current upstream is reported up-to-date without writing a new baseline", async () => {
    const path = await installed();
    const lockPath = join(project, "skills-lock.json");
    const data = JSON.parse(await readFile(lockPath, "utf8"));
    delete data.skills.example.skillFolderHash;
    const lock = JSON.stringify(data);
    await writeFile(lockPath, lock);
    const service = new LocalSkillsService({ projectRoot: project, homeDir: home, allowMutations: true }, {
      ...source, async latest() { return { folderHash: "2".repeat(40), files: [{ path: "SKILL.md", sha: OLD_BLOB, mode: "100644" }] }; },
    });
    expect((await service.checkUpdates({ scope: "project" })).skills[0]?.status).toBe("up_to_date");
    const preview = await service.updateSkill({ scope: "project", name: "example" });
    expect((await service.updateSkill({ scope: "project", name: "example", dry_run: false, confirm: true,
      confirmation_token: preview.confirmation_token })).status).toBe("up_to_date");
    expect(await readFile(lockPath, "utf8")).toBe(lock);
    expect(await readFile(join(path, "SKILL.md"), "utf8")).toBe("original\n");
  });

  test("rejects normalization aliases instead of matching two local files to one baseline entry", async () => {
    const path = join(home, ".agents", "skills", "example");
    await mkdir(path, { recursive: true });
    for (const name of ["SKILL.md", "caf\u00e9.txt", "cafe\u0301.txt"]) await writeFile(join(path, name), "original\n");
    await writeFile(join(home, ".agents", ".skill-lock.json"), JSON.stringify({ version: 3, skills: {
      example: { source: "owner/repo", sourceType: "github", skillPath: "skills/example/SKILL.md", skillFolderHash: "2".repeat(40) },
    } }));
    const service = new LocalSkillsService({ homeDir: home, allowMutations: true }, {
      ...source,
      async baseline() { return { folderHash: "2".repeat(40), files: ["SKILL.md", "caf\u00e9.txt", "other.txt"]
        .map((name) => ({ path: name, sha: OLD_BLOB, mode: "100644" })) }; },
    });
    await expect(service.updateSkill({ scope: "global", name: "example" })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await readFile(join(path, "SKILL.md"), "utf8")).toBe("original\n");
  });

  test("refuses lock serialization that would exceed the readable size limit", async () => {
    const path = await installed();
    const lockPath = join(project, "skills-lock.json");
    const data = JSON.parse(await readFile(lockPath, "utf8"));
    data.extra = { values: Array(250_000).fill(0), padding: "x".repeat(1_000_000) };
    const lock = JSON.stringify(data);
    expect(Buffer.byteLength(lock)).toBeLessThan(2 * 1024 * 1024);
    await writeFile(lockPath, lock);
    const service = new LocalSkillsService({ projectRoot: project, homeDir: home, allowMutations: true });
    const preview = await service.removeSkill({ scope: "project", name: "example" });
    await expect(service.removeSkill({ scope: "project", name: "example", dry_run: false, confirm: true,
      confirmation_token: preview.confirmation_token })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await readFile(lockPath, "utf8")).toBe(lock);
    expect(await readFile(join(path, "SKILL.md"), "utf8")).toBe("original\n");
  });

  test("updates only the approved skill and writes a CLI-compatible content baseline", async () => {
    const path = await installed();
    const service = new LocalSkillsService({ projectRoot: project, homeDir: home, allowMutations: true }, source);
    const preview = await service.updateSkill({ scope: "project", name: "example" });
    expect(preview.status).toBe("preview");
    expect(await readFile(join(path, "SKILL.md"), "utf8")).toBe("original\n");
    const result = await service.updateSkill({ scope: "project", name: "example", dry_run: false,
      confirm: true, confirmation_token: preview.confirmation_token });
    expect(result.status).toBe("updated");
    expect(await readFile(join(path, "SKILL.md"), "utf8")).toBe("updated\n");
    const lock = JSON.parse(await readFile(join(project, "skills-lock.json"), "utf8"));
    expect(lock.skills.example.computedHash).toBe(NEW_HASH);
    expect(lock.skills.other.extra).toBe("retain");
    expect(lock.extra).toBe("preserve");
    expect((await service.checkUpdates({ scope: "project", name: "example" })).skills[0]?.status).toBe("up_to_date");
  });

  test.each(["../example", "example/other", "example\\other", "C:example", ".", "..", "CON", "nul.txt", "example."])(
    "refuses unsafe selected name %s", async (name) => {
      const path = await installed();
      const service = new LocalSkillsService({ projectRoot: project, homeDir: home, allowMutations: true }, source);
      await expect(service.removeSkill({ name, scope: "project" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
      expect(await readFile(join(path, "SKILL.md"), "utf8")).toBe("original\n");
    });

  test("does not infer a project root or treat an untracked directory as owned", async () => {
    const service = new LocalSkillsService({ homeDir: home, allowMutations: true });
    await expect(service.listInstalled({ scope: "project" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    const path = await installed();
    await rm(join(project, "skills-lock.json"));
    const scoped = new LocalSkillsService({ projectRoot: project, homeDir: home, allowMutations: true });
    expect((await scoped.listInstalled({ scope: "project" })).skills[0]?.managed).toBe(false);
    await expect(scoped.removeSkill({ name: "example", scope: "project" })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await readFile(join(path, "SKILL.md"), "utf8")).toBe("original\n");
  });

  test.each(["{bad json", '{"version":99,"skills":{}}'])("leaves an invalid lock untouched: %s", async (raw) => {
    await installed();
    await writeFile(join(project, "skills-lock.json"), raw);
    const service = new LocalSkillsService({ projectRoot: project, homeDir: home, allowMutations: true });
    await expect(service.removeSkill({ name: "example", scope: "project" })).rejects.toMatchObject({ code: "PARSE_ERROR" });
    expect(await readFile(join(project, "skills-lock.json"), "utf8")).toBe(raw);
  });

  test.each(["files", "lock"])("rejects a removal preview made stale by changed %s", async (changed) => {
    const path = await installed();
    const service = new LocalSkillsService({ projectRoot: project, homeDir: home, allowMutations: true });
    const preview = await service.removeSkill({ name: "example", scope: "project" });
    if (changed === "files") await writeFile(join(path, "SKILL.md"), "new local content\n");
    else await writeFile(join(project, "skills-lock.json"), (await readFile(join(project, "skills-lock.json"), "utf8")) + "\n");
    await expect(service.removeSkill({ name: "example", scope: "project", dry_run: false, confirm: true,
      confirmation_token: preview.confirmation_token })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await readFile(join(path, "SKILL.md"), "utf8")).toBe(changed === "files" ? "new local content\n" : "original\n");
  });

  test("refuses updates over local changes and never downloads replacement bytes", async () => {
    const path = await installed();
    await writeFile(join(path, "SKILL.md"), "local work\n");
    let downloads = 0;
    const service = new LocalSkillsService({ projectRoot: project, homeDir: home, allowMutations: true }, {
      ...source, async readFile() { downloads++; return Buffer.from("updated\n"); },
    });
    await expect(service.updateSkill({ scope: "project", name: "example" })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(downloads).toBe(0);
    expect(await readFile(join(path, "SKILL.md"), "utf8")).toBe("local work\n");
  });

  test("a corrupt download leaves both the skill and its lock unchanged", async () => {
    const path = await installed();
    const lock = await readFile(join(project, "skills-lock.json"), "utf8");
    const service = new LocalSkillsService({ projectRoot: project, homeDir: home, allowMutations: true }, {
      ...source, async readFile() { return Buffer.from("corrupt\n"); },
    });
    const preview = await service.updateSkill({ scope: "project", name: "example" });
    await expect(service.updateSkill({ scope: "project", name: "example", dry_run: false, confirm: true,
      confirmation_token: preview.confirmation_token })).rejects.toMatchObject({ code: "UPSTREAM_CHANGED" });
    expect(await readFile(join(path, "SKILL.md"), "utf8")).toBe("original\n");
    expect(await readFile(join(project, "skills-lock.json"), "utf8")).toBe(lock);
    expect(await readdir(join(project, ".agents"))).toEqual(["skills"]);
  });

  test.each([
    ["failed", true],
    ["succeeds", false],
  ] as const)("retains original data when committing the lock fails (rollback %s)", async (_label, rollbackFails) => {
    const path = await installed();
    const lockPath = join(project, "skills-lock.json");
    const lock = await readFile(lockPath, "utf8");
    const move: typeof rename = async (from, to) => {
      if (to === lockPath || (rollbackFails && basename(String(from)) === "previous")) {
        throw Object.assign(new Error("simulated filesystem sharing failure"), { code: "EBUSY" });
      }
      await rename(from, to);
    };
    const service = new LocalSkillsService({ projectRoot: project, homeDir: home, allowMutations: true }, source, move);
    const preview = await service.updateSkill({ scope: "project", name: "example" });
    await expect(service.updateSkill({ scope: "project", name: "example", dry_run: false, confirm: true,
      confirmation_token: preview.confirmation_token })).rejects.toMatchObject({ code: "FILESYSTEM_ERROR" });
    expect(await readFile(lockPath, "utf8")).toBe(lock);
    const entries = await readdir(join(project, ".agents"));
    if (!rollbackFails) {
      expect(await readFile(join(path, "SKILL.md"), "utf8")).toBe("original\n");
      expect(entries).toEqual(["skills"]);
    } else {
      expect(entries).toContain(".skills-mcp.lock");
      const recovery = entries.find((name) => name.startsWith(".skills-mcp-txn-"));
      expect(recovery).toBeDefined();
      const transaction = join(project, ".agents", recovery!);
      expect(await readFile(join(transaction, "previous", "SKILL.md"), "utf8")).toBe("original\n");
      expect(JSON.parse(await readFile(join(transaction, "recovery.json"), "utf8")).originalLock).toBe(lock);
    }
  });

  test("refuses symlinked canonical directories rather than deleting their destinations", async () => {
    const path = await installed();
    const outside = join(root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "SKILL.md"), "outside data\n");
    await rm(path, { recursive: true });
    await symlink(outside, path, process.platform === "win32" ? "junction" : "dir");
    const service = new LocalSkillsService({ projectRoot: project, homeDir: home, allowMutations: true });
    await expect(service.removeSkill({ name: "example", scope: "project" })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await readFile(join(outside, "SKILL.md"), "utf8")).toBe("outside data\n");
  });

  test("an aborted operation leaves no mutation guard or transaction", async () => {
    const path = await installed();
    const service = new LocalSkillsService({ projectRoot: project, homeDir: home, allowMutations: true }, source);
    const controller = new AbortController();
    controller.abort();
    await expect(service.updateSkill({ scope: "project", name: "example" }, controller.signal)).rejects.toMatchObject({ code: "CANCELLED" });
    expect(await readdir(join(project, ".agents"))).toEqual(["skills"]);
    expect(await readFile(join(path, "SKILL.md"), "utf8")).toBe("original\n");
  });

  test("rejects an update approval after upstream changes without downloading files", async () => {
    const path = await installed();
    let hash = "1".repeat(40);
    let downloads = 0;
    const service = new LocalSkillsService({ projectRoot: project, homeDir: home, allowMutations: true }, {
      ...source, async latest() { return { ...await source.latest({ source: "owner/repo", sourceType: "github" }), folderHash: hash }; },
      async readFile() { downloads++; return Buffer.from("updated\n"); },
    });
    const preview = await service.updateSkill({ scope: "project", name: "example" });
    hash = "3".repeat(40);
    await expect(service.updateSkill({ scope: "project", name: "example", dry_run: false, confirm: true,
      confirmation_token: preview.confirmation_token })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(downloads).toBe(0);
    expect(await readFile(join(path, "SKILL.md"), "utf8")).toBe("original\n");
  });

  test("does not steal an existing mutation guard", async () => {
    const path = await installed();
    const lock = await readFile(join(project, "skills-lock.json"), "utf8");
    const service = new LocalSkillsService({ projectRoot: project, homeDir: home, allowMutations: true });
    const preview = await service.removeSkill({ scope: "project", name: "example" });
    const guard = join(project, ".agents", ".skills-mcp.lock");
    await writeFile(guard, "another owner");
    await expect(service.removeSkill({ scope: "project", name: "example", dry_run: false, confirm: true,
      confirmation_token: preview.confirmation_token })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await readFile(guard, "utf8")).toBe("another owner");
    expect(await readFile(join(path, "SKILL.md"), "utf8")).toBe("original\n");
    expect(await readFile(join(project, "skills-lock.json"), "utf8")).toBe(lock);
  });

  test.each(["cancelled", "locally edited"])("retains local data when a download is %s", async (change) => {
    const path = await installed();
    const lock = await readFile(join(project, "skills-lock.json"), "utf8");
    const controller = new AbortController();
    const service = new LocalSkillsService({ projectRoot: project, homeDir: home, allowMutations: true }, {
      ...source, async readFile() {
        if (change === "cancelled") controller.abort();
        else await writeFile(join(path, "SKILL.md"), "editing while downloading\n");
        return Buffer.from("updated\n");
      },
    });
    const preview = await service.updateSkill({ scope: "project", name: "example" });
    await expect(service.updateSkill({ scope: "project", name: "example", dry_run: false, confirm: true,
      confirmation_token: preview.confirmation_token }, controller.signal)).rejects.toMatchObject({ code: change === "cancelled" ? "CANCELLED" : "CONFLICT" });
    expect(await readFile(join(path, "SKILL.md"), "utf8")).toBe(change === "cancelled" ? "original\n" : "editing while downloading\n");
    expect(await readFile(join(project, "skills-lock.json"), "utf8")).toBe(lock);
    expect(await readdir(join(project, ".agents"))).toEqual(["skills"]);
  });

  test("reports an upstream failure as unknown rather than claiming no update exists", async () => {
    await installed();
    const service = new LocalSkillsService({ projectRoot: project, homeDir: home, allowMutations: false }, {
      ...source, async latest() { throw new SkillsError("NETWORK_ERROR", "offline"); },
    });
    expect((await service.checkUpdates({ scope: "project" })).skills[0]).toMatchObject({
      status: "unknown", reason: "[NETWORK_ERROR] offline",
    });
  });

  test("refuses an oversized local file without mutating it", async () => {
    const path = await installed();
    await writeFile(join(path, "large.bin"), Buffer.alloc(2 * 1024 * 1024 + 1));
    const lock = await readFile(join(project, "skills-lock.json"), "utf8");
    const service = new LocalSkillsService({ projectRoot: project, homeDir: home, allowMutations: true });
    await expect(service.removeSkill({ scope: "project", name: "example" })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await readFile(join(path, "SKILL.md"), "utf8")).toBe("original\n");
    expect(await readFile(join(project, "skills-lock.json"), "utf8")).toBe(lock);
  });

  test("updates global CLI metadata in XDG state without touching project skills or other metadata", async () => {
    const projectPath = await installed();
    const globalPath = join(home, ".agents", "skills", "example");
    const state = join(root, "state");
    await mkdir(globalPath, { recursive: true });
    await mkdir(join(state, "skills"), { recursive: true });
    await writeFile(join(globalPath, "SKILL.md"), "original\n");
    const lockPath = join(state, "skills", ".skill-lock.json");
    await writeFile(lockPath, JSON.stringify({ version: 3, skills: {
      example: { source: "owner/repo", sourceType: "github", skillPath: "skills/example/SKILL.md",
        skillFolderHash: "2".repeat(40), installedAt: "2025-01-01T00:00:00.000Z", extra: "retain" },
    }, dismissed: { notice: true } }));
    const service = new LocalSkillsService({ projectRoot: project, homeDir: home, globalStateRoot: state, allowMutations: true }, source);
    const preview = await service.updateSkill({ scope: "global", name: "example" });
    await service.updateSkill({ scope: "global", name: "example", dry_run: false, confirm: true,
      confirmation_token: preview.confirmation_token });
    const lock = JSON.parse(await readFile(lockPath, "utf8"));
    expect(lock.skills.example).toMatchObject({ skillFolderHash: "1".repeat(40), extra: "retain", installedAt: "2025-01-01T00:00:00.000Z" });
    expect(lock.skills.example.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(lock.dismissed).toEqual({ notice: true });
    expect(await readFile(join(globalPath, "SKILL.md"), "utf8")).toBe("updated\n");
    expect(await readFile(join(projectPath, "SKILL.md"), "utf8")).toBe("original\n");
    expect((await service.checkUpdates({ scope: "global" })).skills[0]?.status).toBe("up_to_date");
  });

  test("recognizes a clean CRLF checkout and preserves its line endings during an update", async () => {
    const path = join(home, ".agents", "skills", "example");
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "SKILL.md"), "original\r\n");
    await writeFile(join(home, ".agents", ".skill-lock.json"), JSON.stringify({ version: 3, skills: {
      example: { source: "owner/repo", sourceType: "github", skillPath: "skills/example/SKILL.md", skillFolderHash: "2".repeat(40) },
    } }));
    const service = new LocalSkillsService({ homeDir: home, allowMutations: true }, source);
    expect((await service.checkUpdates({ scope: "global" })).skills[0]?.status).toBe("update_available");
    const preview = await service.updateSkill({ scope: "global", name: "example" });
    await service.updateSkill({ scope: "global", name: "example", dry_run: false, confirm: true,
      confirmation_token: preview.confirmation_token });
    expect(await readFile(join(path, "SKILL.md"), "utf8")).toBe("updated\r\n");
    expect((await service.checkUpdates({ scope: "global" })).skills[0]?.status).toBe("up_to_date");
    await writeFile(join(path, "SKILL.md"), "my changes\r\n");
    expect((await service.checkUpdates({ scope: "global" })).skills[0]?.status).toBe("local_changes");
  });

  test.each([
    ["binary", "original\0\r\n", "617b405e49efbc1ea9538fb542b6791b2fd93fb8"],
    ["mixed line endings", "first\r\nsecond\n", "66a52ee7a1d803dc57859c3e95ac9dcdc87c0164"],
  ])("never normalizes away changes to %s content", async (_label, content, sha) => {
    const path = join(home, ".agents", "skills", "example");
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "SKILL.md"), content!);
    await writeFile(join(home, ".agents", ".skill-lock.json"), JSON.stringify({ version: 3, skills: {
      example: { source: "owner/repo", sourceType: "github", skillPath: "skills/example/SKILL.md", skillFolderHash: "1".repeat(40) },
    } }));
    const service = new LocalSkillsService({ homeDir: home, allowMutations: false }, {
      ...source, async latest() { return { folderHash: "1".repeat(40), files: [{ path: "SKILL.md", sha: sha!, mode: "100644" }] }; },
    });
    expect((await service.checkUpdates({ scope: "global" })).skills[0]?.status).toBe("local_changes");
    expect(await readFile(join(path, "SKILL.md"), "utf8")).toBe(content);
  });

  const installer: SkillSource = {
    ...source,
    async resolve(_source: string, _skill: string, _folder: string | undefined) {
      return {
        entry: { source: "owner/repo", sourceType: "github", skillPath: "skills/example/SKILL.md" },
        snapshot: { folderHash: "1".repeat(40), files: [{ path: "SKILL.md", sha: NEW_BLOB, mode: "100644", size: 8 }] },
      };
    },
  };

  test("installation previews by default and host opt-in plus approval is required to write", async () => {
    const service = new LocalSkillsService({ projectRoot: project, homeDir: home, allowMutations: false }, installer);
    const preview = await service.installSkill({ id: "owner/repo/example", scope: "project" });
    expect(preview).toMatchObject({ status: "preview", name: "example", scope: "project", source: "owner/repo",
      sourceType: "github", skillPath: "skills/example/SKILL.md", files: 1, latest_hash: "1".repeat(40) });
    expect(preview.confirmation_token).toMatch(/^[a-f0-9]{64}$/);
    expect(preview.path).toBe(join(project, ".agents", "skills", "example"));
    expect(await readdir(project)).toEqual([]);
    await expect(service.installSkill({ id: "owner/repo/example", scope: "project", dry_run: false, confirm: true,
      confirmation_token: preview.confirmation_token })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(await readdir(project)).toEqual([]);
  });

  test("creates the canonical skill and preserves unrelated lock metadata", async () => {
    await writeFile(join(project, "skills-lock.json"), JSON.stringify({ version: 1, skills: {
      other: { source: "other/repo", sourceType: "github", extra: "retain" },
    }, extra: "preserve" }));
    const service = new LocalSkillsService({ projectRoot: project, homeDir: home, allowMutations: true }, installer);
    const preview = await service.installSkill({ id: "owner/repo/example", scope: "project" });
    const result = await service.installSkill({ id: "owner/repo/example", scope: "project", dry_run: false, confirm: true,
      confirmation_token: preview.confirmation_token });

    expect(result.status).toBe("installed");
    expect(await readFile(join(project, ".agents", "skills", "example", "SKILL.md"), "utf8")).toBe("updated\n");
    expect(await readdir(join(project, ".agents"))).toEqual(["skills"]);
    const lock = JSON.parse(await readFile(join(project, "skills-lock.json"), "utf8"));
    expect(lock.skills.example).toMatchObject({ source: "owner/repo", sourceType: "github",
      skillPath: "skills/example/SKILL.md", skillFolderHash: "1".repeat(40) });
    expect(lock.skills.example.computedHash).toMatch(/^[a-f0-9]{64}$/);
    expect(lock.skills.other).toMatchObject({ source: "other/repo", extra: "retain" });
    expect(lock.extra).toBe("preserve");
    expect((await service.checkUpdates({ scope: "project" })).skills
      .find((skill) => skill.name === "example")?.status).toBe("up_to_date");
    await expect(service.installSkill({ id: "owner/repo/example", scope: "project" })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  test("installs into the global scope and its version 3 lock", async () => {
    const service = new LocalSkillsService({ homeDir: home, allowMutations: true }, installer);
    const preview = await service.installSkill({ id: "owner/repo/example", scope: "global" });
    await service.installSkill({ id: "owner/repo/example", scope: "global", dry_run: false, confirm: true,
      confirmation_token: preview.confirmation_token });

    expect(await readFile(join(home, ".agents", "skills", "example", "SKILL.md"), "utf8")).toBe("updated\n");
    expect(await readdir(join(home, ".agents"))).toEqual([".skill-lock.json", "skills"]);
    const lock = JSON.parse(await readFile(join(home, ".agents", ".skill-lock.json"), "utf8"));
    expect(lock.version).toBe(3);
    expect(lock.skills.example).toMatchObject({ source: "owner/repo", skillPath: "skills/example/SKILL.md",
      skillFolderHash: "1".repeat(40) });
    expect(lock.skills.example.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect((await service.checkUpdates({ scope: "global" })).skills[0]?.status).toBe("up_to_date");
  });

  test("forwards an explicit repo-relative path and names the skill after the resolved folder", async () => {
    let received: string | undefined;
    const service = new LocalSkillsService({ projectRoot: project, homeDir: home, allowMutations: false }, {
      ...source,
      async resolve(_source: string, _skill: string, folder: string | undefined) {
        received = folder;
        return {
          entry: { source: "owner/repo", sourceType: "github", skillPath: "tools/pipeline/SKILL.md" },
          snapshot: { folderHash: "1".repeat(40), files: [{ path: "SKILL.md", sha: NEW_BLOB, mode: "100644", size: 8 }] },
        };
      },
    });
    const preview = await service.installSkill({ id: "owner/repo/example", path: "tools/pipeline", scope: "project" });
    expect(received).toBe("tools/pipeline");
    expect(preview).toMatchObject({ name: "pipeline", skillPath: "tools/pipeline/SKILL.md",
      path: join(project, ".agents", "skills", "pipeline") });
  });

  test("refuses well-known, invalid, and source-less installs without writing", async () => {
    const service = new LocalSkillsService({ projectRoot: project, homeDir: home, allowMutations: true }, installer);
    await expect(service.installSkill({ id: "uizze.sh/ui-taste", scope: "project" })).rejects.toMatchObject({ code: "UNSUPPORTED_SOURCE" });
    await expect(service.installSkill({ id: "not-an-id", scope: "project" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    const offline = new LocalSkillsService({ projectRoot: project, homeDir: home, allowMutations: true });
    await expect(offline.installSkill({ id: "owner/repo/example", scope: "project" })).rejects.toMatchObject({ code: "UNSUPPORTED_SOURCE" });
    const withoutRoot = new LocalSkillsService({ homeDir: home, allowMutations: true }, installer);
    await expect(withoutRoot.installSkill({ id: "owner/repo/example", scope: "project" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(await readdir(project)).toEqual([]);
  });

  test("rejects an install approval after the resolution changed without writing", async () => {
    let hash = "1".repeat(40);
    const service = new LocalSkillsService({ projectRoot: project, homeDir: home, allowMutations: true }, {
      ...installer,
      async resolve(source: string, skill: string, folder: string | undefined, signal?: AbortSignal) {
        const resolved = await installer.resolve!(source, skill, folder, signal);
        return { ...resolved, snapshot: { ...resolved.snapshot, folderHash: hash } };
      },
    });
    const preview = await service.installSkill({ id: "owner/repo/example", scope: "project" });
    hash = "3".repeat(40);
    await expect(service.installSkill({ id: "owner/repo/example", scope: "project", dry_run: false, confirm: true,
      confirmation_token: preview.confirmation_token })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await readdir(project)).toEqual([]);
  });

  test("cancellation during an install download leaves no partial skill", async () => {
    const controller = new AbortController();
    const service = new LocalSkillsService({ projectRoot: project, homeDir: home, allowMutations: true }, {
      ...installer, async readFile() { controller.abort(); return Buffer.from("updated\n"); },
    });
    const preview = await service.installSkill({ id: "owner/repo/example", scope: "project" });
    await expect(service.installSkill({ id: "owner/repo/example", scope: "project", dry_run: false, confirm: true,
      confirmation_token: preview.confirmation_token }, controller.signal)).rejects.toMatchObject({ code: "CANCELLED" });
    expect(await readdir(project)).toEqual([]);
  });

  test("rolls back a failed install without leaving a partial directory or guard", async () => {
    const move = async (from: Parameters<typeof rename>[0], to: Parameters<typeof rename>[1]) => {
      if (to === join(project, "skills-lock.json") && String(from).includes(".skills-mcp-")) {
        throw Object.assign(new Error("simulated filesystem sharing failure"), { code: "EBUSY" });
      }
      await rename(from, to);
    };
    const service = new LocalSkillsService({ projectRoot: project, homeDir: home, allowMutations: true }, installer, move);
    const preview = await service.installSkill({ id: "owner/repo/example", scope: "project" });
    await expect(service.installSkill({ id: "owner/repo/example", scope: "project", dry_run: false, confirm: true,
      confirmation_token: preview.confirmation_token })).rejects.toMatchObject({ code: "FILESYSTEM_ERROR" });
    expect(await readdir(project)).toEqual([".agents"]);
    expect(await readdir(join(project, ".agents"))).toEqual(["skills"]);
    expect(await readdir(join(project, ".agents", "skills"))).toEqual([]);
  });

  test("rejects an install approval for a different id even when the tree hash is identical", async () => {
    const mirror: SkillSource = {
      ...installer,
      async resolve(source: string, skill: string, folder: string | undefined, signal?: AbortSignal) {
        const resolved = await installer.resolve!(source, skill, folder, signal);
        return { ...resolved, entry: { ...resolved.entry, source } };
      },
    };
    const service = new LocalSkillsService({ projectRoot: project, homeDir: home, allowMutations: true }, mirror);
    const preview = await service.installSkill({ id: "owner/repo/example", scope: "project" });

    await expect(service.installSkill({ id: "mirror/repo/example", scope: "project", dry_run: false, confirm: true,
      confirmation_token: preview.confirmation_token })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await readdir(project)).toEqual([]);
  });

  test("refuses a resolved skill path that is not a portable SKILL.md path", async () => {
    const malformed = (skillPath: string): SkillSource => ({
      ...source,
      async resolve() {
        return { entry: { source: "owner/repo", sourceType: "github", skillPath },
          snapshot: { folderHash: "1".repeat(40), files: [{ path: "SKILL.md", sha: NEW_BLOB, mode: "100644", size: 8 }] } };
      },
    });
    const service = new LocalSkillsService({ projectRoot: project, homeDir: home, allowMutations: true }, malformed("../../outside/SKILL.md"));
    await expect(service.installSkill({ id: "owner/repo/outside", scope: "project" })).rejects.toMatchObject({ code: "CONFLICT" });
    const notSkill = new LocalSkillsService({ projectRoot: project, homeDir: home, allowMutations: true }, malformed("skills/example/README.md"));
    await expect(notSkill.installSkill({ id: "owner/repo/outside", scope: "project" })).rejects.toMatchObject({ code: "UNSUPPORTED_SOURCE" });
    expect(await readdir(project)).toEqual([]);
  });

  test("preserves the staged lock when rollback cannot finish", async () => {
    const path = await installed();
    const move = async (from: Parameters<typeof rename>[0], to: Parameters<typeof rename>[1]) => {
      if (to === path) throw Object.assign(new Error("simulated filesystem sharing failure"), { code: "EBUSY" });
      await rename(from, to);
    };
    const service = new LocalSkillsService({ projectRoot: project, homeDir: home, allowMutations: true }, source, move);
    const preview = await service.updateSkill({ scope: "project", name: "example" });

    await expect(service.updateSkill({ scope: "project", name: "example", dry_run: false, confirm: true,
      confirmation_token: preview.confirmation_token })).rejects.toMatchObject({ code: "FILESYSTEM_ERROR" });
    const agents = await readdir(join(project, ".agents"));
    expect(agents).toContain(".skills-mcp.lock");
    expect(agents.some((entry) => entry.startsWith(".skills-mcp-txn-"))).toBe(true);
    expect((await readdir(project)).some((entry) => /^\.skills-mcp-.+\.tmp$/.test(entry))).toBe(true);
  });

  test("refuses case- and normalization-variant names that would collide elsewhere", async () => {
    await writeFile(join(project, "skills-lock.json"), JSON.stringify({ version: 1, skills: {
      "Example": { source: "owner/repo", sourceType: "github", skillPath: "skills/Example/SKILL.md" },
    } }));
    const service = new LocalSkillsService({ projectRoot: project, homeDir: home, allowMutations: true }, installer);
    await expect(service.installSkill({ id: "owner/repo/example", scope: "project" }))
      .rejects.toMatchObject({ code: "CONFLICT", message: expect.stringContaining("\"Example\"") });

    await rm(join(project, "skills-lock.json"));
    await mkdir(join(project, ".agents", "skills", "EXAMPLE"), { recursive: true });
    await expect(service.installSkill({ id: "owner/repo/example", scope: "project" }))
      .rejects.toMatchObject({ code: "CONFLICT", message: expect.stringContaining("EXAMPLE") });
  });
});
