import { performance } from "node:perf_hooks";
import { types as nodeTypes } from "node:util";

import { canonicalizeRepositoryRelativePath } from "@agent-context/core";
import type { RepositoryRelativePath } from "@agent-context/core";

import {
  BUILT_IN_INSTRUCTION_PATH_DEFINITIONS,
  isCanonicalRepositoryPathForDiscovery,
  isSafeDiscoveryText,
  matchesBuiltInDiscoveryPathMatcher,
  recognizeBuiltInInstructionPath as recognizeSharedBuiltInInstructionPath,
} from "../built-in-instruction-paths.mjs";
import type { IgnoreEngineResult } from "./ignore-engine.js";
import type { TrackedFileEnumerationResult } from "./tracked-file-enumeration.js";

export const DISCOVERY_INDEX_CONTRACT_VERSION = "0.1.0" as const;

export interface DiscoveryIndexLimits {
  readonly maximumCandidates: number;
  readonly maximumDurationMs: number;
  readonly maximumMatcherFacts: number;
  readonly maximumMatcherWork: number;
  readonly maximumPathDepth: number;
  readonly maximumPathLength: number;
  readonly maximumPaths: number;
  readonly maximumRecognizersPerCandidate: number;
  readonly maximumTotalPathBytes: number;
  readonly maximumUpstreamFacts: number;
}

export const DISCOVERY_INDEX_DEFAULT_LIMITS: Readonly<DiscoveryIndexLimits> = Object.freeze({
  maximumCandidates: 100_000,
  maximumDurationMs: 30_000,
  maximumMatcherFacts: 256,
  maximumMatcherWork: 100_000_000,
  maximumPathDepth: 128,
  maximumPathLength: 16_384,
  maximumPaths: 100_000,
  maximumRecognizersPerCandidate: 32,
  maximumTotalPathBytes: 67_108_864,
  maximumUpstreamFacts: 10_000,
});

export const DISCOVERY_INDEX_HARD_LIMITS: Readonly<DiscoveryIndexLimits> = Object.freeze({
  maximumCandidates: 1_000_000,
  maximumDurationMs: 300_000,
  maximumMatcherFacts: 4_096,
  maximumMatcherWork: 500_000_000,
  maximumPathDepth: 1_024,
  maximumPathLength: 16_384,
  maximumPaths: 1_000_000,
  maximumRecognizersPerCandidate: 256,
  maximumTotalPathBytes: 536_870_912,
  maximumUpstreamFacts: 100_000,
});

export type DiscoveryCandidateKind = "configuration" | "evidence" | "instruction";
export type DiscoveryMatcherApplicability =
  "conditional" | "contradiction" | "known-active" | "known-inactive" | "unknown";
export type DiscoveryMatcherEvidence =
  "documented" | "documented-versioned" | "observed" | "source-derived";

export type DiscoveryPathMatcher =
  | { readonly kind: "basename"; readonly value: string }
  | { readonly kind: "exact-path"; readonly value: string }
  | { readonly kind: "path-suffix"; readonly value: string }
  | {
      readonly directory: string;
      readonly kind: "under-directory-extension";
      readonly suffix: string;
    };

/** Data-only profile/configuration contribution. Only known-active facts can match paths. */
export interface DiscoveryMatcherFact {
  readonly applicability: DiscoveryMatcherApplicability;
  readonly candidateKind: DiscoveryCandidateKind;
  readonly clientVersion: string | null;
  readonly evidence: DiscoveryMatcherEvidence;
  readonly factId: string;
  readonly formatId: string | null;
  readonly matcher: DiscoveryPathMatcher;
  readonly profileId: string | null;
  readonly reason: string | null;
  readonly recognizerId: string;
  readonly retrievedAt: string;
  readonly sourceUrl: string;
}

export interface DiscoveryIndexOptions {
  readonly matcherFacts?: readonly DiscoveryMatcherFact[];
  readonly maximumCandidates?: number;
  readonly maximumDurationMs?: number;
  readonly maximumMatcherFacts?: number;
  readonly maximumMatcherWork?: number;
  readonly maximumPathDepth?: number;
  readonly maximumPathLength?: number;
  readonly maximumPaths?: number;
  readonly maximumRecognizersPerCandidate?: number;
  readonly maximumTotalPathBytes?: number;
  readonly maximumUpstreamFacts?: number;
  readonly signal?: AbortSignal;
}

export interface DiscoverySource {
  readonly artifactPath: RepositoryRelativePath | null;
  readonly id: string;
  readonly retrievedAt: string;
  readonly url: string | null;
}

export interface DiscoveryRecognition {
  readonly factId: string | null;
  readonly formatId: string | null;
  readonly kind: DiscoveryCandidateKind;
  readonly origin: "built-in-catalog" | "matcher-fact";
  readonly profileId: string | null;
  readonly recognizerId: string;
  readonly source: DiscoverySource;
}

export type DiscoveryUncertaintyReason =
  "deferred-ignore-profile-facts" | "deferred-matcher-facts" | "fallback-tracking";

export interface DiscoveryCandidate {
  readonly kinds: readonly DiscoveryCandidateKind[];
  readonly path: RepositoryRelativePath;
  readonly recognitions: readonly DiscoveryRecognition[];
  readonly uncertainty: readonly DiscoveryUncertaintyReason[];
}

export interface DiscoveryIndexProvenance {
  readonly appliedIgnoreProfileFactIds: readonly string[];
  readonly appliedMatcherFactIds: readonly string[];
  readonly catalogSources: readonly DiscoverySource[];
  readonly deferredIgnoreProfileFactCount: number;
  readonly deferredMatcherFacts: readonly DiscoveryMatcherFact[];
  readonly enumerationCertainty: "all-files-not-tracked" | "tracked";
  readonly enumerationReason: string;
  readonly enumerationSource: "filesystem-fallback" | "git-index";
  readonly ignoreCertainty: "exact-tracked-input" | "fallback-tracking-uncertain";
  readonly ignoreProfileCertainty: "known" | "uncertain-facts-deferred";
  readonly trackingCertainty: "fallback-mixed-unknown" | "tracked";
}

