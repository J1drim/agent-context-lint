import { readFileSync } from "node:fs";

import { describe, expect, test, vi } from "vitest";

import {
  normalizeAndClassifyStatement,
  STATEMENT_CLASSIFIER_DEFAULT_LIMITS,
  STATEMENT_DOMAINS,
  StatementClassifierError,
  StatementClassifierErrorCode,
} from "../src/index.js";
import type {
  StatementClassifierInput,
  StatementClassifierResult,
  StatementDomain,
} from "../src/index.js";

interface LabeledCase {
  readonly expectedDomains: readonly StatementDomain[];
  readonly id: string;
  readonly text: string;
}

interface LabeledFixture {
  readonly cases: readonly LabeledCase[];
  readonly contractVersion: "0.1.0";
  readonly minimumPositiveLabelsPerDomain: number;
  readonly precisionThreshold: number;
}

const fixture = JSON.parse(
  readFileSync(
    new URL("../../../conformance/fixtures/v0/statement-classifier.fixture.json", import.meta.url),
    "utf8",
  ),
) as LabeledFixture;

function input(text: string): StatementClassifierInput {
  const byteLength = new TextEncoder().encode(text).length;
  const lines = text.split(/\r\n|\r|\n/u);
  const finalLine = lines.at(-1) ?? "";
  return {
    documentId: "document-000001" as StatementClassifierInput["documentId"],
    nodeIds: ["node-000001" as StatementClassifierInput["nodeIds"][number]],
    range: {
      end: {
        byteOffset: byteLength,
        line: 2 + lines.length - 1,
        utf16Column: lines.length === 1 ? text.length : finalLine.length,
        utf16Offset: text.length,
      },
      sourceId: "source-000001" as StatementClassifierInput["range"]["sourceId"],
      start: { byteOffset: 0, line: 2, utf16Column: 0, utf16Offset: 0 },
    },
    statementId: "statement-000001" as StatementClassifierInput["statementId"],
    text,
  };
}

function classify(text: string): StatementClassifierResult {
  return normalizeAndClassifyStatement(input(text));
}

