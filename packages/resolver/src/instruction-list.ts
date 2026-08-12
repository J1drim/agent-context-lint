import { isRepositoryRelativePath, type RepositoryRelativePath } from "@agent-context/core";
import { AGENTS_MARKDOWN_FORMAT_ID, GEMINI_CONTEXT_FORMAT_ID } from "@agent-context/syntax";

import type {
  ClaudeCodeProfileResolution,
  ClaudeCandidateDecision,
} from "./claude-code-profile.js";
import type { CodexCliAgentsResolution, CodexCliCandidateDecision } from "./codex-cli-profile.js";
import type { CopilotCandidateDecision, CopilotProfileResolution } from "./copilot-profile.js";
import type { CursorCandidateDecision, CursorProfileResolution } from "./cursor-profile.js";
import type { GeminiCliCandidateSnapshot, GeminiCliResolution } from "./gemini-cli-profile.js";

export const INSTRUCTION_LIST_CONTRACT_VERSION = "0.1.0" as const;

export const INSTRUCTION_LIST_LIMITS: Readonly<{
  maximumEntries: number;
  maximumInputNodes: number;
  maximumSourcesPerFamily: number;
  maximumTreeDepth: number;
}> = Object.freeze({
  maximumEntries: 100_000,
  maximumInputNodes: 1_000_000,
  maximumSourcesPerFamily: 32,
  maximumTreeDepth: 64,
});

export class InstructionListError extends Error {
  override readonly name = "InstructionListError" as const;
  readonly code: "INSTRUCTION_LIST_INVALID_INPUT" | "INSTRUCTION_LIST_RESOURCE_LIMIT";

  constructor(
    code: "INSTRUCTION_LIST_INVALID_INPUT" | "INSTRUCTION_LIST_RESOURCE_LIMIT",
    message: string,
  ) {
    super(message);
    this.code = code;
    Object.freeze(this);
  }
}

export type InstructionListState =
  "conditional" | "ignored" | "malformed" | "recognized" | "supported";

export interface GeminiInstructionListSource {
  readonly candidates: readonly GeminiCliCandidateSnapshot[];
  readonly resolution: GeminiCliResolution;
}

export interface BuildInstructionListInput {
  readonly claudeCode?: readonly ClaudeCodeProfileResolution[];
  readonly codexCli?: readonly CodexCliAgentsResolution[];
  readonly copilot?: readonly CopilotProfileResolution[];
  readonly cursor?: readonly CursorProfileResolution[];
  readonly geminiCli?: readonly GeminiInstructionListSource[];
}

export interface InstructionListEntry {
  readonly decisionCode: string;
  readonly formatId: string;
  readonly path: RepositoryRelativePath;
  readonly profileId: string;
  readonly profileVersion: string | null;
  readonly reason: string;
  readonly scopeRoot: RepositoryRelativePath | null;
  readonly sourceState: string;
  readonly state: InstructionListState;
  readonly surfaceId: string;
}

export interface InstructionListSummary {
  readonly conditional: number;
  readonly ignored: number;
  readonly malformed: number;
  readonly recognized: number;
  readonly supported: number;
  readonly total: number;
}

export interface InstructionListResult {
  readonly contractVersion: typeof INSTRUCTION_LIST_CONTRACT_VERSION;
  readonly entries: readonly InstructionListEntry[];
  readonly recordKind: "agent-context-instruction-list";
  readonly summary: InstructionListSummary;
}

function entry(value: InstructionListEntry): InstructionListEntry {
  return Object.freeze(value);
}

function isMalformedSyntax(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const syntax = value as {
    readonly issues?: readonly { readonly code?: string }[];
    readonly state?: string;
  };
  if (syntax.state === "malformed") return true;
  return syntax.issues?.some((issue) => issue.code === "invalid-utf8") === true;
}

function codexState(decision: CodexCliCandidateDecision): InstructionListState {
  switch (decision.state) {
    case "selected":
      return "supported";
    case "selection-contingent":
    case "selection-unknown":
      return "conditional";
    case "shadowed":
    case "skipped-broken-symlink":
    case "skipped-not-file":
      return "ignored";
    case "missing":
      return "ignored";
  }
}

