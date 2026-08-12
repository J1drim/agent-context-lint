import type { DIAGNOSTIC_CONTRACT_VERSION, DiagnosticBundle } from "./diagnostic-contracts.js";
import type { RepositoryRelativePath } from "./repository-path.js";

export const TERMINAL_OUTPUT_SCHEMA_VERSION = "1.0.0" as const;
export const JSON_OUTPUT_SCHEMA_VERSION = "1.0.0" as const;
export const SARIF_OUTPUT_LEGACY_SCHEMA_VERSION = "1.0.0" as const;
export const SARIF_OUTPUT_SCHEMA_VERSION = "2.0.0" as const;
export const EFFICIENCY_OUTPUT_SCHEMA_VERSION = "1.0.0" as const;
export const STANDARDS_OUTPUT_SCHEMA_VERSION = "1.0.0" as const;
export const BASELINE_OUTPUT_SCHEMA_VERSION = "1.0.0" as const;
export const SARIF_VERSION = "2.1.0" as const;
export const SARIF_SCHEMA_URI =
  "https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/schemas/sarif-schema-2.1.0.json" as const;

export const OUTPUT_RECORD_KINDS = [
  "agent-context-terminal-output",
  "agent-context-scan-output",
  "agent-context-efficiency-output",
  "agent-context-standards-output",
  "agent-context-baseline-output",
] as const;
export const OUTPUT_COMPATIBILITY_CHANGES = ["patch", "minor", "major"] as const;

export type OutputRecordKind = (typeof OUTPUT_RECORD_KINDS)[number];
export type OutputCompatibilityChange = (typeof OUTPUT_COMPATIBILITY_CHANGES)[number];

declare const sarifArtifactUriBrand: unique symbol;

/** Canonical RFC 3986 percent-encoded repository-relative path used by SARIF. */
export type SarifArtifactUri = string & {
  readonly [sarifArtifactUriBrand]: "SarifArtifactUri";
};

export interface ProfileVersionIdentity {
  readonly clientVersion: string | null;
  readonly profileVersion: string;
}

export interface OutputSummary {
  readonly errors: number;
  readonly warnings: number;
  readonly infos: number;
  readonly suppressed: number;
  readonly exitCode: 0 | 1 | 2;
}

export interface TerminalOutput {
  readonly recordKind: "agent-context-terminal-output";
  readonly schemaVersion: typeof TERMINAL_OUTPUT_SCHEMA_VERSION;
  readonly colorMode: "ansi" | "never";
  readonly width: number;
  readonly lines: readonly string[];
  readonly summary: OutputSummary;
}

export interface ScanJsonOutput {
  readonly recordKind: "agent-context-scan-output";
  readonly schemaVersion: typeof JSON_OUTPUT_SCHEMA_VERSION;
  readonly profileVersions: Readonly<Record<string, ProfileVersionIdentity>>;
  readonly failureThreshold: "error" | "warning" | "never";
  readonly diagnostics: DiagnosticBundle;
  readonly summary: OutputSummary;
}

export interface EfficiencyTokenStatistics {
  readonly minimum: number;
  readonly median: number;
  readonly p95: number;
  readonly maximum: number;
}

export interface EfficiencyRecommendation {
  readonly id: string;
  readonly title: string;
  readonly path: RepositoryRelativePath;
  readonly baselineTokens: number;
  readonly projectedTokens: number;
  readonly confidence: "high" | "medium" | "low";
  readonly caveats: readonly string[];
  readonly benchmarkStatus: "not-run" | "passed" | "failed";
}

export interface EfficiencyOutput {
  readonly recordKind: "agent-context-efficiency-output";
  readonly schemaVersion: typeof EFFICIENCY_OUTPUT_SCHEMA_VERSION;
  readonly profileId: string;
  readonly profileVersion: string;
  readonly clientVersion: string | null;
  readonly surfaceId: string;
  readonly specSnapshotId: string;
  readonly tokenizer: {
    readonly id: string;
    readonly version: string;
    readonly measurement: "exact" | "estimate";
  };
  readonly sampleCount: number;
  readonly tokenStatistics: EfficiencyTokenStatistics;
  readonly score: {
    readonly version: string;
    readonly value: number;
    readonly grade: "A" | "B" | "C" | "D" | "F";
  };
  readonly recommendations: readonly EfficiencyRecommendation[];
}