export interface DiscoveryIndexMetrics {
  readonly candidateCount: number;
  readonly configurationCandidateCount: number;
  readonly contentReads: 0;
  readonly enumeratedPathCount: number;
  readonly evidenceCandidateCount: number;
  readonly ignoredPathCount: number;
  readonly inspectedPathCount: number;
  readonly instructionCandidateCount: number;
  readonly matcherWork: number;
  readonly retainedPathCount: number;
  readonly totalPathBytes: number;
}

export interface TargetedDiscoveryIndex {
  readonly candidates: readonly DiscoveryCandidate[];
  readonly contractVersion: typeof DISCOVERY_INDEX_CONTRACT_VERSION;
  readonly limits: DiscoveryIndexLimits;
  readonly matcherFacts: readonly DiscoveryMatcherFact[];
  readonly metrics: DiscoveryIndexMetrics;
  readonly provenance: DiscoveryIndexProvenance;
  readonly uncertainty: "known" | "uncertain";
  readonly uncertaintyReasons: readonly DiscoveryUncertaintyReason[];
}

const ISSUED_TARGETED_DISCOVERY_INDEXES = new WeakSet<object>();

/** Return true only for a discovery index produced in this process by the C05 builder. */
export function isIssuedTargetedDiscoveryIndex(value: unknown): value is TargetedDiscoveryIndex {
  return (
    typeof value === "object" && value !== null && ISSUED_TARGETED_DISCOVERY_INDEXES.has(value)
  );
}

export const DiscoveryIndexErrorCode: Readonly<{
  aborted: "DISCOVERY_INDEX_ABORTED";
  deadlineExceeded: "DISCOVERY_INDEX_DEADLINE_EXCEEDED";
  invalidInput: "DISCOVERY_INDEX_INVALID_INPUT";
  invalidOptions: "DISCOVERY_INDEX_INVALID_OPTIONS";
  limitExceeded: "DISCOVERY_INDEX_LIMIT_EXCEEDED";
  malformedInput: "DISCOVERY_INDEX_MALFORMED_INPUT";
}> = Object.freeze({
  aborted: "DISCOVERY_INDEX_ABORTED",
  deadlineExceeded: "DISCOVERY_INDEX_DEADLINE_EXCEEDED",
  invalidInput: "DISCOVERY_INDEX_INVALID_INPUT",
  invalidOptions: "DISCOVERY_INDEX_INVALID_OPTIONS",
  limitExceeded: "DISCOVERY_INDEX_LIMIT_EXCEEDED",
  malformedInput: "DISCOVERY_INDEX_MALFORMED_INPUT",
} as const);

export type DiscoveryIndexErrorCode =
  (typeof DiscoveryIndexErrorCode)[keyof typeof DiscoveryIndexErrorCode];

export class DiscoveryIndexError extends Error {
  override readonly name = "DiscoveryIndexError" as const;
  readonly code: DiscoveryIndexErrorCode;
  readonly operation: string;
  readonly path: RepositoryRelativePath | undefined;

  constructor(
    code: DiscoveryIndexErrorCode,
    message: string,
    operation: string,
    pathValue?: RepositoryRelativePath,
  ) {
    super(message);
    this.code = code;
    this.operation = operation;
    this.path = pathValue;
    Object.freeze(this);
  }
}

export interface DiscoveryIndexClock {
  now(): number;
}

interface Recognizer {
  readonly factId: string | null;
  readonly formatId: string | null;
  readonly id: string;
  readonly kind: DiscoveryCandidateKind;
  readonly matcher: DiscoveryPathMatcher;
  readonly origin: "built-in-catalog" | "matcher-fact";
  readonly profileId: string | null;
  readonly source: DiscoverySource;
}

interface OptionsSnapshot {
  readonly limits: Readonly<DiscoveryIndexLimits>;
  readonly matcherFacts: readonly DiscoveryMatcherFact[];
  readonly signal?: AbortSignal;
}

interface EnumerationSnapshot {
  readonly certainty: "all-files-not-tracked" | "tracked";
  readonly paths: readonly RepositoryRelativePath[];
  readonly reason: string;
  readonly source: "filesystem-fallback" | "git-index";
  readonly totalPathBytes: number;
}

interface IgnoreSnapshot {
  readonly appliedProfileFactIds: readonly string[];
  readonly certainty: "exact-tracked-input" | "fallback-tracking-uncertain";
  readonly deferredProfileFactCount: number;
  readonly ignoredPaths: readonly RepositoryRelativePath[];
  readonly paths: readonly RepositoryRelativePath[];
  readonly profileCertainty: "known" | "uncertain-facts-deferred";
  readonly trackingCertainty: "fallback-mixed-unknown" | "tracked";
}

const RETRIEVED_AT = "2026-08-02";
const DEFAULT_CLOCK: DiscoveryIndexClock = Object.freeze({ now: () => performance.now() });
const ABORTED_DESCRIPTOR = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted");
const OPTION_KEYS = Object.freeze([
  "matcherFacts",
  ...Object.keys(DISCOVERY_INDEX_HARD_LIMITS),
  "signal",
]);
const FACT_KEYS = Object.freeze([
  "applicability",
  "candidateKind",
  "clientVersion",
  "evidence",
  "factId",
  "formatId",
  "matcher",
  "profileId",
  "reason",
  "recognizerId",
  "retrievedAt",
  "sourceUrl",
]);

function localSource(id: string): DiscoverySource {
  return Object.freeze({
    artifactPath: canonicalizeRepositoryRelativePath("agent-context-linter-implementation-plan.md"),
    id,
    retrievedAt: RETRIEVED_AT,
    url: null,
  });
}

function webSource(id: string, url: string): DiscoverySource {
  return Object.freeze({ artifactPath: null, id, retrievedAt: RETRIEVED_AT, url });
}

const SOURCES = Object.freeze({
  claude: webSource("claude-memory-current", "https://code.claude.com/docs/en/memory"),
  codex: webSource(
    "codex-agents-md-current",
    "https://developers.openai.com/codex/guides/agents-md",
  ),
  copilot: webSource(
    "github-copilot-instructions-current",
    "https://docs.github.com/en/copilot/reference/custom-instructions-support",
  ),
  cursor: webSource("cursor-rules-current", "https://cursor.com/docs/context/rules"),
  gemini: webSource("gemini-context-current", "https://geminicli.com/docs/cli/gemini-md/"),
  planC05: localSource("implementation-plan-c05"),
  planC11: localSource("implementation-plan-c11"),
});

