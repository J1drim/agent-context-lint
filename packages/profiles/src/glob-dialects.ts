import type { ClientProfileId, SpecSnapshotId, SurfaceId } from "@agent-context/core";

/** Version of the closed, data-only E02 profile glob-dialect catalog. */
export const PROFILE_GLOB_DIALECT_CONTRACT_VERSION = "0.1.0" as const;

export const PROFILE_GLOB_DIALECT_IDS = [
  "claude-code/project-rule-paths/2026-08-01",
  "copilot-cli/apply-to/2026-08-01",
  "copilot-cloud-agent/apply-to/2026-08-01",
  "copilot-code-review/apply-to/2026-08-01",
  "copilot-vscode/apply-to/2026-08-01",
  "cursor-agent/mdc-globs/2026-08-01",
] as const;

export type ProfileGlobDialectId = (typeof PROFILE_GLOB_DIALECT_IDS)[number];

export type ProfileGlobPatternBase = "repository-root" | "scope-root" | "unknown";
export type ProfileGlobFeatureState = "documented" | "unknown";
export type ProfileGlobBracketState = "invalid-is-no-match" | "unknown";

/**
 * Profile-owned behavior data. The resolver interprets this closed mechanism record; profiles never
 * register executable matchers or inherit a shared default dialect.
 */
export interface ProfileGlobDialect {
  readonly contractVersion: typeof PROFILE_GLOB_DIALECT_CONTRACT_VERSION;
  readonly id: ProfileGlobDialectId;
  readonly profileId: ClientProfileId;
  readonly surfaceIds: readonly SurfaceId[];
  readonly specSnapshotId: SpecSnapshotId;
  readonly patternBase: ProfileGlobPatternBase;
  readonly star: ProfileGlobFeatureState;
  readonly globstar: ProfileGlobFeatureState;
  readonly braceExpansion: ProfileGlobFeatureState;
  readonly braceExpansionMaximumPatterns: number | null;
  readonly braceExpansionMaximumBytes: number | null;
  readonly braceLimitResult: "literal-no-match" | "indeterminate";
  readonly bracketExpressions: ProfileGlobBracketState;
  readonly questionMark: ProfileGlobFeatureState;
  readonly caseSensitivity: "unknown";
  readonly dotfileMatching: "unknown";
  readonly evidenceRefs: readonly string[];
  readonly unknownReason: string | null;
}

function dialect(
  value: Omit<ProfileGlobDialect, "contractVersion" | "caseSensitivity" | "dotfileMatching">,
): ProfileGlobDialect {
  return Object.freeze({
    contractVersion: PROFILE_GLOB_DIALECT_CONTRACT_VERSION,
    caseSensitivity: "unknown",
    dotfileMatching: "unknown",
    ...value,
    evidenceRefs: Object.freeze([...value.evidenceRefs]),
    surfaceIds: Object.freeze([...value.surfaceIds]),
  });
}

/**
 * Closed E02 catalog. Unknown entries are deliberate compatibility results, not incomplete fallback
 * configuration: their first-party snapshots do not define enough behavior for deterministic use.
 */
