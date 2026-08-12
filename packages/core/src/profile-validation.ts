import {
  MAX_VALIDATION_ISSUES,
  VALIDATION_ISSUE_LIMIT_CODE,
  ValidationIssueLimitReached,
  validateJsonValue,
  validateUncertaintyValue,
} from "./contract-validation.js";
import {
  EVIDENCE_STATES,
  PROFILE_CATALOG_CONTRACT_VERSION,
  SUPPORT_STATES,
} from "./profile-contracts.js";
import { REPOSITORY_ROOT, isRepositoryRelativePath } from "./repository-path.js";
import type {
  ProfileCatalog,
  ProfileCatalogValidationCode,
  ProfileCatalogValidationIssue,
  ProfileCatalogValidationResult,
} from "./profile-contracts.js";

interface UnknownRecord {
  readonly [key: string]: unknown;
  readonly capabilities?: unknown;
  readonly capabilityDefinitions?: unknown;
  readonly capabilityId?: unknown;
  readonly clientProfiles?: unknown;
  readonly conditions?: unknown;
  readonly documentFormats?: unknown;
  readonly evidenceRefs?: unknown;
  readonly formatId?: unknown;
  readonly formatSupport?: unknown;
  readonly id?: unknown;
  readonly profileId?: unknown;
  readonly profileIds?: unknown;
  readonly recognition?: unknown;
  readonly scope?: unknown;
  readonly sources?: unknown;
  readonly specSnapshotId?: unknown;
  readonly specSnapshotIds?: unknown;
  readonly specSnapshots?: unknown;
  readonly surfaceId?: unknown;
  readonly surfaceIds?: unknown;
  readonly surfaces?: unknown;
  readonly uncertainty?: unknown;
}

const NON_DETERMINISTIC_EVIDENCE: ReadonlySet<string> = new Set([
  "blocked-paid-observation",
  "conditional",
  "contradiction",
  "model-selected",
  "not-listed",
  "pending-observation",
  "unknown",
]);

const SUPPORT_STATE_SET: ReadonlySet<string> = new Set(SUPPORT_STATES);
const EVIDENCE_STATE_SET: ReadonlySet<string> = new Set(EVIDENCE_STATES);
const IDENTIFIER_PATTERN = /^[A-Za-z0-9]+(?:[._:/-][A-Za-z0-9]+)*$/;

function issue(
  issues: ProfileCatalogValidationIssue[],
  code: ProfileCatalogValidationCode,
  path: string,
  message: string,
): void {
  if (issues.length >= MAX_VALIDATION_ISSUES - 1) {
    if (issues.length === MAX_VALIDATION_ISSUES - 1) {
      issues.push({
        code: VALIDATION_ISSUE_LIMIT_CODE,
        message: `validation stopped after ${String(MAX_VALIDATION_ISSUES - 1)} issues`,
        path: "$",
      });
    }
    throw new ValidationIssueLimitReached();
  }
  issues.push({ code, message, path });
}

function objectValue(
  value: unknown,
  path: string,
  keys: readonly string[],
  issues: ProfileCatalogValidationIssue[],
): UnknownRecord | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    issue(issues, "invalid-value", path, "must be an object");
    return undefined;
  }

  const record: UnknownRecord = value as UnknownRecord;
  const allowed: ReadonlySet<string> = new Set(keys);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      issue(issues, "unknown-field", `${path}.${key}`, "is not part of contract version 0.1.0");
    }
  }
  return record;
}

function requiredString(
  record: UnknownRecord,
  key: string,
  path: string,
  issues: ProfileCatalogValidationIssue[],
): string | undefined {
  const value: unknown = record[key];
  if (value === undefined) {
    issue(issues, "missing-field", `${path}.${key}`, "is required");
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0) {
    issue(issues, "invalid-value", `${path}.${key}`, "must be a non-empty string");
    return undefined;
  }
  return value;
}

function requiredIdentifier(
  record: UnknownRecord,
  key: string,
  path: string,
  issues: ProfileCatalogValidationIssue[],
): string | undefined {
  const value = requiredString(record, key, path, issues);
  if (value !== undefined && !IDENTIFIER_PATTERN.test(value)) {
    issue(
      issues,
      "invalid-value",
      `${path}.${key}`,
      "must be a stable identifier made of alphanumeric segments separated by '.', '_', ':', '/', or '-'",
    );
    return undefined;
  }
  return value;
}

