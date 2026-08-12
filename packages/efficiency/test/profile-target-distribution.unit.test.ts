import { canonicalizeRepositoryRelativePath } from "@agent-context/core";
import type { RepositoryRelativePath } from "@agent-context/core";
import { sampleTargets } from "@agent-context/resolver";
import type { DocumentImportDag, TargetSamplingResult } from "@agent-context/resolver";
import { describe, expect, test } from "vitest";

import {
  BUILTIN_ESTIMATE_IDENTITY,
  PROFILE_TARGET_DISTRIBUTION_MAX_TARGETS,
  ProfileTargetDistributionError,
  ProfileTargetDistributionErrorCode,
  accountOccurrenceTokens,
  aggregateProfileTargetDistribution,
} from "../src/index.js";
import type {
  OccurrenceTokenAccounting,
  ProfileTargetAccounting,
  ProfileTargetIdentity,
  TokenCount,
  TokenizerIdentity,
} from "../src/index.js";

interface MutableDistributionInput {
  accountings: ProfileTargetAccounting[];
  identity: TokenizerIdentity;
  profile: ProfileTargetIdentity;
  sampling: TargetSamplingResult;
}

function path(value: string): RepositoryRelativePath {
  return canonicalizeRepositoryRelativePath(value);
}

function count(tokens: number, identity: TokenizerIdentity): TokenCount {
  const bytes = tokens * 4;
  return {
    contractVersion: "1.0.0",
    identity,
    inputCodeUnits: bytes,
    inputUtf8Bytes: bytes,
    tokens,
  };
}

function accounting(
  tokens: number,
  index: number,
  state: "complete" | "partial" = "complete",
  identity: TokenizerIdentity = BUILTIN_ESTIMATE_IDENTITY,
): OccurrenceTokenAccounting {
  const digit = (index % 15) + 1;
  const sha256 = digit.toString(16).repeat(64);
  const documentId = `document:item-${String(index)}`;
  const occurrenceId = `occurrence:item-${String(index)}`;
  const instructionPath = path(`instructions/item-${String(index)}.md`);
  const bytes = tokens * 4;
  const dag = {
    recordKind: "agent-context-document-import-dag",
    contractVersion: "0.1.0",
    contents: [
      {
        byteLength: bytes,
        documentIds: [documentId],
        id: `content:${sha256}`,
        sha256,
      },
    ],
    documents: [
      {
        byteLength: bytes,
        contentId: `content:${sha256}`,
        depth: 0,
        documentId,
        path: instructionPath,
        sourceId: `source:item-${String(index)}`,
        state: "loaded",
      },
    ],
    entryDocumentId: documentId,
    entryPath: instructionPath,
    graphState: state,
    issues:
      state === "partial"
        ? [
            {
              code: "IMPORT_GRAPH_READ_FAILED",
              importId: null,
              path: instructionPath,
              range: null,
              targetPath: path(`instructions/missing-${String(index)}.md`),
            },
          ]
        : [],
    occurrences: [
      {
        contentId: `content:${sha256}`,
        depth: 0,
        fromDocumentId: null,
        id: occurrenceId,
        importId: null,
        issueCode: null,
        ordinal: 0,
        range: null,
        state: "entry",
        targetDocumentId: documentId,
        targetPath: instructionPath,
      },
    ],
    traceEventIds: [`event:item-${String(index)}`],
    traceSha256: sha256,
  } as unknown as DocumentImportDag;
  return accountOccurrenceTokens({
    dag,
    documentMeasurements: [{ count: count(tokens, identity), documentId }],
    identity,
    occurrenceDecisions: [
      {
        activation: "always",
        count: count(tokens, identity),
        disposition: "included",
        occurrenceId,
        sourceBytesConsumed: bytes,
      },
    ],
  });
}

