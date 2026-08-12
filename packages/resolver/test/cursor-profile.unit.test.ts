import { readFileSync } from "node:fs";

import {
  canonicalizeRepositoryRelativePath,
  type RepositoryRelativePath,
} from "@agent-context/core";
import { describe, expect, test, vi } from "vitest";

import {
  CURSOR_PROFILE_RESOLVER_LIMITS,
  CursorProfileError,
  resolveCursorProfile,
  type CursorRuleCandidateSnapshot,
  type CursorRuntimeEvent,
  type ResolveCursorProfileInput,
} from "../src/index.js";

const ENCODER = new TextEncoder();
const FIXTURE_URL = new URL(
  "../../../conformance/fixtures/v0/cursor-stateful-profile.fixture.json",
  import.meta.url,
);

interface FixtureCase {
  readonly event:
    "agent-rule-selection" | "manual-rule-mention" | "read-path" | "reference-path" | "write-path";
  readonly expectedActivation: string;
  readonly expectedCode: string;
  readonly expectedMechanical: string;
  readonly format: "legacy" | "mdc";
  readonly id: string;
  readonly path: string;
  readonly source: string;
}

interface Fixture {
  readonly cases: readonly FixtureCase[];
  readonly recordKind: string;
  readonly schemaVersion: string;
}

const fixture = JSON.parse(readFileSync(FIXTURE_URL, "utf8")) as Fixture;

function path(value: string): RepositoryRelativePath {
  return canonicalizeRepositoryRelativePath(value);
}

function candidate(
  candidatePath: string,
  source: string,
  format: "legacy" | "mdc" = "mdc",
): CursorRuleCandidateSnapshot {
  return { bytes: ENCODER.encode(source), format, path: path(candidatePath) };
}

function mdc(fields: readonly string[], body = "Body\n"): string {
  return ["---", ...fields, "---", body].join("\n");
}

function runtimeEvent(
  kind: FixtureCase["event"],
  candidatePath: RepositoryRelativePath,
): CursorRuntimeEvent {
  const targetPath = candidatePath.startsWith("services/api/")
    ? path("services/api/index.ts")
    : path("src/index.ts");
  if (kind === "manual-rule-mention") {
    return {
      candidatePath: null,
      kind,
      ruleName:
        candidatePath
          .split("/")
          .at(-1)
          ?.replace(/\.mdc$/u, "") ?? "rule",
      sequence: 1,
      targetPath,
    };
  }
  if (kind === "agent-rule-selection") {
    return {
      candidatePath,
      kind,
      selection: "selected",
      sequence: 1,
      targetPath,
    };
  }
  return { kind, sequence: 1, targetPath };
}

function input(
  candidates: readonly CursorRuleCandidateSnapshot[],
  overrides: Partial<ResolveCursorProfileInput["runtime"]> = {},
): ResolveCursorProfileInput {
  return {
    candidates,
    runtime: {
      clientVersion: "3.12.30",
      eventState: "present",
      events: [{ kind: "reference-path", sequence: 1, targetPath: path("src/index.ts") }],
      externalContext: "absent",
      projectRules: "enabled",
      surfaceId: "cursor-agent/ide",
      workspaceRoots: [path(".")],
      ...overrides,
    },
  };
}

function expectProfileError(operation: () => unknown, code: CursorProfileError["code"]): void {
  try {
    operation();
    throw new Error("expected Cursor profile error");
  } catch (error) {
    expect(error).toBeInstanceOf(CursorProfileError);
    expect((error as CursorProfileError).code).toBe(code);
  }
}

