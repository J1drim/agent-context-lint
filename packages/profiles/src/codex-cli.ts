import type { ClientProfileId, SpecSnapshotId, SurfaceId } from "@agent-context/core";

/** Version of the closed D03 Codex CLI profile descriptor. */
export const CODEX_CLI_PROFILE_CONTRACT_VERSION = "0.1.0" as const;

export const CODEX_CLI_PROFILE_ID = "codex-cli" as ClientProfileId;
export const CODEX_CLI_SURFACE_ID = "codex-cli/local-cli-single-cwd" as SurfaceId;
export const CODEX_CLI_SPEC_SNAPSHOT_ID = "codex-cli/0.146.0/2026-08-01" as SpecSnapshotId;

export const CODEX_CLI_BUILT_IN_PROJECT_INSTRUCTION_NAMES: readonly [
  "AGENTS.override.md",
  "AGENTS.md",
] = Object.freeze(["AGENTS.override.md", "AGENTS.md"]);

export const CODEX_CLI_DEFAULT_PROJECT_ROOT_MARKERS: readonly [".git"] = Object.freeze([".git"]);

export interface CodexCliProfileDescriptor {
  readonly contractVersion: typeof CODEX_CLI_PROFILE_CONTRACT_VERSION;
  readonly profileId: ClientProfileId;
  readonly surfaceId: SurfaceId;
  readonly specSnapshotId: SpecSnapshotId;
  readonly clientVersion: "0.146.0";
  readonly retrievedAt: "2026-08-01";
  readonly builtInProjectInstructionNames: readonly ["AGENTS.override.md", "AGENTS.md"];
  readonly defaultProjectRootMarkers: readonly [".git"];
  readonly defaultProjectDocMaxBytes: 32_768;
  /** Codex does not use path globs to activate the root-to-CWD AGENTS chain. */
  readonly globDialectId: null;
  readonly evidenceRefs: readonly string[];
}

/**
 * Immutable profile-owned behavior identity. Executable discovery remains in the resolver; this
 * descriptor cannot register callbacks or borrow another profile's E02 glob semantics.
 */
export const CODEX_CLI_PROFILE: CodexCliProfileDescriptor = Object.freeze({
  builtInProjectInstructionNames: CODEX_CLI_BUILT_IN_PROJECT_INSTRUCTION_NAMES,
  clientVersion: "0.146.0",
  contractVersion: CODEX_CLI_PROFILE_CONTRACT_VERSION,
  defaultProjectDocMaxBytes: 32_768,
  defaultProjectRootMarkers: CODEX_CLI_DEFAULT_PROJECT_ROOT_MARKERS,
  evidenceRefs: Object.freeze([
    "CDX-ROOT-01",
    "CDX-PATH-01",
    "CDX-SEL-01",
    "CDX-MERGE-01",
    "CDX-BYTE-01",
  ]),
  globDialectId: null,
  profileId: CODEX_CLI_PROFILE_ID,
  retrievedAt: "2026-08-01",
  specSnapshotId: CODEX_CLI_SPEC_SNAPSHOT_ID,
  surfaceId: CODEX_CLI_SURFACE_ID,
});
