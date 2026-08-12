import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

import { describe, expect, test } from "vitest";

import {
  EVIDENCE_STATES,
  MAX_VALIDATION_ISSUES,
  PROFILE_CATALOG_CONTRACT_VERSION,
  SUPPORT_STATES,
  UNCERTAINTY_STATES,
  VALIDATION_ISSUE_LIMIT_CODE,
  isProfileCatalog,
  validateProfileCatalog,
} from "../src/index.js";
import type { ProfileCatalog, ProfileCatalogValidationCode, SupportClaim } from "../src/index.js";

type PathSegment = number | string;

const VALID_FIXTURE = new URL("./fixtures/profile-catalog.valid.json", import.meta.url);
const INVALID_FIXTURE = new URL("./fixtures/profile-catalog.invalid.json", import.meta.url);
const D01_MAPPING = new URL(
  "../../../conformance/contracts/profile-surface-map.v0.json",
  import.meta.url,
);

function readJson(url: URL): unknown {
  return JSON.parse(readFileSync(url, "utf8")) as unknown;
}

function cloneValid(): unknown {
  return structuredClone(readJson(VALID_FIXTURE));
}

function child(container: unknown, segment: PathSegment): unknown {
  if (typeof segment === "number") {
    if (!Array.isArray(container)) throw new TypeError("expected an array while editing a fixture");
    return container[segment];
  }
  if (container === null || typeof container !== "object" || Array.isArray(container)) {
    throw new TypeError("expected an object while editing a fixture");
  }
  return (container as Record<string, unknown>)[segment];
}

function setValue(root: unknown, path: readonly PathSegment[], value: unknown): void {
  if (path.length === 0) throw new TypeError("cannot replace the fixture root");
  let parent = root;
  for (const segment of path.slice(0, -1)) parent = child(parent, segment);
  const key = path.at(-1);
  if (typeof key === "number") {
    if (!Array.isArray(parent)) throw new TypeError("expected an array parent");
    parent[key] = value;
  } else if (typeof key === "string") {
    if (parent === null || typeof parent !== "object" || Array.isArray(parent))
      throw new TypeError("expected an object parent");
    (parent as Record<string, unknown>)[key] = value;
  }
}

function deleteValue(root: unknown, path: readonly PathSegment[]): void {
  if (path.length === 0) throw new TypeError("cannot delete the fixture root");
  let parent = root;
  for (const segment of path.slice(0, -1)) parent = child(parent, segment);
  const key = path.at(-1);
  if (
    typeof key !== "string" ||
    parent === null ||
    typeof parent !== "object" ||
    Array.isArray(parent)
  ) {
    throw new TypeError("expected an object property");
  }
  if (!Reflect.deleteProperty(parent, key))
    throw new TypeError("could not delete fixture property");
}

function expectIssue(input: unknown, path: string, code?: ProfileCatalogValidationCode): void {
  const result = validateProfileCatalog(input);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected fixture to be invalid");
  expect(result.issues).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        ...(code === undefined ? {} : { code }),
        path,
      }),
    ]),
  );
}

function validatedFixture(): ProfileCatalog {
  const result = validateProfileCatalog(readJson(VALID_FIXTURE));
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.value;
}

describe("public profile contract vocabulary", () => {
  test("matches every D01 support and evidence state exactly", () => {
    const d01 = readJson(D01_MAPPING);
    if (d01 === null || typeof d01 !== "object" || Array.isArray(d01))
      throw new TypeError("invalid D01 fixture");
    const record = d01 as Record<string, unknown>;

    expect(SUPPORT_STATES).toEqual(record["supportStates"]);
    expect(EVIDENCE_STATES).toEqual(record["evidenceStates"]);
    expect(UNCERTAINTY_STATES).toEqual(["known", "conditional", "unknown", "contradiction"]);
    expect(PROFILE_CATALOG_CONTRACT_VERSION).toBe("0.1.0");
  });

  test("retains all canonical D01 format, profile, and distinct surface IDs", () => {
    const d01 = readJson(D01_MAPPING) as {
      documentFormats: { id: string }[];
      profiles: { id: string }[];
      surfaces: { id: string }[];
    };

    expect(d01.documentFormats.map(({ id }) => id)).toEqual([
      "agents-markdown",
      "claude-memory-markdown",
      "claude-rule-markdown",
      "copilot-repository-markdown",
      "copilot-path-instructions",
      "gemini-context-markdown",
      "cursor-mdc",
      "cursor-legacy-rules",
    ]);
    expect(d01.profiles.map(({ id }) => id)).toHaveLength(8);
    expect(d01.surfaces.map(({ id }) => id)).toEqual(
      expect.arrayContaining([
        "copilot-cli/local-terminal",
        "copilot-vscode/local-chat",
        "copilot-cloud-agent/github-hosted",
        "copilot-code-review/github-hosted",
        "cursor-agent/ide",
        "cursor-agent/cli",
      ]),
    );
    expect(d01.surfaces).toHaveLength(9);
  });

  test("exports JSON-safe claim types without optional uncertainty", () => {
    const claim: SupportClaim = {
      evidence: ["documented"],
      evidenceRefs: ["source"],
      support: "supported",
      uncertainty: { state: "known" },
    };

    expect(JSON.parse(JSON.stringify(claim))).toEqual(claim);
  });
});