function basename(value: string): DiscoveryPathMatcher {
  return Object.freeze({ kind: "basename", value });
}

function exact(value: string): DiscoveryPathMatcher {
  return Object.freeze({ kind: "exact-path", value });
}

function pathSuffix(value: string): DiscoveryPathMatcher {
  return Object.freeze({ kind: "path-suffix", value });
}

function recognizer(
  id: string,
  kind: DiscoveryCandidateKind,
  formatId: string | null,
  matcher: DiscoveryPathMatcher,
  source: DiscoverySource,
): Recognizer {
  return Object.freeze({
    factId: null,
    formatId,
    id,
    kind,
    matcher,
    origin: "built-in-catalog",
    profileId: null,
    source,
  });
}

/** Closed v0 path-only catalog. Profile adapters remain authoritative for activation/order. */
export const BUILT_IN_DISCOVERY_RECOGNIZER_IDS: readonly string[] = Object.freeze([
  "config.agent-context-lint",
  "config.claude-settings",
  "config.claude-settings-local",
  "config.gemini-ignore",
  "config.gemini-settings",
  "config.gitignore",
  "evidence.bazel-build",
  "evidence.bazel-module",
  "evidence.bazel-workspace",
  "evidence.cargo-manifest",
  "evidence.go-module",
  "evidence.go-workspace",
  "evidence.javascript-package",
  "evidence.lerna",
  "evidence.nx",
  "evidence.pnpm-workspace",
  "evidence.python-project",
  "evidence.python-setup-cfg",
  "evidence.python-setup-py",
  "evidence.rush",
  "evidence.turbo",
  "instruction.agents-base",
  "instruction.agents-override",
  "instruction.claude-local",
  "instruction.claude-memory",
  "instruction.claude-rules",
  "instruction.copilot-path",
  "instruction.copilot-repository",
  "instruction.cursor-legacy",
  "instruction.cursor-mdc",
  "instruction.gemini-context",
]);

const BUILT_INS: readonly Recognizer[] = Object.freeze([
  recognizer(
    "config.agent-context-lint",
    "configuration",
    null,
    exact(".agent-context-lint.yml"),
    SOURCES.planC05,
  ),
  recognizer(
    "config.claude-settings",
    "configuration",
    null,
    pathSuffix(".claude/settings.json"),
    SOURCES.claude,
  ),
  recognizer(
    "config.claude-settings-local",
    "configuration",
    null,
    pathSuffix(".claude/settings.local.json"),
    SOURCES.claude,
  ),
  recognizer(
    "config.gemini-ignore",
    "configuration",
    null,
    basename(".geminiignore"),
    SOURCES.gemini,
  ),
  recognizer(
    "config.gemini-settings",
    "configuration",
    null,
    pathSuffix(".gemini/settings.json"),
    SOURCES.gemini,
  ),
  recognizer("config.gitignore", "configuration", null, basename(".gitignore"), SOURCES.planC05),
  recognizer("evidence.bazel-build", "evidence", null, basename("BUILD"), SOURCES.planC11),
  recognizer("evidence.bazel-build", "evidence", null, basename("BUILD.bazel"), SOURCES.planC11),
  recognizer("evidence.bazel-module", "evidence", null, basename("MODULE.bazel"), SOURCES.planC11),
  recognizer("evidence.bazel-workspace", "evidence", null, basename("WORKSPACE"), SOURCES.planC11),
  recognizer(
    "evidence.bazel-workspace",
    "evidence",
    null,
    basename("WORKSPACE.bazel"),
    SOURCES.planC11,
  ),
  recognizer("evidence.cargo-manifest", "evidence", null, basename("Cargo.toml"), SOURCES.planC11),
  recognizer("evidence.go-module", "evidence", null, basename("go.mod"), SOURCES.planC11),
  recognizer("evidence.go-workspace", "evidence", null, basename("go.work"), SOURCES.planC11),
  recognizer(
    "evidence.javascript-package",
    "evidence",
    null,
    basename("package.json"),
    SOURCES.planC11,
  ),
  recognizer("evidence.lerna", "evidence", null, basename("lerna.json"), SOURCES.planC11),
  recognizer("evidence.nx", "evidence", null, basename("nx.json"), SOURCES.planC11),
  recognizer(
    "evidence.pnpm-workspace",
    "evidence",
    null,
    basename("pnpm-workspace.yaml"),
    SOURCES.planC11,
  ),
  recognizer(
    "evidence.python-project",
    "evidence",
    null,
    basename("pyproject.toml"),
    SOURCES.planC11,
  ),
  recognizer("evidence.python-setup-cfg", "evidence", null, basename("setup.cfg"), SOURCES.planC11),
  recognizer("evidence.python-setup-py", "evidence", null, basename("setup.py"), SOURCES.planC11),
  recognizer("evidence.rush", "evidence", null, basename("rush.json"), SOURCES.planC11),
  recognizer("evidence.turbo", "evidence", null, basename("turbo.json"), SOURCES.planC11),
  ...BUILT_IN_INSTRUCTION_PATH_DEFINITIONS.map((definition) =>
    recognizer(
      definition.recognizerId,
      "instruction",
      definition.formatId,
      definition.matcher,
      SOURCES[definition.sourceKey],
    ),
  ),
]);

export interface BuiltInInstructionPathRecognition {
  readonly formatId: string;
  readonly recognizerId: string;
}

/**
 * Classify one canonical repository path with the exact built-in, case-sensitive C05 instruction
 * recognizers. Maintainer tooling uses this pure projection so calibration strata cannot drift
 * from normal product discovery or accept search-engine case variants as supported syntax.
 */
export function recognizeBuiltInInstructionPath(
  pathValue: RepositoryRelativePath,
): readonly BuiltInInstructionPathRecognition[] {
  return recognizeSharedBuiltInInstructionPath(pathValue);
}

