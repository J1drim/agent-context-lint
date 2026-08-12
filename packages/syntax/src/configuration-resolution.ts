import { constants } from "node:fs";
import type { BigIntStats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { types as nodeTypes } from "node:util";

import type {
  AgentContextConfiguration,
  ConfigurationSourceLocation,
  ConfigurationValidationCode,
  ConfigurationValidationIssue,
  RepositoryRelativePath,
} from "@agent-context/core";
import {
  CONFIGURATION_FILE_NAME,
  CONFIGURATION_PROFILE_IDS,
  CONFIGURATION_PROFILE_KEY_BY_ID,
  CONFIGURATION_SOURCE_LIMITS,
  CONFIGURATION_VALUE_LIMITS,
  DEFAULT_AGENT_CONTEXT_CONFIGURATION,
  appendConfigurationPathProperty,
  validateAgentContextConfiguration,
} from "@agent-context/core";

import { parseAgentContextConfiguration } from "./configuration-parser.js";

const CONFIGURATION_PATH = CONFIGURATION_FILE_NAME as RepositoryRelativePath;
const ROOT_PATH = "$";
const MAXIMUM_JSON_DEPTH = 256;

export type ConfigurationLayerKind = "defaults" | "repository" | "cli";

export interface ConfigurationResolutionSource {
  readonly kind: ConfigurationLayerKind;
  readonly path: RepositoryRelativePath | null;
}

export type ConfigurationResolutionIssueCode =
  | ConfigurationValidationCode
  | "configuration-changed"
  | "configuration-file-type"
  | "configuration-read"
  | "configuration-symlink"
  | "invalid-cli-overrides"
  | "invalid-options"
  | "invalid-repository-root"
  | "repository-root-changed"
  | "repository-root-unavailable";

export interface ConfigurationResolutionIssue {
  readonly code: ConfigurationResolutionIssueCode;
  readonly configurationPath: RepositoryRelativePath | null;
  readonly location: ConfigurationSourceLocation | null;
  readonly message: string;
  readonly path: string;
  readonly source: "repository" | "cli";
}

export interface ResolveAgentContextConfigurationOptions {
  /** Sparse JSON-shaped settings supplied by the command line. `version` is not a CLI setting. */
  readonly cliOverrides?: unknown;
}

export type ConfigurationResolutionResult =
  | {
      readonly issues: readonly [];
      readonly ok: true;
      readonly sources: readonly ConfigurationResolutionSource[];
      readonly value: AgentContextConfiguration;
    }
  | {
      readonly issues: readonly ConfigurationResolutionIssue[];
      readonly ok: false;
      readonly sources: readonly ConfigurationResolutionSource[];
      readonly value?: never;
    };

export type ConfigurationResolutionSuccess = Extract<ConfigurationResolutionResult, { ok: true }>;

const ISSUED_CONFIGURATION_RESOLUTION_SUCCESSES = new WeakSet<object>();
const CONFIGURATION_REPOSITORY_IDENTITIES = new WeakMap<
  object,
  Readonly<{ readonly canonicalRoot: string; readonly device: string; readonly inode: string }>
>();

/** True only for a successful B06 resolution issued by this module instance. */
export function isIssuedConfigurationResolutionSuccess(
  value: unknown,
): value is ConfigurationResolutionSuccess {
  return (
    typeof value === "object" &&
    value !== null &&
    ISSUED_CONFIGURATION_RESOLUTION_SUCCESSES.has(value)
  );
}

/** Match an issued B06/B07 success to an independently issued C01 root identity. */
export function doesIssuedConfigurationResolutionMatchRepository(
  value: unknown,
  canonicalRoot: string,
  device: string,
  inode: string,
): value is ConfigurationResolutionSuccess {
  const identity =
    typeof value === "object" && value !== null
      ? CONFIGURATION_REPOSITORY_IDENTITIES.get(value)
      : undefined;
  if (!isIssuedConfigurationResolutionSuccess(value) || identity === undefined) return false;
  return (
    identity.canonicalRoot === canonicalRoot &&
    identity.device === device &&
    identity.inode === inode
  );
}

interface JsonBudget {
  totalStringBytes: number;
  values: number;
}

interface CliSnapshotResult {
  readonly issue?: ConfigurationResolutionIssue;
  readonly supplied: boolean;
  readonly value?: Record<string, unknown>;
}

interface RepositoryReadResult {
  readonly absent?: true;
  readonly issue?: ConfigurationResolutionIssue;
  readonly rootIdentity?: Readonly<{
    readonly canonicalRoot: string;
    readonly device: string;
    readonly inode: string;
  }>;
  readonly source?: string;
}

function source(kind: ConfigurationLayerKind): ConfigurationResolutionSource {
  return Object.freeze({ kind, path: kind === "repository" ? CONFIGURATION_PATH : null });
}

const DEFAULT_SOURCE = source("defaults");
const REPOSITORY_SOURCE = source("repository");
const CLI_SOURCE = source("cli");
const NO_ISSUES: readonly [] = Object.freeze([]);

function freezeIssue(issue: ConfigurationResolutionIssue): ConfigurationResolutionIssue {
  return Object.freeze(issue);
}

function failure(
  sources: readonly ConfigurationResolutionSource[],
  issues: readonly ConfigurationResolutionIssue[],
): ConfigurationResolutionResult {
  return Object.freeze({
    issues: Object.freeze(issues.map((issue) => freezeIssue(issue))),
    ok: false as const,
    sources: Object.freeze([...sources]),
  });
}

function success(
  sources: readonly ConfigurationResolutionSource[],
  value: AgentContextConfiguration,
  rootIdentity: NonNullable<RepositoryReadResult["rootIdentity"]>,
): ConfigurationResolutionResult {
  const result = Object.freeze({
    issues: NO_ISSUES,
    ok: true as const,
    sources: Object.freeze([...sources]),
    value,
  });
  ISSUED_CONFIGURATION_RESOLUTION_SUCCESSES.add(result);
  CONFIGURATION_REPOSITORY_IDENTITIES.set(result, rootIdentity);
  return result;
}

function operationalIssue(
  code: ConfigurationResolutionIssueCode,
  sourceKind: "repository" | "cli",
  message: string,
  diagnosticPath = ROOT_PATH,
): ConfigurationResolutionIssue {
  return {
    code,
    configurationPath: sourceKind === "repository" ? CONFIGURATION_PATH : null,
    location: null,
    message,
    path: diagnosticPath,
    source: sourceKind,
  };
}

function validationIssue(
  issue: ConfigurationValidationIssue,
  sourceKind: "repository" | "cli",
): ConfigurationResolutionIssue {
  return {
    code: issue.code,
    configurationPath: sourceKind === "repository" ? CONFIGURATION_PATH : null,
    location: issue.location,
    message: issue.message,
    path: issue.path,
    source: sourceKind,
  };
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
}

function hasWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function inspectString(
  value: string,
  maximumBytes: number,
  budget: JsonBudget,
): "invalid" | "limit" | undefined {
  if (!hasWellFormedUnicode(value)) return "invalid";
  if (value.length > maximumBytes) return "limit";
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > maximumBytes) return "limit";
  budget.totalStringBytes += bytes;
  return budget.totalStringBytes > CONFIGURATION_VALUE_LIMITS.maximumTotalStringBytes
    ? "limit"
    : undefined;
}

