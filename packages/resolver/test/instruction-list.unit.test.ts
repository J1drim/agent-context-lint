import { readFile } from "node:fs/promises";

import type { RepositoryRelativePath } from "@agent-context/core";
import { describe, expect, it } from "vitest";

import {
  InstructionListError,
  buildInstructionList,
  type BuildInstructionListInput,
  type ClaudeCodeProfileResolution,
  type CodexCliAgentsResolution,
  type CopilotProfileResolution,
  type CursorProfileResolution,
  type GeminiCliCandidateSnapshot,
  type GeminiCliResolution,
} from "../src/index.js";

const path = (value: string): RepositoryRelativePath => value as RepositoryRelativePath;

function codex(): CodexCliAgentsResolution {
  return {
    candidateDecisions: [
      {
        candidateIndex: 1,
        candidateName: "AGENTS.md",
        directory: path("."),
        entryKind: "file",
        path: path("AGENTS.md"),
        state: "selected",
      },
      {
        candidateIndex: 1,
        candidateName: "AGENTS.md",
        directory: path("packages/api"),
        entryKind: "unknown",
        path: path("packages/api/AGENTS.md"),
        state: "selection-unknown",
      },
    ],
    contributions: [],
    profile: {
      clientVersion: "0.146.0",
      profileId: "codex-cli",
      surfaceId: "codex-cli/local-cli-single-cwd",
    },
  } as unknown as CodexCliAgentsResolution;
}

function claude(): ClaudeCodeProfileResolution {
  return {
    candidates: [
      {
        activation: "inactive",
        code: "invalid-syntax",
        loadState: "excluded",
        path: path(".claude/rules/broken.md"),
        reason: "Frontmatter paths metadata is malformed.",
        scopeRoot: path("."),
        syntax: { format: "claude-rule-markdown", state: "malformed" },
      },
    ],
    profile: {
      profileId: "claude-code",
      surfaceId: "claude-code/local-session",
    },
    runtime: { clientVersion: "2.1.217" },
  } as unknown as ClaudeCodeProfileResolution;
}

function copilot(): CopilotProfileResolution {
  return {
    candidates: [
      {
        activation: "inactive",
        code: "documented-not-discovered",
        discovery: "not-discovered",
        eligibility: "denied",
        format: "repository-wide",
        path: path("GEMINI.md"),
        reason: "Not discovered by this surface.",
        scopeRoot: null,
        syntax: { state: "complete" },
      },
    ],
    profile: {
      clientVersion: null,
      formats: [
        {
          formatId: "gemini-context-markdown",
          support: "not-listed",
        },
      ],
      profileId: "copilot-code-review",
      surfaceId: "copilot-code-review/github-hosted",
    },
  } as unknown as CopilotProfileResolution;
}

function cursor(): CursorProfileResolution {
  return {
    candidates: [
      {
        activation: "indeterminate",
        code: "unknown-surface-support",
        discovery: "documented",
        format: "legacy",
        path: path(".cursorrules"),
        reason: "Legacy rule support is unknown for this surface.",
        scopeRoot: path("."),
        syntax: { state: "complete" },
        versionState: "compatible",
      },
    ],
    profile: {
      clientVersion: "2026.05.24-dda726e",
      formats: [{ formatId: "cursor-legacy-rules", support: "unknown" }],
      profileId: "cursor-agent",
      surfaceId: "cursor-agent/cli",
    },
  } as unknown as CursorProfileResolution;
}

function gemini(): {
  candidates: readonly GeminiCliCandidateSnapshot[];
  resolution: GeminiCliResolution;
} {
  return {
    candidates: [
      { identity: "loaded", ignoredBy: [], kind: "file", path: path("GEMINI.md") },
      {
        identity: "ignored",
        ignoredBy: [".gitignore"],
        kind: "file",
        path: path("vendor/GEMINI.md"),
      },
      {
        identity: null,
        ignoredBy: [],
        kind: "unavailable",
        path: path("packages/web/GEMINI.md"),
      },
    ],
    resolution: {
      analysisStatus: "complete",
      documents: [
        {
          path: path("GEMINI.md"),
          phase: "static",
          state: "loaded",
          syntax: { document: { scopeRoot: path(".") }, issues: [] },
        },
      ],
      issues: [
        {
          code: "candidate-unavailable",
          path: path("packages/web/GEMINI.md"),
          reason: "Candidate content was unavailable in the authorized repository snapshot.",
        },
      ],
      profile: {
        clientVersion: "0.53.1",
        profileId: "gemini-cli",
        surfaceId: "gemini-cli/local-terminal",
      },
      trustState: "trusted",
      workspaceRoots: [path(".")],
    } as unknown as GeminiCliResolution,
  };
}

