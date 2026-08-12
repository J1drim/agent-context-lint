import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { beforeAll, describe, expect, test, vi } from "vitest";

import {
  INSTRUCTION_IR_CONTRACT_VERSION,
  validateDiagnosticBundle,
  validateInstructionIr,
} from "@agent-context/core";
import { loadBundledKnowledgePack, serializeStandardsLockfile } from "@agent-context/standards";
import {
  STANDARDS_FRESHNESS_DEFAULT_LIMITS,
  evaluateStandardsFreshnessRules,
  finalizeStandardsFreshnessSuppressions,
} from "../src/index.js";

import type {
  AstNode,
  AstNodeId,
  InstructionIr,
  RepositoryRelativePath,
  SourceDocument,
  SourceDocumentId,
  SourcePosition,
  SourceRange,
} from "@agent-context/core";
import type {
  LoadedBundledKnowledgePack,
  OfflineStandardsStatusRequest,
  StandardsUpdatePlan,
} from "@agent-context/standards";
import type {
  DeprecatedSyntaxObservation,
  StandardsFreshnessRuleInput,
  VerifiedLiveStandardsObservation,
} from "../src/index.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
let bundled: LoadedBundledKnowledgePack;
const PRECISION_CORPUS = new URL(
  "./fixtures/standards-freshness-precision.v0.json",
  import.meta.url,
);

interface PrecisionCorpus {
  readonly cases: readonly {
    readonly expectedRuleIds: readonly string[];
    readonly id: string;
    readonly scenario: string;
  }[];
  readonly precisionThreshold: number;
  readonly recordKind: string;
  readonly schemaVersion: string;
}

beforeAll(async () => {
  const loaded = await loadBundledKnowledgePack({ channel: "stable", engineVersion: "0.0.0" });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues));
  bundled = loaded.value;
});

function positionAt(text: string, offset: number): SourcePosition {
  let line = 0;
  let lineStart = 0;
  for (let index = 0; index < offset; index += 1) {
    if (text[index] === "\r" && text[index + 1] === "\n") {
      if (index + 1 < offset) {
        line += 1;
        lineStart = index + 2;
        index += 1;
      }
    } else if (text[index] === "\r" || text[index] === "\n") {
      line += 1;
      lineStart = index + 1;
    }
  }
  return {
    byteOffset: Buffer.byteLength(text.slice(0, offset), "utf8"),
    line,
    utf16Column: offset - lineStart,
    utf16Offset: offset,
  };
}

function lineEndingOf(text: string): SourceDocument["lineEnding"] {
  const forms = new Set<string>();
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\r" && text[index + 1] === "\n") {
      forms.add("crlf");
      index += 1;
    } else if (text[index] === "\r") forms.add("cr");
    else if (text[index] === "\n") forms.add("lf");
  }
  if (forms.size === 0) return "none";
  if (forms.size > 1) return "mixed";
  return [...forms][0] as SourceDocument["lineEnding"];
}

function irOf(text = "Apply repository instructions.\n"): InstructionIr {
  const sourceId = "source:agents" as SourceDocumentId;
  const children: AstNode[] = [...text.matchAll(/[^\r\n]+/gu)].map((match, index) => {
    const start = match.index;
    return {
      childIds: [],
      id: `node:agents:${String(index)}` as AstNodeId,
      kind:
        match[0].trimStart().startsWith("<!--") && match[0].trimEnd().endsWith("-->")
          ? "html-comment"
          : "paragraph",
      range: {
        end: positionAt(text, start + match[0].length),
        sourceId,
        start: positionAt(text, start),
      },
      sourceId,
    };
  });
  const source: SourceDocument = {
    bom: "none",
    byteLength: Buffer.byteLength(text, "utf8"),
    encoding: "utf-8",
    id: sourceId,
    lineEnding: lineEndingOf(text),
    parseState: { state: "complete" },
    path: "AGENTS.md" as RepositoryRelativePath,
    rootNodeId: "node:agents:root" as AstNodeId,
    sha256: createHash("sha256").update(text).digest("hex"),
    text,
    utf16Length: text.length,
  };
  const candidate: InstructionIr = {
    activationRules: [],
    contractVersion: INSTRUCTION_IR_CONTRACT_VERSION,
    documents: [],
    events: [],
    imports: [],
    nodes: [
      {
        childIds: children.map((node) => node.id),
        id: source.rootNodeId,
        kind: "root",
        range: {
          end: positionAt(text, text.length),
          sourceId,
          start: positionAt(text, 0),
        },
        sourceId,
      },
      ...children,
    ],
    recordKind: "agent-context-instruction-ir",
    sources: [source],
    statements: [],
    targets: [],
  };
  const validated = validateInstructionIr(candidate);
  if (!validated.ok) throw new Error(JSON.stringify(validated.issues));
  return validated.value;
}

