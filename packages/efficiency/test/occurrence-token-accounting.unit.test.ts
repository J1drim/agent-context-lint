import { canonicalizeRepositoryRelativePath } from "@agent-context/core";
import { sampleTargets, type DocumentImportDag } from "@agent-context/resolver";
import { describe, expect, test, vi } from "vitest";

import {
  BUILTIN_ESTIMATE_IDENTITY,
  OccurrenceTokenAccountingError,
  OccurrenceTokenAccountingErrorCode,
  accountOccurrenceTokens,
  aggregateProfileTargetDistribution,
  combineOccurrenceTokenAccountings,
  isIssuedOccurrenceTokenAccounting,
} from "../src/index.js";
import type {
  DocumentTokenMeasurement,
  OccurrenceTokenAccounting,
  OccurrenceTokenDecision,
  TokenCount,
  TokenizerIdentity,
} from "../src/index.js";

const TRACE_SHA256 = "a".repeat(64);
const ROOT_CONTENT_ID = `content:${"1".repeat(64)}`;
const SHARED_CONTENT_ID = `content:${"2".repeat(64)}`;
const C_CONTENT_ID = `content:${"3".repeat(64)}`;

function count(
  tokens: number,
  bytes: number,
  identity: TokenizerIdentity = BUILTIN_ESTIMATE_IDENTITY,
): TokenCount {
  return {
    contractVersion: "1.0.0",
    identity,
    inputCodeUnits: bytes,
    inputUtf8Bytes: bytes,
    tokens,
  };
}

function dag(graphState: "complete" | "partial" = "complete"): DocumentImportDag {
  return {
    recordKind: "agent-context-document-import-dag",
    contractVersion: "0.1.0",
    contents: [
      {
        byteLength: 40,
        documentIds: ["document:root"],
        id: ROOT_CONTENT_ID,
        sha256: "1".repeat(64),
      },
      {
        byteLength: 16,
        documentIds: ["document:a", "document:b"],
        id: SHARED_CONTENT_ID,
        sha256: "2".repeat(64),
      },
      { byteLength: 24, documentIds: ["document:c"], id: C_CONTENT_ID, sha256: "3".repeat(64) },
    ],
    documents: [
      {
        byteLength: 40,
        contentId: ROOT_CONTENT_ID,
        depth: 0,
        documentId: "document:root",
        path: "AGENTS.md",
        sourceId: "source:root",
        state: "loaded",
      },
      {
        byteLength: 16,
        contentId: SHARED_CONTENT_ID,
        depth: 1,
        documentId: "document:a",
        path: "a.md",
        sourceId: "source:a",
        state: "loaded",
      },
      {
        byteLength: 16,
        contentId: SHARED_CONTENT_ID,
        depth: 1,
        documentId: "document:b",
        path: "b.md",
        sourceId: "source:b",
        state: "loaded",
      },
      {
        byteLength: 24,
        contentId: C_CONTENT_ID,
        depth: 1,
        documentId: "document:c",
        path: "c.md",
        sourceId: "source:c",
        state: "loaded",
      },
    ],
    entryDocumentId: "document:root",
    entryPath: "AGENTS.md",
    graphState,
    issues:
      graphState === "partial"
        ? [
            {
              code: "IMPORT_GRAPH_READ_FAILED",
              importId: null,
              path: "AGENTS.md",
              range: null,
              targetPath: "missing.md",
            },
          ]
        : [],
    occurrences: [
      {
        contentId: ROOT_CONTENT_ID,
        depth: 0,
        fromDocumentId: null,
        id: "occurrence:entry",
        importId: null,
        issueCode: null,
        ordinal: 0,
        range: null,
        state: "entry",
        targetDocumentId: "document:root",
        targetPath: "AGENTS.md",
      },
      {
        contentId: SHARED_CONTENT_ID,
        depth: 1,
        fromDocumentId: "document:root",
        id: "occurrence:a",
        importId: "import:a",
        issueCode: null,
        ordinal: 1,
        range: null,
        state: "loaded",
        targetDocumentId: "document:a",
        targetPath: "a.md",
      },
      {
        contentId: SHARED_CONTENT_ID,
        depth: 1,
        fromDocumentId: "document:root",
        id: "occurrence:b",
        importId: "import:b",
        issueCode: null,
        ordinal: 2,
        range: null,
        state: "loaded",
        targetDocumentId: "document:b",
        targetPath: "b.md",
      },
      {
        contentId: SHARED_CONTENT_ID,
        depth: 1,
        fromDocumentId: "document:root",
        id: "occurrence:a-again",
        importId: "import:a-again",
        issueCode: null,
        ordinal: 3,
        range: null,
        state: "already-loaded",
        targetDocumentId: "document:a",
        targetPath: "a.md",
      },
      {
        contentId: null,
        depth: 1,
        fromDocumentId: "document:root",
        id: "occurrence:missing",
        importId: "import:missing",
        issueCode: "IMPORT_GRAPH_READ_FAILED",
        ordinal: 4,
        range: null,
        state: "unavailable",
        targetDocumentId: null,
        targetPath: "missing.md",
      },
    ],
    traceEventIds: ["event:one"],
    traceSha256: TRACE_SHA256,
  } as unknown as DocumentImportDag;
}

