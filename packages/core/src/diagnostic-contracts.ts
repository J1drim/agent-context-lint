import type {
  ActivationRuleId,
  ResolutionEventId,
  ResolutionTargetId,
  SourceDocumentId,
  SourceRange,
} from "./ir-contracts.js";
import type {
  ClientProfileId,
  EvidenceRefId,
  SpecSnapshotId,
  SurfaceId,
  Uncertainty,
} from "./profile-contracts.js";
import type { RepositoryRelativePath } from "./repository-path.js";

export const DIAGNOSTIC_CONTRACT_VERSION = "0.1.0" as const;
export const DIAGNOSTIC_SEVERITIES = ["error", "warning", "info"] as const;
export const RELATED_EVIDENCE_KINDS = ["source", "repository-fact", "resolution", "spec"] as const;
export const FIX_OPERATION_KINDS = ["text-edit", "move-document", "create-document"] as const;
export const SUPPRESSION_STATES = ["applicable", "suppressed", "unused"] as const;
export const PATH_FINGERPRINT_METHOD = "agent-context-lint/path/v1" as const;
export const SEMANTIC_FINGERPRINT_METHOD = "agent-context-lint/semantic/v1" as const;

declare const diagnosticIdBrand: unique symbol;
declare const evidenceIdBrand: unique symbol;
declare const fixPlanIdBrand: unique symbol;
declare const suppressionIdBrand: unique symbol;
declare const fingerprintBrand: unique symbol;

export type DiagnosticId = string & { readonly [diagnosticIdBrand]: "DiagnosticId" };
export type RelatedEvidenceId = string & { readonly [evidenceIdBrand]: "RelatedEvidenceId" };
export type FixPlanId = string & { readonly [fixPlanIdBrand]: "FixPlanId" };
export type SuppressionId = string & { readonly [suppressionIdBrand]: "SuppressionId" };
export type DiagnosticFingerprint = string & {
  readonly [fingerprintBrand]: "DiagnosticFingerprint";
};
export type DiagnosticSeverity = (typeof DIAGNOSTIC_SEVERITIES)[number];
export type RelatedEvidenceKind = (typeof RELATED_EVIDENCE_KINDS)[number];
export type FixOperationKind = (typeof FIX_OPERATION_KINDS)[number];
export type SuppressionState = (typeof SUPPRESSION_STATES)[number];

/** Repository-contained source location bound to exact B03 source bytes. */
export interface DiagnosticSourceLocation {
  readonly sourceId: SourceDocumentId;
  readonly path: RepositoryRelativePath;
  readonly sourceDigest: string;
  readonly range: SourceRange;
}

interface RelatedEvidenceBase {
  readonly id: RelatedEvidenceId;
  readonly label: string;
}

export interface SourceRelatedEvidence extends RelatedEvidenceBase {
  readonly kind: "source";
  readonly location: DiagnosticSourceLocation;
}

export interface RepositoryFactRelatedEvidence extends RelatedEvidenceBase {
  readonly kind: "repository-fact";
  readonly collectorId: string;
  readonly factId: string;
  readonly subjectPath: RepositoryRelativePath | null;
  readonly valueDigest: string;
  readonly locations: readonly DiagnosticSourceLocation[];
}

export interface ResolutionEvidenceRef {
  readonly evidenceRefId: EvidenceRefId;
  readonly factId: string | null;
}

export interface ResolutionRelatedEvidence extends RelatedEvidenceBase {
  readonly kind: "resolution";
  readonly profileId: ClientProfileId;
  readonly surfaceId: SurfaceId;
  readonly specSnapshotId: SpecSnapshotId;
  readonly eventIds: readonly ResolutionEventId[];
  readonly targetIds: readonly ResolutionTargetId[];
  readonly activationRuleIds: readonly ActivationRuleId[];
  readonly sourceLocations: readonly DiagnosticSourceLocation[];
  readonly evidenceRefs: readonly ResolutionEvidenceRef[];
  readonly uncertainty: Uncertainty;
}

export interface SpecRelatedEvidence extends RelatedEvidenceBase {
  readonly kind: "spec";
  readonly specSnapshotId: SpecSnapshotId;
  readonly evidenceRefId: EvidenceRefId;
  readonly factId: string | null;
  readonly url: string;
  readonly retrievedAt: string;
  readonly revision: string | null;
}

export type RelatedEvidence =
  | RepositoryFactRelatedEvidence
  | ResolutionRelatedEvidence
  | SourceRelatedEvidence
  | SpecRelatedEvidence;