function failure(
  code: DiscoveryIndexErrorCode,
  message: string,
  operation: string,
  pathValue?: RepositoryRelativePath,
): DiscoveryIndexError {
  return new DiscoveryIndexError(code, message, operation, pathValue);
}

function unsafeText(value: string): boolean {
  return !isSafeDiscoveryText(value);
}

function validId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    /^[a-z0-9](?:[a-z0-9._/-]*[a-z0-9])?$/u.test(value)
  );
}

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

function plainValues(
  value: unknown,
  allowedKeys: readonly string[],
  code: DiscoveryIndexErrorCode,
  operation: string,
): ReadonlyMap<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    nodeTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw failure(code, "discovery data must be a plain object", operation);
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length > allowedKeys.length ||
    keys.some((key) => typeof key !== "string" || !allowedKeys.includes(key))
  ) {
    throw failure(code, "discovery data contains an unknown field", operation);
  }
  const result = new Map<string, unknown>();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      throw failure(code, "discovery data contains an accessor", operation);
    }
    result.set(key as string, descriptor.value as unknown);
  }
  return result;
}

function denseArray(
  value: unknown,
  maximum: number,
  code: DiscoveryIndexErrorCode,
  operation: string,
): readonly unknown[] {
  if (
    nodeTypes.isProxy(value) ||
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximum ||
    Reflect.ownKeys(value).some((key) => key !== "length" && !/^\d+$/u.test(String(key)))
  ) {
    throw failure(code, "discovery data must be a bounded plain array", operation);
  }
  const snapshot: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor)) {
      throw failure(code, "discovery data contains a sparse or accessor array", operation);
    }
    snapshot.push(descriptor.value as unknown);
  }
  return Object.freeze(snapshot);
}

function abortState(signal: AbortSignal | undefined): boolean {
  if (signal === undefined) return false;
  try {
    return ABORTED_DESCRIPTOR?.get?.call(signal) === true;
  } catch {
    throw failure(DiscoveryIndexErrorCode.invalidOptions, "abort signal is invalid", "signal");
  }
}

class Budget {
  readonly #clock: DiscoveryIndexClock;
  readonly #deadline: number;
  readonly #limit: number;
  readonly #signal: AbortSignal | undefined;
  #lastCheckedWork = 0;
  #lastNow: number;
  #work = 0;