function statusRequest(
  overrides: Partial<OfflineStandardsStatusRequest> = {},
): OfflineStandardsStatusRequest {
  return {
    asOf: "2026-08-02T12:00:00Z",
    bundled,
    cachedLatest: null,
    engineVersion: "0.0.0",
    lockfile: null,
    maxAgeDays: 30,
    ...overrides,
  };
}

function plan(
  channel: "preview" | "stable",
  overrides: Partial<StandardsUpdatePlan> = {},
): StandardsUpdatePlan {
  return {
    candidateLockSha256: HASH_C,
    checkedAt: "2026-08-02T11:00:00Z",
    contractVersion: "0.1.0",
    diff: {
      digest: { candidate: HASH_B, current: HASH_A },
      engineRequirement: { candidate: "0.0.0", current: "0.0.0" },
      rules: { added: ["ACL999"], removed: [] },
      version: { candidate: "2026.9.0", current: "2026.8.0" },
    },
    mode: "dry-run",
    noChanges: false,
    recordKind: "agent-context-standards-update",
    signer: {
      authorizedKeyCount: 3,
      metadataSha256: HASH_A,
      role: channel === "stable" ? "standards-stable" : "standards-preview",
      threshold: 2,
    },
    ...overrides,
  };
}

function live(
  channel: "preview" | "stable",
  value: StandardsUpdatePlan = plan(channel),
): VerifiedLiveStandardsObservation {
  return { channel, origin: "verified-live-h09", result: { ok: true, value } };
}

function trustFailure(channel: "preview" | "stable"): VerifiedLiveStandardsObservation {
  return {
    channel,
    origin: "verified-live-h09",
    result: {
      issues: [
        {
          code: "invalid-signature",
          message: "hostile message is never reflected",
          path: "$.metadata.signature",
          source: "check",
        },
      ],
      ok: false,
    },
  };
}

function input(overrides: Partial<StandardsFreshnessRuleInput> = {}): StandardsFreshnessRuleInput {
  return {
    anchorSourceId: "source:agents",
    contractVersion: "0.1.0",
    deprecatedSyntax: [],
    environment: "local",
    ir: irOf(),
    liveUpdates: [],
    previewEnabled: false,
    recordKind: "agent-context-standards-freshness-rule-input",
    statusRequest: statusRequest(),
    ...overrides,
  };
}

function markerRange(ir: InstructionIr, marker = "legacy-key"): SourceRange {
  const source = ir.sources[0];
  if (source === undefined) throw new Error("source missing");
  const start = source.text.indexOf(marker);
  if (start < 0) throw new Error("marker missing");
  return {
    end: positionAt(source.text, start + marker.length),
    sourceId: source.id,
    start: positionAt(source.text, start),
  };
}

function deprecation(ir: InstructionIr): DeprecatedSyntaxObservation {
  return {
    deprecatedSince: "2026-01-01",
    evidence: {
      evidenceRefId: "fixture:deprecated-syntax",
      retrievedAt: "2026-08-02",
      revision: "fixture-v1",
      url: "https://example.test/spec/deprecation",
    },
    pack: {
      digest: bundled.provenance.contentSha256,
      origin: "bundled",
      version: bundled.pack.packVersion,
    },
    profileId: "profile:fixture",
    range: markerRange(ir),
    replacementId: "current-key",
    sourceId: "source:agents",
    specSnapshotId: "profile:fixture/2026-08-02",
    subjectId: "legacy-key",
    surfaceId: "profile:fixture/cli",
  };
}

