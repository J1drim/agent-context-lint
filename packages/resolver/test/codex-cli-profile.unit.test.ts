import { readFile } from "node:fs/promises";

import { canonicalizeRepositoryRelativePath } from "@agent-context/core";
import {
  IGNORE_ENGINE_DEFAULT_LIMITS,
  TRACKED_FILE_ENUMERATION_DEFAULT_LIMITS,
  buildTargetedDiscoveryIndex,
  type IgnoreEngineResult,
  type TrackedFileEnumerationResult,
} from "@agent-context/evidence";
import { profileGlobDialect } from "@agent-context/profiles";
import { describe, expect, test } from "vitest";

import {
  CodexCliProfileError,
  CodexCliProfileErrorCode,
  createCodexCliFallbackDiscoveryMatcherFacts,
  resolveCodexCliAgents,
  type CodexCliRepositoryEntryKind,
  type CodexCliRepositoryEntrySnapshot,
  type ResolveCodexCliAgentsInput,
} from "../src/index.js";

const FIXTURE = new URL(
  "../../../conformance/fixtures/v0/codex-cli-agents.fixture.json",
  import.meta.url,
);
const encoder = new TextEncoder();

interface FixtureEntry {
  readonly content?: string;
  readonly errorCode?: string;
  readonly kind: CodexCliRepositoryEntryKind;
  readonly path: string;
  readonly resolvedTarget?: string;
}

interface FixtureCase {
  readonly entries: readonly FixtureEntry[];
  readonly expected: {
    readonly issueCodes: readonly string[];
    readonly projectText: string;
    readonly rootState: string;
    readonly searchedDirectories: readonly string[];
    readonly selectedPaths: readonly string[];
  };
  readonly id: string;
  readonly launchCwd: string;
  readonly rootMarkerPaths: readonly string[];
  readonly settings: {
    readonly fallbacks: readonly string[];
    readonly maxBytes: number;
    readonly rootMarkers: readonly string[];
  };
  readonly targetPath: string;
}

function repositoryEntry(entry: FixtureEntry): CodexCliRepositoryEntrySnapshot {
  const readable = entry.kind === "file" || entry.kind === "internal-symlink";
  return {
    bytes: readable ? encoder.encode(entry.content ?? "") : null,
    errorCode: entry.kind === "unreadable-file" ? (entry.errorCode ?? "EIO") : null,
    kind: entry.kind,
    path: canonicalizeRepositoryRelativePath(entry.path),
    resolvedTarget:
      entry.kind === "internal-symlink"
        ? canonicalizeRepositoryRelativePath(entry.resolvedTarget ?? ".")
        : null,
  };
}

function request(overrides: Partial<ResolveCodexCliAgentsInput> = {}): ResolveCodexCliAgentsInput {
  return {
    discovery: {
      certainty: "known",
      entries: [],
      reason: "complete authorized test snapshot",
      rootMarkerPaths: [canonicalizeRepositoryRelativePath(".git")],
    },
    externalContext: { mode: "unavailable" },
    launchCwd: canonicalizeRepositoryRelativePath("."),
    settings: {
      projectDocFallbackFilenames: [],
      projectDocMaxBytes: 32_768,
      projectRootMarkers: [".git"],
    },
    targetPath: canonicalizeRepositoryRelativePath("."),
    ...overrides,
  };
}

async function fixtureCases(): Promise<readonly FixtureCase[]> {
  const parsed = JSON.parse(await readFile(FIXTURE, "utf8")) as {
    readonly cases: readonly FixtureCase[];
    readonly provenance: {
      readonly clientVersion: string;
      readonly observedDifferences: readonly string[];
      readonly retrievalDates: readonly string[];
      readonly sourceUrls: readonly string[];
    };
    readonly recordKind: string;
    readonly retrievedAt: string;
    readonly schemaVersion: number;
  };
  expect(parsed.recordKind).toBe("agent-context-codex-cli-agents-fixture");
  expect(parsed.schemaVersion).toBe(1);
  expect(parsed.retrievedAt).toBe("2026-08-02");
  expect(parsed.provenance.clientVersion).toBe("0.146.0");
  expect(parsed.provenance.retrievalDates).toEqual(["2026-08-01", "2026-08-02"]);
  expect(parsed.provenance.sourceUrls.every((url) => url.startsWith("https://"))).toBe(true);
  expect(parsed.provenance.observedDifferences.length).toBeGreaterThan(0);
  expect(new Set(parsed.cases.map((entry) => entry.id)).size).toBe(parsed.cases.length);
  return parsed.cases;
}