function nullableString(
  record: UnknownRecord,
  key: string,
  path: string,
  issues: ProfileCatalogValidationIssue[],
): string | null | undefined {
  const value: unknown = record[key];
  if (value === undefined) {
    issue(
      issues,
      "missing-field",
      `${path}.${key}`,
      "is required and must be explicit when unknown",
    );
    return undefined;
  }
  if (value !== null && (typeof value !== "string" || value.length === 0)) {
    issue(issues, "invalid-value", `${path}.${key}`, "must be null or a non-empty string");
    return undefined;
  }
  return value;
}

function stringArray(
  record: UnknownRecord,
  key: string,
  path: string,
  issues: ProfileCatalogValidationIssue[],
  minimum = 0,
): readonly string[] | undefined {
  const value: unknown = record[key];
  const itemPath = `${path}.${key}`;
  if (value === undefined) {
    issue(issues, "missing-field", itemPath, "is required");
    return undefined;
  }
  if (!Array.isArray(value)) {
    issue(issues, "invalid-value", itemPath, "must be an array");
    return undefined;
  }
  const output: string[] = [];
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "string" || entry.length === 0) {
      issue(issues, "invalid-value", `${itemPath}[${String(index)}]`, "must be a non-empty string");
    } else {
      output.push(entry);
    }
  }
  if (value.length < minimum) {
    issue(issues, "invalid-value", itemPath, `must contain at least ${String(minimum)} item(s)`);
  }
  if (new Set(output).size !== output.length) {
    issue(issues, "duplicate-id", itemPath, "must not contain duplicate values");
  }
  return output;
}

function identifierArray(
  record: UnknownRecord,
  key: string,
  path: string,
  issues: ProfileCatalogValidationIssue[],
  minimum = 0,
): readonly string[] | undefined {
  const values = stringArray(record, key, path, issues, minimum);
  if (values === undefined) return undefined;
  for (const [index, value] of values.entries()) {
    if (!IDENTIFIER_PATTERN.test(value)) {
      issue(
        issues,
        "invalid-value",
        `${path}.${key}[${String(index)}]`,
        "must be a stable identifier made of alphanumeric segments separated by '.', '_', ':', '/', or '-'",
      );
    }
  }
  return values;
}

function objectArray(
  record: UnknownRecord,
  key: string,
  path: string,
  issues: ProfileCatalogValidationIssue[],
): readonly unknown[] | undefined {
  const value: unknown = record[key];
  const itemPath = `${path}.${key}`;
  if (value === undefined) {
    issue(issues, "missing-field", itemPath, "is required");
    return undefined;
  }
  if (!Array.isArray(value)) {
    issue(issues, "invalid-value", itemPath, "must be an array");
    return undefined;
  }
  const output: unknown[] = [];
  for (const entry of value) output.push(entry as unknown);
  return output;
}

function enumString(
  record: UnknownRecord,
  key: string,
  path: string,
  allowed: ReadonlySet<string>,
  issues: ProfileCatalogValidationIssue[],
): string | undefined {
  const value = requiredString(record, key, path, issues);
  if (value !== undefined && !allowed.has(value)) {
    issue(issues, "invalid-state", `${path}.${key}`, `has unsupported state '${value}'`);
    return undefined;
  }
  return value;
}

function validateDate(
  value: string | undefined,
  path: string,
  issues: ProfileCatalogValidationIssue[],
): void {
  if (value === undefined) return;
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  const roundTripped = Number.isNaN(timestamp)
    ? null
    : new Date(timestamp).toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || roundTripped !== value) {
    issue(issues, "invalid-date", path, "must be a real YYYY-MM-DD calendar date");
  }
}

function hasUrlWhitespaceOrControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x20 || codeUnit === 0x7f) return true;
  }
  return false;
}

function isValidHttpsUrl(value: string): boolean {
  if (
    !/^https:\/\/[^/]/.test(value) ||
    hasUrlWhitespaceOrControl(value) ||
    value.includes("\\") ||
    /%(?![0-9A-Fa-f]{2})/.test(value)
  ) {
    return false;
  }
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "https:" &&
      parsed.hostname.length > 0 &&
      parsed.username.length === 0 &&
      parsed.password.length === 0
    );
  } catch {
    return false;
  }
}