export interface StandardsArtifact {
  readonly channel: string;
  readonly version: string;
  readonly digest: string;
  readonly retrievedAt: string;
}

export interface StandardsOutput {
  readonly recordKind: "agent-context-standards-output";
  readonly schemaVersion: typeof STANDARDS_OUTPUT_SCHEMA_VERSION;
  readonly mode: "status" | "check" | "update-dry-run" | "update";
  readonly channel: string;
  readonly bundled: StandardsArtifact;
  readonly locked: StandardsArtifact | null;
  readonly cachedLatest: StandardsArtifact | null;
  readonly activation: "bundled" | "locked";
  readonly freshness: "current" | "update-available" | "offline-unknown";
  readonly problems: readonly string[];
}

export interface BaselineEntry {
  readonly ruleId: string;
  readonly ruleVersion: string;
  readonly severity: "error" | "warning" | "info";
  readonly path: RepositoryRelativePath;
  readonly semanticFingerprint: string;
  readonly pathFingerprint: string;
  readonly provenanceFingerprint: string;
  readonly profileIds: readonly string[];
  readonly surfaceIds: readonly string[];
  readonly specSnapshotIds: readonly string[];
  readonly firstSeenAt: string;
  readonly expiresAt: string | null;
}

export interface BaselineProfileVersionIdentity extends ProfileVersionIdentity {
  readonly surfaceIds: readonly string[];
  readonly specSnapshotIds: readonly string[];
}

export interface BaselineOutput {
  readonly recordKind: "agent-context-baseline-output";
  readonly schemaVersion: typeof BASELINE_OUTPUT_SCHEMA_VERSION;
  readonly diagnosticContractVersion: typeof DIAGNOSTIC_CONTRACT_VERSION;
  readonly engineVersion: string;
  readonly fingerprintMethods: {
    readonly path: string;
    readonly semantic: string;
  };
  readonly createdAt: string;
  readonly expiresAt: string | null;
  readonly sourceRevision: string;
  readonly profileVersions: Readonly<Record<string, BaselineProfileVersionIdentity>>;
  readonly entries: readonly BaselineEntry[];
}

export type NativeOutputDocument =
  BaselineOutput | EfficiencyOutput | ScanJsonOutput | StandardsOutput | TerminalOutput;

export interface SarifOutput {
  readonly version: typeof SARIF_VERSION;
  readonly $schema: typeof SARIF_SCHEMA_URI;
  readonly runs: readonly SarifRun[];
}

export interface SarifRun {
  readonly tool: {
    readonly driver: {
      readonly name: "Agent Context Linter";
      readonly semanticVersion: string;
      readonly informationUri: string;
      readonly rules: readonly SarifReportingDescriptor[];
    };
  };
  readonly results: readonly SarifResult[];
  readonly properties: {
    readonly agentContextSchemaVersion: typeof SARIF_OUTPUT_SCHEMA_VERSION;
    readonly profileVersions: Readonly<Record<string, ProfileVersionIdentity>>;
  };
}

export interface SarifReportingDescriptor {
  readonly id: string;
  readonly name: string;
  readonly shortDescription: { readonly text: string };
  readonly fullDescription: { readonly text: string };
  readonly helpUri: string;
  readonly help: { readonly text: string; readonly markdown: string };
  readonly defaultConfiguration: { readonly level: "error" | "warning" | "note" };
  readonly properties: {
    readonly tags: readonly string[];
    readonly "problem.severity": "error" | "recommendation" | "warning";
    readonly agentContextCategory: string;
    readonly agentContextFixSafety: string;
    readonly agentContextOwner: string;
    readonly agentContextPrecisionStatus: string;
  };
}

