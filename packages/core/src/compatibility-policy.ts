import {
  MAX_VALIDATION_ISSUES,
  ValidationIssueLimitReached,
  validateJsonValue,
} from "./contract-validation.js";

export const COMPATIBILITY_POLICY_VERSION = "1.0.0" as const;
export const MAX_COMPATIBILITY_SURFACE_ID_BYTES = 64 as const;
export const MAX_COMPATIBILITY_CHANGE_ID_BYTES = 256 as const;

export const COMPATIBILITY_CLASSES: readonly ["patch", "minor", "major"] = Object.freeze([
  "patch",
  "minor",
  "major",
] as const);
export const COMPATIBILITY_SURFACE_IDS: readonly [
  "cli",
  "public-library",
  "profile-behavior",
  "output-schema",
  "diagnostic-baseline",
  "knowledge-pack",
] = Object.freeze([
  "cli",
  "public-library",
  "profile-behavior",
  "output-schema",
  "diagnostic-baseline",
  "knowledge-pack",
] as const);

export type CompatibilityClass = (typeof COMPATIBILITY_CLASSES)[number];
export type CompatibilitySurfaceId = (typeof COMPATIBILITY_SURFACE_IDS)[number];

export interface CompatibilityWindow {
  readonly minimumDeprecationMinorReleases: number;
  readonly minimumNoticeDays: number;
  readonly minimumPriorMajorSupportDays: number;
  readonly publishedArtifactRetention: "indefinite";
}

export interface CompatibilityChangeMatrix {
  readonly patch: readonly string[];
  readonly minor: readonly string[];
  readonly major: readonly string[];
}

export interface CompatibilityMigrationPolicy {
  readonly requiredFor: readonly CompatibilityClass[];
  readonly evidence: readonly string[];
}

export interface CompatibilitySurfacePolicy {
  readonly id: CompatibilitySurfaceId;
  readonly versionAuthority: string;
  readonly releaseScheme: "semantic" | "calendar-version-plus-digest";
  readonly window: CompatibilityWindow;
  readonly changes: CompatibilityChangeMatrix;
  readonly migration: CompatibilityMigrationPolicy;
  readonly invariants: readonly string[];
  readonly owners: readonly string[];
  readonly reviewers: readonly string[];
}

export interface CompatibilityEmergencyPolicy {
  readonly allowedTriggers: readonly string[];
  readonly maximumBreakGlassHours: number;
  readonly noticeMayBeShortened: true;
  readonly nonWaivable: readonly string[];
  readonly recordFields: readonly string[];
  readonly requiredApprovals: readonly string[];
  readonly retrospectiveWithinBusinessDays: number;
  readonly reviewWithinHours: number;
}

export interface CompatibilitySemverPolicy {
  readonly accidentalBreakBehavior: string;
  readonly deprecationRelease: "minor";
  readonly externalTakedownBehavior: string;
  readonly preGaBehavior: string;
  readonly publishedPublicPackageAvailability: "indefinite";
  readonly publicPackagesVersionedTogether: true;
  readonly stableMajorFloor: 1;
}

export interface CompatibilityPolicy {
  readonly recordKind: "agent-context-compatibility-policy";
  readonly policyVersion: typeof COMPATIBILITY_POLICY_VERSION;
  readonly effectiveDate: string;
  readonly status: "normative";
  readonly semver: CompatibilitySemverPolicy;
  readonly surfaces: readonly CompatibilitySurfacePolicy[];
  readonly emergency: CompatibilityEmergencyPolicy;
}

