import { types as nodeTypes } from "node:util";

import {
  MAX_OUTPUT_TEXT_BYTES,
  MAX_OUTPUT_TEXT_CODE_POINTS,
  MAX_SARIF_RELATED_LOCATIONS,
  SARIF_OUTPUT_SCHEMA_VERSION,
  SARIF_SCHEMA_URI,
  SARIF_VERSION,
  encodeSarifArtifactUri,
  sanitizeOutputText,
  serializeSarifOutput,
  validateDiagnosticBundle,
  validateSarifOutput,
} from "@agent-context/core";
import { findRuleMetadata, resolveRuleDocsUrl } from "@agent-context/rules";

import type {
  Diagnostic,
  DiagnosticBundle,
  DiagnosticSourceLocation,
  ProfileVersionIdentity,
  RelatedEvidence,
  SarifLocation,
  SarifOutput,
  SarifRelatedLocation,
  SarifReportingDescriptor,
  SarifResult,
  SourceDocument,
} from "@agent-context/core";
import type { RuleMetadata } from "@agent-context/rules";

export const MAX_SARIF_FORMATTER_OUTPUT_BYTES = 10_000_000 as const;

const MAX_FORMATTER_ISSUES = 256;
const OPTION_KEYS = new Set([
  "informationUri",
  "profileVersions",
  "ruleDocumentationBaseUri",
  "toolVersion",
]);
const IDENTIFIER = /^[A-Za-z0-9]+(?:[._:/-][A-Za-z0-9]+)*$/u;
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const MASK_64 = (1n << 64n) - 1n;
const HASH_MULTIPLIER = 37n;
const HASH_WINDOW = 100;
const HASH_EOF = 65_535;

export interface SarifFormatterOptions {
  readonly toolVersion: string;
  readonly informationUri: string;
  /** Explicit trusted HTTPS directory used to resolve registry documentation paths. */
  readonly ruleDocumentationBaseUri: string;
  readonly profileVersions: Readonly<Record<string, ProfileVersionIdentity>>;
}

export interface SarifFormatterIssue {
  readonly code:
    "invalid-diagnostics" | "invalid-options" | "missing-rule-metadata" | "resource-limit";
  readonly path: string;
  readonly message: string;
}

export type SarifFormatterResult =
  | {
      readonly ok: true;
      readonly output: SarifOutput;
      /** Canonical compact JSON with exactly one trailing LF. */
      readonly text: string;
      readonly byteLength: number;
    }
  | { readonly ok: false; readonly issues: readonly SarifFormatterIssue[] };

interface ResolvedOptions {
  readonly informationUri: string;
  readonly profileVersions: Readonly<Record<string, ProfileVersionIdentity>>;
  readonly ruleDocumentationBaseUri: string;
  readonly toolVersion: string;
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (value !== null && typeof value === "object" && !seen.has(value)) {
    seen.add(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen);
    Object.freeze(value);
  }
  return value;
}

function immutableIssue(
  code: SarifFormatterIssue["code"],
  path: string,
  message: string,
): SarifFormatterIssue {
  return Object.freeze({ code, path, message });
}

function failure(issue: SarifFormatterIssue): SarifFormatterResult {
  return Object.freeze({ ok: false, issues: Object.freeze([issue]) });
}

function boundedTextWithin(
  value: string,
  maximumCodePoints: number,
  maximumBytes: number,
  fallback: string,
): string {
  const sanitized = sanitizeOutputText(value);
  let result = "";
  let bytes = 0;
  let points = 0;
  for (const point of sanitized) {
    const pointBytes = Buffer.byteLength(point, "utf8");
    if (points >= maximumCodePoints || bytes + pointBytes > maximumBytes) break;
    result += point;
    bytes += pointBytes;
    points += 1;
  }
  return result.length === 0 ? fallback : result;
}

function boundedText(value: string, fallback = "REDACTED"): string {
  return boundedTextWithin(value, MAX_OUTPUT_TEXT_CODE_POINTS, MAX_OUTPUT_TEXT_BYTES, fallback);
}

function isSafeHttpsUri(value: string, directory: boolean): boolean {
  if (!/^[\x21-\x7e]+$/u.test(value) || value.includes("\\") || /%(?![0-9A-Fa-f]{2})/u.test(value))
    return false;
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "https:" &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.hostname.length > 0 &&
      (!directory || (parsed.search === "" && parsed.hash === "" && parsed.pathname.endsWith("/")))
    );
  } catch {
    return false;
  }
}

