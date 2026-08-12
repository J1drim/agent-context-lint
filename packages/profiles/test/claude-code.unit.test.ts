import { describe, expect, test } from "vitest";

import {
  CLAUDE_CODE_PROFILE,
  CLAUDE_CODE_PROFILE_CONTRACT_VERSION,
  CLAUDE_CODE_PROFILE_ID,
  CLAUDE_CODE_RULE_GLOB_DIALECT_ID,
  CLAUDE_CODE_SPEC_SNAPSHOT_ID,
  CLAUDE_CODE_SURFACE_ID,
} from "../src/index.js";

describe("D05 Claude Code profile descriptor", () => {
  test("is closed, immutable, evidence-bound, and owns one local surface", () => {
    expect(CLAUDE_CODE_PROFILE).toMatchObject({
      contractVersion: CLAUDE_CODE_PROFILE_CONTRACT_VERSION,
      formatIds: ["claude-memory-markdown", "claude-rule-markdown"],
      importDepth: 4,
      profileId: CLAUDE_CODE_PROFILE_ID,
      releaseClass: "ga-required",
      ruleGlobDialectId: CLAUDE_CODE_RULE_GLOB_DIALECT_ID,
      specSnapshotId: CLAUDE_CODE_SPEC_SNAPSHOT_ID,
      surfaceId: CLAUDE_CODE_SURFACE_ID,
      versionStatus: "living-docs-pending-observation",
    });
    expect(CLAUDE_CODE_PROFILE.evidenceRefs).toEqual([
      "CC-MEMORY",
      "CC-SETTINGS",
      "CC-PERMISSIONS",
      "CC-CLI",
    ]);
    expect(Object.isFrozen(CLAUDE_CODE_PROFILE)).toBe(true);
    expect(Object.isFrozen(CLAUDE_CODE_PROFILE.evidenceRefs)).toBe(true);
    expect(Object.isFrozen(CLAUDE_CODE_PROFILE.formatIds)).toBe(true);
    expect(Object.isFrozen(CLAUDE_CODE_PROFILE.versionBoundaries)).toBe(true);
  });

  test("pins every behavior boundary without executable hooks", () => {
    expect(CLAUDE_CODE_PROFILE.versionBoundaries).toEqual([
      {
        behavior: "symlink-path-rule-activation",
        evidenceRef: "CC-VERSION-2.1.198",
        minimumVersion: "2.1.198",
      },
      {
        behavior: "invalid-glob-isolated",
        evidenceRef: "CC-VERSION-2.1.207",
        minimumVersion: "2.1.207",
      },
      {
        behavior: "project-source-filters-rules",
        evidenceRef: "CC-VERSION-2.1.211",
        minimumVersion: "2.1.211",
      },
      {
        behavior: "bounded-brace-expansion",
        evidenceRef: "CC-VERSION-2.1.217",
        minimumVersion: "2.1.217",
      },
    ]);
    expect(CLAUDE_CODE_PROFILE.versionBoundaries.every(Object.isFrozen)).toBe(true);
    expect(Object.values(CLAUDE_CODE_PROFILE).some((value) => typeof value === "function")).toBe(
      false,
    );
  });
});