const cases = await fixtureCases();

describe("D03 Codex CLI conformance fixture", () => {
  test.each(cases)("resolves $id", (fixture) => {
    const result = resolveCodexCliAgents(
      request({
        discovery: {
          certainty: "known",
          entries: fixture.entries.map(repositoryEntry),
          reason: "complete fixture snapshot",
          rootMarkerPaths: fixture.rootMarkerPaths.map((path) =>
            canonicalizeRepositoryRelativePath(path),
          ),
        },
        launchCwd: canonicalizeRepositoryRelativePath(fixture.launchCwd),
        settings: {
          projectDocFallbackFilenames: fixture.settings.fallbacks,
          projectDocMaxBytes: fixture.settings.maxBytes,
          projectRootMarkers: fixture.settings.rootMarkers,
        },
        targetPath: canonicalizeRepositoryRelativePath(fixture.targetPath),
      }),
    );

    expect(result.root.state).toBe(fixture.expected.rootState);
    expect(result.searchedDirectories).toEqual(fixture.expected.searchedDirectories);
    expect(result.projectText).toBe(fixture.expected.projectText);
    expect(result.selected.map((entry) => entry.path)).toEqual(fixture.expected.selectedPaths);
    expect(result.issues.map((entry) => entry.code)).toEqual(fixture.expected.issueCodes);
    expect(result.discovery).toEqual({ certainty: "known", reason: "complete fixture snapshot" });
    expect(result.globDialectId).toBeNull();
    expect(result.semanticPrecedence).toBe("root-to-cwd-later-text-winner-unknown");
    expect(Object.isFrozen(result)).toBe(true);
  });
});