function readDataProperties(
  input: unknown,
  allowed: ReadonlySet<string>,
): Map<string, unknown> | undefined {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    nodeTypes.isProxy(input)
  )
    return undefined;
  const prototype = Object.getPrototypeOf(input) as unknown;
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const keys = Reflect.ownKeys(input);
  if (keys.length > allowed.size) return undefined;
  const values = new Map<string, unknown>();
  for (const key of keys) {
    if (typeof key !== "string" || !allowed.has(key)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor === undefined || !("value" in descriptor)) return undefined;
    values.set(key, descriptor.value as unknown);
  }
  return values;
}

function validateProfileVersions(
  input: unknown,
): Readonly<Record<string, ProfileVersionIdentity>> | undefined {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    nodeTypes.isProxy(input)
  )
    return undefined;
  const prototype = Object.getPrototypeOf(input) as unknown;
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const keys = Reflect.ownKeys(input);
  if (keys.length === 0 || keys.length > 128 || keys.some((key) => typeof key !== "string"))
    return undefined;
  const output: Record<string, ProfileVersionIdentity> = Object.create(null) as Record<
    string,
    ProfileVersionIdentity
  >;
  for (const key of [...(keys as string[])].sort()) {
    if (!IDENTIFIER.test(key)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor === undefined || !("value" in descriptor)) return undefined;
    const identity = readDataProperties(
      descriptor.value,
      new Set(["clientVersion", "profileVersion"]),
    );
    if (identity?.size !== 2) return undefined;
    const profileVersion = identity.get("profileVersion");
    const clientVersion = identity.get("clientVersion");
    if (
      typeof profileVersion !== "string" ||
      !VERSION.test(profileVersion) ||
      (clientVersion !== null && typeof clientVersion !== "string")
    )
      return undefined;
    const boundedClient = typeof clientVersion === "string" ? boundedText(clientVersion) : null;
    output[key] = Object.freeze({ profileVersion, clientVersion: boundedClient });
  }
  return Object.freeze(output);
}

function validateOptions(input: unknown): ResolvedOptions | undefined {
  const values = readDataProperties(input, OPTION_KEYS);
  if (values?.size !== OPTION_KEYS.size) return undefined;
  const toolVersion = values.get("toolVersion");
  const informationUri = values.get("informationUri");
  const ruleDocumentationBaseUri = values.get("ruleDocumentationBaseUri");
  const profileVersions = validateProfileVersions(values.get("profileVersions"));
  if (
    typeof toolVersion !== "string" ||
    !VERSION.test(toolVersion) ||
    typeof informationUri !== "string" ||
    !isSafeHttpsUri(informationUri, false) ||
    typeof ruleDocumentationBaseUri !== "string" ||
    !isSafeHttpsUri(ruleDocumentationBaseUri, true) ||
    profileVersions === undefined
  )
    return undefined;
  return Object.freeze({ toolVersion, informationUri, ruleDocumentationBaseUri, profileVersions });
}

function activeDiagnostics(bundle: DiagnosticBundle): readonly Diagnostic[] {
  const suppressed = new Set(
    bundle.suppressions
      .filter((suppression) => suppression.state === "suppressed")
      .flatMap((suppression) => suppression.matchedPathFingerprints),
  );
  return bundle.diagnostics.filter(
    (diagnostic) => !suppressed.has(diagnostic.fingerprints.path.value),
  );
}

function sarifLevel(severity: Diagnostic["severity"]): SarifResult["level"] {
  return severity === "info" ? "note" : severity;
}

function problemSeverity(
  severity: RuleMetadata["defaultSeverity"],
): SarifReportingDescriptor["properties"]["problem.severity"] {
  return severity === "info" ? "recommendation" : severity;
}

