import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";

import { describe, expect, test } from "vitest";

import {
  INSTRUCTION_IR_CONTRACT_VERSION,
  validateDiagnosticBundle,
  validateInstructionIr,
} from "@agent-context/core";
import { countEstimatedTokens } from "@agent-context/efficiency";
import {
  DOCUMENT_CONTEXT_BUDGET_SCOPE,
  DOCUMENT_CONTEXT_HARD_MAXIMUM_THRESHOLD,
  DOCUMENT_CONTEXT_MAX_IMPORTS_PER_DOCUMENT,
  evaluateDocumentContextRules,
} from "../src/index.js";

import type {
  ActivationRule,
  AstNode,
  AstNodeId,
  ImportReference,
  InstructionDocument,
  InstructionIr,
  InstructionStatement,
  RepositoryRelativePath,
  SourceDocument,
  SourceDocumentId,
  SourcePosition,
} from "@agent-context/core";
import type { DocumentImportResolution } from "../src/index.js";

interface DocumentFixture {
  readonly always?: boolean;
  readonly path: string;
  readonly text: string;
}

interface BuiltFixture {
  readonly input: {
    readonly contractVersion: "0.1.0";
    readonly importResolutions: readonly DocumentImportResolution[];
    readonly ir: InstructionIr;
    readonly recordKind: "agent-context-document-context-rule-input";
  };
  readonly statements: readonly InstructionStatement[];
}

function lineEndingOf(text: string): SourceDocument["lineEnding"] {
  const endings = new Set<string>();
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\r" && text[index + 1] === "\n") {
      endings.add("crlf");
      index += 1;
    } else if (text[index] === "\r") endings.add("cr");
    else if (text[index] === "\n") endings.add("lf");
  }
  if (endings.size === 0) return "none";
  if (endings.size > 1) return "mixed";
  return [...endings][0] as SourceDocument["lineEnding"];
}

function positionAt(text: string, offset: number): SourcePosition {
  let line = 0;
  let lineStart = 0;
  for (let index = 0; index < offset; index += 1) {
    if (text[index] === "\r" && text[index + 1] === "\n") {
      if (index + 1 < offset) {
        line += 1;
        lineStart = index + 2;
        index += 1;
      }
    } else if (text[index] === "\r" || text[index] === "\n") {
      line += 1;
      lineStart = index + 1;
    }
  }
  return {
    byteOffset: Buffer.byteLength(text.slice(0, offset), "utf8"),
    line,
    utf16Column: offset - lineStart,
    utf16Offset: offset,
  };
}

function fixtureNodes(
  sourceId: SourceDocumentId,
  text: string,
  documentIndex: number,
): { readonly nodes: readonly AstNode[]; readonly rootNodeId: AstNodeId } {
  const rootNodeId = `node:${String(documentIndex)}:root` as AstNodeId;
  const children: AstNode[] = [];
  const blockPattern = /(?:^|\n\n)([^]*?)(?=\n\n|$)/gu;
  for (const match of text.matchAll(blockPattern)) {
    const raw = match[1];
    if (raw === undefined || raw.length === 0) continue;
    const prefixLength = match[0].length - raw.length;
    const startOffset = match.index + prefixLength;
    const endOffset = startOffset + raw.length;
    const id = `node:${String(documentIndex)}:block:${String(children.length)}` as AstNodeId;
    const base = {
      childIds: [] as readonly AstNodeId[],
      id,
      range: {
        end: positionAt(text, endOffset),
        sourceId,
        start: positionAt(text, startOffset),
      },
      sourceId,
    };
    children.push(
      raw.startsWith("```")
        ? { ...base, kind: "code-block", language: null, metadata: null }
        : { ...base, kind: "paragraph" },
    );
  }
  return {
    nodes: [
      {
        childIds: children.map((node) => node.id),
        id: rootNodeId,
        kind: "root",
        range: { end: positionAt(text, text.length), sourceId, start: positionAt(text, 0) },
        sourceId,
      },
      ...children,
    ],
    rootNodeId,
  };
}