describe("positive JSON example", () => {
  test("validates through the public entry point and narrows the type", () => {
    const fixture = readJson(VALID_FIXTURE);
    expect(isProfileCatalog(fixture)).toBe(true);
    const catalog = validatedFixture();
    expect(catalog.recordKind).toBe("agent-context-profile-catalog");
    expect(catalog.formatSupport).toHaveLength(4);
  });

  test("round-trips through JSON without losing explicit nulls or uncertainty", () => {
    const catalog = validatedFixture();
    const reparsed = JSON.parse(JSON.stringify(catalog)) as unknown;
    expect(validateProfileCatalog(reparsed)).toEqual({ ok: true, value: catalog });
  });

  test("keeps syntax separate while two profiles consume agents-markdown differently", () => {
    const catalog = validatedFixture();
    const format = catalog.documentFormats.find(({ id }) => id === "agents-markdown");
    const relationships = catalog.formatSupport.filter(
      ({ formatId }) => formatId === "agents-markdown",
    );

    expect(format).toEqual({
      id: "agents-markdown",
      syntaxFamily: "markdown-instructions",
      syntaxFeatures: ["markdown-body", "empty-content-state", "reference-token-candidates"],
    });
    expect(relationships.map(({ surfaceId }) => surfaceId)).toEqual([
      "codex-cli/local-cli-single-cwd",
      "copilot-vscode/local-chat",
    ]);
    expect(relationships.map(({ recognition }) => recognition.uncertainty.state)).toEqual([
      "known",
      "conditional",
    ]);
  });

  test("preserves an unknown support result instead of coercing it to false", () => {
    const relationship = validatedFixture().formatSupport.find(
      ({ formatId, surfaceId }) =>
        formatId === "cursor-legacy-rules" && surfaceId === "cursor-agent/cli",
    );
    expect(relationship?.recognition).toMatchObject({
      evidence: ["unknown"],
      support: "unknown",
      uncertainty: { state: "unknown" },
    });
  });

  test("preserves both alternatives in a documented contradiction", () => {
    const relationship = validatedFixture().formatSupport.find(
      ({ formatId }) => formatId === "copilot-path-instructions",
    );
    expect(relationship?.recognition.uncertainty).toMatchObject({
      state: "contradiction",
      alternatives: [{ id: "requires-apply-to" }, { id: "description-relevance" }],
    });
  });
});

describe("negative JSON example", () => {
  test("rejects vendor activation embedded in syntax", () => {
    expectIssue(readJson(INVALID_FIXTURE), "$.documentFormats[0].activation", "unknown-field");
  });

  test("rejects support declared unknown while uncertainty is known", () => {
    expectIssue(
      readJson(INVALID_FIXTURE),
      "$.formatSupport[0].recognition.uncertainty.state",
      "invalid-state",
    );
  });

  test("rejects normalized overflow dates", () => {
    expectIssue(readJson(INVALID_FIXTURE), "$.specSnapshots[0].retrievedAt", "invalid-date");
    expectIssue(
      readJson(INVALID_FIXTURE),
      "$.specSnapshots[0].sources[0].retrievedAt",
      "invalid-date",
    );
  });
});