function descriptor(
  metadata: RuleMetadata,
  documentationBase: string,
): SarifReportingDescriptor | undefined {
  const helpUri = resolveRuleDocsUrl(metadata.id, documentationBase)?.href;
  if (helpUri === undefined) return undefined;
  const description = boundedText(metadata.description);
  const rationale = boundedText(metadata.rationale);
  return {
    id: metadata.id,
    name: metadata.id,
    shortDescription: { text: description },
    fullDescription: { text: rationale },
    helpUri,
    help: {
      text: rationale,
      markdown: boundedText(`${rationale} Rule documentation: ${helpUri}`),
    },
    defaultConfiguration: { level: sarifLevel(metadata.defaultSeverity) },
    properties: {
      tags: ["agent-context", metadata.category].sort(),
      "problem.severity": problemSeverity(metadata.defaultSeverity),
      agentContextCategory: metadata.category,
      agentContextFixSafety: metadata.fixSafety,
      agentContextOwner: boundedText(metadata.owner),
      agentContextPrecisionStatus: metadata.precisionStatus,
    },
  };
}

function physicalLocation(location: DiagnosticSourceLocation): SarifLocation | undefined {
  const uri = encodeSarifArtifactUri(location.path);
  if (uri === undefined) return undefined;
  return {
    physicalLocation: {
      artifactLocation: { uri },
      region: {
        startLine: location.range.start.line + 1,
        startColumn: location.range.start.utf16Column + 1,
        endLine: location.range.end.line + 1,
        endColumn: location.range.end.utf16Column + 1,
      },
    },
  };
}

function locationIdentity(location: DiagnosticSourceLocation): string {
  const { start, end } = location.range;
  return `${location.path}\u0000${String(start.line)}:${String(start.utf16Column)}-${String(end.line)}:${String(end.utf16Column)}`;
}

function evidenceLocations(
  evidence: RelatedEvidence,
): readonly { readonly label: string; readonly location: DiagnosticSourceLocation }[] {
  if (evidence.kind === "source") return [{ label: evidence.label, location: evidence.location }];
  if (evidence.kind === "repository-fact")
    return evidence.locations.map((location) => ({ label: evidence.label, location }));
  if (evidence.kind === "resolution")
    return evidence.sourceLocations.map((location) => ({ label: evidence.label, location }));
  return [];
}

function relatedLocations(diagnostic: Diagnostic): readonly SarifRelatedLocation[] | undefined {
  const seen = new Set([locationIdentity(diagnostic.primary)]);
  const related: SarifRelatedLocation[] = [];
  for (const evidence of diagnostic.related) {
    for (const item of evidenceLocations(evidence)) {
      const identity = locationIdentity(item.location);
      if (seen.has(identity)) continue;
      seen.add(identity);
      const location = physicalLocation(item.location);
      if (location === undefined) return undefined;
      related.push({
        id: related.length + 1,
        physicalLocation: location.physicalLocation,
        message: { text: boundedText(item.label) },
      });
      if (related.length === MAX_SARIF_RELATED_LOCATIONS) return related;
    }
  }
  return related;
}

/**
 * Reproduce the unversioned GitHub code-scanning `primaryLocationLineHash` algorithm reviewed at
 * github/codeql-action `src/fingerprints.ts`: a 100-character, whitespace-skipping uint64 hash.
 */
export function computeGithubPrimaryLocationLineHashes(text: string): ReadonlyMap<number, string> {
  const window = Array<number>(HASH_WINDOW).fill(0);
  const lineNumbers = Array<number>(HASH_WINDOW).fill(-1);
  const hashes = new Map<number, string>();
  const counts = new Map<string, number>();
  let firstMod = 1n;
  for (let index = 0; index < HASH_WINDOW; index += 1)
    firstMod = (firstMod * HASH_MULTIPLIER) & MASK_64;
  let hash = 0n;
  let index = 0;
  let lineNumber = 0;
  let lineStart = true;
  let previousCarriageReturn = false;
  const outputHash = (): void => {
    const raw = hash.toString(16);
    const count = (counts.get(raw) ?? 0) + 1;
    counts.set(raw, count);
    const outputLine = lineNumbers[index];
    if (outputLine !== undefined && outputLine > 0)
      hashes.set(outputLine, `${raw}:${String(count)}`);
    lineNumbers[index] = -1;
  };
  const updateHash = (current: number): void => {
    const beginning = window[index] ?? 0;
    window[index] = current;
    hash = (HASH_MULTIPLIER * hash + BigInt(current) - firstMod * BigInt(beginning)) & MASK_64;
    index = (index + 1) % HASH_WINDOW;
  };
  const processCharacter = (input: number): void => {
    let current = input;
    if (current === 32 || current === 9 || (previousCarriageReturn && current === 10)) {
      previousCarriageReturn = false;
      return;
    }
    if (current === 13) {
      current = 10;
      previousCarriageReturn = true;
    } else previousCarriageReturn = false;
    if (lineNumbers[index] !== -1) outputHash();
    if (lineStart) {
      lineStart = false;
      lineNumber += 1;
      lineNumbers[index] = lineNumber;
    }
    if (current === 10) lineStart = true;
    updateHash(current);
  };
  for (let character = 0; character < text.length; character += 1)
    processCharacter(text.charCodeAt(character));
  processCharacter(HASH_EOF);
  for (let remaining = 0; remaining < HASH_WINDOW; remaining += 1) {
    if (lineNumbers[index] !== -1) outputHash();
    updateHash(0);
  }
  return hashes;
}

