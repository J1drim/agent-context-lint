import { types as nodeTypes } from "node:util";

import type { StandardsArtifact, StandardsOutput } from "@agent-context/core";

import { isAuthenticatedBundledKnowledgePack } from "./bundled-pack-loader.js";
import { parseCanonicalStandardsLockfile } from "./standards-lockfile.js";
import { MAX_TUF_SEMVER_BYTES } from "./tuf-trust.js";

import type { LoadedBundledKnowledgePack } from "./bundled-pack-loader.js";
import type { KnowledgePackChannel } from "./knowledge-pack.js";
import type { StandardsLockfile } from "./standards-lockfile.js";
import type { TufTrustedMetadataSummary, TufTrustedStateSnapshot } from "./tuf-trust.js";

export const OFFLINE_STANDARDS_STATUS_CONTRACT_VERSION = "0.1.0" as const;
export const OFFLINE_STANDARDS_STATUS_RECORD_KIND =
  "agent-context-offline-standards-status" as const;
export const MIN_STANDARDS_MAX_AGE_DAYS = 1;
export const MAX_STANDARDS_MAX_AGE_DAYS = 365;
export const MAX_OFFLINE_STANDARDS_STATUS_ISSUES = 16;

const SHA256 = /^[a-f0-9]{64}$/u;
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const RFC3339_UTC = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/u;
const DAY_MS = 86_400_000;
const MIN_CLOCK_MS = Date.UTC(1970, 0, 1);
const MAX_CLOCK_MS = Date.UTC(9999, 11, 31, 23, 59, 59);

export type OfflineStandardsStatusIssueCode =
  | "cached-channel-mismatch"
  | "cached-engine-incompatible"
  | "cached-from-future"
  | "cached-latest-invalid"
  | "invalid-clock"
  | "invalid-input"
  | "invalid-lockfile"
  | "lock-channel-mismatch"
  | "lock-authority-unauthenticated"
  | "lock-engine-incompatible"
  | "lock-from-future"
  | "selected-pack-stale"
  | "unauthenticated-bundle"
  | "unexpected-failure";

export type OfflineStandardsStatusIssueSource = "cached-latest" | "lockfile" | "status";

export interface OfflineStandardsStatusIssue {
  readonly code: OfflineStandardsStatusIssueCode;
  readonly message: string;
  readonly path: string;
  readonly source: OfflineStandardsStatusIssueSource;
}

export interface OfflineStandardsCachedLatestObservation {
  readonly channel: KnowledgePackChannel;
  readonly checkedAt: string;
  readonly minEngineVersion: string;
  readonly origin: "untrusted-offline-cache";
  readonly packVersion: string;
  readonly sha256: string;
}

export interface OfflineStandardsStatusRequest {
  readonly asOf: string;
  readonly bundled: LoadedBundledKnowledgePack;
  readonly cachedLatest: OfflineStandardsCachedLatestObservation | null;
  readonly engineVersion: string;
  readonly lockfile: string | Uint8Array | null;
  readonly maxAgeDays: number;
}

export interface OfflineStandardsArtifactAge {
  readonly ageDays: number;
  readonly maximumAgeDays: number;
  readonly origin: "bundled" | "locked";
  readonly publishedAt: string;
  readonly status: "current" | "stale";
}

export interface OfflineStandardsStatusReport {
  readonly age: Readonly<{
    readonly bundled: OfflineStandardsArtifactAge;
    readonly locked: OfflineStandardsArtifactAge | null;
    readonly policySelection: "bundled" | "locked";
  }>;
  readonly asOf: string;
  readonly contractVersion: typeof OFFLINE_STANDARDS_STATUS_CONTRACT_VERSION;
  readonly issues: readonly OfflineStandardsStatusIssue[];
  /** The last verified check represented by untrusted offline cache data, never a live claim. */
  readonly lastCheckedAt: string | null;
  readonly output: StandardsOutput;
  readonly recordKind: typeof OFFLINE_STANDARDS_STATUS_RECORD_KIND;
}

