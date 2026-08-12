import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  canonicalizeRepositoryRelativePath,
  type RepositoryRelativePath,
} from "@agent-context/core";
import {
  loadImportGraph,
  READ_ONLY_REPOSITORY_DEFAULT_LIMITS,
  ReadOnlyRepositoryError,
  ReadOnlyRepositoryErrorCode,
  ReadOnlyRepositoryFile,
  type ImportGraphResult,
  type ReadOnlyRepository,
} from "@agent-context/evidence";
import { describe, expect, test } from "vitest";

import {
  CLAUDE_CODE_PROFILE_LIMITS,
  ClaudeCodeProfileError,
  ClaudeCodeProfileErrorCode,
  resolveClaudeCodeProfile,
  type ClaudeInstructionCandidateSnapshot,
  type ClaudeRuntimeSnapshot,
  type ResolveClaudeCodeProfileInput,
} from "../src/index.js";

const encoder = new TextEncoder();
const CLAUDE_PROFILE_FIXTURE = fileURLToPath(
  new URL(
    "../../../conformance/fixtures/v0/claude-launch-read-rules.fixture.json",
    import.meta.url,
  ),
);

interface ClaudeProfileFixture {
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
  readonly repository: {
    readonly files: readonly {
      readonly content: string;
      readonly formatId: string | null;
      readonly path: string;
    }[];
  };
}

function path(value: string): RepositoryRelativePath {
  return canonicalizeRepositoryRelativePath(value);
}

function candidate(
  value: string,
  kind: ClaudeInstructionCandidateSnapshot["kind"],
  content = "Instructions.\n",
  overrides: Partial<ClaudeInstructionCandidateSnapshot> = {},
): ClaudeInstructionCandidateSnapshot {
  return {
    absolutePath: `/repo/${value}`,
    bytes: encoder.encode(content),
    importGraph: null,
    kind,
    origin: "repository",
    path: path(value),
    scopeRoot: path("."),
    symlinkState: "none",
    ...overrides,
  };
}

function runtime(overrides: Partial<ClaudeRuntimeSnapshot> = {}): ClaudeRuntimeSnapshot {
  return {
    additionalDirectoryInstructions: "disabled",
    clientVersion: "2.1.217",
    eventTrace: [{ id: "launch", kind: "launch", path: path("apps/api") }],
    exclusions: { completeness: "complete", patterns: [], platformCase: "sensitive" },
    externalContext: "supplied",
    mode: "normal",
    settingSources: { state: "known", values: ["local", "managed", "project", "user"] },
    ...overrides,
  };
}

function input(
  candidates: readonly ClaudeInstructionCandidateSnapshot[],
  runtimeValue = runtime(),
): ResolveClaudeCodeProfileInput {
  return {
    candidates,
    launchCwd: path("apps/api"),
    repositoryRoot: path("."),
    runtime: runtimeValue,
  };
}

function repository(sources: Readonly<Record<string, string>>): ReadOnlyRepository {
  return {
    limits: READ_ONLY_REPOSITORY_DEFAULT_LIMITS,
    root: "/fixture",
    inspect(): ReturnType<ReadOnlyRepository["inspect"]> {
      return Promise.reject(new Error("not used"));
    },
    readDirectory(): ReturnType<ReadOnlyRepository["readDirectory"]> {
      return Promise.reject(new Error("not used"));
    },
    readFile(value): ReturnType<ReadOnlyRepository["readFile"]> {
      const normalized = path(String(value));
      const source = sources[normalized];
      if (source === undefined)
        throw new ReadOnlyRepositoryError(
          ReadOnlyRepositoryErrorCode.pathUnavailable,
          "fixture path unavailable",
          "read-file",
          normalized,
        );
      return Promise.resolve(
        new ReadOnlyRepositoryFile(
          normalized,
          encoder.encode(source),
          { device: "fixture", inode: String(Object.keys(sources).indexOf(normalized) + 1) },
          0,
        ),
      );
    },
    usage(): ReturnType<ReadOnlyRepository["usage"]> {
      return { elapsedMs: 0, entries: 0, metadataOperations: 0, totalBytes: 0 };
    },
  };
}