function validateClaim(
  value: unknown,
  path: string,
  issues: ProfileCatalogValidationIssue[],
  includeCapabilityId: boolean,
  includeSnapshotId = false,
): void {
  const keys = [
    ...(includeCapabilityId ? ["capabilityId"] : []),
    ...(includeSnapshotId ? ["specSnapshotId"] : []),
    "support",
    "evidence",
    "evidenceRefs",
    "uncertainty",
  ];
  const record = objectValue(value, path, keys, issues);
  if (record === undefined) return;
  if (includeCapabilityId) requiredIdentifier(record, "capabilityId", path, issues);
  if (includeSnapshotId) requiredIdentifier(record, "specSnapshotId", path, issues);
  const support = enumString(record, "support", path, SUPPORT_STATE_SET, issues);
  const evidence = stringArray(record, "evidence", path, issues, 1);
  if (evidence !== undefined) {
    for (const [index, state] of evidence.entries()) {
      if (!EVIDENCE_STATE_SET.has(state)) {
        issue(
          issues,
          "invalid-state",
          `${path}.evidence[${String(index)}]`,
          `has unsupported state '${state}'`,
        );
      }
    }
  }
  identifierArray(record, "evidenceRefs", path, issues, 1);
  if (record.uncertainty === undefined) {
    issue(
      issues,
      "missing-field",
      `${path}.uncertainty`,
      "is required; certainty cannot be inferred",
    );
    return;
  }
  const uncertainty = validateUncertaintyValue(
    record.uncertainty,
    `${path}.uncertainty`,
    (code, issuePath, message) => {
      issue(issues, code, issuePath, message);
    },
  );
  if (support === "unknown" && uncertainty !== "unknown" && uncertainty !== "contradiction") {
    issue(
      issues,
      "invalid-state",
      `${path}.uncertainty.state`,
      "unknown support requires unknown or contradiction uncertainty",
    );
  }
  if (support === "not-listed" && uncertainty !== "unknown" && uncertainty !== "contradiction") {
    issue(
      issues,
      "invalid-state",
      `${path}.uncertainty.state`,
      "not-listed support requires unknown or contradiction uncertainty",
    );
  }
  if (
    support === "conditional" &&
    uncertainty !== "conditional" &&
    uncertainty !== "contradiction"
  ) {
    issue(
      issues,
      "invalid-state",
      `${path}.uncertainty.state`,
      "conditional support requires conditional or contradiction uncertainty",
    );
  }
  if (evidence?.includes("contradiction") === true && uncertainty !== "contradiction") {
    issue(
      issues,
      "invalid-state",
      `${path}.uncertainty.state`,
      "contradictory evidence requires contradiction uncertainty",
    );
  }
  if (uncertainty === "contradiction" && evidence?.includes("contradiction") !== true) {
    issue(
      issues,
      "invalid-state",
      `${path}.evidence`,
      "contradiction uncertainty requires contradiction evidence",
    );
  }
  if (
    uncertainty === "known" &&
    evidence?.some((state) => NON_DETERMINISTIC_EVIDENCE.has(state)) === true
  ) {
    issue(
      issues,
      "invalid-state",
      `${path}.uncertainty.state`,
      "known uncertainty conflicts with non-deterministic evidence",
    );
  }
}

function validateDocumentFormat(
  value: unknown,
  path: string,
  issues: ProfileCatalogValidationIssue[],
): void {
  const record = objectValue(value, path, ["id", "syntaxFamily", "syntaxFeatures"], issues);
  if (record === undefined) return;
  requiredIdentifier(record, "id", path, issues);
  requiredIdentifier(record, "syntaxFamily", path, issues);
  identifierArray(record, "syntaxFeatures", path, issues);
}

function validateProfile(
  value: unknown,
  path: string,
  issues: ProfileCatalogValidationIssue[],
): void {
  const record = objectValue(
    value,
    path,
    ["id", "displayName", "releaseClass", "surfaceIds"],
    issues,
  );
  if (record === undefined) return;
  requiredIdentifier(record, "id", path, issues);
  requiredString(record, "displayName", path, issues);
  enumString(
    record,
    "releaseClass",
    path,
    new Set(["ga-required", "recognized-evidence-only"]),
    issues,
  );
  identifierArray(record, "surfaceIds", path, issues, 1);
}

