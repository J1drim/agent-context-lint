import {
  canonicalizeRepositoryRelativePath,
  type RepositoryRelativePath,
  type ResolutionEventId,
} from "@agent-context/core";
import {
  READ_ONLY_REPOSITORY_DEFAULT_LIMITS,
  ReadOnlyRepositoryError,
  ReadOnlyRepositoryErrorCode,
  ReadOnlyRepositoryFile,
  loadImportGraph,
  type ReadOnlyRepository,
} from "@agent-context/evidence";
import { describe, expect, test } from "vitest";

import {
  EFFECTIVE_CONTEXT_CONTRACT_VERSION,
  EFFECTIVE_CONTEXT_INPUT_RECORD_KIND,
  EXPLAIN_PROJECTION_CONTRACT_VERSION,
  EXPLAIN_PROJECTION_INPUT_RECORD_KIND,
  EXPLAIN_PROJECTION_LIMITS,
  ExplainProjectionError,
  ExplainProjectionErrorCode,
  buildDocumentImportDag,
  createSyntheticTargetTrace,
  projectExplain,
  resolveCodexCliAgents,
  resolveCopilotProfile,
  resolveCursorProfile,
  resolveEffectiveContext,
  type CodexCliRepositoryEntryKind,
  type DocumentImportDag,
  type EffectiveContextProfileResolution,
  type EffectiveContextResolution,
  type ExplainProjection,
  type ResolutionEventTrace,
} from "../src/index.js";

const encoder = new TextEncoder();

function path(value: string): RepositoryRelativePath {
  return canonicalizeRepositoryRelativePath(value);
}

function eventId(value: string): ResolutionEventId {
  return value as ResolutionEventId;
}

interface Entry {
  readonly content?: string;
  readonly kind?: CodexCliRepositoryEntryKind;
  readonly path: string;
}

function codexProfile(
  targetPath: RepositoryRelativePath,
  entries: readonly Entry[] = [
    { content: "Root.\n", path: "AGENTS.md" },
    { content: "Child.\n", path: "src/AGENTS.md" },
  ],
  options: {
    readonly certainty?: "known" | "uncertain";
    readonly external?: "supplied" | "unavailable";
    readonly fallbacks?: readonly string[];
    readonly maximumBytes?: number;
  } = {},
): EffectiveContextProfileResolution {
  return resolveCodexCliAgents({
    discovery: {
      certainty: options.certainty ?? "known",
      entries: entries.map((entry) => {
        const kind = entry.kind ?? "file";
        return {
          bytes: kind === "file" ? encoder.encode(entry.content ?? "") : null,
          errorCode: kind === "unreadable-file" ? "EIO" : null,
          kind,
          path: path(entry.path),
          resolvedTarget: null,
        };
      }),
      reason: "complete explain fixture",
      rootMarkerPaths: [path(".git")],
    },
    externalContext:
      options.external === "unavailable"
        ? { mode: "unavailable" }
        : { globalBase: null, globalOverride: null, mode: "supplied" },
    launchCwd: path("src"),
    settings: {
      projectDocFallbackFilenames: options.fallbacks ?? [],
      projectDocMaxBytes: options.maximumBytes ?? 32_768,
      projectRootMarkers: [".git"],
    },
    targetPath,
  });
}

function context(
  profileResolution: EffectiveContextProfileResolution,
  targetPath: RepositoryRelativePath,
  importDags: readonly DocumentImportDag[] = [],
): EffectiveContextResolution {
  return resolveEffectiveContext({
    contractVersion: EFFECTIVE_CONTEXT_CONTRACT_VERSION,
    importDags,
    profileResolution,
    recordKind: EFFECTIVE_CONTEXT_INPUT_RECORD_KIND,
    targetPath,
  });
}

function explain(
  resolutions: readonly EffectiveContextResolution[],
  trace: unknown = null,
): ExplainProjection {
  return projectExplain({
    contractVersion: EXPLAIN_PROJECTION_CONTRACT_VERSION,
    recordKind: EXPLAIN_PROJECTION_INPUT_RECORD_KIND,
    resolutions,
    trace,
  });
}

