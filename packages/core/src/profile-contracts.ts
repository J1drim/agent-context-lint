import type { RepositoryRelativePath } from "./repository-path.js";

/** Version of the public profile-catalog contract. */
export const PROFILE_CATALOG_CONTRACT_VERSION = "0.1.0" as const;

/** Support states frozen by the D01 profile/surface mapping. */
export const SUPPORT_STATES = [
  "supported",
  "conditional",
  "unknown",
  "not-listed",
  "recognized-unsupported",
] as const;

/** Evidence states frozen by the D01 profile/surface mapping. */
export const EVIDENCE_STATES = [
  "documented",
  "documented-versioned",
  "source-derived",
  "observed",
  "observed-metadata",
  "conditional",
  "model-selected",
  "unknown",
  "not-listed",
  "recognized-unsupported",
  "out-of-repository",
  "contradiction",
  "pending-observation",
  "blocked-paid-observation",
  "security-boundary",
] as const;

export const UNCERTAINTY_STATES = ["known", "conditional", "unknown", "contradiction"] as const;

export type DocumentFormatId = string;
export type ClientProfileId = string;
export type SurfaceId = string;
export type SpecSnapshotId = string;
export type CapabilityId = string;
export type EvidenceRefId = string;
export type SupportState = (typeof SUPPORT_STATES)[number];
export type EvidenceState = (typeof EVIDENCE_STATES)[number];
export type UncertaintyState = (typeof UNCERTAINTY_STATES)[number];

/** Syntax identity only. Discovery and activation belong to a profile surface. */
export interface DocumentFormat {
  readonly id: DocumentFormatId;
  readonly syntaxFamily: string;
  readonly syntaxFeatures: readonly string[];
}

/** Product-level identity. A profile may expose more than one independently modeled surface. */
export interface ClientProfile {
  readonly id: ClientProfileId;
  readonly displayName: string;
  readonly releaseClass: "ga-required" | "recognized-evidence-only";
  readonly surfaceIds: readonly SurfaceId[];
}

/** A concrete client execution environment with its own behavioral claims. */
export interface Surface {
  readonly id: SurfaceId;
  readonly profileId: ClientProfileId;
  readonly kind: string;
  readonly specSnapshotIds: readonly SpecSnapshotId[];
  readonly capabilities: readonly SurfaceCapabilityClaim[];
}

export type SpecSourceImmutability = "immutable" | "living" | "observation";

/** Auditable first-party source or repository-owned observation artifact. */
export interface SpecSource {
  readonly id: EvidenceRefId;
  readonly immutability: SpecSourceImmutability;
  readonly url: string | null;
  readonly artifactPath: RepositoryRelativePath | null;
  readonly retrievedAt: string;
  readonly revision: string | null;
  readonly mutableSourceReason: string | null;
}

/** Versioned evidence boundary for one or more profile surfaces. */
export interface SpecSnapshot {
  readonly id: SpecSnapshotId;
  readonly profileIds: readonly ClientProfileId[];
  readonly surfaceIds: readonly SurfaceId[];
  readonly clientVersion: string | null;
  readonly versionStatus: string;
  readonly retrievedAt: string;
  readonly sources: readonly SpecSource[];
  readonly assumptions: readonly string[];
}

/** Defines a behavioral capability without assigning it to syntax or a client. */
export interface CapabilityDefinition {
  readonly id: CapabilityId;
  readonly description: string;
  readonly scope: "surface" | "surface-format";
}

export interface KnownUncertainty {
  readonly state: "known";
}

export interface ConditionalUncertainty {
  readonly state: "conditional";
  readonly conditions: readonly string[];
}

export interface UnknownUncertainty {
  readonly state: "unknown";
  readonly reason: string;
}

export interface ContradictionAlternative {
  readonly id: string;
  readonly description: string;
}

export interface ContradictionUncertainty {
  readonly state: "contradiction";
  readonly reason: string;
  readonly alternatives: readonly ContradictionAlternative[];
}

/** Explicit uncertainty; absence is never interpreted as certainty. */
export type Uncertainty =
  ConditionalUncertainty | ContradictionUncertainty | KnownUncertainty | UnknownUncertainty;

/** Evidence-backed support claim for a capability or a format relationship. */
export interface SupportClaim {
  readonly support: SupportState;
  readonly evidence: readonly EvidenceState[];
  readonly evidenceRefs: readonly EvidenceRefId[];
  readonly uncertainty: Uncertainty;
}

/** A capability claim owned by a surface or a surface/format relationship. */
export interface CapabilityClaim extends SupportClaim {
  readonly capabilityId: CapabilityId;
}

/** A surface capability pins its evidence to exactly one of the surface's snapshots. */
export interface SurfaceCapabilityClaim extends CapabilityClaim {
  readonly specSnapshotId: SpecSnapshotId;
}

/** Connects syntax to consumer behavior without embedding that behavior in DocumentFormat. */
export interface SurfaceFormatSupport {
  readonly surfaceId: SurfaceId;
  readonly formatId: DocumentFormatId;
  readonly specSnapshotId: SpecSnapshotId;
  readonly recognition: SupportClaim;
  readonly capabilities: readonly CapabilityClaim[];
}

/** Closed v0 public catalog. Every member is JSON serializable. */
export interface ProfileCatalog {
  readonly recordKind: "agent-context-profile-catalog";
  readonly contractVersion: typeof PROFILE_CATALOG_CONTRACT_VERSION;
  readonly documentFormats: readonly DocumentFormat[];
  readonly clientProfiles: readonly ClientProfile[];
  readonly surfaces: readonly Surface[];
  readonly specSnapshots: readonly SpecSnapshot[];
  readonly capabilityDefinitions: readonly CapabilityDefinition[];
  readonly formatSupport: readonly SurfaceFormatSupport[];
}

export type ProfileCatalogValidationCode =
  | "duplicate-id"
  | "invalid-date"
  | "invalid-json"
  | "invalid-relationship"
  | "invalid-state"
  | "invalid-value"
  | "missing-field"
  | "resource-limit"
  | "unknown-field";

export interface ProfileCatalogValidationIssue {
  readonly code: ProfileCatalogValidationCode;
  readonly message: string;
  readonly path: string;
}

export interface ValidProfileCatalogResult {
  readonly ok: true;
  readonly value: ProfileCatalog;
}

export interface InvalidProfileCatalogResult {
  readonly ok: false;
  readonly issues: readonly ProfileCatalogValidationIssue[];
}

export type ProfileCatalogValidationResult =
  InvalidProfileCatalogResult | ValidProfileCatalogResult;
