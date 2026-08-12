import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

import {
  INSTRUCTION_IR_CONTRACT_VERSION,
  validateDiagnosticBundle,
  validateInstructionIr,
} from "@agent-context/core";
import type {
  ActivationKind,
  ActivationRule,
  AstNode,
  InstructionDocument,
  InstructionIr,
  RepositoryRelativePath,
  SourceDocument,
  SourcePosition,
} from "@agent-context/core";
import {
  activationFact,
  activationIntersection,
  evaluateActivationRule,
} from "@agent-context/resolver";
import type { ActivationResult } from "@agent-context/resolver";

import {
  ScopeActivationError,
  evaluateScopeActivationRules,
  type ScopeActivationInput,
  type ScopeActivationObservation,
  type ScopeActivationRuleFact,
} from "../src/index.js";

interface RuleSpec {
  readonly documentPath?: string;
  readonly id: string;
  readonly kind?: ActivationKind;
  readonly profileId?: string;
}

interface FixtureOptions {
  readonly facts?: readonly Partial<ScopeActivationRuleFact>[];
  readonly paths?: readonly string[];
  readonly states?: Readonly<Record<string, Readonly<Record<string, ActivationResult["state"]>>>>;
  readonly targetKinds?: Readonly<Record<string, ScopeActivationObservation["targetKind"]>>;
}

function position(offset: number): SourcePosition {
  return { byteOffset: offset, line: 0, utf16Column: offset, utf16Offset: offset };
}

function ruleFixture(
  specs: readonly RuleSpec[],
  fixtureOptions: FixtureOptions = {},
): ScopeActivationInput {
  const sources: SourceDocument[] = [];
  const nodes: AstNode[] = [];
  const documents: InstructionDocument[] = [];
  const rules: ActivationRule[] = [];
  for (const [index, spec] of specs.entries()) {
    const text = `Policy ${spec.id}`;
    const sourceId = `source:${spec.id}` as SourceDocument["id"];
    const nodeId = `node:${spec.id}` as AstNode["id"];
    const documentId = `document:${spec.id}` as InstructionDocument["id"];
    const activationId = spec.id as ActivationRule["id"];
    const range = { end: position(text.length), sourceId, start: position(0) };
    sources.push({
      bom: "none",
      byteLength: text.length,
      encoding: "utf-8",
      id: sourceId,
      lineEnding: "none",
      parseState: { state: "complete" },
      path: (spec.documentPath ?? `RULE${String(index)}.md`) as RepositoryRelativePath,
      rootNodeId: nodeId,
      sha256: createHash("sha256").update(text).digest("hex"),
      text,
      utf16Length: text.length,
    });
    nodes.push({ childIds: [], id: nodeId, kind: "root", range, sourceId });
    documents.push({
      activationRuleIds: [activationId],
      formatId: "fixture-markdown",
      id: documentId,
      importIds: [],
      rootNodeId: nodeId,
      scopeRoot: "." as RepositoryRelativePath,
      sourceId,
      statementIds: [],
    });
    const kind = spec.kind ?? "glob";
    rules.push({
      conditions: [],
      documentId,
      evidenceRefs: [{ factId: `fact:${spec.id}`, sourceId: "fixture:scope" }],
      exclude: [],
      id: activationId,
      include:
        kind === "glob"
          ? [
              {
                dialectId: "fixture-glob",
                kind: "glob",
                pattern: "**/*.ts",
                sourceRange: null,
                uncertainty: { state: "known" },
              },
            ]
          : [],
      kind,
      profileId: spec.profileId ?? `profile:${spec.id}`,
      scopeRoot: "." as RepositoryRelativePath,
      specSnapshotId: `snapshot:${spec.id}`,
      surfaceId: `surface:${spec.id}`,
      uncertainty:
        kind === "unknown"
          ? { reason: "Fixture behavior is unknown.", state: "unknown" }
          : { state: "known" },
      unknownReason: kind === "unknown" ? "Fixture behavior is unknown." : null,
    });
  }
  const ir: InstructionIr = {
    activationRules: rules,
    contractVersion: INSTRUCTION_IR_CONTRACT_VERSION,
    documents,
    events: [],
    imports: [],
    nodes,
    recordKind: "agent-context-instruction-ir",
    sources,
    statements: [],
    targets: [],
  };
  const validated = validateInstructionIr(ir);
  if (!validated.ok) throw new Error(JSON.stringify(validated.issues));
  const paths = fixtureOptions.paths ?? ["src/main.ts"];
  const activationResults = paths.map((path): ScopeActivationObservation => ({
    path: path as RepositoryRelativePath,
    results: rules.map((rule) => {
      const requested = fixtureOptions.states?.[path]?.[rule.id];
      if (rule.kind === "glob")
        return {
          result: evaluateActivationRule(rule, {
            callbacks: {
              matchGlob: () => ({ state: requested ?? "inactive", reason: "Fixture E02 fact." }),
            },
            targetPath: path as RepositoryRelativePath,
          }),
          ruleId: rule.id,
        };
      if (rule.kind === "always")
        return {
          result: evaluateActivationRule(rule, { targetPath: path as RepositoryRelativePath }),
          ruleId: rule.id,
        };
      return {
        result:
          requested === undefined
            ? evaluateActivationRule(rule, { targetPath: path as RepositoryRelativePath })
            : activationFact(requested, `fixture:${rule.id}:${path}`, "Fixture activation fact."),
        ruleId: rule.id,
      };
    }),
    targetKind: fixtureOptions.targetKinds?.[path] ?? "source",
  }));
  const facts = rules.map((rule, index): ScopeActivationRuleFact => {
    const override = fixtureOptions.facts?.[index] ?? {};
    return {
      comparisonGroup: override.comparisonGroup ?? null,
      factId: override.factId ?? `resolution:${rule.id}`,
      nestingState: override.nestingState ?? "known",
      reachabilityState: override.reachabilityState ?? "reachable",
      ruleId: rule.id,
      scopeMetadataState: override.scopeMetadataState ?? "present",
      shadowedByRuleIds: override.shadowedByRuleIds ?? [],
    };
  });
  return {
    activationResults,
    contractVersion: "0.1.0",
    facts,
    ir: validated.value,
    recordKind: "agent-context-scope-activation-rule-input",
    sampling: {
      criticalPaths: [],
      paths: paths as readonly RepositoryRelativePath[],
      trackingCertainty: "tracked",
      trackingReason: "verified-git-index",
      workspaceBoundaries: [],
      workspaceUncertainty: "known",
      workspaceUncertaintyReasons: [],
    },
  };
}