function input(): BuildInstructionListInput {
  return {
    claudeCode: [claude()],
    codexCli: [codex()],
    copilot: [copilot()],
    cursor: [cursor()],
    geminiCli: [gemini()],
  };
}

describe("buildInstructionList", () => {
  it("accounts for every profile candidate with deterministic states, scopes, and reasons", async () => {
    const result = buildInstructionList(input());
    const golden = await readFile(
      new URL("../../../tests/goldens/instruction-list-all-profiles.json", import.meta.url),
      "utf8",
    );
    expect(`${JSON.stringify(result, null, 2)}\n`).toBe(golden);
    expect(result.summary).toEqual({
      conditional: 3,
      ignored: 1,
      malformed: 1,
      recognized: 1,
      supported: 2,
      total: 8,
    });
  });

  it("is independent of family and candidate input order and returns immutable output", () => {
    const forward = buildInstructionList(input());
    const reversed = input();
    const reordered = buildInstructionList({
      geminiCli: reversed.geminiCli?.map((source) => ({
        ...source,
        candidates: [...source.candidates].reverse(),
      })),
      cursor: reversed.cursor,
      copilot: reversed.copilot,
      codexCli: reversed.codexCli?.map((resolution) => ({
        ...resolution,
        candidateDecisions: [...resolution.candidateDecisions].reverse(),
      })),
      claudeCode: reversed.claudeCode,
    });
    expect(reordered).toEqual(forward);
    expect(Object.isFrozen(forward)).toBe(true);
    expect(Object.isFrozen(forward.entries)).toBe(true);
    expect(forward.entries.every(Object.isFrozen)).toBe(true);
    expect(Object.isFrozen(forward.summary)).toBe(true);
  });

  it("rejects accessors, proxies, sparse arrays, unknown fields, duplicates, and excessive sources", () => {
    const accessor = {};
    Object.defineProperty(accessor, "codexCli", { get: () => [] });
    const sparse = { codexCli: new Array(1) };
    const duplicate = codex();
    const excessive = { codexCli: new Array(33).fill(codex()) };
    for (const candidate of [
      accessor,
      new Proxy({}, {}),
      sparse,
      { unexpected: [] },
      { codexCli: [duplicate, duplicate] },
      excessive,
    ]) {
      expect(() => buildInstructionList(candidate)).toThrow(InstructionListError);
    }
  });

  it("returns a complete empty summary when no profile snapshots are supplied", () => {
    expect(buildInstructionList({})).toEqual({
      contractVersion: "0.1.0",
      entries: [],
      recordKind: "agent-context-instruction-list",
      summary: {
        conditional: 0,
        ignored: 0,
        malformed: 0,
        recognized: 0,
        supported: 0,
        total: 0,
      },
    });
  });

  it("covers every closed profile projection branch without collapsing uncertainty", () => {
    const codexMatrix = {
      ...codex(),
      candidateDecisions: (
        [
          ["contingent/AGENTS.md", "selection-contingent"],
          ["shadowed/AGENTS.md", "shadowed"],
          ["broken/AGENTS.md", "skipped-broken-symlink"],
          ["directory/AGENTS.md", "skipped-not-file"],
          ["missing/AGENTS.md", "missing"],
          ["malformed/AGENTS.md", "selected"],
        ] as const
      ).map(([candidatePath, state]) => ({
        candidateIndex: 0,
        candidateName: "AGENTS.md",
        directory: path(candidatePath.slice(0, candidatePath.indexOf("/"))),
        entryKind: state === "missing" ? null : "file",
        path: path(candidatePath),
        state,
      })),
      contributions: [
        {
          path: path("malformed/AGENTS.md"),
          syntax: { issues: [{ code: "invalid-utf8" }] },
        },
      ],
    } as unknown as CodexCliAgentsResolution;

    const claudeMatrix = {
      ...claude(),
      candidates: (
        [
          ["active", "active"],
          ["unknown", "indeterminate"],
          ["inactive", "inactive"],
        ] as const
      ).map(([name, activation]) => ({
        activation,
        code: "documented-launch",
        loadState: activation === "active" ? "launch" : "on-demand-inactive",
        path: path(`claude/${name}.md`),
        reason: `${name} Claude state.`,
        scopeRoot: path("."),
        syntax: { format: "claude-memory-markdown", state: "complete" },
      })),
    } as unknown as ClaudeCodeProfileResolution;

    const copilotMatrix = {
      ...copilot(),
      candidates: (
        [
          [".github/instructions/a.instructions.md", "path-specific", "complete", "active"],
          ["AGENTS.md", "repository-wide", "complete", "inactive"],
          ["CLAUDE.md", "repository-wide", "complete", "indeterminate"],
          ["GEMINI.md", "repository-wide", "complete", "inactive"],
          ["other.md", "repository-wide", "complete", "inactive"],
          ["broken.instructions.md", "path-specific", "malformed", "inactive"],
        ] as const
      ).map(([candidatePath, format, syntaxState, activation]) => ({
        activation,
        code: syntaxState === "malformed" ? "malformed-syntax" : "documented-no-match",
        discovery: "documented",
        eligibility: "allowed",
        format,
        path: path(candidatePath),
        reason: `Copilot ${candidatePath} decision.`,
        scopeRoot: path("."),
        syntax: { state: syntaxState },
      })),
      profile: {
        ...copilot().profile,
        formats: [
          { formatId: "copilot-path-instructions", support: "supported" },
          { formatId: "agents-markdown", support: "conditional" },
          { formatId: "claude-memory-markdown", support: "supported" },
          { formatId: "gemini-context-markdown", support: "unknown" },
        ],
      },
    } as unknown as CopilotProfileResolution;

    const cursorMatrix = {
      ...cursor(),
      candidates: (
        [
          [".cursor/rules/active.mdc", "mdc", "complete", "active"],
          [".cursor/rules/unknown.mdc", "mdc", "complete", "indeterminate"],
          [".cursor/rules/inactive.mdc", "mdc", "complete", "inactive"],
          [".cursor/rules/broken.mdc", "mdc", "malformed", "inactive"],
          [".cursor/rules/unsupported.mdc", "mdc", "complete", "inactive"],
          ["nested/.cursorrules", "legacy", "complete", "inactive"],
        ] as const
      ).map(([candidatePath, format, syntaxState, activation]) => ({
        activation,
        code: syntaxState === "malformed" ? "malformed-syntax" : "always-event",
        discovery: "documented",
        format,
        path: path(candidatePath),
        reason: `Cursor ${candidatePath} decision.`,
        scopeRoot: path("."),
        syntax: { state: syntaxState },
        versionState: candidatePath.includes("unsupported") ? "unsupported" : "compatible",
      })),
      profile: {
        ...cursor().profile,
        formats: [{ formatId: "cursor-mdc", support: "supported" }],
      },
    } as unknown as CursorProfileResolution;

    const geminiBase = gemini();
    const geminiMatrix = {
      candidates: [
        { identity: "directory", ignoredBy: [], kind: "directory", path: path("nested") },
        { identity: "syntax", ignoredBy: [], kind: "file", path: path("nested/GEMINI.md") },
        { identity: "untrusted", ignoredBy: [], kind: "file", path: path("untrusted/GEMINI.md") },
      ],
      resolution: {
        ...geminiBase.resolution,
        documents: [
          {
            path: path("nested/GEMINI.md"),
            phase: "jit",
            state: "unavailable",
            syntax: { document: { scopeRoot: path("nested") }, issues: [], state: "malformed" },
          },
        ],
        issues: [{ code: "discovery-uncertain", path: null, reason: "global uncertainty" }],
        trustState: "untrusted",
        workspaceRoots: [path("."), path("nested")],
      } as unknown as GeminiCliResolution,
    };

    const result = buildInstructionList({
      claudeCode: [claudeMatrix],
      codexCli: [codexMatrix],
      copilot: [copilotMatrix],
      cursor: [cursorMatrix],
      geminiCli: [geminiMatrix],
    });
    expect(new Set(result.entries.map((item) => item.state))).toEqual(
      new Set(["conditional", "ignored", "malformed", "recognized", "supported"]),
    );
    expect(result.entries.some((item) => item.decisionCode === "untrusted-workspace")).toBe(true);
    expect(result.entries.some((item) => item.path === "missing/AGENTS.md")).toBe(false);
  });

  it("fails closed for unsupported object graphs and boundary-shaped input", () => {
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    const symbol = { [Symbol("hidden")]: true };
    let deep: Record<string, unknown> = {};
    for (let index = 0; index < 66; index += 1) deep = { nested: deep };
    for (const candidate of [
      null,
      [],
      new Uint8Array(),
      { codexCli: null },
      { codexCli: [new Date()] },
      { codexCli: [new Uint8Array()] },
      { codexCli: [(): undefined => undefined] },
      { codexCli: [cycle] },
      { codexCli: [symbol] },
      { codexCli: [deep] },
      {
        codexCli: [
          {
            candidateDecisions: [
              {
                candidateIndex: 0,
                candidateName: "AGENTS.md",
                directory: ".",
                entryKind: "file",
                path: 7,
                state: "selected",
              },
            ],
            contributions: [],
            profile: {
              clientVersion: "0.146.0",
              profileId: "codex-cli",
              surfaceId: "codex-cli/local-cli-single-cwd",
            },
          },
        ],
      },
    ]) {
      expect(() => buildInstructionList(candidate)).toThrow(InstructionListError);
    }
  });
});