describe("D13 stateful Cursor profile", () => {
  test("validates the canonical fixture and keeps all four modes mechanically distinct", () => {
    expect(Object.keys(fixture).sort()).toEqual(["cases", "recordKind", "schemaVersion"]);
    expect(fixture).toMatchObject({
      recordKind: "cursor-stateful-profile-cases",
      schemaVersion: "0.1.0",
    });
    expect(fixture.cases).toHaveLength(7);
    for (const fixtureCase of fixture.cases) {
      expect(Object.keys(fixtureCase).sort()).toEqual([
        "event",
        "expectedActivation",
        "expectedCode",
        "expectedMechanical",
        "format",
        "id",
        "path",
        "source",
      ]);
      const candidatePath = path(fixtureCase.path);
      const event = runtimeEvent(fixtureCase.event, candidatePath);
      const result = resolveCursorProfile(
        input([candidate(fixtureCase.path, fixtureCase.source, fixtureCase.format)], {
          events: [event],
        }),
      );
      expect(result.candidates[0], fixtureCase.id).toMatchObject({
        activation: fixtureCase.expectedActivation,
        code: fixtureCase.expectedCode,
        mechanicalActivation: fixtureCase.expectedMechanical,
        path: fixtureCase.path,
      });
    }
  });

  test("does not convert Agent Requested eligibility into selection without a model event", () => {
    const rule = candidate(
      ".cursor/rules/agent.mdc",
      mdc(["alwaysApply: false", "description: API specialist"]),
    );
    const eligible = resolveCursorProfile(input([rule]));
    expect(eligible.candidates[0]).toMatchObject({
      activation: "indeterminate",
      channels: { agentRequested: "indeterminate" },
      code: "agent-selection",
      mechanicalActivation: "inactive",
    });

    const selected = resolveCursorProfile(
      input([rule], {
        events: [
          {
            candidatePath: rule.path,
            kind: "agent-rule-selection",
            selection: "selected",
            sequence: 2,
            targetPath: path("src/api.ts"),
          },
          {
            candidatePath: rule.path,
            kind: "agent-rule-selection",
            selection: "not-selected",
            sequence: 1,
            targetPath: path("src/api.ts"),
          },
        ],
      }),
    );
    expect(selected.candidates[0]).toMatchObject({
      activation: "active",
      channels: { agentRequested: "selected" },
    });

    const rejected = resolveCursorProfile(
      input([rule], {
        events: [
          {
            candidatePath: rule.path,
            kind: "agent-rule-selection",
            selection: "not-selected",
            sequence: 1,
            targetPath: path("src/api.ts"),
          },
        ],
      }),
    );
    expect(rejected.candidates[0]).toMatchObject({
      activation: "inactive",
      channels: { agentRequested: "not-selected" },
    });
    const unknownSelection = resolveCursorProfile(
      input([rule], {
        events: [
          {
            candidatePath: rule.path,
            kind: "agent-rule-selection",
            selection: "unknown",
            sequence: 1,
            targetPath: path("src/api.ts"),
          },
        ],
      }),
    );
    expect(unknownSelection.candidates[0]?.channels.agentRequested).toBe("indeterminate");
  });

  test("resolves unique and exact Manual mentions while retaining duplicate-name ambiguity", () => {
    const root = candidate(".cursor/rules/manual.mdc", mdc(["alwaysApply: false"]));
    const nested = candidate("services/api/.cursor/rules/manual.mdc", mdc(["alwaysApply: false"]));
    const ambiguous = resolveCursorProfile(
      input([nested, root], {
        events: [
          {
            candidatePath: null,
            kind: "manual-rule-mention",
            ruleName: "manual",
            sequence: 1,
            targetPath: path("services/api/index.ts"),
          },
        ],
      }),
    );
    expect(ambiguous.candidates.map((entry) => entry.channels.manual)).toEqual([
      "indeterminate",
      "indeterminate",
    ]);

    const exact = resolveCursorProfile(
      input([nested, root], {
        events: [
          {
            candidatePath: nested.path,
            kind: "manual-rule-mention",
            ruleName: "manual",
            sequence: 1,
            targetPath: path("services/api/index.ts"),
          },
        ],
      }),
    );
    expect(exact.candidates.find((entry) => entry.path === nested.path)?.activation).toBe("active");
    expect(exact.candidates.find((entry) => entry.path === root.path)?.activation).toBe("inactive");
  });

  test("keeps nested location eligibility separate from metadata interaction", () => {
    const nested = candidate("services/api/.cursor/rules/always.mdc", mdc(["alwaysApply: true"]));
    const inside = resolveCursorProfile(
      input([nested], {
        events: [{ kind: "reference-path", sequence: 1, targetPath: path("services/api/app.ts") }],
      }),
    );
    expect(inside.candidates[0]).toMatchObject({
      activation: "indeterminate",
      channels: { always: "active" },
      code: "mixed-mode",
      scopeRoot: "services/api",
    });

    const outside = resolveCursorProfile(
      input([nested], {
        events: [{ kind: "reference-path", sequence: 1, targetPath: path("frontend/app.ts") }],
      }),
    );
    expect(outside.candidates[0]).toMatchObject({
      activation: "inactive",
      channels: { always: "inactive" },
      code: "always-event",
    });
  });

  test("uses only the Cursor-owned unknown glob dialect and records versioned path events", () => {
    const auto = candidate(
      ".cursor/rules/auto.mdc",
      mdc(["alwaysApply: false", "globs: '**/*.ts'"]),
    );
    const referenced = resolveCursorProfile(input([auto]));
    expect(referenced.candidates[0]?.targetDecisions[0]).toMatchObject({
      autoActivation: "indeterminate",
      eventKind: "reference-path",
      globEligibility: "indeterminate",
      locationEligibility: "eligible",
      versionSupport: "compatible",
    });

    const beforeReadWrite = resolveCursorProfile(
      input([auto], {
        clientVersion: "0.48.9",
        events: [{ kind: "read-path", sequence: 1, targetPath: path("src/index.ts") }],
      }),
    );
    expect(beforeReadWrite.candidates[0]?.targetDecisions[0]).toMatchObject({
      autoActivation: "inactive",
      versionSupport: "unsupported",
    });

    const afterReadWrite = resolveCursorProfile(
      input([auto], {
        clientVersion: "0.49.0",
        events: [{ kind: "write-path", sequence: 1, targetPath: path("src/index.ts") }],
      }),
    );
    expect(afterReadWrite.candidates[0]?.targetDecisions[0]).toMatchObject({
      autoActivation: "indeterminate",
      versionSupport: "compatible",
    });

    const cli = resolveCursorProfile(
      input([auto], {
        clientVersion: "2026.05.24-dda726e",
        events: [{ kind: "read-path", sequence: 1, targetPath: path("src/index.ts") }],
        surfaceId: "cursor-agent/cli",
      }),
    );
    expect(cli.candidates[0]?.targetDecisions[0]?.versionSupport).toBe("unknown");
  });

  test("models settings, missing events, discovery, versions, and external context explicitly", () => {
    const always = candidate(".cursor/rules/always.mdc", mdc(["alwaysApply: true"]));
    const disabled = resolveCursorProfile(input([always], { projectRules: "disabled" }));
    expect(disabled.candidates[0]).toMatchObject({
      activation: "inactive",
      code: "project-rules-disabled",
    });
    const settingUnknown = resolveCursorProfile(input([always], { projectRules: "unknown" }));
    expect(settingUnknown.candidates[0]?.code).toBe("project-rules-setting-unknown");
    const noEvent = resolveCursorProfile(input([always], { eventState: "absent", events: [] }));
    expect(noEvent.candidates[0]).toMatchObject({
      activation: "indeterminate",
      code: "no-runtime-event",
    });
    const eventUnknown = resolveCursorProfile(
      input([always], { eventState: "unknown", events: [] }),
    );
    expect(eventUnknown.candidates[0]?.activation).toBe("indeterminate");
    const outside = resolveCursorProfile(input([always], { workspaceRoots: [path("services")] }));
    expect(outside.candidates[0]).toMatchObject({
      activation: "inactive",
      code: "not-discovered",
      discovery: "not-discovered",
    });
    const overlap = resolveCursorProfile(
      input([candidate("services/.cursor/rules/always.mdc", mdc(["alwaysApply: true"]))], {
        workspaceRoots: [path("."), path("services")],
      }),
    );
    expect(overlap.candidates[0]).toMatchObject({
      activation: "inactive",
      discovery: "unknown",
    });
    const old = resolveCursorProfile(input([always], { clientVersion: "0.44.9" }));
    expect(old.candidates[0]).toMatchObject({
      activation: "inactive",
      code: "unsupported-version",
    });
    const unknownVersion = resolveCursorProfile(input([always], { clientVersion: null }));
    expect(unknownVersion.candidates[0]?.code).toBe("unknown-version");
    const external = resolveCursorProfile(input([always], { externalContext: "present" }));
    expect(external).toMatchObject({ analysisStatus: "partial", externalContext: "present" });
    expect(external.candidates[0]).toMatchObject({
      activation: "active",
      code: "external-context",
    });
  });

  test("retains legacy surface support and coexistence without inventing precedence", () => {
    const legacy = candidate(".cursorrules", "Legacy @shared.md\n", "legacy");
    const ide = resolveCursorProfile(input([legacy]));
    expect(ide.candidates[0]).toMatchObject({
      activation: "indeterminate",
      code: "legacy-conditional",
    });
    const cli = resolveCursorProfile(
      input([legacy], {
        clientVersion: "2026.05.24-dda726e",
        surfaceId: "cursor-agent/cli",
      }),
    );
    expect(cli.candidates[0]?.code).toBe("unknown-surface-support");

    const always = candidate(".cursor/rules/always.mdc", mdc(["alwaysApply: true"]));
    const coexist = resolveCursorProfile(input([legacy, always]));
    expect(coexist.candidates.every((entry) => entry.activation === "indeterminate")).toBe(true);
    expect(coexist.candidates.find((entry) => entry.format === "mdc")?.code).toBe("mixed-mode");
  });

  test("keeps references conditional on the parent and never resolves an undocumented base", () => {
    const rule = candidate(
      ".cursor/rules/always.mdc",
      mdc(["alwaysApply: true"], "Use @shared/policy.md\n"),
    );
    const active = resolveCursorProfile(input([rule]));
    expect(active.candidates[0]?.references).toEqual([
      expect.objectContaining({
        candidateBases: ["rule-directory", "workspace-root"],
        rawSpecifier: "shared/policy.md",
        state: "indeterminate",
      }),
    ]);
    const disabled = resolveCursorProfile(input([rule], { projectRules: "disabled" }));
    expect(disabled.candidates[0]?.references[0]?.state).toBe("inactive");
  });

  test("denies malformed and undocumented mode syntax", () => {
    const malformed = resolveCursorProfile(
      input([candidate(".cursor/rules/bad.mdc", "---\nalwaysApply: [\n---\nBody\n")]),
    );
    expect(malformed.candidates[0]).toMatchObject({
      activation: "inactive",
      code: "malformed-syntax",
    });
    const unknown = resolveCursorProfile(
      input([candidate(".cursor/rules/unknown.mdc", mdc(["description: maybe"]))]),
    );
    expect(unknown.candidates[0]).toMatchObject({
      activation: "indeterminate",
      code: "unknown-mode",
    });
    const mixed = resolveCursorProfile(
      input([
        candidate(
          ".cursor/rules/mixed.mdc",
          mdc(["alwaysApply: false", "globs: '**/*.ts'", "description: maybe"]),
        ),
      ]),
    );
    expect(mixed.candidates[0]?.code).toBe("mixed-mode");

    const ambiguousLocation = resolveCursorProfile(
      input([
        candidate(".cursor/rules/nested/.cursor/rules/ambiguous.mdc", mdc(["alwaysApply: true"])),
      ]),
    );
    expect(ambiguousLocation.candidates[0]).toMatchObject({
      activation: "indeterminate",
      code: "mixed-mode",
      scopeRoot: null,
    });
  });

  test("sorts snapshots deterministically and freezes nested output", () => {
    const a = candidate(".cursor/rules/a.mdc", mdc(["alwaysApply: true"]));
    const b = candidate(".cursor/rules/b.mdc", mdc(["alwaysApply: true"]));
    const first = resolveCursorProfile(
      input([b, a], {
        events: [
          { kind: "write-path", sequence: 2, targetPath: path("src/b.ts") },
          { kind: "reference-path", sequence: 1, targetPath: path("src/a.ts") },
        ],
        workspaceRoots: [path("services"), path(".")],
      }),
    );
    const second = resolveCursorProfile(
      input([a, b], {
        events: [
          { kind: "reference-path", sequence: 1, targetPath: path("src/a.ts") },
          { kind: "write-path", sequence: 2, targetPath: path("src/b.ts") },
        ],
        workspaceRoots: [path("."), path("services")],
      }),
    );
    expect(first).toEqual(second);
    expect(first.candidates.map((entry) => entry.path)).toEqual([a.path, b.path]);
    expect(first.runtime.events.map((event) => event.sequence)).toEqual([1, 2]);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.candidates)).toBe(true);
    expect(Object.isFrozen(first.candidates[0]?.channels)).toBe(true);
    expect(Object.isFrozen(first.runtime)).toBe(true);
    expect(Object.isFrozen(first.runtime.events)).toBe(true);
    expect(Object.isFrozen(first.profile.formats)).toBe(true);
  });

  test("snapshots candidate bytes before parsing", () => {
    const bytes = ENCODER.encode(mdc(["alwaysApply: true"]));
    const candidateValue = { bytes, format: "mdc" as const, path: path(".cursor/rules/a.mdc") };
    const result = resolveCursorProfile(input([candidateValue]));
    bytes.fill(0x78);
    expect(result.candidates[0]?.syntax.text).toContain("alwaysApply: true");
  });

  test("rejects hostile records, arrays, proxies, accessors, and relationships", () => {
    const valid = input([candidate(".cursor/rules/a.mdc", mdc(["alwaysApply: true"]))]);
    const validCandidate = valid.candidates[0];
    if (validCandidate === undefined) throw new Error("test candidate is required");
    for (const value of [
      null,
      [],
      new Proxy(valid, {}),
      Object.create(valid),
      { ...valid, extra: 1 },
    ]) {
      expectProfileError(() => resolveCursorProfile(value), "CURSOR_PROFILE_INVALID_INPUT");
    }
    const revoked = Proxy.revocable(valid, {});
    revoked.revoke();
    expectProfileError(() => resolveCursorProfile(revoked.proxy), "CURSOR_PROFILE_INVALID_INPUT");
    const getter = vi.fn(() => []);
    const accessor = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessor, "candidates", { enumerable: true, get: getter });
    Object.defineProperty(accessor, "runtime", { enumerable: true, value: valid.runtime });
    expectProfileError(() => resolveCursorProfile(accessor), "CURSOR_PROFILE_INVALID_INPUT");
    expect(getter).not.toHaveBeenCalled();
    const symbolic = Object.create(null) as Record<PropertyKey, unknown>;
    symbolic["candidates"] = valid.candidates;
    symbolic[Symbol("runtime")] = valid.runtime;
    expectProfileError(() => resolveCursorProfile(symbolic), "CURSOR_PROFILE_INVALID_INPUT");
    const arrayGetter = vi.fn(() => validCandidate);
    const accessorArray: unknown[] = [];
    Object.defineProperty(accessorArray, "0", { enumerable: true, get: arrayGetter });
    expectProfileError(
      () => resolveCursorProfile({ ...valid, candidates: accessorArray }),
      "CURSOR_PROFILE_INVALID_INPUT",
    );
    expect(arrayGetter).not.toHaveBeenCalled();
    const extendedArray = [...valid.candidates] as unknown[] & { extra?: boolean };
    extendedArray.extra = true;
    expectProfileError(
      () => resolveCursorProfile({ ...valid, candidates: extendedArray }),
      "CURSOR_PROFILE_INVALID_INPUT",
    );

    for (const changed of [
      { candidates: new Proxy(valid.candidates as CursorRuleCandidateSnapshot[], {}) },
      { candidates: [{ ...valid.candidates[0], bytes: [] }] },
      {
        candidates: [{ ...validCandidate, bytes: new Proxy(validCandidate.bytes, {}) }],
      },
      { candidates: [{ ...valid.candidates[0], format: "other" }] },
      { candidates: [{ ...valid.candidates[0], path: "../escape" }] },
      { candidates: [...valid.candidates, validCandidate] },
    ]) {
      expect(() => resolveCursorProfile({ ...valid, ...changed })).toThrow(CursorProfileError);
    }

    for (const runtime of [
      { ...valid.runtime, surfaceId: "cursor-agent/other" },
      { ...valid.runtime, workspaceRoots: [] },
      { ...valid.runtime, workspaceRoots: [path("."), path(".")] },
      { ...valid.runtime, eventState: "present", events: [] },
      { ...valid.runtime, eventState: "absent" },
      { ...valid.runtime, events: [{ kind: "other", sequence: 1, targetPath: path("a") }] },
      {
        ...valid.runtime,
        events: [
          { kind: "reference-path", sequence: 1, targetPath: path("a") },
          { kind: "read-path", sequence: 1, targetPath: path("b") },
        ],
      },
      { ...valid.runtime, clientVersion: "bad version" },
      { ...valid.runtime, projectRules: "maybe" },
      { ...valid.runtime, externalContext: "maybe" },
      { ...valid.runtime, events: [null] },
      { ...valid.runtime, events: [{ sequence: 1, targetPath: path("a") }] },
      {
        ...valid.runtime,
        events: [{ kind: "reference-path", sequence: -1, targetPath: path("a") }],
      },
      {
        ...valid.runtime,
        events: [{ kind: "reference-path", sequence: 1.5, targetPath: path("a") }],
      },
      {
        ...valid.runtime,
        events: [{ kind: "reference-path", sequence: "1", targetPath: path("a") }],
      },
      {
        ...valid.runtime,
        events: [
          {
            candidatePath: null,
            kind: "manual-rule-mention",
            ruleName: "bad name",
            sequence: 1,
            targetPath: path("a"),
          },
        ],
      },
      {
        ...valid.runtime,
        events: [
          {
            candidatePath: null,
            kind: "manual-rule-mention",
            ruleName: "",
            sequence: 1,
            targetPath: path("a"),
          },
        ],
      },
      {
        ...valid.runtime,
        events: [
          {
            candidatePath: "../escape",
            kind: "manual-rule-mention",
            ruleName: "a",
            sequence: 1,
            targetPath: path("a"),
          },
        ],
      },
      {
        ...valid.runtime,
        events: [
          {
            candidatePath: validCandidate.path,
            kind: "agent-rule-selection",
            selection: "maybe",
            sequence: 1,
            targetPath: path("a"),
          },
        ],
      },
    ]) {
      expect(() => resolveCursorProfile({ candidates: valid.candidates, runtime })).toThrow(
        CursorProfileError,
      );
    }
  });

  test("enforces candidate, event, root, path, and byte resource limits", () => {
    const base = candidate(".cursor/rules/a.mdc", mdc(["alwaysApply: true"]));
    const valid = input([base]);
    expectProfileError(
      () =>
        resolveCursorProfile({
          ...valid,
          candidates: Array.from(
            { length: CURSOR_PROFILE_RESOLVER_LIMITS.maximumCandidates + 1 },
            () => base,
          ),
        }),
      "CURSOR_PROFILE_RESOURCE_LIMIT",
    );
    const aggregateCandidates = Array.from({ length: 65 }, (_, index) => ({
      bytes: new Uint8Array(CURSOR_PROFILE_RESOLVER_LIMITS.maximumCandidateBytes),
      format: "mdc" as const,
      path: path(`.cursor/rules/r${String(index)}.mdc`),
    }));
    expectProfileError(
      () => resolveCursorProfile({ ...valid, candidates: aggregateCandidates }),
      "CURSOR_PROFILE_RESOURCE_LIMIT",
    );
    expectProfileError(
      () =>
        resolveCursorProfile({
          ...valid,
          candidates: [
            {
              ...base,
              bytes: new Uint8Array(CURSOR_PROFILE_RESOLVER_LIMITS.maximumCandidateBytes + 1),
            },
          ],
        }),
      "CURSOR_PROFILE_RESOURCE_LIMIT",
    );
    expectProfileError(
      () =>
        resolveCursorProfile({
          candidates: valid.candidates,
          runtime: {
            ...valid.runtime,
            events: Array.from(
              { length: CURSOR_PROFILE_RESOLVER_LIMITS.maximumEvents + 1 },
              (_, sequence) => ({
                kind: "reference-path" as const,
                sequence,
                targetPath: path("a"),
              }),
            ),
          },
        }),
      "CURSOR_PROFILE_RESOURCE_LIMIT",
    );
    expectProfileError(
      () =>
        resolveCursorProfile({
          candidates: valid.candidates,
          runtime: {
            ...valid.runtime,
            workspaceRoots: Array.from(
              { length: CURSOR_PROFILE_RESOLVER_LIMITS.maximumWorkspaceRoots + 1 },
              (_, index) => path(`r${String(index)}`),
            ),
          },
        }),
      "CURSOR_PROFILE_RESOURCE_LIMIT",
    );
    expectProfileError(
      () =>
        resolveCursorProfile({
          ...valid,
          candidates: [
            {
              ...base,
              path: "a".repeat(
                CURSOR_PROFILE_RESOLVER_LIMITS.maximumPathBytes + 1,
              ) as RepositoryRelativePath,
            },
          ],
        }),
      "CURSOR_PROFILE_RESOURCE_LIMIT",
    );
    const longTarget = path(`t${"a".repeat(1_024)}`);
    expectProfileError(
      () =>
        resolveCursorProfile({
          candidates: valid.candidates,
          runtime: {
            ...valid.runtime,
            events: Array.from(
              { length: CURSOR_PROFILE_RESOLVER_LIMITS.maximumEvents },
              (_, sequence) => ({
                kind: "reference-path" as const,
                sequence,
                targetPath: longTarget,
              }),
            ),
          },
        }),
      "CURSOR_PROFILE_RESOURCE_LIMIT",
    );
  });
});