function ids(input: ScopeActivationInput): readonly string[] {
  return evaluateScopeActivationRules(input).bundle.diagnostics.map(
    (diagnostic) => diagnostic.ruleId,
  );
}

interface PrecisionCase {
  readonly expected: boolean;
  readonly id: string;
  readonly ruleId: string;
}

function precisionInput(id: string): ScopeActivationInput {
  if (id === "acl200-exact-empty") return ruleFixture([{ id: "activation:precision-empty" }]);
  if (id === "acl200-indeterminate")
    return ruleFixture([{ id: "activation:precision-unknown", kind: "unknown" }]);
  if (id === "acl201-missing-always")
    return ruleFixture([{ id: "activation:precision-missing", kind: "always" }], {
      facts: [{ scopeMetadataState: "missing" }],
    });
  if (id === "acl201-present-always")
    return ruleFixture([{ id: "activation:precision-present", kind: "always" }]);
  if (id === "acl202-outside-directory")
    return ruleFixture([{ documentPath: "pkg/RULE.md", id: "activation:precision-broad" }], {
      states: { "src/main.ts": { "activation:precision-broad": "active" } },
    });
  if (id === "acl202-inside-directory")
    return ruleFixture([{ documentPath: "pkg/RULE.md", id: "activation:precision-local" }], {
      paths: ["pkg/main.ts"],
      states: { "pkg/main.ts": { "activation:precision-local": "active" } },
    });
  if (id === "acl203-proven-shadow")
    return ruleFixture(
      [
        { id: "activation:precision-base", kind: "always" },
        { id: "activation:precision-shadow", kind: "always" },
      ],
      {
        facts: [
          {},
          {
            reachabilityState: "shadowed",
            shadowedByRuleIds: ["activation:precision-base"],
          },
        ],
      },
    );
  if (id === "acl203-conditional")
    return ruleFixture([{ id: "activation:precision-conditional", kind: "always" }], {
      facts: [{ reachabilityState: "conditional" }],
    });
  if (id === "acl204-active-inactive" || id === "acl204-indeterminate")
    return ruleFixture([{ id: "activation:precision-a" }, { id: "activation:precision-b" }], {
      facts: [{ comparisonGroup: "precision:shared" }, { comparisonGroup: "precision:shared" }],
      states: {
        "src/main.ts": {
          "activation:precision-a": "active",
          "activation:precision-b": id === "acl204-active-inactive" ? "inactive" : "indeterminate",
        },
      },
    });
  if (id === "acl205-ambiguous")
    return ruleFixture([{ id: "activation:precision-ambiguous", kind: "always" }], {
      facts: [{ nestingState: "ambiguous" }],
    });
  if (id === "acl205-known")
    return ruleFixture([{ id: "activation:precision-known", kind: "always" }]);
  if (id === "acl206-generated" || id === "acl206-source")
    return ruleFixture([{ id: "activation:precision-artifact", kind: "always" }], {
      targetKinds: {
        "src/generated.ts": id === "acl206-generated" ? "generated" : "source",
      },
      paths: ["src/generated.ts"],
    });
  throw new Error(`unknown precision case ${id}`);
}