describe("closed structural validation", () => {
  test.each([
    { path: ["recordKind"], issuePath: "$.recordKind" },
    { path: ["contractVersion"], issuePath: "$.contractVersion" },
    { path: ["documentFormats"], issuePath: "$.documentFormats" },
    { path: ["clientProfiles"], issuePath: "$.clientProfiles" },
    { path: ["surfaces"], issuePath: "$.surfaces" },
    { path: ["specSnapshots"], issuePath: "$.specSnapshots" },
    { path: ["capabilityDefinitions"], issuePath: "$.capabilityDefinitions" },
    { path: ["formatSupport"], issuePath: "$.formatSupport" },
  ])("requires top-level member $issuePath", ({ issuePath, path }) => {
    const fixture = cloneValid();
    deleteValue(fixture, path);
    expectIssue(fixture, issuePath, "missing-field");
  });

  test.each([
    { path: ["recordKind"], value: "wrong", issuePath: "$.recordKind" },
    { path: ["contractVersion"], value: "1.0.0", issuePath: "$.contractVersion" },
    { path: ["documentFormats"], value: {}, issuePath: "$.documentFormats" },
    { path: ["surfaces", 0, "capabilities"], value: {}, issuePath: "$.surfaces[0].capabilities" },
    {
      path: ["documentFormats", 0, "syntaxFeatures", 0],
      value: "",
      issuePath: "$.documentFormats[0].syntaxFeatures[0]",
    },
    {
      path: ["surfaces", 0, "capabilities", 0, "support"],
      value: "maybe",
      issuePath: "$.surfaces[0].capabilities[0].support",
    },
    {
      path: ["surfaces", 0, "capabilities", 0, "evidence", 0],
      value: "hearsay",
      issuePath: "$.surfaces[0].capabilities[0].evidence[0]",
    },
  ])("rejects malformed value at $issuePath", ({ issuePath, path, value }) => {
    const fixture = cloneValid();
    setValue(fixture, path, value);
    expectIssue(fixture, issuePath);
  });

  test("rejects unknown fields at the catalog and nested object levels", () => {
    const catalogField = cloneValid();
    setValue(catalogField, ["vendor"], "copied-activation");
    expectIssue(catalogField, "$.vendor", "unknown-field");

    const nestedField = cloneValid();
    setValue(nestedField, ["formatSupport", 0, "recognition", "confidence"], 1);
    expectIssue(nestedField, "$.formatSupport[0].recognition.confidence", "unknown-field");
  });
});

describe("strict profile JSON ingress and resource bounds", () => {
  test("rejects accessors and proxies without invoking repository-controlled code", () => {
    const accessor = cloneValid();
    let invoked = false;
    Object.defineProperty(accessor, "unsafe", {
      enumerable: true,
      get() {
        invoked = true;
        throw new Error("must not run");
      },
    });
    expect(validateProfileCatalog(accessor).ok).toBe(false);
    expect(invoked).toBe(false);

    const fixture = cloneValid();
    setValue(fixture, ["formatSupport", 0, "recognition", "uncertainty"], new Proxy({}, {}));
    expect(validateProfileCatalog(fixture).ok).toBe(false);
  });

  test("rejects huge sparse collections without length-proportional work", () => {
    const fixture = cloneValid();
    const sparse: unknown[] = [];
    sparse.length = 1_000_000_000;
    setValue(fixture, ["documentFormats"], sparse);
    const startedAt = performance.now();
    expect(validateProfileCatalog(fixture).ok).toBe(false);
    expect(performance.now() - startedAt).toBeLessThan(1000);
  });

  test("caps profile issues with the shared stable sentinel", () => {
    const fixture = cloneValid() as Record<string, unknown>;
    for (let index = 0; index < MAX_VALIDATION_ISSUES + 100; index += 1) {
      fixture[`unexpected${String(index).padStart(4, "0")}`] = true;
    }
    const first = validateProfileCatalog(fixture);
    const second = validateProfileCatalog(fixture);
    expect(first).toEqual(second);
    expect(first.ok).toBe(false);
    if (first.ok) throw new Error("expected capped profile issues");
    expect(first.issues).toHaveLength(MAX_VALIDATION_ISSUES);
    expect(first.issues.at(-1)).toEqual({
      code: VALIDATION_ISSUE_LIMIT_CODE,
      message: `validation stopped after ${String(MAX_VALIDATION_ISSUES - 1)} issues`,
      path: "$",
    });
  });

  test("fails closed on deeply nested non-contract JSON without throwing", () => {
    let nested: unknown = null;
    for (let index = 0; index < 10_000; index += 1) nested = { next: nested };
    const fixture = cloneValid() as Record<string, unknown>;
    fixture["unexpected"] = nested;
    expect(validateProfileCatalog(fixture).ok).toBe(false);
  });
});