const policyValue: CompatibilityPolicy = {
  recordKind: "agent-context-compatibility-policy",
  policyVersion: COMPATIBILITY_POLICY_VERSION,
  effectiveDate: "2026-08-02",
  status: "normative",
  semver: {
    stableMajorFloor: 1,
    deprecationRelease: "minor",
    publicPackagesVersionedTogether: true,
    preGaBehavior:
      "The 1.0.0 release is stable. Any future pre-release line must publish separate release notes and migration fixtures before distribution.",
    accidentalBreakBehavior:
      "Withdraw or supersede the offending release promptly, restore compatibility in the next release, publish affected versions, and never rewrite a published artifact.",
    publishedPublicPackageAvailability: "indefinite",
    externalTakedownBehavior:
      "A registry-enforced, legal, privacy, or security takedown outside project control may make bytes unavailable; retain the immutable package name, version, digest, reason, and incident identity, and never reuse the identity.",
  },
  surfaces: [
    {
      id: "cli",
      versionAuthority: "@agent-context/lint package version",
      releaseScheme: "semantic",
      window: {
        minimumNoticeDays: 180,
        minimumDeprecationMinorReleases: 2,
        minimumPriorMajorSupportDays: 365,
        publishedArtifactRetention: "indefinite",
      },
      changes: {
        patch: [
          "implementation-fix-with-documented-cli-behavior-unchanged",
          "help-or-diagnostic-wording-clarification-with-machine-output-unchanged",
        ],
        minor: [
          "add-command-or-option-with-no-default-behavior-change",
          "deprecate-command-or-option-with-functional-alias",
        ],
        major: [
          "remove-or-rename-command-option-or-environment-input",
          "change-option-meaning-exit-code-default-output-or-default-profile-selection",
          "introduce-implicit-network-write-command-execution-or-telemetry",
        ],
      },
      migration: {
        requiredFor: ["minor", "major"],
        evidence: [
          "packaged-cli-before-and-after-fixture",
          "old-spelling-or-behavior-remains-tested-through-deprecation-window",
          "release-notes-upgrade-and-rollback-instructions",
        ],
      },
      invariants: [
        "normal-scan-remains-deterministic-offline-model-free-read-only-and-command-free",
        "deprecated-aliases-must-not-change-security-or-output-semantics",
        "breaking-default-changes-require-major-release-even-when-an-old-flag-remains",
        "published-package-availability-is-indefinite-and-independent-of-maintenance-support",
        "end-of-life-uses-npm-deprecation-not-project-initiated-unpublish",
      ],
      owners: ["platform-reviewers"],
      reviewers: ["contracts-reviewers", "release-managers", "qa-reviewers"],
    },
    {
      id: "public-library",
      versionAuthority: "@agent-context/core and @agent-context/lint package versions",
      releaseScheme: "semantic",
      window: {
        minimumNoticeDays: 180,
        minimumDeprecationMinorReleases: 2,
        minimumPriorMajorSupportDays: 365,
        publishedArtifactRetention: "indefinite",
      },
      changes: {
        patch: [
          "implementation-fix-with-accepted-inputs-results-and-side-effects-unchanged",
          "type-or-documentation-clarification-that-does-not-narrow-consumers",
        ],
        minor: [
          "add-export-or-optional-input-with-backward-compatible-default",
          "deprecate-export-while-retaining-equivalent-runtime-and-type-path",
        ],
        major: [
          "remove-rename-or-relocate-export",
          "add-required-input-narrow-accepted-input-or-widen-exhaustive-result-union",
          "change-sync-async-cancellation-error-or-capability-side-effect-contract",
        ],
      },
      migration: {
        requiredFor: ["minor", "major"],
        evidence: [
          "consumer-compilation-fixtures-for-old-and-new-api",
          "runtime-migration-fixture-and-pure-adapter-when-representation-changes",
          "release-notes-upgrade-and-rollback-instructions",
        ],
      },
      invariants: [
        "package-exports-is-the-complete-public-boundary",
        "imports-have-no-io-environment-telemetry-signal-or-process-exit-side-effect",
        "both-public-packages-remain-versioned-together-until-superseding-adr",
        "published-package-availability-is-indefinite-and-independent-of-maintenance-support",
        "end-of-life-uses-npm-deprecation-not-project-initiated-unpublish",
      ],
      owners: ["contracts-reviewers"],
      reviewers: ["platform-reviewers", "qa-reviewers", "release-managers"],
    },
    {
      id: "profile-behavior",
      versionAuthority: "profile adapter version and immutable specSnapshotId",
      releaseScheme: "semantic",
      window: {
        minimumNoticeDays: 90,
        minimumDeprecationMinorReleases: 1,
        minimumPriorMajorSupportDays: 365,
        publishedArtifactRetention: "indefinite",
      },
      changes: {
        patch: [
          "provenance-or-wording-correction-with-resolution-graph-unchanged",
          "new-observation-that-confirms-existing-claim-without-changing-certainty",
        ],
        minor: [
          "add-profile-surface-format-or-capability-without-changing-existing-resolution",
          "mark-project-controlled-profile-capability-deprecated-while-retaining-behavior",
        ],
        major: [
          "change-discovery-precedence-import-glob-activation-or-default-resolution-semantics",
          "flip-known-supported-and-unsupported-claim-or-reinterpret-existing-fixture",
          "remove-or-rename-profile-surface-format-capability-or-stable-identifier",
        ],
      },
      migration: {
        requiredFor: ["minor", "major"],
        evidence: [
          "old-and-new-spec-snapshot-fixtures-with-primary-source-provenance",
          "explicit-observed-conditional-unknown-or-contradiction-state",
          "cross-profile-regression-and-user-migration-guidance",
        ],
      },
      invariants: [
        "upstream-drift-first-creates-a-new-dated-snapshot-and-review-trigger-not-a-silent-rewrite",
        "undocumented-or-version-dependent-behavior-remains-conditional-or-unknown",
        "historical-profile-identifiers-snapshots-provenance-and-fixtures-remain-addressable",
        "forced-upstream-removal-may-shorten-notice-only-through-the-emergency-record",
      ],
      owners: ["profile-reviewers"],
      reviewers: ["contracts-reviewers", "qa-reviewers"],
    },
    {
      id: "output-schema",
      versionAuthority: "family-specific schemaVersion contract and immutable JSON Schema $id",
      releaseScheme: "semantic",
      window: {
        minimumNoticeDays: 180,
        minimumDeprecationMinorReleases: 2,
        minimumPriorMajorSupportDays: 365,
        publishedArtifactRetention: "indefinite",
      },
      changes: {
        patch: [
          "validator-or-serializer-fix-with-accepted-shape-and-canonical-bytes-unchanged",
          "schema-description-or-diagnostic-message-clarification",
        ],
        minor: [
          "add-optional-field-with-documented-unknown-field-down-conversion",
          "add-enum-member-only-when-every-supported-consumer-has-safe-unknown-value-behavior",
        ],
        major: [
          "add-required-remove-rename-narrow-or-change-field-meaning",
          "change-recordKind-schemaVersion-schema-id-canonical-order-serializer-bytes-or-compatibility-affecting-resource-limit",
          "change-diagnostic-identity-fingerprint-baseline-matching-or-exit-status-derivation",
        ],
      },
      migration: {
        requiredFor: ["minor", "major"],
        evidence: [
          "frozen-old-and-new-schema-positive-negative-and-boundary-vectors",
          "pure-old-to-new-migrator-and-reviewed-down-converter-when-claimed",
          "packaged-consumer-negotiation-test-and-no-in-place-persisted-artifact-mutation",
        ],
      },
      invariants: [
        "schema-$id-recordKind-and-major-identity-are-never-reassigned-to-new-semantics",
        "newer-producers-are-not-silently-accepted-by-closed-older-validators",
        "every-supported-version-has-an-explicit-export-validator-and-migration-fixture",
        "sarif-standard-version-and-product-subset-version-remain-distinct",
      ],
      owners: ["contracts-reviewers"],
      reviewers: ["qa-reviewers", "platform-reviewers", "release-managers"],
    },
    {
      id: "diagnostic-baseline",
      versionAuthority:
        "agent-context-baseline-output schemaVersion and fingerprint method versions",
      releaseScheme: "semantic",
      window: {
        minimumNoticeDays: 180,
        minimumDeprecationMinorReleases: 2,
        minimumPriorMajorSupportDays: 365,
        publishedArtifactRetention: "indefinite",
      },
      changes: {
        patch: [
          "reader-fix-with-entry-matching-expiry-and-serialized-bytes-unchanged",
          "non-normative-baseline-documentation-clarification",
        ],
        minor: [
          "add-optional-provenance-field-with-explicit-default-and-down-conversion",
          "add-independent-fingerprint-version-with-existing-matching-retained",
        ],
        major: [
          "change-fingerprint-construction-matching-precedence-expiry-or-default-baseline-selection",
          "remove-rename-or-reinterpret-baseline-entry-or-identity-field",
          "silently-rewrite-drop-or-reclassify-persisted-user-baseline-entries",
        ],
      },
      migration: {
        requiredFor: ["minor", "major"],
        evidence: [
          "frozen-old-baseline-match-no-match-rename-and-expiry-fixtures",
          "pure-side-by-side-migration-with-source-and-destination-digests",
          "atomic-write-concurrent-change-and-idempotence-tests",
        ],
      },
      invariants: [
        "persisted-baselines-are-never-mutated-in-place-or-read-as-commands",
        "incompatible-fingerprint-or-schema-versions-fail-closed-and-require-explicit-migration",
        "user-owned-original-remains-recoverable-until-migrated-output-is-validated",
      ],
      owners: ["contracts-reviewers"],
      reviewers: ["qa-reviewers", "fix-reviewers", "security-reviewers"],
    },
    {
      id: "knowledge-pack",
      versionAuthority:
        "H01 exact-SemVer packVersion plus immutable canonical-byte digest; pack schemaVersion is independent",
      releaseScheme: "semantic",
      window: {
        minimumNoticeDays: 30,
        minimumDeprecationMinorReleases: 1,
        minimumPriorMajorSupportDays: 365,
        publishedArtifactRetention: "indefinite",
      },
      changes: {
        patch: [
          "provenance-documentation-or-migration-hint-correction-with-guidance-unchanged",
          "new-immutable-semver-pack-release-that-only-corrects-non-behavioral-data",
        ],
        minor: [
          "add-deprecation-known-field-location-reference-or-deterministic-pattern-within-supported-schema",
          "publish-preview-pack-before-compatible-stable-promotion",
        ],
        major: [
          "change-pack-schema-required-field-meaning-channel-minEngine-or-activation-semantics",
          "change-discovery-parsing-precedence-import-glob-or-executable-rule-logic-that-requires-engine-release",
          "reuse-version-with-different-bytes-cross-channel-promote-without-review-or-activate-unverified-pack",
        ],
      },
      migration: {
        requiredFor: ["minor", "major"],
        evidence: [
          "old-new-pack-schema-fixtures-digest-provenance-and-expected-diagnostic-diff",
          "engine-compatibility-matrix-and-last-trusted-lock-rollback-fixture",
          "signature-replay-freeze-mix-and-match-wrong-channel-wrong-engine-and-revocation-tests",
        ],
      },
      invariants: [
        "h01-packs-are-data-only-immutable-canonical-json-and-closed-schema-validated-after-h02-h03-tuf-verification",
        "packVersion-schemaVersion-adapterVersion-rulesetVersion-and-minEngineVersion-remain-distinct-exact-semver-identities",
        "stable-and-preview-target-roles-remain-separate-and-ci-never-silently-updates",
        "same-version-different-digest-yanked-revoked-expired-or-incompatible-pack-fails-closed",
        "rollback-activates-only-a-previously-verified-compatible-non-revoked-lock",
        "malicious-pack-revocation-overrides-retention-for-activation-but-preserves-audit-identity",
      ],
      owners: ["standards-reviewers"],
      reviewers: ["security-reviewers", "profile-reviewers", "qa-reviewers"],
    },
  ],
  emergency: {
    allowedTriggers: [
      "active-p0-security-incident",
      "compromised-release-signing-or-standards-trust-infrastructure",
      "urgent-rollback-of-harmful-published-artifact",
      "forced-upstream-removal-that-makes-retained-behavior-unsafe-or-impossible",
    ],
    noticeMayBeShortened: true,
    maximumBreakGlassHours: 4,
    reviewWithinHours: 24,
    retrospectiveWithinBusinessDays: 5,
    requiredApprovals: [
      "security-reviewers",
      "governance-reviewers-or-release-managers",
      "affected-domain-owner",
    ],
    recordFields: [
      "incident-id-trigger-and-affected-versions",
      "dri-independent-approvers-and-utc-timeline",
      "compatibility-impact-and-shortened-window-rationale",
      "migration-workaround-rollback-and-user-notification",
      "tests-artifact-digests-expiry-review-and-retrospective",
    ],
    nonWaivable: [
      "repository-root-filesystem-boundary",
      "normal-scan-no-command-execution-no-network-and-read-only-default",
      "signature-digest-schema-channel-and-engine-verification",
      "secret-redaction-and-no-external-repository-mutation",
      "atomic-range-bounded-concurrent-change-safe-fixes",
      "immutable-versioned-artifacts-and-audit-record",
    ],
  },
};

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Canonical, deeply immutable B10 policy. Generated JSON and docs are derived from this value. */
export const COMPATIBILITY_POLICY: CompatibilityPolicy = deepFreeze(policyValue);

