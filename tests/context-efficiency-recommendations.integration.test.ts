import { readFile } from "node:fs/promises";

import type { AnySchema } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import {
  BUILTIN_ESTIMATE_IDENTITY,
  CONTEXT_EFFICIENCY_METRICS_CONTRACT_VERSION,
  CONTEXT_EFFICIENCY_METRICS_INPUT_RECORD_KIND,
  CONTEXT_EFFICIENCY_RECOMMENDATIONS_CONTRACT_VERSION,
  CONTEXT_EFFICIENCY_RECOMMENDATIONS_INPUT_RECORD_KIND,
  analyzeContextEfficiencyMetrics,
  calculateContextEfficiencyScore,
  compareContextEfficiencyReports,
  createContextEfficiencyReport,
  projectContextEfficiencyRecommendations,
  serializeContextEfficiencyJson,
} from "../packages/efficiency/dist/index.js";
import { sampleTargets } from "../packages/resolver/dist/index.js";
import { describe, expect, test } from "vitest";

const PACKAGE_JSON = new URL("../packages/efficiency/package.json", import.meta.url);
const SCHEMA = new URL(
  "../packages/efficiency/schemas/context-efficiency-recommendations.v1.schema.json",
  import.meta.url,
);
const REPORT_SCHEMA = new URL(
  "../packages/efficiency/schemas/context-efficiency-report.v1.schema.json",
  import.meta.url,
);
const COMPARISON_SCHEMA = new URL(
  "../packages/efficiency/schemas/context-efficiency-comparison.v1.schema.json",
  import.meta.url,
);
const SCORE_SCHEMA = new URL(
  "../packages/efficiency/schemas/context-efficiency-score.v1.schema.json",
  import.meta.url,
);
const SPECIFICATION_SCHEMA = new URL(
  "../packages/efficiency/schemas/efficiency-score-specification.v1.schema.json",
  import.meta.url,
);
const TOKENIZER_SCHEMA = new URL(
  "../packages/efficiency/schemas/tokenizer-identity.v1.schema.json",
  import.meta.url,
);