describe("uncertainty invariants", () => {
  test("rejects duplicate conditional uncertainty conditions", () => {
    const fixture = cloneValid();
    setValue(fixture, ["formatSupport", 0, "recognition", "uncertainty"], {
      state: "conditional",
      conditions: ["same", "same"],
    });
    expectIssue(
      fixture,
      "$.formatSupport[0].recognition.uncertainty.conditions[1]",
      "duplicate-id",
    );
  });

  test.each([
    {
      uncertainty: { state: "conditional", conditions: [] },
      path: "$.formatSupport[0].recognition.uncertainty.conditions",
    },
    {
      uncertainty: { state: "unknown", reason: "" },
      path: "$.formatSupport[0].recognition.uncertainty.reason",
    },
    {
      uncertainty: {
        state: "contradiction",
        reason: "sources differ",
        alternatives: [{ id: "one", description: "only one" }],
      },
      path: "$.formatSupport[0].recognition.uncertainty.alternatives",
    },
    {
      uncertainty: {
        state: "contradiction",
        reason: "sources differ",
        alternatives: [
          { id: "same", description: "one" },
          { id: "same", description: "two" },
        ],
      },
      path: "$.formatSupport[0].recognition.uncertainty.alternatives",
    },
  ])("rejects malformed $uncertainty.state uncertainty", ({ path, uncertainty }) => {
    const fixture = cloneValid();
    setValue(fixture, ["formatSupport", 0, "recognition", "uncertainty"], uncertainty);
    expectIssue(fixture, path);
  });

  test("requires uncertainty explicitly", () => {
    const fixture = cloneValid();
    deleteValue(fixture, ["formatSupport", 0, "recognition", "uncertainty"]);
    expectIssue(fixture, "$.formatSupport[0].recognition.uncertainty", "missing-field");
  });

  test("requires contradiction evidence and rejects deterministic labels for nondeterministic evidence", () => {
    const missingEvidence = cloneValid();
    setValue(missingEvidence, ["formatSupport", 2, "recognition", "evidence"], ["documented"]);
    expectIssue(missingEvidence, "$.formatSupport[2].recognition.evidence", "invalid-state");

    const knownConditional = cloneValid();
    setValue(knownConditional, ["formatSupport", 1, "recognition", "uncertainty"], {
      state: "known",
    });
    expectIssue(
      knownConditional,
      "$.formatSupport[1].recognition.uncertainty.state",
      "invalid-state",
    );
  });

  test("keeps not-listed support explicitly uncertain", () => {
    const fixture = cloneValid();
    setValue(fixture, ["formatSupport", 0, "recognition", "support"], "not-listed");
    setValue(fixture, ["formatSupport", 0, "recognition", "evidence"], ["not-listed"]);
    expectIssue(fixture, "$.formatSupport[0].recognition.uncertainty.state", "invalid-state");
  });
});

