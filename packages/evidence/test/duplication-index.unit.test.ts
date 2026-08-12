import { describe, expect, test, vi } from "vitest";

import {
  buildDuplicationIndex,
  DUPLICATION_INDEX_DEFAULT_LIMITS,
  DUPLICATION_SIMILARITY_ALGORITHM,
  DuplicationIndexError,
  DuplicationIndexErrorCode,
} from "../src/index.js";
import type { DuplicationIndexEntry, DuplicationIndexOptions } from "../src/index.js";

function entry(statementId: string, normalizedText: string): DuplicationIndexEntry {
  return {
    documentId: `document-${statementId}` as DuplicationIndexEntry["documentId"],
    nodeIds: [`node-${statementId}` as DuplicationIndexEntry["nodeIds"][number]],
    normalizedText,
    range: {
      end: {
        byteOffset: normalizedText.length,
        line: 0,
        utf16Column: normalizedText.length,
        utf16Offset: normalizedText.length,
      },
      sourceId: `source-${statementId}` as DuplicationIndexEntry["range"]["sourceId"],
      start: { byteOffset: 0, line: 0, utf16Column: 0, utf16Offset: 0 },
    },
    statementId: statementId as DuplicationIndexEntry["statementId"],
  };
}

function options(value: DuplicationIndexOptions): DuplicationIndexOptions {
  return { ...DUPLICATION_INDEX_DEFAULT_LIMITS, ...value };
}