function measurements(
  identity: TokenizerIdentity = BUILTIN_ESTIMATE_IDENTITY,
): DocumentTokenMeasurement[] {
  return [
    { documentId: "document:root", count: count(10, 40, identity) },
    { documentId: "document:a", count: count(4, 16, identity) },
    { documentId: "document:b", count: count(4, 16, identity) },
    { documentId: "document:c", count: count(6, 24, identity) },
  ];
}

function decisions(): OccurrenceTokenDecision[] {
  return [
    {
      activation: "always",
      count: count(10, 40),
      disposition: "included",
      occurrenceId: "occurrence:entry",
      sourceBytesConsumed: 40,
    },
    {
      activation: "conditional",
      count: count(4, 16),
      disposition: "included",
      occurrenceId: "occurrence:a",
      sourceBytesConsumed: 16,
    },
    {
      activation: "conditional",
      count: count(2, 8),
      disposition: "included",
      occurrenceId: "occurrence:b",
      sourceBytesConsumed: 8,
    },
    {
      activation: "conditional",
      count: count(4, 16),
      disposition: "included",
      occurrenceId: "occurrence:a-again",
      sourceBytesConsumed: 16,
    },
    {
      activation: null,
      count: null,
      disposition: "excluded",
      occurrenceId: "occurrence:missing",
      sourceBytesConsumed: null,
    },
  ];
}

function decisionAt(values: OccurrenceTokenDecision[], index: number): OccurrenceTokenDecision {
  const value = values[index];
  if (value === undefined) throw new Error("test decision fixture is incomplete");
  return value;
}

function measurementAt(
  values: DocumentTokenMeasurement[],
  index: number,
): DocumentTokenMeasurement {
  const value = values[index];
  if (value === undefined) throw new Error("test measurement fixture is incomplete");
  return value;
}

