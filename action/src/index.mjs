import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  decodeSarifArtifactUri,
  sanitizeOutputText,
  validateSarifOutput,
} from "../../packages/core/src/index.ts";
import { runCommandRouter } from "../../packages/cli/src/command-router.ts";
import { createNodeGitMetadataExecutor } from "../../packages/cli/src/git-metadata-executor-production.ts";
import { createScanCommandHandlers } from "../../packages/cli/src/scan-command.ts";

const MAXIMUM_CAPTURE_BYTES = 64 * 1024 * 1024;
const MAXIMUM_INPUT_BYTES = 1_024;
const MAXIMUM_MESSAGE_BYTES = 4_096;
const RULE_ID = /^ACL[0-9]{3}$/u;
const SAFE_RELATIVE_PATH = /^(?![A-Za-z]:)(?!\/)(?!\\)(?:[^/\\]+)(?:\/(?:[^/\\]+))*$/u;
function actionDirectoryFromRuntime() {
  const runtimeDirectory =
    process.env.AGENT_CONTEXT_TRUSTED_ACTION_DIRECTORY ?? process.env.GITHUB_ACTION_PATH;
  if (typeof runtimeDirectory === "string" && path.isAbsolute(runtimeDirectory))
    return path.resolve(runtimeDirectory);
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

const ACTION_DIRECTORY = actionDirectoryFromRuntime();

function byteLength(value) {
  return Buffer.byteLength(value, "utf8");
}

function hasUnsafeText(value) {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return (
      codePoint !== undefined &&
      (codePoint <= 0x1f ||
        (codePoint >= 0x7f && codePoint <= 0x9f) ||
        codePoint === 0x061c ||
        codePoint === 0x200e ||
        codePoint === 0x200f ||
        (codePoint >= 0x202a && codePoint <= 0x202e) ||
        (codePoint >= 0x2066 && codePoint <= 0x2069) ||
        (codePoint >= 0xd800 && codePoint <= 0xdfff))
    );
  });
}

function boundedText(value, maximumBytes = MAXIMUM_MESSAGE_BYTES) {
  if (typeof value !== "string") return null;
  const sanitized = sanitizeOutputText(value);
  let output = "";
  for (const character of sanitized) {
    if (byteLength(output) + byteLength(character) > maximumBytes) break;
    output += character;
  }
  return output;
}

function input(environment, name, fallback) {
  const normalizedKey = `INPUT_${name.toUpperCase().replaceAll("-", "_")}`;
  const preservedKey = `INPUT_${name.toUpperCase()}`;
  const value = environment[normalizedKey] ?? environment[preservedKey] ?? fallback;
  if (typeof value !== "string" || byteLength(value) > MAXIMUM_INPUT_BYTES)
    throw new Error("invalid action input");
  if (hasUnsafeText(value)) throw new Error("invalid action input");
  return value;
}

function safeRelativePath(value) {
  return (
    value === "." ||
    (SAFE_RELATIVE_PATH.test(value) &&
      !hasUnsafeText(value) &&
      value.length <= 1_024 &&
      !value.split("/").some((segment) => segment === "." || segment === ".."))
  );
}

export function isPathWithinForTest(parent, candidate, pathApi = path) {
  const relative = pathApi.relative(parent, candidate);
  return (
    relative === "" ||
    (!pathApi.isAbsolute(relative) && !relative.startsWith(`..${pathApi.sep}`) && relative !== "..")
  );
}

async function requireOrdinaryPath(root, relativePath) {
  let current = root;
  for (const segment of relativePath.split("/")) {
    current = path.join(current, segment);
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) throw new Error("unsafe action path boundary");
  }
}

function boundaryError() {
  return new Error("unsafe action path boundary");
}