describe("statement normalizer and classifier", () => {
  test("normalizes structural Markdown, line endings, Unicode, links, code, spacing, and case", () => {
    const source = "  > - [x] USE Cafe\u0301\r\n\t[`PNPM`](https://pnpm.io)   always.  ";
    const result = classify(source);

    expect(result.normalizedText).toBe("use café pnpm always");
    expect(result.statement.text).toBe(source);
    expect(result.tokens).toEqual([
      { end: 3, start: 0, text: "use" },
      { end: 8, start: 4, text: "café" },
      { end: 13, start: 9, text: "pnpm" },
      { end: 20, start: 14, text: "always" },
    ]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.statement.range.start)).toBe(true);
    expect(Object.isFrozen(result.tokens)).toBe(true);
  });

  test("emits deterministic multi-domain claims and a B03-compatible primary classification", () => {
    const result = classify("Always run pnpm tests.");

    expect(result.domains.map((entry) => entry.domain)).toEqual([
      "package-manager",
      "command",
      "testing",
    ]);
    expect(result.classification).toEqual({
      action: "select-package-manager",
      categoryId: "package-manager",
      confidence: 0.99,
      modality: "must",
      normalizedText: "always run pnpm tests",
      object: "pnpm",
      state: "classified",
      subject: null,
    });
    expect(result.evidence).toEqual([
      expect.objectContaining({
        domain: "package-manager",
        matchedText: "always run pnpm",
        normalizedEnd: 15,
        normalizedStart: 0,
        ruleId: "package-manager.command",
      }),
      expect.objectContaining({ domain: "command", ruleId: "command.run" }),
      expect.objectContaining({ domain: "testing", ruleId: "testing.run" }),
    ]);
    expect(result.uncertainty).toEqual({ state: "known" });
    expect(result.statement.classification).toBe(result.classification);
  });

  test.each([
    ["Do not use bun.", "must-not"],
    ["Tests should pass.", "should"],
    ["Prefer prettier to format code.", "preference"],
    ["Run make verify.", "must"],
  ] as const)("assigns %s modality deterministically", (text, modality) => {
    expect(classify(text).domains[0]?.modality).toBe(modality);
  });

  test("retains unmatched prose as explicitly unclassified instead of guessing", () => {
    const result = classify("The repository was created in 2024.");
    expect(result.classification).toEqual({ state: "unclassified" });
    expect(result.domains).toEqual([]);
    expect(result.evidence).toEqual([]);
    expect(result.uncertainty).toEqual({
      reason: "no high-confidence deterministic domain template matched",
      state: "unknown",
    });
  });

  test("meets every per-domain labeled precision threshold with sufficient positive labels", () => {
    expect(fixture.contractVersion).toBe("0.1.0");
    expect(fixture.minimumPositiveLabelsPerDomain).toBe(8);
    expect(fixture.precisionThreshold).toBe(0.95);
    expect(new Set(fixture.cases.map((entry) => entry.id)).size).toBe(fixture.cases.length);
    for (const entry of fixture.cases) {
      expect(entry.text.length, `${entry.id} text`).toBeGreaterThan(0);
      expect(
        [...entry.expectedDomains].sort(
          (left, right) => STATEMENT_DOMAINS.indexOf(left) - STATEMENT_DOMAINS.indexOf(right),
        ),
      ).toEqual(entry.expectedDomains);
      expect(new Set(entry.expectedDomains).size, `${entry.id} unique labels`).toBe(
        entry.expectedDomains.length,
      );
    }
    const predictions = fixture.cases.map((entry) => ({
      entry,
      predicted: classify(entry.text).domains.map((domain) => domain.domain),
    }));

    for (const domain of STATEMENT_DOMAINS) {
      const positives = fixture.cases.filter((entry) => entry.expectedDomains.includes(domain));
      expect(positives.length, `${domain} positive-label count`).toBeGreaterThanOrEqual(
        fixture.minimumPositiveLabelsPerDomain,
      );
      let truePositive = 0;
      let falsePositive = 0;
      for (const { entry, predicted } of predictions) {
        if (!predicted.includes(domain)) continue;
        if (entry.expectedDomains.includes(domain)) truePositive += 1;
        else falsePositive += 1;
      }
      const precision = truePositive / (truePositive + falsePositive);
      expect(precision, `${domain} precision`).toBeGreaterThanOrEqual(fixture.precisionThreshold);
    }

    for (const { entry, predicted } of predictions)
      expect(predicted, entry.id).toEqual(entry.expectedDomains);
  });

  test("preserves source provenance and deterministic byte output across calls", () => {
    const value = input("src/api is owned by platform-team.");
    const first = normalizeAndClassifyStatement(value);
    const second = normalizeAndClassifyStatement(value);
    expect(second).toEqual(first);
    expect(first.statement).toMatchObject({
      documentId: value.documentId,
      id: value.statementId,
      nodeIds: value.nodeIds,
      range: value.range,
    });
    expect(first.domains[0]).toMatchObject({
      action: "assign-owner",
      domain: "file-ownership",
      object: "src/api",
      subject: "platform-team",
    });
  });

  test.each([
    [null, "input must be a non-proxy plain object"],
    [{}, "input.text must be a string"],
    [{ ...input("ok"), extra: true }, "input contains an unknown field"],
    [
      { ...input("ok"), statementId: "has space" },
      "input.statementId must be a bounded stable identifier",
    ],
    [{ ...input("ok"), nodeIds: [] }, "input.nodeIds must not be empty"],
    [{ ...input("ok"), nodeIds: ["node-2", "node-1"] }, "input.nodeIds must be sorted and unique"],
    [{ ...input("ok"), text: "\ud800" }, "input.text must contain well-formed Unicode"],
  ])("rejects malformed input %#", (value, message) => {
    expect(() => normalizeAndClassifyStatement(value)).toThrow(
      expect.objectContaining({ code: StatementClassifierErrorCode.invalidInput, message }),
    );
  });

  test("rejects proxies, accessors, sparse arrays, symbols, and forged ranges without invoking traps", () => {
    const trap = vi.fn();
    expect(() => normalizeAndClassifyStatement(new Proxy(input("ok"), { ownKeys: trap }))).toThrow(
      StatementClassifierError,
    );
    expect(trap).not.toHaveBeenCalled();

    const hostile = { ...input("ok") } as Record<string, unknown>;
    Object.defineProperty(hostile, "text", { get: trap });
    expect(() => normalizeAndClassifyStatement(hostile)).toThrow(StatementClassifierError);
    expect(trap).not.toHaveBeenCalled();
    expect(() =>
      normalizeAndClassifyStatement({ ...input("ok"), [Symbol("hostile")]: true }),
    ).toThrow(StatementClassifierError);

    const sparse = new Array<string>(2);
    sparse[1] = "node-2";
    expect(() => normalizeAndClassifyStatement({ ...input("ok"), nodeIds: sparse })).toThrow(
      StatementClassifierError,
    );

    const nodeIds = ["node-1"];
    Object.defineProperty(nodeIds, 0, { get: trap });
    expect(() => normalizeAndClassifyStatement({ ...input("ok"), nodeIds })).toThrow(
      StatementClassifierError,
    );
    expect(trap).not.toHaveBeenCalled();

    const extraNodeProperty = input("ok").nodeIds.slice() as string[] & { extra?: boolean };
    extraNodeProperty.extra = true;
    expect(() =>
      normalizeAndClassifyStatement({ ...input("ok"), nodeIds: extraNodeProperty }),
    ).toThrow(StatementClassifierError);

    const reversed = input("ok");
    const invalidRange = {
      ...reversed,
      range: {
        ...reversed.range,
        end: { byteOffset: 1, line: 1, utf16Column: 0, utf16Offset: 1 },
        start: { byteOffset: 2, line: 2, utf16Column: 0, utf16Offset: 2 },
      },
    };
    expect(() => normalizeAndClassifyStatement(invalidRange)).toThrow(StatementClassifierError);

    const mismatchedSpan = input("ok");
    expect(() =>
      normalizeAndClassifyStatement({
        ...mismatchedSpan,
        range: {
          ...mismatchedSpan.range,
          end: { ...mismatchedSpan.range.end, byteOffset: 3, utf16Offset: 3 },
        },
      }),
    ).toThrow(StatementClassifierError);

    const mismatchedPosition = input("ok");
    expect(() =>
      normalizeAndClassifyStatement({
        ...mismatchedPosition,
        range: {
          ...mismatchedPosition.range,
          end: { ...mismatchedPosition.range.end, utf16Column: 9 },
        },
      }),
    ).toThrow(StatementClassifierError);
  });

  test.each([
    ["maximumInputLength", input("ab")],
    ["maximumNodeIds", { ...input("ok"), nodeIds: ["node-1", "node-2"] }],
    ["maximumTokens", input("two tokens")],
    ["maximumEvidence", input("Always use pnpm because the package manager is pnpm")],
  ] as const)("enforces %s", (limitName, value) => {
    expect(() =>
      normalizeAndClassifyStatement(value, {
        ...STATEMENT_CLASSIFIER_DEFAULT_LIMITS,
        [limitName]: 1,
      }),
    ).toThrow(
      expect.objectContaining({
        code: StatementClassifierErrorCode.limitExceeded,
        limitName,
      }),
    );
  });

  test("rejects malformed options", () => {
    expect(() => normalizeAndClassifyStatement(input("ok"), new Date())).toThrow(
      expect.objectContaining({ code: StatementClassifierErrorCode.invalidOptions }),
    );
    expect(() => normalizeAndClassifyStatement(input("ok"), { maximumTokens: 0 })).toThrow(
      expect.objectContaining({
        code: StatementClassifierErrorCode.invalidOptions,
        limitName: "maximumTokens",
      }),
    );
  });
});