function validateCapabilityDefinition(
  value: unknown,
  path: string,
  issues: ProfileCatalogValidationIssue[],
): void {
  const record = objectValue(value, path, ["id", "description", "scope"], issues);
  if (record === undefined) return;
  requiredIdentifier(record, "id", path, issues);
  requiredString(record, "description", path, issues);
  enumString(record, "scope", path, new Set(["surface", "surface-format"]), issues);
}

function validateSource(
  value: unknown,
  path: string,
  issues: ProfileCatalogValidationIssue[],
): void {
  const record = objectValue(
    value,
    path,
    ["id", "immutability", "url", "artifactPath", "retrievedAt", "revision", "mutableSourceReason"],
    issues,
  );
  if (record === undefined) return;
  requiredIdentifier(record, "id", path, issues);
  const immutability = enumString(
    record,
    "immutability",
    path,
    new Set(["immutable", "living", "observation"]),
    issues,
  );
  const url = nullableString(record, "url", path, issues);
  const artifact = nullableString(record, "artifactPath", path, issues);
  const retrievedAt = requiredString(record, "retrievedAt", path, issues);
  validateDate(retrievedAt, `${path}.retrievedAt`, issues);
  const revision = nullableString(record, "revision", path, issues);
  const mutableReason = nullableString(record, "mutableSourceReason", path, issues);

  if (url !== undefined && url !== null && !isValidHttpsUrl(url)) {
    issue(
      issues,
      "invalid-value",
      `${path}.url`,
      "must be an absolute HTTPS URL without credentials, control characters, or malformed escapes",
    );
  }
  if (
    artifact !== undefined &&
    artifact !== null &&
    (!isRepositoryRelativePath(artifact) || artifact === REPOSITORY_ROOT)
  ) {
    issue(
      issues,
      "invalid-value",
      `${path}.artifactPath`,
      "must be a canonical repository-relative file path",
    );
  }
  if (
    immutability === "immutable" &&
    (url === null || revision === null || artifact !== null || mutableReason !== null)
  ) {
    issue(issues, "invalid-value", path, "immutable sources require URL and revision only");
  }
  if (
    immutability === "living" &&
    (url === null || revision !== null || artifact !== null || mutableReason === null)
  ) {
    issue(issues, "invalid-value", path, "living sources require URL and mutableSourceReason only");
  }
  if (
    immutability === "observation" &&
    (artifact === null || revision !== null || mutableReason !== null)
  ) {
    issue(
      issues,
      "invalid-value",
      path,
      "observation sources require an artifactPath and no revision",
    );
  }
}

function validateSnapshot(
  value: unknown,
  path: string,
  issues: ProfileCatalogValidationIssue[],
): void {
  const record = objectValue(
    value,
    path,
    [
      "id",
      "profileIds",
      "surfaceIds",
      "clientVersion",
      "versionStatus",
      "retrievedAt",
      "sources",
      "assumptions",
    ],
    issues,
  );
  if (record === undefined) return;
  requiredIdentifier(record, "id", path, issues);
  identifierArray(record, "profileIds", path, issues, 1);
  identifierArray(record, "surfaceIds", path, issues, 1);
  nullableString(record, "clientVersion", path, issues);
  requiredString(record, "versionStatus", path, issues);
  const retrievedAt = requiredString(record, "retrievedAt", path, issues);
  validateDate(retrievedAt, `${path}.retrievedAt`, issues);
  stringArray(record, "assumptions", path, issues);
  const sources = objectArray(record, "sources", path, issues);
  if (sources !== undefined) {
    if (sources.length === 0)
      issue(issues, "invalid-value", `${path}.sources`, "must not be empty");
    for (const [index, source] of sources.entries())
      validateSource(source, `${path}.sources[${String(index)}]`, issues);
    collectById(sources, `${path}.sources`, issues);
  }
}

function validateSurface(
  value: unknown,
  path: string,
  issues: ProfileCatalogValidationIssue[],
): void {
  const record = objectValue(
    value,
    path,
    ["id", "profileId", "kind", "specSnapshotIds", "capabilities"],
    issues,
  );
  if (record === undefined) return;
  requiredIdentifier(record, "id", path, issues);
  requiredIdentifier(record, "profileId", path, issues);
  requiredIdentifier(record, "kind", path, issues);
  identifierArray(record, "specSnapshotIds", path, issues, 1);
  const claims = objectArray(record, "capabilities", path, issues);
  if (claims !== undefined) {
    for (const [index, claim] of claims.entries())
      validateClaim(claim, `${path}.capabilities[${String(index)}]`, issues, true, true);
  }
}