export type OfflineStandardsStatusResult =
  | { readonly ok: true; readonly value: OfflineStandardsStatusReport }
  | { readonly issues: readonly OfflineStandardsStatusIssue[]; readonly ok: false };

interface ParsedSemver {
  readonly core: readonly [string, string, string];
  readonly prerelease: readonly string[] | null;
}

class StatusFailure extends Error {
  readonly issue: OfflineStandardsStatusIssue;

  constructor(code: OfflineStandardsStatusIssueCode, path: string, message: string) {
    super(message);
    this.issue = Object.freeze({ code, message, path, source: "status" });
  }
}

function fail(code: OfflineStandardsStatusIssueCode, path: string, message: string): never {
  throw new StatusFailure(code, path, message);
}

function failure(error: unknown): OfflineStandardsStatusResult {
  const issue =
    error instanceof StatusFailure
      ? error.issue
      : Object.freeze({
          code: "unexpected-failure" as const,
          message: "offline standards status failed closed",
          path: "$",
          source: "status" as const,
        });
  return Object.freeze({ issues: Object.freeze([issue]), ok: false });
}

function softIssue(
  issues: OfflineStandardsStatusIssue[],
  code: OfflineStandardsStatusIssueCode,
  source: OfflineStandardsStatusIssueSource,
  path: string,
  message: string,
): void {
  if (issues.length < MAX_OFFLINE_STANDARDS_STATUS_ISSUES)
    issues.push(Object.freeze({ code, message, path, source }));
}

function ownData(value: unknown, keys: readonly string[], path: string): Map<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    nodeTypes.isProxy(value)
  )
    fail("invalid-input", path, "status input must be a non-proxy plain data object");
  const prototype = Reflect.getPrototypeOf(value);
  const ownKeys = Reflect.ownKeys(value);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))
  )
    fail("invalid-input", path, "status input fields do not match the closed contract");
  const result = new Map<string, unknown>();
  for (const key of ownKeys as readonly string[]) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor))
      fail("invalid-input", path, "status input must contain only own data properties");
    result.set(key, descriptor.value as unknown);
  }
  return result;
}

function exactInstant(value: unknown): string | undefined {
  if (typeof value !== "string" || RFC3339_UTC.exec(value) === null) return undefined;
  const parsed = Date.parse(value);
  if (
    !Number.isFinite(parsed) ||
    parsed < MIN_CLOCK_MS ||
    parsed > MAX_CLOCK_MS ||
    new Date(parsed).toISOString().replace(".000Z", "Z") !== value
  )
    return undefined;
  return value;
}

function millisecondsInstant(value: string): string {
  return value.slice(0, -1) + ".000Z";
}

function parseSemver(value: unknown): ParsedSemver | undefined {
  if (typeof value !== "string" || value.length > MAX_TUF_SEMVER_BYTES) return undefined;
  const match = SEMVER.exec(value);
  if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined)
    return undefined;
  return {
    core: [match[1], match[2], match[3]],
    prerelease: match[4] === undefined ? null : match[4].split("."),
  };
}

function compareIdentifier(left: string, right: string): number {
  const leftNumeric = /^\d+$/u.test(left);
  const rightNumeric = /^\d+$/u.test(right);
  if (leftNumeric && rightNumeric) {
    const leftTrimmed = left.replace(/^0+(?=\d)/u, "");
    const rightTrimmed = right.replace(/^0+(?=\d)/u, "");
    return leftTrimmed.length - rightTrimmed.length || compareText(leftTrimmed, rightTrimmed);
  }
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
  return compareText(left, right);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareSemver(left: string, right: string): number {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (a === undefined || b === undefined) fail("invalid-input", "$", "version is not exact SemVer");
  for (const index of [0, 1, 2] as const) {
    const coreComparison = compareIdentifier(a.core[index], b.core[index]);
    if (coreComparison !== 0) return coreComparison;
  }
  if (a.prerelease === null || b.prerelease === null)
    return a.prerelease === b.prerelease ? 0 : a.prerelease === null ? 1 : -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = a.prerelease[index];
    const rightPart = b.prerelease[index];
    if (leftPart === undefined || rightPart === undefined)
      return leftPart === rightPart ? 0 : leftPart === undefined ? -1 : 1;
    const comparison = compareIdentifier(leftPart, rightPart);
    if (comparison !== 0) return comparison;
  }
  return 0;
}