describe("D05 Claude Code profile", () => {
  test("reconstructs the versioned launch/read/rules conformance fixture", async () => {
    const fixture = JSON.parse(
      await readFile(CLAUDE_PROFILE_FIXTURE, "utf8"),
    ) as ClaudeProfileFixture;
    const candidates = fixture.repository.files
      .filter((entry) => entry.formatId !== null)
      .map((entry) =>
        candidate(
          entry.path,
          entry.formatId === "claude-rule-markdown" ? "project-rule" : "memory-shared",
          entry.content,
        ),
      );
    const result = resolveClaudeCodeProfile({
      candidates,
      launchCwd: path(fixture.invocation.launchCwd),
      repositoryRoot: path("."),
      runtime: runtime({
        clientVersion: fixture.profile.clientVersion,
        eventTrace: fixture.eventTrace.map((entry) =>
          entry.kind === "launch"
            ? { id: entry.id, kind: "launch" as const, path: path(entry.path) }
            : { id: entry.id, kind: "read" as const, path: path(entry.path) },
        ),
        settingSources: {
          state: "known",
          values: fixture.invocation.settings.settingSources,
        },
      }),
    });

    expect(result.analysisStatus).toBe("complete");
    expect(result.candidates.find((entry) => entry.path === "CLAUDE.md")).toMatchObject({
      activation: "active",
      loadState: "launch",
    });
    expect(result.candidates.find((entry) => entry.path === "other/CLAUDE.md")).toMatchObject({
      activatedBy: ["event-read-other"],
      activation: "active",
      loadState: "on-demand-active",
      orderAfter: ["CLAUDE.md"],
    });
    expect(
      result.candidates.find((entry) => entry.path === ".claude/rules/other-typescript.md"),
    ).toMatchObject({
      activatedBy: ["event-read-other"],
      activation: "active",
      loadState: "on-demand-active",
    });
  });

  test("loads ancestor memory in documented order and keeps sibling order unresolved", () => {
    const result = resolveClaudeCodeProfile(
      input([
        candidate("other/CLAUDE.md", "memory-shared"),
        candidate("apps/CLAUDE.md", "memory-shared"),
        candidate("CLAUDE.local.md", "memory-local"),
        candidate("CLAUDE.md", "memory-shared"),
        candidate(".claude/CLAUDE.md", "memory-alternate"),
      ]),
    );
    expect(result.candidates.map((entry) => [entry.path, entry.activation])).toEqual([
      [".claude/CLAUDE.md", "active"],
      ["CLAUDE.local.md", "active"],
      ["CLAUDE.md", "active"],
      ["apps/CLAUDE.md", "active"],
      ["other/CLAUDE.md", "inactive"],
    ]);
    expect(result.candidates.find((entry) => entry.path === "CLAUDE.local.md")?.orderAfter).toEqual(
      ["CLAUDE.md"],
    );
    expect(result.candidates.find((entry) => entry.path === "apps/CLAUDE.md")?.orderAfter).toEqual([
      "CLAUDE.local.md",
      "CLAUDE.md",
    ]);
    expect(result.unresolvedOrdering).toHaveLength(1);
    expect(result.analysisStatus).toBe("partial");
  });

  test("activates descendants on read and models compact reinjection without inventing state", () => {
    const descendant = candidate("other/CLAUDE.md", "memory-shared");
    const active = resolveClaudeCodeProfile(
      input(
        [descendant],
        runtime({
          eventTrace: [
            { id: "launch", kind: "launch", path: path("apps/api") },
            { id: "read-other", kind: "read", path: path("other/x.ts") },
          ],
        }),
      ),
    );
    expect(active.candidates[0]).toMatchObject({
      activatedBy: ["read-other"],
      activation: "active",
      loadState: "on-demand-active",
    });

    const compacted = resolveClaudeCodeProfile(
      input(
        [candidate("CLAUDE.md", "memory-shared"), descendant],
        runtime({
          eventTrace: [
            { id: "launch", kind: "launch", path: path("apps/api") },
            { id: "read-other", kind: "read", path: path("other/x.ts") },
            { id: "compact", kind: "compact", path: null },
          ],
        }),
      ),
    );
    expect(compacted.candidates[0]).toMatchObject({ activation: "active", loadState: "launch" });
    expect(compacted.candidates[1]).toMatchObject({
      activation: "indeterminate",
      loadState: "unknown",
    });
  });

  test("separates unconditional and path-scoped rule activation", () => {
    const result = resolveClaudeCodeProfile(
      input(
        [
          candidate(".claude/rules/always.md", "project-rule"),
          candidate(
            ".claude/rules/typescript.md",
            "project-rule",
            "---\npaths:\n  - src/**/*.{ts,tsx}\n  - '*.md'\n---\nRule\n",
          ),
        ],
        runtime({
          eventTrace: [
            { id: "launch", kind: "launch", path: path("apps/api") },
            { id: "read-doc", kind: "read", path: path("docs/README.md") },
            { id: "read-source", kind: "read", path: path("src/api.ts") },
          ],
        }),
      ),
    );
    expect(result.candidates[0]).toMatchObject({ activation: "active", loadState: "launch" });
    expect(result.candidates[1]).toMatchObject({
      activatedBy: ["read-source"],
      activation: "active",
      loadState: "on-demand-active",
    });

    const inactive = resolveClaudeCodeProfile(
      input([
        candidate(
          ".claude/rules/typescript.md",
          "project-rule",
          "---\npaths: src/**/*.ts\n---\nRule\n",
        ),
      ]),
    );
    expect(inactive.candidates[0]).toMatchObject({
      activation: "inactive",
      loadState: "on-demand-inactive",
    });
  });

  test("applies runtime modes and versioned setting-source behavior", () => {
    const values = [
      candidate("CLAUDE.md", "memory-shared"),
      candidate("CLAUDE.local.md", "memory-local"),
      candidate(".claude/rules/a.md", "project-rule"),
    ];
    expect(
      resolveClaudeCodeProfile(input(values, runtime({ mode: "safe" }))).candidates.map(
        (entry) => entry.code,
      ),
    ).toEqual(["safe-mode", "safe-mode", "safe-mode"]);
    expect(
      resolveClaudeCodeProfile(input(values, runtime({ mode: "bare" }))).candidates[0]?.code,
    ).toBe("bare-mode");
    const filtered = resolveClaudeCodeProfile(
      input(values, runtime({ settingSources: { state: "known", values: ["managed", "user"] } })),
    );
    expect(filtered.candidates.find((entry) => entry.kind === "memory-local")?.code).toBe(
      "local-source-disabled",
    );
    expect(filtered.candidates.find((entry) => entry.kind === "project-rule")?.code).toBe(
      "project-rules-source-disabled",
    );

    const unversioned = resolveClaudeCodeProfile(
      input(
        [candidate(".claude/rules/a.md", "project-rule")],
        runtime({
          clientVersion: null,
          settingSources: { state: "known", values: ["managed", "user"] },
        }),
      ),
    );
    expect(unversioned.candidates[0]).toMatchObject({
      activation: "indeterminate",
      code: "unknown-version",
      versionBranch: "unversioned",
    });
  });

  test("keeps legacy brace behavior and unknown invocation state indeterminate", () => {
    const rule = candidate(
      ".claude/rules/typescript.md",
      "project-rule",
      "---\npaths: src/**/*.{ts,tsx}\n---\nRule\n",
    );
    expect(
      resolveClaudeCodeProfile(input([rule], runtime({ clientVersion: "2.1.216" }))).candidates[0],
    ).toMatchObject({ activation: "indeterminate", code: "legacy-client-risk" });
    expect(
      resolveClaudeCodeProfile(
        input([candidate("CLAUDE.md", "memory-shared")], runtime({ mode: "unknown" })),
      ).candidates[0],
    ).toMatchObject({ activation: "indeterminate", code: "unknown-runtime" });
    expect(
      resolveClaudeCodeProfile(
        input(
          [rule],
          runtime({
            clientVersion: null,
            eventTrace: [
              { id: "launch", kind: "launch", path: path("apps/api") },
              { id: "read", kind: "read", path: path("src/api.ts") },
            ],
          }),
        ),
      ).candidates[0],
    ).toMatchObject({ activation: "indeterminate", code: "unknown-version" });

    const invalidBracket = candidate(
      ".claude/rules/invalid.md",
      "project-rule",
      "---\npaths: src/[abc.ts\n---\nRule\n",
    );
    const readInvalid = {
      eventTrace: [
        { id: "launch", kind: "launch" as const, path: path("apps/api") },
        { id: "read", kind: "read" as const, path: path("src/abc.ts") },
      ],
    };
    expect(
      resolveClaudeCodeProfile(
        input([invalidBracket], runtime({ ...readInvalid, clientVersion: "2.1.206" })),
      ).candidates[0],
    ).toMatchObject({ activation: "indeterminate", code: "legacy-client-risk" });
    expect(
      resolveClaudeCodeProfile(
        input([invalidBracket], runtime({ ...readInvalid, clientVersion: "2.1.207" })),
      ).candidates[0],
    ).toMatchObject({ activation: "inactive", code: "documented-on-demand-inactive" });

    const dotfile = candidate(
      ".claude/rules/markdown.md",
      "project-rule",
      "---\npaths: '*.md'\n---\nRule\n",
    );
    expect(
      resolveClaudeCodeProfile(
        input(
          [dotfile],
          runtime({
            eventTrace: [
              { id: "launch", kind: "launch", path: path("apps/api") },
              { id: "read-hidden", kind: "read", path: path(".hidden.md") },
            ],
          }),
        ),
      ).candidates[0],
    ).toMatchObject({ activation: "indeterminate", code: "unknown-runtime" });
  });

  test("models additional-directory opt-in and local-source filtering", () => {
    const additional = candidate("shared/CLAUDE.md", "memory-shared", "Shared.\n", {
      absolutePath: "/shared/CLAUDE.md",
      origin: "additional-directory",
      scopeRoot: path("shared"),
    });
    expect(resolveClaudeCodeProfile(input([additional])).candidates[0]?.code).toBe(
      "additional-directory-disabled",
    );
    expect(
      resolveClaudeCodeProfile(
        input([additional], runtime({ additionalDirectoryInstructions: "unknown" })),
      ).candidates[0]?.activation,
    ).toBe("indeterminate");
    expect(
      resolveClaudeCodeProfile(
        input(
          [additional],
          runtime({
            additionalDirectoryInstructions: "enabled",
            eventTrace: [
              { id: "launch", kind: "launch", path: path("apps/api") },
              { id: "read", kind: "read", path: path("shared/file.ts") },
            ],
          }),
        ),
      ).candidates[0],
    ).toMatchObject({ activation: "active", code: "documented-on-demand" });
  });

  test("applies only documented absolute exclusion subsets and preserves uncertainty", () => {
    const memory = candidate("CLAUDE.md", "memory-shared");
    const exact = resolveClaudeCodeProfile(
      input(
        [memory],
        runtime({
          exclusions: {
            completeness: "complete",
            patterns: ["/repo/CLAUDE.md"],
            platformCase: "sensitive",
          },
        }),
      ),
    );
    expect(exact.candidates[0]).toMatchObject({
      code: "excluded-by-setting",
      loadState: "excluded",
    });

    const rule = candidate(".claude/rules/a.md", "project-rule");
    const subtree = resolveClaudeCodeProfile(
      input(
        [rule],
        runtime({
          exclusions: {
            completeness: "complete",
            patterns: ["/repo/.claude/rules/**"],
            platformCase: "sensitive",
          },
        }),
      ),
    );
    expect(subtree.candidates[0]?.code).toBe("excluded-by-setting");

    const unknown = resolveClaudeCodeProfile(
      input(
        [memory],
        runtime({
          exclusions: {
            completeness: "partial",
            patterns: ["relative/**"],
            platformCase: "unknown",
          },
        }),
      ),
    );
    expect(unknown.candidates[0]).toMatchObject({
      activation: "indeterminate",
      code: "unknown-exclusion",
    });

    const unsupported = resolveClaudeCodeProfile(
      input(
        [memory],
        runtime({
          exclusions: {
            completeness: "complete",
            patterns: ["/repo/**/CLAUDE.md"],
            platformCase: "sensitive",
          },
        }),
      ),
    );
    expect(unsupported.candidates[0]?.code).toBe("unknown-exclusion");
    const knownNonmatch = resolveClaudeCodeProfile(
      input(
        [memory],
        runtime({
          exclusions: {
            completeness: "complete",
            patterns: ["/different/path", "/different/tree/**"],
            platformCase: "sensitive",
          },
        }),
      ),
    );
    expect(knownNonmatch.candidates[0]?.activation).toBe("active");
    expect(
      resolveClaudeCodeProfile(
        input(
          [memory],
          runtime({
            exclusions: { completeness: "partial", patterns: [], platformCase: "sensitive" },
          }),
        ),
      ).candidates[0]?.code,
    ).toBe("unknown-exclusion");
  });

  test("does not grant authority to symlinks, empty files, or malformed syntax", () => {
    expect(
      resolveClaudeCodeProfile(
        input([candidate("CLAUDE.md", "memory-shared", "x", { symlinkState: "external" })]),
      ).candidates[0]?.code,
    ).toBe("external-symlink-unknown");
    expect(
      resolveClaudeCodeProfile(
        input([candidate("CLAUDE.md", "memory-shared", "x", { symlinkState: "internal" })]),
      ).candidates[0]?.code,
    ).toBe("unknown-symlink");
    expect(
      resolveClaudeCodeProfile(input([candidate("CLAUDE.md", "memory-shared", "")])).candidates[0]
        ?.code,
    ).toBe("invalid-syntax");
    expect(
      resolveClaudeCodeProfile(
        input([candidate(".claude/rules/a.md", "project-rule", "---\npaths: 7\n---\nRule\n")]),
      ).candidates[0]?.code,
    ).toBe("invalid-syntax");
  });

  test("composes a real C10 import graph and enforces the four-hop profile boundary", async () => {
    const sources = {
      "CLAUDE.md": "@a.md\n",
      "a.md": "@b.md\n",
      "b.md": "@c.md\n",
      "c.md": "@d.md\n",
      "d.md": "@e.md\n",
      "e.md": "Done.\n",
    };
    const graph: ImportGraphResult = await loadImportGraph({
      entryPath: path("CLAUDE.md"),
      repository: repository(sources),
      syntax: "claude-code",
    });
    const result = resolveClaudeCodeProfile(
      input([
        candidate("CLAUDE.md", "memory-shared", sources["CLAUDE.md"], { importGraph: graph }),
      ]),
    );
    expect(result.candidates[0]?.imports.map((entry) => entry.state)).toEqual([
      "loaded",
      "loaded",
      "loaded",
      "loaded",
      "depth-unsupported",
    ]);
    expect(result.analysisStatus).toBe("partial");
    expect(result.candidates[0]?.imports.map((entry) => entry.rawSpecifier)).toEqual([
      "a.md",
      "b.md",
      "c.md",
      "d.md",
      "e.md",
    ]);
  });

  test("retains C10 approval, cycle, unavailable, repeat, and limit states", async () => {
    const resolveGraph = async (
      sources: Readonly<Record<string, string>>,
      limits?: Parameters<typeof loadImportGraph>[1],
    ): Promise<ReturnType<typeof resolveClaudeCodeProfile>> => {
      const graph = await loadImportGraph(
        { entryPath: path("CLAUDE.md"), repository: repository(sources), syntax: "claude-code" },
        limits,
      );
      return resolveClaudeCodeProfile(
        input([
          candidate("CLAUDE.md", "memory-shared", sources["CLAUDE.md"] ?? "", {
            importGraph: graph,
          }),
        ]),
      );
    };

    expect(
      (await resolveGraph({ "CLAUDE.md": "@../outside.md\n" })).candidates[0]?.imports[0]?.state,
    ).toBe("approval-required");
    expect(
      (
        await resolveGraph({ "CLAUDE.md": "@a.md\n", "a.md": "@CLAUDE.md\n" })
      ).candidates[0]?.imports.map((entry) => entry.state),
    ).toContain("cycle-unknown");
    expect(
      (await resolveGraph({ "CLAUDE.md": "@missing.md\n" })).candidates[0]?.imports[0]?.state,
    ).toBe("unavailable");
    expect(
      (
        await resolveGraph({ "CLAUDE.md": "@a.md\n@a.md\n", "a.md": "A\n" })
      ).candidates[0]?.imports.map((entry) => entry.state),
    ).toEqual(["loaded", "loaded"]);
    expect(
      (await resolveGraph({ "CLAUDE.md": "@a.md\n", "a.md": "A\n" }, { maxDepth: 0 })).candidates[0]
        ?.imports[0]?.state,
    ).toBe("unknown");

    const unresolved = resolveClaudeCodeProfile(
      input([candidate("CLAUDE.md", "memory-shared", "@docs/policy.md\n")]),
    );
    expect(unresolved.candidates[0]?.imports[0]).toMatchObject({
      rawSpecifier: "docs/policy.md",
      state: "unknown",
    });
  });

  test("rejects graph substitution and hostile closed-input violations", async () => {
    const graph = await loadImportGraph({
      entryPath: path("other.md"),
      repository: repository({ "other.md": "x" }),
      syntax: "claude-code",
    });
    expect(() =>
      resolveClaudeCodeProfile(
        input([candidate("CLAUDE.md", "memory-shared", "x", { importGraph: graph })]),
      ),
    ).toThrow(ClaudeCodeProfileError);
    expect(() =>
      resolveClaudeCodeProfile(
        input([
          candidate("CLAUDE.md", "memory-shared", "x", {
            importGraph: { ...graph, state: "invalid" } as never,
          }),
        ]),
      ),
    ).toThrow(ClaudeCodeProfileError);
    expect(() => resolveClaudeCodeProfile(new Proxy({}, {}))).toThrow(ClaudeCodeProfileError);
    expect(() => resolveClaudeCodeProfile({ ...input([]), extra: true })).toThrow(
      expect.objectContaining({ code: ClaudeCodeProfileErrorCode.invalidInput }),
    );
    expect(() => resolveClaudeCodeProfile(input([candidate("wrong.md", "memory-shared")]))).toThrow(
      ClaudeCodeProfileError,
    );
    expect(() =>
      resolveClaudeCodeProfile({
        ...input([]),
        runtime: { ...runtime(), eventTrace: [] },
      }),
    ).toThrow(ClaudeCodeProfileError);
  });

  test("rejects resource excess before syntax work", () => {
    expect(() =>
      resolveClaudeCodeProfile(
        input([
          candidate(
            "CLAUDE.md",
            "memory-shared",
            "x".repeat(CLAUDE_CODE_PROFILE_LIMITS.maximumCandidateBytes + 1),
          ),
        ]),
      ),
    ).toThrow(expect.objectContaining({ code: ClaudeCodeProfileErrorCode.resourceLimit }));
    const patterns = Array.from(
      { length: CLAUDE_CODE_PROFILE_LIMITS.maximumExclusions + 1 },
      (_, index) => `/x/${String(index)}`,
    );
    expect(() =>
      resolveClaudeCodeProfile(
        input(
          [],
          runtime({
            exclusions: { completeness: "complete", patterns, platformCase: "sensitive" },
          }),
        ),
      ),
    ).toThrow(expect.objectContaining({ code: ClaudeCodeProfileErrorCode.resourceLimit }));
  });

  test("rejects hostile candidate, runtime, setting, exclusion, event, and array shapes", () => {
    const plain = candidate("CLAUDE.md", "memory-shared");
    const invalidValues: readonly unknown[] = [
      { ...input([]), launchCwd: "../escape" },
      { ...input([]), launchCwd: "outside", repositoryRoot: "repo" },
      input([{ ...plain, absolutePath: "relative/path" }]),
      input([{ ...plain, absolutePath: "/repo/../escape" }]),
      input([{ ...plain, bytes: Buffer.from("x") }]),
      input([{ ...plain, kind: "unknown" } as never]),
      input([{ ...plain, origin: "unknown" } as never]),
      input([{ ...plain, symlinkState: "unknown-value" } as never]),
      input([{ ...plain, importGraph: 7 } as never]),
      input([{ ...plain, scopeRoot: path("nested") }]),
      input([plain, plain]),
      { ...input([]), runtime: { ...runtime(), additionalDirectoryInstructions: "other" } },
      { ...input([]), runtime: { ...runtime(), externalContext: "other" } },
      { ...input([]), runtime: { ...runtime(), mode: "other" } },
      { ...input([]), runtime: { ...runtime(), clientVersion: "latest" } },
      {
        ...input([]),
        runtime: { ...runtime(), settingSources: { state: "invalid", values: [] } },
      },
      {
        ...input([]),
        runtime: { ...runtime(), settingSources: { state: "known", values: ["bad"] } },
      },
      {
        ...input([]),
        runtime: { ...runtime(), settingSources: { state: "known", values: ["user", "user"] } },
      },
      {
        ...input([]),
        runtime: {
          ...runtime(),
          exclusions: { completeness: "invalid", patterns: [], platformCase: "sensitive" },
        },
      },
      {
        ...input([]),
        runtime: {
          ...runtime(),
          exclusions: { completeness: "complete", patterns: [], platformCase: "invalid" },
        },
      },
      {
        ...input([]),
        runtime: {
          ...runtime(),
          exclusions: { completeness: "complete", patterns: [""], platformCase: "sensitive" },
        },
      },
      {
        ...input([]),
        runtime: {
          ...runtime(),
          exclusions: {
            completeness: "complete",
            patterns: ["/a", "/a"],
            platformCase: "sensitive",
          },
        },
      },
      {
        ...input([]),
        runtime: {
          ...runtime(),
          eventTrace: [
            { id: "launch", kind: "launch", path: path("apps/api") },
            { id: "compact", kind: "compact", path: path("apps/api") },
          ],
        },
      },
      {
        ...input([]),
        runtime: {
          ...runtime(),
          eventTrace: [
            { id: "launch", kind: "launch", path: path("apps/api") },
            { id: "bad", kind: "other", path: path("apps/api") },
          ],
        },
      },
      {
        ...input([]),
        runtime: {
          ...runtime(),
          eventTrace: [
            { id: "launch", kind: "launch", path: path("apps/api") },
            { id: "again", kind: "launch", path: path("apps/api") },
          ],
        },
      },
      {
        ...input([]),
        runtime: {
          ...runtime(),
          eventTrace: [
            { id: "same", kind: "launch", path: path("apps/api") },
            { id: "same", kind: "read", path: path("x") },
          ],
        },
      },
      {
        ...input([]),
        runtime: {
          ...runtime(),
          eventTrace: [{ id: "bad id", kind: "launch", path: path("apps/api") }],
        },
      },
    ];
    for (const value of invalidValues)
      expect(() => resolveClaudeCodeProfile(value)).toThrow(ClaudeCodeProfileError);

    const extra = [] as unknown[] & { extra?: boolean };
    extra.extra = true;
    expect(() => resolveClaudeCodeProfile({ ...input([]), candidates: extra })).toThrow(
      ClaudeCodeProfileError,
    );
    const sparse = new Array<unknown>(1);
    expect(() => resolveClaudeCodeProfile({ ...input([]), candidates: sparse })).toThrow(
      ClaudeCodeProfileError,
    );
    const accessor = { ...input([]) };
    Object.defineProperty(accessor, "runtime", { enumerable: true, get: () => runtime() });
    expect(() => resolveClaudeCodeProfile(accessor)).toThrow(ClaudeCodeProfileError);
    const aliased = new Uint8Array([1]);
    Object.defineProperty(aliased, "extra", { enumerable: true, value: true });
    expect(() => resolveClaudeCodeProfile(input([{ ...plain, bytes: aliased }]))).toThrow(
      ClaudeCodeProfileError,
    );
  });

  test("preserves unavailable external context and unknown setting sources as partial", () => {
    const memory = candidate("CLAUDE.md", "memory-shared");
    const unavailable = resolveClaudeCodeProfile(
      input([memory], runtime({ externalContext: "unavailable" })),
    );
    expect(unavailable).toMatchObject({
      analysisStatus: "partial",
      externalContext: "unavailable",
    });
    const unknownSettings = resolveClaudeCodeProfile(
      input([memory], runtime({ settingSources: { state: "unknown", values: [] } })),
    );
    expect(unknownSettings.candidates[0]).toMatchObject({
      activation: "indeterminate",
      code: "unknown-runtime",
    });
    const legacySources = resolveClaudeCodeProfile(
      input(
        [candidate(".claude/rules/a.md", "project-rule")],
        runtime({
          clientVersion: "2.1.210",
          settingSources: { state: "known", values: ["user"] },
        }),
      ),
    );
    expect(legacySources.candidates[0]?.code).toBe("legacy-client-risk");
  });

  test("reports each documented client-version boundary without collapsing ranges", () => {
    const memory = candidate("CLAUDE.md", "memory-shared");
    const branches = [
      [null, "unversioned"],
      ["2.1.197", "before-2.1.198"],
      ["2.1.198", "2.1.198-to-2.1.206"],
      ["2.1.207", "2.1.207-to-2.1.210"],
      ["2.1.211", "2.1.211-to-2.1.216"],
      ["2.1.217", "2.1.217-or-newer"],
      ["3.0.0", "2.1.217-or-newer"],
    ] as const;
    expect(
      branches.map(
        ([clientVersion]) =>
          resolveClaudeCodeProfile(input([memory], runtime({ clientVersion }))).candidates[0]
            ?.versionBranch,
      ),
    ).toEqual(branches.map(([, branch]) => branch));
  });

  test("sorts and freezes deterministic output without mutating bytes", () => {
    const root = candidate("CLAUDE.md", "memory-shared");
    const nested = candidate("apps/CLAUDE.md", "memory-shared");
    const before = Uint8Array.from(root.bytes);
    const value = input([nested, root]);
    const first = resolveClaudeCodeProfile(value);
    expect(first).toEqual(resolveClaudeCodeProfile(value));
    expect(first.candidates.map((entry) => entry.path)).toEqual(["CLAUDE.md", "apps/CLAUDE.md"]);
    expect(root.bytes).toEqual(before);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.profile)).toBe(true);
  });
});
