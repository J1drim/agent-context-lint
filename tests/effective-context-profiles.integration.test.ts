import { readFile } from "node:fs/promises";

import {
  canonicalizeRepositoryRelativePath,
  type RepositoryRelativePath,
} from "../packages/core/dist/index.js";
import {
  READ_ONLY_REPOSITORY_DEFAULT_LIMITS,
  ReadOnlyRepositoryError,
  ReadOnlyRepositoryErrorCode,
  ReadOnlyRepositoryFile,
  type ReadOnlyRepository,
} from "../packages/evidence/dist/index.js";
import type { GeminiSettingsLayerInput } from "../packages/syntax/dist/index.js";
import { describe, expect, test } from "vitest";

import {
  EFFECTIVE_CONTEXT_CONTRACT_VERSION,
  EFFECTIVE_CONTEXT_INPUT_RECORD_KIND,
  resolveClaudeCodeProfile,
  resolveCodexCliAgents,
  resolveCopilotProfile,
  resolveCursorProfile,
  resolveEffectiveContext,
  resolveGeminiCliContext,
  type CursorRuntimeEvent,
  type EffectiveContextResolution,
  type EffectiveContextProfileResolution,
} from "../packages/resolver/dist/index.js";

interface FixtureFile {
  readonly content: string;
  readonly formatId: string | null;
  readonly path: string;
}

interface CodexFixture {
  readonly invocation: {
    readonly launchCwd: string;
    readonly settings: {
      readonly project_doc_max_bytes: number;
      readonly project_root_markers: readonly string[];
    };
  };
  readonly repository: { readonly files: readonly FixtureFile[] };
  readonly targets: readonly [{ readonly path: string }, ...{ readonly path: string }[]];
}

interface ClaudeFixture {
  readonly eventTrace: readonly {
    readonly id: string;
    readonly kind: "launch" | "read-path";
    readonly path: string;
  }[];
  readonly invocation: {
    readonly launchCwd: string;
    readonly settings: {
      readonly settingSources: readonly ("local" | "managed" | "project" | "user")[];
    };
  };
  readonly profile: { readonly clientVersion: string };
  readonly repository: { readonly files: readonly FixtureFile[] };
  readonly targets: readonly [{ readonly path: string }, ...{ readonly path: string }[]];
}

interface CopilotFixture {
  readonly repository: { readonly files: readonly FixtureFile[] };
  readonly targets: readonly [{ readonly path: string }, ...{ readonly path: string }[]];
}

interface GeminiFixture {
  readonly eventTrace: readonly {
    readonly id: string;
    readonly kind: "launch" | "read-path";
    readonly path: string;
  }[];
  readonly invocation: {
    readonly settings: {
      readonly "context.fileName": string;
      readonly "context.memoryBoundaryMarkers": readonly string[];
    };
  };
  readonly repository: {
    readonly directories: readonly string[];
    readonly files: readonly FixtureFile[];
  };
  readonly targets: readonly [{ readonly path: string }, ...{ readonly path: string }[]];
}

interface CursorFixtureCase {
  readonly event:
    "agent-rule-selection" | "manual-rule-mention" | "read-path" | "reference-path" | "write-path";
  readonly expectedActivation: "active" | "inactive" | "indeterminate";
  readonly format: "legacy" | "mdc";
  readonly id: string;
  readonly path: string;
  readonly source: string;
}

interface CursorFixture {
  readonly cases: readonly CursorFixtureCase[];
}

interface Golden {
  readonly cases: Readonly<{
    "claude-launch-read-rules": { readonly documentPaths: readonly string[] };
    "codex-root-order": {
      readonly assemblyText: string;
      readonly documentPaths: readonly string[];
      readonly ordering: "total";
    };
    "copilot-vscode-description-ambiguity": {
      readonly activation: "indeterminate";
      readonly documentPaths: readonly string[];
    };
    "cursor-stateful-profile": { readonly caseCount: number };
    "gemini-hierarchy-jit": {
      readonly documentPaths: readonly string[];
      readonly ordering: "total";
    };
  }>;
}

function fixtureUrl(name: string): URL {
  return new URL(`../conformance/fixtures/v0/${name}.fixture.json`, import.meta.url);
}
const GOLDEN = new URL("../conformance/fixtures/v0/effective-context.golden.json", import.meta.url);
const encoder = new TextEncoder();

function path(value: string): RepositoryRelativePath {
  return canonicalizeRepositoryRelativePath(value);
}

async function json<T>(url: URL): Promise<T> {
  return JSON.parse(await readFile(url, "utf8")) as T;
}