function buildFixture(fixtures: readonly DocumentFixture[]): BuiltFixture {
  const sources: SourceDocument[] = [];
  const nodes: AstNode[] = [];
  const documents: InstructionDocument[] = [];
  const statements: InstructionStatement[] = [];
  const activationRules: ActivationRule[] = [];
  for (const [documentIndex, fixture] of fixtures.entries()) {
    const sourceId = `source:document-${String(documentIndex)}` as SourceDocumentId;
    const parsed = fixtureNodes(sourceId, fixture.text, documentIndex);
    const source: SourceDocument = {
      bom: "none",
      byteLength: Buffer.byteLength(fixture.text, "utf8"),
      encoding: "utf-8",
      id: sourceId,
      lineEnding: lineEndingOf(fixture.text),
      parseState: { state: "complete" },
      path: fixture.path as RepositoryRelativePath,
      rootNodeId: parsed.rootNodeId,
      sha256: createHash("sha256").update(fixture.text).digest("hex"),
      text: fixture.text,
      utf16Length: fixture.text.length,
    };
    sources.push(source);
    nodes.push(...parsed.nodes);
    const documentId = `document:${String(documentIndex)}` as InstructionDocument["id"];
    const documentStatements = parsed.nodes
      .filter((node) => node.kind === "paragraph")
      .map((node, statementIndex): InstructionStatement => ({
        classification: { state: "unclassified" },
        documentId,
        id: `statement:${String(documentIndex)}:${String(statementIndex)}` as InstructionStatement["id"],
        nodeIds: [node.id],
        range: node.range,
        text: fixture.text.slice(node.range.start.utf16Offset, node.range.end.utf16Offset),
      }));
    statements.push(...documentStatements);
    const activationId = `activation:${String(documentIndex)}` as ActivationRule["id"];
    documents.push({
      activationRuleIds: [activationId],
      formatId: "agents-markdown",
      id: documentId,
      importIds: [],
      rootNodeId: parsed.rootNodeId,
      scopeRoot: "." as RepositoryRelativePath,
      sourceId,
      statementIds: documentStatements.map((statement) => statement.id),
    });
    activationRules.push({
      conditions: [],
      documentId,
      evidenceRefs: [
        {
          factId: `fixture:activation:${String(documentIndex)}`,
          sourceId: "fixture:profile-observation",
        },
      ],
      exclude: [],
      id: activationId,
      include: [],
      kind: fixture.always === false ? "manual" : "always",
      profileId: "profile:test",
      scopeRoot: "." as RepositoryRelativePath,
      specSnapshotId: "profile:test/1.0.0/2026-08-02",
      surfaceId: "profile:test/local",
      uncertainty: { state: "known" },
      unknownReason: null,
    });
  }
  const ir: InstructionIr = {
    activationRules,
    contractVersion: INSTRUCTION_IR_CONTRACT_VERSION,
    documents,
    events: [],
    imports: [],
    nodes,
    recordKind: "agent-context-instruction-ir",
    sources,
    statements,
    targets: [],
  };
  const validation = validateInstructionIr(ir);
  if (!validation.ok) throw new Error(JSON.stringify(validation.issues));
  return {
    input: {
      contractVersion: "0.1.0",
      importResolutions: [],
      ir: validation.value,
      recordKind: "agent-context-document-context-rule-input",
    },
    statements,
  };
}

