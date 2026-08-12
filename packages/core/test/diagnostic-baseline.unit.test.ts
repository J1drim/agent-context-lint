import { readFileSync } from "node:fs";

import type { AnySchema } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, test } from "vitest";

import {
  compareDiagnosticBaseline,
  baselineValidationIssues,
  computeBaselineProvenanceDigest,
  computePathFingerprint,
  computeSemanticFingerprint,
  generateDiagnosticBaseline,
  validateBaselineOutput,
  validateInstructionIr,
} from "../src/index.js";

import type {
  BaselineDiagnosticClassification,
  BaselineOutput,
  BaselineProfileVersionIdentity,
  CompareDiagnosticBaselineResult,
  Diagnostic,
  DiagnosticBundle,
  RepositoryRelativePath,
  SourceDocument,
} from "../src/index.js";

const BASELINE_FIXTURE = new URL("./fixtures/diagnostic-baseline.v1.valid.json", import.meta.url);
const COMPATIBILITY_FIXTURE = new URL(
  "./fixtures/diagnostic-baseline-compatibility.v1.json",
  import.meta.url,
);
const BASELINE_SCHEMA = new URL("../schemas/diagnostic-baseline.v1.schema.json", import.meta.url);
const DIAGNOSTICS_FIXTURE = new URL("./fixtures/diagnostics.valid.json", import.meta.url);
const IR_FIXTURE = new URL("./fixtures/instruction-ir.valid.json", import.meta.url);
const CREATED_AT = "2026-08-02T12:00:00.000Z";
const EXPIRES_AT = "2026-09-02T12:00:00.000Z";
const SOURCE_REVISION = "a".repeat(64);

function json(url: URL): unknown {
  return JSON.parse(readFileSync(url, "utf8")) as unknown;
}

function diagnostics(): DiagnosticBundle {
  return structuredClone(json(DIAGNOSTICS_FIXTURE)) as DiagnosticBundle;
}

function sources(): readonly SourceDocument[] {
  const result = validateInstructionIr(json(IR_FIXTURE));
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return structuredClone(result.value.sources);
}

function classifications(
  bundle: DiagnosticBundle,
  kind: BaselineDiagnosticClassification["kind"] = "lint",
): readonly BaselineDiagnosticClassification[] {
  return bundle.diagnostics.map((diagnostic) => ({ diagnosticId: diagnostic.id, kind }));
}

function profiles(
  overrides: Partial<BaselineProfileVersionIdentity> = {},
): Readonly<Record<string, BaselineProfileVersionIdentity>> {
  return {
    "codex-cli": {
      profileVersion: "1.0.0",
      clientVersion: "0.146.0",
      surfaceIds: ["codex-cli/local-cli-single-cwd"],
      specSnapshotIds: ["codex-cli/0.146.0/2026-08-01"],
      ...overrides,
    },
  };
}

function generated(
  bundle = diagnostics(),
  options: {
    readonly classifications?: readonly BaselineDiagnosticClassification[];
    readonly expiresAt?: string | null;
  } = {},
): BaselineOutput {
  const result = generateDiagnosticBaseline({
    diagnostics: bundle,
    sources: sources(),
    classifications: options.classifications ?? classifications(bundle),
    engineVersion: "1.0.0",
    sourceRevision: SOURCE_REVISION,
    profileVersions: profiles(),
    createdAt: CREATED_AT,
    expiresAt: options.expiresAt === undefined ? EXPIRES_AT : options.expiresAt,
  });
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.baseline;
}

function compare(
  baseline: unknown,
  bundle = diagnostics(),
  options: {
    readonly classifications?: readonly BaselineDiagnosticClassification[];
    readonly engineVersion?: string;
    readonly now?: string;
    readonly profileVersions?: Readonly<Record<string, BaselineProfileVersionIdentity>>;
    readonly pathMoves?: readonly {
      readonly fromPath: RepositoryRelativePath;
      readonly toPath: RepositoryRelativePath;
      readonly ruleId: string;
      readonly semanticFingerprint: string;
    }[];
    readonly sources?: readonly SourceDocument[];
  } = {},
): CompareDiagnosticBaselineResult {
  const input = {
    baseline,
    diagnostics: bundle,
    sources: options.sources ?? sources(),
    classifications: options.classifications ?? classifications(bundle),
    engineVersion: options.engineVersion ?? "1.0.0",
    profileVersions: options.profileVersions ?? profiles(),
    now: options.now ?? "2026-08-03T12:00:00.000Z",
    ...(options.pathMoves === undefined ? {} : { pathMoves: options.pathMoves }),
  };
  return compareDiagnosticBaseline(input);
}