export interface SarifRegion {
  readonly startLine: number;
  readonly startColumn: number;
  readonly endLine: number;
  readonly endColumn: number;
}

export interface SarifLocation {
  readonly physicalLocation: {
    readonly artifactLocation: { readonly uri: SarifArtifactUri };
    readonly region: SarifRegion;
  };
}

export interface SarifRelatedLocation extends SarifLocation {
  readonly id: number;
  readonly message: { readonly text: string };
}

export interface SarifResult {
  readonly ruleId: string;
  readonly ruleIndex: number;
  readonly level: "error" | "warning" | "note";
  readonly message: { readonly text: string };
  readonly locations: readonly [SarifLocation];
  readonly relatedLocations: readonly SarifRelatedLocation[];
  readonly partialFingerprints: {
    readonly primaryLocationLineHash: string;
    readonly "agentContextPath/v1": string;
    readonly "agentContextSemantic/v1": string;
  };
  readonly properties: {
    readonly agentContextRuleVersion: string;
    readonly profileIds: readonly string[];
    readonly surfaceIds: readonly string[];
    readonly specSnapshotIds: readonly string[];
  };
}

/** Frozen pre-GA SARIF product-subset v1 shape. New producers emit only SarifOutput v2. */
export interface SarifOutputV1 {
  readonly version: typeof SARIF_VERSION;
  readonly $schema: typeof SARIF_SCHEMA_URI;
  readonly runs: readonly SarifRunV1[];
}

export interface SarifRunV1 {
  readonly tool: {
    readonly driver: {
      readonly name: "Agent Context Linter";
      readonly semanticVersion: string;
      readonly informationUri: string;
      readonly rules: readonly SarifReportingDescriptorV1[];
    };
  };
  readonly results: readonly SarifResultV1[];
  readonly properties: {
    readonly agentContextSchemaVersion: typeof SARIF_OUTPUT_LEGACY_SCHEMA_VERSION;
    readonly profileVersions: Readonly<Record<string, ProfileVersionIdentity>>;
  };
}

export interface SarifReportingDescriptorV1 {
  readonly id: string;
  readonly name: string;
  readonly shortDescription: { readonly text: string };
  readonly defaultConfiguration: { readonly level: "error" | "warning" | "note" };
}

export interface SarifLocationV1 {
  readonly physicalLocation: {
    readonly artifactLocation: { readonly uri: SarifArtifactUri };
    readonly region: SarifRegion;
  };
}

export interface SarifResultV1 {
  readonly ruleId: string;
  readonly ruleIndex: number;
  readonly level: "error" | "warning" | "note";
  readonly message: { readonly text: string };
  readonly locations: readonly [SarifLocationV1];
  readonly relatedLocations: readonly SarifLocationV1[];
  readonly partialFingerprints: Readonly<Record<string, string>>;
}

export type SarifV1MigrationResult =
  | {
      readonly ok: false;
      readonly code: "invalid-v1";
      readonly issues: readonly OutputValidationIssue[];
    }
  | {
      readonly ok: false;
      readonly code: "regeneration-required";
      readonly fromVersion: typeof SARIF_OUTPUT_LEGACY_SCHEMA_VERSION;
      readonly toVersion: typeof SARIF_OUTPUT_SCHEMA_VERSION;
      readonly reason: string;
    };

export type OutputValidationCode =
  | "duplicate-id"
  | "invalid-json"
  | "invalid-order"
  | "invalid-path"
  | "invalid-relationship"
  | "invalid-state"
  | "invalid-value"
  | "missing-field"
  | "resource-limit"
  | "unknown-field"
  | "unsafe-terminal"
  | "unsupported-version";

export interface OutputValidationIssue {
  readonly code: OutputValidationCode;
  readonly path: string;
  readonly message: string;
}

export type OutputValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly OutputValidationIssue[] };

export interface OutputCompatibilityResult {
  readonly change: OutputCompatibilityChange;
  readonly compatible: boolean;
  readonly reason: string;
}

export type OutputSerializationResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly issues: readonly OutputValidationIssue[] };