function validateRequest(value: unknown): OfflineStandardsStatusRequest {
  const fields = ownData(
    value,
    ["asOf", "bundled", "cachedLatest", "engineVersion", "lockfile", "maxAgeDays"],
    "$request",
  );
  const asOf = exactInstant(fields.get("asOf"));
  if (asOf === undefined)
    fail("invalid-clock", "$request.asOf", "asOf must be an exact UTC RFC 3339 second");
  const bundled = fields.get("bundled");
  if (!isAuthenticatedBundledKnowledgePack(bundled))
    fail(
      "unauthenticated-bundle",
      "$request.bundled",
      "bundled status authority must come from the production loader",
    );
  const engineVersion = fields.get("engineVersion");
  if (typeof engineVersion !== "string" || parseSemver(engineVersion) === undefined)
    fail("invalid-input", "$request.engineVersion", "engineVersion must be exact SemVer");
  const maxAgeDays = fields.get("maxAgeDays");
  if (
    !Number.isSafeInteger(maxAgeDays) ||
    (maxAgeDays as number) < MIN_STANDARDS_MAX_AGE_DAYS ||
    (maxAgeDays as number) > MAX_STANDARDS_MAX_AGE_DAYS
  )
    fail("invalid-input", "$request.maxAgeDays", "maxAgeDays is outside the supported range");
  const lockfile = fields.get("lockfile");
  if (lockfile !== null && typeof lockfile !== "string" && !nodeTypes.isUint8Array(lockfile))
    fail("invalid-input", "$request.lockfile", "lockfile must be canonical text, bytes, or null");
  return {
    asOf,
    bundled,
    cachedLatest: fields.get("cachedLatest") as OfflineStandardsCachedLatestObservation | null,
    engineVersion,
    lockfile,
    maxAgeDays: maxAgeDays as number,
  };
}

function artifactAge(
  origin: "bundled" | "locked",
  publishedAt: string,
  asOf: string,
  maximumAgeDays: number,
): OfflineStandardsArtifactAge {
  const published = Date.parse(`${publishedAt}T00:00:00Z`);
  const current = Date.parse(`${asOf.slice(0, 10)}T00:00:00Z`);
  const ageDays = (current - published) / DAY_MS;
  return Object.freeze({
    ageDays,
    maximumAgeDays,
    origin,
    publishedAt,
    status: ageDays > maximumAgeDays ? "stale" : "current",
  });
}

function artifact(
  channel: KnowledgePackChannel,
  version: string,
  digest: string,
  verifiedAt: string,
): StandardsArtifact {
  return Object.freeze({
    channel,
    digest,
    retrievedAt: millisecondsInstant(verifiedAt),
    version,
  });
}

function parseLock(
  input: string | Uint8Array | null,
  channel: KnowledgePackChannel,
  engineVersion: string,
  asOf: string,
  issues: OfflineStandardsStatusIssue[],
): StandardsLockfile | undefined {
  if (input === null) return undefined;
  const parsed = parseCanonicalStandardsLockfile(input);
  if (!parsed.ok) {
    softIssue(
      issues,
      "invalid-lockfile",
      "lockfile",
      "$request.lockfile",
      "standards lockfile is invalid",
    );
    return undefined;
  }
  const lock = parsed.value;
  if (lock.channel !== channel) {
    softIssue(
      issues,
      "lock-channel-mismatch",
      "lockfile",
      "$request.lockfile.channel",
      "standards lockfile channel differs from the selected bundled channel",
    );
    return undefined;
  }
  if (lock.verificationTime > asOf || lock.pack.publishedAt > asOf.slice(0, 10)) {
    softIssue(
      issues,
      "lock-from-future",
      "lockfile",
      "$request.lockfile.verificationTime",
      "standards lockfile is newer than the fixed status time",
    );
    return undefined;
  }
  if (compareSemver(engineVersion, lock.target.minEngineVersion) < 0)
    softIssue(
      issues,
      "lock-engine-incompatible",
      "lockfile",
      "$request.lockfile.target.minEngineVersion",
      "standards lockfile requires a newer engine",
    );
  return lock;
}