function codexReason(decision: CodexCliCandidateDecision): string {
  switch (decision.state) {
    case "selected":
      return "Codex selected this document in the root-to-working-directory instruction chain.";
    case "selection-contingent":
      return "Codex selection depends on an earlier candidate whose file kind is unknown.";
    case "selection-unknown":
      return "Codex selection is conditional because discovery is uncertain.";
    case "shadowed":
      return "Codex ignored this document because an earlier candidate won in the same directory.";
    case "skipped-broken-symlink":
      return "Codex ignored this candidate because it is a broken symlink.";
    case "skipped-not-file":
      return "Codex ignored this candidate because it is not a readable instruction file.";
    case "missing":
      return "Codex did not find a file at this candidate location.";
  }
}

function addCodex(entries: InstructionListEntry[], resolution: CodexCliAgentsResolution): void {
  const syntaxByPath = new Map(resolution.contributions.map((item) => [item.path, item.syntax]));
  for (const decision of resolution.candidateDecisions) {
    // Missing candidate names are search evidence, not discovered files.
    if (decision.state === "missing") continue;
    const malformed = isMalformedSyntax(syntaxByPath.get(decision.path));
    entries.push(
      entry({
        decisionCode: malformed ? "invalid-syntax" : decision.state,
        formatId: AGENTS_MARKDOWN_FORMAT_ID,
        path: decision.path,
        profileId: resolution.profile.profileId,
        profileVersion: resolution.profile.clientVersion,
        reason: malformed
          ? "The selected AGENTS Markdown document contains malformed UTF-8."
          : codexReason(decision),
        scopeRoot: decision.directory,
        sourceState: decision.state,
        state: malformed ? "malformed" : codexState(decision),
        surfaceId: resolution.profile.surfaceId,
      }),
    );
  }
}

function claudeState(decision: ClaudeCandidateDecision): InstructionListState {
  if (decision.syntax.state === "malformed" || decision.code === "invalid-syntax") {
    return "malformed";
  }
  if (decision.activation === "active") return "supported";
  if (decision.activation === "indeterminate") return "conditional";
  return "ignored";
}

function addClaude(entries: InstructionListEntry[], resolution: ClaudeCodeProfileResolution): void {
  for (const decision of resolution.candidates) {
    entries.push(
      entry({
        decisionCode: decision.code,
        formatId: decision.syntax.format,
        path: decision.path,
        profileId: resolution.profile.profileId,
        profileVersion: resolution.runtime.clientVersion,
        reason: decision.reason,
        scopeRoot: decision.scopeRoot,
        sourceState: `${decision.activation}/${decision.loadState}`,
        state: claudeState(decision),
        surfaceId: resolution.profile.surfaceId,
      }),
    );
  }
}

function copilotState(
  resolution: CopilotProfileResolution,
  decision: CopilotCandidateDecision,
): InstructionListState {
  if (decision.syntax.state === "malformed" || decision.code === "malformed-syntax") {
    return "malformed";
  }
  const formatId = copilotFormatId(decision);
  const claim = resolution.profile.formats.find((format) => format.formatId === formatId);
  if (claim === undefined || claim.support === "not-listed") return "recognized";
  if (claim.support === "conditional" || claim.support === "unknown") return "conditional";
  if (decision.activation === "active") return "supported";
  if (decision.activation === "indeterminate") return "conditional";
  return "ignored";
}

function copilotFormatId(decision: CopilotCandidateDecision): string {
  if (decision.format === "path-specific") return "copilot-path-instructions";
  const basename = decision.path.slice(decision.path.lastIndexOf("/") + 1);
  if (basename === "AGENTS.md") return AGENTS_MARKDOWN_FORMAT_ID;
  if (basename === "CLAUDE.md") return "claude-memory-markdown";
  if (basename === "GEMINI.md") return GEMINI_CONTEXT_FORMAT_ID;
  return "copilot-repository-markdown";
}