  constructor(
    limits: DiscoveryIndexLimits,
    signal: AbortSignal | undefined,
    clock: DiscoveryIndexClock,
  ) {
    this.#clock = clock;
    this.#signal = signal;
    this.#limit = limits.maximumMatcherWork;
    this.#lastNow = this.readClock();
    this.#deadline = this.#lastNow + limits.maximumDurationMs;
    if (!Number.isFinite(this.#deadline)) {
      throw failure(
        DiscoveryIndexErrorCode.invalidOptions,
        "trusted discovery clock is invalid",
        "clock",
      );
    }
    this.check();
  }

  get work(): number {
    return this.#work;
  }

  consume(amount = 1): void {
    if (!Number.isSafeInteger(amount) || amount < 0 || this.#work > this.#limit - amount) {
      throw failure(
        DiscoveryIndexErrorCode.limitExceeded,
        "discovery matcher work limit was exceeded",
        "matcher-work",
      );
    }
    this.#work += amount;
    if (this.#work - this.#lastCheckedWork >= 1_024 || amount === 0) {
      this.check();
      this.#lastCheckedWork = this.#work;
    }
  }

  check(): void {
    if (abortState(this.#signal)) {
      throw failure(DiscoveryIndexErrorCode.aborted, "discovery was aborted", "discover");
    }
    const now = this.readClock();
    if (now < this.#lastNow) {
      throw failure(
        DiscoveryIndexErrorCode.invalidOptions,
        "discovery clock moved backwards",
        "clock",
      );
    }
    this.#lastNow = now;
    if (now > this.#deadline) {
      throw failure(
        DiscoveryIndexErrorCode.deadlineExceeded,
        "discovery deadline was exceeded",
        "deadline",
      );
    }
  }

  private readClock(): number {
    let value: number;
    try {
      value = this.#clock.now();
    } catch {
      throw failure(
        DiscoveryIndexErrorCode.invalidOptions,
        "trusted discovery clock failed",
        "clock",
      );
    }
    if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
      throw failure(
        DiscoveryIndexErrorCode.invalidOptions,
        "trusted discovery clock is invalid",
        "clock",
      );
    }
    return value;
  }
}

function snapshotMatcher(value: unknown, operation: string): DiscoveryPathMatcher {
  const fields = plainValues(
    value,
    ["directory", "kind", "suffix", "value"],
    DiscoveryIndexErrorCode.invalidOptions,
    operation,
  );
  const kind = fields.get("kind");
  if (kind === "basename") {
    const name = fields.get("value");
    if (
      fields.size !== 2 ||
      typeof name !== "string" ||
      name.length === 0 ||
      name.length > 255 ||
      name.includes("/") ||
      name.includes("\\") ||
      name === "." ||
      name === ".." ||
      unsafeText(name)
    ) {
      throw failure(
        DiscoveryIndexErrorCode.invalidOptions,
        "basename matcher is invalid",
        operation,
      );
    }
    return Object.freeze({ kind, value: name });
  }
  if (kind === "exact-path" || kind === "path-suffix") {
    const pathValue = fields.get("value");
    if (fields.size !== 2 || typeof pathValue !== "string") {
      throw failure(DiscoveryIndexErrorCode.invalidOptions, "exact matcher is invalid", operation);
    }
    let canonical: RepositoryRelativePath;
    try {
      canonical = canonicalizeRepositoryRelativePath(pathValue, "posix");
    } catch {
      throw failure(DiscoveryIndexErrorCode.invalidOptions, "exact matcher is invalid", operation);
    }
    if (canonical === "." || canonical !== pathValue || unsafeText(pathValue)) {
      throw failure(DiscoveryIndexErrorCode.invalidOptions, "exact matcher is invalid", operation);
    }
    return Object.freeze({ kind, value: canonical });
  }
  if (kind === "under-directory-extension") {
    const directory = fields.get("directory");
    const suffix = fields.get("suffix");
    if (
      fields.size !== 3 ||
      typeof directory !== "string" ||
      typeof suffix !== "string" ||
      suffix.length === 0 ||
      suffix.length > 255 ||
      suffix.includes("/") ||
      suffix.includes("\\") ||
      unsafeText(suffix)
    ) {
      throw failure(
        DiscoveryIndexErrorCode.invalidOptions,
        "directory matcher is invalid",
        operation,
      );
    }
    let canonical: RepositoryRelativePath;
    try {
      canonical = canonicalizeRepositoryRelativePath(directory, "posix");
    } catch {
      throw failure(
        DiscoveryIndexErrorCode.invalidOptions,
        "directory matcher is invalid",
        operation,
      );
    }
    if (canonical === "." || canonical !== directory || unsafeText(directory)) {
      throw failure(
        DiscoveryIndexErrorCode.invalidOptions,
        "directory matcher is invalid",
        operation,
      );
    }
    return Object.freeze({ directory: canonical, kind, suffix });
  }
  throw failure(DiscoveryIndexErrorCode.invalidOptions, "matcher kind is invalid", operation);
}

function snapshotFact(value: unknown): DiscoveryMatcherFact {
  const fields = plainValues(
    value,
    FACT_KEYS,
    DiscoveryIndexErrorCode.invalidOptions,
    "validate-matcher-fact",
  );
  if (fields.size !== FACT_KEYS.length) {
    throw failure(
      DiscoveryIndexErrorCode.invalidOptions,
      "matcher fact is missing a field",
      "validate-matcher-fact",
    );
  }
  const applicability = fields.get("applicability");
  const candidateKind = fields.get("candidateKind");
  const clientVersion = fields.get("clientVersion");
  const evidence = fields.get("evidence");
  const factId = fields.get("factId");
  const formatId = fields.get("formatId");
  const profileId = fields.get("profileId");
  const reason = fields.get("reason");
  const recognizerId = fields.get("recognizerId");
  const retrievedAt = fields.get("retrievedAt");
  const sourceUrl = fields.get("sourceUrl");
  const applicabilityValues: readonly DiscoveryMatcherApplicability[] = [
    "conditional",
    "contradiction",
    "known-active",
    "known-inactive",
    "unknown",
  ];
  const evidenceValues: readonly DiscoveryMatcherEvidence[] = [
    "documented",
    "documented-versioned",
    "observed",
    "source-derived",
  ];
  const uncertain = applicability !== "known-active" && applicability !== "known-inactive";
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(typeof sourceUrl === "string" ? sourceUrl : "invalid:");
  } catch {
    throw failure(
      DiscoveryIndexErrorCode.invalidOptions,
      "matcher fact is invalid",
      "validate-matcher-fact",
    );
  }
  if (
    typeof applicability !== "string" ||
    !applicabilityValues.includes(applicability as DiscoveryMatcherApplicability) ||
    (candidateKind !== "configuration" &&
      candidateKind !== "evidence" &&
      candidateKind !== "instruction") ||
    (clientVersion !== null &&
      (typeof clientVersion !== "string" ||
        clientVersion.length === 0 ||
        clientVersion.length > 128 ||
        unsafeText(clientVersion))) ||
    typeof evidence !== "string" ||
    !evidenceValues.includes(evidence as DiscoveryMatcherEvidence) ||
    !validId(factId) ||
    (formatId !== null && !validId(formatId)) ||
    (candidateKind !== "instruction" && formatId !== null) ||
    (profileId !== null && !validId(profileId)) ||
    !validId(recognizerId) ||
    (uncertain
      ? typeof reason !== "string" ||
        reason.length === 0 ||
        reason.length > 1_024 ||
        unsafeText(reason)
      : reason !== null) ||
    !validDate(retrievedAt) ||
    typeof sourceUrl !== "string" ||
    sourceUrl.length > 2_048 ||
    parsedUrl.protocol !== "https:" ||
    parsedUrl.username !== "" ||
    parsedUrl.password !== ""
  ) {
    throw failure(
      DiscoveryIndexErrorCode.invalidOptions,
      "matcher fact is invalid",
      "validate-matcher-fact",
    );
  }
  return Object.freeze({
    applicability: applicability as DiscoveryMatcherApplicability,
    candidateKind,
    clientVersion: clientVersion,
    evidence: evidence as DiscoveryMatcherEvidence,
    factId,
    formatId: formatId,
    matcher: snapshotMatcher(fields.get("matcher"), "validate-matcher-fact"),
    profileId: profileId,
    reason: reason as string | null,
    recognizerId,
    retrievedAt,
    sourceUrl: parsedUrl.href,
  });
}

function snapshotOptions(value: unknown): OptionsSnapshot {
  const fields =
    value === undefined
      ? new Map<string, unknown>()
      : plainValues(value, OPTION_KEYS, DiscoveryIndexErrorCode.invalidOptions, "validate-options");
  const limits: Record<string, number> = {};
  for (const [key, hard] of Object.entries(DISCOVERY_INDEX_HARD_LIMITS)) {
    const supplied = fields.get(key);
    const selected =
      supplied === undefined
        ? DISCOVERY_INDEX_DEFAULT_LIMITS[key as keyof DiscoveryIndexLimits]
        : supplied;
    if (
      !Number.isSafeInteger(selected) ||
      (selected as number) <= 0 ||
      (selected as number) > hard
    ) {
      throw failure(
        DiscoveryIndexErrorCode.invalidOptions,
        "discovery limit is invalid",
        "validate-options",
      );
    }
    limits[key] = selected as number;
  }
  const frozenLimits = Object.freeze(limits) as unknown as Readonly<DiscoveryIndexLimits>;
  const facts = denseArray(
    fields.get("matcherFacts") ?? [],
    frozenLimits.maximumMatcherFacts,
    DiscoveryIndexErrorCode.invalidOptions,
    "validate-options",
  ).map(snapshotFact);
  const factIds = new Set<string>();
  const recognizerIds = new Set(BUILT_IN_DISCOVERY_RECOGNIZER_IDS);
  for (const fact of facts) {
    if (factIds.has(fact.factId) || recognizerIds.has(fact.recognizerId)) {
      throw failure(
        DiscoveryIndexErrorCode.invalidOptions,
        "matcher fact identity is duplicated",
        "validate-options",
      );
    }
    factIds.add(fact.factId);
    recognizerIds.add(fact.recognizerId);
  }
  const signal = fields.get("signal");
  if (signal !== undefined && (nodeTypes.isProxy(signal) || !(signal instanceof AbortSignal))) {
    throw failure(
      DiscoveryIndexErrorCode.invalidOptions,
      "abort signal is invalid",
      "validate-options",
    );
  }
  return Object.freeze({
    limits: frozenLimits,
    matcherFacts: Object.freeze(facts),
    ...(signal === undefined ? {} : { signal: signal }),
  });
}

