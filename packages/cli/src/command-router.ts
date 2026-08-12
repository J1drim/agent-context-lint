import path from "node:path";
import { types as nodeTypes } from "node:util";

import packageManifest from "../package.json" with { type: "json" };
import { isValidGitBaseReference } from "@agent-context/evidence";
import { RULE_REGISTRY } from "@agent-context/rules";

export const CLI_NAME = "agent-context-lint" as const;
export const CLI_VERSION: string = packageManifest.version;

export const CLI_EXIT_CODES: Readonly<{
  interrupted: 130;
  operationalFailure: 2;
  policyFailure: 1;
  success: 0;
}> = Object.freeze({
  interrupted: 130,
  operationalFailure: 2,
  policyFailure: 1,
  success: 0,
});

export type CliExitCode = (typeof CLI_EXIT_CODES)[keyof typeof CLI_EXIT_CODES];

export type CliOperationalErrorCode =
  | "command-failed"
  | "command-unavailable"
  | "invalid-arguments"
  | "invalid-invocation"
  | "output-failed"
  | "unknown-command"
  | "unknown-option";

export interface CliOperationalError {
  readonly category: "operational" | "usage";
  readonly code: CliOperationalErrorCode;
  readonly message: string;
  readonly retryable: false;
}

export interface CliRunResult {
  readonly exitCode: CliExitCode;
  readonly operationalError: CliOperationalError | null;
}

export interface CliOutput {
  readonly write: (text: string, signal: AbortSignal) => Promise<void> | void;
}

export interface CliInvocation {
  readonly argv: readonly string[];
  readonly signal: AbortSignal;
  readonly stderr: CliOutput;
  readonly stdout: CliOutput;
}

export interface CliCommandContext {
  /** Selected client profile. Null means the command's documented all/default profile behavior. */
  readonly agent: CliAgentProfile | null;
  readonly command: CliCommandName;
  /** Exact Git base ref supplied only by the paired scan `--changed --base <ref>` grammar. */
  readonly changedBaseReference: string | null;
  /** Efficiency-only comparison source selected by an explicit `--compare` argument. */
  readonly comparePath: string | null;
  /** True only for an explicit `scan --fix-dry-run`; handlers must preview and never mutate. */
  readonly fixDryRun: boolean;
  /** True only for an explicit `standards update --dry-run`; no cache or lockfile write is allowed. */
  readonly standardsDryRun: boolean;
  /** Explicit absolute cache root for a standards activation; never inferred from ambient state. */
  readonly standardsCachePath: string | null;
  /** Stable output representation selected explicitly by the caller. */
  readonly format: CliOutputFormat;
  /** Scan-only failure threshold selected explicitly by the caller. */
  readonly failureThreshold: CliFailureThreshold | null;
  /** Explicit deterministic scheduler ceiling used by release-trial concurrency verification. */
  readonly maximumConcurrency?: number | null;
  /** True only for explicit efficiency `--no-color`. */
  readonly noColor: boolean;
  readonly operands: readonly string[];
  /** Scan-only, closed profile selector. Empty means configuration-enabled profiles. */
  readonly profiles: readonly CliAgentProfile[];
  /** Scan-only, closed rule selector. Empty means every registered rule. */
  readonly rules: readonly string[];
  /** Scan-only severity overrides encoded as validated rule/severity pairs. */
  readonly severityOverrides: readonly CliSeverityOverride[];
  readonly signal: AbortSignal;
  /** Exact client surface selected for a multi-surface profile; only valid for `explain`. */
  readonly surface: CliSurface | null;
  readonly writeStderr: (text: string) => Promise<void>;
  readonly writeStdout: (text: string) => Promise<void>;
  /** Repository-relative or absolute trace file argument; only valid for `explain`. */
  readonly tracePath: string | null;
  /** Scan-only, closed surface selector. Empty means configuration-enabled surfaces. */
  readonly surfaces: readonly CliSurfaceId[];
  /** Explicit efficiency terminal width, or null for the deterministic default. */
  readonly width: number | null;
}

export type CliAgentProfile =
  | "claude-code"
  | "codex-cli"
  | "copilot-cli"
  | "copilot-cloud-agent"
  | "copilot-code-review"
  | "copilot-vscode"
  | "cursor-agent"
  | "gemini-cli";

export type CliSurface = "cursor-agent/cli" | "cursor-agent/ide";

export type CliOutputFormat = "json" | "sarif" | "stylish" | "terminal";
export type CliScanOutputFormat = "json" | "sarif" | "stylish";
export type CliFailureThreshold = "error" | "never" | "warning";
export type CliRuleSeverity = "error" | "info" | "off" | "warning";
export interface CliSeverityOverride {
  readonly ruleId: string;
  readonly severity: CliRuleSeverity;
}
export type CliSurfaceId =
  | "claude-code/local-session"
  | "codex-cli/local-cli-single-cwd"
  | "copilot-cli/local-terminal"
  | "copilot-cloud-agent/github-hosted"
  | "copilot-code-review/github-hosted"
  | "copilot-vscode/local-chat"
  | "cursor-agent/cli"
  | "cursor-agent/ide"
  | "gemini-cli/local-terminal";

export type CliCommandCompletion =
  | { readonly status: "operational-failure" }
  | { readonly status: "policy-failure" }
  | { readonly status: "success" };

export type CliCommandHandler = (
  context: CliCommandContext,
) => CliCommandCompletion | Promise<CliCommandCompletion>;

export type CliCommandName =
  "efficiency" | "explain" | "init" | "list" | "rules" | "scan" | "standards";

export type CliCommandHandlers = Readonly<Partial<Record<CliCommandName, CliCommandHandler>>>;

