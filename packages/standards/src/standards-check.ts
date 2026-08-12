import { types as nodeTypes } from "node:util";

import {
  MAX_TUF_JSON_DEPTH,
  MAX_TUF_JSON_VALUES,
  MAX_TUF_ROOT_CHAIN,
  MAX_TUF_SEMVER_BYTES,
  MAX_TUF_TARGET_PATH_BYTES,
  OfflineTufTrustStore,
} from "./tuf-trust.js";
import { StandardsRegistryClient } from "./registry-client.js";

import type {
  TufChannel,
  TufTrustErrorCode,
  TufTrustedStateSnapshot,
  TufVerifiedTarget,
  TufVerifiedUpdate,
} from "./tuf-trust.js";
import type {
  StandardsRegistryIssue,
  StandardsRegistryIssueCode,
  StandardsRegistryObject,
  StandardsRegistryProvenance,
} from "./registry-client.js";

export const STANDARDS_CHECK_CONTRACT_VERSION = "0.1.0" as const;
export const MAX_STANDARDS_CHECK_REQUESTS: number = MAX_TUF_ROOT_CHAIN + 6;

export type StandardsCheckPhase =
  | "clock"
  | "delegated-targets"
  | "input"
  | "pack"
  | "root"
  | "snapshot"
  | "targets"
  | "timestamp"
  | "trust";

export type StandardsCheckLocalIssueCode =
  | "invalid-clock"
  | "invalid-input"
  | "invalid-routing-metadata"
  | "root-chain-limit"
  | "unexpected-failure";

export type StandardsCheckIssue =
  | Readonly<{
      code: StandardsCheckLocalIssueCode;
      message: string;
      path: string;
      phase: StandardsCheckPhase;
      source: "check";
    }>
  | Readonly<{
      code: StandardsRegistryIssueCode;
      message: string;
      path: string;
      phase: StandardsCheckPhase;
      source: "registry";
    }>
  | Readonly<{
      code: TufTrustErrorCode;
      message: string;
      path: string;
      phase: "trust";
      source: "trust";
    }>;

export type StandardsCheckResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly issues: readonly StandardsCheckIssue[]; readonly ok: false };

export interface StandardsCheckRequest {
  readonly channel: TufChannel;
  readonly engineVersion: string;
  readonly targetPath: string;
}

export interface StandardsCheckOptions {
  readonly signal: AbortSignal;
}

export interface StandardsCheckReport {
  readonly acquisitions: readonly StandardsRegistryProvenance[];
  readonly candidate: TufTrustedStateSnapshot;
  readonly checkedAt: string;
  readonly contractVersion: typeof STANDARDS_CHECK_CONTRACT_VERSION;
  readonly current: TufTrustedStateSnapshot;
  readonly recovery: Readonly<{
    readonly rootVersionsApplied: readonly number[];
    readonly snapshotAuthorityRotated: boolean;
    readonly timestampAuthorityRotated: boolean;
  }>;
  readonly requestsAttempted: number;
  readonly target: TufVerifiedTarget;
}

/** @internal H09-only verified bytes/state handoff; intentionally absent from package exports. */
export interface StandardsVerifiedUpdateForH09 {
  readonly state: OfflineTufTrustStore;
  readonly targetBytes: Uint8Array;
}

const VERIFIED_UPDATE_BY_REPORT = new WeakMap<StandardsCheckReport, TufVerifiedUpdate>();

interface StandardsCheckClock {
  nowMilliseconds(): number;
}

interface ValidatedCheckInput {
  readonly channel: TufChannel;
  readonly engineVersion: string;
  readonly signal: AbortSignal;
  readonly targetPath: string;
}

type RoutingObject = Readonly<Record<string, unknown>>;

class CheckFailure extends Error {
  readonly issue: StandardsCheckIssue;