function addImport(
  fixture: BuiltFixture,
  documentIndex: number,
  targetSourceIndex: number,
): BuiltFixture {
  const ir = structuredClone(fixture.input.ir);
  const document = ir.documents[documentIndex];
  const statement = ir.statements.find((entry) => entry.documentId === document?.id);
  if (document === undefined || statement === undefined)
    throw new Error("missing import fixture node");
  const importNodeId = statement.nodeIds[0];
  if (importNodeId === undefined) throw new Error("missing import fixture node ID");
  const reference: ImportReference = {
    documentId: document.id,
    id: `import:${String(documentIndex)}` as ImportReference["id"],
    kind: "vendor-import",
    nodeId: importNodeId,
    range: statement.range,
    rawSpecifier: statement.text,
    specifierRange: statement.range,
    state: "recognized",
    targetKind: "repository-path-candidate",
    uncertainty: { state: "known" },
  };
  (ir.imports as ImportReference[]).push(reference);
  (document.importIds as ImportReference["id"][]).push(reference.id);
  const validation = validateInstructionIr(ir);
  if (!validation.ok) throw new Error(JSON.stringify(validation.issues));
  const targetSource = ir.sources[targetSourceIndex];
  if (targetSource === undefined) throw new Error("missing target source");
  return {
    input: {
      ...fixture.input,
      importResolutions: [
        {
          importId: reference.id,
          provenance: {
            collectorId: "fixture:import-resolver",
            factId: `fixture:import:${String(documentIndex)}`,
            valueDigest: createHash("sha256")
              .update(`${reference.id}:${targetSource.id}`)
              .digest("hex"),
          },
          targetSourceId: targetSource.id,
        },
      ],
      ir: validation.value,
    },
    statements: fixture.statements,
  };
}

function resultOf(
  fixture: BuiltFixture,
  options: Record<string, number>,
): Extract<ReturnType<typeof evaluateDocumentContextRules>, { readonly ok: true }> {
  const result = evaluateDocumentContextRules(fixture.input, options);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result;
}