function sampling(
  values: readonly RepositoryRelativePath[],
  partial = false,
): TargetSamplingResult {
  return sampleTargets({
    activationObservations: values.map((target) => ({ path: target, states: [] })),
    criticalPaths: [],
    paths: [...values],
    trackingCertainty: partial ? "all-files-not-tracked" : "tracked",
    trackingReason: partial ? "git-index-missing" : "verified-git-index",
    workspaceBoundaries: [],
    workspaceUncertainty: "known",
    workspaceUncertaintyReasons: [],
  });
}

function input(tokens: readonly number[]): MutableDistributionInput {
  const paths = tokens.map((_, index) =>
    path(`src/target-${index.toString().padStart(2, "0")}.ts`),
  );
  return {
    accountings: paths.map((target, index) => ({
      accounting: accounting(tokens[index] ?? 0, index),
      path: target,
    })),
    identity: BUILTIN_ESTIMATE_IDENTITY,
    profile: {
      clientVersion: "1.2.3",
      profileId: "client:fixture",
      profileVersion: "2026.08.02",
      specSnapshotId: "snapshot:fixture",
      surfaceId: "surface:fixture",
    },
    sampling: sampling(paths),
  };
}

describe("G04 profile target distributions", () => {
  test("computes exact nearest-rank min, p50, p95, and max over complete target accountings", () => {
    const value = input(Array.from({ length: 20 }, (_, index) => index + 1));
    value.accountings.reverse();

    const result = aggregateProfileTargetDistribution(value);

    expect(result.statistics).toEqual({ maximum: 20, minimum: 1, p50: 10, p95: 19 });
    expect(result.percentileMethod).toBe("empirical-nearest-rank-v1");
    expect(result.sampleCount).toBe(20);
    expect(result.completeSampleCount).toBe(20);
    expect(result.targets.map((target) => target.alwaysOnTokens)).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 1),
    );
    expect(result.targets.map((target) => target.path)).toEqual(
      [...result.targets.map((target) => target.path)].sort(),
    );
    expect(result.state).toBe("complete");
    expect(result.issues).toEqual([]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.targets)).toBe(true);
    expect(Object.isFrozen(result.statistics)).toBe(true);
  });

  test("defines singleton and empty-repository behavior without inventing values", () => {
    const singleton = aggregateProfileTargetDistribution(input([37]));
    expect(singleton.statistics).toEqual({ maximum: 37, minimum: 37, p50: 37, p95: 37 });

    const empty = input([]);
    const result = aggregateProfileTargetDistribution(empty);
    expect(result).toMatchObject({
      completeSampleCount: 0,
      issues: [],
      sampleCount: 0,
      state: "empty",
      statistics: null,
      targets: [],
    });
  });

  test("excludes partial accounting lower bounds from statistics and preserves explicit issues", () => {
    const value = input([2, 100, 6]);
    const partialEntry = value.accountings[1];
    if (partialEntry === undefined) throw new Error("partial accounting fixture is incomplete");
    value.accountings[1] = {
      accounting: accounting(100, 1, "partial"),
      path: partialEntry.path,
    };
    value.sampling = sampling(
      value.accountings.map((entry) => entry.path),
      true,
    );

    const result = aggregateProfileTargetDistribution(value);

    expect(result.state).toBe("partial");
    expect(result.statistics).toEqual({ maximum: 6, minimum: 2, p50: 2, p95: 6 });
    expect(result.completeSampleCount).toBe(2);
    expect(result.targets[1]).toMatchObject({
      effectiveTokens: 100,
      includedInStatistics: false,
      state: "partial",
    });
    expect(result.issues).toEqual([
      { code: "sampling-partial", path: null },
      { code: "accounting-partial", path: "src/target-01.ts" },
    ]);
  });

  test("returns no statistics when every non-empty target is partial", () => {
    const value = input([10]);
    value.accountings[0] = {
      accounting: accounting(10, 0, "partial"),
      path: path("src/target-00.ts"),
    };
    const result = aggregateProfileTargetDistribution(value);
    expect(result.statistics).toBeNull();
    expect(result.issues).toEqual([
      { code: "accounting-partial", path: "src/target-00.ts" },
      { code: "no-complete-targets", path: null },
    ]);
  });

  test("requires one accounting for every selected path and rejects duplicates or substitutions", () => {
    const missing = input([1, 2]);
    missing.accountings.pop();
    expect(() => aggregateProfileTargetDistribution(missing)).toThrow(
      expect.objectContaining({ code: ProfileTargetDistributionErrorCode.invalidRelationship }),
    );

    const substituted = input([1, 2]);
    substituted.accountings[1] = {
      accounting: accounting(2, 1),
      path: path("src/other.ts"),
    };
    expect(() => aggregateProfileTargetDistribution(substituted)).toThrow(
      ProfileTargetDistributionError,
    );
  });

  test("rejects incompatible tokenizer identities and malformed G03 summaries", () => {
    const exact: TokenizerIdentity = { id: "fixture:exact", measurement: "exact", version: "1" };
    const incompatible = input([1]);
    incompatible.accountings[0] = {
      accounting: accounting(1, 0, "complete", exact),
      path: path("src/target-00.ts"),
    };
    expect(() => aggregateProfileTargetDistribution(incompatible)).toThrow(
      expect.objectContaining({ code: ProfileTargetDistributionErrorCode.incompatibleTokenizer }),
    );

    const malformed = structuredClone(input([1]));
    (malformed.accountings[0]?.accounting.totals as { effective: number }).effective = -1;
    expect(() => aggregateProfileTargetDistribution(malformed)).toThrow(
      ProfileTargetDistributionError,
    );
  });

  test("rejects malformed profiles, sampling order, sparse arrays, proxies, and accessors", () => {
    const profile = input([1]);
    (profile.profile as { profileId: string }).profileId = "bad profile";
    expect(() => aggregateProfileTargetDistribution(profile)).toThrow(
      ProfileTargetDistributionError,
    );

    const unordered = structuredClone(input([1, 2]));
    (unordered.sampling.selected as unknown as unknown[]).reverse();
    expect(() => aggregateProfileTargetDistribution(unordered)).toThrow(
      expect.objectContaining({ code: ProfileTargetDistributionErrorCode.invalidRelationship }),
    );

    const sparse = input([]);
    sparse.accountings = new Array<ProfileTargetAccounting>(
      PROFILE_TARGET_DISTRIBUTION_MAX_TARGETS + 1,
    );
    expect(() => aggregateProfileTargetDistribution(sparse)).toThrow(
      expect.objectContaining({ code: ProfileTargetDistributionErrorCode.resourceLimit }),
    );

    expect(() => aggregateProfileTargetDistribution(new Proxy(input([1]), {}))).toThrow(
      ProfileTargetDistributionError,
    );
    const unsafe = input([1]);
    let reads = 0;
    Object.defineProperty(unsafe.accountings, "0", {
      enumerable: true,
      get(): never {
        reads += 1;
        throw new Error("unsafe");
      },
    });
    expect(() => aggregateProfileTargetDistribution(unsafe)).toThrow(
      ProfileTargetDistributionError,
    );
    expect(reads).toBe(0);
  });

  test("revalidates upstream sampling and every G03 contribution before aggregation", () => {
    const cases: ((candidate: MutableDistributionInput) => void)[] = [
      (candidate): void => {
        (candidate.sampling as { recordKind: string }).recordKind = "forged";
      },
      (candidate): void => {
        (candidate.sampling as { contractVersion: string }).contractVersion = "9.0.0";
      },
      (candidate): void => {
        (candidate.sampling as { state: string }).state = "unknown";
      },
      (candidate): void => {
        (candidate.sampling as { strategy: string }).strategy = "random";
      },
      (candidate): void => {
        (candidate.identity as { id: string }).id = "bad identity";
      },
      (candidate): void => {
        (candidate.profile as { clientVersion: string | null }).clientVersion =
          "unsafe\u0000version";
      },
      (candidate): void => {
        (candidate as unknown as { accountings: unknown }).accountings = {};
      },
      (candidate): void => {
        (candidate.accountings as ProfileTargetAccounting[] & { extra?: boolean }).extra = true;
      },
      (candidate): void => {
        (candidate.accountings[0]?.accounting as { recordKind: string }).recordKind = "forged";
      },
      (candidate): void => {
        (candidate.accountings[0]?.accounting as { contractVersion: string }).contractVersion =
          "9.0.0";
      },
      (candidate): void => {
        (candidate.accountings[0]?.accounting as { state: string }).state = "unknown";
      },
      (candidate): void => {
        (candidate.accountings[0]?.accounting as { traceSha256: string }).traceSha256 = "z";
      },
      (candidate): void => {
        (candidate.accountings[0]?.accounting.identity as { id: string }).id = "bad identity";
      },
      (candidate): void => {
        const totals = candidate.accountings[0]?.accounting.totals as {
          effective: number;
          imported: number;
        };
        totals.imported = totals.effective + 1;
      },
      (candidate): void => {
        (candidate.accountings[0]?.accounting.totals as { raw: number }).raw += 1;
      },
      (candidate): void => {
        (candidate.accountings[0]?.accounting.documents[0] as { rawTokens: number }).rawTokens += 1;
      },
      (candidate): void => {
        const documents = candidate.accountings[0]?.accounting.documents as unknown as unknown[];
        documents.push(documents[0]);
      },
      (candidate): void => {
        const documents = candidate.accountings[0]?.accounting.documents as unknown as Record<
          string,
          unknown
        >[];
        documents.push({
          ...documents[0],
          contentId: `content:${"e".repeat(64)}`,
          documentId: "document:overflow",
          rawTokens: Number.MAX_SAFE_INTEGER,
        });
      },
      (candidate): void => {
        (candidate.accountings[0]?.accounting.documents[0] as { path: string }).path = "../escape";
      },
      (candidate): void => {
        const content = candidate.accountings[0]?.accounting.contents[0];
        (content as unknown as { documentIds: string[] }).documentIds = [];
      },
      (candidate): void => {
        (candidate.accountings[0]?.accounting.contents[0] as { tokens: number }).tokens += 1;
      },
      (candidate): void => {
        const contents = candidate.accountings[0]?.accounting.contents as unknown as unknown[];
        contents.push(contents[0]);
      },
      (candidate): void => {
        (candidate.accountings[0]?.accounting as unknown as { contents: unknown[] }).contents = [];
      },
      (candidate): void => {
        (candidate.accountings[0]?.accounting.occurrences[0] as { ordinal: number }).ordinal = 2;
      },
      (candidate): void => {
        (candidate.accountings[0]?.accounting.occurrences[0] as { state: string }).state = "other";
      },
      (candidate): void => {
        (
          candidate.accountings[0]?.accounting.occurrences[0] as { disposition: string }
        ).disposition = "maybe";
      },
      (candidate): void => {
        (candidate.accountings[0]?.accounting.occurrences[0] as { activation: string }).activation =
          "sometimes";
      },
      (candidate): void => {
        (
          candidate.accountings[0]?.accounting.occurrences[0] as { availableTokens: number }
        ).availableTokens += 1;
      },
      (candidate): void => {
        (candidate.accountings[0]?.accounting.occurrences[0] as { targetPath: string }).targetPath =
          "instructions/other.md";
      },
      (candidate): void => {
        (candidate.accountings[0]?.accounting.occurrences[0] as { truncated: unknown }).truncated =
          "maybe";
      },
      (candidate): void => {
        (
          candidate.accountings[0]?.accounting.occurrences[0] as { consumedTokens: number }
        ).consumedTokens += 1;
      },
      (candidate): void => {
        const occurrence = candidate.accountings[0]?.accounting.occurrences[0] as {
          consumedTokens: number;
          disposition: string;
        };
        occurrence.disposition = "excluded";
        occurrence.consumedTokens = 0;
      },
      (candidate): void => {
        (candidate.accountings[0]?.accounting as { state: string }).state = "partial";
      },
    ];
    for (const change of cases) {
      const candidate = structuredClone(input([1]));
      change(candidate);
      expect(() => aggregateProfileTargetDistribution(candidate)).toThrow(
        ProfileTargetDistributionError,
      );
    }

    const malformedIssue = input([1]);
    malformedIssue.accountings[0] = {
      accounting: structuredClone(accounting(1, 0, "partial")),
      path: path("src/target-00.ts"),
    };
    (malformedIssue.accountings[0].accounting.issues[0] as { code: string }).code = "unknown";
    expect(() => aggregateProfileTargetDistribution(malformedIssue)).toThrow(
      ProfileTargetDistributionError,
    );
  });

  test("accepts null client versions, excluded targets, and imported contributions", () => {
    const excluded = structuredClone(input([1]));
    (excluded.profile as { clientVersion: string | null }).clientVersion = null;
    const excludedAccounting = excluded.accountings[0]?.accounting;
    if (excludedAccounting === undefined) throw new Error("excluded fixture is incomplete");
    const excludedOccurrence = excludedAccounting.occurrences[0] as unknown as Record<
      string,
      unknown
    >;
    Object.assign(excludedOccurrence, {
      activation: null,
      consumedTokens: null,
      disposition: "excluded",
      sourceBytesConsumed: null,
      truncated: null,
    });
    Object.assign(excludedAccounting.totals as unknown as Record<string, number>, {
      always: 0,
      effective: 0,
      imported: 0,
      raw: 1,
      unique: 0,
    });
    expect(aggregateProfileTargetDistribution(excluded).statistics).toEqual({
      maximum: 0,
      minimum: 0,
      p50: 0,
      p95: 0,
    });

    const imported = structuredClone(input([1]));
    (imported.profile as { clientVersion: string | null }).clientVersion = "Version 1.2 (build 3)";
    const importedAccounting = imported.accountings[0]?.accounting;
    if (importedAccounting === undefined) throw new Error("import fixture is incomplete");
    const repeated = {
      ...structuredClone(importedAccounting.occurrences[0]),
      activation: "conditional",
      occurrenceId: "occurrence:imported",
      ordinal: 1,
      state: "loaded",
    };
    (importedAccounting.occurrences as unknown as unknown[]).push(repeated);
    Object.assign(importedAccounting.totals as unknown as Record<string, number>, {
      always: 1,
      effective: 2,
      imported: 1,
      raw: 1,
      unique: 1,
    });
    expect(aggregateProfileTargetDistribution(imported).statistics).toEqual({
      maximum: 2,
      minimum: 2,
      p50: 2,
      p95: 2,
    });

    const unresolved = input([1]);
    unresolved.accountings[0] = {
      accounting: structuredClone(accounting(1, 0, "partial")),
      path: path("src/target-00.ts"),
    };
    const unresolvedAccounting = unresolved.accountings[0].accounting;
    (unresolvedAccounting.occurrences as unknown as unknown[]).push({
      activation: null,
      availableTokens: null,
      consumedTokens: null,
      disposition: "unknown",
      occurrenceId: "occurrence:unknown",
      ordinal: 1,
      sourceBytesAvailable: null,
      sourceBytesConsumed: null,
      state: "unavailable",
      targetDocumentId: null,
      targetPath: null,
      truncated: null,
    });
    (unresolvedAccounting.issues as unknown as unknown[]).push({
      code: "unknown-occurrence",
      occurrenceId: "occurrence:unknown",
      path: "$unresolved",
    });
    expect(aggregateProfileTargetDistribution(unresolved).state).toBe("partial");
  });

  test("is byte-identical across repeated aggregation", () => {
    const value = input([7, 2, 11, 3]);
    const expected = JSON.stringify(aggregateProfileTargetDistribution(value));
    for (let index = 0; index < 100; index += 1) {
      expect(JSON.stringify(aggregateProfileTargetDistribution(value))).toBe(expected);
    }
  });
});