function provenance(diagnostic: Diagnostic): {
  readonly profileIds: readonly string[];
  readonly specSnapshotIds: readonly string[];
  readonly surfaceIds: readonly string[];
} {
  const profileIds = new Set([
    ...diagnostic.fingerprintBasis.path.profileIds,
    ...diagnostic.fingerprintBasis.semantic.profileIds,
  ]);
  const surfaceIds = new Set<string>();
  const specSnapshotIds = new Set<string>();
  for (const evidence of diagnostic.related) {
    if (evidence.kind === "resolution") {
      profileIds.add(evidence.profileId);
      surfaceIds.add(evidence.surfaceId);
      specSnapshotIds.add(evidence.specSnapshotId);
    } else if (evidence.kind === "spec") specSnapshotIds.add(evidence.specSnapshotId);
  }
  return {
    profileIds: [...profileIds].sort(),
    surfaceIds: [...surfaceIds].sort(),
    specSnapshotIds: [...specSnapshotIds].sort(),
  };
}

function resultMessage(message: string, related: readonly SarifRelatedLocation[]): string {
  const links = related.map(
    (location) => `[related location ${String(location.id)}](${String(location.id)})`,
  );
  if (links.length === 0) return boundedText(message);
  const suffix = ` Related: ${links.join(", ")}.`;
  const prefix = boundedTextWithin(
    message,
    MAX_OUTPUT_TEXT_CODE_POINTS - Array.from(suffix).length,
    MAX_OUTPUT_TEXT_BYTES - Buffer.byteLength(suffix, "utf8"),
    "",
  );
  return `${prefix}${suffix}`;
}

/**
 * Convert a validated B04 bundle and its B03 sources to deterministic SARIF 2.1.0. The function is
 * offline, does not inspect the filesystem, preserves active diagnostic order, and never mutates
 * caller data. Upstream F15 owns sorting, deduplication, severity policy, and suppression matching.
 */