export const CLI_LIMITS: Readonly<{
  maximumArgumentBytes: number;
  maximumArgumentCount: number;
  maximumOutputBytes: number;
  maximumOutputChunkBytes: number;
  maximumTotalArgumentBytes: number;
}> = Object.freeze({
  maximumArgumentBytes: 4_096,
  maximumArgumentCount: 64,
  maximumOutputBytes: 64 * 1_024 * 1_024,
  maximumOutputChunkBytes: 1_024 * 1_024,
  maximumTotalArgumentBytes: 65_536,
});

export type CliCompletionKind = "directory" | "file" | "none";

export interface CliOptionDefinition {
  readonly completion: CliCompletionKind;
  readonly description: string;
  readonly names: readonly string[];
  readonly valueName: string | null;
  readonly values: readonly string[];
}

export interface CliCommandDefinition {
  readonly completion: CliCompletionKind;
  readonly description: string;
  readonly implementationTicket: string;
  readonly maximumOperands: number;
  readonly minimumOperands: number;
  readonly name: CliCommandName;
  readonly options: readonly CliOptionDefinition[];
  readonly usage: string;
  readonly validFirstOperands: readonly string[];
}

const freezeOption = (definition: CliOptionDefinition): CliOptionDefinition =>
  Object.freeze({
    ...definition,
    names: Object.freeze([...definition.names]),
    values: Object.freeze([...definition.values]),
  });

export const CLI_AGENT_PROFILES: readonly CliAgentProfile[] = Object.freeze([
  "claude-code",
  "codex-cli",
  "copilot-cli",
  "copilot-cloud-agent",
  "copilot-code-review",
  "copilot-vscode",
  "cursor-agent",
  "gemini-cli",
]);
const AGENT_PROFILES = new Set<CliAgentProfile>(CLI_AGENT_PROFILES);
export const CLI_SURFACES: readonly CliSurface[] = Object.freeze([
  "cursor-agent/cli",
  "cursor-agent/ide",
]);
const SURFACES = new Set<CliSurface>(CLI_SURFACES);
export const CLI_SCAN_SURFACES: readonly CliSurfaceId[] = Object.freeze([
  "claude-code/local-session",
  "codex-cli/local-cli-single-cwd",
  "copilot-cli/local-terminal",
  "copilot-cloud-agent/github-hosted",
  "copilot-code-review/github-hosted",
  "copilot-vscode/local-chat",
  "cursor-agent/cli",
  "cursor-agent/ide",
  "gemini-cli/local-terminal",
]);
const SCAN_SURFACES = new Set<CliSurfaceId>(CLI_SCAN_SURFACES);
const RULE_ID = /^ACL[0-9]{3}$/u;
const REGISTERED_RULE_IDS = new Set<string>(RULE_REGISTRY.rules.map((rule) => rule.id));

export const CLI_GLOBAL_OPTIONS: readonly CliOptionDefinition[] = Object.freeze([
  freezeOption({
    completion: "none",
    description: "Show deterministic help.",
    names: ["-h", "--help"],
    valueName: null,
    values: [],
  }),
  freezeOption({
    completion: "none",
    description: "Show the package version.",
    names: ["-V", "--version"],
    valueName: null,
    values: [],
  }),
]);

const HELP_COMMAND_OPTION = freezeOption({
  completion: "none",
  description: "Show command help.",
  names: ["-h", "--help"],
  valueName: null,
  values: [],
});
const FORMAT_OPTION = freezeOption({
  completion: "none",
  description: "Select deterministic terminal or JSON output.",
  names: ["--format"],
  valueName: "format",
  values: ["terminal", "json"],
});

export const CLI_COMMAND_REGISTRY_VERSION = "1.0.0" as const;

