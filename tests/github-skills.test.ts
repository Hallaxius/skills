import { describe, expect, test } from "bun:test";
import { GitHubSkillsSource } from "../src/services/github-skills";
import { jsonResponse, stubFetch } from "./helpers";

const folder = "1".repeat(40);
const blob = "2".repeat(40);
const entry = { source: "owner/repo", sourceType: "github", skillPath: "skills/example/SKILL.md", ref: "release/one" };

describe("GitHub skill snapshots", () => {
  test("resolves one skill folder at its recorded ref, not arbitrary source URLs", async () => {
    const stub = stubFetch(() => jsonResponse(JSON.stringify({ sha: "3".repeat(40), truncated: false, tree: [
      { path: "skills/example", type: "tree", mode: "040000", sha: folder },
      { path: "skills/example/SKILL.md", type: "blob", mode: "100644", sha: blob, size: 12 },
      { path: "elsewhere/ignored", type: "blob", mode: "120000", sha: blob },
    ] })));
    const source = new GitHubSkillsSource(stub.fetch, { minIntervalMs: 0, timeoutMs: 100 });

    const result = await source.latest({ ...entry, sourceUrl: "http://localhost/private" });

    expect(result).toEqual({ folderHash: folder, files: [{ path: "SKILL.md", sha: blob, size: 12, mode: "100644" }] });
    expect(stub.calls[0]?.url).toBe("https://api.github.com/repos/owner/repo/git/trees/release%2Fone?recursive=1");
  });

  test.each([
    ["case-colliding directories", ["Guide/one.md", "guide/two.md"]],
    ["file/directory collisions", ["guide", "guide/two.md"]],
    ["Unicode-normalized directory collisions", ["caf\u00e9/one.md", "cafe\u0301/two.md"]],
  ])("refuses %s before downloading files", async (_, paths) => {
    const stub = stubFetch(() => jsonResponse(JSON.stringify({ sha: "3".repeat(40), truncated: false, tree: [
      { path: "skills/example", type: "tree", mode: "040000", sha: folder },
      ...["SKILL.md", ...paths].map((path) => ({ path: `skills/example/${path}`, type: "blob", mode: "100644", sha: blob })),
    ] })));
    const source = new GitHubSkillsSource(stub.fetch, { minIntervalMs: 0 });
    await expect(source.latest(entry)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  test.each(["../SKILL.md", "/SKILL.md", "skills/example/../SKILL.md", "skills\\example/SKILL.md", "skills/aux/SKILL.md",
    "skills/CONOUT$/SKILL.md", "skills/COM\u00b9/SKILL.md"])(
    "rejects an unsafe recorded path %s without network access", async (skillPath) => {
      const stub = stubFetch(() => { throw new Error("must not fetch"); });
      const source = new GitHubSkillsSource(stub.fetch, { minIntervalMs: 0 });
      await expect(source.latest({ ...entry, skillPath })).rejects.toMatchObject({ code: "CONFLICT" });
      expect(stub.calls).toHaveLength(0);
    });

  test("never treats an incomplete upstream tree as a complete skill", async () => {
    const stub = stubFetch(() => jsonResponse(JSON.stringify({ sha: folder, truncated: true, tree: [] })));
    const source = new GitHubSkillsSource(stub.fetch, { minIntervalMs: 0 });
    await expect(source.latest(entry)).rejects.toMatchObject({ code: "PARSE_ERROR" });
  });

  test.each(["120000", "160000"])("refuses upstream symlinks and submodules (mode %s)", async (mode) => {
    const stub = stubFetch(() => jsonResponse(JSON.stringify({ sha: folder, truncated: false, tree: [
      { path: "SKILL.md", type: mode === "160000" ? "commit" : "blob", mode, sha: blob },
    ] })));
    const source = new GitHubSkillsSource(stub.fetch, { minIntervalMs: 0 });
    await expect(source.latest({ ...entry, skillPath: "SKILL.md" })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  test("checks downloaded blob bytes against the immutable tree hash", async () => {
    const content = Buffer.from("updated\n");
    const stub = stubFetch(() => jsonResponse(JSON.stringify({ encoding: "base64", content: content.toString("base64"), size: content.length })));
    const source = new GitHubSkillsSource(stub.fetch, { minIntervalMs: 0 });
    const file = { path: "SKILL.md", sha: "519c15ed8d400dfa4be08f404a5c5b21ad6d4a7a", mode: "100644", size: 8 };
    expect(await source.readFile(entry, file)).toEqual(content);
    await expect(source.readFile(entry, { ...file, sha: blob })).rejects.toMatchObject({ code: "UPSTREAM_CHANGED" });
  });

  test("reports GitHub rate limiting without exposing response bodies or tokens", async () => {
    const stub = stubFetch(() => jsonResponse('{"message":"private detail"}', 403, { "x-ratelimit-remaining": "0" }));
    const source = new GitHubSkillsSource(stub.fetch, { minIntervalMs: 0, token: "test-token" });
    await expect(source.latest(entry)).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(stub.calls[0]?.headers["authorization"]).toBe("Bearer test-token");
    expect(stub.calls[0]?.url.startsWith("https://api.github.com/")).toBe(true);
  });

  test("the timeout remains active while reading the response body", async () => {
    const stalledFetch = (async (_input: unknown, init?: RequestInit) => new Response(new ReadableStream({
      start(controller) {
        init?.signal?.addEventListener("abort", () => controller.error(new Error("aborted")), { once: true });
      },
    }))) as typeof fetch;
    const source = new GitHubSkillsSource(stalledFetch, { minIntervalMs: 0, timeoutMs: 5 });
    await expect(source.latest(entry)).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  test("cancellation before dispatch performs no request", async () => {
    const stub = stubFetch(() => { throw new Error("must not fetch"); });
    const source = new GitHubSkillsSource(stub.fetch, { minIntervalMs: 0 });
    const controller = new AbortController();
    controller.abort();
    await expect(source.latest(entry, controller.signal)).rejects.toMatchObject({ code: "CANCELLED" });
    expect(stub.calls).toHaveLength(0);
  });
});

describe("GitHub skill resolution for install", () => {
  const treeBody = (paths: string[]) => jsonResponse(JSON.stringify({ sha: "3".repeat(40), truncated: false, tree: [
    ...paths.map((path) => ({ path, type: "blob", mode: "100644", sha: blob, size: 4 })),
  ] }));

  test("resolves a unique nested skill folder from the default branch", async () => {
    const stub = stubFetch(() => jsonResponse(JSON.stringify({ sha: "3".repeat(40), truncated: false, tree: [
      { path: "other/SKILL.md", type: "blob", mode: "100644", sha: blob, size: 4 },
      { path: "skills/example", type: "tree", mode: "040000", sha: folder },
      { path: "skills/example/SKILL.md", type: "blob", mode: "100644", sha: blob, size: 4 },
      { path: "skills/example/metadata.json", type: "blob", mode: "100644", sha: blob, size: 2 },
    ] })));
    const source = new GitHubSkillsSource(stub.fetch, { minIntervalMs: 0 });

    const resolved = await source.resolve("owner/repo", "example", undefined);

    expect(resolved.entry).toEqual({ source: "owner/repo", sourceType: "github", skillPath: "skills/example/SKILL.md" });
    expect(resolved.snapshot).toEqual({ folderHash: folder,
      files: [{ path: "SKILL.md", sha: blob, size: 4, mode: "100644" }] });
    expect(stub.calls[0]?.url).toBe("https://api.github.com/repos/owner/repo/git/trees/HEAD?recursive=1");
  });

  test("accepts a repository-root skill named after the repository", async () => {
    const stub = stubFetch(() => treeBody(["SKILL.md", "notes.md"]));
    const source = new GitHubSkillsSource(stub.fetch, { minIntervalMs: 0 });

    const resolved = await source.resolve("owner/repo", "repo", undefined);

    expect(resolved.entry.skillPath).toBe("SKILL.md");
    expect(resolved.snapshot).toEqual({ folderHash: "3".repeat(40), files: [
      { path: "SKILL.md", sha: blob, size: 4, mode: "100644" },
      { path: "notes.md", sha: blob, size: 4, mode: "100644" },
    ] });
  });

  test("refuses an ambiguous skill name and accepts the repo-relative path instead", async () => {
    const stub = stubFetch(() => jsonResponse(JSON.stringify({ sha: "3".repeat(40), truncated: false, tree: [
      { path: "packages/a/example", type: "tree", mode: "040000", sha: folder },
      { path: "packages/a/example/SKILL.md", type: "blob", mode: "100644", sha: blob, size: 4 },
      { path: "packages/b/example", type: "tree", mode: "040000", sha: folder },
      { path: "packages/b/example/SKILL.md", type: "blob", mode: "100644", sha: blob, size: 4 },
    ] })));
    const source = new GitHubSkillsSource(stub.fetch, { minIntervalMs: 0 });

    await expect(source.resolve("owner/repo", "example", undefined)).rejects.toMatchObject({ code: "CONFLICT" });
    const resolved = await source.resolve("owner/repo", "example", "packages/b/example");
    expect(resolved.entry.skillPath).toBe("packages/b/example/SKILL.md");
    expect(resolved.snapshot.folderHash).toBe(folder);
  });

  test("reports missing folders and rejects unsafe or non-GitHub requests without fetching", async () => {
    const stub = stubFetch(() => treeBody(["SKILL.md"]));
    const source = new GitHubSkillsSource(stub.fetch, { minIntervalMs: 0 });

    await expect(source.resolve("owner/repo", "example", undefined)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(source.resolve("owner/repo", "example", "skills/missing")).rejects.toMatchObject({ code: "NOT_FOUND" });

    const unsafe = stubFetch(() => { throw new Error("must not fetch"); });
    const guarded = new GitHubSkillsSource(unsafe.fetch, { minIntervalMs: 0 });
    await expect(guarded.resolve("owner/repo", "example", "../example")).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(guarded.resolve("uizze.sh/ui-taste", "ui-taste", undefined)).rejects.toMatchObject({ code: "UNSUPPORTED_SOURCE" });
    expect(unsafe.calls).toHaveLength(0);
  });
});