function addCopilot(entries: InstructionListEntry[], resolution: CopilotProfileResolution): void {
  for (const decision of resolution.candidates) {
    const state = copilotState(resolution, decision);
    const formatId = copilotFormatId(decision);
    const reason =
      state === "recognized"
        ? `The ${resolution.profile.profileId} surface recognizes ${formatId} syntax, but its pinned support matrix does not list this format.`
        : decision.reason;
    entries.push(
      entry({
        decisionCode: decision.code,
        formatId,
        path: decision.path,
        profileId: resolution.profile.profileId,
        profileVersion: resolution.profile.clientVersion,
        reason,
        scopeRoot: decision.scopeRoot,
        sourceState: `${decision.discovery}/${decision.activation}/${decision.eligibility}`,
        state,
        surfaceId: resolution.profile.surfaceId,
      }),
    );
  }
}

function cursorState(
  resolution: CursorProfileResolution,
  decision: CursorCandidateDecision,
): InstructionListState {
  if (decision.syntax.state === "malformed" || decision.code === "malformed-syntax") {
    return "malformed";
  }
  if (decision.versionState === "unsupported") return "recognized";
  const claim = resolution.profile.formats.find(
    (format) => format.formatId === cursorFormatId(decision),
  );
  if (claim === undefined || claim.support === "unknown") return "conditional";
  if (decision.activation === "active") return "supported";
  if (decision.activation === "indeterminate") return "conditional";
  return "ignored";
}

function cursorFormatId(decision: CursorCandidateDecision): "cursor-legacy-rules" | "cursor-mdc" {
  return decision.format === "mdc" ? "cursor-mdc" : "cursor-legacy-rules";
}

function addCursor(entries: InstructionListEntry[], resolution: CursorProfileResolution): void {
  for (const decision of resolution.candidates) {
    entries.push(
      entry({
        decisionCode: decision.code,
        formatId: cursorFormatId(decision),
        path: decision.path,
        profileId: resolution.profile.profileId,
        profileVersion: resolution.profile.clientVersion,
        reason: decision.reason,
        scopeRoot: decision.scopeRoot,
        sourceState: `${decision.discovery}/${decision.activation}/${decision.versionState}`,
        state: cursorState(resolution, decision),
        surfaceId: resolution.profile.surfaceId,
      }),
    );
  }
}

function pathWithin(root: RepositoryRelativePath, path: RepositoryRelativePath): boolean {
  return root === "." || path === root || path.startsWith(`${root}/`);
}

function geminiScope(
  resolution: GeminiCliResolution,
  path: RepositoryRelativePath,
): RepositoryRelativePath | null {
  let selected: RepositoryRelativePath | null = null;
  for (const root of resolution.workspaceRoots) {
    if (pathWithin(root, path) && (selected === null || root.length > selected.length))
      selected = root;
  }
  return selected;
}