interface SourceBoundFixOperation {
  readonly sourceId: SourceDocumentId;
  readonly path: RepositoryRelativePath;
  readonly sourceDigest: string;
}

/** LSP-shaped bounded replacement over B03's zero-based half-open range. */
export interface TextEditFixOperation extends SourceBoundFixOperation {
  readonly kind: "text-edit";
  readonly range: SourceRange;
  readonly newText: string;
}

/** Whole-document move. The destination must still be absent when the plan is applied. */
export interface MoveDocumentFixOperation extends SourceBoundFixOperation {
  readonly kind: "move-document";
  readonly destinationPath: RepositoryRelativePath;
  readonly destinationPrecondition: "absent";
}

/** New document creation. The destination must still be absent when the plan is applied. */
export interface CreateDocumentFixOperation {
  readonly kind: "create-document";
  readonly path: RepositoryRelativePath;
  readonly destinationPrecondition: "absent";
  readonly content: string;
  readonly contentDigest: string;
}

export type FixOperation =
  CreateDocumentFixOperation | MoveDocumentFixOperation | TextEditFixOperation;

/**
 * Previewable all-or-nothing mutation intent. I10/I11 own filesystem application and must verify
 * every precondition before applying any operation.
 */
export interface AtomicFixPlan {
  readonly id: FixPlanId;
  readonly title: string;
  readonly safety: "mechanical";
  readonly application: "atomic";
  readonly operations: readonly FixOperation[];
}

export interface DiagnosticSuggestion {
  readonly message: string;
  readonly fixPlan: AtomicFixPlan | null;
}

export interface FingerprintComponent {
  readonly key: string;
  readonly value: string;
}

export interface PathFingerprintBasis {
  readonly anchor: string;
  readonly profileIds: readonly ClientProfileId[];
}

export interface SemanticFingerprintBasis {
  readonly components: readonly FingerprintComponent[];
  readonly profileIds: readonly ClientProfileId[];
}

export interface DiagnosticFingerprintBasis {
  readonly path: PathFingerprintBasis;
  readonly semantic: SemanticFingerprintBasis;
}

export interface VersionedFingerprint {
  readonly method: typeof PATH_FINGERPRINT_METHOD | typeof SEMANTIC_FINGERPRINT_METHOD;
  readonly value: DiagnosticFingerprint;
}

export interface DiagnosticFingerprints {
  readonly path: VersionedFingerprint;
  readonly semantic: VersionedFingerprint;
}

export interface Diagnostic {
  readonly id: DiagnosticId;
  readonly ruleId: string;
  readonly ruleVersion: string;
  readonly severity: DiagnosticSeverity;
  readonly message: string;
  readonly primary: DiagnosticSourceLocation;
  readonly related: readonly RelatedEvidence[];
  readonly suggestion: DiagnosticSuggestion | null;
  readonly fingerprintBasis: DiagnosticFingerprintBasis;
  readonly fingerprints: DiagnosticFingerprints;
}

/** B08 emits applicable records; F15 changes them to suppressed or unused after matching. */
export interface SuppressionRecord {
  readonly id: SuppressionId;
  readonly state: SuppressionState;
  readonly directive: DiagnosticSourceLocation;
  readonly targetRuleIds: readonly string[];
  readonly reason: string | null;
  readonly matchedPathFingerprints: readonly DiagnosticFingerprint[];
  readonly evidence: readonly RelatedEvidence[];
}

/** Closed JSON-safe B04 transport contract. Source bytes remain in the validated B03 IR. */
export interface DiagnosticBundle {
  readonly recordKind: "agent-context-diagnostics";
  readonly contractVersion: typeof DIAGNOSTIC_CONTRACT_VERSION;
  readonly diagnostics: readonly Diagnostic[];
  readonly suppressions: readonly SuppressionRecord[];
}

export type DiagnosticContractValidationCode =
  | "duplicate-id"
  | "invalid-date"
  | "invalid-digest"
  | "invalid-fingerprint"
  | "invalid-json"
  | "invalid-order"
  | "invalid-path"
  | "invalid-range"
  | "invalid-relationship"
  | "invalid-state"
  | "invalid-value"
  | "missing-field"
  | "overlapping-edit"
  | "resource-limit"
  | "unknown-field";

export interface DiagnosticContractValidationIssue {
  readonly code: DiagnosticContractValidationCode;
  readonly message: string;
  readonly path: string;
}

export type DiagnosticContractValidationResult =
  | { readonly ok: true; readonly value: DiagnosticBundle }
  | { readonly ok: false; readonly issues: readonly DiagnosticContractValidationIssue[] };
