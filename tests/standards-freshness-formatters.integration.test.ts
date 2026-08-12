import { readFileSync } from "node:fs";

import { beforeAll, describe, expect, test } from "vitest";

import { validateInstructionIr } from "../packages/core/dist/index.js";
import {
  formatJsonDiagnostics,
  formatSarifDiagnostics,
  formatStylishDiagnostics,
} from "../packages/formatters/src/index.js";
import { evaluateStandardsFreshnessRules } from "../packages/rules/dist/index.js";
import {
  loadBundledKnowledgePack,
  serializeStandardsLockfile,
} from "../packages/standards/dist/index.js";

import type { DiagnosticBundle, InstructionIr } from "../packages/core/dist/index.js";
import type {
  LoadedBundledKnowledgePack,
  StandardsUpdatePlan,
} from "../packages/standards/dist/index.js";
import type {
  DeprecatedSyntaxObservation,
  StandardsFreshnessRuleInput,
  VerifiedLiveStandardsObservation,
} from "../packages/rules/dist/index.js";

const IR_FIXTURE = new URL(
  "../packages/core/test/fixtures/instruction-ir.valid.json",
  import.meta.url,
);
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
let bundled: LoadedBundledKnowledgePack;
let ir: InstructionIr;

beforeAll(async () => {
  const loaded = await loadBundledKnowledgePack({ channel: "stable", engineVersion: "0.0.0" });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues));
  bundled = loaded.value;
  const validated = validateInstructionIr(JSON.parse(readFileSync(IR_FIXTURE, "utf8")));
  if (!validated.ok) throw new Error(JSON.stringify(validated.issues));
  ir = validated.value;
});

function preview(): VerifiedLiveStandardsObservation {
  const value: StandardsUpdatePlan = {
    candidateLockSha256: HASH_C,
    checkedAt: "2026-09-01T11:00:00Z",
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
      role: "standards-preview",
      threshold: 2,
    },
  };
  return { channel: "preview", origin: "verified-live-h09", result: { ok: true, value } };
}

function olderUnauthenticatedLock(): string {
  const candidate = {
    channel: bundled.pack.channel,
    pack: {
      packId: bundled.pack.packId,
      packVersion: "2026.7.0",
      publishedAt: bundled.pack.publishedAt,
      schemaVersion: bundled.pack.schemaVersion,
    },
    recordKind: "agent-context-standards-lock",
    schemaVersion: "1.0.0",
    target: { ...structuredClone(bundled.provenance.target), packVersion: "2026.7.0" },
    trustedState: structuredClone(bundled.provenance.trustedState),
    verificationTime: bundled.provenance.verificationTime,
  };
  const serialized = serializeStandardsLockfile(candidate);
  if (!serialized.ok) throw new Error(JSON.stringify(serialized.issues));
  return serialized.text;
}

function deprecation(): DeprecatedSyntaxObservation {
  const source = ir.sources[0];
  if (source === undefined) throw new Error("fixture source missing");
  const root = ir.nodes.find((node) => node.id === source.rootNodeId);
  if (root === undefined) throw new Error("fixture root missing");
  return {
    deprecatedSince: "2026-01-01",
    evidence: {
      evidenceRefId: "fixture:formatter-deprecation",
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
    range: root.range,
    replacementId: "current-syntax",
    sourceId: source.id,
    specSnapshotId: "profile:fixture/2026-08-02",
    subjectId: "legacy-syntax",
    surfaceId: "profile:fixture/cli",
  };
}

function input(environment: "ci" | "local", lockfile: string | null): StandardsFreshnessRuleInput {
  const source = ir.sources[0];
  if (source === undefined) throw new Error("fixture source missing");
  return {
    anchorSourceId: source.id,
    contractVersion: "0.1.0",
    deprecatedSyntax: lockfile === null ? [] : [deprecation()],
    environment,
    ir,
    liveUpdates: lockfile === null ? [] : [preview()],
    previewEnabled: false,
    recordKind: "agent-context-standards-freshness-rule-input",
    statusRequest: {
      asOf: "2026-09-02T12:00:00Z",
      bundled,
      cachedLatest:
        lockfile === null
          ? null
          : {
              channel: "stable",
              checkedAt: "2026-09-01T12:00:00Z",
              minEngineVersion: "99.0.0",
              origin: "untrusted-offline-cache",
              packVersion: "2026.9.0",
              sha256: HASH_B,
            },
      engineVersion: "0.0.0",
      lockfile,
      maxAgeDays: 1,
    },
  };
}

describe("F13 formatter integration", () => {
  test("renders every freshness rule through stylish, native JSON, and SARIF", () => {
    const broad = evaluateStandardsFreshnessRules(input("local", olderUnauthenticatedLock()));
    const ci = evaluateStandardsFreshnessRules(input("ci", null));
    expect(broad.ok).toBe(true);
    expect(ci.ok).toBe(true);
    if (!broad.ok || !ci.ok) throw new Error("fixture evaluation failed");
    const all = [...broad.bundle.diagnostics, ...ci.bundle.diagnostics];
    expect(new Set(all.map((entry) => entry.ruleId))).toEqual(
      new Set(["ACL500", "ACL501", "ACL502", "ACL503", "ACL504", "ACL505", "ACL506"]),
    );
    const profileVersions = {
      "profile:fixture": { clientVersion: null, profileVersion: "1.0.0" },
    };
    for (const diagnostic of all) {
      const bundle: DiagnosticBundle = Object.freeze({
        ...broad.bundle,
        diagnostics: Object.freeze([diagnostic]),
        suppressions: Object.freeze([]),
      });
      const stylish = formatStylishDiagnostics(bundle, broad.sources, { color: "never" });
      const json = formatJsonDiagnostics(bundle, broad.sources, {
        failureThreshold: "never",
        profileVersions,
      });
      const sarif = formatSarifDiagnostics(bundle, broad.sources, {
        informationUri: "https://agent-context-lint.dev/",
        profileVersions,
        ruleDocumentationBaseUri: "https://agent-context-lint.dev/",
        toolVersion: "0.0.0",
      });
      expect(stylish.ok).toBe(true);
      expect(json.ok).toBe(true);
      expect(sarif.ok).toBe(true);
      if (stylish.ok) expect(stylish.text).toContain(diagnostic.ruleId);
      if (json.ok) expect(json.text).toContain(diagnostic.ruleId);
      if (sarif.ok) expect(sarif.text).toContain(diagnostic.ruleId);
    }
  });
});