export type CompatibilityPolicyValidationCode =
  | "duplicate-id"
  | "invalid-state"
  | "invalid-value"
  | "missing-field"
  | "resource-limit"
  | "unknown-field"
  | "unsupported-version";

export interface CompatibilityPolicyValidationIssue {
  readonly code: CompatibilityPolicyValidationCode;
  readonly message: string;
  readonly path: string;
}

export type CompatibilityPolicyValidationResult =
  | { readonly ok: true; readonly value: CompatibilityPolicy }
  | { readonly ok: false; readonly issues: readonly CompatibilityPolicyValidationIssue[] };

export interface CompatibilityChangeClassification {
  readonly ok: true;
  readonly surfaceId: CompatibilitySurfaceId;
  readonly changeId: string;
  readonly classification: CompatibilityClass;
  readonly migrationRequired: boolean;
  readonly minimumDeprecationMinorReleases: number;
  readonly minimumNoticeDays: number;
  readonly minimumPriorMajorSupportDays: number;
}

export type CompatibilityChangeClassificationResult =
  | CompatibilityChangeClassification
  | {
      readonly ok: false;
      readonly code: "invalid-change" | "invalid-surface";
      readonly reason: string;
    };

export const COMPATIBILITY_POLICY_LIMITS: Readonly<{
  maximumContainerEntries: number;
  maximumKeyBytes: number;
  maximumStringBytes: number;
  maximumTotalStringBytes: number;
  maximumValues: number;
}> = Object.freeze({
  maximumContainerEntries: 128,
  maximumKeyBytes: 128,
  maximumStringBytes: 4_096,
  maximumTotalStringBytes: 262_144,
  maximumValues: 8_192,
});