function addGemini(entries: InstructionListEntry[], source: GeminiInstructionListSource): void {
  const { candidates, resolution } = source;
  const documentByPath = new Map(resolution.documents.map((document) => [document.path, document]));
  const issueByPath = new Map(
    resolution.issues.flatMap((issue) =>
      issue.path === null ? [] : [[issue.path, issue] as const],
    ),
  );
  for (const candidate of candidates) {
    if (candidate.kind === "directory") continue;
    const document = documentByPath.get(candidate.path);
    const issue = issueByPath.get(candidate.path);
    const malformed = issue?.code === "syntax-failed" || isMalformedSyntax(document?.syntax);
    let state: InstructionListState;
    let code: string;
    let reason: string;
    if (malformed) {
      state = "malformed";
      code = "syntax-failed";
      reason = issue?.reason ?? "The Gemini context document contains malformed syntax.";
    } else if (candidate.ignoredBy.length > 0) {
      state = "ignored";
      code = "ignored-by-profile";
      reason = `Gemini ignored this document because it matched: ${candidate.ignoredBy.join(", ")}.`;
    } else if (document?.state === "loaded") {
      state = "supported";
      code = `loaded-${document.phase}`;
      reason = `Gemini loaded this document during the ${document.phase} context phase.`;
    } else if (
      candidate.kind === "unavailable" ||
      resolution.trustState === "unknown" ||
      resolution.analysisStatus === "partial"
    ) {
      state = "conditional";
      code = issue?.code ?? "runtime-state-unknown";
      reason =
        issue?.reason ??
        "Gemini activation is conditional because required runtime evidence is incomplete.";
    } else {
      state = "ignored";
      code = resolution.trustState === "untrusted" ? "untrusted-workspace" : "not-loaded";
      reason =
        resolution.trustState === "untrusted"
          ? "Gemini ignored repository context because the workspace is untrusted."
          : "Gemini did not load this recognized context document for the supplied event trace.";
    }
    entries.push(
      entry({
        decisionCode: code,
        formatId: GEMINI_CONTEXT_FORMAT_ID,
        path: candidate.path,
        profileId: resolution.profile.profileId,
        profileVersion: resolution.profile.clientVersion,
        reason,
        scopeRoot: document?.syntax?.document.scopeRoot ?? geminiScope(resolution, candidate.path),
        sourceState: document?.state ?? candidate.kind,
        state,
        surfaceId: resolution.profile.surfaceId,
      }),
    );
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareEntries(left: InstructionListEntry, right: InstructionListEntry): number {
  return (
    compareText(left.path, right.path) ||
    compareText(left.profileId, right.profileId) ||
    compareText(left.surfaceId, right.surfaceId) ||
    compareText(left.formatId, right.formatId) ||
    compareText(left.decisionCode, right.decisionCode)
  );
}

const INPUT_KEYS = new Set(["claudeCode", "codexCli", "copilot", "cursor", "geminiCli"]);

function invalid(message: string): never {
  throw new InstructionListError("INSTRUCTION_LIST_INVALID_INPUT", message);
}

function resourceLimit(message: string): never {
  throw new InstructionListError("INSTRUCTION_LIST_RESOURCE_LIMIT", message);
}

function assertSafeInputTree(value: unknown): asserts value is BuildInstructionListInput {
  const seen = new Set<object>();
  let nodes = 0;
  const visit = (item: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > INSTRUCTION_LIST_LIMITS.maximumInputNodes) {
      resourceLimit("Instruction list input exceeds the node limit");
    }
    if (depth > INSTRUCTION_LIST_LIMITS.maximumTreeDepth) {
      resourceLimit("Instruction list input exceeds the nesting limit");
    }
    if (
      item === null ||
      typeof item === "string" ||
      typeof item === "number" ||
      typeof item === "boolean" ||
      typeof item === "undefined"
    ) {
      return;
    }
    if (typeof item !== "object" || nodeTypes.isProxy(item)) {
      invalid("Instruction list input must contain only inert data");
    }
    if (item instanceof Uint8Array) return;
    if (seen.has(item)) invalid("Instruction list input must not contain cycles");
    seen.add(item);
    const prototype = Reflect.getPrototypeOf(item);
    if (prototype !== Object.prototype && prototype !== null && prototype !== Array.prototype) {
      invalid("Instruction list input contains an unsupported object type");
    }
    const keys = Reflect.ownKeys(item);
    if (keys.some((key) => typeof key === "symbol")) {
      invalid("Instruction list input must not contain symbol properties");
    }
    if (Array.isArray(item)) {
      if (item.length > INSTRUCTION_LIST_LIMITS.maximumInputNodes) {
        resourceLimit("Instruction list input array exceeds the item limit");
      }
      for (let index = 0; index < item.length; index += 1) {
        if (!Object.hasOwn(item, index)) invalid("Instruction list input arrays must be dense");
      }
    }
    for (const key of keys) {
      if (key === "length") continue;
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (descriptor === undefined || !("value" in descriptor)) {
        invalid("Instruction list input must not contain accessors");
      }
      visit(descriptor.value, depth + 1);
    }
    seen.delete(item);
  };
  visit(value, 0);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid("Instruction list input must be an object");
  }
  const rootPrototype = Reflect.getPrototypeOf(value);
  if (rootPrototype !== Object.prototype && rootPrototype !== null) {
    invalid("Instruction list input must be a plain object");
  }
  for (const key of Object.keys(value)) {
    if (!INPUT_KEYS.has(key)) invalid(`Unknown instruction list input field: ${key}`);
    const family = (value as Record<string, unknown>)[key];
    if (!Array.isArray(family)) invalid(`${key} must be an array`);
    if (family.length > INSTRUCTION_LIST_LIMITS.maximumSourcesPerFamily) {
      resourceLimit(`${key} exceeds the profile source limit`);
    }
  }
}