describe("relationship validation", () => {
  test.each([
    {
      path: ["clientProfiles", 0, "surfaceIds", 0],
      value: "missing/surface",
      issuePath: "$.clientProfiles[0].surfaceIds[0]",
    },
    {
      path: ["surfaces", 0, "profileId"],
      value: "missing-profile",
      issuePath: "$.surfaces[0].profileId",
    },
    {
      path: ["surfaces", 0, "specSnapshotIds", 0],
      value: "missing-snapshot",
      issuePath: "$.surfaces[0].specSnapshotIds[0]",
    },
    {
      path: ["formatSupport", 0, "formatId"],
      value: "missing-format",
      issuePath: "$.formatSupport[0].formatId",
    },
    {
      path: ["formatSupport", 0, "surfaceId"],
      value: "missing-surface",
      issuePath: "$.formatSupport[0].surfaceId",
    },
    {
      path: ["formatSupport", 0, "specSnapshotId"],
      value: "missing-snapshot",
      issuePath: "$.formatSupport[0].specSnapshotId",
    },
    {
      path: ["surfaces", 0, "capabilities", 0, "capabilityId"],
      value: "missing-capability",
      issuePath: "$.surfaces[0].capabilities[0].capabilityId",
    },
    {
      path: ["surfaces", 0, "capabilities", 0, "specSnapshotId"],
      value: "cursor/2026-08-01",
      issuePath: "$.surfaces[0].capabilities[0].specSnapshotId",
    },
    {
      path: ["surfaces", 0, "capabilities", 0, "evidenceRefs", 0],
      value: "cursor-cli-docs",
      issuePath: "$.surfaces[0].capabilities[0].evidenceRefs[0]",
    },
    {
      path: ["formatSupport", 0, "capabilities", 0, "capabilityId"],
      value: "event-trace-resolution",
      issuePath: "$.formatSupport[0].capabilities[0].capabilityId",
    },
    {
      path: ["formatSupport", 0, "recognition", "evidenceRefs", 0],
      value: "missing-source",
      issuePath: "$.formatSupport[0].recognition.evidenceRefs[0]",
    },
  ])("rejects broken relationship at $issuePath", ({ issuePath, path, value }) => {
    const fixture = cloneValid();
    setValue(fixture, path, value);
    expectIssue(fixture, issuePath, "invalid-relationship");
  });

  test("rejects duplicate entity IDs and duplicate surface/format pairs", () => {
    const duplicateFormat = cloneValid();
    setValue(duplicateFormat, ["documentFormats", 1, "id"], "agents-markdown");
    expectIssue(duplicateFormat, "$.documentFormats[1].id", "duplicate-id");

    const duplicatePair = cloneValid();
    const first = child(child(duplicatePair, "formatSupport"), 0);
    const relationships = child(duplicatePair, "formatSupport");
    if (!Array.isArray(relationships)) throw new TypeError("expected relationships");
    relationships.push(structuredClone(first));
    expectIssue(duplicatePair, "$.formatSupport[4]", "duplicate-id");
  });

  test("requires a snapshot on every surface capability claim", () => {
    const fixture = cloneValid();
    deleteValue(fixture, ["surfaces", 0, "capabilities", 0, "specSnapshotId"]);
    expectIssue(fixture, "$.surfaces[0].capabilities[0].specSnapshotId", "missing-field");
  });

  test("requires snapshots to list each covered surface owner's profile", () => {
    const fixture = cloneValid();
    setValue(fixture, ["specSnapshots", 0, "profileIds", 0], "cursor-agent");
    expectIssue(fixture, "$.specSnapshots[0].surfaceIds[0]", "invalid-relationship");
  });

  test("rejects an unrelated existing profile in a snapshot", () => {
    const fixture = cloneValid();
    setValue(fixture, ["specSnapshots", 0, "profileIds"], ["codex-cli", "cursor-agent"]);
    expectIssue(fixture, "$.specSnapshots[0].profileIds[1]", "invalid-relationship");
  });

  test.each(["bad id", "bad\0id", "bad//id", "-leading", "trailing-"])(
    "rejects unsafe stable identifier %j",
    (identifier) => {
      const fixture = cloneValid();
      setValue(fixture, ["documentFormats", 0, "id"], identifier);
      expectIssue(fixture, "$.documentFormats[0].id", "invalid-value");
    },
  );

  test("rejects duplicate source IDs within one snapshot", () => {
    const fixture = cloneValid();
    const source = child(child(child(fixture, "specSnapshots"), 0), "sources");
    if (!Array.isArray(source)) throw new TypeError("expected sources");
    source.push(structuredClone(source[0]));
    expectIssue(fixture, "$.specSnapshots[0].sources[1].id", "duplicate-id");
  });
});