export const CLI_COMMAND_DEFINITIONS: readonly CliCommandDefinition[] = Object.freeze([
  Object.freeze({
    completion: "directory",
    description: "Lint repository agent instruction files.",
    implementationTicket: "I02",
    maximumOperands: 1,
    minimumOperands: 0,
    name: "scan",
    options: Object.freeze([
      HELP_COMMAND_OPTION,
      freezeOption({
        completion: "none",
        description: "Select stylish, JSON, or SARIF output.",
        names: ["--format"],
        valueName: "format",
        values: ["stylish", "json", "sarif"],
      }),
      freezeOption({
        completion: "none",
        description: "Run only a registered rule; repeat to select more.",
        names: ["--rule"],
        valueName: "rule",
        values: [],
      }),
      freezeOption({
        completion: "none",
        description: "Override one rule severity as ACLNNN=severity; repeatable.",
        names: ["--severity"],
        valueName: "override",
        values: [],
      }),
      freezeOption({
        completion: "none",
        description: "Choose the diagnostic failure threshold.",
        names: ["--fail-on"],
        valueName: "threshold",
        values: ["error", "warning", "never"],
      }),
      freezeOption({
        completion: "none",
        description: "Bound rule-family worker concurrency from 1 through 10.",
        names: ["--maximum-concurrency"],
        valueName: "workers",
        values: [],
      }),
      freezeOption({
        completion: "none",
        description: "Select a client profile; repeat to select more.",
        names: ["--profile"],
        valueName: "profile",
        values: CLI_AGENT_PROFILES,
      }),
      freezeOption({
        completion: "none",
        description: "Select a client surface; repeat to select more.",
        names: ["--surface"],
        valueName: "surface",
        values: CLI_SCAN_SURFACES,
      }),
      freezeOption({
        completion: "none",
        description: "Select diagnostics changed from one explicit Git base reference.",
        names: ["--changed"],
        valueName: null,
        values: [],
      }),
      freezeOption({
        completion: "none",
        description: "Resolve the exact Git base reference for --changed mode.",
        names: ["--base"],
        valueName: "ref",
        values: [],
      }),
      freezeOption({
        completion: "none",
        description: "Preview selected mechanical fixes without writing.",
        names: ["--fix-dry-run"],
        valueName: null,
        values: [],
      }),
    ]),
    usage:
      "scan [repository] [--format stylish|json|sarif] [--rule ACLNNN] [--severity <override>] [--fail-on error|warning|never] [--maximum-concurrency 1..10] [--profile profile] [--surface surface] [--changed --base ref] [--fix-dry-run]",
    validFirstOperands: Object.freeze([]),
  }),
  Object.freeze({
    completion: "directory",
    description: "List discovered instruction surfaces.",
    implementationTicket: "I03",
    maximumOperands: 1,
    minimumOperands: 0,
    name: "list",
    options: Object.freeze([HELP_COMMAND_OPTION, FORMAT_OPTION]),
    usage: "list [repository] [--format terminal|json]",
    validFirstOperands: Object.freeze([]),
  }),
  Object.freeze({
    completion: "file",
    description: "Explain effective instructions for a target path.",
    implementationTicket: "I03",
    maximumOperands: 1,
    minimumOperands: 1,
    name: "explain",
    options: Object.freeze([
      HELP_COMMAND_OPTION,
      freezeOption({
        completion: "none",
        description: "Select an exact client profile.",
        names: ["--agent"],
        valueName: "profile",
        values: CLI_AGENT_PROFILES,
      }),
      freezeOption({
        completion: "file",
        description: "Load a repository-contained resolution-event trace.",
        names: ["--trace"],
        valueName: "file",
        values: [],
      }),
      freezeOption({
        completion: "none",
        description: "Select an exact surface for a multi-surface client profile.",
        names: ["--surface"],
        valueName: "surface",
        values: CLI_SURFACES,
      }),
      FORMAT_OPTION,
    ]),
    usage:
      "explain <target> [--agent <profile>] [--surface <surface>] [--trace <file>] [--format terminal|json]",
    validFirstOperands: Object.freeze([]),
  }),
  Object.freeze({
    completion: "none",
    description: "List installed lint rules.",
    implementationTicket: "I03",
    maximumOperands: 0,
    minimumOperands: 0,
    name: "rules",
    options: Object.freeze([HELP_COMMAND_OPTION, FORMAT_OPTION]),
    usage: "rules [--format terminal|json]",
    validFirstOperands: Object.freeze([]),
  }),
  Object.freeze({
    completion: "directory",
    description: "Create a starter repository configuration.",
    implementationTicket: "I03",
    maximumOperands: 1,
    minimumOperands: 0,
    name: "init",
    options: Object.freeze([HELP_COMMAND_OPTION]),
    usage: "init [repository]",
    validFirstOperands: Object.freeze([]),
  }),
  Object.freeze({
    completion: "none",
    description: "Inspect, verify, or update standards knowledge.",
    implementationTicket: "H06/H08/H09",
    maximumOperands: 1,
    minimumOperands: 1,
    name: "standards",
    options: Object.freeze([
      HELP_COMMAND_OPTION,
      FORMAT_OPTION,
      freezeOption({
        completion: "directory",
        description: "Use an explicit private cache root for update activation.",
        names: ["--cache"],
        valueName: "directory",
        values: [],
      }),
      freezeOption({
        completion: "none",
        description: "Preview a signed update without writing cache or lockfile state.",
        names: ["--dry-run"],
        valueName: null,
        values: [],
      }),
    ]),
    usage:
      "standards <status|check|update> [--format terminal|json] [--dry-run] [--cache <directory>]",
    validFirstOperands: Object.freeze(["check", "status", "update"]),
  }),
  Object.freeze({
    completion: "directory",
    description: "Report instruction-context efficiency.",
    implementationTicket: "G09",
    maximumOperands: 1,
    minimumOperands: 0,
    name: "efficiency",
    options: Object.freeze([
      HELP_COMMAND_OPTION,
      freezeOption({
        completion: "none",
        description: "Select an exact client profile.",
        names: ["--agent"],
        valueName: "profile",
        values: CLI_AGENT_PROFILES,
      }),
      FORMAT_OPTION,
      freezeOption({
        completion: "directory",
        description: "Compare against an independently resolved repository source.",
        names: ["--compare"],
        valueName: "repository",
        values: [],
      }),
      freezeOption({
        completion: "none",
        description: "Render terminal output without ANSI color.",
        names: ["--no-color"],
        valueName: null,
        values: [],
      }),
      freezeOption({
        completion: "none",
        description: "Set terminal width from 40 through 240 columns.",
        names: ["--width"],
        valueName: "columns",
        values: [],
      }),
    ]),
    usage:
      "efficiency [repository] [--agent <profile>] [--format terminal|json] [--compare <repository>] [--no-color] [--width <columns>]",
    validFirstOperands: Object.freeze([]),
  }),
]);

const COMMAND_NAMES = new Set<CliCommandName>(
  CLI_COMMAND_DEFINITIONS.map((definition) => definition.name),
);
const HELP_OPTIONS = new Set(["--help", "-h"]);
const VERSION_OPTIONS = new Set(["--version", "-V"]);
const ARGUMENT_CONTROL_PATTERN = new RegExp(
  String.raw`[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]`,
  "u",
);
const UNPAIRED_SURROGATE_PATTERN =
  /(?:[\ud800-\udbff](?![\udc00-\udfff])|(?:^|[^\ud800-\udbff])[\udc00-\udfff])/u;