function snapshotPath(
  value: unknown,
  limits: DiscoveryIndexLimits,
  operation: string,
): RepositoryRelativePath {
  if (
    !isCanonicalRepositoryPathForDiscovery(value, {
      maximumPathDepth: limits.maximumPathDepth,
      maximumPathLength: limits.maximumPathLength,
    })
  ) {
    throw failure(DiscoveryIndexErrorCode.malformedInput, "discovery path is unsafe", operation);
  }
  let canonical: RepositoryRelativePath;
  try {
    canonical = canonicalizeRepositoryRelativePath(value, "posix");
  } catch {
    throw failure(DiscoveryIndexErrorCode.malformedInput, "discovery path is invalid", operation);
  }
  if (canonical === "." || canonical !== value) {
    throw failure(DiscoveryIndexErrorCode.malformedInput, "discovery path is invalid", operation);
  }
  return canonical;
}

function sortedPaths(
  value: unknown,
  limits: DiscoveryIndexLimits,
  operation: string,
  budget: Budget,
): { readonly bytes: number; readonly paths: readonly RepositoryRelativePath[] } {
  const values = denseArray(
    value,
    limits.maximumPaths,
    DiscoveryIndexErrorCode.invalidInput,
    operation,
  );
  const paths: RepositoryRelativePath[] = [];
  let bytes = 0;
  let previous: RepositoryRelativePath | undefined;
  for (const item of values) {
    budget.consume();
    const pathValue = snapshotPath(item, limits, operation);
    budget.consume(pathValue.length);
    if (previous !== undefined && previous >= pathValue) {
      throw failure(
        DiscoveryIndexErrorCode.invalidInput,
        "discovery paths are not sorted and unique",
        operation,
      );
    }
    const pathBytes = Buffer.byteLength(pathValue, "utf8");
    if (bytes > limits.maximumTotalPathBytes - pathBytes) {
      throw failure(
        DiscoveryIndexErrorCode.limitExceeded,
        "discovery path byte limit was exceeded",
        operation,
      );
    }
    bytes += pathBytes;
    paths.push(pathValue);
    previous = pathValue;
  }
  return Object.freeze({ bytes, paths: Object.freeze(paths) });
}

function snapshotEnumeration(
  value: unknown,
  limits: DiscoveryIndexLimits,
  budget: Budget,
): EnumerationSnapshot {
  const fields = plainValues(
    value,
    [
      "certainty",
      "indexObjectFormat",
      "indexVersion",
      "limits",
      "omittedProblems",
      "paths",
      "problems",
      "reason",
      "source",
    ],
    DiscoveryIndexErrorCode.invalidInput,
    "validate-enumeration",
  );
  const certainty = fields.get("certainty");
  const reason = fields.get("reason");
  const source = fields.get("source");
  const omittedProblems = fields.get("omittedProblems");
  const expectedFields = source === "git-index" ? 9 : 7;
  const fallbackReasons = [
    "git-directory-missing",
    "git-index-malformed",
    "git-index-missing",
    "git-index-unsupported",
    "git-metadata-unsafe",
    "git-worktree-external-metadata",
  ];
  if (
    fields.size !== expectedFields ||
    !fields.has("limits") ||
    (certainty !== "tracked" && certainty !== "all-files-not-tracked") ||
    typeof reason !== "string" ||
    reason.length === 0 ||
    reason.length > 128 ||
    unsafeText(reason) ||
    (source !== "git-index" && source !== "filesystem-fallback") ||
    (source === "git-index" && (certainty !== "tracked" || reason !== "verified-git-index")) ||
    (source === "git-index" &&
      ((fields.get("indexObjectFormat") !== "sha1" &&
        fields.get("indexObjectFormat") !== "sha256") ||
        (fields.get("indexVersion") !== 2 &&
          fields.get("indexVersion") !== 3 &&
          fields.get("indexVersion") !== 4))) ||
    (source === "filesystem-fallback" &&
      (certainty !== "all-files-not-tracked" || !fallbackReasons.includes(reason))) ||
    !Number.isSafeInteger(omittedProblems) ||
    (omittedProblems as number) < 0
  ) {
    throw failure(
      DiscoveryIndexErrorCode.invalidInput,
      "enumeration provenance is incoherent",
      "validate-enumeration",
    );
  }
  denseArray(
    fields.get("problems"),
    limits.maximumUpstreamFacts,
    DiscoveryIndexErrorCode.invalidInput,
    "validate-enumeration",
  );
  const snapshot = sortedPaths(fields.get("paths"), limits, "validate-enumeration", budget);
  return Object.freeze({
    certainty,
    paths: snapshot.paths,
    reason,
    source,
    totalPathBytes: snapshot.bytes,
  });
}

function snapshotStringIds(value: unknown, maximum: number, operation: string): readonly string[] {
  const values = denseArray(value, maximum, DiscoveryIndexErrorCode.invalidInput, operation);
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of values) {
    if (!validId(item) || seen.has(item)) {
      throw failure(
        DiscoveryIndexErrorCode.invalidInput,
        "provenance identifiers are invalid",
        operation,
      );
    }
    seen.add(item);
    result.push(item);
  }
  return Object.freeze(result);
}

