import {
  PROFILE_GLOB_DIALECT_CONTRACT_VERSION,
  PROFILE_GLOB_DIALECT_IDS,
  PROFILE_GLOB_DIALECTS,
  profileGlobDialect,
} from "../src/index.js";
import { describe, expect, test } from "vitest";

describe("E02 profile-owned glob dialect catalog", () => {
  test("is closed, unique, ordered, immutable, and version-bound", () => {
    expect(PROFILE_GLOB_DIALECTS.map((dialect) => dialect.id)).toEqual(PROFILE_GLOB_DIALECT_IDS);
    expect([...PROFILE_GLOB_DIALECT_IDS].sort()).toEqual(PROFILE_GLOB_DIALECT_IDS);
    expect(new Set(PROFILE_GLOB_DIALECT_IDS).size).toBe(PROFILE_GLOB_DIALECT_IDS.length);
    expect(Object.isFrozen(PROFILE_GLOB_DIALECTS)).toBe(true);
    for (const dialect of PROFILE_GLOB_DIALECTS) {
      expect(dialect.contractVersion).toBe(PROFILE_GLOB_DIALECT_CONTRACT_VERSION);
      expect(dialect.id.startsWith(`${dialect.profileId}/`)).toBe(true);
      expect(dialect.surfaceIds.length).toBeGreaterThan(0);
      expect(new Set(dialect.surfaceIds).size).toBe(dialect.surfaceIds.length);
      expect(
        dialect.surfaceIds.every((surfaceId) => surfaceId.startsWith(`${dialect.profileId}/`)),
      ).toBe(true);
      expect(dialect.evidenceRefs.length).toBeGreaterThan(0);
      expect(Object.isFrozen(dialect)).toBe(true);
      expect(Object.isFrozen(dialect.surfaceIds)).toBe(true);
      expect(Object.isFrozen(dialect.evidenceRefs)).toBe(true);
      expect(profileGlobDialect(dialect.id)).toBe(dialect);
    }
  });

  test("does not supply fallback behavior for unknown identities", () => {
    expect(profileGlobDialect("unknown/default/glob")).toBeUndefined();
    expect(profileGlobDialect("")).toBeUndefined();
    expect(PROFILE_GLOB_DIALECTS.some((dialect) => dialect.profileId === "codex-cli")).toBe(false);
    expect(PROFILE_GLOB_DIALECTS.some((dialect) => dialect.profileId === "gemini-cli")).toBe(false);
  });

  test("retains known and unknown profile behavior independently", () => {
    expect(profileGlobDialect("claude-code/project-rule-paths/2026-08-01")).toMatchObject({
      patternBase: "repository-root",
      braceExpansion: "documented",
      braceExpansionMaximumPatterns: 1_000,
      braceExpansionMaximumBytes: 4_194_304,
      braceLimitResult: "literal-no-match",
    });
    expect(profileGlobDialect("copilot-vscode/apply-to/2026-08-01")).toMatchObject({
      patternBase: "scope-root",
      braceExpansion: "documented",
      braceExpansionMaximumPatterns: null,
      braceExpansionMaximumBytes: null,
      braceLimitResult: "indeterminate",
    });
    expect(profileGlobDialect("cursor-agent/mdc-globs/2026-08-01")).toMatchObject({
      patternBase: "unknown",
      star: "unknown",
      globstar: "unknown",
    });
  });
});