function isCanonicalStandardsCachePath(value: string): boolean {
  return (
    value.length > 0 &&
    path.isAbsolute(value) &&
    path.resolve(value) === value &&
    path.parse(value).root !== value
  );
}
const ABORT_SIGNAL_ABORTED_DESCRIPTOR = Object.getOwnPropertyDescriptor(
  AbortSignal.prototype,
  "aborted",
);
type EventTargetIntrinsic = (...arguments_: readonly unknown[]) => unknown;
const EVENT_TARGET_ADD_EVENT_LISTENER = Object.getOwnPropertyDescriptor(
  EventTarget.prototype,
  "addEventListener",
)?.value as EventTargetIntrinsic;
const EVENT_TARGET_REMOVE_EVENT_LISTENER = Object.getOwnPropertyDescriptor(
  EventTarget.prototype,
  "removeEventListener",
)?.value as EventTargetIntrinsic;

const ERROR_DEFINITIONS: Readonly<
  Record<
    CliOperationalErrorCode,
    Readonly<{ readonly category: "operational" | "usage"; readonly message: string }>
  >
> = Object.freeze({
  "command-failed": Object.freeze({
    category: "operational",
    message: "command execution failed",
  }),
  "command-unavailable": Object.freeze({
    category: "operational",
    message: "command is not available in this build",
  }),
  "invalid-arguments": Object.freeze({
    category: "usage",
    message: "invalid command arguments",
  }),
  "invalid-invocation": Object.freeze({
    category: "operational",
    message: "invalid CLI invocation",
  }),
  "output-failed": Object.freeze({
    category: "operational",
    message: "unable to write command output",
  }),
  "unknown-command": Object.freeze({ category: "usage", message: "unknown command" }),
  "unknown-option": Object.freeze({ category: "usage", message: "unknown option" }),
});

const SUCCESS_RESULT: CliRunResult = Object.freeze({
  exitCode: CLI_EXIT_CODES.success,
  operationalError: null,
});
const POLICY_FAILURE_RESULT: CliRunResult = Object.freeze({
  exitCode: CLI_EXIT_CODES.policyFailure,
  operationalError: null,
});
const INTERRUPTED_RESULT: CliRunResult = Object.freeze({
  exitCode: CLI_EXIT_CODES.interrupted,
  operationalError: null,
});

interface InvocationSnapshot {
  readonly argv: readonly string[];
  readonly signal: AbortSignal;
  readonly stderr: CliOutput;
  readonly stdout: CliOutput;
}

interface HandlerSnapshot {
  readonly handlers: ReadonlyMap<CliCommandName, CliCommandHandler>;
  readonly valid: boolean;
}

type ParseResult =
  | {
      readonly agent: CliAgentProfile | null;
      readonly changedBaseReference: string | null;
      readonly kind: "command";
      readonly command: CliCommandName;
      readonly comparePath: string | null;
      readonly fixDryRun: boolean;
      readonly standardsDryRun: boolean;
      readonly standardsCachePath: string | null;
      readonly format: CliOutputFormat;
      readonly failureThreshold: CliFailureThreshold | null;
      readonly maximumConcurrency: number | null;
      readonly noColor: boolean;
      readonly operands: readonly string[];
      readonly surface: CliSurface | null;
      readonly profiles: readonly CliAgentProfile[];
      readonly rules: readonly string[];
      readonly severityOverrides: readonly CliSeverityOverride[];
      readonly surfaces: readonly CliSurfaceId[];
      readonly tracePath: string | null;
      readonly width: number | null;
    }
  | { readonly command?: CliCommandName; readonly kind: "help" }
  | { readonly error: CliOperationalError; readonly kind: "error" }
  | { readonly kind: "version" };

type OperationResult<T> =
  | { readonly kind: "aborted" }
  | { readonly kind: "fulfilled"; readonly value: T }
  | { readonly kind: "rejected"; readonly outputFailure: boolean };

const OUTPUT_FAILURES = new WeakSet<object>();

class OutputFailure extends Error {
  public constructor() {
    super("bounded output capability failed");
    this.name = "OutputFailure";
    OUTPUT_FAILURES.add(this);
  }
}

function isOutputFailure(value: unknown): boolean {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    OUTPUT_FAILURES.has(value)
  );
}

function makeError(code: CliOperationalErrorCode): CliOperationalError {
  const definition = ERROR_DEFINITIONS[code];
  return Object.freeze({
    category: definition.category,
    code,
    message: definition.message,
    retryable: false,
  });
}

function failureResult(error: CliOperationalError): CliRunResult {
  return Object.freeze({
    exitCode: CLI_EXIT_CODES.operationalFailure,
    operationalError: error,
  });
}

function isPlainClosedRecord(value: unknown, allowedKeys: ReadonlySet<string>): value is object {
  if (typeof value !== "object" || value === null || nodeTypes.isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length > allowedKeys.size) return false;
  return keys.every((key) => typeof key === "string" && allowedKeys.has(key));
}

function dataProperty(record: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
}

function snapshotOutput(value: unknown): CliOutput | null {
  if (!isPlainClosedRecord(value, new Set(["write"]))) return null;
  const write = dataProperty(value, "write");
  if (typeof write !== "function" || nodeTypes.isProxy(write)) return null;
  return Object.freeze({ write: write as CliOutput["write"] });
}

function isSafeArgument(argument: string): boolean {
  if (ARGUMENT_CONTROL_PATTERN.test(argument) || UNPAIRED_SURROGATE_PATTERN.test(argument)) {
    return false;
  }
  return Buffer.byteLength(argument, "utf8") <= CLI_LIMITS.maximumArgumentBytes;
}