describe("source provenance and date boundaries", () => {
  test("accepts a real leap day", () => {
    const fixture = cloneValid();
    setValue(fixture, ["specSnapshots", 0, "retrievedAt"], "2024-02-29");
    setValue(fixture, ["specSnapshots", 0, "sources", 0, "retrievedAt"], "2024-02-29");
    expect(validateProfileCatalog(fixture).ok).toBe(true);
  });

  test.each(["2023-02-29", "2026-02-31", "2026-13-01", "2026-00-10"])(
    "rejects non-calendar date %s",
    (date) => {
      const fixture = cloneValid();
      setValue(fixture, ["specSnapshots", 0, "retrievedAt"], date);
      expectIssue(fixture, "$.specSnapshots[0].retrievedAt", "invalid-date");
    },
  );

  test.each([
    {
      immutability: "immutable",
      url: "https://example.com/source",
      artifactPath: null,
      revision: null,
      mutableSourceReason: null,
      issuePath: "$.specSnapshots[0].sources[0]",
    },
    {
      immutability: "living",
      url: "http://example.com/source",
      artifactPath: null,
      revision: null,
      mutableSourceReason: "Living page.",
      issuePath: "$.specSnapshots[0].sources[0].url",
    },
    {
      immutability: "observation",
      url: null,
      artifactPath: null,
      revision: null,
      mutableSourceReason: null,
      issuePath: "$.specSnapshots[0].sources[0]",
    },
  ])("rejects malformed $immutability source provenance", ({ issuePath, ...sourceFields }) => {
    const fixture = cloneValid();
    for (const [key, value] of Object.entries(sourceFields)) {
      setValue(fixture, ["specSnapshots", 0, "sources", 0, key], value);
    }
    expectIssue(fixture, issuePath);
  });

  test("accepts a canonical repository-owned observation artifact", () => {
    const fixture = cloneValid();
    setValue(fixture, ["specSnapshots", 0, "sources", 0, "immutability"], "observation");
    setValue(fixture, ["specSnapshots", 0, "sources", 0, "url"], null);
    setValue(
      fixture,
      ["specSnapshots", 0, "sources", 0, "artifactPath"],
      "docs/observations/Zażółć-例.md",
    );
    setValue(fixture, ["specSnapshots", 0, "sources", 0, "revision"], null);
    expect(validateProfileCatalog(fixture).ok).toBe(true);
  });

  test.each([
    ".",
    "/etc/passwd",
    "../outside.md",
    "docs/../../outside.md",
    "docs\\observation.md",
    "C:/outside.md",
    "//server/share/file.md",
    "docs/observation\0.md",
    "docs/\ud800.md",
  ])("rejects unsafe observation artifact path %j", (artifactPath) => {
    const fixture = cloneValid();
    setValue(fixture, ["specSnapshots", 0, "sources", 0, "immutability"], "observation");
    setValue(fixture, ["specSnapshots", 0, "sources", 0, "url"], null);
    setValue(fixture, ["specSnapshots", 0, "sources", 0, "artifactPath"], artifactPath);
    setValue(fixture, ["specSnapshots", 0, "sources", 0, "revision"], null);
    expectIssue(fixture, "$.specSnapshots[0].sources[0].artifactPath", "invalid-value");
  });

  test.each([
    "https://",
    "https://\n",
    "http://example.com/source",
    "relative/source",
    "https://user:secret@example.com/source",
    "https:///missing-host",
    "https://example.com/bad%escape",
  ])("rejects malformed or unsafe provenance URL %j", (url) => {
    const fixture = cloneValid();
    setValue(fixture, ["specSnapshots", 0, "sources", 0, "url"], url);
    expectIssue(fixture, "$.specSnapshots[0].sources[0].url", "invalid-value");
  });
});