function appendPath(path: string, key: string): string {
  return /^[A-Za-z_][A-Za-z0-9_-]*$/.test(key)
    ? `${path}.${key}`
    : `${path}[${JSON.stringify(key)}]`;
}

function compareCanonical(
  actual: unknown,
  expected: unknown,
  path: string,
  report: (code: CompatibilityPolicyValidationCode, path: string, message: string) => void,
): void {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      report("invalid-value", path, "must be the policy array published for version 1.0.0");
      return;
    }
    if (actual.length !== expected.length) {
      report(
        "invalid-value",
        path,
        `must contain exactly ${String(expected.length)} policy entries`,
      );
    }
    const commonLength = Math.min(actual.length, expected.length);
    for (let index = 0; index < commonLength; index += 1) {
      compareCanonical(actual[index], expected[index], `${path}[${String(index)}]`, report);
    }
    return;
  }
  if (expected !== null && typeof expected === "object") {
    if (actual === null || typeof actual !== "object" || Array.isArray(actual)) {
      report("invalid-value", path, "must be the policy object published for version 1.0.0");
      return;
    }
    const actualRecord = actual as Record<string, unknown>;
    const expectedRecord = expected as Record<string, unknown>;
    for (const key of Object.keys(actualRecord)) {
      if (!Object.hasOwn(expectedRecord, key)) {
        report("unknown-field", appendPath(path, key), "is not part of policy version 1.0.0");
      }
    }
    for (const [key, expectedValue] of Object.entries(expectedRecord)) {
      const childPath = appendPath(path, key);
      if (!Object.hasOwn(actualRecord, key)) {
        report("missing-field", childPath, "is required by policy version 1.0.0");
      } else {
        compareCanonical(actualRecord[key], expectedValue, childPath, report);
      }
    }
    return;
  }
  if (!Object.is(actual, expected)) {
    report(
      "invalid-value",
      path,
      `must equal the published policy value ${JSON.stringify(expected)}`,
    );
  }
}