function snapshotIgnoredPaths(
  value: unknown,
  limits: DiscoveryIndexLimits,
  fallback: boolean,
  budget: Budget,
): readonly RepositoryRelativePath[] {
  const values = denseArray(
    value,
    limits.maximumPaths,
    DiscoveryIndexErrorCode.invalidInput,
    "validate-ignore",
  );
  const paths: RepositoryRelativePath[] = [];
  let previous: RepositoryRelativePath | undefined;
  for (const item of values) {
    budget.consume();
    const fields = plainValues(
      item,
      ["certainty", "path", "ruleId"],
      DiscoveryIndexErrorCode.invalidInput,
      "validate-ignore",
    );
    const certainty = fields.get("certainty");
    const ruleId = fields.get("ruleId");
    const pathValue = snapshotPath(fields.get("path"), limits, "validate-ignore");
    budget.consume(pathValue.length);
    if (
      fields.size !== 3 ||
      (fallback
        ? certainty !== "known" && certainty !== "tracking-uncertain"
        : certainty !== "known") ||
      typeof ruleId !== "string" ||
      ruleId.length === 0 ||
      ruleId.length > limits.maximumPathLength + 256 ||
      unsafeText(ruleId) ||
      (previous !== undefined && previous >= pathValue)
    ) {
      throw failure(
        DiscoveryIndexErrorCode.invalidInput,
        "ignore decisions are invalid",
        "validate-ignore",
      );
    }
    paths.push(pathValue);
    previous = pathValue;
  }
  return Object.freeze(paths);
}

function snapshotIgnore(
  value: unknown,
  limits: DiscoveryIndexLimits,
  enumeration: EnumerationSnapshot,
  budget: Budget,
): IgnoreSnapshot {
  const fields = plainValues(
    value,
    [
      "appliedProfileFactIds",
      "certainty",
      "deferredProfileFacts",
      "ignored",
      "limits",
      "omittedProblems",
      "paths",
      "problems",
      "profileCertainty",
      "profileFacts",
      "rules",
      "trackingCertainty",
    ],
    DiscoveryIndexErrorCode.invalidInput,
    "validate-ignore",
  );
  const fallback = enumeration.source === "filesystem-fallback";
  const certainty = fields.get("certainty");
  const profileCertainty = fields.get("profileCertainty");
  const trackingCertainty = fields.get("trackingCertainty");
  const omittedProblems = fields.get("omittedProblems");
  if (
    fields.size !== 12 ||
    certainty !== (fallback ? "fallback-tracking-uncertain" : "exact-tracked-input") ||
    trackingCertainty !== (fallback ? "fallback-mixed-unknown" : "tracked") ||
    (profileCertainty !== "known" && profileCertainty !== "uncertain-facts-deferred") ||
    !Number.isSafeInteger(omittedProblems) ||
    (omittedProblems as number) < 0
  ) {
    throw failure(
      DiscoveryIndexErrorCode.invalidInput,
      "ignore provenance is incoherent",
      "validate-ignore",
    );
  }
  const retained = sortedPaths(fields.get("paths"), limits, "validate-ignore", budget).paths;
  const ignored = snapshotIgnoredPaths(fields.get("ignored"), limits, fallback, budget);
  const applied = snapshotStringIds(
    fields.get("appliedProfileFactIds"),
    limits.maximumUpstreamFacts,
    "validate-ignore",
  );
  const deferred = denseArray(
    fields.get("deferredProfileFacts"),
    limits.maximumUpstreamFacts,
    DiscoveryIndexErrorCode.invalidInput,
    "validate-ignore",
  );
  const profileFacts = denseArray(
    fields.get("profileFacts"),
    limits.maximumUpstreamFacts,
    DiscoveryIndexErrorCode.invalidInput,
    "validate-ignore",
  );
  denseArray(
    fields.get("rules"),
    limits.maximumUpstreamFacts,
    DiscoveryIndexErrorCode.invalidInput,
    "validate-ignore",
  );
  denseArray(
    fields.get("problems"),
    limits.maximumUpstreamFacts,
    DiscoveryIndexErrorCode.invalidInput,
    "validate-ignore",
  );
  if (profileFacts.length < applied.length + deferred.length) {
    throw failure(
      DiscoveryIndexErrorCode.invalidInput,
      "ignore profile provenance is incomplete",
      "validate-ignore",
    );
  }
  if ((deferred.length === 0) !== (profileCertainty === "known")) {
    throw failure(
      DiscoveryIndexErrorCode.invalidInput,
      "ignore profile certainty is incoherent",
      "validate-ignore",
    );
  }
  let retainedIndex = 0;
  let ignoredIndex = 0;
  for (const expected of enumeration.paths) {
    budget.consume();
    const retainedPath = retained[retainedIndex];
    const ignoredPath = ignored[ignoredIndex];
    if (retainedPath === expected) retainedIndex += 1;
    else if (ignoredPath === expected) ignoredIndex += 1;
    else
      throw failure(
        DiscoveryIndexErrorCode.invalidInput,
        "ignore result does not partition enumeration",
        "validate-ignore",
      );
  }
  if (retainedIndex !== retained.length || ignoredIndex !== ignored.length) {
    throw failure(
      DiscoveryIndexErrorCode.invalidInput,
      "ignore result contains an unknown path",
      "validate-ignore",
    );
  }
  return Object.freeze({
    appliedProfileFactIds: applied,
    certainty: certainty as IgnoreSnapshot["certainty"],
    deferredProfileFactCount: deferred.length,
    ignoredPaths: ignored,
    paths: retained,
    profileCertainty: profileCertainty,
    trackingCertainty: trackingCertainty as IgnoreSnapshot["trackingCertainty"],
  });
}

function matcherMatches(matcher: DiscoveryPathMatcher, pathValue: RepositoryRelativePath): boolean {
  return matchesBuiltInDiscoveryPathMatcher(matcher, pathValue);
}

function recognition(value: Recognizer): DiscoveryRecognition {
  return Object.freeze({
    factId: value.factId,
    formatId: value.formatId,
    kind: value.kind,
    origin: value.origin,
    profileId: value.profileId,
    recognizerId: value.id,
    source: value.source,
  });
}

