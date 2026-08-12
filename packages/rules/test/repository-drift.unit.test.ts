import { createHash } from "node:crypto";

import { describe, expect, test, vi } from "vitest";

import { canonicalizeRepositoryRelativePath } from "@agent-context/core";
import type {
  AstNodeId,
  InstructionDocumentId,
  InstructionStatementId,
  RepositoryRelativePath,
  SourceDocumentId,
  SourceRange,
} from "@agent-context/core";
import {
  EVIDENCE_INDEX_CONTRACT_VERSION,
  EVIDENCE_INDEX_DEFAULT_LIMITS,
} from "@agent-context/evidence";
import type { EvidenceFact, RepositoryEvidenceIndex } from "@agent-context/evidence";

import {
  REPOSITORY_DRIFT_DEFAULT_LIMITS,
  REPOSITORY_DRIFT_HARD_LIMITS,
  RepositoryDriftError,
  RepositoryDriftErrorCode,
  evaluateRepositoryDrift,
} from "../src/index.js";
import type { RepositoryDriftOptions, RepositoryDriftStatementInput } from "../src/index.js";

let factSequence = 0;

function range(text: string, sourceId: string): SourceRange {
  return {
    end: {
      byteOffset: Buffer.byteLength(text, "utf8"),
      line: 0,
      utf16Column: text.length,
      utf16Offset: text.length,
    },
    sourceId: sourceId as SourceDocumentId,
    start: { byteOffset: 0, line: 0, utf16Column: 0, utf16Offset: 0 },
  };
}

function statement(
  statementId: string,
  text: string,
  path = "AGENTS.md",
  dialect: RepositoryDriftStatementInput["dialect"] = "posix-shell",
): RepositoryDriftStatementInput {
  const sourceId = `source-${statementId}`;
  return {
    dialect,
    documentId: `document-${statementId}` as InstructionDocumentId,
    nodeIds: [`node-${statementId}` as AstNodeId],
    path: canonicalizeRepositoryRelativePath(path),
    range: range(text, sourceId),
    sourceDigest: createHash("sha256").update(text).digest("hex"),
    statementId: statementId as InstructionStatementId,
    text,
  };
}

function fact(
  category: EvidenceFact["category"],
  name: string,
  value: string,
  scope = ".",
  overrides: Partial<EvidenceFact> = {},
): EvidenceFact {
  factSequence += 1;
  const path =
    category === "path" ? name : category === "tool" ? `${name}.config.js` : "package.json";
  return {
    category,
    certainty: "declared",
    id: `fact:${String(factSequence).padStart(4, "0")}`,
    location: {
      path: canonicalizeRepositoryRelativePath(path),
      range: {
        end: { byteOffset: 1, line: 0, utf16Column: 1, utf16Offset: 1 },
        start: { byteOffset: 0, line: 0, utf16Column: 0, utf16Offset: 0 },
      },
    },
    name,
    provenance: {
      collectorId: `f01.${category}`,
      interpretation: category === "path" ? "path-only" : "inert-text",
      sourceState: category === "path" ? "path-only" : "complete",
    },
    rawValue: value,
    scope: canonicalizeRepositoryRelativePath(scope),
    value,
    ...overrides,
  };
}

function evidence(
  facts: readonly EvidenceFact[],
  uncertainty: RepositoryEvidenceIndex["uncertainty"] = "known",
): RepositoryEvidenceIndex {
  return {
    conflicts: [],
    contractVersion: EVIDENCE_INDEX_CONTRACT_VERSION,
    facts,
    issues: [],
    limits: EVIDENCE_INDEX_DEFAULT_LIMITS,
    metrics: {
      conflictCount: 0,
      contentReads: 0,
      factCount: facts.length,
      issueCount: 0,
      pathCount: facts.filter((item) => item.category === "path").length,
      totalBytes: 0,
    },
    uncertainty,
    uncertaintyReasons: uncertainty === "known" ? [] : ["synthetic incomplete source"],
  };
}

function options(overrides: RepositoryDriftOptions): RepositoryDriftOptions {
  return { ...REPOSITORY_DRIFT_DEFAULT_LIMITS, ...overrides };
}