function validateFormatSupport(
  value: unknown,
  path: string,
  issues: ProfileCatalogValidationIssue[],
): void {
  const record = objectValue(
    value,
    path,
    ["surfaceId", "formatId", "specSnapshotId", "recognition", "capabilities"],
    issues,
  );
  if (record === undefined) return;
  requiredIdentifier(record, "surfaceId", path, issues);
  requiredIdentifier(record, "formatId", path, issues);
  requiredIdentifier(record, "specSnapshotId", path, issues);
  if (record.recognition === undefined) {
    issue(issues, "missing-field", `${path}.recognition`, "is required");
  } else {
    validateClaim(record.recognition, `${path}.recognition`, issues, false);
  }
  const claims = objectArray(record, "capabilities", path, issues);
  if (claims !== undefined) {
    for (const [index, claim] of claims.entries())
      validateClaim(claim, `${path}.capabilities[${String(index)}]`, issues, true);
  }
}

function collectById(
  values: readonly unknown[],
  path: string,
  issues: ProfileCatalogValidationIssue[],
): Map<string, UnknownRecord> {
  const output = new Map<string, UnknownRecord>();
  for (const [index, value] of values.entries()) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
    const record: UnknownRecord = value as UnknownRecord;
    const id: unknown = record.id;
    if (typeof id !== "string" || id.length === 0) continue;
    if (output.has(id))
      issue(issues, "duplicate-id", `${path}[${String(index)}].id`, `duplicates '${id}'`);
    else output.set(id, record);
  }
  return output;
}

function relationshipIssue(
  issues: ProfileCatalogValidationIssue[],
  path: string,
  message: string,
): void {
  issue(issues, "invalid-relationship", path, message);
}