function issuedAccounting(
  root: string,
  options: {
    readonly identity?: TokenizerIdentity;
    readonly partial?: boolean;
    readonly traceSha256?: string;
  } = {},
): OccurrenceTokenAccounting {
  const identity = options.identity ?? BUILTIN_ESTIMATE_IDENTITY;
  const inputDag = structuredClone(dag(options.partial === true ? "partial" : "complete"));
  const rootDocumentId = `document:${root}`;
  const rootSourceId = `source:${root}`;
  const rootPath = `${root}/AGENTS.md`;
  const rootContentId = `content:${root === "root-a" ? "4" : "5"}` + "0".repeat(63);
  Object.assign(inputDag as object, {
    entryDocumentId: rootDocumentId,
    entryPath: rootPath,
    traceSha256: options.traceSha256 ?? TRACE_SHA256,
  });
  Object.assign(inputDag.documents[0] as object, {
    contentId: rootContentId,
    documentId: rootDocumentId,
    path: rootPath,
    sourceId: rootSourceId,
  });
  Object.assign(inputDag.contents[0] as object, {
    documentIds: [rootDocumentId],
    id: rootContentId,
    sha256: rootContentId.slice("content:".length),
  });
  for (const occurrence of inputDag.occurrences) {
    (occurrence as { id: string }).id = `${occurrence.id}:${root}`;
    if (occurrence.fromDocumentId === "document:root")
      (occurrence as { fromDocumentId: string }).fromDocumentId = rootDocumentId;
  }
  Object.assign(inputDag.occurrences[0] as object, {
    contentId: rootContentId,
    targetDocumentId: rootDocumentId,
    targetPath: rootPath,
  });
  if (options.partial !== true)
    (inputDag.occurrences as unknown as DocumentImportDag["occurrences"][number][]).splice(4, 1);
  const inputMeasurements = measurements(identity).map((entry) =>
    entry.documentId === "document:root" ? { ...entry, documentId: rootDocumentId } : entry,
  );
  const inputDecisions = decisions().map((entry) => ({
    ...entry,
    count: entry.count === null ? null : { ...entry.count, identity },
    occurrenceId: `${entry.occurrenceId}:${root}`,
  }));
  if (options.partial !== true) inputDecisions.splice(4, 1);
  if (options.partial === true)
    inputDecisions[4] = {
      ...decisionAt(inputDecisions, 4),
      activation: null,
      count: null,
      disposition: "unknown",
      sourceBytesConsumed: null,
    };
  return accountOccurrenceTokens({
    dag: inputDag,
    documentMeasurements: inputMeasurements,
    identity,
    occurrenceDecisions: inputDecisions,
  });
}