export const PROFILE_GLOB_DIALECTS: readonly ProfileGlobDialect[] = Object.freeze([
  dialect({
    braceExpansion: "documented",
    braceExpansionMaximumBytes: 4_194_304,
    braceExpansionMaximumPatterns: 1_000,
    braceLimitResult: "literal-no-match",
    bracketExpressions: "invalid-is-no-match",
    evidenceRefs: ["CC-RULE-08", "CC-RULE-09", "CC-RULE-10", "CC-RULE-12", "CC-RULE-13"],
    globstar: "documented",
    id: "claude-code/project-rule-paths/2026-08-01",
    patternBase: "repository-root",
    profileId: "claude-code",
    questionMark: "unknown",
    specSnapshotId: "claude-code/2026-08-01",
    star: "documented",
    surfaceIds: ["claude-code/local-session"],
    unknownReason: null,
  }),
  dialect({
    braceExpansion: "unknown",
    braceExpansionMaximumBytes: null,
    braceExpansionMaximumPatterns: null,
    braceLimitResult: "indeterminate",
    bracketExpressions: "unknown",
    evidenceRefs: ["COP-GAP-004", "COP-PRE-004"],
    globstar: "documented",
    id: "copilot-cli/apply-to/2026-08-01",
    patternBase: "unknown",
    profileId: "copilot-cli",
    questionMark: "unknown",
    specSnapshotId: "copilot-surfaces/2026-08-01.0",
    star: "documented",
    surfaceIds: ["copilot-cli/local-terminal"],
    unknownReason: "Copilot CLI does not document the pattern base or a complete glob dialect.",
  }),
  dialect({
    braceExpansion: "unknown",
    braceExpansionMaximumBytes: null,
    braceExpansionMaximumPatterns: null,
    braceLimitResult: "indeterminate",
    bracketExpressions: "unknown",
    evidenceRefs: ["COP-GAP-004", "COP-PRE-004"],
    globstar: "documented",
    id: "copilot-cloud-agent/apply-to/2026-08-01",
    patternBase: "unknown",
    profileId: "copilot-cloud-agent",
    questionMark: "unknown",
    specSnapshotId: "copilot-surfaces/2026-08-01.0",
    star: "documented",
    surfaceIds: ["copilot-cloud-agent/github-hosted"],
    unknownReason: "The hosted coding-agent snapshot does not document the pattern base.",
  }),
  dialect({
    braceExpansion: "unknown",
    braceExpansionMaximumBytes: null,
    braceExpansionMaximumPatterns: null,
    braceLimitResult: "indeterminate",
    bracketExpressions: "unknown",
    evidenceRefs: ["COP-GAP-004", "COP-PRE-004"],
    globstar: "documented",
    id: "copilot-code-review/apply-to/2026-08-01",
    patternBase: "unknown",
    profileId: "copilot-code-review",
    questionMark: "unknown",
    specSnapshotId: "copilot-surfaces/2026-08-01.0",
    star: "documented",
    surfaceIds: ["copilot-code-review/github-hosted"],
    unknownReason: "The hosted code-review snapshot does not document the pattern base.",
  }),
  dialect({
    braceExpansion: "documented",
    braceExpansionMaximumBytes: null,
    braceExpansionMaximumPatterns: null,
    braceLimitResult: "indeterminate",
    bracketExpressions: "unknown",
    evidenceRefs: ["COP-PRE-004", "VSC-INSTRUCTIONS"],
    globstar: "documented",
    id: "copilot-vscode/apply-to/2026-08-01",
    patternBase: "scope-root",
    profileId: "copilot-vscode",
    questionMark: "unknown",
    specSnapshotId: "copilot-surfaces/2026-08-01.0",
    star: "documented",
    surfaceIds: ["copilot-vscode/local-chat"],
    unknownReason: null,
  }),
  dialect({
    braceExpansion: "unknown",
    braceExpansionMaximumBytes: null,
    braceExpansionMaximumPatterns: null,
    braceLimitResult: "indeterminate",
    bracketExpressions: "unknown",
    evidenceRefs: ["CURSOR-GLOB-03", "CURSOR-GLOB-05", "CURSOR-GLOB-06", "CURSOR-GLOB-07"],
    globstar: "unknown",
    id: "cursor-agent/mdc-globs/2026-08-01",
    patternBase: "unknown",
    profileId: "cursor-agent",
    questionMark: "unknown",
    specSnapshotId: "cursor/2026-08-01",
    star: "unknown",
    surfaceIds: ["cursor-agent/cli", "cursor-agent/ide"],
    unknownReason: "Cursor does not publish a complete MDC glob grammar or pattern base.",
  }),
]);

const DIALECT_BY_ID: ReadonlyMap<string, ProfileGlobDialect> = new Map(
  PROFILE_GLOB_DIALECTS.map((entry) => [entry.id, entry]),
);

/** Returns immutable built-in behavior data; an unknown ID has no fallback semantics. */
export function profileGlobDialect(id: string): ProfileGlobDialect | undefined {
  return DIALECT_BY_ID.get(id);
}
