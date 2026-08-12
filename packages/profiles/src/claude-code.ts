export const CLAUDE_CODE_PROFILE_CONTRACT_VERSION = "0.1.0" as const;
export const CLAUDE_CODE_PROFILE_ID = "claude-code" as const;
export const CLAUDE_CODE_SURFACE_ID = "claude-code/local-session" as const;
export const CLAUDE_CODE_SPEC_SNAPSHOT_ID = "claude-code/2026-08-01" as const;
export const CLAUDE_CODE_RULE_GLOB_DIALECT_ID =
  "claude-code/project-rule-paths/2026-08-01" as const;

export interface ClaudeCodeVersionBoundary {
  readonly evidenceRef: string;
  readonly minimumVersion: string;
  readonly behavior:
    | "bounded-brace-expansion"
    | "invalid-glob-isolated"
    | "project-source-filters-rules"
    | "symlink-path-rule-activation";
}

export interface ClaudeCodeProfileDescriptor {
  readonly contractVersion: typeof CLAUDE_CODE_PROFILE_CONTRACT_VERSION;
  readonly evidenceRefs: readonly string[];
  readonly formatIds: readonly ["claude-memory-markdown", "claude-rule-markdown"];
  readonly importDepth: 4;
  readonly profileId: typeof CLAUDE_CODE_PROFILE_ID;
  readonly releaseClass: "ga-required";
  readonly ruleGlobDialectId: typeof CLAUDE_CODE_RULE_GLOB_DIALECT_ID;
  readonly specSnapshotId: typeof CLAUDE_CODE_SPEC_SNAPSHOT_ID;
  readonly surfaceId: typeof CLAUDE_CODE_SURFACE_ID;
  readonly versionBoundaries: readonly ClaudeCodeVersionBoundary[];
  readonly versionStatus: "living-docs-pending-observation";
}

const VERSION_BOUNDARIES: readonly ClaudeCodeVersionBoundary[] = Object.freeze([
  Object.freeze({
    behavior: "symlink-path-rule-activation",
    evidenceRef: "CC-VERSION-2.1.198",
    minimumVersion: "2.1.198",
  }),
  Object.freeze({
    behavior: "invalid-glob-isolated",
    evidenceRef: "CC-VERSION-2.1.207",
    minimumVersion: "2.1.207",
  }),
  Object.freeze({
    behavior: "project-source-filters-rules",
    evidenceRef: "CC-VERSION-2.1.211",
    minimumVersion: "2.1.211",
  }),
  Object.freeze({
    behavior: "bounded-brace-expansion",
    evidenceRef: "CC-VERSION-2.1.217",
    minimumVersion: "2.1.217",
  }),
]);

/** Immutable D04-backed identity. Runtime state remains caller supplied to the D05 resolver. */
export const CLAUDE_CODE_PROFILE: Readonly<ClaudeCodeProfileDescriptor> = Object.freeze({
  contractVersion: CLAUDE_CODE_PROFILE_CONTRACT_VERSION,
  evidenceRefs: Object.freeze(["CC-MEMORY", "CC-SETTINGS", "CC-PERMISSIONS", "CC-CLI"]),
  formatIds: Object.freeze(["claude-memory-markdown", "claude-rule-markdown"] as const),
  importDepth: 4,
  profileId: CLAUDE_CODE_PROFILE_ID,
  releaseClass: "ga-required",
  ruleGlobDialectId: CLAUDE_CODE_RULE_GLOB_DIALECT_ID,
  specSnapshotId: CLAUDE_CODE_SPEC_SNAPSHOT_ID,
  surfaceId: CLAUDE_CODE_SURFACE_ID,
  versionBoundaries: VERSION_BOUNDARIES,
  versionStatus: "living-docs-pending-observation",
});