function recognizerFromFact(fact: DiscoveryMatcherFact): Recognizer {
  return Object.freeze({
    factId: fact.factId,
    formatId: fact.formatId,
    id: fact.recognizerId,
    kind: fact.candidateKind,
    matcher: fact.matcher,
    origin: "matcher-fact",
    profileId: fact.profileId,
    source: Object.freeze({
      artifactPath: null,
      id: fact.factId,
      retrievedAt: fact.retrievedAt,
      url: fact.sourceUrl,
    }),
  });
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function uncertaintyReasons(
  enumeration: EnumerationSnapshot,
  ignore: IgnoreSnapshot,
  deferredFacts: readonly DiscoveryMatcherFact[],
): readonly DiscoveryUncertaintyReason[] {
  const reasons: DiscoveryUncertaintyReason[] = [];
  if (ignore.profileCertainty === "uncertain-facts-deferred")
    reasons.push("deferred-ignore-profile-facts");
  if (deferredFacts.length > 0) reasons.push("deferred-matcher-facts");
  if (enumeration.certainty === "all-files-not-tracked") reasons.push("fallback-tracking");
  return Object.freeze(reasons.sort());
}

/** Build a path-only index with the production monotonic clock. */
export function buildTargetedDiscoveryIndex(
  enumeration: TrackedFileEnumerationResult,
  ignore: IgnoreEngineResult,
  options?: DiscoveryIndexOptions,
): TargetedDiscoveryIndex {
  return buildTargetedDiscoveryIndexWithClock(enumeration, ignore, options, DEFAULT_CLOCK);
}

/** Trusted clock-injected form for deterministic cancellation/deadline tests. */
export function buildTargetedDiscoveryIndexWithClock(
  enumeration: TrackedFileEnumerationResult,
  ignore: IgnoreEngineResult,
  options: DiscoveryIndexOptions | undefined,
  clock: DiscoveryIndexClock,
): TargetedDiscoveryIndex {
  const snapshot = snapshotOptions(options);
  const budget = new Budget(snapshot.limits, snapshot.signal, clock);
  const enumerationSnapshot = snapshotEnumeration(enumeration, snapshot.limits, budget);
  const ignoreSnapshot = snapshotIgnore(ignore, snapshot.limits, enumerationSnapshot, budget);
  const activeFacts = snapshot.matcherFacts.filter((fact) => fact.applicability === "known-active");
  const deferredFacts = snapshot.matcherFacts.filter(
    (fact) => fact.applicability !== "known-active" && fact.applicability !== "known-inactive",
  );
  const recognizers = Object.freeze([...BUILT_INS, ...activeFacts.map(recognizerFromFact)]);
  const reasons = uncertaintyReasons(enumerationSnapshot, ignoreSnapshot, deferredFacts);
  const candidates: DiscoveryCandidate[] = [];
  let configurationCount = 0;
  let evidenceCount = 0;
  let instructionCount = 0;
  for (const pathValue of ignoreSnapshot.paths) {
    budget.consume(pathValue.length + 1);
    const matches: DiscoveryRecognition[] = [];
    const kinds = new Set<DiscoveryCandidateKind>();
    for (const known of recognizers) {
      budget.consume(known.id.length + 1);
      if (!matcherMatches(known.matcher, pathValue)) continue;
      if (matches.length >= snapshot.limits.maximumRecognizersPerCandidate) {
        throw failure(
          DiscoveryIndexErrorCode.limitExceeded,
          "candidate recognizer limit was exceeded",
          "recognize-path",
          pathValue,
        );
      }
      matches.push(recognition(known));
      kinds.add(known.kind);
    }
    if (matches.length === 0) continue;
    if (candidates.length >= snapshot.limits.maximumCandidates) {
      throw failure(
        DiscoveryIndexErrorCode.limitExceeded,
        "discovery candidate limit was exceeded",
        "candidate-limit",
        pathValue,
      );
    }
    matches.sort((left, right) => compareText(left.recognizerId, right.recognizerId));
    const sortedKinds = [...kinds].sort();
    if (kinds.has("configuration")) configurationCount += 1;
    if (kinds.has("evidence")) evidenceCount += 1;
    if (kinds.has("instruction")) instructionCount += 1;
    candidates.push(
      Object.freeze({
        kinds: Object.freeze(sortedKinds),
        path: pathValue,
        recognitions: Object.freeze(matches),
        uncertainty: reasons,
      }),
    );
  }
  budget.check();
  const catalogSources = Object.freeze(
    [...new Map(BUILT_INS.map((item) => [item.source.id, item.source] as const)).values()].sort(
      (left, right) => compareText(left.id, right.id),
    ),
  );
  const appliedMatcherFactIds = Object.freeze(activeFacts.map((fact) => fact.factId));
  const metrics: DiscoveryIndexMetrics = Object.freeze({
    candidateCount: candidates.length,
    configurationCandidateCount: configurationCount,
    contentReads: 0,
    enumeratedPathCount: enumerationSnapshot.paths.length,
    evidenceCandidateCount: evidenceCount,
    ignoredPathCount: ignoreSnapshot.ignoredPaths.length,
    inspectedPathCount: ignoreSnapshot.paths.length,
    instructionCandidateCount: instructionCount,
    matcherWork: budget.work,
    retainedPathCount: ignoreSnapshot.paths.length,
    totalPathBytes: enumerationSnapshot.totalPathBytes,
  });
  const provenance: DiscoveryIndexProvenance = Object.freeze({
    appliedIgnoreProfileFactIds: ignoreSnapshot.appliedProfileFactIds,
    appliedMatcherFactIds,
    catalogSources,
    deferredIgnoreProfileFactCount: ignoreSnapshot.deferredProfileFactCount,
    deferredMatcherFacts: Object.freeze(deferredFacts),
    enumerationCertainty: enumerationSnapshot.certainty,
    enumerationReason: enumerationSnapshot.reason,
    enumerationSource: enumerationSnapshot.source,
    ignoreCertainty: ignoreSnapshot.certainty,
    ignoreProfileCertainty: ignoreSnapshot.profileCertainty,
    trackingCertainty: ignoreSnapshot.trackingCertainty,
  });
  const result = Object.freeze({
    candidates: Object.freeze(candidates),
    contractVersion: DISCOVERY_INDEX_CONTRACT_VERSION,
    limits: snapshot.limits,
    matcherFacts: snapshot.matcherFacts,
    metrics,
    provenance,
    uncertainty: reasons.length === 0 ? "known" : "uncertain",
    uncertaintyReasons: reasons,
  });
  ISSUED_TARGETED_DISCOVERY_INDEXES.add(result);
  return result;
}