function validateRelationships(
  record: UnknownRecord,
  issues: ProfileCatalogValidationIssue[],
): void {
  const formats = Array.isArray(record.documentFormats) ? record.documentFormats : [];
  const profiles = Array.isArray(record.clientProfiles) ? record.clientProfiles : [];
  const surfaces = Array.isArray(record.surfaces) ? record.surfaces : [];
  const snapshots = Array.isArray(record.specSnapshots) ? record.specSnapshots : [];
  const definitions = Array.isArray(record.capabilityDefinitions)
    ? record.capabilityDefinitions
    : [];
  const support = Array.isArray(record.formatSupport) ? record.formatSupport : [];
  const formatById = collectById(formats, "$.documentFormats", issues);
  const profileById = collectById(profiles, "$.clientProfiles", issues);
  const surfaceById = collectById(surfaces, "$.surfaces", issues);
  const snapshotById = collectById(snapshots, "$.specSnapshots", issues);
  const definitionById = collectById(definitions, "$.capabilityDefinitions", issues);

  for (const [index, profile] of profiles.entries()) {
    if (profile === null || typeof profile !== "object" || Array.isArray(profile)) continue;
    const item: UnknownRecord = profile as UnknownRecord;
    const profileId = typeof item.id === "string" ? item.id : "";
    if (!Array.isArray(item.surfaceIds)) continue;
    for (const [surfaceIndex, surfaceId] of item.surfaceIds.entries()) {
      if (typeof surfaceId !== "string") continue;
      const surface = surfaceById.get(surfaceId);
      if (surface === undefined)
        relationshipIssue(
          issues,
          `$.clientProfiles[${String(index)}].surfaceIds[${String(surfaceIndex)}]`,
          "references an unknown surface",
        );
      else if (surface.profileId !== profileId)
        relationshipIssue(
          issues,
          `$.clientProfiles[${String(index)}].surfaceIds[${String(surfaceIndex)}]`,
          "references a surface owned by another profile",
        );
    }
  }

  for (const [index, surfaceValue] of surfaces.entries()) {
    if (surfaceValue === null || typeof surfaceValue !== "object" || Array.isArray(surfaceValue))
      continue;
    const surface: UnknownRecord = surfaceValue as UnknownRecord;
    const surfaceId = typeof surface.id === "string" ? surface.id : "";
    const profileId = typeof surface.profileId === "string" ? surface.profileId : "";
    const profile = profileById.get(profileId);
    if (profile === undefined)
      relationshipIssue(
        issues,
        `$.surfaces[${String(index)}].profileId`,
        "references an unknown profile",
      );
    else if (!Array.isArray(profile.surfaceIds) || !profile.surfaceIds.includes(surfaceId))
      relationshipIssue(
        issues,
        `$.surfaces[${String(index)}].profileId`,
        "profile does not list this surface",
      );
    if (Array.isArray(surface.specSnapshotIds)) {
      for (const [snapshotIndex, snapshotId] of surface.specSnapshotIds.entries()) {
        if (typeof snapshotId !== "string") continue;
        const snapshot = snapshotById.get(snapshotId);
        const path = `$.surfaces[${String(index)}].specSnapshotIds[${String(snapshotIndex)}]`;
        if (snapshot === undefined)
          relationshipIssue(issues, path, "references an unknown snapshot");
        else {
          if (!Array.isArray(snapshot.surfaceIds) || !snapshot.surfaceIds.includes(surfaceId))
            relationshipIssue(issues, path, "snapshot does not list this surface");
          if (!Array.isArray(snapshot.profileIds) || !snapshot.profileIds.includes(profileId))
            relationshipIssue(issues, path, "snapshot does not list this profile");
        }
      }
      if (Array.isArray(surface.capabilities)) {
        for (const [claimIndex, claim] of surface.capabilities.entries()) {
          const claimPath = `$.surfaces[${String(index)}].capabilities[${String(claimIndex)}]`;
          if (claim === null || typeof claim !== "object" || Array.isArray(claim)) continue;
          const claimRecord: UnknownRecord = claim as UnknownRecord;
          const claimSnapshotId =
            typeof claimRecord.specSnapshotId === "string" ? claimRecord.specSnapshotId : "";
          const claimSnapshot = snapshotById.get(claimSnapshotId);
          if (!surface.specSnapshotIds.includes(claimSnapshotId)) {
            relationshipIssue(
              issues,
              `${claimPath}.specSnapshotId`,
              "is not selected by this surface",
            );
          }
          validateEvidenceRefs(claim, claimPath, snapshotSourceIds(claimSnapshot), issues);
        }
      }
    }
    validateClaimDefinitions(
      surface.capabilities,
      "surface",
      `$.surfaces[${String(index)}].capabilities`,
      definitionById,
      issues,
    );
  }

  for (const [index, snapshotValue] of snapshots.entries()) {
    if (snapshotValue === null || typeof snapshotValue !== "object" || Array.isArray(snapshotValue))
      continue;
    const snapshot: UnknownRecord = snapshotValue as UnknownRecord;
    const coveredProfileIds = new Set<string>();
    if (Array.isArray(snapshot.surfaceIds)) {
      for (const surfaceId of snapshot.surfaceIds) {
        if (typeof surfaceId !== "string") continue;
        const surface = surfaceById.get(surfaceId);
        if (surface !== undefined && typeof surface.profileId === "string") {
          coveredProfileIds.add(surface.profileId);
        }
      }
    }
    if (Array.isArray(snapshot.profileIds)) {
      for (const [profileIndex, profileId] of snapshot.profileIds.entries()) {
        if (typeof profileId !== "string") continue;
        const path = `$.specSnapshots[${String(index)}].profileIds[${String(profileIndex)}]`;
        if (!profileById.has(profileId)) {
          relationshipIssue(issues, path, "references an unknown profile");
        } else if (!coveredProfileIds.has(profileId)) {
          relationshipIssue(issues, path, "does not own any surface covered by this snapshot");
        }
      }
    }
    if (Array.isArray(snapshot.surfaceIds)) {
      for (const [surfaceIndex, surfaceId] of snapshot.surfaceIds.entries()) {
        if (typeof surfaceId !== "string") continue;
        const surface = surfaceById.get(surfaceId);
        const path = `$.specSnapshots[${String(index)}].surfaceIds[${String(surfaceIndex)}]`;
        if (surface === undefined) relationshipIssue(issues, path, "references an unknown surface");
        else {
          if (
            !Array.isArray(surface.specSnapshotIds) ||
            !surface.specSnapshotIds.includes(snapshot.id)
          )
            relationshipIssue(issues, path, "surface does not list this snapshot");
          if (
            typeof surface.profileId === "string" &&
            (!Array.isArray(snapshot.profileIds) ||
              !snapshot.profileIds.includes(surface.profileId))
          ) {
            relationshipIssue(issues, path, "snapshot does not list the surface owner's profile");
          }
        }
      }
    }
  }

  const formatsBySurface = new Map<string, Set<string>>();
  for (const [index, supportValue] of support.entries()) {
    if (supportValue === null || typeof supportValue !== "object" || Array.isArray(supportValue))
      continue;
    const relation: UnknownRecord = supportValue as UnknownRecord;
    const surfaceId = typeof relation.surfaceId === "string" ? relation.surfaceId : "";
    const formatId = typeof relation.formatId === "string" ? relation.formatId : "";
    const snapshotId = typeof relation.specSnapshotId === "string" ? relation.specSnapshotId : "";
    const relationPath = `$.formatSupport[${String(index)}]`;
    if (!surfaceById.has(surfaceId))
      relationshipIssue(issues, `${relationPath}.surfaceId`, "references an unknown surface");
    if (!formatById.has(formatId))
      relationshipIssue(
        issues,
        `${relationPath}.formatId`,
        "references an unknown document format",
      );
    const snapshot = snapshotById.get(snapshotId);
    if (snapshot === undefined)
      relationshipIssue(issues, `${relationPath}.specSnapshotId`, "references an unknown snapshot");
    else if (!Array.isArray(snapshot.surfaceIds) || !snapshot.surfaceIds.includes(surfaceId))
      relationshipIssue(
        issues,
        `${relationPath}.specSnapshotId`,
        "snapshot does not cover this surface",
      );
    const surfaceFormats = formatsBySurface.get(surfaceId) ?? new Set<string>();
    if (surfaceFormats.has(formatId))
      issue(issues, "duplicate-id", relationPath, "duplicates a surface/format relationship");
    surfaceFormats.add(formatId);
    formatsBySurface.set(surfaceId, surfaceFormats);
    validateClaimDefinitions(
      relation.capabilities,
      "surface-format",
      `${relationPath}.capabilities`,
      definitionById,
      issues,
    );
    const evidenceIds = snapshotSourceIds(snapshot);
    validateEvidenceRefs(relation.recognition, `${relationPath}.recognition`, evidenceIds, issues);
    if (Array.isArray(relation.capabilities)) {
      for (const [claimIndex, claim] of relation.capabilities.entries())
        validateEvidenceRefs(
          claim,
          `${relationPath}.capabilities[${String(claimIndex)}]`,
          evidenceIds,
          issues,
        );
    }
  }
}