function snapshotArguments(value: unknown): readonly string[] | null {
  if (typeof value !== "object" || value === null || nodeTypes.isProxy(value)) return null;
  if (!Array.isArray(value) || value.length > CLI_LIMITS.maximumArgumentCount) return null;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1) return null;

  const argumentsCopy: string[] = [];
  let totalBytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      typeof descriptor.value !== "string"
    ) {
      return null;
    }
    if (!isSafeArgument(descriptor.value)) return null;
    totalBytes += Buffer.byteLength(descriptor.value, "utf8");
    if (totalBytes > CLI_LIMITS.maximumTotalArgumentBytes) return null;
    argumentsCopy.push(descriptor.value);
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (lengthDescriptor === undefined || !("value" in lengthDescriptor)) return null;
  return Object.freeze(argumentsCopy);
}

function snapshotInvocation(value: unknown): InvocationSnapshot | null {
  const keys = new Set(["argv", "signal", "stderr", "stdout"]);
  if (!isPlainClosedRecord(value, keys)) return null;
  const argv = snapshotArguments(dataProperty(value, "argv"));
  const signal = dataProperty(value, "signal");
  const stderr = snapshotOutput(dataProperty(value, "stderr"));
  const stdout = snapshotOutput(dataProperty(value, "stdout"));
  if (argv === null || stderr === null || stdout === null || !isNativeAbortSignal(signal)) {
    return null;
  }
  return Object.freeze({ argv, signal, stderr, stdout });
}

function snapshotHandlers(value: unknown): HandlerSnapshot {
  if (!isPlainClosedRecord(value, COMMAND_NAMES)) {
    return Object.freeze({ handlers: new Map(), valid: false });
  }
  const handlers = new Map<CliCommandName, CliCommandHandler>();
  for (const command of COMMAND_NAMES) {
    const descriptor = Object.getOwnPropertyDescriptor(value, command);
    if (descriptor === undefined) continue;
    if (!("value" in descriptor) || typeof descriptor.value !== "function") {
      return Object.freeze({ handlers: new Map(), valid: false });
    }
    if (nodeTypes.isProxy(descriptor.value)) {
      return Object.freeze({ handlers: new Map(), valid: false });
    }
    handlers.set(command, descriptor.value as CliCommandHandler);
  }
  return Object.freeze({ handlers, valid: true });
}