function repository(sources: Readonly<Record<string, string>>): ReadOnlyRepository {
  return {
    limits: READ_ONLY_REPOSITORY_DEFAULT_LIMITS,
    root: "/fixture",
    inspect: () => Promise.reject(new Error("not used")),
    readDirectory: () => Promise.reject(new Error("not used")),
    readFile(value): ReturnType<ReadOnlyRepository["readFile"]> {
      const sourcePath = path(String(value));
      const source = sources[sourcePath];
      if (source === undefined)
        throw new ReadOnlyRepositoryError(
          ReadOnlyRepositoryErrorCode.pathUnavailable,
          "fixture source unavailable",
          "read-file",
          sourcePath,
        );
      return Promise.resolve(
        new ReadOnlyRepositoryFile(
          sourcePath,
          encoder.encode(source),
          { device: "fixture", inode: sourcePath },
          0,
        ),
      );
    },
    usage: () => ({ elapsedMs: 0, entries: 0, metadataOperations: 0, totalBytes: 0 }),
  };
}

function twoTargetTrace(): ResolutionEventTrace {
  return {
    contractVersion: "0.1.0",
    events: [
      {
        id: eventId("event:launch"),
        kind: "launch",
        path: path("."),
        sequence: 0,
        settings: [],
        targetId: "target:a" as never,
        uncertainty: { state: "known" },
        workspaceRoots: [path(".")],
      },
      {
        id: eventId("event:a"),
        kind: "read-path",
        path: path("src/a.ts"),
        sequence: 1,
        targetId: "target:a" as never,
        uncertainty: { state: "known" },
      },
      {
        id: eventId("event:b"),
        kind: "reference-path",
        path: path("src/b.ts"),
        sequence: 2,
        targetId: "target:b" as never,
        uncertainty: { reason: "client did not expose the exact reference", state: "unknown" },
      },
      {
        id: eventId("event:session"),
        kind: "memory-show",
        sequence: 3,
        targetId: null,
        uncertainty: { state: "known" },
      },
    ],
    recordKind: "agent-context-resolution-event-trace",
    rules: [],
    targets: [
      { id: "target:a" as never, path: path("src/a.ts"), purpose: "explain" },
      { id: "target:b" as never, path: path("src/b.ts"), purpose: "explain" },
    ],
  };
}

