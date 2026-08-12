import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

import { canonicalizeRepositoryRelativePath } from "@agent-context/core";
import type { RepositoryRelativePath } from "@agent-context/core";
import { describe, expect, it } from "vitest";

import {
  buildTargetedDiscoveryIndex,
  buildTargetedDiscoveryIndexWithClock,
  DISCOVERY_INDEX_DEFAULT_LIMITS,
  DISCOVERY_INDEX_HARD_LIMITS,
  DiscoveryIndexError,
  DiscoveryIndexErrorCode,
  isIssuedTargetedDiscoveryIndex,
  recognizeBuiltInInstructionPath,
} from "../src/discovery-index.js";
import type {
  DiscoveryIndexOptions,
  DiscoveryMatcherFact,
  DiscoveryPathMatcher,
  TargetedDiscoveryIndex,
} from "../src/discovery-index.js";
import { IGNORE_ENGINE_DEFAULT_LIMITS } from "../src/ignore-engine.js";
import type { IgnoreEngineResult, IgnoredPathDecision } from "../src/ignore-engine.js";
import { TRACKED_FILE_ENUMERATION_DEFAULT_LIMITS } from "../src/tracked-file-enumeration.js";
import type { TrackedFileEnumerationResult } from "../src/tracked-file-enumeration.js";

function paths(values: readonly string[]): ReturnType<typeof canonicalizeRepositoryRelativePath>[] {
  return values.map((value) => canonicalizeRepositoryRelativePath(value)).sort();
}

describe("built-in instruction path projection", () => {
  it.each([
    ["AGENTS.md", ["instruction.agents-base"]],
    ["packages/api/AGENTS.override.md", ["instruction.agents-override"]],
    ["CLAUDE.md", ["instruction.claude-memory"]],
    ["packages/api/CLAUDE.local.md", ["instruction.claude-local"]],
    [".claude/rules/testing.md", ["instruction.claude-rules"]],
    ["nested/.claude/rules/deep/style.md", ["instruction.claude-rules"]],
    [".github/copilot-instructions.md", ["instruction.copilot-repository"]],
    ["nested/.github/copilot-instructions.md", ["instruction.copilot-repository"]],
    [".github/instructions/test.instructions.md", ["instruction.copilot-path"]],
    ["nested/.github/instructions/deep/test.instructions.md", ["instruction.copilot-path"]],
    [".cursor/rules/project.mdc", ["instruction.cursor-mdc"]],
    ["nested/.cursor/rules/deep/project.mdc", ["instruction.cursor-mdc"]],
    [".cursorrules", ["instruction.cursor-legacy"]],
    ["GEMINI.md", ["instruction.gemini-context"]],
    ["packages/api/GEMINI.md", ["instruction.gemini-context"]],
  ])("recognizes %s with the production catalog", (pathValue, expected) => {
    expect(
      recognizeBuiltInInstructionPath(canonicalizeRepositoryRelativePath(pathValue)).map(
        (entry) => entry.recognizerId,
      ),
    ).toEqual(expected);
  });

  it.each([
    ".GitHub/copilot-instructions.md",
    ".gitHub/copilot-instructions.md",
    "gemini.md",
    "agents.md",
    ".Cursor/rules/project.mdc",
    "nested/.cursorrules",
    ".claude/Rules/project.md",
    ".github/instructions/not.md",
    "double//AGENTS.md",
    "dot/./AGENTS.md",
    "C:AGENTS.md",
    "C:/AGENTS.md",
    "\\\\?\\C:\\AGENTS.md",
    "control\u0000/AGENTS.md",
    "control\u001f/AGENTS.md",
    "control\u007f/AGENTS.md",
    "control\u0080/AGENTS.md",
    "control\u009f/AGENTS.md",
    "direction\u061c/AGENTS.md",
    "direction\u200e/AGENTS.md",
    "direction\u200f/AGENTS.md",
    "direction\u202a/AGENTS.md",
    "direction\u202e/AGENTS.md",
    "direction\u2066/AGENTS.md",
    "direction\u2069/AGENTS.md",
    `bad-${String.fromCharCode(0xd800)}/AGENTS.md`,
    `bad-${String.fromCharCode(0xdc00)}/AGENTS.md`,
  ])("rejects unsupported or case-variant path %s", (pathValue) => {
    expect(recognizeBuiltInInstructionPath(pathValue as RepositoryRelativePath)).toEqual([]);
  });

  it("uses the exact C05 path-length and depth admission boundaries", () => {
    const accepted = `${"a".repeat(16_384 - "AGENTS.md".length - 1)}/AGENTS.md`;
    const rejected = `a${accepted}`;
    expect(accepted.length).toBe(16_384);
    expect(
      recognizeBuiltInInstructionPath(canonicalizeRepositoryRelativePath(accepted)).map(
        (entry) => entry.recognizerId,
      ),
    ).toEqual(["instruction.agents-base"]);
    expect(recognizeBuiltInInstructionPath(rejected as RepositoryRelativePath)).toEqual([]);
    const acceptedDepth = `${Array.from({ length: 127 }, (_, index) => `d${String(index)}`).join("/")}/AGENTS.md`;
    const rejectedDepth = `extra/${acceptedDepth}`;
    expect(acceptedDepth.split("/")).toHaveLength(128);
    expect(rejectedDepth.split("/")).toHaveLength(129);
    expect(
      recognizeBuiltInInstructionPath(acceptedDepth as RepositoryRelativePath).map(
        (entry) => entry.recognizerId,
      ),
    ).toEqual(["instruction.agents-base"]);
    expect(recognizeBuiltInInstructionPath(rejectedDepth as RepositoryRelativePath)).toEqual([]);
    expect(run([acceptedDepth]).candidates.map((entry) => entry.path)).toEqual([acceptedDepth]);
    const listed = enumeration(["AGENTS.md"]);
    const forged = {
      ...listed,
      paths: Object.freeze([rejectedDepth]),
    } as TrackedFileEnumerationResult;
    expect(() => buildTargetedDiscoveryIndex(forged, ignoreResult(forged))).toThrow(
      DiscoveryIndexError,
    );
  });
});