  constructor(issue: StandardsCheckIssue) {
    super(issue.message);
    this.issue = issue;
  }
}

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const TARGET_PATH = /^knowledge\/(?:preview|stable)\/[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*\.json$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_TUF_VERSION = 2_147_483_647;
const MIN_CLOCK_MS = Date.UTC(1970, 0, 1);
const MAX_CLOCK_MS = Date.UTC(9999, 11, 31, 23, 59, 59);
const SYSTEM_CLOCK: StandardsCheckClock = Object.freeze({
  nowMilliseconds: (): number => Date.now(),
});

function localFailure(
  code: StandardsCheckLocalIssueCode,
  phase: StandardsCheckPhase,
  path: string,
  message: string,
): never {
  throw new CheckFailure(Object.freeze({ code, message, path, phase, source: "check" }));
}

function registryFailure(issue: StandardsRegistryIssue, phase: StandardsCheckPhase): never {
  throw new CheckFailure(
    Object.freeze({
      code: issue.code,
      message: issue.message,
      path: issue.path,
      phase,
      source: "registry",
    }),
  );
}

function failure<T>(error: unknown): StandardsCheckResult<T> {
  const issue =
    error instanceof CheckFailure
      ? error.issue
      : Object.freeze({
          code: "unexpected-failure" as const,
          message: "standards check failed closed",
          path: "$",
          phase: "trust" as const,
          source: "check" as const,
        });
  return Object.freeze({ issues: Object.freeze([issue]), ok: false });
}

function success<T>(value: T): StandardsCheckResult<T> {
  return Object.freeze({ ok: true, value });
}

function plainData(value: unknown, path: string): RoutingObject {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    nodeTypes.isProxy(value)
  )
    localFailure("invalid-input", "input", path, "standards check input must be plain data");
  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    localFailure("invalid-input", "input", path, "standards check input has an unsafe prototype");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string")
      localFailure("invalid-input", "input", path, "standards check input has a symbol field");
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor))
      localFailure("invalid-input", "input", path, "standards check input has an accessor field");
    output[key] = descriptor.value;
  }
  return output;
}

function exactKeys(value: RoutingObject, expected: readonly string[], path: string): void {
  const keys = Object.keys(value);
  if (
    keys.length !== expected.length ||
    expected.some((key) => !Object.hasOwn(value, key)) ||
    keys.some((key) => !expected.includes(key))
  )
    localFailure(
      "invalid-input",
      "input",
      path,
      "standards check fields do not match the contract",
    );
}

function byteLengthWithin(value: string, maximum: number): boolean {
  return value.length <= maximum && Buffer.byteLength(value, "utf8") <= maximum;
}

function nativeSignal(value: unknown): value is AbortSignal {
  return (
    value !== null &&
    typeof value === "object" &&
    !nodeTypes.isProxy(value) &&
    value instanceof AbortSignal &&
    Reflect.getPrototypeOf(value) === AbortSignal.prototype
  );
}

function validateInput(requestInput: unknown, optionsInput: unknown): ValidatedCheckInput {
  const request = plainData(requestInput, "$request");
  exactKeys(request, ["channel", "engineVersion", "targetPath"], "$request");
  const options = plainData(optionsInput, "$options");
  exactKeys(options, ["signal"], "$options");
  const channel = request["channel"];
  const engineVersion = request["engineVersion"];
  const targetPath = request["targetPath"];
  const signal = options["signal"];
  if (channel !== "preview" && channel !== "stable")
    localFailure("invalid-input", "input", "$request.channel", "channel must be preview or stable");
  if (
    typeof engineVersion !== "string" ||
    !byteLengthWithin(engineVersion, MAX_TUF_SEMVER_BYTES) ||
    !SEMVER.test(engineVersion)
  )
    localFailure(
      "invalid-input",
      "input",
      "$request.engineVersion",
      "engine version must be bounded SemVer 2.0.0",
    );
  if (
    typeof targetPath !== "string" ||
    !byteLengthWithin(targetPath, MAX_TUF_TARGET_PATH_BYTES) ||
    !TARGET_PATH.test(targetPath) ||
    !targetPath.startsWith(`knowledge/${channel}/`)
  )
    localFailure(
      "invalid-input",
      "input",
      "$request.targetPath",
      "target path must be canonical and belong to the selected channel",
    );
  if (!nativeSignal(signal))
    localFailure(
      "invalid-input",
      "input",
      "$options.signal",
      "signal must be a native AbortSignal",
    );
  return Object.freeze({ channel, engineVersion, signal, targetPath });
}

