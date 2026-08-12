import { createHash } from "node:crypto";
import path from "node:path";
import { types as nodeTypes } from "node:util";

import type { AgentContextConfiguration, RepositoryRelativePath } from "@agent-context/core";
import {
  createAtomicRepositoryWriter,
  createReadOnlyRepository,
  ReadOnlyRepositoryError,
  ReadOnlyRepositoryErrorCode,
  selectRepositoryRoot,
} from "@agent-context/evidence";
import {
  createOfflineStandardsStatus,
  getAuthenticatedBundledTrustStore,
  loadBundledKnowledgePack,
  serializeKnowledgePack,
  StandardsChecker,
  StandardsCache,
  StandardsUpdater,
  type LoadedBundledKnowledgePack,
  type OfflineStandardsStatusReport,
  type StandardsActivationReport,
  type StandardsCheckReport,
  type StandardsUpdatePlan,
} from "@agent-context/standards";
import { resolveAgentContextConfiguration } from "@agent-context/syntax";

import packageManifest from "../package.json" with { type: "json" };

import type { CliCommandContext, CliCommandHandler, CliCommandHandlers } from "./command-router.js";

export const STANDARDS_COMMAND_OUTPUT_CONTRACT_VERSION = "0.1.0" as const;
export const STANDARDS_CHECK_RECORD_KIND = "agent-context-standards-check" as const;
export const STANDARDS_COMMAND_ERROR_RECORD_KIND = "agent-context-standards-command-error" as const;

const EXACT_ABSOLUTE_PATH = (value: string): boolean =>
  value.length > 0 && path.isAbsolute(value) && path.resolve(value) === value;

interface StandardsCommandOptions {
  readonly engineVersion?: string;
  readonly now?: () => string;
  readonly workingDirectory: string;
}

interface RepositorySnapshot {
  readonly configuration: AgentContextConfiguration;
  readonly lock: Readonly<{
    readonly bytes: Uint8Array;
    readonly identity: Readonly<{ readonly device: string; readonly inode: string }>;
  }> | null;
  readonly repositoryRoot: string;
  readonly selection: Awaited<ReturnType<typeof selectRepositoryRoot>>;
}

interface CommandErrorIssue {
  readonly code: string;
  readonly path: string;
  readonly source: string;
}

type StandardsCommandValue =
  | OfflineStandardsStatusReport
  | StandardsCheckReport
  | StandardsUpdatePlan
  | StandardsActivationReport;