function enumeration(values: readonly string[], fallback = false): TrackedFileEnumerationResult {
  return Object.freeze({
    certainty: fallback ? "all-files-not-tracked" : "tracked",
    ...(fallback ? {} : { indexObjectFormat: "sha1" as const, indexVersion: 2 as const }),
    limits: TRACKED_FILE_ENUMERATION_DEFAULT_LIMITS,
    omittedProblems: 0,
    paths: Object.freeze(paths(values)),
    problems: Object.freeze([]),
    reason: fallback ? "git-index-missing" : "verified-git-index",
    source: fallback ? "filesystem-fallback" : "git-index",
  });
}

function ignoreResult(
  input: TrackedFileEnumerationResult,
  ignoredValues: readonly string[] = [],
  uncertainProfile = false,
): IgnoreEngineResult {
  const ignoredSet = new Set(ignoredValues);
  const ignored: IgnoredPathDecision[] = input.paths
    .filter((pathValue) => ignoredSet.has(pathValue))
    .map((pathValue) =>
      Object.freeze({
        certainty:
          input.source === "git-index" ? ("known" as const) : ("tracking-uncertain" as const),
        path: pathValue,
        ruleId: "built-in:test:1",
      }),
    );
  const deferredProfileFacts = uncertainProfile
    ? Object.freeze([
        Object.freeze({
          applicability: "unknown" as const,
          clientVersion: null,
          evidence: "documented" as const,
          factId: "profile.ignore.unknown",
          pattern: "temp/",
          profileId: "sample-profile",
          reason: "client behavior is not documented",
          retrievedAt: "2026-08-02",
          sourceUrl: "https://example.com/ignore",
        }),
      ])
    : Object.freeze([]);
  return Object.freeze({
    appliedProfileFactIds: Object.freeze([]),
    certainty: input.source === "git-index" ? "exact-tracked-input" : "fallback-tracking-uncertain",
    deferredProfileFacts,
    ignored: Object.freeze(ignored),
    limits: IGNORE_ENGINE_DEFAULT_LIMITS,
    omittedProblems: 0,
    paths: Object.freeze(input.paths.filter((pathValue) => !ignoredSet.has(pathValue))),
    problems: Object.freeze([]),
    profileCertainty: uncertainProfile ? "uncertain-facts-deferred" : "known",
    profileFacts: deferredProfileFacts,
    rules: Object.freeze([]),
    trackingCertainty: input.source === "git-index" ? "tracked" : "fallback-mixed-unknown",
  });
}