export function formatSarifDiagnostics(
  input: unknown,
  sources: readonly SourceDocument[],
  options: SarifFormatterOptions,
): SarifFormatterResult {
  try {
    const resolvedOptions = validateOptions(options);
    if (resolvedOptions === undefined)
      return failure(
        immutableIssue(
          "invalid-options",
          "$options",
          "must satisfy the closed SARIF formatter option contract",
        ),
      );
    const validation = validateDiagnosticBundle(input, sources);
    if (!validation.ok)
      return failure(
        immutableIssue(
          "invalid-diagnostics",
          "$",
          `diagnostic bundle failed B04 validation (${String(Math.min(validation.issues.length, MAX_FORMATTER_ISSUES))} issues)`,
        ),
      );
    const diagnostics = activeDiagnostics(validation.value);
    const usedProfiles = new Set(diagnostics.flatMap((item) => provenance(item).profileIds));
    if (
      [...usedProfiles].some(
        (profileId) => !Object.hasOwn(resolvedOptions.profileVersions, profileId),
      )
    )
      return failure(
        immutableIssue(
          "invalid-options",
          "$options.profileVersions",
          "must identify every profile used by active diagnostics",
        ),
      );
    const sourceById = new Map(sources.map((source) => [source.id, source]));
    const hashesBySource = new Map<string, ReadonlyMap<number, string>>();
    const metadataById = new Map<string, RuleMetadata>();
    for (const diagnostic of diagnostics) {
      const metadata = findRuleMetadata(diagnostic.ruleId);
      if (metadata === undefined)
        return failure(
          immutableIssue(
            "missing-rule-metadata",
            "$.diagnostics",
            "every diagnostic rule must exist in the registry",
          ),
        );
      metadataById.set(metadata.id, metadata);
    }
    const rules: SarifReportingDescriptor[] = [];
    for (const metadata of [...metadataById.values()].sort((left, right) =>
      left.id === right.id ? 0 : left.id < right.id ? -1 : 1,
    )) {
      const rule = descriptor(metadata, resolvedOptions.ruleDocumentationBaseUri);
      if (rule === undefined)
        return failure(
          immutableIssue(
            "invalid-options",
            "$options.ruleDocumentationBaseUri",
            "must resolve every rule documentation URI",
          ),
        );
      rules.push(rule);
    }
    const ruleIndexes = new Map(rules.map((rule, index) => [rule.id, index]));
    const results: SarifResult[] = [];
    for (const diagnostic of diagnostics) {
      const primary = physicalLocation(diagnostic.primary);
      const related = relatedLocations(diagnostic);
      const source = sourceById.get(diagnostic.primary.sourceId);
      const ruleIndex = ruleIndexes.get(diagnostic.ruleId);
      if (
        primary === undefined ||
        related === undefined ||
        source === undefined ||
        ruleIndex === undefined
      )
        return failure(
          immutableIssue(
            "invalid-diagnostics",
            "$.diagnostics",
            "validated diagnostics could not be represented as SARIF",
          ),
        );
      let lineHashes = hashesBySource.get(source.id);
      if (lineHashes === undefined) {
        lineHashes = computeGithubPrimaryLocationLineHashes(source.text);
        hashesBySource.set(source.id, lineHashes);
      }
      const primaryLocationLineHash = lineHashes.get(diagnostic.primary.range.start.line + 1);
      if (primaryLocationLineHash === undefined)
        return failure(
          immutableIssue(
            "invalid-diagnostics",
            "$.diagnostics",
            "primary source line could not be fingerprinted",
          ),
        );
      const resultProvenance = provenance(diagnostic);
      results.push({
        ruleId: diagnostic.ruleId,
        ruleIndex,
        level: sarifLevel(diagnostic.severity),
        message: { text: resultMessage(diagnostic.message, related) },
        locations: [primary],
        relatedLocations: related,
        partialFingerprints: {
          primaryLocationLineHash,
          "agentContextPath/v1": diagnostic.fingerprints.path.value,
          "agentContextSemantic/v1": diagnostic.fingerprints.semantic.value,
        },
        properties: {
          agentContextRuleVersion: diagnostic.ruleVersion,
          ...resultProvenance,
        },
      });
    }
    const model: SarifOutput = {
      version: SARIF_VERSION,
      $schema: SARIF_SCHEMA_URI,
      runs: [
        {
          tool: {
            driver: {
              name: "Agent Context Linter",
              semanticVersion: resolvedOptions.toolVersion,
              informationUri: resolvedOptions.informationUri,
              rules,
            },
          },
          results,
          properties: {
            agentContextSchemaVersion: SARIF_OUTPUT_SCHEMA_VERSION,
            profileVersions: resolvedOptions.profileVersions,
          },
        },
      ],
    };
    const serialized = serializeSarifOutput(model);
    if (!serialized.ok)
      return failure(
        immutableIssue(
          "resource-limit",
          "$",
          "constructed SARIF failed the public output contract",
        ),
      );
    const byteLength = Buffer.byteLength(serialized.text, "utf8");
    if (byteLength > MAX_SARIF_FORMATTER_OUTPUT_BYTES)
      return failure(
        immutableIssue("resource-limit", "$", "SARIF output exceeds the formatter byte budget"),
      );
    const output = JSON.parse(serialized.text) as unknown;
    const outputValidation = validateSarifOutput(output);
    if (!outputValidation.ok)
      return failure(immutableIssue("resource-limit", "$", "serialized SARIF failed validation"));
    return deepFreeze({
      ok: true,
      output: outputValidation.value,
      text: serialized.text,
      byteLength,
    });
  } catch {
    return failure(
      immutableIssue("invalid-diagnostics", "$", "inputs must be safely inspectable bounded data"),
    );
  }
}