function mutableDiagnostic(bundle: DiagnosticBundle): Record<string, unknown> {
  return bundle.diagnostics[0] as unknown as Record<string, unknown>;
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("expected object");
  return value as Record<string, unknown>;
}

function changeDiagnostic(
  mutation: (diagnostic: Record<string, unknown>) => void,
): DiagnosticBundle {
  const bundle = diagnostics();
  const diagnostic = mutableDiagnostic(bundle);
  mutation(diagnostic);
  const typed = diagnostic as unknown as Diagnostic;
  record(diagnostic["fingerprints"])["path"] = {
    method: "agent-context-lint/path/v1",
    value: computePathFingerprint({
      ruleId: typed.ruleId,
      ruleVersion: typed.ruleVersion,
      path: typed.primary.path,
      basis: typed.fingerprintBasis.path,
    }),
  };
  record(diagnostic["fingerprints"])["semantic"] = {
    method: "agent-context-lint/semantic/v1",
    value: computeSemanticFingerprint({
      ruleId: typed.ruleId,
      ruleVersion: typed.ruleVersion,
      basis: typed.fingerprintBasis.semantic,
    }),
  };
  return bundle;
}

describe("I08 diagnostic baselines", () => {
  test("freezes the dedicated closed v1 schema and compatibility goldens", () => {
    const schema = json(BASELINE_SCHEMA) as AnySchema;
    const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
    const fixture = json(BASELINE_FIXTURE);
    expect(validate(fixture), JSON.stringify(validate.errors)).toBe(true);
    expect(validateBaselineOutput(fixture)).toMatchObject({ ok: true });
    const compatibility = record(json(COMPATIBILITY_FIXTURE));
    expect(compatibility).toMatchObject({
      recordKind: "agent-context-baseline-compatibility-fixtures",
      fixtureVersion: "1.0.0",
    });
    expect((compatibility["cases"] as unknown[]).map((item) => record(item)["id"])).toEqual([
      "v1-exact-identity",
      "v1-expired-entry",
      "future-major-fails-closed",
      "legacy-scaffold-requires-regeneration",
    ]);
    const extra = structuredClone(fixture) as Record<string, unknown>;
    extra["command"] = "$(touch never)";
    expect(validate(extra)).toBe(false);
  });

  test("generates canonical immutable bounded entries and deduplicates only exact identities", () => {
    const bundle = diagnostics();
    const original = bundle.diagnostics[0];
    if (original === undefined) throw new Error("missing fixture diagnostic");
    const duplicate = structuredClone(original);
    Object.assign(duplicate as unknown as Record<string, unknown>, { id: "diagnostic:duplicate" });
    for (const related of duplicate.related)
      Object.assign(related as unknown as Record<string, unknown>, {
        id: `${related.id}:duplicate`,
      });
    const duplicateFix = duplicate.suggestion?.fixPlan;
    if (duplicateFix !== null && duplicateFix !== undefined)
      Object.assign(duplicateFix as unknown as Record<string, unknown>, {
        id: "fix:package-manager:duplicate",
      });
    const duplicated = {
      ...bundle,
      diagnostics: [original, duplicate],
    } satisfies DiagnosticBundle;
    const result = generateDiagnosticBaseline({
      diagnostics: duplicated,
      sources: sources(),
      classifications: classifications(duplicated),
      engineVersion: "1.0.0",
      sourceRevision: SOURCE_REVISION,
      profileVersions: profiles(),
      createdAt: CREATED_AT,
      expiresAt: EXPIRES_AT,
    });
    expect(result, JSON.stringify(result)).toMatchObject({
      ok: true,
      baseline: { entries: [{ ruleId: "ACL250" }] },
    });
    if (!result.ok) throw new Error("expected generation");
    expect(result.baseline.entries).toHaveLength(1);
    expect(result.serializedBytes).toBeGreaterThan(0);
    expect(Object.isFrozen(result.baseline)).toBe(true);
    expect(Object.isFrozen(result.baseline.entries[0])).toBe(true);

    const severityChanged = structuredClone(original);
    Object.assign(severityChanged as unknown as Record<string, unknown>, {
      id: "diagnostic:severity",
      severity: "warning",
    });
    for (const related of severityChanged.related)
      Object.assign(related as unknown as Record<string, unknown>, {
        id: `${related.id}:severity`,
      });
    const severityFix = severityChanged.suggestion?.fixPlan;
    if (severityFix !== null && severityFix !== undefined)
      Object.assign(severityFix as unknown as Record<string, unknown>, {
        id: "fix:package-manager:severity",
      });
    const distinct = { ...bundle, diagnostics: [original, severityChanged] };
    const distinctResult = generateDiagnosticBaseline({
      diagnostics: distinct,
      sources: sources(),
      classifications: classifications(distinct),
      engineVersion: "1.0.0",
      sourceRevision: SOURCE_REVISION,
      profileVersions: profiles(),
      createdAt: CREATED_AT,
      expiresAt: EXPIRES_AT,
    });
    expect(distinctResult).toMatchObject({ ok: true });
    if (distinctResult.ok) expect(distinctResult.baseline.entries).toHaveLength(2);
    const reversed = { ...bundle, diagnostics: [severityChanged, original] };
    const reversedResult = generateDiagnosticBaseline({
      diagnostics: reversed,
      sources: sources(),
      classifications: classifications(reversed),
      engineVersion: "1.0.0",
      sourceRevision: SOURCE_REVISION,
      profileVersions: profiles(),
      createdAt: CREATED_AT,
      expiresAt: EXPIRES_AT,
    });
    expect(reversedResult).toMatchObject({ ok: true });
    if (distinctResult.ok && reversedResult.ok)
      expect(reversedResult.baseline).toEqual(distinctResult.baseline);
  });

  test("matches only the complete exact identity and keeps caller diagnostic order", () => {
    const bundle = diagnostics();
    const result = compare(generated(bundle), bundle);
    expect(result).toMatchObject({
      ok: true,
      diagnostics: [
        {
          diagnosticId: bundle.diagnostics[0]?.id,
          status: "matched",
          reason: "exact-match",
          visible: false,
        },
      ],
      visibleDiagnosticIndexes: [],
      visibleDiagnosticIds: [],
      staleEntries: [],
      summary: { matched: 1, new: 0, stale: 0, expired: 0, incompatible: 0, ambiguous: 0 },
    });
    if (result.ok) expect(Object.isFrozen(result.diagnostics)).toBe(true);
  });

  test.each([
    ["configuration-error", "non-suppressible-configuration-error"],
    ["parser-error", "non-suppressible-parser-error"],
  ] as const)("never suppresses %s diagnostics", (kind, reason) => {
    const bundle = diagnostics();
    const result = compare(generated(bundle), bundle, {
      classifications: classifications(bundle, kind),
    });
    expect(result).toMatchObject({
      ok: true,
      diagnostics: [{ status: "new", reason, visible: true }],
      summary: { matched: 0, new: 1, stale: 1 },
    });
  });

  test("makes expiry and explicit caller time deterministic at the boundary", () => {
    const baseline = generated();
    expect(compare(baseline, diagnostics(), { now: EXPIRES_AT })).toMatchObject({
      ok: true,
      diagnostics: [{ status: "expired", reason: "baseline-expired", visible: true }],
      summary: { expired: 1 },
    });
    expect(
      compare(baseline, diagnostics(), { now: "2026-09-02T14:00:00.000+02:00" }),
    ).toMatchObject({
      ok: false,
      issues: [{ code: "invalid-input", path: "$.now" }],
    });
  });

  test.each([
    ["engine", { engineVersion: "2.0.0" }, "engine-version-changed"],
    [
      "client",
      { profileVersions: profiles({ clientVersion: "0.147.0" }) },
      "profile-identity-changed",
    ],
    [
      "surface",
      { profileVersions: profiles({ surfaceIds: ["codex-cli/other"] }) },
      "profile-identity-changed",
    ],
    [
      "specification",
      { profileVersions: profiles({ specSnapshotIds: ["codex-cli/next"] }) },
      "profile-identity-changed",
    ],
  ] as const)("fails closed when the %s identity changes", (_label, options, reason) => {
    expect(compare(generated(), diagnostics(), options)).toMatchObject({
      ok: true,
      diagnostics: [{ status: "incompatible", reason, visible: true }],
    });
  });

  test("surfaces rule-version and severity changes", () => {
    const ruleChanged = changeDiagnostic((diagnostic) => {
      diagnostic["ruleVersion"] = "2.0.0";
    });
    expect(compare(generated(), ruleChanged)).toMatchObject({
      ok: true,
      diagnostics: [{ status: "incompatible", reason: "rule-version-changed" }],
    });
    const severityChanged = changeDiagnostic((diagnostic) => {
      diagnostic["severity"] = "warning";
    });
    expect(compare(generated(), severityChanged)).toMatchObject({
      ok: true,
      diagnostics: [{ status: "incompatible", reason: "severity-changed" }],
    });
  });

  test("surfaces diagnostic provenance and fingerprint changes independently", () => {
    const provenanceChanged = changeDiagnostic((diagnostic) => {
      const related = diagnostic["related"] as unknown[];
      const resolution = related.map(record).find((item) => item["kind"] === "resolution");
      if (resolution === undefined) throw new Error("missing resolution evidence");
      resolution["surfaceId"] = "codex-cli/other";
    });
    const twoSurfaces = profiles({
      surfaceIds: ["codex-cli/local-cli-single-cwd", "codex-cli/other"],
    });
    const baselineResult = generateDiagnosticBaseline({
      diagnostics: diagnostics(),
      sources: sources(),
      classifications: classifications(diagnostics()),
      engineVersion: "1.0.0",
      sourceRevision: SOURCE_REVISION,
      profileVersions: twoSurfaces,
      createdAt: CREATED_AT,
      expiresAt: EXPIRES_AT,
    });
    if (!baselineResult.ok) throw new Error(JSON.stringify(baselineResult.issues));
    expect(
      compare(baselineResult.baseline, provenanceChanged, { profileVersions: twoSurfaces }),
    ).toMatchObject({
      ok: true,
      diagnostics: [{ status: "incompatible", reason: "diagnostic-provenance-changed" }],
    });

    const fingerprintChanged = changeDiagnostic((diagnostic) => {
      record(record(diagnostic["fingerprintBasis"])["path"])["anchor"] = "statement:changed";
    });
    expect(compare(generated(), fingerprintChanged)).toMatchObject({
      ok: true,
      diagnostics: [{ status: "incompatible", reason: "fingerprint-changed" }],
    });
  });

  test("keeps exact fingerprint collisions and unmatched entries visible for audit", () => {
    const bundle = diagnostics();
    const original = bundle.diagnostics[0];
    if (original === undefined) throw new Error("missing fixture diagnostic");
    const duplicate = structuredClone(original);
    Object.assign(duplicate as unknown as Record<string, unknown>, { id: "diagnostic:collision" });
    for (const related of duplicate.related)
      Object.assign(related as unknown as Record<string, unknown>, {
        id: `${related.id}:collision`,
      });
    const duplicateFix = duplicate.suggestion?.fixPlan;
    if (duplicateFix !== null && duplicateFix !== undefined)
      Object.assign(duplicateFix as unknown as Record<string, unknown>, { id: "fix:collision" });
    const collided = { ...bundle, diagnostics: [original, duplicate] } satisfies DiagnosticBundle;
    expect(
      compare(generated(), collided, { classifications: classifications(collided) }),
    ).toMatchObject({
      ok: true,
      diagnostics: [
        { status: "ambiguous", reason: "fingerprint-collision", visible: true },
        { status: "ambiguous", reason: "fingerprint-collision", visible: true },
      ],
      summary: { ambiguous: 2, stale: 1 },
    });

    const empty = {
      recordKind: "agent-context-diagnostics",
      contractVersion: "0.1.0",
      diagnostics: [],
      suppressions: [],
    } as unknown as DiagnosticBundle;
    expect(compare(generated(), empty, { classifications: [] })).toMatchObject({
      ok: true,
      diagnostics: [],
      staleEntries: [{ reason: "not-observed" }],
      summary: { stale: 1 },
    });
    expect(
      compare(generated(), empty, {
        classifications: [],
        now: "2026-09-02T12:00:00.000Z",
      }),
    ).toMatchObject({
      ok: true,
      staleEntries: [{ reason: "expired" }],
      summary: { expired: 1, stale: 0 },
    });
  });

  test("keeps multiple near identities visible instead of guessing", () => {
    const baseline = structuredClone(generated());
    const original = baseline.entries[0];
    if (original === undefined) throw new Error("missing baseline fixture entry");
    const second = structuredClone(original);
    Object.assign(second as unknown as Record<string, unknown>, { severity: "warning" });
    Object.assign(baseline as unknown as Record<string, unknown>, {
      entries: [original, second],
    });
    expect(validateBaselineOutput(baseline)).toMatchObject({ ok: true });
    const changed = changeDiagnostic((diagnostic) => {
      diagnostic["ruleVersion"] = "2.0.0";
    });
    expect(compare(baseline, changed)).toMatchObject({
      ok: true,
      diagnostics: [{ status: "ambiguous", reason: "fingerprint-collision", visible: true }],
    });
  });

  test("distinguishes entry expiry from whole-baseline expiry", () => {
    const baseline = structuredClone(generated(diagnostics(), { expiresAt: null }));
    const expiringEntry = baseline.entries[0];
    if (expiringEntry === undefined) throw new Error("missing baseline fixture entry");
    Object.assign(expiringEntry as unknown as Record<string, unknown>, {
      expiresAt: "2026-08-03T12:00:00.000Z",
    });
    expect(compare(baseline, diagnostics(), { now: "2026-08-03T12:00:00.000Z" })).toMatchObject({
      ok: true,
      diagnostics: [{ status: "expired", reason: "entry-expired", visible: true }],
      summary: { expired: 1, stale: 0 },
    });
  });

  test("requires an explicit one-to-one move and rejects semantic collisions", () => {
    const moved = changeDiagnostic((diagnostic) => {
      const primary = record(diagnostic["primary"]);
      primary["path"] = "docs/AGENTS.md";
      const related = diagnostic["related"] as unknown[];
      for (const item of related) {
        const evidence = record(item);
        if (evidence["kind"] === "source") record(evidence["location"])["path"] = "docs/AGENTS.md";
      }
      const suggestion = record(diagnostic["suggestion"]);
      const fixPlan = record(suggestion["fixPlan"]);
      record((fixPlan["operations"] as unknown[])[0])["path"] = "docs/AGENTS.md";
    });
    record(record(moved.suppressions[0])["directive"])["path"] = "docs/AGENTS.md";
    const movedSources = structuredClone(sources()) as SourceDocument[];
    const movedSource = movedSources[0];
    if (movedSource === undefined) throw new Error("missing source fixture");
    Object.assign(movedSource, { path: "docs/AGENTS.md" });
    const semantic = moved.diagnostics[0]?.fingerprints.semantic.value;
    const unproven = compare(generated(), moved, { sources: movedSources });
    expect(unproven, JSON.stringify(unproven)).toMatchObject({
      ok: true,
      diagnostics: [{ status: "new", reason: "path-move-unproven", visible: true }],
    });
    const declaration = {
      fromPath: "AGENTS.md" as RepositoryRelativePath,
      toPath: "docs/AGENTS.md" as RepositoryRelativePath,
      ruleId: "ACL250",
      semanticFingerprint: semantic ?? "",
    };
    expect(
      compare(generated(), moved, { sources: movedSources, pathMoves: [declaration] }),
    ).toMatchObject({
      ok: true,
      diagnostics: [{ status: "matched", reason: "path-move", visible: false }],
    });
    expect(
      compare(generated(), moved, {
        sources: movedSources,
        pathMoves: [
          declaration,
          { ...declaration, fromPath: "other.md" as RepositoryRelativePath },
        ],
      }),
    ).toMatchObject({
      ok: true,
      diagnostics: [{ status: "ambiguous", reason: "ambiguous-path-move", visible: true }],
    });
  });

  test("fails safely on malformed, proxy, accessor, version, profile, and resource inputs", () => {
    const future = structuredClone(json(BASELINE_FIXTURE)) as Record<string, unknown>;
    future["schemaVersion"] = "2.0.0";
    expect(compare(future)).toMatchObject({ ok: false, issues: [{ code: "invalid-baseline" }] });
    expect(compare(new Proxy(future, {}))).toMatchObject({
      ok: false,
      issues: [{ code: "invalid-baseline" }],
    });
    const accessor = structuredClone(json(BASELINE_FIXTURE)) as Record<string, unknown>;
    Object.defineProperty(accessor, "entries", { enumerable: true, get: () => [] });
    expect(() => compare(accessor)).not.toThrow();
    expect(compare(accessor)).toMatchObject({ ok: false });
    expect(
      compare(generated(), diagnostics(), {
        pathMoves: new Array(10_001).fill({
          fromPath: "a" as RepositoryRelativePath,
          toPath: "b" as RepositoryRelativePath,
          ruleId: "ACL250",
          semanticFingerprint: "a".repeat(64),
        }),
      }),
    ).toMatchObject({ ok: false, issues: [{ path: "$.pathMoves" }] });
    expect(
      generateDiagnosticBaseline({
        diagnostics: diagnostics(),
        sources: sources(),
        classifications: classifications(diagnostics()),
        engineVersion: "latest",
        sourceRevision: SOURCE_REVISION,
        profileVersions: profiles(),
        createdAt: CREATED_AT,
        expiresAt: EXPIRES_AT,
      }),
    ).toMatchObject({ ok: false, issues: [{ path: "$.engineVersion" }] });

    const bundle = diagnostics();
    const baseInput = {
      diagnostics: bundle,
      sources: sources(),
      classifications: classifications(bundle),
      engineVersion: "1.0.0",
      sourceRevision: SOURCE_REVISION,
      profileVersions: profiles(),
      createdAt: CREATED_AT,
      expiresAt: EXPIRES_AT,
    } as const;
    expect(
      generateDiagnosticBaseline({ ...baseInput, createdAt: "2026-02-30T00:00:00.000Z" }),
    ).toMatchObject({
      ok: false,
      issues: [{ path: "$.createdAt" }],
    });
    expect(generateDiagnosticBaseline({ ...baseInput, expiresAt: CREATED_AT })).toMatchObject({
      ok: false,
      issues: [{ path: "$.expiresAt" }],
    });
    expect(generateDiagnosticBaseline({ ...baseInput, sourceRevision: "bad" })).toMatchObject({
      ok: false,
      issues: [{ path: "$.sourceRevision" }],
    });
    expect(generateDiagnosticBaseline({ ...baseInput, classifications: [] })).toMatchObject({
      ok: false,
      issues: [{ path: "$.classifications" }],
    });
    expect(
      generateDiagnosticBaseline({
        ...baseInput,
        classifications: [
          {
            ...classifications(bundle)[0],
            extra: true,
          } as unknown as BaselineDiagnosticClassification,
        ],
      }),
    ).toMatchObject({ ok: false, issues: [{ path: "$.classifications" }] });
    expect(generateDiagnosticBaseline({ ...baseInput, profileVersions: {} })).toMatchObject({
      ok: false,
      issues: [{ path: "$.profileVersions" }],
    });
    expect(
      generateDiagnosticBaseline({
        ...baseInput,
        profileVersions: profiles({ surfaceIds: ["duplicate", "duplicate"] }),
      }),
    ).toMatchObject({ ok: false, issues: [{ path: "$.profileVersions" }] });
    const accessorProfile = profiles()["codex-cli"] as unknown as Record<string, unknown>;
    Object.defineProperty(accessorProfile, "profileVersion", {
      enumerable: true,
      get: () => "1.0.0",
    });
    expect(
      generateDiagnosticBaseline({
        ...baseInput,
        profileVersions: {
          "codex-cli": accessorProfile as unknown as BaselineProfileVersionIdentity,
        },
      }),
    ).toMatchObject({ ok: false, issues: [{ path: "$.profileVersions" }] });
    const undeclaredProfile = generateDiagnosticBaseline({
      ...baseInput,
      profileVersions: {
        "claude-code": {
          profileVersion: "1.0.0",
          clientVersion: null,
          surfaceIds: [],
          specSnapshotIds: [],
        },
      },
    });
    expect(undeclaredProfile).toMatchObject({ ok: false });
    if (!undeclaredProfile.ok)
      expect(undeclaredProfile.issues.every((issue) => issue.code === "invalid-input")).toBe(true);
    const firstClassification = classifications(bundle)[0];
    if (firstClassification === undefined) throw new Error("missing classification fixture");
    const revoked = Proxy.revocable(firstClassification, {});
    revoked.revoke();
    expect(
      generateDiagnosticBaseline({ ...baseInput, classifications: [revoked.proxy] }),
    ).toMatchObject({ ok: false, issues: [{ path: "$" }] });
    const malformedBundle = {} as DiagnosticBundle;
    const invalidGeneration = generateDiagnosticBaseline({
      ...baseInput,
      diagnostics: malformedBundle,
    });
    expect(invalidGeneration).toMatchObject({ ok: false });
    if (!invalidGeneration.ok)
      expect(invalidGeneration.issues.every((issue) => issue.code === "invalid-diagnostics")).toBe(
        true,
      );
    const invalidComparison = compareDiagnosticBaseline({
      baseline: generated(),
      diagnostics: malformedBundle,
      sources: [],
      classifications: [],
      engineVersion: "1.0.0",
      profileVersions: profiles(),
      now: CREATED_AT,
    });
    expect(invalidComparison).toMatchObject({ ok: false });
    if (!invalidComparison.ok)
      expect(invalidComparison.issues.every((issue) => issue.code === "invalid-diagnostics")).toBe(
        true,
      );
    const parserOnly = generateDiagnosticBaseline({
      ...baseInput,
      classifications: classifications(bundle, "parser-error"),
    });
    expect(parserOnly).toMatchObject({ ok: true, baseline: { entries: [] } });
    const revokedMove = Proxy.revocable(
      {
        fromPath: "a" as RepositoryRelativePath,
        toPath: "b" as RepositoryRelativePath,
        ruleId: "ACL250",
        semanticFingerprint: "a".repeat(64),
      },
      {},
    );
    revokedMove.revoke();
    expect(compare(generated(), bundle, { pathMoves: [revokedMove.proxy] })).toMatchObject({
      ok: false,
      issues: [{ path: "$.pathMoves" }],
    });
    expect(
      compare(generated(), bundle, {
        pathMoves: [new Proxy({} as never, {})],
      }),
    ).toMatchObject({ ok: false, issues: [{ path: "$.pathMoves" }] });
    expect(
      compare(generated(), bundle, {
        pathMoves: [null as unknown as never],
      }),
    ).toMatchObject({ ok: false, issues: [{ path: "$.pathMoves" }] });
  });

  test("sanitizes persisted strings and reports frozen validation issues", () => {
    const bundle = diagnostics();
    const result = generateDiagnosticBaseline({
      diagnostics: bundle,
      sources: sources(),
      classifications: classifications(bundle),
      engineVersion: "1.0.0",
      sourceRevision: SOURCE_REVISION,
      profileVersions: profiles({ clientVersion: "token=SECRET_CANARY_BASELINE" }),
      createdAt: CREATED_AT,
      expiresAt: null,
    });
    expect(result).toMatchObject({
      ok: true,
      baseline: {
        profileVersions: { "codex-cli": { clientVersion: "token=REDACTED" } },
      },
    });
    const issues = baselineValidationIssues({});
    expect(issues.length).toBeGreaterThan(0);
    expect(Object.isFrozen(issues)).toBe(true);
    expect(baselineValidationIssues(json(BASELINE_FIXTURE))).toEqual([]);
  });

  test("is deterministic under repeated comparison and exposes a stable provenance digest", () => {
    const baseline = generated();
    const first = compare(baseline);
    for (let index = 0; index < 50; index += 1) expect(compare(baseline)).toEqual(first);
    const entry = baseline.entries[0];
    if (entry === undefined) throw new Error("missing baseline fixture entry");
    expect(computeBaselineProvenanceDigest(entry)).toMatch(/^[a-f0-9]{64}$/u);
  });
});