describe("duplication index", () => {
  test("builds stable exact clusters with source evidence and content digests", () => {
    const entries = [
      entry("statement-01", "always run tests before merging"),
      entry("statement-02", "always run tests before merging"),
      entry("statement-03", "use pnpm for dependencies"),
    ];
    const result = buildDuplicationIndex(entries);

    expect(result.exactClusters).toHaveLength(1);
    expect(result.exactClusters[0]).toMatchObject({
      kind: "exact",
      members: [
        {
          documentId: "document-statement-01",
          statementId: "statement-01",
        },
        {
          documentId: "document-statement-02",
          statementId: "statement-02",
        },
      ],
      similarityBasisPoints: 10_000,
    });
    expect(result.exactClusters[0]?.id).toMatch(/^duplicate-exact-[a-f0-9]{20}$/u);
    expect(result.exactClusters[0]?.normalizedTextSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.metrics).toMatchObject({
      entryCount: 3,
      exactClusterCount: 1,
      exactDuplicateEntryCount: 2,
      uniqueNormalizedTextCount: 2,
    });
    expect(result.similarity).toEqual({
      algorithm: "unicode-code-point-trigram-jaccard-v1",
      candidateStrategy: "globally-rarest-bounded-shingles",
      measure: "set-jaccard",
      minimumSimilarityBasisPoints: 8_000,
      normalizationContractVersion: "0.1.0",
      shingleUnit: "unicode-code-point",
      shingleWidth: 3,
    });
    expect(DUPLICATION_SIMILARITY_ALGORITHM).toBe("unicode-code-point-trigram-jaccard-v1");
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.exactClusters[0]?.members[0]?.range.start)).toBe(true);
  });

  test("accepts a near edge at the exact integer threshold and rejects it above the threshold", () => {
    const entries = [
      entry("statement-01", "always run pnpm tests before merging"),
      entry("statement-02", "always run pnpm tests before merge"),
    ];
    const included = buildDuplicationIndex(
      entries,
      options({ minimumSimilarityBasisPoints: 8_421 }),
    );
    expect(included.nearClusters[0]?.edges).toEqual([
      {
        intersectionShingles: 32,
        leftStatementId: "statement-02",
        rightStatementId: "statement-01",
        similarityBasisPoints: 8_421,
        unionShingles: 38,
      },
    ]);
    expect(included.nearClusters[0]?.members.map((member) => member.statementId)).toEqual([
      "statement-01",
      "statement-02",
    ]);
    expect(
      buildDuplicationIndex(entries, options({ minimumSimilarityBasisPoints: 8_422 })).nearClusters,
    ).toEqual([]);
  });

  test("expands exact members into near clusters without losing the separate exact cluster", () => {
    const result = buildDuplicationIndex([
      entry("statement-01", "do not edit generated files directly"),
      entry("statement-02", "do not edit generated files directly"),
      entry("statement-03", "do not edit generated file directly"),
    ]);
    expect(result.exactClusters[0]?.members.map((member) => member.statementId)).toEqual([
      "statement-01",
      "statement-02",
    ]);
    expect(result.nearClusters[0]?.members.map((member) => member.statementId)).toEqual([
      "statement-01",
      "statement-02",
      "statement-03",
    ]);
    expect(result.nearClusters[0]?.edges[0]).toMatchObject({ similarityBasisPoints: 8_684 });
  });

  test("forms deterministic connected components and retains only qualifying edges", () => {
    const values = [
      entry("statement-01", "always run the complete unit test suite before merging"),
      entry("statement-02", "always run the complete unit tests before merging"),
      entry("statement-03", "always run complete unit tests before merging"),
    ];
    const first = buildDuplicationIndex(values, options({ minimumSimilarityBasisPoints: 7_000 }));
    const second = buildDuplicationIndex(values, options({ minimumSimilarityBasisPoints: 7_000 }));
    expect(second).toEqual(first);
    expect(first.nearClusters).toHaveLength(1);
    expect(first.nearClusters[0]?.members).toHaveLength(3);
    expect(first.nearClusters[0]?.edges.length).toBeGreaterThanOrEqual(2);
    expect(first.nearClusters[0]?.id).toMatch(/^duplicate-near-[a-f0-9]{20}$/u);
  });

  test("uses code points without whitespace tokenization or cross-script folding", () => {
    const result = buildDuplicationIndex(
      [
        entry("statement-01", "在提交代码之前必须运行所有单元测试并确认结果通过"),
        entry("statement-02", "在提交代码之前必须运行所冇单元测试并确认结果通过"),
        entry("statement-03", "перед слиянием запустите все тесты"),
        entry("statement-04", "قبل الدمج شغّل جميع الاختبارات"),
        entry("statement-05", "keep the build green 🧪"),
      ],
      options({ minimumSimilarityBasisPoints: 7_000 }),
    );

    expect(result.nearClusters).toHaveLength(1);
    expect(result.nearClusters[0]?.members.map((member) => member.statementId)).toEqual([
      "statement-01",
      "statement-02",
    ]);
    expect(result.nearClusters[0]?.edges[0]?.similarityBasisPoints).toBeGreaterThanOrEqual(7_000);
    expect(result.metrics.entryCount).toBe(5);
  });

  test("retains exact short duplicates while explicitly excluding short text from near matching", () => {
    const result = buildDuplicationIndex([
      entry("statement-01", "run tests"),
      entry("statement-02", "run tests"),
      entry("statement-03", "run test"),
      entry("statement-04", ""),
    ]);
    expect(result.exactClusters).toHaveLength(1);
    expect(result.nearClusters).toEqual([]);
    expect(result.exclusions.map(({ evidence, reason }) => [evidence.statementId, reason])).toEqual(
      [
        ["statement-01", "near-text-too-short"],
        ["statement-02", "near-text-too-short"],
        ["statement-03", "near-text-too-short"],
        ["statement-04", "empty-normalized-text"],
      ],
    );
  });

  test("bounds high-support anchors deterministically instead of creating quadratic candidates", () => {
    const entries = [
      entry("statement-01", "always run tests before merging alpha"),
      entry("statement-02", "always run tests before merging beta"),
      entry("statement-03", "always run tests before merging gamma"),
    ];
    const result = buildDuplicationIndex(entries, options({ maximumPostingLength: 1 }));
    expect(result.nearClusters).toEqual([]);
    expect(result.metrics.candidateComparisons).toBe(0);
  });

  test("collapses a large exact corpus before near comparison", () => {
    const entries = Array.from({ length: 20_000 }, (_, index) =>
      entry(`statement-${String(index).padStart(5, "0")}`, "always run all tests before merging"),
    );
    const result = buildDuplicationIndex(entries);
    expect(result).toMatchObject({
      metrics: {
        candidateComparisons: 0,
        entryCount: 20_000,
        exactClusterCount: 1,
        exactDuplicateEntryCount: 20_000,
        uniqueNormalizedTextCount: 1,
      },
    });
    expect(result.exactClusters[0]?.members).toHaveLength(20_000);
  });

  test.each([
    [null, "entries must be a non-proxy array"],
    [[null], "entries[0] must be a non-proxy plain object"],
    [
      [entry("statement-02", "valid text here"), entry("statement-01", "valid text here")],
      "entries must be sorted by unique statementId",
    ],
    [
      [{ ...entry("statement-01", "valid text here"), extra: true }],
      "entries[0] contains an unknown field",
    ],
    [
      [{ ...entry("statement-01", "valid text here"), statementId: "" }],
      "entries[0].statementId must be a bounded stable identifier",
    ],
    [
      [{ ...entry("statement-01", "valid text here"), normalizedText: 42 }],
      "entries[0].normalizedText must be a string",
    ],
    [
      [{ ...entry("statement-01", "valid text here"), normalizedText: "Upper case" }],
      "entries[0].normalizedText must be canonical F03 normalized text",
    ],
    [
      [{ ...entry("statement-01", "valid text here"), normalizedText: "cafe\u0301" }],
      "entries[0].normalizedText must be canonical F03 normalized text",
    ],
    [
      [{ ...entry("statement-01", "valid text here"), normalizedText: "two  spaces" }],
      "entries[0].normalizedText must be canonical F03 normalized text",
    ],
    [
      [{ ...entry("statement-01", "valid text here"), normalizedText: "bad\ud800" }],
      "entries[0].normalizedText must contain well-formed Unicode",
    ],
    [
      [{ ...entry("statement-01", "valid text here"), normalizedText: "bad\udc00" }],
      "entries[0].normalizedText must contain well-formed Unicode",
    ],
    [
      [{ ...entry("statement-01", "valid text here"), nodeIds: null }],
      "entries[0].nodeIds must be a non-proxy array",
    ],
    [
      [{ ...entry("statement-01", "valid text here"), nodeIds: [] }],
      "entries[0].nodeIds must not be empty",
    ],
    [
      [{ ...entry("statement-01", "valid text here"), nodeIds: ["node-2", "node-1"] }],
      "entries[0].nodeIds must be sorted and unique",
    ],
  ])("rejects malformed input %#", (value, message) => {
    expect(() => buildDuplicationIndex(value)).toThrow(
      expect.objectContaining({ code: DuplicationIndexErrorCode.invalidInput, message }),
    );
  });

  test("rejects proxies, sparse arrays, symbols, accessors, node extras, and reversed ranges", () => {
    const trap = vi.fn();
    expect(() => buildDuplicationIndex(new Proxy([], { ownKeys: trap }))).toThrow(
      DuplicationIndexError,
    );
    expect(trap).not.toHaveBeenCalled();

    const sparse = new Array<DuplicationIndexEntry>(2);
    sparse[1] = entry("statement-02", "valid normalized statement");
    expect(() => buildDuplicationIndex(sparse)).toThrow(DuplicationIndexError);
    expect(() =>
      buildDuplicationIndex(
        Object.assign([entry("statement-01", "valid normalized statement")], {
          [Symbol("extra")]: true,
        }),
      ),
    ).toThrow(DuplicationIndexError);

    const hostile = entry("statement-01", "valid normalized statement") as unknown as Record<
      string,
      unknown
    >;
    Object.defineProperty(hostile, "normalizedText", { get: trap });
    expect(() => buildDuplicationIndex([hostile])).toThrow(DuplicationIndexError);
    expect(trap).not.toHaveBeenCalled();

    const accessorEntries = [entry("statement-01", "valid normalized statement")];
    Object.defineProperty(accessorEntries, 0, { get: trap });
    expect(() => buildDuplicationIndex(accessorEntries)).toThrow(DuplicationIndexError);
    expect(trap).not.toHaveBeenCalled();

    const nodeIds = ["node-01"] as string[] & { extra?: boolean };
    nodeIds.extra = true;
    expect(() =>
      buildDuplicationIndex([{ ...entry("statement-01", "valid normalized statement"), nodeIds }]),
    ).toThrow(DuplicationIndexError);

    const negativePosition = entry("statement-01", "valid normalized statement");
    expect(() =>
      buildDuplicationIndex([
        {
          ...negativePosition,
          range: {
            ...negativePosition.range,
            start: { ...negativePosition.range.start, byteOffset: -1 },
          },
        },
      ]),
    ).toThrow(DuplicationIndexError);

    const value = entry("statement-01", "valid normalized statement");
    expect(() =>
      buildDuplicationIndex([
        {
          ...value,
          range: {
            ...value.range,
            end: { byteOffset: 0, line: 0, utf16Column: 0, utf16Offset: 0 },
            start: { byteOffset: 1, line: 1, utf16Column: 0, utf16Offset: 1 },
          },
        },
      ]),
    ).toThrow(DuplicationIndexError);
  });

  test.each([
    [
      "maximumEntries",
      [
        entry("statement-01", "first valid statement"),
        entry("statement-02", "second valid statement"),
      ],
    ],
    [
      "maximumNodeIdsPerEntry",
      [{ ...entry("statement-01", "valid normalized statement"), nodeIds: ["node-01", "node-02"] }],
    ],
    ["maximumNormalizedTextLength", [entry("statement-01", "ab")]],
    ["maximumTotalNormalizedTextLength", [entry("statement-01", "ab")]],
    ["maximumShinglesPerEntry", [entry("statement-01", "long unique normalized statement")]],
    ["maximumTotalShingleOccurrences", [entry("statement-01", "long unique normalized statement")]],
    [
      "maximumCandidateComparisons",
      [
        entry("statement-01", "always run tests before merging alpha"),
        entry("statement-02", "always run tests before merging beta"),
        entry("statement-03", "always run tests before merging gamma"),
      ],
    ],
    [
      "maximumClusterMembers",
      [
        entry("statement-01", "always run tests before merging"),
        entry("statement-02", "always run tests before merging"),
      ],
    ],
  ] as const)("enforces %s", (limitName, entries) => {
    expect(() => buildDuplicationIndex(entries, options({ [limitName]: 1 }))).toThrow(
      expect.objectContaining({ code: DuplicationIndexErrorCode.limitExceeded, limitName }),
    );
  });

  test("rejects malformed options", () => {
    expect(() => buildDuplicationIndex([], new Date())).toThrow(
      expect.objectContaining({ code: DuplicationIndexErrorCode.invalidOptions }),
    );
    expect(() => buildDuplicationIndex([], { maximumEntries: 0 })).toThrow(
      expect.objectContaining({
        code: DuplicationIndexErrorCode.invalidOptions,
        limitName: "maximumEntries",
      }),
    );
    expect(() => buildDuplicationIndex([], { unknown: 1 })).toThrow(
      expect.objectContaining({ code: DuplicationIndexErrorCode.invalidOptions }),
    );
    expect(
      buildDuplicationIndex([], Object.create(null) as DuplicationIndexOptions).limits,
    ).toEqual(DUPLICATION_INDEX_DEFAULT_LIMITS);
  });

  test("bounds expanded members of near-only clusters", () => {
    expect(() =>
      buildDuplicationIndex(
        [
          entry("statement-01", "always run pnpm tests before merging"),
          entry("statement-02", "always run pnpm tests before merge"),
        ],
        options({ maximumClusterMembers: 1 }),
      ),
    ).toThrow(
      expect.objectContaining({
        code: DuplicationIndexErrorCode.limitExceeded,
        limitName: "maximumClusterMembers",
      }),
    );
  });
});