function authenticatedLock(): string {
  const serialized = serializeStandardsLockfile({
    channel: bundled.pack.channel,
    pack: {
      packId: bundled.pack.packId,
      packVersion: bundled.pack.packVersion,
      publishedAt: bundled.pack.publishedAt,
      schemaVersion: bundled.pack.schemaVersion,
    },
    recordKind: "agent-context-standards-lock",
    schemaVersion: "1.0.0",
    target: structuredClone(bundled.provenance.target),
    trustedState: structuredClone(bundled.provenance.trustedState),
    verificationTime: bundled.provenance.verificationTime,
  });
  if (!serialized.ok) throw new Error(JSON.stringify(serialized.issues));
  return serialized.text;
}

function evaluate(
  value: StandardsFreshnessRuleInput,
): Extract<ReturnType<typeof evaluateStandardsFreshnessRules>, { ok: true }> {
  const result = evaluateStandardsFreshnessRules(value);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  expect(validateDiagnosticBundle(result.bundle, result.sources).ok).toBe(true);
  return result;
}

function caseFor(ruleId: string, text?: string): StandardsFreshnessRuleInput {
  const ir = irOf(
    text ?? (ruleId === "ACL504" ? "legacy-key\n" : "Apply repository instructions.\n"),
  );
  if (ruleId === "ACL500")
    return input({
      ir,
      statusRequest: statusRequest({
        asOf: "2026-09-02T12:00:00Z",
        lockfile: authenticatedLock(),
        maxAgeDays: 1,
      }),
    });
  if (ruleId === "ACL501") return input({ ir, liveUpdates: [live("stable")] });
  if (ruleId === "ACL502")
    return input({
      ir,
      statusRequest: statusRequest({
        cachedLatest: {
          channel: "stable",
          checkedAt: "2026-08-02T11:00:00Z",
          minEngineVersion: "99.0.0",
          origin: "untrusted-offline-cache",
          packVersion: "2026.9.0",
          sha256: HASH_B,
        },
      }),
    });
  if (ruleId === "ACL503") return input({ ir, liveUpdates: [trustFailure("stable")] });
  if (ruleId === "ACL504") return input({ ir, deprecatedSyntax: [deprecation(ir)] });
  if (ruleId === "ACL505") return input({ environment: "ci", ir });
  if (ruleId === "ACL506") return input({ ir, liveUpdates: [live("preview")] });
  throw new Error(`unknown rule ${ruleId}`);
}