describe("E06 explain projection", () => {
  test("accounts for included and shadowed documents with stable reasons", () => {
    const target = path("src/main.ts");
    const resolution = context(
      codexProfile(
        target,
        [
          { content: "Root.\n", path: "AGENTS.md" },
          { content: "Fallback.\n", path: "FALLBACK.md" },
          { content: "Child.\n", path: "src/AGENTS.md" },
        ],
        { fallbacks: ["FALLBACK.md"] },
      ),
      target,
    );
    const result = explain([resolution]);

    expect(result).toMatchObject({
      clientVersion: "0.146.0",
      profileId: "codex-cli",
      profileVersion: "0.1.0",
      trace: { binding: "not-applicable", mode: "static", sha256: null },
    });
    expect(
      result.targets[0]?.documents.map((document) => [document.path, document.disposition]),
    ).toEqual([
      ["AGENTS.md", "included"],
      ["FALLBACK.md", "excluded"],
      ["src/AGENTS.md", "included"],
    ]);
    expect(result.targets[0]?.documents[1]?.reasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "activation-inactive", kind: "activation" }),
        expect.objectContaining({ code: "state-shadowed", kind: "selection" }),
      ]),
    );
    expect(result.targets[0]?.accounting.documents).toEqual({
      conditional: 0,
      excluded: 1,
      included: 2,
      total: 3,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.targets[0]?.documents[0]?.reasons)).toBe(true);
  });

  test("accounts for conditional, unavailable, empty, and truncated document states", () => {
    const target = path("src/main.ts");
    const conditional = context(
      codexProfile(
        target,
        [
          { kind: "unknown", path: "AGENTS.md" },
          { content: "Fallback.\n", path: "FALLBACK.md" },
        ],
        { certainty: "uncertain", external: "unavailable", fallbacks: ["FALLBACK.md"] },
      ),
      target,
    );
    const conditionalResult = explain([conditional]);
    expect(
      conditionalResult.targets[0]?.documents.every((entry) => entry.disposition === "conditional"),
    ).toBe(true);
    expect(conditionalResult.targets[0]?.documents[0]?.reasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "content-unavailable" }),
        expect.objectContaining({ code: "ambiguity-activation" }),
      ]),
    );

    const truncated = explain([
      context(
        codexProfile(target, [{ content: "   remainder", path: "AGENTS.md" }], {
          maximumBytes: 2,
        }),
        target,
      ),
    ]);
    expect(truncated.targets[0]?.documents[0]).toMatchObject({
      disposition: "included",
      state: "empty",
      truncation: "prefix",
    });
    expect(truncated.targets[0]?.documents[0]?.reasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "state-empty" }),
        expect.objectContaining({ code: "truncation-prefix" }),
      ]),
    );
  });

  test("sorts many targets deterministically and keeps every target's accounting separate", () => {
    const firstPath = path("src/a.ts");
    const secondPath = path("src/b.ts");
    const first = context(codexProfile(firstPath), firstPath);
    const second = context(codexProfile(secondPath), secondPath);
    const result = explain([second, first]);

    expect(result.targets.map((target) => target.targetPath)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(result.targets.every((target) => target.accounting.documents.total === 2)).toBe(true);
    expect(JSON.stringify(explain([second, first]))).toBe(JSON.stringify(result));
    expect(JSON.stringify(explain([first, second]))).toBe(JSON.stringify(result));
  });

  test("normalizes --trace input and projects target and session events", () => {
    const firstPath = path("src/a.ts");
    const secondPath = path("src/b.ts");
    const result = explain(
      [context(codexProfile(secondPath), secondPath), context(codexProfile(firstPath), firstPath)],
      structuredClone(twoTargetTrace()),
    );

    expect(result.trace).toMatchObject({
      binding: "target-matched",
      eventCount: 4,
      mode: "provided",
      targetCount: 2,
    });
    expect(result.trace.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.targets[0]?.traceEvents.map((event) => [event.id, event.scope])).toEqual([
      ["event:launch", "session"],
      ["event:a", "target"],
      ["event:session", "session"],
    ]);
    expect(result.targets[1]?.traceEvents[1]).toMatchObject({
      id: "event:b",
      uncertainty: "unknown",
    });
  });

  test("projects included, conditional, and excluded E04 import occurrences", async () => {
    const target = path("src/main.ts");
    const source = "@https://example.com/a\n@file.md,\n@a.md\n";
    const graph = await loadImportGraph({
      entryPath: path("AGENTS.md"),
      repository: repository({ "AGENTS.md": source, "a.md": "Imported.\n" }),
      syntax: "claude-code",
    });
    const dag = buildDocumentImportDag({
      graph,
      trace: createSyntheticTargetTrace({
        launchCwd: path("."),
        purpose: "explain",
        targetPath: target,
        workspaceRoots: [path(".")],
      }),
    });
    const resolution = context(
      codexProfile(target, [{ content: source, path: "AGENTS.md" }]),
      target,
      [dag],
    );
    const result = explain([resolution]);

    expect(result.targets[0]?.occurrences.map((entry) => [entry.state, entry.disposition])).toEqual(
      [
        ["entry", "included"],
        ["rejected", "excluded"],
        ["ambiguous", "conditional"],
        ["loaded", "included"],
      ],
    );
    expect(result.targets[0]?.accounting.occurrences).toEqual({
      conditional: 1,
      excluded: 1,
      included: 2,
      total: 4,
    });
    expect(result.targets[0]?.occurrences[2]?.reasons).toEqual([
      expect.objectContaining({ code: "import-ambiguous", kind: "import" }),
    ]);
  });

  test("rejects malformed envelopes, forged E05 results, sparse arrays, and excess targets", () => {
    const target = path("src/main.ts");
    const resolution = context(codexProfile(target), target);
    const base = {
      contractVersion: EXPLAIN_PROJECTION_CONTRACT_VERSION,
      recordKind: EXPLAIN_PROJECTION_INPUT_RECORD_KIND,
      resolutions: [resolution],
      trace: null,
    };
    const forged = structuredClone(resolution);
    const sparse = new Array(1);
    const unsafeArray = [resolution];
    Object.defineProperty(unsafeArray, "0", { enumerable: true, get: () => resolution });
    const accessor = { ...base } as Record<string, unknown>;
    Object.defineProperty(accessor, "trace", { enumerable: true, get: () => null });
    for (const malformed of [
      null,
      [],
      new Proxy(base, {}),
      { ...base, extra: true },
      { ...base, contractVersion: "9" },
      { ...base, resolutions: [] },
      { ...base, resolutions: [forged] },
      { ...base, resolutions: sparse },
      { ...base, resolutions: unsafeArray },
      accessor,
    ])
      expect(() => projectExplain(malformed)).toThrow(ExplainProjectionError);

    expect(() =>
      projectExplain({
        ...base,
        resolutions: new Array(EXPLAIN_PROJECTION_LIMITS.maximumTargets + 1).fill(resolution),
      }),
    ).toThrow(expect.objectContaining({ code: ExplainProjectionErrorCode.resourceLimit }));
  });

  test("rejects invalid/missing-target traces, duplicate targets, and mixed profiles", () => {
    const target = path("src/main.ts");
    const resolution = context(codexProfile(target), target);
    expect(() => explain([resolution], {})).toThrow(
      expect.objectContaining({ code: ExplainProjectionErrorCode.invalidTrace }),
    );
    expect(() => explain([resolution], twoTargetTrace())).toThrow(
      expect.objectContaining({ code: ExplainProjectionErrorCode.invalidRelationship }),
    );
    expect(() => explain([resolution, resolution])).toThrow(
      expect.objectContaining({ code: ExplainProjectionErrorCode.invalidRelationship }),
    );

    const copilot = resolveCopilotProfile({
      candidates: [
        {
          bytes: encoder.encode("Repository.\n"),
          format: "repository-wide",
          path: path(".github/copilot-instructions.md"),
        },
      ],
      profileId: "copilot-vscode",
      runtime: {
        applyingInstructions: "enabled",
        eventState: "present",
        instructionFolders: [{ path: path(".github/instructions"), workspaceRoot: path(".") }],
        kind: "copilot-vscode",
        manualAttachments: [],
        targetPaths: [target],
        workspaceRoots: [path(".")],
      },
    });
    expect(() => explain([resolution, context(copilot, target)])).toThrow(
      expect.objectContaining({ code: ExplainProjectionErrorCode.invalidRelationship }),
    );
  });

  test("fails before materializing an unbounded aggregate document explanation", () => {
    const candidates = Array.from({ length: 3_000 }, (_, index) => ({
      bytes: encoder.encode("---\nalwaysApply: true\n---\nPolicy.\n"),
      format: "mdc" as const,
      path: path(`.cursor/rules/r${index.toString().padStart(4, "0")}.mdc`),
    }));
    const profile = resolveCursorProfile({
      candidates,
      runtime: {
        clientVersion: "3.12.30",
        eventState: "absent",
        events: [],
        externalContext: "absent",
        projectRules: "disabled",
        surfaceId: "cursor-agent/ide",
        workspaceRoots: [path(".")],
      },
    });
    const resolutions = ["a", "b", "c"].map((name) => context(profile, path(`src/${name}.ts`)));
    expect(() => explain(resolutions)).toThrow(
      expect.objectContaining({ code: ExplainProjectionErrorCode.resourceLimit }),
    );
  });
});