describe("G03 occurrence-aware token accounting", () => {
  test("reconciles hand-calculated repeated imports, unique content, activation, and truncation", () => {
    const result = accountOccurrenceTokens({
      dag: dag(),
      documentMeasurements: measurements(),
      identity: BUILTIN_ESTIMATE_IDENTITY,
      occurrenceDecisions: decisions(),
    });

    expect(result.totals).toEqual({ raw: 24, imported: 10, unique: 14, always: 10, effective: 20 });
    expect(
      result.documents.map((item) => item.rawTokens).reduce((sum, value) => sum + value, 0),
    ).toBe(result.totals.raw);
    expect(
      result.occurrences
        .filter((item) => item.state !== "entry")
        .reduce((sum, item) => sum + (item.consumedTokens ?? 0), 0),
    ).toBe(result.totals.imported);
    expect(
      result.occurrences
        .filter((item) => item.activation === "always")
        .reduce((sum, item) => sum + (item.consumedTokens ?? 0), 0),
    ).toBe(result.totals.always);
    expect(result.occurrences.reduce((sum, item) => sum + (item.consumedTokens ?? 0), 0)).toBe(
      result.totals.effective,
    );
    expect(result.occurrences[2]).toMatchObject({
      availableTokens: 4,
      consumedTokens: 2,
      sourceBytesAvailable: 16,
      sourceBytesConsumed: 8,
      truncated: true,
    });
    expect(result.occurrences[3]).toMatchObject({
      state: "already-loaded",
      consumedTokens: 4,
      truncated: false,
    });
    expect(result.contents).toEqual([
      { contentId: ROOT_CONTENT_ID, documentIds: ["document:root"], tokens: 10 },
      { contentId: SHARED_CONTENT_ID, documentIds: ["document:a", "document:b"], tokens: 4 },
      { contentId: C_CONTENT_ID, documentIds: ["document:c"], tokens: 6 },
    ]);
    expect(result.state).toBe("complete");
    expect(result.traceSha256).toBe(TRACE_SHA256);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.occurrences)).toBe(true);
    expect(Object.isFrozen(result.totals)).toBe(true);
  });

  test("does not invent repeated-import loading semantics", () => {
    const inputDecisions = decisions();
    inputDecisions[3] = {
      activation: null,
      count: null,
      disposition: "excluded",
      occurrenceId: "occurrence:a-again",
      sourceBytesConsumed: null,
    };
    const result = accountOccurrenceTokens({
      dag: dag(),
      documentMeasurements: measurements(),
      identity: BUILTIN_ESTIMATE_IDENTITY,
      occurrenceDecisions: inputDecisions,
    });
    expect(result.totals).toEqual({ raw: 24, imported: 6, unique: 14, always: 10, effective: 16 });
    expect(result.occurrences[3]).toMatchObject({ disposition: "excluded", consumedTokens: null });
  });

  test("preserves graph and occurrence uncertainty as partial evidence", () => {
    const inputDecisions = decisions();
    inputDecisions[4] = {
      activation: null,
      count: null,
      disposition: "unknown",
      occurrenceId: "occurrence:missing",
      sourceBytesConsumed: null,
    };
    const result = accountOccurrenceTokens({
      dag: dag("partial"),
      documentMeasurements: measurements(),
      identity: BUILTIN_ESTIMATE_IDENTITY,
      occurrenceDecisions: inputDecisions,
    });
    expect(result.state).toBe("partial");
    expect(result.issues).toEqual([
      { code: "graph-partial", occurrenceId: null, path: "$dag" },
      { code: "unknown-occurrence", occurrenceId: "occurrence:missing", path: "missing.md" },
    ]);
    expect(result.totals).toEqual({ raw: 24, imported: 10, unique: 14, always: 10, effective: 20 });
  });

  test("rejects incompatible tokenizers and inconsistent full-content counts", () => {
    const exact: TokenizerIdentity = { id: "exact", measurement: "exact", version: "1" };
    expect(() =>
      accountOccurrenceTokens({
        dag: dag(),
        documentMeasurements: measurements(),
        identity: exact,
        occurrenceDecisions: decisions(),
      }),
    ).toThrow(
      expect.objectContaining({ code: OccurrenceTokenAccountingErrorCode.incompatibleTokenizer }),
    );

    const conflicting = measurements();
    conflicting[2] = { documentId: "document:b", count: count(5, 16) };
    expect(() =>
      accountOccurrenceTokens({
        dag: dag(),
        documentMeasurements: conflicting,
        identity: BUILTIN_ESTIMATE_IDENTITY,
        occurrenceDecisions: decisions(),
      }),
    ).toThrow(
      expect.objectContaining({ code: OccurrenceTokenAccountingErrorCode.invalidRelationship }),
    );
  });

  test("rejects missing/duplicate decisions and invalid truncation relationships", () => {
    expect(() =>
      accountOccurrenceTokens({
        dag: dag(),
        documentMeasurements: measurements(),
        identity: BUILTIN_ESTIMATE_IDENTITY,
        occurrenceDecisions: decisions().slice(1),
      }),
    ).toThrow(OccurrenceTokenAccountingError);
    expect(() =>
      accountOccurrenceTokens({
        dag: dag(),
        documentMeasurements: measurements(),
        identity: BUILTIN_ESTIMATE_IDENTITY,
        occurrenceDecisions: [...decisions(), decisionAt(decisions(), 0)],
      }),
    ).toThrow(OccurrenceTokenAccountingError);

    const overrun = decisions();
    overrun[1] = { ...decisionAt(overrun, 1), sourceBytesConsumed: 17 };
    expect(() =>
      accountOccurrenceTokens({
        dag: dag(),
        documentMeasurements: measurements(),
        identity: BUILTIN_ESTIMATE_IDENTITY,
        occurrenceDecisions: overrun,
      }),
    ).toThrow(
      expect.objectContaining({ code: OccurrenceTokenAccountingErrorCode.invalidRelationship }),
    );
    const forgedFull = decisions();
    forgedFull[1] = { ...decisionAt(forgedFull, 1), count: count(3, 12) };
    expect(() =>
      accountOccurrenceTokens({
        dag: dag(),
        documentMeasurements: measurements(),
        identity: BUILTIN_ESTIMATE_IDENTITY,
        occurrenceDecisions: forgedFull,
      }),
    ).toThrow(
      expect.objectContaining({ code: OccurrenceTokenAccountingErrorCode.invalidRelationship }),
    );
    const oversizedMeasuredPrefix = decisions();
    oversizedMeasuredPrefix[2] = {
      ...decisionAt(oversizedMeasuredPrefix, 2),
      count: count(5, 20),
    };
    expect(() =>
      accountOccurrenceTokens({
        dag: dag(),
        documentMeasurements: measurements(),
        identity: BUILTIN_ESTIMATE_IDENTITY,
        occurrenceDecisions: oversizedMeasuredPrefix,
      }),
    ).toThrow(
      expect.objectContaining({ code: OccurrenceTokenAccountingErrorCode.invalidRelationship }),
    );
  });

  test("revalidates DAG content, occurrence, and entry relationships", () => {
    const cases: ((candidate: DocumentImportDag) => void)[] = [
      (candidate): void => {
        (candidate.documents[1] as { path: string }).path = "AGENTS.md";
      },
      (candidate): void => {
        (candidate.contents[1] as { id: string }).id = `content:${"9".repeat(64)}`;
      },
      (candidate): void => {
        (candidate.contents[1]?.documentIds as unknown as string[]).push("document:c");
      },
      (candidate): void => {
        (candidate.occurrences[1] as { ordinal: number }).ordinal = 7;
      },
      (candidate): void => {
        (candidate.occurrences[1] as { state: string }).state = "unavailable";
      },
      (candidate): void => {
        (candidate as { entryDocumentId: string }).entryDocumentId = "document:a";
      },
      (candidate): void => {
        (candidate.occurrences[2] as { targetPath: string }).targetPath = "../escape.md";
      },
    ];
    for (const change of cases) {
      const candidate = structuredClone(dag());
      change(candidate);
      expect(() =>
        accountOccurrenceTokens({
          dag: candidate,
          documentMeasurements: measurements(),
          identity: BUILTIN_ESTIMATE_IDENTITY,
          occurrenceDecisions: decisions(),
        }),
      ).toThrow(OccurrenceTokenAccountingError);
    }
  });

  test("fails closed across malformed DAG scalar and cardinality boundaries", () => {
    const cases: ((candidate: DocumentImportDag) => void)[] = [
      (candidate): void => {
        (candidate as { recordKind: string }).recordKind = "forged";
      },
      (candidate): void => {
        (candidate as { entryPath: string }).entryPath = "../escape.md";
      },
      (candidate): void => {
        (candidate as { graphState: string }).graphState = "unknown";
      },
      (candidate): void => {
        (candidate as { traceSha256: string }).traceSha256 = "Z".repeat(64);
      },
      (candidate): void => {
        (candidate.documents[1] as { state: string }).state = "unknown";
      },
      (candidate): void => {
        (candidate.documents[2] as { documentId: string }).documentId = "document:a";
      },
      (candidate): void => {
        (candidate.contents[1] as { sha256: string }).sha256 = "z".repeat(64);
      },
      (candidate): void => {
        (candidate.contents[1] as unknown as { documentIds: string[] }).documentIds = [];
      },
      (candidate): void => {
        (candidate.contents[1] as { id: string; sha256: string }).id = ROOT_CONTENT_ID;
        (candidate.contents[1] as { id: string; sha256: string }).sha256 = "1".repeat(64);
      },
      (candidate): void => {
        (candidate.occurrences[4] as { contentId: string }).contentId = SHARED_CONTENT_ID;
      },
      (candidate): void => {
        (candidate.occurrences[2] as { id: string }).id = "occurrence:a";
      },
      (candidate): void => {
        (candidate as { entryDocumentId: null }).entryDocumentId = null;
      },
    ];
    for (const change of cases) {
      const candidate = structuredClone(dag());
      change(candidate);
      expect(() =>
        accountOccurrenceTokens({
          dag: candidate,
          documentMeasurements: measurements(),
          identity: BUILTIN_ESTIMATE_IDENTITY,
          occurrenceDecisions: decisions(),
        }),
      ).toThrow(OccurrenceTokenAccountingError);
    }
  });

  test("fails closed across malformed measurements and decisions", () => {
    const duplicateMeasurements = measurements();
    duplicateMeasurements[1] = measurementAt(duplicateMeasurements, 0);
    const badContract = structuredClone(measurements());
    (badContract[0]?.count as { contractVersion: string }).contractVersion = "9.0.0";
    const excessiveInput = structuredClone(measurements());
    (excessiveInput[0]?.count as { inputUtf8Bytes: number }).inputUtf8Bytes = 16_777_217;
    const badDisposition = decisions();
    (badDisposition[0] as { disposition: string }).disposition = "maybe";
    const badActivation = decisions();
    (badActivation[0] as { activation: string }).activation = "sometimes";
    const incompleteIncluded = decisions();
    incompleteIncluded[0] = { ...decisionAt(incompleteIncluded, 0), count: null };
    const contributingExcluded = decisions();
    contributingExcluded[4] = {
      activation: "always",
      count: count(1, 1),
      disposition: "excluded",
      occurrenceId: "occurrence:missing",
      sourceBytesConsumed: 1,
    };
    const targetlessIncluded = decisions();
    targetlessIncluded[4] = {
      activation: "conditional",
      count: count(1, 1),
      disposition: "included",
      occurrenceId: "occurrence:missing",
      sourceBytesConsumed: 1,
    };

    const inputs = [
      { documentMeasurements: duplicateMeasurements, occurrenceDecisions: decisions() },
      { documentMeasurements: measurements().slice(1), occurrenceDecisions: decisions() },
      { documentMeasurements: badContract, occurrenceDecisions: decisions() },
      { documentMeasurements: excessiveInput, occurrenceDecisions: decisions() },
      { documentMeasurements: measurements(), occurrenceDecisions: badDisposition },
      { documentMeasurements: measurements(), occurrenceDecisions: badActivation },
      { documentMeasurements: measurements(), occurrenceDecisions: incompleteIncluded },
      { documentMeasurements: measurements(), occurrenceDecisions: contributingExcluded },
      { documentMeasurements: measurements(), occurrenceDecisions: targetlessIncluded },
    ];
    for (const input of inputs) {
      expect(() =>
        accountOccurrenceTokens({
          dag: dag(),
          documentMeasurements: input.documentMeasurements,
          identity: BUILTIN_ESTIMATE_IDENTITY,
          occurrenceDecisions: input.occurrenceDecisions,
        }),
      ).toThrow(OccurrenceTokenAccountingError);
    }
    expect(() =>
      accountOccurrenceTokens({
        dag: dag(),
        documentMeasurements: measurements(),
        identity: { id: "bad id", measurement: "estimate", version: "1" },
        occurrenceDecisions: decisions(),
      }),
    ).toThrow(
      expect.objectContaining({ code: OccurrenceTokenAccountingErrorCode.incompatibleTokenizer }),
    );
  });

  test("reports parse-failed sources and guards arithmetic overflow", () => {
    const parseFailed = structuredClone(dag("partial"));
    (parseFailed.documents[3] as { state: string }).state = "parse-failed";
    const result = accountOccurrenceTokens({
      dag: parseFailed,
      documentMeasurements: measurements(),
      identity: BUILTIN_ESTIMATE_IDENTITY,
      occurrenceDecisions: decisions(),
    });
    expect(result.issues).toContainEqual({
      code: "parse-failed-document",
      occurrenceId: null,
      path: "c.md",
    });

    const huge = measurements();
    huge[0] = { documentId: "document:root", count: count(Number.MAX_SAFE_INTEGER, 40) };
    expect(() =>
      accountOccurrenceTokens({
        dag: dag(),
        documentMeasurements: huge,
        identity: BUILTIN_ESTIMATE_IDENTITY,
        occurrenceDecisions: decisions(),
      }),
    ).toThrow(expect.objectContaining({ code: OccurrenceTokenAccountingErrorCode.resourceLimit }));
  });

  test("accepts a cycle alias only through an explicit decision", () => {
    const candidate = structuredClone(dag("partial"));
    (candidate.occurrences[3] as { state: string; targetPath: string }).state = "cycle";
    (candidate.occurrences[3] as { state: string; targetPath: string }).targetPath = "alias/a.md";
    const result = accountOccurrenceTokens({
      dag: candidate,
      documentMeasurements: measurements(),
      identity: BUILTIN_ESTIMATE_IDENTITY,
      occurrenceDecisions: decisions(),
    });
    expect(result.occurrences[3]).toMatchObject({
      disposition: "included",
      state: "cycle",
      targetPath: "alias/a.md",
    });
  });

  test("returns a bounded zero accounting result for an entry read failure", () => {
    const empty = structuredClone(dag("partial"));
    (empty as { entryDocumentId: null }).entryDocumentId = null;
    (empty as unknown as { contents: unknown[] }).contents = [];
    (empty as unknown as { documents: unknown[] }).documents = [];
    (empty as unknown as { occurrences: unknown[] }).occurrences = [];
    const result = accountOccurrenceTokens({
      dag: empty,
      documentMeasurements: [],
      identity: BUILTIN_ESTIMATE_IDENTITY,
      occurrenceDecisions: [],
    });
    expect(result.totals).toEqual({ raw: 0, imported: 0, unique: 0, always: 0, effective: 0 });
    expect(result.state).toBe("partial");
  });

  test("rejects accessors, proxies, sparse arrays, and extended arrays without executing them", () => {
    let reads = 0;
    const accessor = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessor, "dag", {
      enumerable: true,
      get: () => {
        reads += 1;
        throw new Error("unsafe");
      },
    });
    Object.assign(accessor, {
      documentMeasurements: measurements(),
      identity: BUILTIN_ESTIMATE_IDENTITY,
      occurrenceDecisions: decisions(),
    });
    expect(() => accountOccurrenceTokens(accessor as never)).toThrow(
      OccurrenceTokenAccountingError,
    );
    expect(reads).toBe(0);
    expect(() =>
      accountOccurrenceTokens(
        new Proxy(
          {
            dag: dag(),
            documentMeasurements: measurements(),
            identity: BUILTIN_ESTIMATE_IDENTITY,
            occurrenceDecisions: decisions(),
          },
          {},
        ) as never,
      ),
    ).toThrow(OccurrenceTokenAccountingError);

    const sparse = decisions();
    sparse.length = 65_538;
    expect(() =>
      accountOccurrenceTokens({
        dag: dag(),
        documentMeasurements: measurements(),
        identity: BUILTIN_ESTIMATE_IDENTITY,
        occurrenceDecisions: sparse,
      }),
    ).toThrow(expect.objectContaining({ code: OccurrenceTokenAccountingErrorCode.resourceLimit }));
    const extended = decisions() as OccurrenceTokenDecision[] & { extra?: boolean };
    extended.extra = true;
    expect(() =>
      accountOccurrenceTokens({
        dag: dag(),
        documentMeasurements: measurements(),
        identity: BUILTIN_ESTIMATE_IDENTITY,
        occurrenceDecisions: extended,
      }),
    ).toThrow(expect.objectContaining({ code: OccurrenceTokenAccountingErrorCode.invalidInput }));
  });

  test("is byte-identical and immutable across repeated runs", () => {
    const input = {
      dag: dag(),
      documentMeasurements: measurements(),
      identity: BUILTIN_ESTIMATE_IDENTITY,
      occurrenceDecisions: decisions(),
    };
    const expected = JSON.stringify(accountOccurrenceTokens(input));
    for (let index = 0; index < 50; index += 1)
      expect(JSON.stringify(accountOccurrenceTokens(input))).toBe(expected);
  });
});