function validateClaimDefinitions(
  claims: unknown,
  expectedScope: string,
  path: string,
  definitions: ReadonlyMap<string, UnknownRecord>,
  issues: ProfileCatalogValidationIssue[],
): void {
  if (!Array.isArray(claims)) return;
  const ids = new Set<string>();
  for (const [index, claimValue] of claims.entries()) {
    if (claimValue === null || typeof claimValue !== "object" || Array.isArray(claimValue))
      continue;
    const claim: UnknownRecord = claimValue as UnknownRecord;
    if (typeof claim.capabilityId !== "string") continue;
    const definition = definitions.get(claim.capabilityId);
    if (definition === undefined)
      relationshipIssue(
        issues,
        `${path}[${String(index)}].capabilityId`,
        "references an unknown capability definition",
      );
    else if (definition.scope !== expectedScope)
      relationshipIssue(
        issues,
        `${path}[${String(index)}].capabilityId`,
        `requires a ${expectedScope} capability`,
      );
    if (ids.has(claim.capabilityId))
      issue(
        issues,
        "duplicate-id",
        `${path}[${String(index)}].capabilityId`,
        "duplicates a capability claim",
      );
    ids.add(claim.capabilityId);
  }
}

function snapshotSourceIds(snapshot: UnknownRecord | undefined): ReadonlySet<string> {
  const ids = new Set<string>();
  if (snapshot !== undefined && Array.isArray(snapshot.sources)) {
    for (const value of snapshot.sources) {
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        const source: UnknownRecord = value as UnknownRecord;
        if (typeof source.id === "string") ids.add(source.id);
      }
    }
  }
  return ids;
}