describe("G08 built recommendation package", () => {
  test("exports the schema and projects a schema-valid empty analysis through dist", async () => {
    const sampling = sampleTargets({
      activationObservations: [],
      criticalPaths: [],
      paths: [],
      trackingCertainty: "tracked",
      trackingReason: "verified-git-index",
      workspaceBoundaries: [],
      workspaceUncertainty: "known",
      workspaceUncertaintyReasons: [],
    });
    const metrics = analyzeContextEfficiencyMetrics({
      comparisons: [],
      contractVersion: CONTEXT_EFFICIENCY_METRICS_CONTRACT_VERSION,
      documents: [],
      identity: BUILTIN_ESTIMATE_IDENTITY,
      profiles: [
        {
          accountings: [],
          profile: {
            clientVersion: null,
            profileId: "codex-cli",
            profileVersion: "0.1.0",
            specSnapshotId: "codex-cli/integration-test",
            surfaceId: "codex-cli/integration-test",
          },
          sampling,
        },
      ],
      recordKind: CONTEXT_EFFICIENCY_METRICS_INPUT_RECORD_KIND,
      statements: [],
    });
    const score = calculateContextEfficiencyScore(metrics);
    const result = await projectContextEfficiencyRecommendations({
      contractVersion: CONTEXT_EFFICIENCY_RECOMMENDATIONS_CONTRACT_VERSION,
      metrics,
      recordKind: CONTEXT_EFFICIENCY_RECOMMENDATIONS_INPUT_RECORD_KIND,
      scenarios: [],
      score,
    });

    const schema = JSON.parse(await readFile(SCHEMA, "utf8")) as AnySchema;
    const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
    expect(validate(JSON.parse(JSON.stringify(result)))).toBe(true);
    expect(result).toMatchObject({
      evaluations: [],
      qualityClaim: false,
      recommendations: [],
      semanticQualityPreservationClaim: false,
      sourceScoreConfidence: "unavailable",
      state: "complete",
    });

    const packageJson = JSON.parse(await readFile(PACKAGE_JSON, "utf8")) as {
      readonly exports: Readonly<Record<string, unknown>>;
      readonly files: readonly string[];
    };
    expect(packageJson.files).toContain("schemas");
    expect(packageJson.exports["./schemas/context-efficiency-recommendations.v1.schema.json"]).toBe(
      "./schemas/context-efficiency-recommendations.v1.schema.json",
    );
  });

  test("builds and validates unavailable reports and comparisons through public dist exports", async () => {
    const sampling = sampleTargets({
      activationObservations: [],
      criticalPaths: [],
      paths: [],
      trackingCertainty: "tracked",
      trackingReason: "verified-git-index",
      workspaceBoundaries: [],
      workspaceUncertainty: "known",
      workspaceUncertaintyReasons: [],
    });
    const metrics = analyzeContextEfficiencyMetrics({
      comparisons: [],
      contractVersion: CONTEXT_EFFICIENCY_METRICS_CONTRACT_VERSION,
      documents: [],
      identity: BUILTIN_ESTIMATE_IDENTITY,
      profiles: [
        {
          accountings: [],
          profile: {
            clientVersion: null,
            profileId: "codex-cli",
            profileVersion: "0.1.0",
            specSnapshotId: "codex-cli/integration-test",
            surfaceId: "codex-cli/integration-test",
          },
          sampling,
        },
      ],
      recordKind: CONTEXT_EFFICIENCY_METRICS_INPUT_RECORD_KIND,
      statements: [],
    });
    const score = calculateContextEfficiencyScore(metrics);
    const recommendations = await projectContextEfficiencyRecommendations({
      contractVersion: CONTEXT_EFFICIENCY_RECOMMENDATIONS_CONTRACT_VERSION,
      metrics,
      recordKind: CONTEXT_EFFICIENCY_RECOMMENDATIONS_INPUT_RECORD_KIND,
      scenarios: [],
      score,
    });
    const report = createContextEfficiencyReport({
      metrics,
      recommendations,
      scope: { kind: "repository", targetPath: null },
      score,
    });
    const comparison = compareContextEfficiencyReports({ baseline: report, candidate: report });
    expect(report.score.score).toBeNull();
    expect(comparison.score).toEqual({ baseline: null, candidate: null, delta: null });

    const ajv = new Ajv2020({ allErrors: true, strict: true });
    for (const schemaUrl of [TOKENIZER_SCHEMA, SPECIFICATION_SCHEMA, SCORE_SCHEMA, SCHEMA])
      ajv.addSchema(JSON.parse(await readFile(schemaUrl, "utf8")) as AnySchema);
    const validateReport = ajv.compile(
      JSON.parse(await readFile(REPORT_SCHEMA, "utf8")) as AnySchema,
    );
    const validateComparison = ajv.compile(
      JSON.parse(await readFile(COMPARISON_SCHEMA, "utf8")) as AnySchema,
    );
    expect(validateReport(JSON.parse(serializeContextEfficiencyJson(report)))).toBe(true);
    expect(validateComparison(JSON.parse(serializeContextEfficiencyJson(comparison)))).toBe(true);
  });

  test("publishes report code and both closed schemas in the efficiency package contract", async () => {
    const packageJson = JSON.parse(await readFile(PACKAGE_JSON, "utf8")) as {
      readonly exports: Readonly<Record<string, unknown>>;
    };
    expect(packageJson.exports["./report"]).toEqual({
      default: "./dist/context-efficiency-report.js",
      import: "./dist/context-efficiency-report.js",
      types: "./dist/context-efficiency-report.d.ts",
    });
    expect(packageJson.exports["./schemas/context-efficiency-report.v1.schema.json"]).toBe(
      "./schemas/context-efficiency-report.v1.schema.json",
    );
    expect(packageJson.exports["./schemas/context-efficiency-comparison.v1.schema.json"]).toBe(
      "./schemas/context-efficiency-comparison.v1.schema.json",
    );
  });
});
