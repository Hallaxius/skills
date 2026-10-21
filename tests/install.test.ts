import { describe, expect, test } from "bun:test";
import { githubInstallCommand, pinnedInstallCommand } from "../src/utils/install";

describe("githubInstallCommand", () => {
  test("derives the canonical install command for GitHub sources", () => {
    expect(githubInstallCommand("vercel-labs/skills", "find-skills")).toBe(
      "npx skills add https://github.com/vercel-labs/skills --skill find-skills",
    );
  });

  test("returns undefined for well-known (non-GitHub) sources", () => {
    expect(githubInstallCommand("uizze.sh", "ui-taste")).toBeUndefined();
  });
});

describe("pinnedInstallCommand", () => {
  const sha40 = "b146008599c31057cef1c145774cea5d5afb30e8";

  test("pins the commit in the #ref fragment with the @skill filter", () => {
    expect(pinnedInstallCommand("vercel-labs/skills", "find-skills", sha40)).toBe(
      `npx skills add vercel-labs/skills#${sha40}@find-skills`,
    );
  });

  test("rejects abbreviated SHAs — the CLI only pins full 40-char commits", () => {
    expect(pinnedInstallCommand("vercel-labs/skills", "find-skills", "b146008")).toBeUndefined();
  });

  test("rejects non-hex SHAs and non-GitHub sources", () => {
    expect(pinnedInstallCommand("vercel-labs/skills", "find-skills", "z".repeat(40))).toBeUndefined();
    expect(pinnedInstallCommand("uizze.sh", "ui-taste", sha40)).toBeUndefined();
  });
});