function snapshotJson(
  value: unknown,
  diagnosticPath: string,
  depth: number,
  ancestors: WeakSet<object>,
  budget: JsonBudget,
): { readonly issue?: ConfigurationResolutionIssue; readonly value?: unknown } {
  budget.values += 1;
  if (budget.values > CONFIGURATION_VALUE_LIMITS.maximumValues) {
    return {
      issue: operationalIssue(
        "invalid-cli-overrides",
        "cli",
        `CLI overrides must not contain more than ${String(CONFIGURATION_VALUE_LIMITS.maximumValues)} JSON values`,
        diagnosticPath,
      ),
    };
  }
  if (value === null || typeof value === "boolean") return { value };
  if (typeof value === "string") {
    const problem = inspectString(value, CONFIGURATION_VALUE_LIMITS.maximumStringBytes, budget);
    return problem === undefined
      ? { value }
      : {
          issue: operationalIssue(
            "invalid-cli-overrides",
            "cli",
            problem === "invalid"
              ? "CLI override strings must be well-formed Unicode"
              : "CLI override strings exceed the configured JSON resource limits",
            diagnosticPath,
          ),
        };
  }
  if (typeof value === "number") {
    return Number.isFinite(value) && !Object.is(value, -0)
      ? { value }
      : {
          issue: operationalIssue(
            "invalid-cli-overrides",
            "cli",
            "CLI overrides must contain finite JSON numbers other than negative zero",
            diagnosticPath,
          ),
        };
  }
  if (typeof value !== "object") {
    return {
      issue: operationalIssue(
        "invalid-cli-overrides",
        "cli",
        "CLI overrides must contain only JSON values",
        diagnosticPath,
      ),
    };
  }
  if (nodeTypes.isProxy(value)) {
    return {
      issue: operationalIssue(
        "invalid-cli-overrides",
        "cli",
        "CLI overrides must not contain proxies",
        diagnosticPath,
      ),
    };
  }
  if (depth >= MAXIMUM_JSON_DEPTH) {
    return {
      issue: operationalIssue(
        "invalid-cli-overrides",
        "cli",
        `CLI overrides must not exceed ${String(MAXIMUM_JSON_DEPTH)} nested containers`,
        diagnosticPath,
      ),
    };
  }
  if (ancestors.has(value)) {
    return {
      issue: operationalIssue(
        "invalid-cli-overrides",
        "cli",
        "CLI overrides must not contain reference cycles",
        diagnosticPath,
      ),
    };
  }

  try {
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (
      (array && prototype !== Array.prototype) ||
      (!array && prototype !== Object.prototype && prototype !== null)
    ) {
      return {
        issue: operationalIssue(
          "invalid-cli-overrides",
          "cli",
          "CLI overrides must contain only plain JSON objects and arrays",
          diagnosticPath,
        ),
      };
    }
    const keys = Reflect.ownKeys(value);
    const dataKeys = array ? keys.filter((key) => key !== "length") : keys;
    const expectedEntries = array
      ? (Object.getOwnPropertyDescriptor(value, "length")?.value as unknown)
      : dataKeys.length;
    if (
      typeof expectedEntries !== "number" ||
      !Number.isSafeInteger(expectedEntries) ||
      expectedEntries < 0 ||
      expectedEntries > CONFIGURATION_VALUE_LIMITS.maximumContainerEntries ||
      dataKeys.length !== expectedEntries
    ) {
      return {
        issue: operationalIssue(
          "invalid-cli-overrides",
          "cli",
          "CLI override containers are sparse or exceed the configured JSON resource limits",
          diagnosticPath,
        ),
      };
    }
    const output: unknown[] | Record<string, unknown> = array ? [] : {};
    ancestors.add(value);
    for (let index = 0; index < dataKeys.length; index += 1) {
      const key = dataKeys[index];
      if (typeof key !== "string") {
        return {
          issue: operationalIssue(
            "invalid-cli-overrides",
            "cli",
            "CLI overrides must not contain symbol keys",
            diagnosticPath,
          ),
        };
      }
      const keyProblem = inspectString(key, CONFIGURATION_VALUE_LIMITS.maximumKeyBytes, budget);
      if (keyProblem !== undefined) {
        return {
          issue: operationalIssue(
            "invalid-cli-overrides",
            "cli",
            "CLI override keys exceed the configured JSON resource limits or contain malformed Unicode",
            diagnosticPath,
          ),
        };
      }
      if (array && key !== String(index)) {
        return {
          issue: operationalIssue(
            "invalid-cli-overrides",
            "cli",
            "CLI override arrays must be dense and use canonical indices",
            diagnosticPath,
          ),
        };
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      const childPath = array
        ? `${diagnosticPath}[${key}]`
        : appendConfigurationPathProperty(diagnosticPath, key);
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
        return {
          issue: operationalIssue(
            "invalid-cli-overrides",
            "cli",
            "CLI overrides must not contain accessors or non-enumerable data",
            childPath,
          ),
        };
      }
      const child = snapshotJson(descriptor.value, childPath, depth + 1, ancestors, budget);
      if (child.issue !== undefined) return { issue: child.issue };
      if (array) (output as unknown[]).push(child.value);
      else {
        Object.defineProperty(output, key, {
          configurable: true,
          enumerable: true,
          value: child.value,
          writable: true,
        });
      }
    }
    return { value: output };
  } catch {
    return {
      issue: operationalIssue(
        "invalid-cli-overrides",
        "cli",
        "CLI overrides must be safely inspectable JSON data",
        diagnosticPath,
      ),
    };
  } finally {
    ancestors.delete(value);
  }
}