describe("F10 document context rules", () => {
  test("emits ACL350 through ACL354 from real G02/F03/F04 evidence", () => {
    const longRequirements = `${"Run the focused tests and record the deterministic output. ".repeat(8)}Ensure the documentation describes the contract and boundaries. ${"Maintain exact provenance for every result. ".repeat(8)}`;
    const fixture = buildFixture([
      {
        path: "AGENTS.md",
        text: `${"always-on context ".repeat(10)}\n\n\`\`\`ts\n${"const value = 1;\n".repeat(8)}\`\`\`\n\nFollow best practices.\n\n${longRequirements}\n\nThis repository is written in TypeScript.`,
      },
      { path: "nested/AGENTS.md", text: "This repository is written in TypeScript." },
    ]);
    const result = resultOf(fixture, {
      largeCodeBlockTokens: 5,
      longInstructionTokens: 12,
      maxAlwaysOnTokens: 5,
      maximumImportExpansionBasisPoints: 20_000,
      minimumImportedTokens: 1,
    });
    const rules = new Set(result.bundle.diagnostics.map((diagnostic) => diagnostic.ruleId));
    expect(rules).toEqual(new Set(["ACL350", "ACL351", "ACL352", "ACL353", "ACL354"]));
    expect(result.duplicationIndex.exactClusters).toHaveLength(1);
    expect(result.metrics).toMatchObject({
      budgetScope: DOCUMENT_CONTEXT_BUDGET_SCOPE,
      duplicationExactClusterCount: 1,
      tokenizer: { measurement: "estimate" },
    });
    expect(validateDiagnosticBundle(result.bundle, result.sources).ok).toBe(true);
    expect(JSON.stringify(result.bundle)).not.toMatch(/ACL55[01]/u);
  });

  test("emits ACL355 only for explicit direct import amplification with exact provenance", () => {
    const fixture = addImport(
      buildFixture([
        { path: "AGENTS.md", text: "guide.md" },
        { always: false, path: "guide.md", text: "Imported policy. ".repeat(40) },
      ]),
      0,
      1,
    );
    const result = resultOf(fixture, {
      maximumImportExpansionBasisPoints: 20_000,
      minimumImportedTokens: 2,
    });
    const diagnostic = result.bundle.diagnostics.find((entry) => entry.ruleId === "ACL355");
    expect(diagnostic?.severity).toBe("warning");
    expect(diagnostic?.message).toContain("Direct imports expand estimated document context");
    expect(diagnostic?.related.map((evidence) => evidence.kind)).toEqual([
      "repository-fact",
      "repository-fact",
      "source",
    ]);
    expect(result.metrics.budgetScope).toBe("raw-always-on-document");
    expect(result.bundle.diagnostics.some((entry) => entry.ruleId === "ACL550")).toBe(false);
  });

  test("keeps ACL353 identities unique for identical long instructions in different documents", () => {
    const text = "Run tests. Ensure documentation is current. ".repeat(24);
    const result = resultOf(
      buildFixture([
        { always: false, path: "AGENTS.md", text },
        { always: false, path: "nested/AGENTS.md", text },
      ]),
      { longInstructionTokens: 1 },
    );
    const diagnostics = result.bundle.diagnostics.filter((entry) => entry.ruleId === "ACL353");
    expect(diagnostics).toHaveLength(2);
    expect(new Set(diagnostics.map((entry) => entry.id))).toHaveLength(2);
    expect(new Set(diagnostics.map((entry) => entry.fingerprints.semantic.value))).toHaveLength(2);
  });

  test("emits ACL353 once when one statement repeats the same requirement signal", () => {
    const text = "Run tests. Ensure documentation is current. ".repeat(24);
    const result = resultOf(buildFixture([{ always: false, path: "AGENTS.md", text }]), {
      longInstructionTokens: 1,
    });
    expect(result.bundle.diagnostics.filter((entry) => entry.ruleId === "ACL353")).toHaveLength(1);
  });

  test("honors strict threshold boundaries and conservative negative predicates", () => {
    const fixture = addImport(
      buildFixture([
        {
          always: false,
          path: "AGENTS.md",
          text: "Run pnpm test.\n\nOne long descriptive sentence without another requirement signal.\n\nFollow best practices for TypeScript.\n\nThis repository is written in Rust.",
        },
        { always: false, path: "guide.md", text: "abcd" },
      ]),
      0,
      1,
    );
    const result = resultOf(fixture, {
      largeCodeBlockTokens: 1,
      longInstructionTokens: 1,
      maxAlwaysOnTokens: 1,
      maximumImportExpansionBasisPoints: 1_000_000,
      minimumImportedTokens: 1,
    });
    expect(result.bundle.diagnostics).toEqual([]);

    const exactBudget = resultOf(buildFixture([{ path: "AGENTS.md", text: "abcd" }]), {
      maxAlwaysOnTokens: 1,
    });
    expect(exactBudget.bundle.diagnostics.some((entry) => entry.ruleId === "ACL350")).toBe(false);

    const exactBlock = resultOf(buildFixture([{ path: "AGENTS.md", text: "```\na\n```" }]), {
      largeCodeBlockTokens: 3,
      maxAlwaysOnTokens: 1_000,
    });
    expect(exactBlock.bundle.diagnostics.some((entry) => entry.ruleId === "ACL351")).toBe(false);

    const twoRequirements = "Run tests. Ensure documentation is current.";
    const exactLongCount = countEstimatedTokens(twoRequirements);
    if (!exactLongCount.ok) throw new Error(JSON.stringify(exactLongCount.issues));
    const exactLong = resultOf(buildFixture([{ path: "AGENTS.md", text: twoRequirements }]), {
      longInstructionTokens: exactLongCount.value.tokens,
      maxAlwaysOnTokens: 1_000,
    });
    expect(exactLong.bundle.diagnostics.some((entry) => entry.ruleId === "ACL353")).toBe(false);

    const exactExpansion = resultOf(
      addImport(
        buildFixture([
          { always: false, path: "AGENTS.md", text: "abcd" },
          { always: false, path: "target.md", text: "abcd" },
        ]),
        0,
        1,
      ),
      { maximumImportExpansionBasisPoints: 20_000, minimumImportedTokens: 1 },
    );
    expect(exactExpansion.bundle.diagnostics.some((entry) => entry.ruleId === "ACL355")).toBe(
      false,
    );
  });

  test("is deterministic across import-resolution order and never mutates inputs", () => {
    const base = buildFixture([
      { path: "AGENTS.md", text: "a.md" },
      { always: false, path: "a.md", text: "A".repeat(80) },
      { always: false, path: "b.md", text: "B".repeat(80) },
    ]);
    const first = addImport(base, 0, 1);
    const ir = structuredClone(first.input.ir);
    const document = ir.documents[0];
    const statement = ir.statements[0];
    if (document === undefined || statement === undefined) throw new Error("missing fixture");
    const firstReference = ir.imports[0];
    if (firstReference === undefined) throw new Error("missing first import");
    const secondReference: ImportReference = {
      ...firstReference,
      id: "import:second" as ImportReference["id"],
    };
    (ir.imports as ImportReference[]).push(secondReference);
    (document.importIds as ImportReference["id"][]).push(secondReference.id);
    const validated = validateInstructionIr(ir);
    if (!validated.ok) throw new Error(JSON.stringify(validated.issues));
    const secondResolution: DocumentImportResolution = {
      importId: secondReference.id,
      provenance: {
        collectorId: "fixture:import-resolver",
        factId: "fixture:import:second",
        valueDigest: createHash("sha256").update("second").digest("hex"),
      },
      targetSourceId: ir.sources[2]?.id ?? "missing",
    };
    const input = {
      ...first.input,
      importResolutions: [...first.input.importResolutions, secondResolution],
      ir: validated.value,
    };
    const before = structuredClone(input);
    const forward = evaluateDocumentContextRules(input, { minimumImportedTokens: 1 });
    const reverse = evaluateDocumentContextRules(
      { ...input, importResolutions: [...input.importResolutions].reverse() },
      { minimumImportedTokens: 1 },
    );
    expect(forward).toEqual(reverse);
    expect(input).toEqual(before);
    expect(Object.isFrozen(forward)).toBe(true);
  });

  test("fails closed for malformed, hostile, unknown, and resource-exhausting input", () => {
    expect(evaluateDocumentContextRules(null)).toMatchObject({
      issues: [{ code: "invalid-input", path: "$" }],
      ok: false,
    });
    expect(
      evaluateDocumentContextRules({
        contractVersion: "0.1.0",
        importResolutions: [],
        ir: {},
        recordKind: "agent-context-document-context-rule-input",
        unexpectedAuthority: true,
      }),
    ).toMatchObject({ ok: false });
    expect(
      evaluateDocumentContextRules(buildFixture([{ path: "AGENTS.md", text: "policy" }]).input, {
        maxAlwaysOnTokens: DOCUMENT_CONTEXT_HARD_MAXIMUM_THRESHOLD + 1,
      }),
    ).toMatchObject({ issues: [{ code: "invalid-options" }], ok: false });

    let getterCalls = 0;
    const hostile = Object.defineProperty({}, "contractVersion", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return "0.1.0";
      },
    });
    expect(() => evaluateDocumentContextRules(hostile)).not.toThrow();
    expect(getterCalls).toBe(0);
    const proxy = new Proxy(
      {},
      {
        ownKeys: (): never => {
          throw new Error("must not run");
        },
      },
    );
    expect(nodeTypes.isProxy(proxy)).toBe(true);
    expect(() => evaluateDocumentContextRules(proxy)).not.toThrow();

    const fixture = addImport(
      buildFixture([
        { path: "AGENTS.md", text: "x" },
        { always: false, path: "target.md", text: "target" },
      ]),
      0,
      1,
    );
    const forged = structuredClone(fixture.input);
    (forged.importResolutions[0] as { targetSourceId: string }).targetSourceId = "source:missing";
    expect(evaluateDocumentContextRules(forged)).toMatchObject({
      issues: [{ code: "invalid-input" }],
      ok: false,
    });

    const crowdedIr = structuredClone(fixture.input.ir);
    const crowdedDocument = crowdedIr.documents[0];
    const templateImport = crowdedIr.imports[0];
    if (crowdedDocument === undefined || templateImport === undefined)
      throw new Error("missing crowded import fixture");
    const crowdedImports = Array.from(
      { length: DOCUMENT_CONTEXT_MAX_IMPORTS_PER_DOCUMENT + 1 },
      (_, index): ImportReference => ({
        ...templateImport,
        id: `import:crowded-${String(index).padStart(3, "0")}` as ImportReference["id"],
      }),
    );
    (crowdedIr as unknown as { imports: ImportReference[] }).imports = crowdedImports;
    (crowdedDocument as unknown as { importIds: ImportReference["id"][] }).importIds =
      crowdedImports.map((entry) => entry.id);
    const crowdedValidation = validateInstructionIr(crowdedIr);
    if (!crowdedValidation.ok) throw new Error(JSON.stringify(crowdedValidation.issues));
    const crowdedResolutions = crowdedImports.map((entry, index): DocumentImportResolution => ({
      importId: entry.id,
      provenance: {
        collectorId: "fixture:import-resolver",
        factId: `fixture:crowded:${String(index)}`,
        valueDigest: createHash("sha256").update(entry.id).digest("hex"),
      },
      targetSourceId: crowdedIr.sources[1]?.id ?? "missing",
    }));
    expect(
      evaluateDocumentContextRules({
        ...fixture.input,
        importResolutions: crowdedResolutions,
        ir: crowdedValidation.value,
      }),
    ).toMatchObject({ issues: [{ code: "resource-limit" }], ok: false });
  });

  test("validates every closed input layer without invoking hostile authority", () => {
    const fixture = addImport(
      buildFixture([
        { path: "AGENTS.md", text: "target" },
        { always: false, path: "target.md", text: "target content" },
      ]),
      0,
      1,
    );
    const expectFailure = (input: unknown, options?: unknown): void => {
      expect(evaluateDocumentContextRules(input, options)).toMatchObject({ ok: false });
    };

    for (const options of [null, [], new Proxy({}, {}), { unknown: 1 }, { maxAlwaysOnTokens: 0 }])
      expectFailure(fixture.input, options);
    expectFailure(fixture.input, Object.create({ maxAlwaysOnTokens: 1 }));
    const optionAccessor = Object.defineProperty({}, "maxAlwaysOnTokens", {
      enumerable: true,
      get: (): number => 1,
    });
    expectFailure(fixture.input, optionAccessor);
    const optionSymbol = { maxAlwaysOnTokens: 1 };
    Object.defineProperty(optionSymbol, Symbol("authority"), { value: true });
    expectFailure(fixture.input, optionSymbol);

    expectFailure({ ...fixture.input, recordKind: "wrong" });
    expectFailure(Object.assign(Object.create({}), fixture.input));
    const hiddenRoot = { ...fixture.input };
    Object.defineProperty(hiddenRoot, "recordKind", {
      enumerable: false,
      value: fixture.input.recordKind,
    });
    expectFailure(hiddenRoot);

    for (const importResolutions of [null, {}, new Proxy([], {})])
      expectFailure({ ...fixture.input, importResolutions });
    const inheritedArray = [...fixture.input.importResolutions];
    const foreignArrayPrototype: object = {};
    Reflect.setPrototypeOf(inheritedArray, foreignArrayPrototype);
    expectFailure({ ...fixture.input, importResolutions: inheritedArray });
    const sparse: unknown[] = [];
    sparse.length = 1;
    expectFailure({ ...fixture.input, importResolutions: sparse });
    const extraArrayField = [...fixture.input.importResolutions];
    Object.defineProperty(extraArrayField, "authority", { value: true });
    expectFailure({ ...fixture.input, importResolutions: extraArrayField });
    let arrayGetterCalls = 0;
    const accessorArray: unknown[] = [];
    Object.defineProperty(accessorArray, "0", {
      enumerable: true,
      get: (): never => {
        arrayGetterCalls += 1;
        throw new Error("must not run");
      },
    });
    accessorArray.length = 1;
    expectFailure({ ...fixture.input, importResolutions: accessorArray });
    expect(arrayGetterCalls).toBe(0);

    const valid = fixture.input.importResolutions[0];
    if (valid === undefined) throw new Error("missing valid import resolution");
    expect(evaluateDocumentContextRules({ ...fixture.input, ir: {} })).toMatchObject({
      issues: [{ code: "invalid-input", path: "$.ir" }],
      ok: false,
    });
    expectFailure({
      ...fixture.input,
      importResolutions: Array.from({ length: 100_001 }, () => valid),
    });
    const malformedEntries: unknown[] = [
      null,
      { ...valid, importId: "not stable" },
      { ...valid, targetSourceId: "not stable" },
      { ...valid, provenance: null },
      { ...valid, provenance: { ...valid.provenance, collectorId: "not stable" } },
      { ...valid, provenance: { ...valid.provenance, factId: "not stable" } },
      { ...valid, provenance: { ...valid.provenance, valueDigest: 1 } },
      { ...valid, provenance: { ...valid.provenance, valueDigest: "0".repeat(63) } },
    ];
    for (const entry of malformedEntries)
      expectFailure({ ...fixture.input, importResolutions: [entry] });
    expectFailure({ ...fixture.input, importResolutions: [valid, structuredClone(valid)] });
    expectFailure({
      ...fixture.input,
      importResolutions: [{ ...valid, importId: "import:unknown" }],
    });

    let coercionCalls = 0;
    const hostileDigest = {
      toString: (): string => {
        coercionCalls += 1;
        return "0".repeat(64);
      },
    };
    expectFailure({
      ...fixture.input,
      importResolutions: [
        { ...valid, provenance: { ...valid.provenance, valueDigest: hostileDigest } },
      ],
    });
    expect(coercionCalls).toBe(0);

    const tooLong = buildFixture([{ path: "AGENTS.md", text: `Run ${"x".repeat(70_000)}` }]);
    expect(evaluateDocumentContextRules(tooLong.input)).toMatchObject({
      issues: [{ code: "resource-limit" }],
      ok: false,
    });
  });

  test("orders amplification for multiple documents and retains the minimum-import gate", () => {
    const base = buildFixture([
      { always: false, path: "a.md", text: "x" },
      { always: false, path: "b.md", text: "y" },
      { always: false, path: "target.md", text: "imported policy ".repeat(20) },
    ]);
    const first = addImport(base, 0, 2);
    const second = addImport(first, 1, 2);
    const firstResolution = first.input.importResolutions[0];
    const secondResolution = second.input.importResolutions[0];
    if (firstResolution === undefined || secondResolution === undefined)
      throw new Error("missing multi-document import resolutions");
    const input = {
      ...second.input,
      importResolutions: [secondResolution, firstResolution],
    };
    const combined: BuiltFixture = { input, statements: base.statements };
    const amplified = resultOf(combined, { minimumImportedTokens: 1 });
    expect(
      amplified.bundle.diagnostics.filter((diagnostic) => diagnostic.ruleId === "ACL355"),
    ).toHaveLength(2);

    const gated = resultOf(combined, { minimumImportedTokens: 1_000 });
    expect(gated.bundle.diagnostics.some((diagnostic) => diagnostic.ruleId === "ACL355")).toBe(
      false,
    );
  });
});