describe("malformed nested inputs remain data errors", () => {
  test("rejects a primitive catalog without throwing", () => {
    expectIssue(null, "$", "invalid-value");
  });

  test.each([
    { collection: "documentFormats", path: "$.documentFormats[0]" },
    { collection: "clientProfiles", path: "$.clientProfiles[0]" },
    { collection: "surfaces", path: "$.surfaces[0]" },
    { collection: "specSnapshots", path: "$.specSnapshots[0]" },
    { collection: "capabilityDefinitions", path: "$.capabilityDefinitions[0]" },
    { collection: "formatSupport", path: "$.formatSupport[0]" },
  ])("rejects a primitive in $collection", ({ collection, path }) => {
    const fixture = cloneValid();
    setValue(fixture, [collection, 0], null);
    expectIssue(fixture, path, "invalid-value");
  });

  test.each([
    {
      edit: (fixture: unknown): void => {
        deleteValue(fixture, ["specSnapshots", 0, "clientVersion"]);
      },
      path: "$.specSnapshots[0].clientVersion",
    },
    {
      edit: (fixture: unknown): void => {
        setValue(fixture, ["specSnapshots", 0, "clientVersion"], 146);
      },
      path: "$.specSnapshots[0].clientVersion",
    },
    {
      edit: (fixture: unknown): void => {
        deleteValue(fixture, ["documentFormats", 0, "syntaxFeatures"]);
      },
      path: "$.documentFormats[0].syntaxFeatures",
    },
    {
      edit: (fixture: unknown): void => {
        setValue(fixture, ["documentFormats", 0, "syntaxFeatures"], {});
      },
      path: "$.documentFormats[0].syntaxFeatures",
    },
    {
      edit: (fixture: unknown): void => {
        setValue(
          fixture,
          ["clientProfiles", 0, "surfaceIds"],
          ["codex-cli/local-cli-single-cwd", "codex-cli/local-cli-single-cwd"],
        );
      },
      path: "$.clientProfiles[0].surfaceIds",
    },
    {
      edit: (fixture: unknown): void => {
        deleteValue(fixture, ["specSnapshots", 0, "retrievedAt"]);
      },
      path: "$.specSnapshots[0].retrievedAt",
    },
  ])("rejects missing, malformed, or duplicate scalar containers at $path", ({ edit, path }) => {
    const fixture = cloneValid();
    edit(fixture);
    expectIssue(fixture, path);
  });

  test.each([
    {
      uncertainty: null,
      path: "$.formatSupport[0].recognition.uncertainty",
    },
    {
      uncertainty: { state: "known", reason: "not allowed" },
      path: "$.formatSupport[0].recognition.uncertainty.reason",
    },
    {
      uncertainty: { state: "conditional", conditions: ["condition"], reason: "not allowed" },
      path: "$.formatSupport[0].recognition.uncertainty.reason",
    },
    {
      uncertainty: { state: "unknown", reason: "unknown", conditions: ["not allowed"] },
      path: "$.formatSupport[0].recognition.uncertainty.conditions",
    },
    {
      uncertainty: {
        state: "contradiction",
        reason: "sources differ",
        conditions: ["not allowed"],
        alternatives: [
          { id: "one", description: "one" },
          { id: "two", description: "two" },
        ],
      },
      path: "$.formatSupport[0].recognition.uncertainty.conditions",
    },
  ])("rejects incompatible uncertainty members at $path", ({ path, uncertainty }) => {
    const fixture = cloneValid();
    setValue(fixture, ["formatSupport", 0, "recognition", "uncertainty"], uncertainty);
    expectIssue(fixture, path);
  });

  test("rejects contradictory evidence without contradiction uncertainty", () => {
    const fixture = cloneValid();
    setValue(fixture, ["formatSupport", 0, "recognition", "evidence"], ["contradiction"]);
    expectIssue(fixture, "$.formatSupport[0].recognition.uncertainty.state", "invalid-state");
  });

  test("rejects conditional support without conditional uncertainty", () => {
    const fixture = cloneValid();
    setValue(fixture, ["formatSupport", 0, "recognition", "support"], "conditional");
    expectIssue(fixture, "$.formatSupport[0].recognition.uncertainty.state", "invalid-state");
  });

  test("rejects empty sources and missing recognition", () => {
    const emptySources = cloneValid();
    setValue(emptySources, ["specSnapshots", 0, "sources"], []);
    expectIssue(emptySources, "$.specSnapshots[0].sources", "invalid-value");

    const missingRecognition = cloneValid();
    deleteValue(missingRecognition, ["formatSupport", 0, "recognition"]);
    expectIssue(missingRecognition, "$.formatSupport[0].recognition", "missing-field");
  });

  test("rejects a profile listing a surface owned by another profile", () => {
    const fixture = cloneValid();
    setValue(fixture, ["clientProfiles", 0, "surfaceIds", 0], "copilot-vscode/local-chat");
    expectIssue(fixture, "$.clientProfiles[0].surfaceIds[0]", "invalid-relationship");
  });

  test("rejects unknown snapshot profiles and surfaces", () => {
    const unknownProfile = cloneValid();
    setValue(unknownProfile, ["specSnapshots", 0, "profileIds", 0], "missing-profile");
    expectIssue(unknownProfile, "$.specSnapshots[0].profileIds[0]", "invalid-relationship");

    const unknownSurface = cloneValid();
    setValue(unknownSurface, ["specSnapshots", 0, "surfaceIds", 0], "missing-surface");
    expectIssue(unknownSurface, "$.specSnapshots[0].surfaceIds[0]", "invalid-relationship");
  });

  test("rejects duplicate capability claims", () => {
    const fixture = cloneValid();
    const capabilities = child(child(child(fixture, "formatSupport"), 0), "capabilities");
    if (!Array.isArray(capabilities)) throw new TypeError("expected capabilities");
    capabilities.push(structuredClone(capabilities[0]));
    expectIssue(fixture, "$.formatSupport[0].capabilities[1].capabilityId", "duplicate-id");
  });
});
