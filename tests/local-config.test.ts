import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";

describe("local skills environment configuration", () => {
  test("defaults to read-only and never infers the current project directory", () => {
    expect(loadConfig({})).toMatchObject({ projectRoot: undefined, allowMutations: false, githubToken: undefined });
  });

  test.each([undefined, "false", "1", "TRUE", " true "])("does not enable mutations for %s", (value) => {
    expect(loadConfig({ SKILLS_ALLOW_MUTATIONS: value }).allowMutations).toBe(false);
  });

  test("uses only explicit roots and exact mutation opt-in", () => {
    expect(loadConfig({ SKILLS_PROJECT_ROOT: "configured-project", XDG_STATE_HOME: "configured-state",
      SKILLS_ALLOW_MUTATIONS: "true" })).toMatchObject({ projectRoot: "configured-project",
      globalStateRoot: "configured-state", allowMutations: true });
  });

  test("prefers a nonempty GitHub token and supports the GH_TOKEN fallback", () => {
    expect(loadConfig({ GITHUB_TOKEN: " test-primary ", GH_TOKEN: "test-fallback" }).githubToken).toBe("test-primary");
    expect(loadConfig({ GITHUB_TOKEN: " ", GH_TOKEN: "test-fallback" }).githubToken).toBe("test-fallback");
  });
});