export async function validateActionPathBoundary(
  environment,
  workingDirectory,
  actionDirectory = ACTION_DIRECTORY,
) {
  const workspaceInput = environment.GITHUB_WORKSPACE;
  if (workspaceInput === undefined) return;
  if (typeof workspaceInput !== "string" || !path.isAbsolute(workspaceInput)) throw boundaryError();
  try {
    await requireOrdinaryPath(workspaceInput, workingDirectory);
  } catch {
    throw boundaryError();
  }
  let workspace;
  let action;
  let target;
  try {
    [workspace, action, target] = await Promise.all([
      realpath(workspaceInput),
      realpath(actionDirectory),
      realpath(path.resolve(workspaceInput, workingDirectory)),
    ]);
  } catch {
    throw boundaryError();
  }
  if (!isPathWithinForTest(workspace, target)) throw boundaryError();
  if (isPathWithinForTest(action, target)) throw boundaryError();
  if (isPathWithinForTest(target, action)) throw boundaryError();
}

function safeBase(value) {
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value);
}

export function parseActionInputs(environment) {
  const base = input(environment, "base", "");
  const changedText = input(environment, "changed", "false");
  const failOn = input(environment, "fail-on", "warning");
  const maximumText = input(environment, "max-annotations", "50");
  const workingDirectory = input(environment, "working-directory", ".");
  if (changedText !== "true" && changedText !== "false") throw new Error("invalid action input");
  const changed = changedText === "true";
  if ((changed && !safeBase(base)) || (!changed && base !== ""))
    throw new Error("invalid action input");
  if (failOn !== "error" && failOn !== "warning" && failOn !== "never")
    throw new Error("invalid action input");
  if (!/^(?:[1-9]|[1-4][0-9]|50)$/u.test(maximumText)) throw new Error("invalid action input");
  if (!safeRelativePath(workingDirectory)) throw new Error("invalid action input");
  return Object.freeze({
    base,
    changed,
    failOn,
    maximumAnnotations: Number(maximumText),
    workingDirectory,
  });
}

function capture() {
  let bytes = 0;
  let text = "";
  return {
    output: Object.freeze({
      write: async (chunk) => {
        if (typeof chunk !== "string") throw new Error("invalid scan output");
        bytes += byteLength(chunk);
        if (bytes > MAXIMUM_CAPTURE_BYTES) throw new Error("scan output limit exceeded");
        text += chunk;
      },
    }),
    text: () => text,
  };
}