function validateEvidenceRefs(
  claimValue: unknown,
  path: string,
  sourceIds: ReadonlySet<string>,
  issues: ProfileCatalogValidationIssue[],
): void {
  if (claimValue === null || typeof claimValue !== "object" || Array.isArray(claimValue)) return;
  const claim: UnknownRecord = claimValue as UnknownRecord;
  if (!Array.isArray(claim.evidenceRefs)) return;
  for (const [index, ref] of claim.evidenceRefs.entries()) {
    if (typeof ref === "string" && !sourceIds.has(ref))
      relationshipIssue(
        issues,
        `${path}.evidenceRefs[${String(index)}]`,
        "is not present in the selected snapshot",
      );
  }
}

/**
 * Validate untrusted JSON as a closed v0 profile catalog.
 *
 * The validator performs no I/O and never expands vendor-specific discovery or activation behavior.
 */
function validateProfileCatalogValue(
  input: unknown,
  issues: ProfileCatalogValidationIssue[],
): ProfileCatalogValidationResult {
  const jsonSafe = validateJsonValue(input, "$", (_code, issuePath, message) => {
    issue(issues, "invalid-json", issuePath, message);
  });
  if (!jsonSafe) return { issues, ok: false };
  const record = objectValue(
    input,
    "$",
    [
      "recordKind",
      "contractVersion",
      "documentFormats",
      "clientProfiles",
      "surfaces",
      "specSnapshots",
      "capabilityDefinitions",
      "formatSupport",
    ],
    issues,
  );
  if (record === undefined) return { issues, ok: false };

  const recordKind = requiredString(record, "recordKind", "$", issues);
  if (recordKind !== undefined && recordKind !== "agent-context-profile-catalog")
    issue(issues, "invalid-value", "$.recordKind", "must equal 'agent-context-profile-catalog'");
  const version = requiredString(record, "contractVersion", "$", issues);
  if (version !== undefined && version !== PROFILE_CATALOG_CONTRACT_VERSION)
    issue(
      issues,
      "invalid-value",
      "$.contractVersion",
      `must equal '${PROFILE_CATALOG_CONTRACT_VERSION}'`,
    );

  const formats = objectArray(record, "documentFormats", "$", issues);
  const profiles = objectArray(record, "clientProfiles", "$", issues);
  const surfaces = objectArray(record, "surfaces", "$", issues);
  const snapshots = objectArray(record, "specSnapshots", "$", issues);
  const definitions = objectArray(record, "capabilityDefinitions", "$", issues);
  const support = objectArray(record, "formatSupport", "$", issues);
  if (formats !== undefined)
    for (const [index, value] of formats.entries())
      validateDocumentFormat(value, `$.documentFormats[${String(index)}]`, issues);
  if (profiles !== undefined)
    for (const [index, value] of profiles.entries())
      validateProfile(value, `$.clientProfiles[${String(index)}]`, issues);
  if (surfaces !== undefined)
    for (const [index, value] of surfaces.entries())
      validateSurface(value, `$.surfaces[${String(index)}]`, issues);
  if (snapshots !== undefined)
    for (const [index, value] of snapshots.entries())
      validateSnapshot(value, `$.specSnapshots[${String(index)}]`, issues);
  if (definitions !== undefined)
    for (const [index, value] of definitions.entries())
      validateCapabilityDefinition(value, `$.capabilityDefinitions[${String(index)}]`, issues);
  if (support !== undefined)
    for (const [index, value] of support.entries())
      validateFormatSupport(value, `$.formatSupport[${String(index)}]`, issues);
  validateRelationships(record, issues);

  if (issues.length > 0) return { issues, ok: false };
  return { ok: true, value: input as ProfileCatalog };
}

export function validateProfileCatalog(input: unknown): ProfileCatalogValidationResult {
  const issues: ProfileCatalogValidationIssue[] = [];
  try {
    return validateProfileCatalogValue(input, issues);
  } catch (error) {
    if (error instanceof ValidationIssueLimitReached) return { issues, ok: false };
    throw error;
  }
}

/** Type guard for callers that only need a yes/no result. */
export function isProfileCatalog(input: unknown): input is ProfileCatalog {
  return validateProfileCatalog(input).ok;
}
