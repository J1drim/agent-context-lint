import { describe, expect, it } from "vitest";

import {
  GEMINI_CLI_DEFAULT_CONTEXT_FILENAMES,
  GEMINI_CLI_DEFAULT_MEMORY_BOUNDARY_MARKERS,
  GEMINI_CLI_PROFILE,
} from "../src/index.js";

describe("Gemini CLI profile descriptor", () => {
  it("pins the D09 package, source snapshots, defaults, and evidence", () => {
    expect(GEMINI_CLI_PROFILE).toMatchObject({
      clientVersion: "0.53.1",
      currentSourceSha: "f47d6c6f7a1308d81f9f57acf7d279f0928c5249",
      profileId: "gemini-cli",
      specSnapshotId: "gemini-cli/2026-08-02.0",
      stableSourceSha: "19a68016bdc9cd4177a155846dd51f282c3c1c59",
      surfaceId: "gemini-cli/local-terminal",
    });
    expect(GEMINI_CLI_DEFAULT_CONTEXT_FILENAMES).toEqual(["GEMINI.md"]);
    expect(GEMINI_CLI_DEFAULT_MEMORY_BOUNDARY_MARKERS).toEqual([".git"]);
    expect(GEMINI_CLI_PROFILE.evidenceRefs).toContain("GEM-IGN-003");
    expect(Object.isFrozen(GEMINI_CLI_PROFILE)).toBe(true);
    expect(Object.isFrozen(GEMINI_CLI_PROFILE.evidenceRefs)).toBe(true);
  });
});
