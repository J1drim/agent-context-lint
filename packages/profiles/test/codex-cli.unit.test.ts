import { describe, expect, test } from "vitest";

import {
  CODEX_CLI_BUILT_IN_PROJECT_INSTRUCTION_NAMES,
  CODEX_CLI_DEFAULT_PROJECT_ROOT_MARKERS,
  CODEX_CLI_PROFILE,
  CODEX_CLI_PROFILE_CONTRACT_VERSION,
} from "../src/index.js";

describe("D03 Codex CLI profile descriptor", () => {
  test("pins the documented client surface and defaults", () => {
    expect(CODEX_CLI_PROFILE).toMatchObject({
      builtInProjectInstructionNames: ["AGENTS.override.md", "AGENTS.md"],
      clientVersion: "0.146.0",
      contractVersion: CODEX_CLI_PROFILE_CONTRACT_VERSION,
      defaultProjectDocMaxBytes: 32_768,
      defaultProjectRootMarkers: [".git"],
      globDialectId: null,
      profileId: "codex-cli",
      retrievedAt: "2026-08-01",
      specSnapshotId: "codex-cli/0.146.0/2026-08-01",
      surfaceId: "codex-cli/local-cli-single-cwd",
    });
    expect(CODEX_CLI_PROFILE.evidenceRefs).toEqual([
      "CDX-ROOT-01",
      "CDX-PATH-01",
      "CDX-SEL-01",
      "CDX-MERGE-01",
      "CDX-BYTE-01",
    ]);
  });

  test("exports closed immutable profile-owned data with no executable hooks", () => {
    expect(Object.isFrozen(CODEX_CLI_PROFILE)).toBe(true);
    expect(Object.isFrozen(CODEX_CLI_BUILT_IN_PROJECT_INSTRUCTION_NAMES)).toBe(true);
    expect(Object.isFrozen(CODEX_CLI_DEFAULT_PROJECT_ROOT_MARKERS)).toBe(true);
    expect(Object.isFrozen(CODEX_CLI_PROFILE.evidenceRefs)).toBe(true);
    expect(Reflect.ownKeys(CODEX_CLI_PROFILE).sort()).toEqual(
      [
        "builtInProjectInstructionNames",
        "clientVersion",
        "contractVersion",
        "defaultProjectDocMaxBytes",
        "defaultProjectRootMarkers",
        "evidenceRefs",
        "globDialectId",
        "profileId",
        "retrievedAt",
        "specSnapshotId",
        "surfaceId",
      ].sort(),
    );
    expect(Object.values(CODEX_CLI_PROFILE).some((value) => typeof value === "function")).toBe(
      false,
    );
  });
});
