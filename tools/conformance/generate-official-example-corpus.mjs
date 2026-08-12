#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { format } from "prettier";

export const OFFICIAL_CORPUS_CONTRACT_VERSION = "0.1.0";
export const OFFICIAL_CORPUS_REVIEW_DATE = "2026-08-02";
export const OFFICIAL_CORPUS_NEXT_REVIEW = "2026-09-02";

const FIXTURE_DIRECTORY = "conformance/official-examples/v0/fixtures";
const MANIFEST_PATH = "conformance/official-examples/v0/corpus.json";
const SUMMARY_PATH = "conformance/official-examples/v0/summary.golden.json";
const INVENTORY_PATH = "conformance/contracts/profile-surface-map.v0.json";
const OBSERVATION_REVIEW_PATH = "conformance/observations/v0/d16/review.json";
const COVERAGE_TAGS = Object.freeze([
  "activation",
  "ambiguity",
  "glob-edge-case",
  "import-behavior",
  "nested-discovery",
  "supported-location",
  "unsupported-field",
]);

const FORMAT_EXAMPLES = Object.freeze({
  "agents-markdown": {
    content: "# Project instructions\n\nUse the repository test command.\n@docs/policy.md\n",
    negativePath: "invalid/AGENT.md",
    path: "AGENTS.md",
  },
  "claude-memory-markdown": {
    content: "# Project memory\n\nUse the repository test command.\n@docs/policy.md\n",
    negativePath: "invalid/CLAUDES.md",
    path: "CLAUDE.md",
  },
  "claude-rule-markdown": {
    content:
      "---\npaths:\n  - src/**/*.ts\nunsupportedExampleField: inert\n---\nUse the TypeScript policy.\n@docs/policy.md\n",
    negativePath: "invalid/example.claude-rule.md",
    path: ".claude/rules/example.md",
  },
  "copilot-path-instructions": {
    content:
      "---\napplyTo: src/**/*.ts\nunsupportedExampleField: inert\n---\nUse the TypeScript policy.\n[Policy](../../docs/policy.md)\n",
    negativePath: "invalid/example.instruction.md",
    path: ".github/instructions/example.instructions.md",
  },
  "copilot-repository-markdown": {
    content:
      "# Repository instructions\n\nUse the repository test command.\n[Policy](../docs/policy.md)\n",
    negativePath: "invalid/copilot.md",
    path: ".github/copilot-instructions.md",
  },
  "cursor-legacy-rules": {
    content: "Use the repository test command.\n@docs/policy.md\n",
    negativePath: "invalid/cursorrules.txt",
    path: ".cursorrules",
  },
  "cursor-mdc": {
    content:
      "---\ndescription: TypeScript guidance\nglobs: src/**/*.ts\nalwaysApply: false\nunsupportedExampleField: inert\n---\nUse the TypeScript policy.\n@docs/policy.md\n",
    negativePath: "invalid/example.mdc",
    path: ".cursor/rules/example.mdc",
  },
  "gemini-context-markdown": {
    content:
      "# Project context\n\nUse the repository test command.\n@docs/policy.md\n`@ignored/in-code.md`\n",
    negativePath: "invalid/GEMINIS.md",
    path: "GEMINI.md",
  },
});

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function capabilityId(surfaceId, formatId) {
  return `${surfaceId.replaceAll("/", ".")}--${formatId}`;
}

function surfaceSlug(surfaceId) {
  return surfaceId.replaceAll("/", "-");
}

function assertionId(formatId, polarity) {
  return `assert-${formatId}-${polarity}`;
}

function selectedEvidenceStatus(support) {
  if (support.supportStatus !== "supported") return support.supportStatus;
  for (const status of ["contradiction", "model-selected", "conditional", "unknown"]) {
    if (support.evidenceStatus.includes(status)) return status;
  }
  if (support.evidenceStatus.includes("source-derived")) return "source-derived";
  if (support.evidenceStatus.includes("observed")) return "observed";
  return "documented";
}