function fixedStart(clock: StandardsCheckClock): string {
  let milliseconds: number;
  try {
    milliseconds = clock.nowMilliseconds();
  } catch {
    localFailure("invalid-clock", "clock", "$clock", "standards check clock failed");
  }
  if (
    !Number.isSafeInteger(milliseconds) ||
    milliseconds < MIN_CLOCK_MS ||
    milliseconds > MAX_CLOCK_MS
  )
    localFailure("invalid-clock", "clock", "$clock", "standards check clock is outside UTC bounds");
  return new Date(Math.floor(milliseconds / 1_000) * 1_000).toISOString().replace(".000Z", "Z");
}

function preflightJson(text: string, phase: StandardsCheckPhase): void {
  let depth = 0;
  let values = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (inString) {
      if (escaped) escaped = false;
      else if (code === 0x5c) escaped = true;
      else if (code === 0x22) inString = false;
      continue;
    }
    if (code === 0x22) {
      inString = true;
      values += 1;
    } else if (code === 0x7b || code === 0x5b) {
      depth += 1;
      values += 1;
      if (depth > MAX_TUF_JSON_DEPTH)
        localFailure(
          "invalid-routing-metadata",
          phase,
          "$routing",
          "routing metadata exceeds its depth limit",
        );
    } else if (code === 0x7d || code === 0x5d) {
      depth -= 1;
      if (depth < 0)
        localFailure(
          "invalid-routing-metadata",
          phase,
          "$routing",
          "routing metadata is structurally invalid",
        );
    } else if (code === 0x2c || code === 0x3a) values += 1;
    if (values > MAX_TUF_JSON_VALUES)
      localFailure(
        "invalid-routing-metadata",
        phase,
        "$routing",
        "routing metadata exceeds its value limit",
      );
  }
  if (inString || depth !== 0)
    localFailure("invalid-routing-metadata", phase, "$routing", "routing metadata is incomplete");
}

function routingJson(object: StandardsRegistryObject, phase: StandardsCheckPhase): RoutingObject {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(object.bytes);
  } catch {
    localFailure("invalid-routing-metadata", phase, "$routing", "routing metadata is not UTF-8");
  }
  if (object.bytes[0] === 0xef && object.bytes[1] === 0xbb && object.bytes[2] === 0xbf)
    localFailure(
      "invalid-routing-metadata",
      phase,
      "$routing",
      "routing metadata has an unsupported byte-order mark",
    );
  preflightJson(text, phase);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    localFailure(
      "invalid-routing-metadata",
      phase,
      "$routing",
      "routing metadata is not valid JSON",
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    localFailure(
      "invalid-routing-metadata",
      phase,
      "$routing",
      "routing metadata must be an object",
    );
  return parsed as RoutingObject;
}

function child(value: unknown, phase: StandardsCheckPhase, path: string): RoutingObject {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    localFailure("invalid-routing-metadata", phase, path, "routing field must be an object");
  return value as RoutingObject;
}

function field(value: RoutingObject, key: string): unknown {
  const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
}

function routeVersion(value: unknown, phase: StandardsCheckPhase, path: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_TUF_VERSION
  )
    localFailure("invalid-routing-metadata", phase, path, "routing metadata version is invalid");
  return value;
}

function timestampSnapshotVersion(object: StandardsRegistryObject): number {
  const envelope = routingJson(object, "timestamp");
  const signed = child(field(envelope, "signed"), "timestamp", "$routing.signed");
  const meta = child(field(signed, "meta"), "timestamp", "$routing.signed.meta");
  const snapshot = child(
    field(meta, "snapshot.json"),
    "timestamp",
    "$routing.signed.meta.snapshot.json",
  );
  return routeVersion(
    field(snapshot, "version"),
    "timestamp",
    "$routing.signed.meta.snapshot.json.version",
  );
}

function snapshotRoleVersion(object: StandardsRegistryObject, name: string): number {
  const envelope = routingJson(object, "snapshot");
  const signed = child(field(envelope, "signed"), "snapshot", "$routing.signed");
  const meta = child(field(signed, "meta"), "snapshot", "$routing.signed.meta");
  const role = child(field(meta, name), "snapshot", `$routing.signed.meta.${name}`);
  return routeVersion(field(role, "version"), "snapshot", `$routing.signed.meta.${name}.version`);
}