function effective(
  profileResolution: EffectiveContextProfileResolution,
  targetPath: string,
): EffectiveContextResolution {
  return resolveEffectiveContext({
    contractVersion: EFFECTIVE_CONTEXT_CONTRACT_VERSION,
    importDags: [],
    profileResolution,
    recordKind: EFFECTIVE_CONTEXT_INPUT_RECORD_KIND,
    targetPath: path(targetPath),
  });
}

function repository(
  files: readonly { readonly content: string; readonly path: string }[],
): ReadOnlyRepository {
  const sources = new Map(files.map((file) => [file.path, file.content]));
  return {
    limits: READ_ONLY_REPOSITORY_DEFAULT_LIMITS,
    root: "/conformance",
    inspect: () => Promise.reject(new Error("not used")),
    readDirectory: () => Promise.reject(new Error("not used")),
    readFile(value): ReturnType<ReadOnlyRepository["readFile"]> {
      const sourcePath = String(value);
      const source = sources.get(sourcePath);
      if (source === undefined)
        throw new ReadOnlyRepositoryError(
          ReadOnlyRepositoryErrorCode.pathUnavailable,
          "fixture source unavailable",
          "read-file",
          path(sourcePath),
        );
      return Promise.resolve(
        new ReadOnlyRepositoryFile(
          path(sourcePath),
          encoder.encode(source),
          { device: "fixture", inode: sourcePath },
          0,
        ),
      );
    },
    usage: () => ({ elapsedMs: 0, entries: 0, metadataOperations: 0, totalBytes: 0 }),
  };
}