describe("D03 Codex profile composition", () => {
  test("uses explicit global context only and preserves the client separator", () => {
    const result = resolveCodexCliAgents(
      request({
        discovery: {
          certainty: "known",
          entries: [repositoryEntry({ kind: "file", path: "AGENTS.md", content: "project" })],
          reason: "complete",
          rootMarkerPaths: [canonicalizeRepositoryRelativePath(".git")],
        },
        externalContext: {
          mode: "supplied",
          globalBase: encoder.encode("base"),
          globalOverride: encoder.encode("override"),
        },
      }),
    );

    expect(result.externalContext).toMatchObject({
      byteLength: 8,
      decode: "utf8",
      source: "caller-supplied-global-override",
      state: "override",
      text: "override",
    });
    expect(result.externalContext.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.assembledText).toBe("override\n\n--- project-doc ---\n\nproject");
    expect(resolveCodexCliAgents(request()).externalContext.state).toBe("unavailable");
  });

  test("skips blank global override, falls through to base, and can select none", () => {
    const base = resolveCodexCliAgents(
      request({
        externalContext: {
          mode: "supplied",
          globalBase: encoder.encode("base"),
          globalOverride: encoder.encode(" \n"),
        },
      }),
    );
    const none = resolveCodexCliAgents(
      request({
        externalContext: { mode: "supplied", globalBase: null, globalOverride: null },
      }),
    );

    expect(base.externalContext).toMatchObject({
      byteLength: 4,
      decode: "utf8",
      source: "caller-supplied-global-base",
      state: "base",
      text: "base",
    });
    expect(none.externalContext).toEqual({
      byteLength: null,
      decode: "not-applicable",
      sha256: null,
      source: null,
      state: "none",
      text: null,
    });
  });

  test("uses a byte prefix even when the cap splits UTF-8", () => {
    const result = resolveCodexCliAgents(
      request({
        discovery: {
          certainty: "known",
          entries: [repositoryEntry({ kind: "file", path: "AGENTS.md", content: "é" })],
          reason: "complete",
          rootMarkerPaths: [canonicalizeRepositoryRelativePath(".git")],
        },
        settings: {
          projectDocFallbackFilenames: [],
          projectDocMaxBytes: 1,
          projectRootMarkers: [".git"],
        },
      }),
    );

    expect(result.projectText).toBe("�");
    expect(result.selected[0]).toMatchObject({ bytesIncluded: 1, truncated: true });
    expect(result.contributions[0]?.syntax?.decode).toBe("utf8-lossy-replacement");
  });

  test("does not charge a whitespace-only bounded prefix", () => {
    const result = resolveCodexCliAgents(
      request({
        discovery: {
          certainty: "known",
          entries: [
            repositoryEntry({ kind: "file", path: "AGENTS.md", content: "   root" }),
            repositoryEntry({ kind: "file", path: "child/AGENTS.md", content: "child" }),
          ],
          reason: "complete",
          rootMarkerPaths: [canonicalizeRepositoryRelativePath(".git")],
        },
        launchCwd: canonicalizeRepositoryRelativePath("child"),
        settings: {
          projectDocFallbackFilenames: [],
          projectDocMaxBytes: 3,
          projectRootMarkers: [".git"],
        },
      }),
    );

    expect(result.projectText).toBe("chi");
    expect(result.remainingProjectBytes).toBe(0);
    expect(result.selected).toEqual([
      expect.objectContaining({
        bytesIncluded: 0,
        path: "AGENTS.md",
        state: "bounded-prefix-empty-after-trim",
        truncated: true,
      }),
      expect.objectContaining({
        bytesIncluded: 3,
        path: "child/AGENTS.md",
        state: "included",
        truncated: true,
      }),
    ]);
  });

  test("marks uncertain discovery, unknown kinds, and case variants incomplete", () => {
    const result = resolveCodexCliAgents(
      request({
        discovery: {
          certainty: "uncertain",
          entries: [
            repositoryEntry({ kind: "unknown", path: "AGENTS.md" }),
            repositoryEntry({ kind: "file", path: "agents.md", content: "case variant" }),
          ],
          reason: "fallback enumeration",
          rootMarkerPaths: [canonicalizeRepositoryRelativePath(".git")],
        },
      }),
    );

    expect(result.analysisStatus).toBe("incomplete");
    expect(result.issues.map((entry) => entry.code)).toEqual([
      "discovery-uncertain",
      "filesystem-case-semantics-not-profiled",
      "selection-kind-unknown",
    ]);
  });

  test("keeps later candidate selection contingent after an unknown kind", () => {
    const result = resolveCodexCliAgents(
      request({
        discovery: {
          certainty: "known",
          entries: [
            repositoryEntry({ kind: "unknown", path: "AGENTS.override.md" }),
            repositoryEntry({ kind: "file", path: "AGENTS.md", content: "base" }),
          ],
          reason: "incomplete type evidence",
          rootMarkerPaths: [canonicalizeRepositoryRelativePath(".git")],
        },
      }),
    );

    expect(result.projectText).toBe("");
    expect(result.candidateDecisions).toEqual([
      expect.objectContaining({ path: "AGENTS.override.md", state: "selection-unknown" }),
      expect.objectContaining({ path: "AGENTS.md", state: "selection-contingent" }),
    ]);
    expect(result.issues).toEqual([expect.objectContaining({ code: "selection-kind-unknown" })]);
  });

  test("bounds syntax parsing independently from the larger profile byte cap", () => {
    const content = new Uint8Array(524_289).fill(0x61);
    const result = resolveCodexCliAgents(
      request({
        discovery: {
          certainty: "known",
          entries: [
            {
              bytes: content,
              errorCode: null,
              kind: "file",
              path: canonicalizeRepositoryRelativePath("AGENTS.md"),
              resolvedTarget: null,
            },
          ],
          reason: "complete",
          rootMarkerPaths: [canonicalizeRepositoryRelativePath(".git")],
        },
        settings: {
          projectDocFallbackFilenames: [],
          projectDocMaxBytes: content.byteLength,
          projectRootMarkers: [".git"],
        },
      }),
    );

    expect(result.contributions[0]?.syntax).toBeNull();
    expect(result.issues).toEqual([
      expect.objectContaining({ code: "syntax-resource-limit", path: "AGENTS.md" }),
    ]);
    expect(result.analysisStatus).toBe("incomplete");
  });

  test("composes configured fallbacks with C05 discovery facts", () => {
    const matcherFacts = createCodexCliFallbackDiscoveryMatcherFacts([
      "",
      "AGENTS.md",
      "TEAM.md",
      "TEAM.md",
    ]);
    const paths = ["TEAM.md"].map((path) => canonicalizeRepositoryRelativePath(path));
    const enumeration: TrackedFileEnumerationResult = {
      certainty: "tracked",
      indexObjectFormat: "sha1",
      indexVersion: 2,
      limits: TRACKED_FILE_ENUMERATION_DEFAULT_LIMITS,
      omittedProblems: 0,
      paths,
      problems: [],
      reason: "verified-git-index",
      source: "git-index",
    };
    const ignore: IgnoreEngineResult = {
      appliedProfileFactIds: [],
      certainty: "exact-tracked-input",
      deferredProfileFacts: [],
      ignored: [],
      limits: IGNORE_ENGINE_DEFAULT_LIMITS,
      omittedProblems: 0,
      paths,
      problems: [],
      profileCertainty: "known",
      profileFacts: [],
      rules: [],
      trackingCertainty: "tracked",
    };
    const index = buildTargetedDiscoveryIndex(enumeration, ignore, { matcherFacts });

    expect(matcherFacts).toHaveLength(1);
    expect(matcherFacts[0]?.matcher).toEqual({ kind: "basename", value: "TEAM.md" });
    expect(index.candidates[0]).toMatchObject({ kinds: ["instruction"], path: "TEAM.md" });
    expect(index.provenance.appliedMatcherFactIds).toEqual([matcherFacts[0]?.factId]);
  });

  test("does not borrow E02 glob behavior", () => {
    expect(profileGlobDialect(null as never)).toBeUndefined();
    expect(resolveCodexCliAgents(request()).globDialectId).toBeNull();
  });
});