function invalidPolicyResult(
  issues: CompatibilityPolicyValidationIssue[],
): CompatibilityPolicyValidationResult {
  for (const issue of issues) Object.freeze(issue);
  Object.freeze(issues);
  return Object.freeze({ issues, ok: false });
}

/**
 * Validate an untrusted machine-readable policy artifact against the exact published authority.
 * The returned value is the immutable in-process authority, never caller-owned input.
 */
export function validateCompatibilityPolicy(input: unknown): CompatibilityPolicyValidationResult {
  const issues: CompatibilityPolicyValidationIssue[] = [];
  const report = (code: CompatibilityPolicyValidationCode, path: string, message: string): void => {
    if (issues.length >= MAX_VALIDATION_ISSUES - 1) {
      if (issues.length === MAX_VALIDATION_ISSUES - 1) {
        issues.push({
          code: "resource-limit",
          message: `validation stopped after ${String(MAX_VALIDATION_ISSUES - 1)} issues`,
          path: "$",
        });
      }
      throw new ValidationIssueLimitReached();
    }
    issues.push({ code, message, path });
  };

  try {
    const safe = validateJsonValue(
      input,
      "$",
      (code, path, message) => {
        report(code, path, message);
      },
      COMPATIBILITY_POLICY_LIMITS,
    );
    if (!safe) return invalidPolicyResult(issues);
    const record = input as Record<string, unknown>;
    if (record["policyVersion"] !== COMPATIBILITY_POLICY_VERSION) {
      report(
        "unsupported-version",
        "$.policyVersion",
        `only policy version ${COMPATIBILITY_POLICY_VERSION} is supported`,
      );
      return invalidPolicyResult(issues);
    }
    compareCanonical(input, COMPATIBILITY_POLICY, "$", report);
  } catch (error) {
    if (!(error instanceof ValidationIssueLimitReached)) {
      return invalidPolicyResult([
        { code: "invalid-value", message: "must be safely inspectable JSON data", path: "$" },
      ]);
    }
  }
  return issues.length === 0
    ? Object.freeze({ ok: true, value: COMPATIBILITY_POLICY })
    : invalidPolicyResult(issues);
}