describe("G03 multi-entry profile target composition", () => {
  test("deduplicates shared evidence, preserves repeated consumption, and is order independent", () => {
    const first = issuedAccounting("root-a");
    const second = issuedAccounting("root-b");
    const combined = combineOccurrenceTokenAccountings({ accountings: [first, second] });
    const reversed = combineOccurrenceTokenAccountings({ accountings: [second, first] });

    expect(combined).toEqual(reversed);
    expect(combined.totals).toEqual({
      always: 20,
      effective: 40,
      imported: 20,
      raw: 34,
      unique: 24,
    });
    expect(combined.documents).toHaveLength(5);
    expect(
      combined.contents.find((entry) => entry.contentId === SHARED_CONTENT_ID)?.documentIds,
    ).toEqual(["document:a", "document:b"]);
    expect(combined.occurrences).toHaveLength(8);
    expect(new Set(combined.occurrences.map((entry) => entry.occurrenceId)).size).toBe(8);
    expect(combined.occurrences.map((entry) => entry.ordinal)).toEqual(
      Array.from({ length: 8 }, (_, index) => index),
    );
    expect(isIssuedOccurrenceTokenAccounting(first)).toBe(true);
    expect(isIssuedOccurrenceTokenAccounting(combined)).toBe(true);
    expect(Object.isFrozen(combined)).toBe(true);
  });

  test("preserves partial state and remaps issue occurrence provenance", () => {
    const partial = issuedAccounting("root-b", { partial: true });
    const combined = combineOccurrenceTokenAccountings({
      accountings: [issuedAccounting("root-a"), partial],
    });
    expect(combined.state).toBe("partial");
    expect(combined.issues.map((entry) => entry.code)).toEqual([
      "graph-partial",
      "unknown-occurrence",
    ]);
    expect(
      combined.issues.find((entry) => entry.code === "unknown-occurrence")?.occurrenceId,
    ).toMatch(/^occurrence:combined:/u);
  });

  test("rejects forged, duplicated-root, incompatible, mismatched-trace, and hostile input", () => {
    const first = issuedAccounting("root-a");
    const second = issuedAccounting("root-b");
    expect(() =>
      combineOccurrenceTokenAccountings({ accountings: [structuredClone(first)] }),
    ).toThrow(expect.objectContaining({ code: OccurrenceTokenAccountingErrorCode.invalidInput }));
    expect(() => combineOccurrenceTokenAccountings({ accountings: [first, first] })).toThrow(
      expect.objectContaining({ code: OccurrenceTokenAccountingErrorCode.invalidRelationship }),
    );
    expect(() =>
      combineOccurrenceTokenAccountings({
        accountings: [
          first,
          issuedAccounting("root-b", {
            identity: { id: "exact", measurement: "exact", version: "1" },
          }),
        ],
      }),
    ).toThrow(
      expect.objectContaining({ code: OccurrenceTokenAccountingErrorCode.incompatibleTokenizer }),
    );
    expect(() =>
      combineOccurrenceTokenAccountings({
        accountings: [first, issuedAccounting("root-b", { traceSha256: "b".repeat(64) })],
      }),
    ).toThrow(
      expect.objectContaining({ code: OccurrenceTokenAccountingErrorCode.invalidRelationship }),
    );
    expect(() =>
      combineOccurrenceTokenAccountings(new Proxy({ accountings: [second] }, {})),
    ).toThrow(OccurrenceTokenAccountingError);
    const sparse = new Array<OccurrenceTokenAccounting>(2);
    sparse[1] = second;
    expect(() => combineOccurrenceTokenAccountings({ accountings: sparse })).toThrow(
      OccurrenceTokenAccountingError,
    );
    expect(() =>
      combineOccurrenceTokenAccountings({ accountings: Array(4_097).fill(first) }),
    ).toThrow(expect.objectContaining({ code: OccurrenceTokenAccountingErrorCode.resourceLimit }));
    const amplified = Array.from({ length: 1_025 }, (_, index) =>
      issuedAccounting(`root-${index.toString(36)}`),
    );
    expect(() => combineOccurrenceTokenAccountings({ accountings: amplified })).toThrow(
      expect.objectContaining({ code: OccurrenceTokenAccountingErrorCode.resourceLimit }),
    );
    const getter = vi.fn();
    const accessor = {} as Record<string, unknown>;
    Object.defineProperty(accessor, "accountings", { enumerable: true, get: getter });
    expect(() => combineOccurrenceTokenAccountings(accessor as never)).toThrow(
      OccurrenceTokenAccountingError,
    );
    expect(getter).not.toHaveBeenCalled();
  });

  test("is accepted by G04 as exactly one accounting for one sampled target", () => {
    const target = canonicalizeRepositoryRelativePath("src/main.ts");
    const sampling = sampleTargets({
      activationObservations: [{ path: target, states: [] }],
      criticalPaths: [],
      paths: [target],
      trackingCertainty: "tracked",
      trackingReason: "verified-git-index",
      workspaceBoundaries: [],
      workspaceUncertainty: "known",
      workspaceUncertaintyReasons: [],
    });
    const combined = combineOccurrenceTokenAccountings({
      accountings: [issuedAccounting("root-a"), issuedAccounting("root-b")],
    });
    expect(
      aggregateProfileTargetDistribution({
        accountings: [{ accounting: combined, path: target }],
        identity: BUILTIN_ESTIMATE_IDENTITY,
        profile: {
          clientVersion: "1",
          profileId: "fixture",
          profileVersion: "1",
          specSnapshotId: "fixture",
          surfaceId: "fixture",
        },
        sampling,
      }),
    ).toMatchObject({ sampleCount: 1, state: "complete" });
  });
});