describe("D03 hostile and malformed profile inputs", () => {
  test("rejects extra fields, proxies, accessors, Buffer values, and unsafe fallbacks", () => {
    const bytesWithExtra = encoder.encode("text");
    Object.defineProperty(bytesWithExtra, "extra", { enumerable: true, value: true });
    const malformedEntries: readonly unknown[] = [
      {
        bytes: bytesWithExtra,
        errorCode: null,
        kind: "file",
        path: "AGENTS.md",
        resolvedTarget: null,
      },
      {
        bytes: Buffer.from("text"),
        errorCode: null,
        kind: "file",
        path: "AGENTS.md",
        resolvedTarget: null,
      },
    ];
    for (const entry of malformedEntries)
      expect(() =>
        resolveCodexCliAgents(
          request({
            discovery: {
              certainty: "known",
              entries: [entry] as never,
              reason: "x",
              rootMarkerPaths: [canonicalizeRepositoryRelativePath(".git")],
            },
          }),
        ),
      ).toThrow(CodexCliProfileError);
    expect(() => resolveCodexCliAgents({ ...request(), extra: true } as never)).toThrow(
      CodexCliProfileError,
    );
    expect(() => resolveCodexCliAgents(new Proxy(request(), {}))).toThrow(CodexCliProfileError);
    expect(() =>
      resolveCodexCliAgents(
        request({
          settings: {
            projectDocFallbackFilenames: ["../TEAM.md"],
            projectDocMaxBytes: 1,
            projectRootMarkers: [".git"],
          },
        }),
      ),
    ).toThrow(expect.objectContaining({ code: CodexCliProfileErrorCode.invalidInput }));
  });

  test("rejects duplicate inventory paths and incoherent entry payloads", () => {
    const duplicate = repositoryEntry({ kind: "file", path: "AGENTS.md", content: "one" });
    expect(() =>
      resolveCodexCliAgents(
        request({
          discovery: {
            certainty: "known",
            entries: [duplicate, duplicate],
            reason: "x",
            rootMarkerPaths: [],
          },
        }),
      ),
    ).toThrow(CodexCliProfileError);
    expect(() =>
      resolveCodexCliAgents(
        request({
          discovery: {
            certainty: "known",
            entries: [{ ...duplicate, kind: "external-symlink" }],
            reason: "x",
            rootMarkerPaths: [],
          },
        }),
      ),
    ).toThrow(CodexCliProfileError);
    expect(() =>
      resolveCodexCliAgents(
        request({
          externalContext: { mode: "invalid" } as never,
        }),
      ),
    ).toThrow(CodexCliProfileError);
    expect(() =>
      resolveCodexCliAgents(
        request({
          settings: {
            projectDocFallbackFilenames: [],
            projectDocMaxBytes: -1,
            projectRootMarkers: [".git"],
          },
        }),
      ),
    ).toThrow(CodexCliProfileError);
  });

  test("fails closed across malformed records, arrays, paths, and entry variants", () => {
    const accessor = Object.defineProperty({}, "discovery", {
      enumerable: true,
      get: () => request().discovery,
    });
    for (const key of ["externalContext", "launchCwd", "settings", "targetPath"] as const)
      Object.defineProperty(accessor, key, { enumerable: true, value: request()[key] });
    const arrayWithExtra: string[] & { extra?: boolean } = [];
    arrayWithExtra.extra = true;
    const baseEntry = repositoryEntry({ kind: "file", path: "AGENTS.md", content: "text" });
    const malformed: readonly ResolveCodexCliAgentsInput[] = [
      accessor as ResolveCodexCliAgentsInput,
      request({
        launchCwd: "../outside" as never,
      }),
      request({
        settings: {
          projectDocFallbackFilenames: "TEAM.md" as never,
          projectDocMaxBytes: 1,
          projectRootMarkers: [".git"],
        },
      }),
      request({
        settings: {
          projectDocFallbackFilenames: Array.from(
            { length: 129 },
            (_, index) => `F${String(index)}.md`,
          ),
          projectDocMaxBytes: 1,
          projectRootMarkers: [".git"],
        },
      }),
      request({
        settings: {
          projectDocFallbackFilenames: arrayWithExtra,
          projectDocMaxBytes: 1,
          projectRootMarkers: [".git"],
        },
      }),
      request({
        settings: {
          projectDocFallbackFilenames: [1] as never,
          projectDocMaxBytes: 1,
          projectRootMarkers: [".git"],
        },
      }),
      request({
        discovery: {
          certainty: "known",
          entries: [],
          reason: "x",
          rootMarkerPaths: [
            canonicalizeRepositoryRelativePath(".git"),
            canonicalizeRepositoryRelativePath(".git"),
          ],
        },
      }),
      request({
        discovery: {
          certainty: "known",
          entries: [{ ...baseEntry, kind: "invented" as never }],
          reason: "x",
          rootMarkerPaths: [],
        },
      }),
      request({
        discovery: {
          certainty: "known",
          entries: [{ ...baseEntry, kind: "internal-symlink", resolvedTarget: null }],
          reason: "x",
          rootMarkerPaths: [],
        },
      }),
      request({
        discovery: {
          certainty: "known",
          entries: [
            {
              bytes: null,
              errorCode: "bad",
              kind: "unreadable-file",
              path: baseEntry.path,
              resolvedTarget: null,
            },
          ],
          reason: "x",
          rootMarkerPaths: [],
        },
      }),
      request({
        discovery: {
          certainty: "known",
          entries: [{ ...baseEntry, errorCode: "EIO" }],
          reason: "x",
          rootMarkerPaths: [],
        },
      }),
      request({
        discovery: null as never,
      }),
      request({
        externalContext: null as never,
      }),
      request({
        discovery: {
          certainty: "invented" as never,
          entries: [],
          reason: "x",
          rootMarkerPaths: [],
        },
      }),
    ];

    for (const input of malformed)
      expect(() => resolveCodexCliAgents(input)).toThrow(CodexCliProfileError);
  });

  test("bounds discovery reasons and derived candidate paths", () => {
    expect(() =>
      resolveCodexCliAgents(
        request({
          discovery: {
            certainty: "known",
            entries: [],
            reason: "x".repeat(16_385),
            rootMarkerPaths: [],
          },
        }),
      ),
    ).toThrow(expect.objectContaining({ code: CodexCliProfileErrorCode.resourceLimit }));

    const nearLimit = "a".repeat(16_380) as ResolveCodexCliAgentsInput["launchCwd"];
    expect(() =>
      resolveCodexCliAgents(
        request({
          launchCwd: nearLimit,
          settings: {
            projectDocFallbackFilenames: [],
            projectDocMaxBytes: 1,
            projectRootMarkers: [],
          },
        }),
      ),
    ).toThrow(expect.objectContaining({ code: CodexCliProfileErrorCode.resourceLimit }));
  });
});