describe("E05 canonical profile conformance", () => {
  test("reconstructs Codex, Claude, Copilot, Gemini, and Cursor fixture semantics", async () => {
    const golden = await json<Golden>(GOLDEN);

    const codexFixture = await json<CodexFixture>(fixtureUrl("codex-root-order"));
    const codexTarget = codexFixture.targets[0].path;
    const codex = effective(
      resolveCodexCliAgents({
        discovery: {
          certainty: "known",
          entries: codexFixture.repository.files
            .filter((file) => file.formatId === "agents-markdown")
            .map((file) => ({
              bytes: encoder.encode(file.content),
              errorCode: null,
              kind: "file" as const,
              path: path(file.path),
              resolvedTarget: null,
            })),
          reason: "canonical conformance fixture",
          rootMarkerPaths: [path(".git")],
        },
        externalContext: { mode: "unavailable" },
        launchCwd: path(codexFixture.invocation.launchCwd),
        settings: {
          projectDocFallbackFilenames: [],
          projectDocMaxBytes: codexFixture.invocation.settings.project_doc_max_bytes,
          projectRootMarkers: codexFixture.invocation.settings.project_root_markers,
        },
        targetPath: path(codexTarget),
      }),
      codexTarget,
    );
    expect(
      codex.documents.filter((entry) => entry.activation === "active").map((entry) => entry.path),
    ).toEqual(golden.cases["codex-root-order"].documentPaths);
    expect(codex.sequence).toEqual(codex.documents.map((entry) => entry.id));
    expect(codex.assembly.text).toBe(golden.cases["codex-root-order"].assemblyText);
    expect(codex.ordering).toBe(golden.cases["codex-root-order"].ordering);

    const claudeFixture = await json<ClaudeFixture>(fixtureUrl("claude-launch-read-rules"));
    const claudeTarget = claudeFixture.targets[0].path;
    const claude = effective(
      resolveClaudeCodeProfile({
        candidates: claudeFixture.repository.files
          .filter((file) => file.formatId !== null)
          .map((file) => ({
            absolutePath: `/repo/${file.path}`,
            bytes: encoder.encode(file.content),
            importGraph: null,
            kind: file.formatId === "claude-rule-markdown" ? "project-rule" : "memory-shared",
            origin: "repository",
            path: path(file.path),
            scopeRoot: path("."),
            symlinkState: "none",
          })),
        launchCwd: path(claudeFixture.invocation.launchCwd),
        repositoryRoot: path("."),
        runtime: {
          additionalDirectoryInstructions: "disabled",
          clientVersion: claudeFixture.profile.clientVersion,
          eventTrace: claudeFixture.eventTrace.map((event) => ({
            id: event.id,
            kind: event.kind === "read-path" ? "read" : event.kind,
            path: path(event.path),
          })),
          exclusions: { completeness: "complete", patterns: [], platformCase: "sensitive" },
          externalContext: "supplied",
          mode: "normal",
          settingSources: {
            state: "known",
            values: claudeFixture.invocation.settings.settingSources,
          },
        },
      }),
      claudeTarget,
    );
    expect(claude.documents.map((entry) => entry.path)).toEqual(
      golden.cases["claude-launch-read-rules"].documentPaths,
    );
    expect(claude.documents.every((entry) => entry.text !== null)).toBe(true);

    const copilotFixture = await json<CopilotFixture>(
      fixtureUrl("copilot-vscode-description-ambiguity"),
    );
    const copilotTarget = copilotFixture.targets[0].path;
    const copilot = effective(
      resolveCopilotProfile({
        candidates: copilotFixture.repository.files
          .filter((file) => file.formatId !== null)
          .map((file) => ({
            bytes: encoder.encode(file.content),
            format: "path-specific",
            path: path(file.path),
          })),
        profileId: "copilot-vscode",
        runtime: {
          applyingInstructions: "enabled",
          eventState: "present",
          instructionFolders: [{ path: path(".github/instructions"), workspaceRoot: path(".") }],
          kind: "copilot-vscode",
          manualAttachments: [],
          targetPaths: [path(copilotTarget)],
          workspaceRoots: [path(".")],
        },
      }),
      copilotTarget,
    );
    expect(copilot.documents.map((entry) => entry.path)).toEqual(
      golden.cases["copilot-vscode-description-ambiguity"].documentPaths,
    );
    expect(copilot.documents[0]?.activation).toBe(
      golden.cases["copilot-vscode-description-ambiguity"].activation,
    );

    const geminiFixture = await json<GeminiFixture>(fixtureUrl("gemini-hierarchy-jit"));
    const geminiTarget = geminiFixture.targets[0].path;
    const settings: GeminiSettingsLayerInput = {
      bytes: encoder.encode(
        JSON.stringify({
          context: {
            fileName: geminiFixture.invocation.settings["context.fileName"],
            memoryBoundaryMarkers:
              geminiFixture.invocation.settings["context.memoryBoundaryMarkers"],
          },
        }),
      ),
      kind: "workspace",
      path: path(".gemini/settings.json"),
      trustState: "trusted",
    };
    const gemini = effective(
      await resolveGeminiCliContext({
        boundaryMarkerDirectories: [path(".")],
        candidates: [
          ...geminiFixture.repository.directories.map((directory: string) => ({
            identity: `directory:${directory.replace(/\/$/u, "") || "."}`,
            ignoredBy: [],
            kind: "directory" as const,
            path: path(directory.replace(/\/$/u, "") || "."),
          })),
          ...geminiFixture.repository.files.map((file) => ({
            identity: `file:${file.path}`,
            ignoredBy: [],
            kind: "file" as const,
            path: path(file.path),
          })),
        ],
        events: geminiFixture.eventTrace.map((event) => ({
          id: event.id,
          kind: event.kind,
          path: path(event.path),
        })),
        externalContext: "unavailable",
        repository: repository(geminiFixture.repository.files),
        settingsLayers: [settings],
        trustState: "trusted",
        workspaceRoots: [path(".")],
      }),
      geminiTarget,
    );
    expect(gemini.documents.map((entry) => entry.path)).toEqual(
      golden.cases["gemini-hierarchy-jit"].documentPaths,
    );
    expect(gemini.ordering).toBe(golden.cases["gemini-hierarchy-jit"].ordering);

    const cursorFixture = await json<CursorFixture>(fixtureUrl("cursor-stateful-profile"));
    expect(cursorFixture.cases).toHaveLength(golden.cases["cursor-stateful-profile"].caseCount);
    for (const fixtureCase of cursorFixture.cases) {
      const candidatePath = path(fixtureCase.path);
      const targetPath = fixtureCase.path.startsWith("services/api/")
        ? path("services/api/index.ts")
        : path("src/index.ts");
      let event: CursorRuntimeEvent;
      if (fixtureCase.event === "manual-rule-mention")
        event = {
          candidatePath: null,
          kind: fixtureCase.event,
          ruleName: (fixtureCase.path.split("/").at(-1) ?? "rule").replace(/\.mdc$/u, ""),
          sequence: 1,
          targetPath,
        };
      else if (fixtureCase.event === "agent-rule-selection")
        event = {
          candidatePath,
          kind: fixtureCase.event,
          selection: "selected",
          sequence: 1,
          targetPath,
        };
      else event = { kind: fixtureCase.event, sequence: 1, targetPath };
      const cursor = effective(
        resolveCursorProfile({
          candidates: [
            {
              bytes: encoder.encode(fixtureCase.source),
              format: fixtureCase.format,
              path: candidatePath,
            },
          ],
          runtime: {
            clientVersion: "3.12.30",
            eventState: "present",
            events: [event],
            externalContext: "absent",
            projectRules: "enabled",
            surfaceId: "cursor-agent/ide",
            workspaceRoots: [path(".")],
          },
        }),
        targetPath,
      );
      expect(cursor.documents[0]?.activation, fixtureCase.id).toBe(fixtureCase.expectedActivation);
    }
  });
});