function expectedState(support) {
  const status = selectedEvidenceStatus(support);
  if (["conditional", "contradiction", "model-selected", "not-listed", "unknown"].includes(status))
    return "indeterminate";
  if (status === "recognized-unsupported") return "not-selected";
  return "selected";
}

function ambiguityFor(capability, evidenceStatus) {
  if (
    !["conditional", "contradiction", "model-selected", "not-listed", "unknown"].includes(
      evidenceStatus,
    )
  )
    return undefined;
  const id = `ambiguity-${capability.formatId}`;
  return {
    alternatives: [
      {
        description: "The candidate is selected when the documented condition is satisfied.",
        id: "selected",
      },
      {
        description: "The candidate is not selected when the condition is absent or unresolved.",
        id: "not-selected",
      },
    ],
    evidenceRefs: [capability.id],
    id,
    kind: "official-source-does-not-prove-one-deterministic-outcome",
    reason:
      "The canonical profile inventory preserves this capability as conditional or unresolved.",
  };
}

function parentDirectories(paths) {
  const result = new Set(["docs/", "src/"]);
  for (const value of paths) {
    const segments = value.split("/").slice(0, -1);
    let current = "";
    for (const segment of segments) {
      current += `${segment}/`;
      result.add(current);
    }
  }
  return [...result].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
}

function fixtureSource(record) {
  const source = {
    id: `${record.id.replaceAll("/", "-")}-official-source`,
    immutability: record.upstreamRevision === null ? "retrieved-living-doc" : "immutable-revision",
    retrievedAt: OFFICIAL_CORPUS_REVIEW_DATE,
    url: record.primarySources[0],
  };
  if (record.upstreamRevision === null) source.mutableSourceReason = record.mutableSourceReason;
  else source.revision = record.upstreamRevision;
  return source;
}

function buildFixture({ polarity, profile, researchRecord, surface, supports }) {
  const id = `official-${surfaceSlug(surface.id)}-${polarity}`;
  const instructionFiles = supports.map((support) => {
    const example = FORMAT_EXAMPLES[support.formatId];
    return {
      content: example.content,
      formatId: support.formatId,
      path: polarity === "positive" ? example.path : example.negativePath,
    };
  });
  const ambiguities = [];
  const nodes = [
    {
      evidenceRefs: ["k01-target"],
      id: "target-example",
      kind: "target",
      path: "src/example.ts",
      resolutionStatus: "documented",
    },
  ];
  const edges = [];
  const assertions = [];
  for (const [index, support] of supports.entries()) {
    const capability = { ...support, id: capabilityId(surface.id, support.formatId) };
    const evidenceStatus = polarity === "positive" ? selectedEvidenceStatus(support) : "documented";
    const ambiguity =
      polarity === "positive" ? ambiguityFor(capability, evidenceStatus) : undefined;
    if (ambiguity !== undefined) ambiguities.push(ambiguity);
    const nodeId = `document-${support.formatId}`;
    nodes.push({
      ...(ambiguity === undefined ? {} : { ambiguityId: ambiguity.id }),
      evidenceRefs: [capability.id],
      formatId: support.formatId,
      id: nodeId,
      kind: "document",
      path: instructionFiles[index].path,
      resolutionStatus: evidenceStatus,
    });
    edges.push({
      ...(ambiguity === undefined ? {} : { ambiguityId: ambiguity.id }),
      evidenceRefs: [capability.id],
      from: nodeId,
      id: `edge-${support.formatId}`,
      relation:
        polarity === "positive" && expectedState(support) !== "not-selected"
          ? "selects"
          : "excludes",
      resolutionStatus: evidenceStatus,
      to: "target-example",
    });
    assertions.push({
      ...(ambiguity === undefined ? {} : { ambiguityId: ambiguity.id }),
      evidenceRefs: [capability.id],
      evidenceStatus,
      expected: {
        selection: polarity === "positive" ? expectedState(support) : "not-selected",
        supportStatus: support.supportStatus,
      },
      id: assertionId(support.formatId, polarity),
      predicate: "profile-format-capability-outcome",
    });
  }
  const files = [
    ...instructionFiles,
    { content: "Official-example target.\n", formatId: null, path: "src/example.ts" },
    { content: "Synthetic imported marker.\n", formatId: null, path: "docs/policy.md" },
  ];
  return {
    assertions,
    eventTrace: [
      { id: "event-launch", kind: "launch", path: ".", sequence: 0, targetId: "target-example" },
      {
        id: "event-reference",
        kind: "reference-path",
        path: "src/example.ts",
        sequence: 1,
        targetId: "target-example",
      },
    ],
    expectedGraph: {
      ambiguities,
      analysisStatus: ambiguities.length === 0 ? "complete" : "partial",
      edges,
      nodes,
    },
    extensions: {
      "agent-context-lint.dev/k01": {
        coverageTags: COVERAGE_TAGS,
        polarity,
      },
    },
    externalContext: { entries: [], mode: "unavailable" },
    fixtureFormatVersion: "0.1.0",
    id,
    invocation: {
      branchState: { kind: "synthetic", ref: "fixture" },
      launchCwd: ".",
      runtimeMode: surface.kind,
      settings: {},
      trustState: "trusted-synthetic",
      workspaceRoots: ["."],
    },
    profile: {
      clientVersion: surface.version,
      profileId: profile.id,
      specSnapshotId: researchRecord.id,
      surfaceId: surface.id,
      versionStatus: surface.versionStatus,
    },
    provenance: {
      assumptions: [
        "Example prose is replaced by short inert markers while retaining official locations, fields, and activation inputs.",
        "The negative fixture changes only fixture-owned location or activation inputs and does not infer undocumented client behavior.",
      ],
      derivation: "official-example",
      observationIds: [],
      researchRecordIds: [researchRecord.id],
      sources: [fixtureSource(researchRecord)],
    },
    recordKind: "profile-conformance-fixture",
    repository: {
      directories: parentDirectories(files.map((file) => file.path)),
      files,
      root: ".",
      symlinks: [],
    },
    targets: [
      { id: "target-example", path: "src/example.ts", purpose: "resolve-effective-context" },
    ],
    title: `${surface.id} official examples (${polarity})`,
  };
}