function cachedObservation(
  input: unknown,
  channel: KnowledgePackChannel,
  engineVersion: string,
  asOf: string,
  issues: OfflineStandardsStatusIssue[],
): OfflineStandardsCachedLatestObservation | undefined {
  if (input === null) return undefined;
  try {
    const fields = ownData(
      input,
      ["channel", "checkedAt", "minEngineVersion", "origin", "packVersion", "sha256"],
      "$request.cachedLatest",
    );
    const observedChannel = fields.get("channel");
    const checkedAt = exactInstant(fields.get("checkedAt"));
    const minEngineVersion = fields.get("minEngineVersion");
    const origin = fields.get("origin");
    const packVersion = fields.get("packVersion");
    const sha256 = fields.get("sha256");
    if (
      (observedChannel !== "preview" && observedChannel !== "stable") ||
      checkedAt === undefined ||
      typeof minEngineVersion !== "string" ||
      parseSemver(minEngineVersion) === undefined ||
      origin !== "untrusted-offline-cache" ||
      typeof packVersion !== "string" ||
      parseSemver(packVersion) === undefined ||
      typeof sha256 !== "string" ||
      !SHA256.test(sha256)
    )
      throw new TypeError("invalid cached observation");
    if (observedChannel !== channel) {
      softIssue(
        issues,
        "cached-channel-mismatch",
        "cached-latest",
        "$request.cachedLatest.channel",
        "cached latest channel differs from the selected bundled channel",
      );
      return undefined;
    }
    if (checkedAt > asOf) {
      softIssue(
        issues,
        "cached-from-future",
        "cached-latest",
        "$request.cachedLatest.checkedAt",
        "cached latest check is newer than the fixed status time",
      );
      return undefined;
    }
    if (compareSemver(engineVersion, minEngineVersion) < 0)
      softIssue(
        issues,
        "cached-engine-incompatible",
        "cached-latest",
        "$request.cachedLatest.minEngineVersion",
        "cached latest pack requires a newer engine",
      );
    return Object.freeze({
      channel: observedChannel,
      checkedAt,
      minEngineVersion,
      origin,
      packVersion,
      sha256,
    });
  } catch {
    softIssue(
      issues,
      "cached-latest-invalid",
      "cached-latest",
      "$request.cachedLatest",
      "cached latest observation is invalid",
    );
    return undefined;
  }
}

function sortedIssues(
  issues: readonly OfflineStandardsStatusIssue[],
): readonly OfflineStandardsStatusIssue[] {
  return Object.freeze(
    [...issues].sort(
      (left, right) =>
        compareText(left.source, right.source) ||
        compareText(left.code, right.code) ||
        compareText(left.path, right.path),
    ),
  );
}

function sameMetadataSummary(
  left: TufTrustedMetadataSummary | null,
  right: TufTrustedMetadataSummary | null,
): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.expires === right.expires &&
      left.issuedAt === right.issuedAt &&
      left.role === right.role &&
      left.sha256 === right.sha256 &&
      left.version === right.version)
  );
}

function sameTrustedState(left: TufTrustedStateSnapshot, right: TufTrustedStateSnapshot): boolean {
  return (
    sameMetadataSummary(left.root, right.root) &&
    sameMetadataSummary(left.snapshot, right.snapshot) &&
    sameMetadataSummary(left.targets, right.targets) &&
    sameMetadataSummary(left.timestamp, right.timestamp) &&
    sameMetadataSummary(left.delegated.preview, right.delegated.preview) &&
    sameMetadataSummary(left.delegated.stable, right.delegated.stable)
  );
}

/**
 * Build a deterministic offline status report. This function has no filesystem, network, cache,
 * clock, or mutation capability; all observations and the exact status time are caller-supplied.
 */