function delegatedPackDigest(object: StandardsRegistryObject, targetPath: string): string {
  const envelope = routingJson(object, "delegated-targets");
  const signed = child(field(envelope, "signed"), "delegated-targets", "$routing.signed");
  const targets = child(field(signed, "targets"), "delegated-targets", "$routing.signed.targets");
  const target = child(
    field(targets, targetPath),
    "delegated-targets",
    "$routing.signed.targets.requested",
  );
  const hashes = child(
    field(target, "hashes"),
    "delegated-targets",
    "$routing.signed.targets.requested.hashes",
  );
  const digest = field(hashes, "sha256");
  if (typeof digest !== "string" || !SHA256.test(digest))
    localFailure(
      "invalid-routing-metadata",
      "delegated-targets",
      "$routing.signed.targets.requested.hashes.sha256",
      "routing target digest is invalid",
    );
  return digest;
}

let constructChecker: (
  trust: OfflineTufTrustStore,
  registry: StandardsRegistryClient,
  clock: StandardsCheckClock,
) => StandardsChecker;

export class StandardsChecker {
  readonly #clock: StandardsCheckClock;
  readonly #registry: StandardsRegistryClient;
  readonly #trust: OfflineTufTrustStore;

  private constructor(
    trust: OfflineTufTrustStore,
    registry: StandardsRegistryClient,
    clock: StandardsCheckClock,
  ) {
    this.#trust = trust;
    this.#registry = registry;
    this.#clock = clock;
    Object.freeze(this);
  }

  static {
    constructChecker = (trust, registry, clock): StandardsChecker =>
      new StandardsChecker(trust, registry, clock);
  }

  static create(trust: OfflineTufTrustStore): StandardsChecker {
    return new StandardsChecker(trust, StandardsRegistryClient.create(), SYSTEM_CLOCK);
  }