async function jsonBytes(value) {
  return Buffer.from(
    await format(`${JSON.stringify(value)}\n`, {
      endOfLine: "lf",
      parser: "json",
      printWidth: 100,
    }),
    "utf8",
  );
}

export async function buildOfficialExampleCorpus(repositoryRoot) {
  const mapBytes = readFileSync(path.join(repositoryRoot, ...INVENTORY_PATH.split("/")));
  const observationBytes = readFileSync(
    path.join(repositoryRoot, ...OBSERVATION_REVIEW_PATH.split("/")),
  );
  const map = JSON.parse(mapBytes.toString("utf8"));
  const gaProfiles = map.profiles.filter((profile) => profile.releaseClass === "ga-required");
  const researchById = new Map(map.researchRecords.map((record) => [record.id, record]));
  const surfaceById = new Map(map.surfaces.map((surface) => [surface.id, surface]));
  const outputs = new Map();
  const fixtureReferences = [];
  const fixtureIdByKey = new Map();

  for (const profile of gaProfiles) {
    for (const surfaceId of profile.surfaceIds) {
      const surface = surfaceById.get(surfaceId);
      const supports = map.formatSupport.filter((support) => support.surfaceId === surfaceId);
      const researchRecord = researchById.get(surface.researchRecords[0]);
      for (const polarity of ["negative", "positive"]) {
        const fixture = buildFixture({ polarity, profile, researchRecord, surface, supports });
        const relativePath = `${FIXTURE_DIRECTORY}/${fixture.id}.fixture.json`;
        const bytes = await jsonBytes(fixture);
        outputs.set(relativePath, bytes);
        fixtureReferences.push({
          id: fixture.id,
          path: relativePath,
          polarity,
          profileId: profile.id,
          sha256: sha256(bytes),
          surfaceId,
        });
        fixtureIdByKey.set(`${surfaceId}\0${polarity}`, fixture.id);
      }
    }
  }

  const capabilities = map.formatSupport
    .filter((support) =>
      gaProfiles.some((profile) => profile.surfaceIds.includes(support.surfaceId)),
    )
    .map((support) => {
      const surface = surfaceById.get(support.surfaceId);
      const positiveState = expectedState(support);
      return {
        coverageTags: COVERAGE_TAGS,
        evidenceStatus: support.evidenceStatus,
        formatId: support.formatId,
        id: capabilityId(support.surfaceId, support.formatId),
        negative: {
          assertionId: assertionId(support.formatId, "negative"),
          expectedState: "not-selected",
          fixtureId: fixtureIdByKey.get(`${support.surfaceId}\0negative`),
        },
        positive: {
          assertionId: assertionId(support.formatId, "positive"),
          expectedState: positiveState,
          fixtureId: fixtureIdByKey.get(`${support.surfaceId}\0positive`),
        },
        profileId: surface.profileId,
        supportStatus: support.supportStatus,
        surfaceId: support.surfaceId,
      };
    });

  const manifest = {
    capabilities,
    contractVersion: OFFICIAL_CORPUS_CONTRACT_VERSION,
    fixtures: fixtureReferences,
    inventory: { path: INVENTORY_PATH, sha256: sha256(mapBytes) },
    observationReview: { path: OBSERVATION_REVIEW_PATH, sha256: sha256(observationBytes) },
    recordKind: "official-example-conformance-corpus",
    review: {
      cadence: "monthly",
      nextReviewDue: OFFICIAL_CORPUS_NEXT_REVIEW,
      primaryOwner: "@agent-context-lint/profile-reviewers",
      procedurePath: "docs/profiles/official-example-conformance.md",
      qualityOwner: "@agent-context-lint/qa-reviewers",
      reviewedAt: OFFICIAL_CORPUS_REVIEW_DATE,
    },
  };
  outputs.set(MANIFEST_PATH, await jsonBytes(manifest));
  const countBy = (values) =>
    Object.fromEntries(
      [...new Set(values)]
        .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
        .map((value) => [value, values.filter((candidate) => candidate === value).length]),
    );
  outputs.set(
    SUMMARY_PATH,
    await jsonBytes({
      capabilityCount: capabilities.length,
      capabilityIds: capabilities.map((capability) => capability.id),
      contractVersion: OFFICIAL_CORPUS_CONTRACT_VERSION,
      fixtureCount: fixtureReferences.length,
      positiveStateCounts: countBy(
        capabilities.map((capability) => capability.positive.expectedState),
      ),
      recordKind: "official-example-conformance-summary-golden",
      supportStatusCounts: countBy(capabilities.map((capability) => capability.supportStatus)),
      surfaceCapabilityCounts: countBy(capabilities.map((capability) => capability.surfaceId)),
    }),
  );
  return outputs;
}