function snapshotCliOptions(options: unknown): CliSnapshotResult {
  if (options === undefined) return { supplied: false };
  if (options === null || typeof options !== "object" || nodeTypes.isProxy(options)) {
    return {
      issue: operationalIssue(
        "invalid-options",
        "cli",
        "resolution options must be a plain object",
      ),
      supplied: false,
    };
  }
  try {
    const prototype = Object.getPrototypeOf(options) as object | null;
    const keys = Reflect.ownKeys(options);
    if (prototype !== Object.prototype && prototype !== null) {
      return {
        issue: operationalIssue(
          "invalid-options",
          "cli",
          "resolution options must be a plain object",
        ),
        supplied: false,
      };
    }
    if (keys.some((key) => key !== "cliOverrides")) {
      return {
        issue: operationalIssue(
          "invalid-options",
          "cli",
          "resolution options contain an unknown or symbol field",
        ),
        supplied: false,
      };
    }
    if (!keys.includes("cliOverrides")) return { supplied: false };
    const descriptor = Object.getOwnPropertyDescriptor(options, "cliOverrides");
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      return {
        issue: operationalIssue(
          "invalid-options",
          "cli",
          "cliOverrides must be an enumerable data property",
          "$.cliOverrides",
        ),
        supplied: false,
      };
    }
    const snapshot = snapshotJson(descriptor.value, ROOT_PATH, 0, new WeakSet<object>(), {
      totalStringBytes: 0,
      values: 0,
    });
    if (snapshot.issue !== undefined) return { issue: snapshot.issue, supplied: true };
    if (
      snapshot.value === null ||
      typeof snapshot.value !== "object" ||
      Array.isArray(snapshot.value)
    ) {
      return {
        issue: operationalIssue(
          "invalid-cli-overrides",
          "cli",
          "CLI overrides must be a JSON object",
        ),
        supplied: true,
      };
    }
    const value = snapshot.value as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(value, "version")) {
      return {
        issue: operationalIssue(
          "invalid-cli-overrides",
          "cli",
          "version belongs to the repository configuration schema and cannot be overridden by CLI arguments",
          "$.version",
        ),
        supplied: true,
      };
    }
    return { supplied: true, value };
  } catch {
    return {
      issue: operationalIssue(
        "invalid-options",
        "cli",
        "resolution options must be safely inspectable",
      ),
      supplied: false,
    };
  }
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return (
    sameFile(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

async function readConfigurationAtCanonicalRoot(
  canonicalRoot: string,
): Promise<RepositoryReadResult> {
  const configurationFile = path.join(canonicalRoot, CONFIGURATION_FILE_NAME);
  const relative = path.relative(canonicalRoot, configurationFile);
  if (relative !== CONFIGURATION_FILE_NAME || path.isAbsolute(relative)) {
    return {
      issue: operationalIssue(
        "invalid-repository-root",
        "repository",
        "configuration path does not remain inside the repository root",
      ),
    };
  }

  let initial: BigIntStats;
  try {
    initial = await lstat(configurationFile, { bigint: true });
  } catch (error: unknown) {
    return errorCode(error) === "ENOENT"
      ? { absent: true }
      : {
          issue: operationalIssue(
            "configuration-read",
            "repository",
            "repository configuration cannot be inspected",
          ),
        };
  }
  if (initial.isSymbolicLink()) {
    return {
      issue: operationalIssue(
        "configuration-symlink",
        "repository",
        "repository configuration must not be a symbolic link",
      ),
    };
  }
  if (!initial.isFile()) {
    return {
      issue: operationalIssue(
        "configuration-file-type",
        "repository",
        "repository configuration must be a regular file",
      ),
    };
  }
  if (initial.size > BigInt(CONFIGURATION_SOURCE_LIMITS.maximumBytes)) {
    return {
      issue: operationalIssue(
        "resource-limit",
        "repository",
        `repository configuration must not exceed ${String(CONFIGURATION_SOURCE_LIMITS.maximumBytes)} bytes`,
      ),
    };
  }

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const flags =
      process.platform === "win32" ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW;
    handle = await open(configurationFile, flags);
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile()) {
      return {
        issue: operationalIssue(
          "configuration-file-type",
          "repository",
          "repository configuration changed to a non-regular file before it was read",
        ),
      };
    }
    if (!sameFile(initial, opened)) {
      return {
        issue: operationalIssue(
          "configuration-changed",
          "repository",
          "repository configuration changed while it was being opened",
        ),
      };
    }
    const buffer = Buffer.alloc(CONFIGURATION_SOURCE_LIMITS.maximumBytes + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const next = await handle.read(buffer, bytesRead, buffer.length - bytesRead, null);
      if (next.bytesRead === 0) break;
      bytesRead += next.bytesRead;
    }
    if (bytesRead > CONFIGURATION_SOURCE_LIMITS.maximumBytes) {
      return {
        issue: operationalIssue(
          "resource-limit",
          "repository",
          `repository configuration must not exceed ${String(CONFIGURATION_SOURCE_LIMITS.maximumBytes)} bytes`,
        ),
      };
    }
    const afterRead = await handle.stat({ bigint: true });
    let finalPathStatus: BigIntStats;
    try {
      finalPathStatus = await lstat(configurationFile, { bigint: true });
    } catch {
      return {
        issue: operationalIssue(
          "configuration-changed",
          "repository",
          "repository configuration disappeared while it was being read",
        ),
      };
    }
    if (
      finalPathStatus.isSymbolicLink() ||
      !finalPathStatus.isFile() ||
      !sameSnapshot(initial, afterRead) ||
      !sameSnapshot(afterRead, finalPathStatus)
    ) {
      return {
        issue: operationalIssue(
          "configuration-changed",
          "repository",
          "repository configuration changed while it was being read",
        ),
      };
    }
    try {
      return {
        source: new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead)),
      };
    } catch {
      return {
        issue: operationalIssue(
          "invalid-value",
          "repository",
          "repository configuration must contain valid UTF-8",
        ),
      };
    }
  } catch (error: unknown) {
    return {
      issue: operationalIssue(
        errorCode(error) === "ELOOP" ? "configuration-symlink" : "configuration-read",
        "repository",
        errorCode(error) === "ELOOP"
          ? "repository configuration must not be a symbolic link"
          : "repository configuration cannot be read",
      ),
    };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function repositoryRootMatches(
  repositoryRoot: string,
  canonicalRoot: string,
  expected: BigIntStats,
): Promise<boolean> {
  try {
    const current = await lstat(repositoryRoot, { bigint: true });
    if (current.isSymbolicLink() || !current.isDirectory() || !sameFile(expected, current)) {
      return false;
    }
    const currentCanonicalRoot = await realpath(repositoryRoot);
    if (currentCanonicalRoot !== canonicalRoot) return false;
    const resolved = await lstat(currentCanonicalRoot, { bigint: true });
    return !resolved.isSymbolicLink() && resolved.isDirectory() && sameFile(expected, resolved);
  } catch {
    return false;
  }
}

function stripTrailingHostSeparators(absolutePath: string): string {
  const rootLength = path.parse(absolutePath).root.length;
  let end = absolutePath.length;
  while (end > rootLength) {
    const character = absolutePath[end - 1];
    if (character !== path.sep && !(process.platform === "win32" && character === "/")) break;
    end -= 1;
  }
  return absolutePath.slice(0, end);
}

async function readRepositoryConfiguration(repositoryRoot: string): Promise<RepositoryReadResult> {
  if (
    typeof repositoryRoot !== "string" ||
    repositoryRoot.includes("\0") ||
    !hasWellFormedUnicode(repositoryRoot)
  ) {
    return {
      issue: operationalIssue(
        "invalid-repository-root",
        "repository",
        "repository root must be well-formed Unicode without NUL bytes",
      ),
    };
  }
  if (!path.isAbsolute(repositoryRoot)) {
    return {
      issue: operationalIssue(
        "invalid-repository-root",
        "repository",
        "repository root must be an absolute path",
      ),
    };
  }
  const selectedRoot = stripTrailingHostSeparators(repositoryRoot);

  let initial: BigIntStats;
  let canonicalRoot: string;
  try {
    initial = await lstat(selectedRoot, { bigint: true });
    if (initial.isSymbolicLink() || !initial.isDirectory()) {
      return {
        issue: operationalIssue(
          "invalid-repository-root",
          "repository",
          "repository root must name a real directory, not a symlink or another file type",
        ),
      };
    }
    canonicalRoot = await realpath(selectedRoot);
    const resolved = await lstat(canonicalRoot, { bigint: true });
    if (resolved.isSymbolicLink() || !resolved.isDirectory() || !sameFile(initial, resolved)) {
      return {
        issue: operationalIssue(
          "repository-root-changed",
          "repository",
          "repository root changed while it was being resolved",
        ),
      };
    }
  } catch {
    return {
      issue: operationalIssue(
        "repository-root-unavailable",
        "repository",
        "repository root cannot be inspected",
      ),
    };
  }

  const outcome = await readConfigurationAtCanonicalRoot(canonicalRoot);
  if (!(await repositoryRootMatches(selectedRoot, canonicalRoot, initial))) {
    return {
      issue: operationalIssue(
        "repository-root-changed",
        "repository",
        "repository root changed while configuration was being resolved",
      ),
    };
  }
  return {
    ...outcome,
    rootIdentity: Object.freeze({
      canonicalRoot,
      device: String(initial.dev),
      inode: String(initial.ino),
    }),
  };
}

function toDecodedConfiguration(value: AgentContextConfiguration): Record<string, unknown> {
  return {
    commands: { ...value.commands },
    efficiency: {
      budgets: { ...value.efficiency.budgets },
      componentWeights: { ...value.efficiency.componentWeights },
      gradeThresholds: { ...value.efficiency.gradeThresholds },
      scoreVersion: value.efficiency.scoreVersion,
      tokenizer: value.efficiency.tokenizer,
    },
    ignore: [...value.ignore],
    limits: { ...value.limits },
    profiles: Object.fromEntries(
      CONFIGURATION_PROFILE_IDS.map((profileId) => [
        CONFIGURATION_PROFILE_KEY_BY_ID[profileId],
        {
          enabled: value.profiles[profileId].enabled,
          surfaces: { ...value.profiles[profileId].surfaces },
        },
      ]),
    ),
    rules: Object.fromEntries(
      Object.entries(value.rules).map(([ruleId, rule]) => [ruleId, { ...rule }]),
    ),
    security: { ...value.security },
    standards: { ...value.standards },
    version: value.version,
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function overlay(
  base: Record<string, unknown>,
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, override] of Object.entries(overrides)) {
    const current = result[key];
    const resolved =
      isPlainRecord(current) && isPlainRecord(override) ? overlay(current, override) : override;
    Object.defineProperty(result, key, {
      configurable: true,
      enumerable: true,
      value: resolved,
      writable: true,
    });
  }
  return result;
}

/**
 * Resolve the only supported v1 configuration stack.
 *
 * The function reads exactly `.agent-context-lint.yml` at the supplied root, never searches a
 * parent/home/global location, and applies sparse CLI settings over the repository value and B06
 * defaults. Every invalid layer rejects the complete resolution.
 */
export async function resolveAgentContextConfiguration(
  repositoryRoot: string,
  options?: ResolveAgentContextConfigurationOptions,
): Promise<ConfigurationResolutionResult> {
  const cli = snapshotCliOptions(options);
  if (cli.issue !== undefined) {
    return failure(cli.supplied ? [DEFAULT_SOURCE, CLI_SOURCE] : [DEFAULT_SOURCE], [cli.issue]);
  }

  const repository = await readRepositoryConfiguration(repositoryRoot);
  if (repository.issue !== undefined) return failure([DEFAULT_SOURCE], [repository.issue]);
  if (repository.rootIdentity === undefined)
    return failure(
      [DEFAULT_SOURCE],
      [
        operationalIssue(
          "repository-root-changed",
          "repository",
          "repository root identity is unavailable after configuration resolution",
        ),
      ],
    );

  const sources: ConfigurationResolutionSource[] = [DEFAULT_SOURCE];
  let base = DEFAULT_AGENT_CONTEXT_CONFIGURATION;
  if (repository.source !== undefined) {
    sources.push(REPOSITORY_SOURCE);
    const parsed = parseAgentContextConfiguration(repository.source, { path: CONFIGURATION_PATH });
    if (!parsed.ok) {
      return failure(
        sources,
        parsed.issues.map((issue) => validationIssue(issue, "repository")),
      );
    }
    base = parsed.value;
  }

  if (!cli.supplied || cli.value === undefined)
    return success(sources, base, repository.rootIdentity);
  sources.push(CLI_SOURCE);
  const merged = overlay(toDecodedConfiguration(base), cli.value);
  const validated = validateAgentContextConfiguration(merged);
  if (!validated.ok) {
    return failure(
      sources,
      validated.issues.map((issue) => validationIssue(issue, "cli")),
    );
  }
  return success(sources, validated.value, repository.rootIdentity);
}
