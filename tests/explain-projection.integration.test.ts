import { readFile } from "node:fs/promises";

import {
  canonicalizeRepositoryRelativePath,
  type RepositoryRelativePath,
} from "../packages/core/dist/index.js";
import { describe, expect, test } from "vitest";

import {
  EFFECTIVE_CONTEXT_CONTRACT_VERSION,
  EFFECTIVE_CONTEXT_INPUT_RECORD_KIND,
  EXPLAIN_PROJECTION_CONTRACT_VERSION,
  EXPLAIN_PROJECTION_INPUT_RECORD_KIND,
  createSyntheticTargetTrace,
  projectExplain,
  resolveCodexCliAgents,
  resolveEffectiveContext,
  type ExplainProjection,
} from "../packages/resolver/dist/index.js";

interface ExplainGolden {
  readonly projection: unknown;
  readonly recordKind: "explain-projection-conformance-golden";
  readonly schemaVersion: "0.1.0";
}

const GOLDEN = new URL(
  "../conformance/fixtures/v0/explain-projection.golden.json",
  import.meta.url,
);
const encoder = new TextEncoder();

function path(value: string): RepositoryRelativePath {
  return canonicalizeRepositoryRelativePath(value);
}

async function golden(): Promise<ExplainGolden> {
  return JSON.parse(await readFile(GOLDEN, "utf8")) as ExplainGolden;
}

function projectFixture(): ExplainProjection {
  const targetPath = path("app/main.ts");
  const profileResolution = resolveCodexCliAgents({
    discovery: {
      certainty: "known",
      entries: [
        { content: "Root policy.\n", path: "AGENTS.md" },
        { content: "App policy.\n", path: "app/AGENTS.md" },
      ].map((entry) => ({
        bytes: encoder.encode(entry.content),
        errorCode: null,
        kind: "file" as const,
        path: path(entry.path),
        resolvedTarget: null,
      })),
      reason: "E06 golden fixture",
      rootMarkerPaths: [path(".git")],
    },
    externalContext: { globalBase: null, globalOverride: null, mode: "supplied" },
    launchCwd: path("app"),
    settings: {
      projectDocFallbackFilenames: [],
      projectDocMaxBytes: 32_768,
      projectRootMarkers: [".git"],
    },
    targetPath,
  });
  const resolution = resolveEffectiveContext({
    contractVersion: EFFECTIVE_CONTEXT_CONTRACT_VERSION,
    importDags: [],
    profileResolution,
    recordKind: EFFECTIVE_CONTEXT_INPUT_RECORD_KIND,
    targetPath,
  });
  const trace = createSyntheticTargetTrace({
    launchCwd: path("app"),
    purpose: "explain-golden",
    targetPath,
    workspaceRoots: [path(".")],
  });
  return projectExplain({
    contractVersion: EXPLAIN_PROJECTION_CONTRACT_VERSION,
    recordKind: EXPLAIN_PROJECTION_INPUT_RECORD_KIND,
    resolutions: [resolution],
    trace,
  });
}

function stableSummary(projection: ReturnType<typeof projectFixture>): unknown {
  return {
    analysisStatus: projection.analysisStatus,
    clientVersion: projection.clientVersion,
    profileId: projection.profileId,
    profileVersion: projection.profileVersion,
    recordKind: projection.recordKind,
    specSnapshotId: projection.specSnapshotId,
    surfaceId: projection.surfaceId,
    targets: projection.targets.map((target) => ({
      accounting: target.accounting,
      analysisStatus: target.analysisStatus,
      documents: target.documents.map((document) => ({
        disposition: document.disposition,
        path: document.path,
        reasons: document.reasons.map((reason) => reason.code),
      })),
      targetPath: target.targetPath,
      traceEvents: target.traceEvents.map((event) => ({
        kind: event.kind,
        scope: event.scope,
        uncertainty: event.uncertainty,
      })),
    })),
    trace: projection.trace,
  };
}

describe("E06 explain projection conformance", () => {
  test("projects a real E05 result and E03 trace to the canonical golden", async () => {
    const expected = await golden();
    const first = projectFixture();
    const second = projectFixture();

    expect(stableSummary(first)).toEqual(expected.projection);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});