export function createOfflineStandardsStatus(input: unknown): OfflineStandardsStatusResult {
  try {
    const request = validateRequest(input);
    const bundle = request.bundled;
    if (
      bundle.provenance.verificationTime > request.asOf ||
      bundle.pack.publishedAt > request.asOf.slice(0, 10)
    )
      fail(
        "invalid-clock",
        "$request.asOf",
        "asOf precedes authenticated bundled standards provenance",
      );
    const issues: OfflineStandardsStatusIssue[] = [];
    const locked = parseLock(
      request.lockfile,
      bundle.pack.channel,
      request.engineVersion,
      request.asOf,
      issues,
    );
    const cached = cachedObservation(
      request.cachedLatest,
      bundle.pack.channel,
      request.engineVersion,
      request.asOf,
      issues,
    );
    const lockContentAuthenticated =
      locked?.pack.packId === bundle.pack.packId &&
      locked.pack.packVersion === bundle.pack.packVersion &&
      locked.pack.publishedAt === bundle.pack.publishedAt &&
      locked.target.length === bundle.provenance.target.length &&
      locked.target.sha256 === bundle.provenance.target.sha256 &&
      locked.target.minEngineVersion === bundle.provenance.target.minEngineVersion &&
      locked.target.targetPath === bundle.provenance.target.targetPath &&
      locked.verificationTime === bundle.provenance.verificationTime &&
      sameTrustedState(locked.trustedState, bundle.provenance.trustedState);
    if (locked !== undefined && !lockContentAuthenticated)
      softIssue(
        issues,
        "lock-authority-unauthenticated",
        "lockfile",
        "$request.lockfile",
        "locked content or provenance differs from the authenticated bundled authority",
      );
    const lockEngineCompatible =
      locked !== undefined &&
      compareSemver(request.engineVersion, locked.target.minEngineVersion) >= 0;
    const bundledAge = artifactAge(
      "bundled",
      bundle.pack.publishedAt,
      request.asOf,
      request.maxAgeDays,
    );
    const lockedAge =
      locked === undefined
        ? null
        : artifactAge("locked", locked.pack.publishedAt, request.asOf, request.maxAgeDays);
    const selectedAge = lockedAge ?? bundledAge;
    if (selectedAge.status === "stale")
      softIssue(
        issues,
        "selected-pack-stale",
        "status",
        "$.age",
        "selected standards pack exceeds maxAgeDays",
      );
    const selectedVersion = locked?.pack.packVersion ?? bundle.pack.packVersion;
    const freshness =
      cached === undefined
        ? "offline-unknown"
        : compareSemver(cached.packVersion, selectedVersion) > 0
          ? "update-available"
          : "current";
    const finalIssues = sortedIssues(issues);
    const problems = Object.freeze([...new Set(finalIssues.map((entry) => entry.code))].sort());
    const output: StandardsOutput = Object.freeze({
      activation: lockContentAuthenticated && lockEngineCompatible ? "locked" : "bundled",
      bundled: artifact(
        bundle.pack.channel,
        bundle.pack.packVersion,
        bundle.provenance.contentSha256,
        bundle.provenance.verificationTime,
      ),
      cachedLatest:
        cached === undefined
          ? null
          : artifact(cached.channel, cached.packVersion, cached.sha256, cached.checkedAt),
      channel: bundle.pack.channel,
      freshness,
      locked:
        locked === undefined
          ? null
          : artifact(
              locked.channel,
              locked.pack.packVersion,
              locked.target.sha256,
              locked.verificationTime,
            ),
      mode: "status",
      problems,
      recordKind: "agent-context-standards-output",
      schemaVersion: "1.0.0",
    });
    const report: OfflineStandardsStatusReport = Object.freeze({
      age: Object.freeze({
        bundled: bundledAge,
        locked: lockedAge ?? null,
        policySelection: lockedAge === null ? "bundled" : "locked",
      }),
      asOf: request.asOf,
      contractVersion: OFFLINE_STANDARDS_STATUS_CONTRACT_VERSION,
      issues: finalIssues,
      lastCheckedAt: cached?.checkedAt ?? null,
      output,
      recordKind: OFFLINE_STANDARDS_STATUS_RECORD_KIND,
    });
    return Object.freeze({ ok: true, value: report });
  } catch (error) {
    return failure(error);
  }
}
