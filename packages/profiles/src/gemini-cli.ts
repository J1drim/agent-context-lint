import type { ClientProfileId, SpecSnapshotId, SurfaceId } from "@agent-context/core";

export const GEMINI_CLI_PROFILE_CONTRACT_VERSION = "0.1.0" as const;
export const GEMINI_CLI_PROFILE_ID = "gemini-cli" as ClientProfileId;
export const GEMINI_CLI_SURFACE_ID = "gemini-cli/local-terminal" as SurfaceId;
export const GEMINI_CLI_SPEC_SNAPSHOT_ID = "gemini-cli/2026-08-02.0" as SpecSnapshotId;
export const GEMINI_CLI_DEFAULT_CONTEXT_FILENAMES: readonly ["GEMINI.md"] = Object.freeze([
  "GEMINI.md",
]);
export const GEMINI_CLI_DEFAULT_MEMORY_BOUNDARY_MARKERS: readonly [".git"] = Object.freeze([
  ".git",
]);

export interface GeminiCliProfileDescriptor {
  readonly clientVersion: "0.53.1";
  readonly contractVersion: typeof GEMINI_CLI_PROFILE_CONTRACT_VERSION;
  readonly defaultContextFilenames: readonly ["GEMINI.md"];
  readonly defaultMemoryBoundaryMarkers: readonly [".git"];
  readonly evidenceRefs: readonly string[];
  readonly globDialectId: null;
  readonly profileId: ClientProfileId;
  readonly retrievedAt: "2026-08-02";
  readonly specSnapshotId: SpecSnapshotId;
  readonly stableSourceSha: "19a68016bdc9cd4177a155846dd51f282c3c1c59";
  readonly currentSourceSha: "f47d6c6f7a1308d81f9f57acf7d279f0928c5249";
  readonly surfaceId: SurfaceId;
  readonly versionStatus: "pinned-package-and-source";
}

/** Immutable D10 behavior identity; executable state transitions remain resolver-owned. */
export const GEMINI_CLI_PROFILE: GeminiCliProfileDescriptor = Object.freeze({
  clientVersion: "0.53.1",
  contractVersion: GEMINI_CLI_PROFILE_CONTRACT_VERSION,
  currentSourceSha: "f47d6c6f7a1308d81f9f57acf7d279f0928c5249",
  defaultContextFilenames: GEMINI_CLI_DEFAULT_CONTEXT_FILENAMES,
  defaultMemoryBoundaryMarkers: GEMINI_CLI_DEFAULT_MEMORY_BOUNDARY_MARKERS,
  evidenceRefs: Object.freeze([
    "GEM-LOC-002",
    "GEM-JIT-003",
    "GEM-NAME-002",
    "GEM-SET-001",
    "GEM-IGN-003",
    "GEM-IMP-006",
    "GEM-EVT-002",
  ]),
  globDialectId: null,
  profileId: GEMINI_CLI_PROFILE_ID,
  retrievedAt: "2026-08-02",
  specSnapshotId: GEMINI_CLI_SPEC_SNAPSHOT_ID,
  stableSourceSha: "19a68016bdc9cd4177a155846dd51f282c3c1c59",
  surfaceId: GEMINI_CLI_SURFACE_ID,
  versionStatus: "pinned-package-and-source",
});