function isBoundedCompatibilityId(value: unknown, maximumBytes: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumBytes &&
    /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/.test(value) &&
    Buffer.byteLength(value, "utf8") <= maximumBytes
  );
}

function classificationFailure(
  code: "invalid-change" | "invalid-surface",
  reason: string,
): CompatibilityChangeClassificationResult {
  return Object.freeze({ code, ok: false, reason });
}

/** Resolve untrusted identifiers through the closed B10 matrix; unknown input fails closed. */
export function classifyCompatibilityChange(
  surfaceId: unknown,
  changeId: unknown,
): CompatibilityChangeClassificationResult {
  if (!isBoundedCompatibilityId(surfaceId, MAX_COMPATIBILITY_SURFACE_ID_BYTES)) {
    return classificationFailure("invalid-surface", "unsupported compatibility surface");
  }
  const surface = COMPATIBILITY_POLICY.surfaces.find((candidate) => candidate.id === surfaceId);
  if (surface === undefined) {
    return classificationFailure("invalid-surface", "unsupported compatibility surface");
  }
  if (!isBoundedCompatibilityId(changeId, MAX_COMPATIBILITY_CHANGE_ID_BYTES)) {
    return classificationFailure(
      "invalid-change",
      "unrecognized compatibility change; classify at the higher risk until reviewed",
    );
  }
  for (const classification of COMPATIBILITY_CLASSES) {
    if (surface.changes[classification].includes(changeId)) {
      return Object.freeze({
        ok: true,
        surfaceId: surface.id,
        changeId,
        classification,
        migrationRequired: surface.migration.requiredFor.includes(classification),
        minimumDeprecationMinorReleases: surface.window.minimumDeprecationMinorReleases,
        minimumNoticeDays: surface.window.minimumNoticeDays,
        minimumPriorMajorSupportDays: surface.window.minimumPriorMajorSupportDays,
      });
    }
  }
  return classificationFailure(
    "invalid-change",
    "unrecognized compatibility change; classify at the higher risk until reviewed",
  );
}