describe("F13 standards freshness and update-security rules", () => {
  test.each(["ACL500", "ACL501", "ACL502", "ACL503", "ACL504", "ACL505", "ACL506"])(
    "emits %s for its positive case with registry severity",
    (ruleId) => {
      const result = evaluate(caseFor(ruleId));
      const diagnostic = result.bundle.diagnostics.find((entry) => entry.ruleId === ruleId);
      expect(diagnostic).toBeDefined();
      expect(diagnostic?.severity).toBe(
        ruleId === "ACL502" || ruleId === "ACL503"
          ? "error"
          : ruleId === "ACL506"
            ? "info"
            : "warning",
      );
    },
  );

  test("preserves cached provenance without turning it into a live freshness claim", () => {
    const result = evaluate(
      input({
        statusRequest: statusRequest({
          cachedLatest: {
            channel: "stable",
            checkedAt: "2026-08-01T12:00:00Z",
            minEngineVersion: "0.0.0",
            origin: "untrusted-offline-cache",
            packVersion: "2026.9.0",
            sha256: HASH_B,
          },
        }),
      }),
    );
    const diagnostic = result.bundle.diagnostics.find((entry) => entry.ruleId === "ACL501");
    expect(diagnostic?.message).toContain("Cached offline observation");
    expect(diagnostic?.message).toContain("not a live freshness claim");
    expect(diagnostic?.fingerprintBasis.semantic.components).toContainEqual({
      key: "origin",
      value: "cached-offline",
    });
    expect(result.status.output.freshness).toBe("update-available");
  });

  test("prefers verified live stable evidence while retaining cached H06 status", () => {
    const result = evaluate(
      input({
        liveUpdates: [live("stable")],
        statusRequest: statusRequest({
          cachedLatest: {
            channel: "stable",
            checkedAt: "2026-08-01T12:00:00Z",
            minEngineVersion: "0.0.0",
            origin: "untrusted-offline-cache",
            packVersion: "2026.8.1",
            sha256: HASH_C,
          },
        }),
      }),
    );
    const findings = result.bundle.diagnostics.filter((entry) => entry.ruleId === "ACL501");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("Verified live standards check");
    expect(result.metrics.cachedObservationCount).toBe(1);
    expect(result.metrics.liveObservationCount).toBe(1);
  });

  test("does not report network failures as trust failures", () => {
    const result = evaluate(
      input({
        liveUpdates: [
          {
            channel: "stable",
            origin: "verified-live-h09",
            result: {
              issues: [{ code: "network-failure", message: "offline", path: "$", source: "check" }],
              ok: false,
            },
          },
        ],
      }),
    );
    expect(result.bundle.diagnostics.map((entry) => entry.ruleId)).not.toContain("ACL503");
  });

  test("keeps disabled preview silent without a successful H09 preview observation", () => {
    expect(evaluate(input()).bundle.diagnostics).toEqual([]);
    expect(
      evaluate(input({ previewEnabled: true, liveUpdates: [live("preview")] })).bundle.diagnostics,
    ).toEqual([]);
    expect(
      evaluate(input({ liveUpdates: [trustFailure("preview")] })).bundle.diagnostics.map(
        (entry) => entry.ruleId,
      ),
    ).toEqual(["ACL503"]);
  });

  test("uses caller time only and rejects observations from its future", () => {
    const clock = vi.spyOn(Date, "now");
    evaluate(input());
    expect(clock).not.toHaveBeenCalled();
    clock.mockRestore();
    const candidate = input({
      liveUpdates: [live("stable", plan("stable", { checkedAt: "2026-08-03T00:00:00Z" }))],
    });
    expect(evaluateStandardsFreshnessRules(candidate)).toMatchObject({
      issues: [{ code: "invalid-input", path: "$.liveUpdates" }],
      ok: false,
    });
  });

  test("fails closed on accessors, proxies, malformed H09 plans, and wrong selected-pack bindings", () => {
    const getter = structuredClone(input()) as unknown as Record<string, unknown>;
    Object.defineProperty(getter, "environment", { enumerable: true, get: () => "ci" });
    expect(evaluateStandardsFreshnessRules(getter)).toMatchObject({ ok: false });
    const revocable = Proxy.revocable(input(), {});
    revocable.revoke();
    expect(() => evaluateStandardsFreshnessRules(revocable.proxy)).not.toThrow();
    expect(evaluateStandardsFreshnessRules(revocable.proxy)).toMatchObject({ ok: false });

    const malformed = structuredClone(
      input({ liveUpdates: [live("stable")] }),
    ) as unknown as Record<string, unknown>;
    const observations = malformed["liveUpdates"] as Record<string, unknown>[];
    const result = observations[0]?.["result"] as Record<string, unknown>;
    const value = result["value"] as Record<string, unknown>;
    const signer = value["signer"] as Record<string, unknown>;
    signer["threshold"] = 1;
    expect(evaluateStandardsFreshnessRules(malformed)).toMatchObject({ ok: false });

    const ir = irOf("legacy-key\n");
    const wrong = structuredClone(deprecation(ir));
    (wrong.pack as { digest: string }).digest = HASH_C;
    expect(evaluateStandardsFreshnessRules(input({ ir, deprecatedSyntax: [wrong] }))).toMatchObject(
      {
        ok: false,
      },
    );
  });

  test("enforces collection resource limits and dense arrays", () => {
    expect(
      evaluateStandardsFreshnessRules(
        input({
          liveUpdates: Array.from(
            { length: STANDARDS_FRESHNESS_DEFAULT_LIMITS.liveUpdates + 1 },
            () => live("stable"),
          ),
        }),
      ),
    ).toMatchObject({ ok: false });
    const sparse = input() as unknown as Record<string, unknown>;
    sparse["deprecatedSyntax"] = new Array(2);
    expect(evaluateStandardsFreshnessRules(sparse)).toMatchObject({ ok: false });
  });

  test("rejects malformed top-level execution, IR, anchor, and H06 values", () => {
    for (const value of [
      null,
      [],
      new (class Input {
        readonly marker = true;
      })(),
      { ...input(), extra: true },
    ])
      expect(evaluateStandardsFreshnessRules(value)).toMatchObject({ ok: false });
    expect(evaluateStandardsFreshnessRules({ ...input(), environment: "build" })).toMatchObject({
      ok: false,
    });
    expect(evaluateStandardsFreshnessRules({ ...input(), previewEnabled: "false" })).toMatchObject({
      ok: false,
    });
    expect(
      evaluateStandardsFreshnessRules({ ...input(), anchorSourceId: "source:missing" }),
    ).toMatchObject({
      ok: false,
    });
    expect(evaluateStandardsFreshnessRules({ ...input(), ir: {} })).toMatchObject({ ok: false });
    expect(evaluateStandardsFreshnessRules({ ...input(), statusRequest: {} })).toMatchObject({
      issues: [{ code: "dependency-failure", path: "$.statusRequest" }],
      ok: false,
    });
  });

  test("rejects malformed H09 envelopes, issue records, and plan invariants", () => {
    const badValues: unknown[] = [
      [live("stable"), live("stable")],
      [{ ...live("stable"), origin: "cache" }],
      [
        {
          channel: "beta",
          origin: "verified-live-h09",
          result: { ok: true, value: plan("stable") },
        },
      ],
      [{ channel: "stable", origin: "verified-live-h09", result: {} }],
      [{ channel: "stable", origin: "verified-live-h09", result: { issues: [], ok: false } }],
      [
        {
          channel: "stable",
          origin: "verified-live-h09",
          result: {
            issues: [{ code: "x", message: "x", path: "$", source: "unknown" }],
            ok: false,
          },
        },
      ],
    ];
    for (const liveUpdates of badValues)
      expect(evaluateStandardsFreshnessRules({ ...input(), liveUpdates })).toMatchObject({
        issues: [{ path: "$.liveUpdates" }],
        ok: false,
      });

    const mutatePlan = (mutator: (value: Record<string, unknown>) => void): unknown => {
      const value = structuredClone(plan("stable")) as unknown as Record<string, unknown>;
      mutator(value);
      return [{ channel: "stable", origin: "verified-live-h09", result: { ok: true, value } }];
    };
    const malformedPlans = [
      mutatePlan((value) => {
        value["checkedAt"] = "not-an-instant";
      }),
      mutatePlan((value) => {
        value["candidateLockSha256"] = "bad";
      }),
      mutatePlan((value) => {
        value["mode"] = "apply";
      }),
      mutatePlan((value) => {
        value["noChanges"] = "false";
      }),
      mutatePlan((value) => {
        const signer = value["signer"] as Record<string, unknown>;
        signer["role"] = "standards-preview";
      }),
      mutatePlan((value) => {
        const diff = value["diff"] as Record<string, unknown>;
        const rules = diff["rules"] as Record<string, unknown>;
        rules["added"] = ["ACL999", "ACL999"];
      }),
      mutatePlan((value) => {
        const diff = value["diff"] as Record<string, unknown>;
        const rules = diff["rules"] as Record<string, unknown>;
        rules["added"] = ["ACL999", "ACL100"];
      }),
      mutatePlan((value) => {
        const diff = value["diff"] as Record<string, unknown>;
        const version = diff["version"] as Record<string, unknown>;
        version["candidate"] = "latest";
      }),
      mutatePlan((value) => {
        const diff = value["diff"] as Record<string, unknown>;
        const version = diff["version"] as Record<string, unknown>;
        version["candidate"] = null;
      }),
      mutatePlan((value) => {
        value["noChanges"] = true;
      }),
    ];
    for (const liveUpdates of malformedPlans)
      expect(evaluateStandardsFreshnessRules({ ...input(), liveUpdates })).toMatchObject({
        issues: [{ path: "$.liveUpdates" }],
        ok: false,
      });
  });

  test("handles SemVer prerelease boundaries and compatible/no-change H09 plans", () => {
    const unchanged = plan("stable", {
      candidateLockSha256: HASH_A,
      diff: {
        digest: { candidate: HASH_A, current: HASH_A },
        engineRequirement: { candidate: "0.0.0", current: "0.0.0" },
        rules: { added: [], removed: [] },
        version: { candidate: "2026.8.0", current: "2026.8.0" },
      },
      noChanges: true,
    });
    expect(
      evaluate(input({ liveUpdates: [live("stable", unchanged)] })).bundle.diagnostics,
    ).toEqual([]);
    expect(
      evaluate(
        input({
          liveUpdates: [
            live(
              "stable",
              plan("stable", {
                diff: {
                  ...plan("stable").diff,
                  engineRequirement: {
                    candidate: "1.0.0-alpha.10",
                    current: "0.0.0",
                  },
                },
              }),
            ),
          ],
          statusRequest: statusRequest({ engineVersion: "1.0.0-alpha.2" }),
        }),
      ).bundle.diagnostics.map((entry) => entry.ruleId),
    ).toContain("ACL502");
    expect(
      evaluate(
        input({
          liveUpdates: [
            live(
              "stable",
              plan("stable", {
                diff: {
                  ...plan("stable").diff,
                  version: { candidate: "2026.8.0-alpha.1", current: "2026.8.0" },
                },
              }),
            ),
          ],
        }),
      ).bundle.diagnostics.map((entry) => entry.ruleId),
    ).not.toContain("ACL501");
  });

  test("distinguishes invalid and unauthenticated lockfile trust results", () => {
    expect(
      evaluate(input({ statusRequest: statusRequest({ lockfile: "{}" }) })).bundle.diagnostics.find(
        (entry) => entry.ruleId === "ACL503",
      )?.message,
    ).toContain("canonical validation");

    const parsed = JSON.parse(authenticatedLock()) as Record<string, unknown>;
    const packValue = parsed["pack"] as Record<string, unknown>;
    const target = parsed["target"] as Record<string, unknown>;
    packValue["packVersion"] = "2026.7.0";
    target["packVersion"] = "2026.7.0";
    const serialized = serializeStandardsLockfile(parsed);
    if (!serialized.ok) throw new Error(JSON.stringify(serialized.issues));
    expect(
      evaluate(
        input({ statusRequest: statusRequest({ lockfile: serialized.text }) }),
      ).bundle.diagnostics.find((entry) => entry.ruleId === "ACL503")?.message,
    ).toContain("authenticated authority");
  });

  test("validates deprecation URLs, ranges, identities, dates, and nullable replacements", () => {
    const ir = irOf("legacy-key\nlegacy-key\n");
    const base = deprecation(ir);
    const future = { ...base, deprecatedSince: "2027-01-01", replacementId: null };
    expect(evaluate(input({ ir, deprecatedSyntax: [future] })).bundle.diagnostics).toEqual([]);
    const invalids: DeprecatedSyntaxObservation[] = [
      { ...base, deprecatedSince: null as unknown as string },
      { ...base, deprecatedSince: "2026-02-31" },
      { ...base, evidence: { ...base.evidence, url: "http://example.test/spec" } },
      { ...base, evidence: { ...base.evidence, url: "not a URL" } },
      { ...base, range: { ...base.range, end: { ...base.range.end, byteOffset: 100_000 } } },
      {
        ...base,
        range: {
          ...base.range,
          start: { ...base.range.start, byteOffset: base.range.end.byteOffset + 1 },
        },
      },
      { ...base, range: { ...base.range, start: { ...base.range.start, line: -1 } } },
    ];
    for (const value of invalids)
      expect(
        evaluateStandardsFreshnessRules(input({ ir, deprecatedSyntax: [value] })),
      ).toMatchObject({
        issues: [{ path: "$.deprecatedSyntax" }],
        ok: false,
      });
    expect(
      evaluateStandardsFreshnessRules(input({ ir, deprecatedSyntax: [base, base] })),
    ).toMatchObject({ ok: false });
  });

  test("requires scalar-safe source-exact UTF-16, UTF-8, line, and column positions", () => {
    const unicodeIr = irOf("heading\r\n😀 legacy-key\r\n");
    const exact = deprecation(unicodeIr);
    expect(
      evaluate(input({ ir: unicodeIr, deprecatedSyntax: [exact] })).bundle.diagnostics.map(
        (entry) => entry.ruleId,
      ),
    ).toEqual(["ACL504"]);
    const source = unicodeIr.sources[0];
    if (source === undefined) throw new Error("source missing");
    const scalar = source.text.indexOf("😀");
    const splitScalar = {
      ...exact,
      range: {
        ...exact.range,
        start: {
          byteOffset: Buffer.byteLength(source.text.slice(0, scalar + 1), "utf8"),
          line: 1,
          utf16Column: 1,
          utf16Offset: scalar + 1,
        },
      },
    };
    expect(
      evaluateStandardsFreshnessRules(input({ ir: unicodeIr, deprecatedSyntax: [splitScalar] })),
    ).toMatchObject({ ok: false });
    expect(
      evaluateStandardsFreshnessRules(
        input({
          ir: unicodeIr,
          deprecatedSyntax: [
            {
              ...exact,
              range: {
                ...exact.range,
                start: { ...exact.range.start, utf16Column: exact.range.start.utf16Column + 1 },
              },
            },
          ],
        }),
      ),
    ).toMatchObject({ ok: false });
  });

  test("rejects forged finalization contexts and malformed added diagnostics", () => {
    expect(finalizeStandardsFreshnessSuppressions(null)).toMatchObject({ ok: false });
    expect(finalizeStandardsFreshnessSuppressions({})).toMatchObject({ ok: false });
    const evaluation = evaluate(caseFor("ACL505"));
    const sparse = new Array(1);
    expect(finalizeStandardsFreshnessSuppressions(evaluation, sparse)).toMatchObject({ ok: false });
    expect(finalizeStandardsFreshnessSuppressions(evaluation, [{}])).toMatchObject({ ok: false });
  });

  test.each(["ACL500", "ACL501", "ACL502", "ACL503", "ACL504", "ACL505", "ACL506"])(
    "suppresses %s through the real B08 matcher",
    (ruleId) => {
      const text = `<!-- agent-context-lint-disable-next-line ${ruleId} -- fixture -->\n${
        ruleId === "ACL504" ? "legacy-key" : "Apply repository instructions."
      }\n`;
      const evaluation = evaluate(caseFor(ruleId, text));
      const finalized = finalizeStandardsFreshnessSuppressions(evaluation);
      expect(finalized.ok).toBe(true);
      if (!finalized.ok) throw new Error(JSON.stringify(finalized.issues));
      expect(finalized.suppressedDiagnostics.map((entry) => entry.ruleId)).toContain(ruleId);
      expect(finalized.visibleDiagnostics.map((entry) => entry.ruleId)).not.toContain(ruleId);
    },
  );

  test("orders output deterministically independent of observation input order", () => {
    const first = evaluate(
      input({ environment: "ci", liveUpdates: [live("stable"), live("preview")] }),
    );
    const second = evaluate(
      input({ environment: "ci", liveUpdates: [live("preview"), live("stable")] }),
    );
    expect(first.bundle).toEqual(second.bundle);
    expect(first.bundle.diagnostics.map((entry) => entry.ruleId)).toEqual([
      "ACL501",
      "ACL505",
      "ACL506",
    ]);
  });

  test("meets the labeled precision corpus without speculative findings", () => {
    const corpus = JSON.parse(readFileSync(PRECISION_CORPUS, "utf8")) as PrecisionCorpus;
    expect(corpus).toMatchObject({
      precisionThreshold: 0.95,
      recordKind: "agent-context-standards-freshness-precision-corpus",
      schemaVersion: "0.1.0",
    });
    const valueFor = (scenario: string): StandardsFreshnessRuleInput => {
      if (scenario === "stable-update") return caseFor("ACL501");
      if (scenario === "trust-failure") return caseFor("ACL503");
      if (scenario === "ci-missing") return caseFor("ACL505");
      if (scenario === "baseline") return input();
      if (scenario === "local") return input({ environment: "local" });
      if (scenario === "preview-enabled")
        return input({ previewEnabled: true, liveUpdates: [live("preview")] });
      if (scenario === "timeout")
        return input({
          liveUpdates: [
            {
              channel: "stable",
              origin: "verified-live-h09",
              result: {
                issues: [{ code: "timeout", message: "timeout", path: "$", source: "check" }],
                ok: false,
              },
            },
          ],
        });
      throw new Error(`unknown precision scenario ${scenario}`);
    };
    let truePositive = 0;
    let falsePositive = 0;
    for (const item of corpus.cases) {
      const actual = evaluate(valueFor(item.scenario)).bundle.diagnostics.map(
        (entry) => entry.ruleId,
      );
      truePositive += actual.filter((entry) => item.expectedRuleIds.includes(entry)).length;
      falsePositive += actual.filter((entry) => !item.expectedRuleIds.includes(entry)).length;
      expect(actual, item.id).toEqual(item.expectedRuleIds);
    }
    expect(truePositive / (truePositive + falsePositive)).toBeGreaterThanOrEqual(
      corpus.precisionThreshold,
    );
  });
});