describe("ACL200-ACL206 scope and activation rules", () => {
  test("emits ACL200 only for a provably empty exact scope", () => {
    const result = evaluateScopeActivationRules(ruleFixture([{ id: "activation:empty" }]));
    expect(result.sampling.strategy).toBe("exhaustive");
    expect(result.summaries[0]).toMatchObject({ completeness: "exact", setState: "empty" });
    expect(result.bundle.diagnostics.map((entry) => entry.ruleId)).toEqual(["ACL200"]);
    expect(validateDiagnosticBundle(result.bundle, result.sources).ok).toBe(true);
  });

  test("does not infer empty from sampled or indeterminate activation", () => {
    const paths = Array.from({ length: 1_001 }, (_, index) => `src/f${String(index)}.ts`);
    const sampled = evaluateScopeActivationRules(
      ruleFixture([{ id: "activation:sampled" }], { paths }),
    );
    expect(sampled.summaries[0]).toMatchObject({
      completeness: "sampled",
      setState: "sampled-no-active",
    });
    expect(sampled.bundle.diagnostics).toEqual([]);
    expect(sampled.uncertainties.map((entry) => entry.reason)).toContain("sampled-no-active");

    const unknown = evaluateScopeActivationRules(
      ruleFixture([{ id: "activation:unknown", kind: "unknown" }]),
    );
    expect(unknown.summaries[0]?.setState).toBe("indeterminate");
    expect(unknown.bundle.diagnostics).toEqual([]);
    expect(unknown.uncertainties.map((entry) => entry.reason)).toContain(
      "activation-indeterminate",
    );

    const mixedUniverse = ruleFixture([{ id: "activation:mixed" }]);
    const mixed = evaluateScopeActivationRules({
      ...mixedUniverse,
      sampling: {
        ...mixedUniverse.sampling,
        paths: [...mixedUniverse.sampling.paths, "README.md" as RepositoryRelativePath],
      },
    });
    expect(mixed.summaries[0]).toMatchObject({
      completeness: "sampled",
      setState: "sampled-no-active",
    });
    expect(mixed.bundle.diagnostics).toEqual([]);
  });

  test("covers missing always-on metadata, broad scope, and shadow evidence", () => {
    expect(
      ids(
        ruleFixture([{ id: "activation:always", kind: "always" }], {
          facts: [{ scopeMetadataState: "missing" }],
        }),
      ),
    ).toContain("ACL201");
    expect(
      ids(
        ruleFixture([{ documentPath: "pkg/RULE.md", id: "activation:broad" }], {
          states: { "src/main.ts": { "activation:broad": "active" } },
        }),
      ),
    ).toContain("ACL202");
    const shadowed = ruleFixture(
      [
        { id: "activation:base", kind: "always" },
        { id: "activation:shadow", kind: "always" },
      ],
      { facts: [{}, { reachabilityState: "shadowed", shadowedByRuleIds: ["activation:base"] }] },
    );
    expect(ids(shadowed)).toContain("ACL203");
    expect(
      ids(
        ruleFixture([{ id: "activation:unreachable", kind: "always" }], {
          facts: [{ reachabilityState: "unreachable" }],
        }),
      ),
    ).toContain("ACL203");
  });

  test("covers cross-profile divergence and nesting ambiguity without collapsing uncertainty", () => {
    const comparison = ruleFixture(
      [
        { id: "activation:a", profileId: "profile:a" },
        { id: "activation:b", profileId: "profile:b" },
      ],
      {
        facts: [{ comparisonGroup: "shared:policy" }, { comparisonGroup: "shared:policy" }],
        states: { "src/main.ts": { "activation:a": "active", "activation:b": "inactive" } },
      },
    );
    expect(ids(comparison)).toContain("ACL204");
    const nesting = evaluateScopeActivationRules(
      ruleFixture([{ id: "activation:nested", kind: "always" }], {
        facts: [{ nestingState: "contradictory", reachabilityState: "conditional" }],
      }),
    );
    expect(nesting.bundle.diagnostics.map((entry) => entry.ruleId)).toContain("ACL205");
    expect(nesting.uncertainties.map((entry) => entry.reason)).toEqual(
      expect.arrayContaining(["nesting-contradictory", "reachability-conditional"]),
    );
  });

  test("reports active generated, vendored, and dependency source targets", () => {
    for (const targetKind of ["generated", "vendored", "dependency"] as const) {
      const input = ruleFixture([{ id: `activation:${targetKind}` }], {
        states: { "src/generated.ts": { [`activation:${targetKind}`]: "active" } },
        paths: ["src/generated.ts"],
        targetKinds: { "src/generated.ts": targetKind },
      });
      expect(ids(input)).toContain("ACL206");
    }
  });

  test("keeps close negative cases silent", () => {
    const input = ruleFixture([{ id: "activation:local" }], {
      states: { "pkg/main.ts": { "activation:local": "active" } },
      paths: ["pkg/main.ts"],
    });
    expect(ids(input)).toEqual([]);
  });

  test("is deterministic across observation and per-target result order", () => {
    const input = ruleFixture([{ id: "activation:a" }, { id: "activation:b" }], {
      facts: [{ comparisonGroup: "shared:one" }, { comparisonGroup: "shared:one" }],
      paths: ["src/a.ts", "src/b.ts"],
      states: {
        "src/a.ts": { "activation:a": "active", "activation:b": "inactive" },
        "src/b.ts": { "activation:a": "inactive", "activation:b": "active" },
      },
    });
    const first = evaluateScopeActivationRules(input);
    const permuted = {
      ...input,
      activationResults: [...input.activationResults].reverse().map((entry) => ({
        ...entry,
        results: [...entry.results].reverse(),
      })),
    };
    expect(evaluateScopeActivationRules(permuted)).toEqual(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.bundle.diagnostics)).toBe(true);
  });

  test("rejects malformed, hostile, inconsistent, and over-limit input", () => {
    const input = ruleFixture([{ id: "activation:one" }]);
    expect(() => evaluateScopeActivationRules(new Proxy(input, {}))).toThrow(ScopeActivationError);
    expect(() => evaluateScopeActivationRules({ ...input, extra: true } as never)).toThrow(
      ScopeActivationError,
    );
    const sparse = [...input.activationResults];
    sparse.length = 2;
    expect(() => evaluateScopeActivationRules({ ...input, activationResults: sparse })).toThrow(
      ScopeActivationError,
    );
    expect(() => evaluateScopeActivationRules({ ...input, facts: [] })).toThrow(
      ScopeActivationError,
    );
    expect(() => evaluateScopeActivationRules(input, { maximumRules: 0 })).toThrow(
      ScopeActivationError,
    );
    expect(() =>
      evaluateScopeActivationRules(input, { maximumRules: 1, unknown: 1 } as never),
    ).toThrow(ScopeActivationError);
    const two = ruleFixture([{ id: "activation:one" }, { id: "activation:two" }]);
    expect(() => evaluateScopeActivationRules(two, { maximumRules: 1 })).toThrow(
      ScopeActivationError,
    );
    let invoked = false;
    const hostile = { ...input } as unknown as Record<string, unknown>;
    Object.defineProperty(hostile, "facts", {
      enumerable: true,
      get: () => {
        invoked = true;
        return [];
      },
    });
    expect(() => evaluateScopeActivationRules(hostile as never)).toThrow(ScopeActivationError);
    expect(invoked).toBe(false);
  });

  test("closes nested observations, E01 results, facts, and E08 sampling evidence", () => {
    const input = ruleFixture([{ id: "activation:one" }]);
    const observation = input.activationResults[0];
    const observationResult = observation?.results[0];
    if (observation === undefined || observationResult === undefined)
      throw new Error("missing fixture observation");
    const invalid: unknown[] = [];
    invalid.push({ ...input, recordKind: "wrong" });
    invalid.push({ ...input, ir: {} });
    invalid.push({ ...input, activationResults: {} });
    invalid.push({ ...input, activationResults: [new Proxy(observation, {})] });
    invalid.push({ ...input, activationResults: [{ ...input.activationResults[0], path: 7 }] });
    invalid.push({
      ...input,
      activationResults: [{ ...input.activationResults[0], targetKind: "other" }],
    });
    invalid.push({
      ...input,
      activationResults: [input.activationResults[0], input.activationResults[0]],
    });
    invalid.push({
      ...input,
      activationResults: [
        { ...input.activationResults[0], results: [{ result: {}, ruleId: "activation:one" }] },
      ],
    });
    invalid.push({
      ...input,
      activationResults: [
        {
          ...observation,
          results: [{ ...observationResult, ruleId: "invalid id" }],
        },
      ],
    });
    invalid.push({ ...input, activationResults: [{ ...input.activationResults[0], results: [] }] });
    invalid.push({ ...input, facts: [input.facts[0], input.facts[0]] });
    for (const [key, value] of [
      ["nestingState", "bad"],
      ["reachabilityState", "bad"],
      ["scopeMetadataState", "bad"],
    ] as const)
      invalid.push({ ...input, facts: [{ ...input.facts[0], [key]: value }] });
    invalid.push({ ...input, facts: [{ ...input.facts[0], shadowedByRuleIds: ["missing"] }] });
    invalid.push({ ...input, facts: [{ ...input.facts[0], reachabilityState: "shadowed" }] });
    invalid.push({ ...input, sampling: { ...input.sampling, trackingReason: "bad" } });
    const hidden = [input.activationResults[0]];
    Object.defineProperty(hidden, "0", { enumerable: false, value: input.activationResults[0] });
    invalid.push({ ...input, activationResults: hidden });
    for (const candidate of invalid)
      expect(() => evaluateScopeActivationRules(candidate as never)).toThrow(ScopeActivationError);

    const twoFacts = activationIntersection([
      activationFact("active", "fixture:one", "First fixture fact."),
      activationFact("active", "fixture:two", "Second fixture fact."),
    ]);
    const provenanceHeavy = {
      ...input,
      activationResults: [
        {
          ...observation,
          results: [{ result: twoFacts, ruleId: "activation:one" }],
        },
      ],
    } satisfies ScopeActivationInput;
    expect(() =>
      evaluateScopeActivationRules(provenanceHeavy, { maximumProvenanceFacts: 1 }),
    ).toThrow(ScopeActivationError);
    expect(() =>
      evaluateScopeActivationRules(input, { maximumActivationResults: 1 }),
    ).not.toThrow();
    const two = ruleFixture([{ id: "activation:one" }, { id: "activation:two" }]);
    expect(() => evaluateScopeActivationRules(two, { maximumActivationResults: 1 })).toThrow(
      ScopeActivationError,
    );
  });

  test("retains every conditional, contradictory, ambiguous, and unknown fact state", () => {
    for (const [reachabilityState, reason] of [
      ["ambiguous", "reachability-ambiguous"],
      ["contradictory", "reachability-contradictory"],
      ["unknown", "reachability-unknown"],
    ] as const) {
      const result = evaluateScopeActivationRules(
        ruleFixture([{ id: `activation:${reachabilityState}`, kind: "always" }], {
          facts: [{ reachabilityState }],
        }),
      );
      expect(result.uncertainties.map((entry) => entry.reason)).toContain(reason);
    }
    const metadata = evaluateScopeActivationRules(
      ruleFixture([{ id: "activation:metadata", kind: "always" }], {
        facts: [{ nestingState: "unknown", scopeMetadataState: "unknown" }],
      }),
    );
    expect(metadata.uncertainties.map((entry) => entry.reason)).toEqual(
      expect.arrayContaining(["nesting-unknown", "scope-metadata-unknown"]),
    );
    const nestingConditional = evaluateScopeActivationRules(
      ruleFixture([{ id: "activation:nesting-conditional", kind: "always" }], {
        facts: [{ nestingState: "conditional" }],
      }),
    );
    expect(nestingConditional.uncertainties.map((entry) => entry.reason)).toContain(
      "nesting-conditional",
    );
  });

  test("enforces diagnostic and uncertainty output limits", () => {
    const diagnostics = ruleFixture([{ documentPath: "pkg/RULE.md", id: "activation:limited" }], {
      facts: [{ nestingState: "ambiguous" }],
      states: { "src/main.ts": { "activation:limited": "active" } },
    });
    expect(() => evaluateScopeActivationRules(diagnostics, { maximumDiagnostics: 1 })).toThrow(
      ScopeActivationError,
    );
    const uncertainties = ruleFixture([{ id: "activation:uncertain", kind: "unknown" }], {
      facts: [{ reachabilityState: "unknown" }],
    });
    expect(() => evaluateScopeActivationRules(uncertainties, { maximumUncertainties: 1 })).toThrow(
      ScopeActivationError,
    );
  });

  test("rejects hostile container variants and invalid option scalars", () => {
    const input = ruleFixture([{ id: "activation:containers" }]);
    for (const candidate of [null, [], Object.create({ inherited: true })])
      expect(() => evaluateScopeActivationRules(candidate as never)).toThrow(ScopeActivationError);
    expect(() =>
      evaluateScopeActivationRules({
        ...input,
        activationResults: new Proxy([...input.activationResults], {}),
      }),
    ).toThrow(ScopeActivationError);
    const extended = [...input.activationResults];
    Object.defineProperty(extended, "extra", { enumerable: true, value: true });
    expect(() => evaluateScopeActivationRules({ ...input, activationResults: extended })).toThrow(
      ScopeActivationError,
    );
    for (const candidate of [
      { maximumRules: "1" },
      { maximumRules: 100_001 },
      new Proxy({ maximumRules: 1 }, {}),
    ])
      expect(() => evaluateScopeActivationRules(input, candidate as never)).toThrow(
        ScopeActivationError,
      );
    const oneMemberComparison = ruleFixture([{ id: "activation:single-comparison" }], {
      facts: [{ comparisonGroup: "single:group" }],
    });
    expect(
      evaluateScopeActivationRules(oneMemberComparison).bundle.diagnostics.map(
        (entry) => entry.ruleId,
      ),
    ).toEqual(["ACL200"]);
  });

  test("meets the labeled hard-negative precision corpus", () => {
    const corpus = JSON.parse(
      readFileSync(
        new URL("./fixtures/scope-activation-precision.v1.json", import.meta.url),
        "utf8",
      ),
    ) as { readonly cases: readonly PrecisionCase[]; readonly minimumPrecision: number };
    let truePositives = 0;
    let falsePositives = 0;
    for (const entry of corpus.cases) {
      const emitted = ids(precisionInput(entry.id)).includes(entry.ruleId);
      expect(emitted, entry.id).toBe(entry.expected);
      if (emitted && entry.expected) truePositives += 1;
      else if (emitted) falsePositives += 1;
    }
    expect(truePositives / (truePositives + falsePositives)).toBeGreaterThanOrEqual(
      corpus.minimumPrecision,
    );
  });
});