describe("F09 repository drift rules", () => {
  test("emits ACL300-ACL305 from composed F01, F02, and F03 evidence", () => {
    const statements = [
      statement("statement-01", "Run npm run missing"),
      statement("statement-02", "Do not edit config/missing.yml"),
      statement("statement-03", "Run eslint src"),
      statement("statement-04", "Node version must be 20"),
      statement("statement-05", "Use prettier to format source files"),
    ];
    const facts = [
      fact("package-manager", "selected", "pnpm"),
      fact("script", "build", "tsc"),
      fact("path", "config/existing.yml", "present", ".", {
        certainty: "observed-path",
      }),
      fact("runtime", "node", "^24.11.0"),
      fact("tool", "prettier", "configuration"),
    ];
    const result = evaluateRepositoryDrift(statements, evidence(facts));

    expect(result.bundle.diagnostics.map((diagnostic) => diagnostic.ruleId)).toEqual([
      "ACL300",
      "ACL301",
      "ACL302",
      "ACL303",
      "ACL304",
      "ACL305",
    ]);
    expect(result.bundle.diagnostics.map((diagnostic) => diagnostic.severity)).toEqual([
      "error",
      "warning",
      "warning",
      "warning",
      "warning",
      "info",
    ]);
    expect(
      result.bundle.diagnostics.find((item) => item.ruleId === "ACL301")?.related,
    ).toHaveLength(1);
    expect(
      result.bundle.diagnostics.find((item) => item.ruleId === "ACL305")?.related,
    ).toHaveLength(1);
    expect(result).toMatchObject({
      commandLexerContractVersion: "0.1.0",
      contractVersion: "0.1.0",
      evidenceIndexContractVersion: "0.1.0",
      statementClassifierContractVersion: "0.1.0",
      metrics: { diagnosticCount: 6, statementCount: 5, uncertaintyCount: 0 },
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.bundle.diagnostics[0]?.primary.range.start)).toBe(true);
  });

  test("passes existing tasks, paths, tools, runtimes, and selected package managers", () => {
    const facts = [
      fact("package-manager", "selected", "pnpm"),
      fact("script", "build", "tsc"),
      fact("task", "verify", "make"),
      fact("path", "scripts/check.sh", "present", ".", { certainty: "observed-path" }),
      fact("runtime", "node", "24.11.0"),
      fact("tool", "eslint", "configuration"),
    ];
    const statements = [
      statement("statement-01", "Run pnpm run build"),
      statement("statement-02", "Run make verify"),
      statement("statement-03", "Run ./scripts/check.sh"),
      statement("statement-04", "Run eslint src"),
      statement("statement-05", "Use node 24"),
    ];
    const result = evaluateRepositoryDrift(statements, evidence(facts));
    expect(result.bundle.diagnostics).toEqual([]);
    expect(result.uncertainties).toEqual([]);
  });

  test("retains Yarn and Bun script-or-binary/file resolution as explicit uncertainty", () => {
    const statements = [
      statement("statement-01", "Run yarn missing"),
      statement("statement-02", "Run yarn run missing"),
      statement("statement-03", "Run bun test"),
      statement("statement-04", "Run bun run missing"),
    ];
    const result = evaluateRepositoryDrift(
      statements,
      evidence([
        fact("package-manager", "selected", "yarn", "packages/yarn"),
        fact("package-manager", "selected", "bun", "packages/bun"),
      ]),
    );
    expect(result.bundle.diagnostics.filter((item) => item.ruleId === "ACL300")).toEqual([]);
    expect(result.uncertainties.filter((item) => item.ruleId === "ACL300")).toEqual([
      expect.objectContaining({ reason: "ambiguous-task-resolution", subject: "missing" }),
      expect.objectContaining({ reason: "ambiguous-task-resolution", subject: "missing" }),
      expect.objectContaining({ reason: "ambiguous-task-resolution", subject: "test" }),
      expect.objectContaining({ reason: "ambiguous-task-resolution", subject: "missing" }),
    ]);
  });

  test("accepts an existing Yarn/Bun script without claiming missing-task uncertainty", () => {
    const result = evaluateRepositoryDrift(
      [statement("statement-01", "Run yarn build"), statement("statement-02", "Run bun run build")],
      evidence([fact("script", "build", "tsc")]),
    );
    expect(result.bundle.diagnostics).toEqual([]);
    expect(result.uncertainties.filter((item) => item.ruleId === "ACL300")).toEqual([]);
  });

  test("does not treat npm lifecycle shorthand as an arbitrary missing script", () => {
    const result = evaluateRepositoryDrift(
      [statement("statement-01", "Run npm test")],
      evidence([fact("package-manager", "selected", "npm")]),
    );
    expect(result.bundle.diagnostics).toEqual([]);
    expect(result.uncertainties).toEqual([]);
  });

  test("covers explicit alternate task forms without promoting unsafe candidates", () => {
    const result = evaluateRepositoryDrift(
      [
        statement("statement-01", "Run npm run-script missing"),
        statement("statement-02", "Run just verify"),
        statement("statement-03", "Run npm run"),
        statement("statement-04", "Run make --help"),
        statement("statement-05", "Run ../outside"),
        statement("statement-06", "Do not edit ../outside"),
        statement("statement-07", "Run pnpm run /^lint:/"),
      ],
      evidence([]),
    );
    expect(result.bundle.diagnostics.map((item) => item.ruleId)).toEqual(["ACL300", "ACL300"]);
    expect(result.uncertainties).toContainEqual(
      expect.objectContaining({ ruleId: "ACL300", reason: "pattern-task-reference" }),
    );
  });

  test("marks optional scripts, automatic dialects, dynamic words, and incomplete indexes unknown", () => {
    const statements = [
      statement("statement-01", "Run npm run --if-present absent"),
      statement("statement-02", "Run npm run build", "AGENTS.md", "auto"),
      statement("statement-03", "Run $TOOL run build"),
      statement("statement-04", "Run npm run missing"),
    ];
    const result = evaluateRepositoryDrift(statements, evidence([], "uncertain"));
    expect(result.bundle.diagnostics).toEqual([]);
    expect(new Set(result.uncertainties.map((item) => item.reason))).toEqual(
      new Set([
        "ambiguous-command-dialect",
        "dynamic-command",
        "evidence-index-uncertain",
        "optional-task-reference",
      ]),
    );
  });

  test("uses the nearest applicable scope and refuses conflicting manager certainty", () => {
    const facts = [
      fact("package-manager", "selected", "pnpm"),
      fact("package-manager", "selected", "npm", "packages/app"),
      fact("package-manager", "selected", "yarn", "packages/conflict"),
      fact("package-manager", "selected", "pnpm", "packages/conflict"),
    ];
    const result = evaluateRepositoryDrift(
      [
        statement("statement-01", "Run npm run build", "packages/app/AGENTS.md"),
        statement("statement-02", "Run npm run build", "packages/conflict/AGENTS.md"),
      ],
      evidence([
        ...facts,
        fact("script", "build", "ok", "packages/app"),
        fact("script", "build", "ok", "packages/conflict"),
      ]),
    );
    expect(result.bundle.diagnostics).toEqual([]);
    expect(result.uncertainties).toContainEqual(
      expect.objectContaining({ ruleId: "ACL301", reason: "evidence-conflict" }),
    );
  });

  test("requires every usable runtime fact to support a conflict conclusion", () => {
    const mixed = evaluateRepositoryDrift(
      [statement("statement-01", "Use node 20")],
      evidence([fact("runtime", "node", "20.18.0"), fact("runtime", "node", "24.11.0")]),
    );
    expect(mixed.bundle.diagnostics).toEqual([]);
    expect(mixed.uncertainties).toContainEqual(
      expect.objectContaining({ ruleId: "ACL304", reason: "evidence-conflict" }),
    );

    const unsupported = evaluateRepositoryDrift(
      [statement("statement-01", "Use python 3.13")],
      evidence([fact("runtime", "python", ">=3.12 <4")]),
    );
    expect(unsupported.bundle.diagnostics).toEqual([]);
    expect(unsupported.uncertainties).toContainEqual(
      expect.objectContaining({ reason: "unsupported-runtime-constraint" }),
    );

    const caretMinor = evaluateRepositoryDrift(
      [statement("statement-01", "Use node 24.12")],
      evidence([fact("runtime", "node", "^24.11.0")]),
    );
    expect(caretMinor.bundle.diagnostics).toEqual([]);
    expect(caretMinor.uncertainties).toContainEqual(
      expect.objectContaining({ reason: "unsupported-runtime-constraint" }),
    );

    const exactMinor = evaluateRepositoryDrift(
      [statement("statement-01", "Use node 24.12")],
      evidence([fact("runtime", "node", "24.11.0")]),
    );
    expect(exactMinor.bundle.diagnostics.map((item) => item.ruleId)).toEqual(["ACL304"]);

    const incomplete = evaluateRepositoryDrift(
      [statement("statement-01", "Use node 20")],
      evidence([fact("runtime", "node", "24.11.0")], "uncertain"),
    );
    expect(incomplete.bundle.diagnostics).toEqual([]);
    expect(incomplete.uncertainties).toContainEqual(
      expect.objectContaining({ ruleId: "ACL304", reason: "evidence-index-uncertain" }),
    );
  });

  test.each([
    "Run npx eslint src",
    "Run bunx eslint src",
    "Run pnpm exec eslint src",
    "Run yarn exec eslint src",
    "Run npm exec eslint src",
    "Run npm exec -- eslint src",
  ])("finds an absent project tool through wrapper command: %s", (text) => {
    const result = evaluateRepositoryDrift([statement("statement-01", text)], evidence([]));
    expect(result.bundle.diagnostics).toHaveLength(1);
    expect(result.bundle.diagnostics[0]?.ruleId).toBe("ACL303");
    expect(result.bundle.diagnostics[0]?.message).toContain("eslint");
    expect(result.uncertainties.filter((item) => item.ruleId === "ACL300")).toEqual([]);
  });

  test("deduplicates repeated findings and uncertainties in compound commands", () => {
    const diagnostics = evaluateRepositoryDrift(
      [statement("statement-01", "Run eslint src && eslint test")],
      evidence([]),
    );
    expect(diagnostics.bundle.diagnostics.map((item) => item.ruleId)).toEqual(["ACL303"]);

    const uncertainties = evaluateRepositoryDrift(
      [statement("statement-01", "Run yarn missing && yarn missing")],
      evidence([]),
    );
    expect(uncertainties.uncertainties.filter((item) => item.ruleId === "ACL300")).toHaveLength(1);
  });

  test("handles directory prefixes, unsafe path prose, absolute commands, and incomplete facts", () => {
    const facts = [
      fact("path", "src/file.ts", "present", ".", { certainty: "observed-path" }),
      fact("path", "config/maybe.yml", "present", ".", { certainty: "uncertain" }),
      fact("tool", "eslint", "configuration", ".", { certainty: "uncertain" }),
      fact("runtime", "node", "24", ".", { certainty: "uncertain" }),
    ];
    const result = evaluateRepositoryDrift(
      [
        statement("statement-01", "Do not edit src/"),
        statement("statement-02", "Do not edit generated files"),
        statement("statement-03", "Run /usr/bin/tool"),
        statement("statement-04", "Do not edit config/maybe.yml"),
        statement("statement-05", "Run eslint src"),
        statement("statement-06", "Use node 20"),
      ],
      evidence(facts),
    );
    expect(result.bundle.diagnostics).toEqual([]);
    expect(result.uncertainties).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ruleId: "ACL302", reason: "evidence-index-uncertain" }),
        expect.objectContaining({ ruleId: "ACL303", reason: "evidence-index-uncertain" }),
        expect.objectContaining({ ruleId: "ACL304", reason: "evidence-index-uncertain" }),
      ]),
    );
  });

  test("treats non-complete fact provenance as uncertainty rather than absence", () => {
    const incomplete = {
      certainty: "declared" as const,
      provenance: {
        collectorId: "f01.incomplete",
        interpretation: "inert-text" as const,
        sourceState: "unavailable" as const,
      },
    };
    const result = evaluateRepositoryDrift(
      [
        statement("statement-01", "Run npm run build"),
        statement("statement-02", "Run eslint src"),
        statement("statement-03", "Use node 20"),
      ],
      evidence([
        fact("script", "build", "unknown", ".", incomplete),
        fact("tool", "eslint", "unknown", ".", incomplete),
        fact("runtime", "node", "24", ".", incomplete),
      ]),
    );
    expect(result.bundle.diagnostics).toEqual([]);
    expect(result.uncertainties).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ruleId: "ACL300", reason: "evidence-index-uncertain" }),
        expect.objectContaining({ ruleId: "ACL303", reason: "evidence-index-uncertain" }),
        expect.objectContaining({ ruleId: "ACL304", reason: "evidence-index-uncertain" }),
      ]),
    );
  });

  test("recognizes anchored runtime aliases and ignores version prose without a requirement", () => {
    const result = evaluateRepositoryDrift(
      [
        statement("statement-01", "Node.js version must be 24"),
        statement("statement-02", "Use golang 1"),
        statement("statement-03", "The Node 20 release is documented here"),
      ],
      evidence([fact("runtime", "node", "24.1.0"), fact("runtime", "go", "2.0.0")]),
    );
    expect(result.bundle.diagnostics.map((item) => item.ruleId)).toEqual(["ACL304"]);
  });

  test("recognizes configured lint policy as mechanical without inferring one when absent", () => {
    const present = evaluateRepositoryDrift(
      [statement("statement-01", "Use eslint for linting")],
      evidence([fact("tool", "eslint", "configuration")]),
    );
    expect(present.bundle.diagnostics.map((item) => item.ruleId)).toEqual(["ACL305"]);
    const absent = evaluateRepositoryDrift(
      [statement("statement-01", "Use eslint for linting")],
      evidence([]),
    );
    expect(absent.bundle.diagnostics).toEqual([]);
  });

  test("is deterministic across fact order and does not call network capability", () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const statements = [statement("statement-01", "Run npm run absent")];
    const facts = [fact("package-manager", "selected", "pnpm"), fact("runtime", "node", "24")];
    const first = evaluateRepositoryDrift(statements, evidence(facts));
    const second = evaluateRepositoryDrift(statements, evidence([...facts].reverse()));
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockRestore();
  });

  test("rejects proxies, accessors, sparse arrays, malformed paths, digests, facts, and options", () => {
    const trap = vi.fn(() => {
      throw new Error("must not execute");
    });
    expect(() => evaluateRepositoryDrift(new Proxy([], { ownKeys: trap }), evidence([]))).toThrow(
      RepositoryDriftError,
    );
    expect(trap).not.toHaveBeenCalled();

    const accessor = [statement("statement-01", "Run npm run build")];
    Object.defineProperty(accessor, 0, { get: trap });
    expect(() => evaluateRepositoryDrift(accessor, evidence([]))).toThrow(RepositoryDriftError);
    expect(trap).not.toHaveBeenCalled();

    const sparse = Array<RepositoryDriftStatementInput>(1);
    expect(() => evaluateRepositoryDrift(sparse, evidence([]))).toThrow(RepositoryDriftError);

    const accessorFact = fact("tool", "eslint", "configuration");
    Object.defineProperty(accessorFact, "category", { get: trap });
    expect(() => evaluateRepositoryDrift([], { ...evidence([]), facts: [accessorFact] })).toThrow(
      RepositoryDriftError,
    );
    expect(trap).not.toHaveBeenCalled();
    expect(() =>
      evaluateRepositoryDrift([], {
        ...evidence([]),
        facts: [new Proxy(fact("tool", "eslint", "configuration"), { ownKeys: trap })],
      }),
    ).toThrow(RepositoryDriftError);
    expect(trap).not.toHaveBeenCalled();

    expect(() =>
      evaluateRepositoryDrift(
        [{ ...statement("statement-01", "ok"), path: "../escape" as RepositoryRelativePath }],
        evidence([]),
      ),
    ).toThrow(RepositoryDriftError);
    expect(() =>
      evaluateRepositoryDrift(
        [{ ...statement("statement-01", "ok"), sourceDigest: "bad" }],
        evidence([]),
      ),
    ).toThrow(RepositoryDriftError);
    expect(() =>
      evaluateRepositoryDrift([], {
        ...evidence([]),
        facts: [{ ...fact("tool", "eslint", "configuration"), category: "unknown" }],
      }),
    ).toThrow(RepositoryDriftError);
    expect(() => evaluateRepositoryDrift([], evidence([]), new Date())).toThrow(
      expect.objectContaining({ code: RepositoryDriftErrorCode.invalidOptions }),
    );
    expect(() => evaluateRepositoryDrift([], evidence([]), { maximumStatements: 0 })).toThrow(
      expect.objectContaining({ code: RepositoryDriftErrorCode.invalidOptions }),
    );
    expect(() =>
      evaluateRepositoryDrift([], evidence([]), {
        maximumStatements: REPOSITORY_DRIFT_HARD_LIMITS.maximumStatements + 1,
      }),
    ).toThrow(expect.objectContaining({ code: RepositoryDriftErrorCode.invalidOptions }));
  });

  test.each([
    ["null statement", [null], evidence([])],
    ["statement prototype", [Object.create({})], evidence([])],
    [
      "unknown statement field",
      [{ ...statement("statement-01", "ok"), unknown: true }],
      evidence([]),
    ],
    [
      "duplicate statement ID",
      [statement("statement-01", "ok"), statement("statement-01", "ok")],
      evidence([]),
    ],
    [
      "unsupported dialect",
      [{ ...statement("statement-01", "ok"), dialect: "future-shell" }],
      evidence([]),
    ],
    ["malformed statement Unicode", [statement("statement-01", "bad\ud800")], evidence([])],
    [
      "invalid statement identifier",
      [{ ...statement("statement-01", "ok"), statementId: "invalid id" }],
      evidence([]),
    ],
    [
      "noncanonical statement path",
      [{ ...statement("statement-01", "ok"), path: "./AGENTS.md" }],
      evidence([]),
    ],
    [
      "negative range position",
      [
        {
          ...statement("statement-01", "ok"),
          range: {
            ...statement("statement-01", "ok").range,
            start: { byteOffset: -1, line: 0, utf16Column: 0, utf16Offset: 0 },
          },
        },
      ],
      evidence([]),
    ],
    ["invalid index contract", [], { ...evidence([]), contractVersion: "9" }],
    ["invalid index uncertainty", [], { ...evidence([]), uncertainty: "maybe" }],
    [
      "duplicate fact ID",
      [],
      ((): RepositoryEvidenceIndex => {
        const first = fact("tool", "eslint", "configuration");
        return evidence([first, { ...fact("tool", "prettier", "configuration"), id: first.id }]);
      })(),
    ],
    [
      "reversed fact range",
      [],
      evidence([
        fact("tool", "eslint", "configuration", ".", {
          location: {
            path: canonicalizeRepositoryRelativePath("eslint.config.js"),
            range: {
              end: { byteOffset: 0, line: 0, utf16Column: 0, utf16Offset: 0 },
              start: { byteOffset: 1, line: 0, utf16Column: 1, utf16Offset: 1 },
            },
          },
        }),
      ]),
    ],
    [
      "invalid fact certainty",
      [],
      {
        ...evidence([]),
        facts: [{ ...fact("tool", "eslint", "configuration"), certainty: "yes" }],
      },
    ],
    [
      "non-string fact name",
      [],
      {
        ...evidence([]),
        facts: [{ ...fact("tool", "eslint", "configuration"), name: 7 }],
      },
    ],
    [
      "invalid provenance",
      [],
      {
        ...evidence([]),
        facts: [
          {
            ...fact("tool", "eslint", "configuration"),
            provenance: {
              collectorId: "f01.tool",
              interpretation: "executable",
              sourceState: "complete",
            },
          },
        ],
      },
    ],
    [
      "invalid provenance source state",
      [],
      {
        ...evidence([]),
        facts: [
          {
            ...fact("tool", "eslint", "configuration"),
            provenance: {
              collectorId: "f01.tool",
              interpretation: "inert-text",
              sourceState: "future",
            },
          },
        ],
      },
    ],
  ] as const)("rejects %s", (_label, statements, index) => {
    expect(() => evaluateRepositoryDrift(statements, index)).toThrow(
      expect.objectContaining({ code: RepositoryDriftErrorCode.invalidInput }),
    );
  });

  test.each([
    [
      "maximumStatements",
      [statement("statement-01", "ok"), statement("statement-02", "ok")],
      evidence([]),
    ],
    [
      "maximumFacts",
      [],
      evidence([
        fact("tool", "eslint", "configuration"),
        fact("tool", "prettier", "configuration"),
      ]),
    ],
    [
      "maximumDiagnostics",
      [statement("statement-01", "Run make one"), statement("statement-02", "Run make two")],
      evidence([]),
    ],
    [
      "maximumUncertainties",
      [statement("statement-01", "Run npm run build", "AGENTS.md", "auto")],
      evidence([]),
    ],
    [
      "maximumRelatedFacts",
      [statement("statement-01", "Use node 20")],
      evidence([fact("runtime", "node", "24"), fact("runtime", "node", "25")]),
    ],
  ] as const)("enforces %s", (limitName, statements, index) => {
    expect(() => evaluateRepositoryDrift(statements, index, options({ [limitName]: 1 }))).toThrow(
      expect.objectContaining({
        code: RepositoryDriftErrorCode.limitExceeded,
        limitName,
      }),
    );
  });

  test("enforces maximumTextLength before classification", () => {
    expect(() =>
      evaluateRepositoryDrift(
        [statement("statement-01", "Run npm run build")],
        evidence([]),
        options({ maximumTextLength: 3 }),
      ),
    ).toThrow(expect.objectContaining({ code: RepositoryDriftErrorCode.invalidInput }));
  });
});
