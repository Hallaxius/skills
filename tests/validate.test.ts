import { describe, expect, it } from "bun:test";
import { parseSkillId } from "../src/utils/validate";

describe("parseSkillId", () => {
  it("accepts GitHub-style ids (owner/repo/skill)", () => {
    expect(parseSkillId("vercel-labs/skills/find-skills")).toEqual({
      source: "vercel-labs/skills",
      slug: "find-skills",
      pagePath: "/vercel-labs/skills/find-skills",
    });
  });

  it("accepts well-known domain ids (domain/skill)", () => {
    expect(parseSkillId("uizze.sh/ui-taste")).toEqual({
      source: "uizze.sh",
      slug: "ui-taste",
      pagePath: "/site/uizze.sh/ui-taste",
    });
    expect(parseSkillId("mintlify.com/mintlify")?.pagePath).toBe("/site/mintlify.com/mintlify");
  });

  it("trims surrounding whitespace and slashes", () => {
    expect(parseSkillId(" /vercel-labs/skills/find-skills/ ")).toEqual({
      source: "vercel-labs/skills",
      slug: "find-skills",
      pagePath: "/vercel-labs/skills/find-skills",
    });
  });

  it("rejects malformed ids", () => {
    const invalid = [
      "", // empty
      "foo", // single segment
      "foo/bar", // 2 segments without a domain dot
      "a/b/c/d", // 4 segments
      "http://example.com/skill", // URL
      "https://skills.sh/a/b/c", // URL
      "github.com/skills/find-skills", // dotted first segment is not a GitHub owner
      "fo/o/b", // too-short segments
      "owner/../skill", // traversal in the middle segment
      "owner/repo/sk ill", // space
      "owner/repo/sk%20ill", // URL-encoded space
      "owner/repo/skill?", // trailing punctuation
      `${"a".repeat(60)}/${"b".repeat(60)}/${"c".repeat(100)}`, // >200 chars total
    ];
    for (const id of invalid) {
      expect(parseSkillId(id)).toBeUndefined();
    }
  });
});