  async check(
    request: StandardsCheckRequest,
    options: StandardsCheckOptions,
  ): Promise<StandardsCheckResult<StandardsCheckReport>>;
  async check(
    requestInput: unknown,
    optionsInput: unknown,
  ): Promise<StandardsCheckResult<StandardsCheckReport>> {
    try {
      const input = validateInput(requestInput, optionsInput);
      if (
        nodeTypes.isProxy(this.#trust) ||
        !(this.#trust instanceof OfflineTufTrustStore) ||
        Reflect.getPrototypeOf(this.#trust) !== OfflineTufTrustStore.prototype
      )
        localFailure("invalid-input", "input", "$trust", "trusted state is not authentic");
      const checkedAt = fixedStart(this.#clock);
      const current = this.#trust.snapshot();
      const acquisitions: StandardsRegistryProvenance[] = [];
      let requestsAttempted = 0;

      const acquire = async (
        objectRequest:
          | { readonly kind: "metadata"; readonly role: "root"; readonly version: number }
          | {
              readonly kind: "metadata";
              readonly role:
                "snapshot" | "standards-preview" | "standards-stable" | "targets" | "timestamp";
              readonly version: number | null;
            }
          | { readonly kind: "pack"; readonly sha256: string },
        phase: StandardsCheckPhase,
        missingIsEnd = false,
      ): Promise<StandardsRegistryObject | null> => {
        requestsAttempted += 1;
        if (requestsAttempted > MAX_STANDARDS_CHECK_REQUESTS)
          localFailure(
            "root-chain-limit",
            "root",
            "$registry",
            "standards check request budget was exceeded",
          );
        const result = await this.#registry.fetchObject(objectRequest, { signal: input.signal });
        if (!result.ok) {
          const issue = result.issues[0];
          if (issue === undefined)
            localFailure(
              "unexpected-failure",
              phase,
              "$registry",
              "standards registry returned no issue",
            );
          if (missingIsEnd && issue.code === "not-found") return null;
          registryFailure(issue, phase);
        }
        acquisitions.push(result.value.provenance);
        return result.value;
      };

      const roots: Uint8Array[] = [];
      for (let offset = 1; offset <= MAX_TUF_ROOT_CHAIN + 1; offset += 1) {
        const version = current.root.version + offset;
        if (!Number.isSafeInteger(version) || version > MAX_TUF_VERSION)
          localFailure(
            "root-chain-limit",
            "root",
            "$registry.root",
            "trusted root version cannot advance safely",
          );
        const candidate = await acquire({ kind: "metadata", role: "root", version }, "root", true);
        if (candidate === null) break;
        if (offset > MAX_TUF_ROOT_CHAIN)
          localFailure(
            "root-chain-limit",
            "root",
            "$registry.root",
            "root update chain exceeds its per-check limit",
          );
        roots.push(candidate.bytes);
      }

      const timestamp = await acquire(
        { kind: "metadata", role: "timestamp", version: null },
        "timestamp",
      );
      if (timestamp === null)
        localFailure("unexpected-failure", "timestamp", "$registry", "timestamp is missing");
      const snapshotVersion = timestampSnapshotVersion(timestamp);
      const snapshot = await acquire(
        { kind: "metadata", role: "snapshot", version: snapshotVersion },
        "snapshot",
      );
      if (snapshot === null)
        localFailure("unexpected-failure", "snapshot", "$registry", "snapshot is missing");
      const targetsVersion = snapshotRoleVersion(snapshot, "targets.json");
      const delegatedRole = input.channel === "stable" ? "standards-stable" : "standards-preview";
      const delegatedVersion = snapshotRoleVersion(snapshot, `${delegatedRole}.json`);
      const targets = await acquire(
        { kind: "metadata", role: "targets", version: targetsVersion },
        "targets",
      );
      if (targets === null)
        localFailure("unexpected-failure", "targets", "$registry", "targets metadata is missing");
      const delegated = await acquire(
        { kind: "metadata", role: delegatedRole, version: delegatedVersion },
        "delegated-targets",
      );
      if (delegated === null)
        localFailure(
          "unexpected-failure",
          "delegated-targets",
          "$registry",
          "delegated targets metadata is missing",
        );
      const packDigest = delegatedPackDigest(delegated, input.targetPath);
      const pack = await acquire({ kind: "pack", sha256: packDigest }, "pack");
      if (pack === null)
        localFailure("unexpected-failure", "pack", "$registry", "target pack is missing");

      const verified = this.#trust.verifyUpdate(
        {
          delegatedTargets: delegated.bytes,
          roots,
          snapshot: snapshot.bytes,
          target: pack.bytes,
          targets: targets.bytes,
          timestamp: timestamp.bytes,
        },
        {
          channel: input.channel,
          engineVersion: input.engineVersion,
          startedAt: checkedAt,
          targetPath: input.targetPath,
        },
      );
      if (!verified.ok) {
        const issue = verified.issues[0];
        if (issue === undefined)
          localFailure(
            "unexpected-failure",
            "trust",
            "$trust",
            "trust verification returned no issue",
          );
        throw new CheckFailure(
          Object.freeze({
            code: issue.code,
            message: issue.message,
            path: issue.path,
            phase: "trust",
            source: "trust",
          }),
        );
      }
      const report: StandardsCheckReport = Object.freeze({
        acquisitions: Object.freeze([...acquisitions]),
        candidate: verified.value.state.snapshot(),
        checkedAt,
        contractVersion: STANDARDS_CHECK_CONTRACT_VERSION,
        current,
        recovery: verified.value.recovery,
        requestsAttempted,
        target: verified.value.target,
      });
      VERIFIED_UPDATE_BY_REPORT.set(report, verified.value);
      return success(report);
    } catch (error) {
      return failure(error);
    }
  }
}

/** @internal One-use H08-to-H09 authority transfer without exposing target bytes publicly. */
export function consumeStandardsVerifiedUpdateForH09(
  report: StandardsCheckReport,
): StandardsVerifiedUpdateForH09 | undefined {
  const verified = VERIFIED_UPDATE_BY_REPORT.get(report);
  if (verified === undefined) return undefined;
  VERIFIED_UPDATE_BY_REPORT.delete(report);
  return Object.freeze({
    state: verified.state,
    targetBytes: new Uint8Array(verified.targetBytes),
  });
}

/** @internal Clock/registry injection seam; not exported from the package root. */
export function createStandardsCheckerFixtureForTest(
  trust: OfflineTufTrustStore,
  registry: StandardsRegistryClient,
  clock: StandardsCheckClock,
): StandardsChecker {
  return constructChecker(trust, registry, clock);
}