function commandMessage(value) {
  return value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

function commandProperty(value) {
  return commandMessage(value).replaceAll(":", "%3A").replaceAll(",", "%2C");
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value >= 1 ? value : null;
}

function artifactPath(result) {
  const uri = result?.locations?.[0]?.physicalLocation?.artifactLocation?.uri;
  if (typeof uri !== "string") return null;
  const decoded = decodeSarifArtifactUri(uri);
  return decoded === undefined || decoded === "." || hasUnsafeText(decoded) ? null : decoded;
}

function annotation(result) {
  const path = artifactPath(result);
  const ruleId = result?.ruleId;
  const level = result?.level;
  const message = boundedText(result?.message?.text);
  const region = result?.locations?.[0]?.physicalLocation?.region;
  const line = positiveInteger(region?.startLine);
  const endLine = positiveInteger(region?.endLine);
  const column = positiveInteger(region?.startColumn);
  const endColumn = positiveInteger(region?.endColumn);
  if (
    path === null ||
    typeof ruleId !== "string" ||
    !RULE_ID.test(ruleId) ||
    (level !== "error" && level !== "warning" && level !== "note") ||
    message === null ||
    message.length === 0 ||
    line === null ||
    endLine === null ||
    endLine < line
  )
    return null;
  const kind = level === "note" ? "notice" : level;
  const properties = [
    `file=${commandProperty(path)}`,
    `line=${String(line)}`,
    `endLine=${String(endLine)}`,
    `title=${ruleId}`,
  ];
  if (line === endLine && column !== null && endColumn !== null && endColumn >= column) {
    properties.push(`col=${String(column)}`, `endColumn=${String(endColumn)}`);
  }
  return `::${kind} ${properties.join(",")}::${commandMessage(message)}`;
}

export function renderSarifAnnotations(source, maximumAnnotations) {
  if (typeof source !== "string" || byteLength(source) > MAXIMUM_CAPTURE_BYTES)
    throw new Error("invalid SARIF output");
  let document;
  try {
    document = JSON.parse(source);
  } catch {
    throw new Error("invalid SARIF output");
  }
  const validation = validateSarifOutput(document);
  if (!validation.ok) throw new Error("invalid SARIF output");
  const results = validation.value.runs[0].results;
  const commands = [];
  for (const result of results) {
    const rendered = annotation(result);
    if (rendered === null) throw new Error("invalid SARIF result");
    if (commands.length < maximumAnnotations) commands.push(rendered);
  }
  return Object.freeze({
    commands: Object.freeze(commands),
    emitted: commands.length,
    total: results.length,
  });
}

export function renderScanNotice(source) {
  if (source === "") return null;
  const match =
    /^agent-context-lint: changed-file mode used the full scan \(([a-z0-9-]{1,64})\)\.\n$/u.exec(
      source,
    );
  if (match?.[1] === undefined) throw new Error("invalid scan notice");
  return `::warning title=Agent Context Linter::Changed mode conservatively used a complete scan (${match[1]}).`;
}

function scanArguments(options) {
  const arguments_ = [
    "scan",
    options.workingDirectory,
    "--format",
    "sarif",
    "--fail-on",
    options.failOn,
  ];
  if (options.changed) arguments_.push("--changed", "--base", options.base);
  return Object.freeze(arguments_);
}

export async function runGithubAction({ environment, log, scan }) {
  let options;
  try {
    options = parseActionInputs(environment);
    await validateActionPathBoundary(environment, options.workingDirectory);
  } catch {
    log("::error title=Agent Context Linter::Invalid or inconsistent action inputs.");
    return 2;
  }
  const stdout = capture();
  const stderr = capture();
  let result;
  try {
    result = await scan(scanArguments(options), stdout.output, stderr.output);
  } catch {
    log("::error title=Agent Context Linter::The offline scan failed operationally.");
    return 2;
  }
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    log("::error title=Agent Context Linter::The offline scan failed operationally.");
    return result.exitCode === 130 ? 130 : 2;
  }
  let rendered;
  let scanNotice;
  try {
    rendered = renderSarifAnnotations(stdout.text(), options.maximumAnnotations);
    scanNotice = renderScanNotice(stderr.text());
  } catch {
    log("::error title=Agent Context Linter::The scan produced invalid annotation data.");
    return 2;
  }
  if (scanNotice !== null) log(scanNotice);
  for (const command of rendered.commands) log(command);
  log(
    `::notice title=Agent Context Linter::Scan reported ${String(rendered.total)} diagnostics; emitted ${String(rendered.emitted)} bounded annotations.`,
  );
  return result.exitCode;
}

async function productionScan(arguments_, stdout, stderr) {
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once("SIGINT", interrupt);
  try {
    return await runCommandRouter(
      Object.freeze({ argv: arguments_, signal: controller.signal, stderr, stdout }),
      createScanCommandHandlers({
        createGitMetadataExecutor: async (selection, signal) =>
          createNodeGitMetadataExecutor(selection, { signal }),
        environment: "ci",
        now: () => `${new Date().toISOString().slice(0, 10)}T00:00:00Z`,
        workingDirectory: process.cwd(),
      }),
    );
  } finally {
    process.off("SIGINT", interrupt);
  }
}

export async function main() {
  const exitCode = await runGithubAction({
    environment: process.env,
    log: (line) => process.stdout.write(`${line}\n`),
    scan: productionScan,
  });
  process.exitCode = exitCode;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