function exactNow(): string {
  return `${new Date().toISOString().slice(0, 19)}Z`;
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function ownDataValue(value: object, key: string): unknown {
  const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
  return descriptor === undefined || !("value" in descriptor) ? undefined : descriptor.value;
}

function issueSource(value: unknown): string {
  if (value === null || typeof value !== "object") return "standards";
  const source = ownDataValue(value, "source");
  return typeof source === "string" && /^[a-z][a-z-]{0,31}$/u.test(source) ? source : "standards";
}

function issuePath(value: unknown): string {
  if (value === null || typeof value !== "object") return "$";
  const candidate = ownDataValue(value, "path");
  return typeof candidate === "string" && candidate.length <= 512 ? candidate : "$";
}

function issueCode(value: unknown): string {
  if (value === null || typeof value !== "object") return "standards-failure";
  const candidate = ownDataValue(value, "code");
  return typeof candidate === "string" && /^[a-z][a-z0-9-]{0,63}$/u.test(candidate)
    ? candidate
    : "standards-failure";
}

function safeIssue(value: unknown): CommandErrorIssue {
  return Object.freeze({
    code: issueCode(value),
    path: issuePath(value),
    source: issueSource(value),
  });
}

function resultIssues(value: unknown): readonly CommandErrorIssue[] {
  if (value === null || typeof value !== "object") return Object.freeze([]);
  const candidate = ownDataValue(value, "issues");
  if (!Array.isArray(candidate)) return Object.freeze([]);
  return Object.freeze(candidate.slice(0, 16).map((entry) => safeIssue(entry)));
}

function commandErrorRecord(operation: string, issues: readonly CommandErrorIssue[]): object {
  return Object.freeze({
    contractVersion: STANDARDS_COMMAND_OUTPUT_CONTRACT_VERSION,
    issues: Object.freeze([...issues]),
    operation,
    recordKind: STANDARDS_COMMAND_ERROR_RECORD_KIND,
  });
}

function commandJsonValue(value: unknown, ancestors: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("standards output contains a non-finite number");
    return JSON.stringify(value);
  }
  if (typeof value !== "object" || nodeTypes.isProxy(value))
    throw new Error("standards output contains a non-JSON value");
  if (ancestors.has(value)) throw new Error("standards output contains a cycle");
  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null && prototype !== Array.prototype)
    throw new Error("standards output contains an exotic object");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const keys = Reflect.ownKeys(descriptors);
      const lengthDescriptor = Reflect.getOwnPropertyDescriptor(value, "length");
      if (
        lengthDescriptor === undefined ||
        !("value" in lengthDescriptor) ||
        typeof lengthDescriptor.value !== "number" ||
        !Number.isSafeInteger(lengthDescriptor.value) ||
        keys.length !== lengthDescriptor.value + 1 ||
        keys.some((key) => typeof key !== "string" || (key !== "length" && !/^\d+$/u.test(key)))
      )
        throw new Error("standards output contains an invalid array");
      const entries: string[] = [];
      for (let index = 0; index < lengthDescriptor.value; index += 1) {
        const descriptor = descriptors[String(index)];
        if (descriptor === undefined || !("value" in descriptor))
          throw new Error("standards output contains a sparse array");
        entries.push(commandJsonValue(descriptor.value, ancestors));
      }
      return `[${entries.join(",")}]`;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key !== "string"))
      throw new Error("standards output contains a symbol key");
    const encoded = (keys as string[])
      .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
      .map((key) => {
        const descriptor = descriptors[key];
        if (descriptor === undefined || !("value" in descriptor))
          throw new Error("standards output contains an accessor");
        return `${JSON.stringify(key)}:${commandJsonValue(descriptor.value, ancestors)}`;
      });
    return `{${encoded.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function serializeJson(value: unknown): string {
  return `${commandJsonValue(value, new Set())}\n`;
}

function artifactLine(
  label: string,
  artifact: Readonly<{ readonly digest: string; readonly version: string }> | null,
): string {
  return artifact === null
    ? `${label}: none`
    : `${label}: ${artifact.version} (${artifact.digest.slice(0, 16)})`;
}

function renderStatusTerminal(report: OfflineStandardsStatusReport): string {
  const output = report.output;
  const bundledAge = report.age.bundled;
  const lockedAge = report.age.locked;
  const problems = report.issues.map((issue) => issue.code);
  return [
    "Standards status",
    `Channel: ${output.channel}`,
    `Activation: ${output.activation}`,
    `Freshness: ${output.freshness}`,
    artifactLine("Bundled", output.bundled),
    artifactLine("Locked", output.locked),
    artifactLine("Cached latest", output.cachedLatest),
    `Bundled age: ${String(bundledAge.ageDays)} day(s), ${bundledAge.status} (maximum ${String(bundledAge.maximumAgeDays)})`,
    lockedAge === null
      ? "Locked age: none"
      : `Locked age: ${String(lockedAge.ageDays)} day(s), ${lockedAge.status} (maximum ${String(lockedAge.maximumAgeDays)})`,
    `Last checked: ${report.lastCheckedAt ?? "never"}`,
    `Problems: ${problems.length === 0 ? "none" : problems.join(", ")}`,
    "",
  ].join("\n");
}

function renderCheckTerminal(report: StandardsCheckReport): string {
  return [
    "Standards check",
    "Result: verified",
    `Checked at: ${report.checkedAt}`,
    `Target: ${report.target.packVersion} (${report.target.sha256.slice(0, 16)})`,
    `Requests: ${String(report.requestsAttempted)}`,
    `Root updates: ${String(report.recovery.rootVersionsApplied.length)}`,
    "",
  ].join("\n");
}

function renderUpdateTerminal(
  value: StandardsUpdatePlan | StandardsActivationReport,
  activated: boolean,
): string {
  const plan = "plan" in value ? value.plan : value;
  const lines = [
    activated ? "Standards update" : "Standards update (dry run)",
    `Result: ${activated ? (value as StandardsActivationReport).activation : "review"}`,
    `Current version: ${plan.diff.version.current}`,
    `Candidate version: ${plan.diff.version.candidate}`,
    `Current digest: ${plan.diff.digest.current}`,
    `Candidate digest: ${plan.diff.digest.candidate}`,
    `Engine requirement: ${plan.diff.engineRequirement.candidate}`,
    `Added rules: ${plan.diff.rules.added.length === 0 ? "none" : plan.diff.rules.added.join(", ")}`,
    `Removed rules: ${plan.diff.rules.removed.length === 0 ? "none" : plan.diff.rules.removed.join(", ")}`,
    `Signer: ${plan.signer.role}, threshold ${String(plan.signer.threshold)} of ${String(plan.signer.authorizedKeyCount)}`,
    `Changes: ${plan.noChanges ? "none" : "available"}`,
  ];
  if (activated) {
    const activation = value as StandardsActivationReport;
    lines.push(`Cache: ${activation.cache}`, `Lockfile: ${activation.write?.path ?? "unchanged"}`);
  }
  lines.push("");
  return lines.join("\n");
}

async function writeValue(
  context: CliCommandContext,
  value: StandardsCommandValue | object,
  terminal: string,
): Promise<void> {
  await context.writeStdout(context.format === "json" ? serializeJson(value) : terminal);
}

async function failCommand(
  context: CliCommandContext,
  operation: string,
  value?: unknown,
): Promise<{ readonly status: "operational-failure" }> {
  const issues = value === undefined ? Object.freeze([]) : resultIssues(value);
  if (context.format === "json")
    await context.writeStdout(serializeJson(commandErrorRecord(operation, issues)));
  await context.writeStderr(`agent-context-lint: standards ${operation} failed.\n`);
  return Object.freeze({ status: "operational-failure" });
}

async function readOptionalLock(
  repository: Awaited<ReturnType<typeof createReadOnlyRepository>>,
  lockPath: RepositoryRelativePath,
): Promise<RepositorySnapshot["lock"]> {
  try {
    const file = await repository.readFile(lockPath);
    return Object.freeze({ bytes: file.bytes(), identity: file.identity });
  } catch (error) {
    if (
      error instanceof ReadOnlyRepositoryError &&
      error.code === ReadOnlyRepositoryErrorCode.pathUnavailable
    )
      return null;
    throw error;
  }
}

async function repositorySnapshot(
  workingDirectory: string,
  signal: AbortSignal,
): Promise<RepositorySnapshot> {
  const selection = await selectRepositoryRoot(path.resolve(workingDirectory), {
    mode: "discover",
    signal,
  });
  const configurationResult = await resolveAgentContextConfiguration(selection.root);
  if (!configurationResult.ok) throw new Error("repository configuration is invalid");
  const configuration = configurationResult.value;
  const repository = await createReadOnlyRepository(selection, {
    maximumEntries: configuration.limits.maxFiles,
    maximumFileBytes: configuration.limits.maxFileBytes,
    maximumTotalBytes: configuration.limits.maxTotalBytes,
    maximumTraversalDepth: configuration.limits.maxTraversalDepth,
    signal,
  });
  return Object.freeze({
    configuration,
    lock: await readOptionalLock(repository, configuration.standards.lockfile),
    repositoryRoot: selection.root,
    selection,
  });
}

async function loadBundle(
  configuration: AgentContextConfiguration,
  engineVersion: string,
): Promise<LoadedBundledKnowledgePack> {
  const loaded = await loadBundledKnowledgePack({
    channel: configuration.standards.channel,
    engineVersion,
  });
  if (!loaded.ok) throw new Error("bundled standards are unavailable");
  if (getAuthenticatedBundledTrustStore(loaded.value) === undefined)
    throw new Error("bundled standards trust authority is unavailable");
  return loaded.value;
}

function currentPackText(bundle: LoadedBundledKnowledgePack): string {
  const serialized = serializeKnowledgePack(bundle.pack);
  if (!serialized.ok) throw new Error("bundled standards pack cannot be serialized");
  return serialized.text;
}

function cachePathInsideRepository(repositoryRoot: string, candidate: string): boolean {
  const relative = path.relative(repositoryRoot, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

async function runStatus(
  context: CliCommandContext,
  snapshot: RepositorySnapshot,
  bundle: LoadedBundledKnowledgePack,
  engineVersion: string,
  now: () => string,
): Promise<{ readonly status: "success" | "operational-failure" }> {
  const status = createOfflineStandardsStatus({
    asOf: now(),
    bundled: bundle,
    cachedLatest: null,
    engineVersion,
    lockfile: snapshot.lock?.bytes ?? null,
    maxAgeDays: snapshot.configuration.standards.maxAgeDays,
  });
  if (!status.ok) return failCommand(context, "status", status);
  await writeValue(context, status.value, renderStatusTerminal(status.value));
  return Object.freeze({ status: "success" });
}

async function runCheck(
  context: CliCommandContext,
  bundle: LoadedBundledKnowledgePack,
  engineVersion: string,
): Promise<{ readonly status: "success" | "operational-failure" }> {
  const trust = getAuthenticatedBundledTrustStore(bundle);
  if (trust === undefined) return failCommand(context, "check");
  const checker = StandardsChecker.create(trust);
  const result = await checker.check(
    {
      channel: bundle.provenance.channel,
      engineVersion,
      targetPath: bundle.provenance.target.targetPath,
    },
    { signal: context.signal },
  );
  if (!result.ok) return failCommand(context, "check", result);
  const report = Object.freeze({
    acquisitions: result.value.acquisitions,
    candidate: result.value.candidate,
    checkedAt: result.value.checkedAt,
    contractVersion: STANDARDS_COMMAND_OUTPUT_CONTRACT_VERSION,
    current: result.value.current,
    recovery: result.value.recovery,
    recordKind: STANDARDS_CHECK_RECORD_KIND,
    requestsAttempted: result.value.requestsAttempted,
    target: result.value.target,
  });
  await writeValue(context, report, renderCheckTerminal(result.value));
  return Object.freeze({ status: "success" });
}

async function runUpdate(
  context: CliCommandContext,
  snapshot: RepositorySnapshot,
  bundle: LoadedBundledKnowledgePack,
  engineVersion: string,
): Promise<{ readonly status: "success" | "operational-failure" }> {
  if (snapshot.lock === null) return failCommand(context, "update");
  const trust = getAuthenticatedBundledTrustStore(bundle);
  if (trust === undefined) return failCommand(context, "update");
  const currentPack = currentPackText(bundle);
  const request = {
    check: {
      channel: bundle.provenance.channel,
      engineVersion,
      targetPath: bundle.provenance.target.targetPath,
    },
    currentLockfile: snapshot.lock.bytes,
    currentPack,
  } as const;
  const updater = StandardsUpdater.create(StandardsChecker.create(trust));
  if (context.standardsDryRun) {
    const result = await updater.dryRun(request, { signal: context.signal });
    if (!result.ok) return failCommand(context, "update", result);
    await writeValue(context, result.value, renderUpdateTerminal(result.value, false));
    return Object.freeze({ status: "success" });
  }
  const cachePath = context.standardsCachePath;
  if (
    cachePath === null ||
    !EXACT_ABSOLUTE_PATH(cachePath) ||
    cachePath === path.parse(cachePath).root ||
    cachePathInsideRepository(snapshot.repositoryRoot, cachePath)
  )
    return failCommand(context, "update");
  const cache = await StandardsCache.open(cachePath);
  if (!cache.ok) return failCommand(context, "update", cache);
  const writer = await createAtomicRepositoryWriter(snapshot.selection, { signal: context.signal });
  const result = await updater.activate(request, {
    cache: cache.value,
    cacheLock: { maxAttempts: 20, retryDelayMs: 25 },
    expected: { identity: snapshot.lock.identity, sha256: digest(snapshot.lock.bytes) },
    path: snapshot.configuration.standards.lockfile,
    signal: context.signal,
    writer,
  });
  if (!result.ok) return failCommand(context, "update", result);
  await writeValue(context, result.value, renderUpdateTerminal(result.value, true));
  return Object.freeze({ status: "success" });
}

/** Install the H06/H08/H09 standards command. Construction performs no filesystem or network I/O. */
export function createStandardsCommandHandlers(
  optionsValue: StandardsCommandOptions,
): CliCommandHandlers {
  const workingDirectory = path.resolve(optionsValue.workingDirectory);
  const engineVersion = optionsValue.engineVersion ?? packageManifest.version;
  const now = optionsValue.now ?? exactNow;
  const standards: CliCommandHandler = async (context) => {
    const operation = context.operands[0];
    try {
      const snapshot = await repositorySnapshot(workingDirectory, context.signal);
      const bundle = await loadBundle(snapshot.configuration, engineVersion);
      if (operation === "status")
        return await runStatus(context, snapshot, bundle, engineVersion, now);
      if (operation === "check") return await runCheck(context, bundle, engineVersion);
      if (operation === "update") return await runUpdate(context, snapshot, bundle, engineVersion);
      return await failCommand(context, "command");
    } catch {
      return await failCommand(context, operation ?? "command");
    }
  };
  return Object.freeze({ standards });
}