function parseArguments(argv: readonly string[]): ParseResult {
  if (argv.length === 0) return Object.freeze({ kind: "help" });
  const first = argv[0];
  if (first === undefined) return Object.freeze({ kind: "help" });
  if (HELP_OPTIONS.has(first)) {
    return argv.length === 1
      ? Object.freeze({ kind: "help" })
      : Object.freeze({ error: makeError("invalid-arguments"), kind: "error" });
  }
  if (VERSION_OPTIONS.has(first)) {
    return argv.length === 1
      ? Object.freeze({ kind: "version" })
      : Object.freeze({ error: makeError("invalid-arguments"), kind: "error" });
  }
  if (first.startsWith("-")) {
    return Object.freeze({ error: makeError("unknown-option"), kind: "error" });
  }
  if (!COMMAND_NAMES.has(first as CliCommandName)) {
    return Object.freeze({ error: makeError("unknown-command"), kind: "error" });
  }

  const command = first as CliCommandName;
  if (argv.length === 2 && HELP_OPTIONS.has(argv[1] ?? "")) {
    return Object.freeze({ command, kind: "help" });
  }
  const operands: string[] = [];
  let agent: CliAgentProfile | null = null;
  let baseReference: string | null = null;
  let changed = false;
  let comparePath: string | null = null;
  let fixDryRun = false;
  let standardsDryRun = false;
  let standardsCachePath: string | null = null;
  let format: CliOutputFormat = "terminal";
  let failureThreshold: CliFailureThreshold | null = null;
  let formatSpecified = false;
  let noColor = false;
  let maximumConcurrency: number | null = null;
  let surface: CliSurface | null = null;
  const profiles: CliAgentProfile[] = [];
  const rules: string[] = [];
  const severityOverrides: CliSeverityOverride[] = [];
  const surfaces: CliSurfaceId[] = [];
  let tracePath: string | null = null;
  let width: number | null = null;
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined)
      return Object.freeze({ error: makeError("invalid-arguments"), kind: "error" });
    if (argument === "--changed") {
      if (command !== "scan" || changed)
        return Object.freeze({ error: makeError("invalid-arguments"), kind: "error" });
      changed = true;
    } else if (argument === "--base") {
      const value = argv[index + 1];
      if (command !== "scan" || baseReference !== null || !isValidGitBaseReference(value))
        return Object.freeze({ error: makeError("invalid-arguments"), kind: "error" });
      baseReference = value;
      index += 1;
    } else if (argument === "--fix-dry-run") {
      if (command !== "scan" || fixDryRun)
        return Object.freeze({ error: makeError("invalid-arguments"), kind: "error" });
      fixDryRun = true;
    } else if (argument === "--dry-run") {
      if (command !== "standards" || standardsDryRun)
        return Object.freeze({ error: makeError("invalid-arguments"), kind: "error" });
      standardsDryRun = true;
    } else if (argument === "--cache") {
      const value = argv[index + 1];
      if (
        command !== "standards" ||
        standardsCachePath !== null ||
        value === undefined ||
        value.startsWith("-") ||
        !isCanonicalStandardsCachePath(value)
      )
        return Object.freeze({ error: makeError("invalid-arguments"), kind: "error" });
      standardsCachePath = value;
      index += 1;
    } else if (argument === "--format") {
      if (
        (command !== "scan" &&
          command !== "list" &&
          command !== "explain" &&
          command !== "rules" &&
          command !== "efficiency" &&
          command !== "standards") ||
        index + 1 >= argv.length
      )
        return Object.freeze({ error: makeError("invalid-arguments"), kind: "error" });
      const value = argv[index + 1];
      if (
        (command === "scan" && value !== "stylish" && value !== "json" && value !== "sarif") ||
        (command !== "scan" && value !== "terminal" && value !== "json") ||
        formatSpecified
      )
        return Object.freeze({ error: makeError("invalid-arguments"), kind: "error" });
      format = value as CliOutputFormat;
      formatSpecified = true;
      index += 1;
    } else if (argument === "--rule") {
      const value = argv[index + 1];
      if (
        command !== "scan" ||
        value === undefined ||
        !RULE_ID.test(value) ||
        !REGISTERED_RULE_IDS.has(value) ||
        rules.includes(value)
      )
        return Object.freeze({ error: makeError("invalid-arguments"), kind: "error" });
      rules.push(value);
      index += 1;
    } else if (argument === "--severity") {
      const value = argv[index + 1];
      const match = value?.match(/^(ACL[0-9]{3})=(error|warning|info|off)$/u);
      const ruleId = match?.[1];
      const severity = match?.[2];
      if (
        command !== "scan" ||
        ruleId === undefined ||
        severity === undefined ||
        !REGISTERED_RULE_IDS.has(ruleId) ||
        severityOverrides.some((entry) => entry.ruleId === ruleId)
      )
        return Object.freeze({ error: makeError("invalid-arguments"), kind: "error" });
      severityOverrides.push(Object.freeze({ ruleId, severity: severity as CliRuleSeverity }));
      index += 1;
    } else if (argument === "--fail-on") {
      const value = argv[index + 1];
      if (
        command !== "scan" ||
        failureThreshold !== null ||
        (value !== "error" && value !== "warning" && value !== "never")
      )
        return Object.freeze({ error: makeError("invalid-arguments"), kind: "error" });
      failureThreshold = value;
      index += 1;
    } else if (argument === "--profile") {
      const value = argv[index + 1];
      if (
        command !== "scan" ||
        value === undefined ||
        !AGENT_PROFILES.has(value as CliAgentProfile) ||
        profiles.includes(value as CliAgentProfile)
      )
        return Object.freeze({ error: makeError("invalid-arguments"), kind: "error" });
      profiles.push(value as CliAgentProfile);
      index += 1;
    } else if (argument === "--maximum-concurrency") {
      const value = argv[index + 1];
      if (
        command !== "scan" ||
        maximumConcurrency !== null ||
        value === undefined ||
        !/^(?:[1-9]|10)$/u.test(value)
      )
        return Object.freeze({ error: makeError("invalid-arguments"), kind: "error" });
      maximumConcurrency = Number(value);
      index += 1;
    } else if (argument === "--surface") {
      const value = argv[index + 1];
      if (value === undefined)
        return Object.freeze({ error: makeError("invalid-arguments"), kind: "error" });
      if (command === "scan") {
        if (!SCAN_SURFACES.has(value as CliSurfaceId) || surfaces.includes(value as CliSurfaceId))
          return Object.freeze({ error: makeError("invalid-arguments"), kind: "error" });
        surfaces.push(value as CliSurfaceId);
      } else if (command === "explain") {
        if (surface !== null || !SURFACES.has(value as CliSurface))
          return Object.freeze({ error: makeError("invalid-arguments"), kind: "error" });
        surface = value as CliSurface;
      } else return Object.freeze({ error: makeError("invalid-arguments"), kind: "error" });
      index += 1;
    } else if (argument === "--agent") {
      if (
        (command !== "explain" && command !== "efficiency") ||
        index + 1 >= argv.length ||
        agent !== null
      )
        return Object.freeze({ error: makeError("invalid-arguments"), kind: "error" });
      const value = argv[index + 1];
      if (value === undefined || !AGENT_PROFILES.has(value as CliAgentProfile))
        return Object.freeze({ error: makeError("invalid-arguments"), kind: "error" });
      agent = value as CliAgentProfile;
      index += 1;
    } else if (argument === "--trace") {
      if (command !== "explain" || index + 1 >= argv.length || tracePath !== null)
        return Object.freeze({ error: makeError("invalid-arguments"), kind: "error" });
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("-"))
        return Object.freeze({ error: makeError("invalid-arguments"), kind: "error" });
      tracePath = value;
      index += 1;
    } else if (argument === "--compare") {
      if (command !== "efficiency" || index + 1 >= argv.length || comparePath !== null)
        return Object.freeze({ error: makeError("invalid-arguments"), kind: "error" });
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("-"))
        return Object.freeze({ error: makeError("invalid-arguments"), kind: "error" });
      comparePath = value;
      index += 1;
    } else if (argument === "--no-color") {
      if (command !== "efficiency" || noColor)
        return Object.freeze({ error: makeError("invalid-arguments"), kind: "error" });
      noColor = true;
    } else if (argument === "--width") {
      if (command !== "efficiency" || index + 1 >= argv.length || width !== null)
        return Object.freeze({ error: makeError("invalid-arguments"), kind: "error" });
      const value = argv[index + 1];
      if (value === undefined || !/^(?:[4-9][0-9]|1[0-9]{2}|2[0-3][0-9]|240)$/u.test(value))
        return Object.freeze({ error: makeError("invalid-arguments"), kind: "error" });
      width = Number(value);
      index += 1;
    } else if (argument.startsWith("-")) {
      return Object.freeze({ error: makeError("unknown-option"), kind: "error" });
    } else operands.push(argument);
  }
  const definition = CLI_COMMAND_DEFINITIONS.find((candidate) => candidate.name === command);
  if (
    definition === undefined ||
    operands.length < definition.minimumOperands ||
    operands.length > definition.maximumOperands ||
    (definition.validFirstOperands.length > 0 &&
      !definition.validFirstOperands.includes(operands[0] ?? ""))
  ) {
    return Object.freeze({ error: makeError("invalid-arguments"), kind: "error" });
  }
  if (surface !== null && agent !== "cursor-agent")
    return Object.freeze({ error: makeError("invalid-arguments"), kind: "error" });
  if (changed !== (baseReference !== null))
    return Object.freeze({ error: makeError("invalid-arguments"), kind: "error" });
  if (command === "scan" && fixDryRun && format !== "terminal" && format !== "stylish")
    return Object.freeze({ error: makeError("invalid-arguments"), kind: "error" });
  if (command !== "standards" && (standardsDryRun || standardsCachePath !== null))
    return Object.freeze({ error: makeError("invalid-arguments"), kind: "error" });
  if (command === "standards" && standardsDryRun && operands[0] !== "update")
    return Object.freeze({ error: makeError("invalid-arguments"), kind: "error" });
  if (command === "standards" && standardsDryRun && standardsCachePath !== null)
    return Object.freeze({ error: makeError("invalid-arguments"), kind: "error" });
  if (command === "standards" && standardsCachePath !== null && operands[0] !== "update")
    return Object.freeze({ error: makeError("invalid-arguments"), kind: "error" });
  if (
    command === "scan" &&
    rules.length > 0 &&
    severityOverrides.some((entry) => !rules.includes(entry.ruleId))
  )
    return Object.freeze({ error: makeError("invalid-arguments"), kind: "error" });
  return Object.freeze({
    agent,
    changedBaseReference: changed ? baseReference : null,
    command,
    comparePath,
    failureThreshold,
    fixDryRun,
    standardsDryRun,
    standardsCachePath,
    format: command === "scan" && format === "terminal" ? "stylish" : format,
    kind: "command",
    maximumConcurrency,
    noColor,
    operands: Object.freeze(operands),
    surface,
    profiles: Object.freeze(profiles),
    rules: Object.freeze(rules),
    severityOverrides: Object.freeze(severityOverrides),
    surfaces: Object.freeze(surfaces),
    tracePath,
    width,
  });
}