function assertUniqueEntries(entries: readonly InstructionListEntry[]): void {
  if (entries.length > INSTRUCTION_LIST_LIMITS.maximumEntries) {
    resourceLimit("Instruction list exceeds the entry limit");
  }
  const identities = new Set<string>();
  for (const item of entries) {
    const pathValue: unknown = item.path;
    const scopeRootValue: unknown = item.scopeRoot;
    if (
      typeof pathValue !== "string" ||
      !isRepositoryRelativePath(pathValue) ||
      (scopeRootValue !== null &&
        (typeof scopeRootValue !== "string" || !isRepositoryRelativePath(scopeRootValue)))
    ) {
      invalid("Instruction list profile resolution contains an invalid repository path");
    }
    for (const [name, value] of [
      ["decisionCode", item.decisionCode],
      ["formatId", item.formatId],
      ["profileId", item.profileId],
      ["reason", item.reason],
      ["sourceState", item.sourceState],
      ["surfaceId", item.surfaceId],
    ] as const) {
      const rawValue: unknown = value;
      if (typeof rawValue !== "string" || rawValue.length === 0 || rawValue.length > 16_384) {
        invalid(`Instruction list profile resolution contains an invalid ${name}`);
      }
    }
    const profileVersionValue: unknown = item.profileVersion;
    if (
      profileVersionValue !== null &&
      (typeof profileVersionValue !== "string" ||
        profileVersionValue.length === 0 ||
        profileVersionValue.length > 4_096)
    ) {
      invalid("Instruction list profile resolution contains an invalid profileVersion");
    }
    const stateValue: unknown = item.state;
    if (
      typeof stateValue !== "string" ||
      !["conditional", "ignored", "malformed", "recognized", "supported"].includes(stateValue)
    ) {
      invalid("Instruction list profile resolution contains an invalid state");
    }
    const identity = `${item.path}\0${item.profileId}\0${item.surfaceId}\0${item.formatId}`;
    if (identities.has(identity)) invalid(`Duplicate instruction list entry: ${item.path}`);
    identities.add(identity);
  }
}

/**
 * Projects the closed D03/D05/D08/D10/D13 profile decisions into one deterministic listing.
 * This function performs no discovery, filesystem access, network access, or command execution.
 */
export function buildInstructionList(rawInput: unknown): InstructionListResult {
  assertSafeInputTree(rawInput);
  const input = rawInput;
  const entries: InstructionListEntry[] = [];
  try {
    for (const resolution of input.codexCli ?? []) addCodex(entries, resolution);
    for (const resolution of input.claudeCode ?? []) addClaude(entries, resolution);
    for (const resolution of input.copilot ?? []) addCopilot(entries, resolution);
    for (const resolution of input.cursor ?? []) addCursor(entries, resolution);
    for (const source of input.geminiCli ?? []) addGemini(entries, source);
  } catch (error: unknown) {
    if (error instanceof InstructionListError) throw error;
    invalid("Instruction list input contains a malformed profile resolution");
  }
  assertUniqueEntries(entries);
  entries.sort(compareEntries);

  const summary = {
    conditional: 0,
    ignored: 0,
    malformed: 0,
    recognized: 0,
    supported: 0,
    total: entries.length,
  };
  for (const item of entries) summary[item.state] += 1;
  return Object.freeze({
    contractVersion: INSTRUCTION_LIST_CONTRACT_VERSION,
    entries: Object.freeze(entries),
    recordKind: "agent-context-instruction-list",
    summary: Object.freeze(summary),
  });
}
import { types as nodeTypes } from "node:util";