function isMainModule() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  const args = process.argv.slice(2);
  const check = args.length === 0 || (args.length === 1 && args[0] === "--check");
  const write =
    args.length === 2 && args[0] === "--write" && args[1] === "--acknowledge-reviewed-update";
  if (!check && !write) {
    console.error(
      "usage: generate-official-example-corpus.mjs --check | --write --acknowledge-reviewed-update",
    );
    process.exitCode = 2;
  } else {
    const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
    const outputs = await buildOfficialExampleCorpus(repositoryRoot);
    let stale = false;
    for (const [relativePath, expected] of outputs) {
      const absolute = path.join(repositoryRoot, ...relativePath.split("/"));
      if (write) {
        mkdirSync(path.dirname(absolute), { recursive: true });
        writeFileSync(absolute, expected, { flag: "w", mode: 0o644 });
      } else {
        let actual;
        try {
          actual = readFileSync(absolute);
        } catch {
          actual = undefined;
        }
        if (actual === undefined || !actual.equals(expected)) {
          console.error(`stale generated official-example artifact: ${relativePath}`);
          stale = true;
        }
      }
    }
    if (write) console.log(`wrote ${outputs.size} official-example corpus artifacts`);
    else if (!stale)
      console.log(`valid ${outputs.size} generated official-example corpus artifacts`);
    if (stale) process.exitCode = 1;
  }
}