function renderRootHelp(handlers: ReadonlyMap<CliCommandName, CliCommandHandler>): string {
  const commandLines = CLI_COMMAND_DEFINITIONS.map((definition) => {
    const status = handlers.has(definition.name) ? "available" : "unavailable";
    return `  ${definition.usage.padEnd(38)} ${definition.description} [${status}]`;
  });
  return [
    `Agent Context Linter ${CLI_VERSION}`,
    "",
    "Usage:",
    `  ${CLI_NAME} [--help] [--version]`,
    `  ${CLI_NAME} <command> [arguments]`,
    "",
    "Commands:",
    ...commandLines,
    "",
    "Options:",
    "  -h, --help       Show deterministic help.",
    "  -V, --version    Show the package version.",
    "  --fix-dry-run    Scan only: preview selected mechanical fixes; never write.",
    "",
    "Exit codes: 0 success, 1 lint policy failure, 2 usage/operational failure, 130 SIGINT.",
    "",
  ].join("\n");
}

function renderCommandHelp(
  command: CliCommandName,
  handlers: ReadonlyMap<CliCommandName, CliCommandHandler>,
): string {
  const definition = CLI_COMMAND_DEFINITIONS.find((candidate) => candidate.name === command);
  if (definition === undefined) return renderRootHelp(handlers);
  const status = handlers.has(command)
    ? "available"
    : `unavailable in this build; implementation is tracked by ${definition.implementationTicket}`;
  return [
    `Usage: ${CLI_NAME} ${definition.usage}`,
    "",
    definition.description,
    `Status: ${status}.`,
    "",
  ].join("\n");
}

function renderError(error: CliOperationalError): string {
  return [
    `${CLI_NAME}: ${error.message}.`,
    `Run '${CLI_NAME} --help' for usage and command availability.`,
    "",
  ].join("\n");
}

function validOutputText(text: string): boolean {
  return !UNPAIRED_SURROGATE_PATTERN.test(text);
}

function intrinsicAbortState(value: unknown): boolean | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    nodeTypes.isProxy(value) ||
    ABORT_SIGNAL_ABORTED_DESCRIPTOR?.get === undefined
  ) {
    return undefined;
  }
  try {
    const state: unknown = ABORT_SIGNAL_ABORTED_DESCRIPTOR.get.call(value);
    return typeof state === "boolean" ? state : undefined;
  } catch {
    return undefined;
  }
}

function isNativeAbortSignal(value: unknown): value is AbortSignal {
  return intrinsicAbortState(value) !== undefined;
}

function signalWasAborted(signal: AbortSignal): boolean {
  return intrinsicAbortState(signal) !== false;
}

function addIntrinsicAbortListener(signal: AbortSignal, listener: () => void): void {
  Reflect.apply(EVENT_TARGET_ADD_EVENT_LISTENER, signal, ["abort", listener, { once: true }]);
}

function removeIntrinsicAbortListener(signal: AbortSignal, listener: () => void): void {
  Reflect.apply(EVENT_TARGET_REMOVE_EVENT_LISTENER, signal, ["abort", listener]);
}