function fact(
  factId: string,
  applicability: DiscoveryMatcherFact["applicability"],
  matcher: DiscoveryPathMatcher = { kind: "basename", value: "TEAM.md" },
): DiscoveryMatcherFact {
  const uncertain = applicability !== "known-active" && applicability !== "known-inactive";
  return {
    applicability,
    candidateKind: "instruction",
    clientVersion: null,
    evidence: "documented",
    factId,
    formatId: "agents-markdown",
    matcher,
    profileId: "sample-profile",
    reason: uncertain ? "activation is not known" : null,
    recognizerId: `instruction.${factId}`,
    retrievedAt: "2026-08-02",
    sourceUrl: "https://example.com/profile",
  };
}

function run(values: readonly string[], options?: DiscoveryIndexOptions): TargetedDiscoveryIndex {
  const listed = enumeration(values);
  return buildTargetedDiscoveryIndex(listed, ignoreResult(listed), options);
}

describe("targeted discovery index", () => {
  it("indexes every v1 instruction family and targeted configuration/evidence family", () => {
    const listed = enumeration([
      ".agent-context-lint.yml",
      ".cursorrules",
      ".github/copilot-instructions.md",
      ".github/instructions/api.instructions.md",
      ".gitignore",
      "AGENTS.md",
      "AGENTS.override.md",
      "BUILD.bazel",
      "Cargo.toml",
      "CLAUDE.local.md",
      "CLAUDE.md",
      "GEMINI.md",
      "MODULE.bazel",
      "apps/api/.claude/CLAUDE.md",
      "apps/api/.claude/rules/nested/security.md",
      "apps/api/.claude/settings.json",
      "apps/api/.cursor/rules/backend.mdc",
      "apps/api/.gemini/settings.json",
      "apps/api/.github/copilot-instructions.md",
      "apps/api/go.mod",
      "apps/api/package.json",
      "apps/api/pyproject.toml",
      "go.work",
      "nx.json",
      "pnpm-workspace.yaml",
      "src/index.ts",
      "turbo.json",
    ]);
    const result = buildTargetedDiscoveryIndex(listed, ignoreResult(listed));

    expect(isIssuedTargetedDiscoveryIndex(result)).toBe(true);
    expect(isIssuedTargetedDiscoveryIndex(structuredClone(result))).toBe(false);

    expect(result.candidates.map((candidate) => candidate.path)).not.toContain("src/index.ts");
    expect(result.candidates).toHaveLength(26);
    expect(result.candidates.find((candidate) => candidate.path === "AGENTS.md")).toMatchObject({
      kinds: ["instruction"],
      recognitions: [{ formatId: "agents-markdown", recognizerId: "instruction.agents-base" }],
    });
    expect(result.metrics).toMatchObject({
      candidateCount: 26,
      configurationCandidateCount: 4,
      contentReads: 0,
      evidenceCandidateCount: 10,
      instructionCandidateCount: 12,
    });
    expect(result.provenance.catalogSources.map((source) => source.id)).toEqual([
      "claude-memory-current",
      "codex-agents-md-current",
      "cursor-rules-current",
      "gemini-context-current",
      "github-copilot-instructions-current",
      "implementation-plan-c05",
      "implementation-plan-c11",
    ]);
  });

  it("uses exact structural boundaries instead of substring or host-platform matching", () => {
    const result = run([
      ".claude/deep/settings.json",
      ".cursorrules",
      "nested/.cursorrules",
      "nested/.github/copilot-instructions.md",
      "nested/.github/instructions.instructions.md",
      "nested/.github/instructions/a.instructions.md",
      "nested/.github/instructions/readme.md",
      "nested/x.github/instructions/a.instructions.md",
      "nested/x.cursor/rules/a.mdc",
      "nested/x/.cursor/rules/a.mdc",
    ]);

    expect(result.candidates.map((candidate) => candidate.path)).toEqual([
      ".cursorrules",
      "nested/.github/copilot-instructions.md",
      "nested/.github/instructions/a.instructions.md",
      "nested/x/.cursor/rules/a.mdc",
    ]);
  });

  it("excludes C04 ignored candidates and preserves the partition metrics", () => {
    const listed = enumeration(["AGENTS.md", "node_modules/AGENTS.md", "src/a.ts"]);
    const result = buildTargetedDiscoveryIndex(
      listed,
      ignoreResult(listed, ["node_modules/AGENTS.md"]),
    );

    expect(result.candidates.map((candidate) => candidate.path)).toEqual(["AGENTS.md"]);
    expect(result.metrics).toMatchObject({
      enumeratedPathCount: 3,
      ignoredPathCount: 1,
      inspectedPathCount: 2,
      retainedPathCount: 2,
    });
  });

  it("applies only known-active matcher facts and retains every uncertain fact", () => {
    const active = fact("custom.active", "known-active");
    const inactive = fact("custom.inactive", "known-inactive", {
      kind: "basename",
      value: "OFF.md",
    });
    const unknown = fact("custom.unknown", "unknown", {
      kind: "basename",
      value: "UNKNOWN.md",
    });
    const conditional = fact("custom.conditional", "conditional", {
      kind: "exact-path",
      value: "CONDITIONAL.md",
    });
    const contradiction = fact("custom.contradiction", "contradiction", {
      kind: "path-suffix",
      value: "custom/CONTRADICTION.md",
    });
    const result = run(["CONDITIONAL.md", "OFF.md", "TEAM.md", "UNKNOWN.md"], {
      matcherFacts: [active, inactive, unknown, conditional, contradiction],
    });

    expect(result.candidates.map((candidate) => candidate.path)).toEqual(["TEAM.md"]);
    expect(result.candidates[0]?.recognitions[0]).toMatchObject({
      factId: "custom.active",
      origin: "matcher-fact",
      profileId: "sample-profile",
    });
    expect(result.provenance.appliedMatcherFactIds).toEqual(["custom.active"]);
    expect(result.provenance.deferredMatcherFacts.map((item) => item.factId)).toEqual([
      "custom.unknown",
      "custom.conditional",
      "custom.contradiction",
    ]);
    expect(result.uncertaintyReasons).toEqual(["deferred-matcher-facts"]);
  });

  it("supports all bounded matcher mechanisms and orders overlapping recognitions", () => {
    const configured = fact("custom.config", "known-active", {
      kind: "exact-path",
      value: ".custom/config.yml",
    });
    const result = run([".custom/config.yml", ".custom/rules/a.md", "AGENTS.md", "package.json"], {
      matcherFacts: [
        { ...configured, candidateKind: "configuration", formatId: null },
        fact("custom.agents", "known-active", { kind: "basename", value: "AGENTS.md" }),
        fact("custom.rules", "known-active", {
          directory: ".custom/rules",
          kind: "under-directory-extension",
          suffix: ".md",
        }),
        fact("custom.package", "known-active", { kind: "path-suffix", value: "package.json" }),
      ],
    });

    expect(result.candidates.find((item) => item.path === "AGENTS.md")?.recognitions).toHaveLength(
      2,
    );
    expect(result.candidates.find((item) => item.path === ".custom/config.yml")?.kinds).toEqual([
      "configuration",
    ]);
    expect(result.candidates.find((item) => item.path === "package.json")?.kinds).toEqual([
      "evidence",
      "instruction",
    ]);
    expect(result.provenance.appliedMatcherFactIds).toEqual([
      "custom.config",
      "custom.agents",
      "custom.rules",
      "custom.package",
    ]);
  });

  it("preserves C03 fallback and C04 deferred-profile uncertainty on every candidate", () => {
    const listed = enumeration(["AGENTS.md"], true);
    const result = buildTargetedDiscoveryIndex(listed, ignoreResult(listed, [], true));

    expect(result.uncertainty).toBe("uncertain");
    expect(result.uncertaintyReasons).toEqual([
      "deferred-ignore-profile-facts",
      "fallback-tracking",
    ]);
    expect(result.candidates[0]?.uncertainty).toBe(result.uncertaintyReasons);
    expect(result.provenance).toMatchObject({
      deferredIgnoreProfileFactCount: 1,
      enumerationCertainty: "all-files-not-tracked",
      ignoreCertainty: "fallback-tracking-uncertain",
      trackingCertainty: "fallback-mixed-unknown",
    });
  });

  it("accepts known ignore decisions alongside fallback tracking uncertainty", () => {
    const listed = enumeration(["AGENTS.md", "node_modules/policy.md"], true);
    const ignored = ignoreResult(listed, ["node_modules/policy.md"]);
    const knownBuiltInDecision = Object.freeze({
      ...ignored,
      ignored: Object.freeze([
        Object.freeze({
          certainty: "known" as const,
          path: canonicalizeRepositoryRelativePath("node_modules/policy.md"),
          ruleId: "built-in:root:18",
        }),
      ]),
    });

    const result = buildTargetedDiscoveryIndex(listed, knownBuiltInDecision);

    expect(result.candidates.map((candidate) => candidate.path)).toEqual([
      canonicalizeRepositoryRelativePath("AGENTS.md"),
    ]);
    expect(result.metrics).toMatchObject({ ignoredPathCount: 1, retainedPathCount: 1 });
    expect(result.uncertaintyReasons).toEqual(["fallback-tracking"]);
  });

  it("accepts non-ASCII paths but rejects malformed Unicode, controls, and traversal", () => {
    expect(run(["docs/😀/AGENTS.md"]).candidates[0]?.path).toBe("docs/😀/AGENTS.md");
    for (const invalid of [
      "docs/\ud800/AGENTS.md",
      "docs/\u202e/AGENTS.md",
      "../AGENTS.md",
      "x\\AGENTS.md",
    ]) {
      const listed = enumeration(["AGENTS.md"]);
      const forged = { ...listed, paths: Object.freeze([invalid]) } as TrackedFileEnumerationResult;
      expect(() => buildTargetedDiscoveryIndex(forged, ignoreResult(forged))).toThrow(
        DiscoveryIndexError,
      );
    }
  });

  it("returns a recursively immutable, deterministic result", () => {
    const first = run(["AGENTS.md", "package.json"]);
    const second = run(["AGENTS.md", "package.json"]);

    expect(first).toEqual(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.candidates)).toBe(true);
    expect(Object.isFrozen(first.candidates[0])).toBe(true);
    expect(Object.isFrozen(first.candidates[0]?.recognitions)).toBe(true);
    expect(Object.isFrozen(first.candidates[0]?.recognitions[0]?.source)).toBe(true);
    expect(Object.isFrozen(first.provenance)).toBe(true);
    expect(Object.isFrozen(first.metrics)).toBe(true);
  });

  it("rejects incoherent enumeration and ignore provenance and partitions", () => {
    const listed = enumeration(["AGENTS.md", "src/a.ts"]);
    const ignored = ignoreResult(listed);
    const cases: readonly [TrackedFileEnumerationResult, IgnoreEngineResult][] = [
      [{ ...listed, reason: "git-index-missing" }, ignored],
      [{ ...listed, indexVersion: 99 as 2 }, ignored],
      [
        { ...enumeration(["AGENTS.md"], true), reason: "invented-reason" as "git-index-missing" },
        ignoreResult(enumeration(["AGENTS.md"], true)),
      ],
      [listed, { ...ignored, certainty: "fallback-tracking-uncertain" }],
      [listed, { ...ignored, trackingCertainty: "fallback-mixed-unknown" }],
      [listed, { ...ignored, paths: Object.freeze(paths(["AGENTS.md"])) }],
      [listed, { ...ignored, paths: Object.freeze(paths(["AGENTS.md", "extra.md", "src/a.ts"])) }],
      [listed, { ...ignored, paths: Object.freeze(paths(["AGENTS.md", "src/a.ts", "zzz.md"])) }],
      [listed, { ...ignored, profileCertainty: "uncertain-facts-deferred" }],
    ];
    for (const [enumerationValue, ignoreValue] of cases) {
      expect(() => buildTargetedDiscoveryIndex(enumerationValue, ignoreValue)).toThrow(
        expect.objectContaining({ code: DiscoveryIndexErrorCode.invalidInput }),
      );
    }
  });

  it("rejects duplicate, unsorted, and excessive input paths", () => {
    const listed = enumeration(["AGENTS.md"]);
    for (const invalidPaths of [
      ["b/AGENTS.md", "a/AGENTS.md"],
      ["AGENTS.md", "AGENTS.md"],
    ]) {
      const forged = {
        ...listed,
        paths: Object.freeze(invalidPaths),
      } as TrackedFileEnumerationResult;
      expect(() => buildTargetedDiscoveryIndex(forged, ignoreResult(forged))).toThrow(
        DiscoveryIndexError,
      );
    }
    expect(() => run(["a.ts", "b.ts"], { maximumPaths: 1 })).toThrow(
      expect.objectContaining({ code: DiscoveryIndexErrorCode.invalidInput }),
    );
  });

  it("rejects hostile objects, accessors, proxies, and extended or sparse arrays", () => {
    const listed = enumeration(["AGENTS.md"]);
    const ignored = ignoreResult(listed);
    const accessor = Object.defineProperty({}, "paths", { get: () => listed.paths });
    const sparse: unknown[] = [];
    sparse.length = 1;
    const extended = Object.assign(["AGENTS.md"], { extra: true });
    const proxy = new Proxy(listed, {});
    const revokedArray = Proxy.revocable(["AGENTS.md"], {});
    revokedArray.revoke();
    const cases: unknown[] = [
      null,
      [],
      accessor,
      proxy,
      { ...listed, paths: sparse },
      { ...listed, paths: extended },
      { ...listed, paths: revokedArray.proxy },
    ];
    for (const value of cases) {
      expect(() =>
        buildTargetedDiscoveryIndex(value as TrackedFileEnumerationResult, ignored),
      ).toThrow(DiscoveryIndexError);
    }
    expect(() => buildTargetedDiscoveryIndex(listed, new Proxy(ignored, {}))).toThrow(
      DiscoveryIndexError,
    );
    expect(() => buildTargetedDiscoveryIndex(listed, ignored, new Proxy({}, {}))).toThrow(
      DiscoveryIndexError,
    );
    expect(() =>
      buildTargetedDiscoveryIndex(listed, ignored, { signal: {} as AbortSignal }),
    ).toThrow(DiscoveryIndexError);
    const forgedSignal = Object.create(AbortSignal.prototype) as AbortSignal;
    expect(() => buildTargetedDiscoveryIndex(listed, ignored, { signal: forgedSignal })).toThrow(
      expect.objectContaining({ code: DiscoveryIndexErrorCode.invalidOptions }),
    );
  });

  it("rejects malformed matcher facts without invoking repository-owned behavior", () => {
    const listed = enumeration(["TEAM.md"]);
    const ignored = ignoreResult(listed);
    const active = fact("custom.active", "known-active");
    const missingReason = {
      applicability: active.applicability,
      candidateKind: active.candidateKind,
      clientVersion: active.clientVersion,
      evidence: active.evidence,
      factId: active.factId,
      formatId: active.formatId,
      matcher: active.matcher,
      profileId: active.profileId,
      recognizerId: active.recognizerId,
      retrievedAt: active.retrievedAt,
      sourceUrl: active.sourceUrl,
    };
    const cases: unknown[] = [
      new Proxy(active, {}),
      { ...active, sourceUrl: "http://example.com/profile" },
      { ...active, sourceUrl: "not a URL" },
      { ...active, sourceUrl: "https://user:secret@example.com/profile" },
      { ...active, reason: "not allowed for known state" },
      { ...active, candidateKind: "evidence", formatId: "agents-markdown" },
      { ...active, candidateKind: "unknown" },
      missingReason,
      { ...active, matcher: new Proxy(active.matcher, {}) },
      { ...active, matcher: { kind: "basename", value: "../TEAM.md" } },
      { ...active, matcher: { kind: "exact-path", value: 1 } },
      { ...active, matcher: { kind: "exact-path", value: "." } },
      { ...active, matcher: { kind: "exact-path", value: "../TEAM.md" } },
      {
        ...active,
        matcher: { kind: "under-directory-extension", directory: ".custom", suffix: "" },
      },
      {
        ...active,
        matcher: { kind: "under-directory-extension", directory: "../custom", suffix: ".md" },
      },
      { ...active, matcher: { kind: "under-directory-extension", directory: ".", suffix: ".md" } },
      { ...active, matcher: { kind: "unknown", value: "TEAM.md" } },
    ];
    for (const value of cases) {
      expect(() =>
        buildTargetedDiscoveryIndex(listed, ignored, { matcherFacts: [value] } as never),
      ).toThrow(expect.objectContaining({ code: DiscoveryIndexErrorCode.invalidOptions }));
    }
    expect(() =>
      buildTargetedDiscoveryIndex(listed, ignored, { matcherFacts: [active, active] }),
    ).toThrow(expect.objectContaining({ code: DiscoveryIndexErrorCode.invalidOptions }));
  });

  it("enforces option hard bounds and candidate, recognizer, byte, and work limits", () => {
    const listed = enumeration(["AGENTS.md", "package.json"]);
    const ignored = ignoreResult(listed);
    for (const options of [
      { maximumCandidates: 0 },
      { maximumCandidates: DISCOVERY_INDEX_HARD_LIMITS.maximumCandidates + 1 },
      { maximumDurationMs: Number.NaN },
      { unknown: 1 },
    ]) {
      expect(() => buildTargetedDiscoveryIndex(listed, ignored, options as never)).toThrow(
        expect.objectContaining({ code: DiscoveryIndexErrorCode.invalidOptions }),
      );
    }
    expect(() => buildTargetedDiscoveryIndex(listed, ignored, { maximumCandidates: 1 })).toThrow(
      expect.objectContaining({ code: DiscoveryIndexErrorCode.limitExceeded }),
    );
    expect(() =>
      buildTargetedDiscoveryIndex(listed, ignored, { maximumTotalPathBytes: 5 }),
    ).toThrow(expect.objectContaining({ code: DiscoveryIndexErrorCode.limitExceeded }));
    expect(() => buildTargetedDiscoveryIndex(listed, ignored, { maximumMatcherWork: 1 })).toThrow(
      expect.objectContaining({ code: DiscoveryIndexErrorCode.limitExceeded }),
    );
    expect(() => run(["a/AGENTS.md"], { maximumPathDepth: 1 })).toThrow(
      expect.objectContaining({ code: DiscoveryIndexErrorCode.malformedInput }),
    );
    expect(() =>
      buildTargetedDiscoveryIndex(listed, ignored, {
        matcherFacts: [fact("custom.one", "known-active"), fact("custom.two", "known-active")],
        maximumMatcherFacts: 1,
      }),
    ).toThrow(expect.objectContaining({ code: DiscoveryIndexErrorCode.invalidOptions }));
    expect(() =>
      buildTargetedDiscoveryIndex(
        enumeration(["TEAM.md"]),
        ignoreResult(enumeration(["TEAM.md"])),
        {
          matcherFacts: [fact("custom.one", "known-active"), fact("custom.two", "known-active")],
          maximumRecognizersPerCandidate: 1,
        },
      ),
    ).toThrow(expect.objectContaining({ code: DiscoveryIndexErrorCode.limitExceeded }));
  });

  it("retains validated C04 applied-profile identifiers and rejects malformed decisions", () => {
    const listed = enumeration(["AGENTS.md", "ignored/AGENTS.md"]);
    const ignored = ignoreResult(listed, ["ignored/AGENTS.md"]);
    const withApplied = {
      ...ignored,
      appliedProfileFactIds: Object.freeze(["profile.ignore.active"]),
      profileFacts: Object.freeze([
        Object.freeze({
          applicability: "known-active" as const,
          clientVersion: null,
          evidence: "documented" as const,
          factId: "profile.ignore.active",
          pattern: "temp/",
          profileId: "sample-profile",
          reason: null,
          retrievedAt: "2026-08-02",
          sourceUrl: "https://example.com/ignore",
        }),
      ]),
    } as IgnoreEngineResult;
    expect(
      buildTargetedDiscoveryIndex(listed, withApplied).provenance.appliedIgnoreProfileFactIds,
    ).toEqual(["profile.ignore.active"]);
    const badDecision = {
      ...ignored,
      ignored: Object.freeze([
        {
          certainty: "tracking-uncertain" as const,
          path: canonicalizeRepositoryRelativePath("ignored/AGENTS.md"),
          ruleId: "built-in:test:1",
        },
      ]),
    } as IgnoreEngineResult;
    expect(() => buildTargetedDiscoveryIndex(listed, badDecision)).toThrow(
      expect.objectContaining({ code: DiscoveryIndexErrorCode.invalidInput }),
    );
  });

  it("accepts known built-in decisions during fallback but keeps tracked input exact", () => {
    const fallbackEnumeration = enumeration(["AGENTS.md", "dist/output.js"], true);
    const uncertain = ignoreResult(fallbackEnumeration, ["dist/output.js"]);
    const knownDuringFallback = {
      ...uncertain,
      ignored: Object.freeze(
        uncertain.ignored.map((decision) =>
          Object.freeze({ ...decision, certainty: "known" as const }),
        ),
      ),
    } as IgnoreEngineResult;
    expect(
      buildTargetedDiscoveryIndex(fallbackEnumeration, knownDuringFallback).candidates.map(
        (candidate) => candidate.path,
      ),
    ).toEqual(["AGENTS.md"]);

    const trackedEnumeration = enumeration(["AGENTS.md", "dist/output.js"]);
    const tracked = ignoreResult(trackedEnumeration, ["dist/output.js"]);
    const uncertainDuringTracked = {
      ...tracked,
      ignored: Object.freeze(
        tracked.ignored.map((decision) =>
          Object.freeze({ ...decision, certainty: "tracking-uncertain" as const }),
        ),
      ),
    } as IgnoreEngineResult;
    expect(() => buildTargetedDiscoveryIndex(trackedEnumeration, uncertainDuringTracked)).toThrow(
      expect.objectContaining({ code: DiscoveryIndexErrorCode.invalidInput }),
    );
  });

  it("honors cancellation, deadlines, backward clocks, and invalid clocks", () => {
    const listed = enumeration(["AGENTS.md"]);
    const ignored = ignoreResult(listed);
    const controller = new AbortController();
    controller.abort();
    expect(() =>
      buildTargetedDiscoveryIndex(listed, ignored, { signal: controller.signal }),
    ).toThrow(expect.objectContaining({ code: DiscoveryIndexErrorCode.aborted }));
    const live = new AbortController();
    expect(() =>
      buildTargetedDiscoveryIndex(listed, ignored, { signal: new Proxy(live.signal, {}) }),
    ).toThrow(expect.objectContaining({ code: DiscoveryIndexErrorCode.invalidOptions }));
    const many = enumeration(
      Array.from({ length: 3_000 }, (_, index) => `src/f${String(index).padStart(4, "0")}.ts`),
    );
    const during = new AbortController();
    let clockCalls = 0;
    expect(() =>
      buildTargetedDiscoveryIndexWithClock(
        many,
        ignoreResult(many),
        { signal: during.signal },
        {
          now: () => {
            clockCalls += 1;
            if (clockCalls === 3) during.abort();
            return clockCalls;
          },
        },
      ),
    ).toThrow(expect.objectContaining({ code: DiscoveryIndexErrorCode.aborted }));
    expect(() =>
      buildTargetedDiscoveryIndexWithClock(
        listed,
        ignored,
        { maximumDurationMs: 1 },
        {
          now: (() => {
            const values = [0, 2];
            return (): number => values.shift() ?? 2;
          })(),
        },
      ),
    ).toThrow(expect.objectContaining({ code: DiscoveryIndexErrorCode.deadlineExceeded }));
    expect(() =>
      buildTargetedDiscoveryIndexWithClock(listed, ignored, undefined, {
        now: (() => {
          const values = [2, 1];
          return (): number => values.shift() ?? 1;
        })(),
      }),
    ).toThrow(expect.objectContaining({ code: DiscoveryIndexErrorCode.invalidOptions }));
    for (const clock of [
      { now: (): number => Number.NaN },
      { now: (): number => Number.MAX_VALUE },
      {
        now: (): number => {
          throw new Error("secret");
        },
      },
    ]) {
      expect(() => buildTargetedDiscoveryIndexWithClock(listed, ignored, undefined, clock)).toThrow(
        expect.objectContaining({ code: DiscoveryIndexErrorCode.invalidOptions }),
      );
    }
  });

  it("meets the deterministic 100k-path discovery budget without content reads", () => {
    const fixture = JSON.parse(
      readFileSync(
        new URL("../../../conformance/fixtures/v0/discovery-100k.fixture.json", import.meta.url),
        "utf8",
      ),
    ) as {
      expected: {
        candidateCount: number;
        configurationCandidateCount: number;
        contentReads: number;
        evidenceCandidateCount: number;
        ignoredPathCount: number;
        instructionCandidateCount: number;
        maximumDurationMs: number;
        maximumMatcherWork: number;
        retainedPathCount: number;
      };
      generator: { totalPaths: number };
    };
    const generated: string[] = [];
    const ignoredPaths: string[] = [];
    for (let index = 0; index < fixture.generator.totalPaths; index += 1) {
      const digits = String(index).padStart(6, "0");
      if (index % 1_000 === 0) generated.push(`packages/p${digits}/AGENTS.md`);
      else if (index % 2_500 === 1) generated.push(`packages/p${digits}/package.json`);
      else if (index % 2_000 === 2) {
        const pathValue = `generated/g${digits}.ts`;
        generated.push(pathValue);
        ignoredPaths.push(pathValue);
      } else generated.push(`src/f${digits}.ts`);
    }
    const listed = enumeration(generated);
    const started = performance.now();
    const result = buildTargetedDiscoveryIndex(listed, ignoreResult(listed, ignoredPaths));
    const duration = performance.now() - started;

    expect(result.metrics).toMatchObject({
      candidateCount: fixture.expected.candidateCount,
      configurationCandidateCount: fixture.expected.configurationCandidateCount,
      contentReads: fixture.expected.contentReads,
      evidenceCandidateCount: fixture.expected.evidenceCandidateCount,
      ignoredPathCount: fixture.expected.ignoredPathCount,
      instructionCandidateCount: fixture.expected.instructionCandidateCount,
      retainedPathCount: fixture.expected.retainedPathCount,
    });
    expect(result.metrics.matcherWork).toBeLessThanOrEqual(fixture.expected.maximumMatcherWork);
    expect(duration).toBeLessThan(fixture.expected.maximumDurationMs);
    expect(result.limits).toEqual(DISCOVERY_INDEX_DEFAULT_LIMITS);
  }, 15_000);
});