async function settleOperation<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<OperationResult<T>> {
  if (signalWasAborted(signal)) return Object.freeze({ kind: "aborted" });
  let resolveAbort = (): void => undefined;
  const aborted = new Promise<OperationResult<T>>((resolve) => {
    resolveAbort = (): void => {
      resolve(Object.freeze({ kind: "aborted" }));
    };
  });
  addIntrinsicAbortListener(signal, resolveAbort);
  try {
    if (signalWasAborted(signal)) resolveAbort();
    const settled = operation.then<OperationResult<T>, OperationResult<T>>(
      (value): OperationResult<T> => Object.freeze({ kind: "fulfilled", value }),
      (reason: unknown): OperationResult<T> =>
        Object.freeze({ kind: "rejected", outputFailure: isOutputFailure(reason) }),
    );
    return await Promise.race([settled, aborted]);
  } finally {
    removeIntrinsicAbortListener(signal, resolveAbort);
  }
}

function createBoundedWriter(
  output: CliOutput,
  signal: AbortSignal,
): (text: string) => Promise<void> {
  let totalBytes = 0;
  return async (text: string): Promise<void> => {
    if (signalWasAborted(signal)) throw new OutputFailure();
    const bytes = Buffer.byteLength(text, "utf8");
    if (
      !validOutputText(text) ||
      bytes > CLI_LIMITS.maximumOutputChunkBytes ||
      totalBytes + bytes > CLI_LIMITS.maximumOutputBytes
    ) {
      throw new OutputFailure();
    }
    totalBytes += bytes;
    let operation: Promise<void> | void;
    try {
      operation = output.write(text, signal);
    } catch {
      throw new OutputFailure();
    }
    const result = await settleOperation(Promise.resolve(operation), signal);
    if (result.kind !== "fulfilled") throw new OutputFailure();
  };
}

async function reportError(
  error: CliOperationalError,
  stderr: (text: string) => Promise<void>,
  signal: AbortSignal,
): Promise<CliRunResult> {
  if (signalWasAborted(signal)) return INTERRUPTED_RESULT;
  try {
    await stderr(renderError(error));
    return signalWasAborted(signal) ? INTERRUPTED_RESULT : failureResult(error);
  } catch {
    return signalWasAborted(signal)
      ? INTERRUPTED_RESULT
      : failureResult(makeError("output-failed"));
  }
}

function snapshotCompletion(value: unknown): CliCommandCompletion | null {
  if (!isPlainClosedRecord(value, new Set(["status"]))) return null;
  const status = dataProperty(value, "status");
  if (status !== "operational-failure" && status !== "policy-failure" && status !== "success") {
    return null;
  }
  return Object.freeze({ status });
}

export async function runCommandRouter(
  invocationValue: unknown,
  handlerValue: unknown = Object.freeze({}),
): Promise<CliRunResult> {
  const invocation = snapshotInvocation(invocationValue);
  if (invocation === null) return failureResult(makeError("invalid-invocation"));
  if (signalWasAborted(invocation.signal)) return INTERRUPTED_RESULT;

  const stderr = createBoundedWriter(invocation.stderr, invocation.signal);
  const stdout = createBoundedWriter(invocation.stdout, invocation.signal);
  const handlerSnapshot = snapshotHandlers(handlerValue);
  if (!handlerSnapshot.valid) {
    return reportError(makeError("invalid-invocation"), stderr, invocation.signal);
  }

  const parsed = parseArguments(invocation.argv);
  if (parsed.kind === "error") {
    return reportError(parsed.error, stderr, invocation.signal);
  }
  if (parsed.kind === "help" || parsed.kind === "version") {
    const output =
      parsed.kind === "version"
        ? `${CLI_VERSION}\n`
        : parsed.command === undefined
          ? renderRootHelp(handlerSnapshot.handlers)
          : renderCommandHelp(parsed.command, handlerSnapshot.handlers);
    try {
      await stdout(output);
      return signalWasAborted(invocation.signal) ? INTERRUPTED_RESULT : SUCCESS_RESULT;
    } catch {
      return reportError(makeError("output-failed"), stderr, invocation.signal);
    }
  }

  const handler = handlerSnapshot.handlers.get(parsed.command);
  if (handler === undefined) {
    return reportError(makeError("command-unavailable"), stderr, invocation.signal);
  }

  try {
    const operation = handler(
      Object.freeze({
        command: parsed.command,
        agent: parsed.agent,
        changedBaseReference: parsed.changedBaseReference,
        comparePath: parsed.comparePath,
        failureThreshold: parsed.failureThreshold,
        fixDryRun: parsed.fixDryRun,
        standardsDryRun: parsed.standardsDryRun,
        standardsCachePath: parsed.standardsCachePath,
        format: parsed.format,
        maximumConcurrency: parsed.maximumConcurrency,
        noColor: parsed.noColor,
        operands: parsed.operands,
        profiles: parsed.profiles,
        rules: parsed.rules,
        severityOverrides: parsed.severityOverrides,
        signal: invocation.signal,
        surface: parsed.surface,
        writeStderr: stderr,
        writeStdout: stdout,
        tracePath: parsed.tracePath,
        surfaces: parsed.surfaces,
        width: parsed.width,
      }),
    );
    const settled = await settleOperation(Promise.resolve(operation), invocation.signal);
    if (settled.kind === "aborted") return INTERRUPTED_RESULT;
    if (settled.kind === "rejected") {
      return await reportError(
        makeError(settled.outputFailure ? "output-failed" : "command-failed"),
        stderr,
        invocation.signal,
      );
    }
    const completion = snapshotCompletion(settled.value);
    if (completion === null || completion.status === "operational-failure") {
      return await reportError(makeError("command-failed"), stderr, invocation.signal);
    }
    return completion.status === "policy-failure" ? POLICY_FAILURE_RESULT : SUCCESS_RESULT;
  } catch (error) {
    if (signalWasAborted(invocation.signal)) return INTERRUPTED_RESULT;
    return await reportError(
      isOutputFailure(error) ? makeError("output-failed") : makeError("command-failed"),
      stderr,
      invocation.signal,
    );
  }
}
