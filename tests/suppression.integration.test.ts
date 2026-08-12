import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";

import { describe, expect, test, vi } from "vitest";

import {
  DIAGNOSTIC_CONTRACT_VERSION,
  INSTRUCTION_IR_CONTRACT_VERSION,
  PATH_FINGERPRINT_METHOD,
  SEMANTIC_FINGERPRINT_METHOD,
  computePathFingerprint,
  computeSemanticFingerprint,
  validateDiagnosticBundle,
  validateInstructionIr,
} from "../packages/core/dist/index.js";
import type {
  AstNode,
  Diagnostic,
  DiagnosticBundle,
  DiagnosticId,
  DiagnosticSourceLocation,
  InstructionIr,
  RepositoryRelativePath,
  SourceDocument,
  SourceDocumentId,
  SourcePosition,
} from "../packages/core/dist/index.js";

import { parseMarkdown } from "../packages/markdown/src/index.js";
import {
  DEFAULT_SUPPRESSION_LIMITS,
  SUPPRESSION_PROCESSOR_RESOURCE_LIMITS,
  SuppressionProcessorError,
  matchSuppressionDirectives,
  parseSuppressionDirectives,
} from "../packages/syntax/src/index.js";
import type {
  ParsedSuppressionDirective,
  SuppressionOptions,
} from "../packages/syntax/src/index.js";

function lineEndingOf(text: string): SourceDocument["lineEnding"] {
  const forms = new Set<string>();
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\r" && text[index + 1] === "\n") {
      forms.add("crlf");
      index += 1;
    } else if (text[index] === "\r") forms.add("cr");
    else if (text[index] === "\n") forms.add("lf");
  }
  if (forms.size === 0) return "none";
  if (forms.size > 1) return "mixed";
  return [...forms][0] as SourceDocument["lineEnding"];
}

function sourceAndNodes(
  text: string,
  path = "AGENTS.md",
): { readonly nodes: readonly AstNode[]; readonly source: SourceDocument } {
  const sourceId = `source:${path}` as SourceDocumentId;
  const parsed = parseMarkdown({ sourceId, text });
  return {
    nodes: parsed.nodes,
    source: {
      id: sourceId,
      path: path as RepositoryRelativePath,
      encoding: "utf-8",
      bom: text.startsWith("\uFEFF") ? "utf-8" : "none",
      text,
      byteLength: Buffer.byteLength(text, "utf8"),
      utf16Length: text.length,
      sha256: createHash("sha256").update(text).digest("hex"),
      lineEnding: lineEndingOf(text),
      parseState: parsed.parseState,
      rootNodeId: parsed.rootNodeId,
    },
  };
}

function irOf(text: string, path?: string): InstructionIr {
  const value = sourceAndNodes(text, path);
  const ir: InstructionIr = {
    recordKind: "agent-context-instruction-ir",
    contractVersion: INSTRUCTION_IR_CONTRACT_VERSION,
    sources: [value.source],
    documents: [],
    nodes: value.nodes,
    imports: [],
    statements: [],
    activationRules: [],
    targets: [],
    events: [],
  };
  const validation = validateInstructionIr(ir);
  if (!validation.ok) throw new Error(JSON.stringify(validation.issues));
  return validation.value;
}

function combineIr(...entries: readonly InstructionIr[]): InstructionIr {
  const ir: InstructionIr = {
    recordKind: "agent-context-instruction-ir",
    contractVersion: INSTRUCTION_IR_CONTRACT_VERSION,
    sources: entries.flatMap((entry) => entry.sources),
    documents: [],
    nodes: entries.flatMap((entry) => entry.nodes),
    imports: [],
    statements: [],
    activationRules: [],
    targets: [],
    events: [],
  };
  const validation = validateInstructionIr(ir);
  if (!validation.ok) throw new Error(JSON.stringify(validation.issues));
  return validation.value;
}

function relabelNodeAsHtmlComment(
  input: InstructionIr,
  text: string,
  originalKind: AstNode["kind"],
): InstructionIr {
  const ir = structuredClone(input);
  const nodeIndex = ir.nodes.findIndex((node) => node.kind === originalKind);
  const original = ir.nodes[nodeIndex];
  if (nodeIndex < 0 || original === undefined) {
    throw new Error(`missing ${originalKind} node`);
  }
  const start = text.indexOf("<!--");
  const end = text.indexOf("-->", start) + 3;
  if (start < 0 || end < 3) throw new Error("missing comment lexeme");
  (ir.nodes as AstNode[])[nodeIndex] = {
    id: original.id,
    sourceId: original.sourceId,
    childIds: [],
    kind: "html-comment",
    range: {
      sourceId: original.sourceId,
      start: positionAt(text, start),
      end: positionAt(text, end),
    },
  };
  const validation = validateInstructionIr(ir);
  if (!validation.ok) throw new Error(JSON.stringify(validation.issues));
  return validation.value;
}

function replaceOnlySourceText(input: InstructionIr, text: string): InstructionIr {
  const ir = structuredClone(input);
  const source = ir.sources[0];
  if (source === undefined || ir.sources.length !== 1) throw new Error("expected one source");
  const rootIndex = ir.nodes.findIndex((node) => node.id === source.rootNodeId);
  const root = ir.nodes[rootIndex];
  if (rootIndex < 0 || root === undefined) throw new Error("missing source root");
  (ir.sources as SourceDocument[])[0] = {
    ...source,
    bom: text.startsWith("\uFEFF") ? "utf-8" : "none",
    byteLength: Buffer.byteLength(text, "utf8"),
    lineEnding: lineEndingOf(text),
    sha256: createHash("sha256").update(text).digest("hex"),
    text,
    utf16Length: text.length,
  };
  (ir.nodes as AstNode[])[rootIndex] = {
    ...root,
    range: { ...root.range, end: positionAt(text, text.length) },
  };
  const validation = validateInstructionIr(ir);
  if (!validation.ok) throw new Error(JSON.stringify(validation.issues));
  return validation.value;
}

function validateForgedIr(input: InstructionIr): InstructionIr {
  const validation = validateInstructionIr(input);
  if (!validation.ok) throw new Error(JSON.stringify(validation.issues));
  return validation.value;
}

function asciiPosition(offset: number): SourcePosition {
  return { byteOffset: offset, line: 0, utf16Column: offset, utf16Offset: offset };
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

function diagnostic(
  directive: ParsedSuppressionDirective,
  index: number,
  options: {
    readonly primary?: DiagnosticSourceLocation;
    readonly profileIds?: readonly string[];
    readonly ruleId?: string;
  } = {},
): Diagnostic {
  const source = directive.target;
  const ruleId = options.ruleId ?? "ACL250";
  const profileIds = options.profileIds ?? ["codex-cli"];
  const anchor = `finding:${String(index)}`;
  const pathBasis = { anchor, profileIds } as const;
  const semanticBasis = {
    components: [{ key: "finding", value: String(index) }],
    profileIds,
  } as const;
  const primary = options.primary ?? source;
  return {
    id: `diagnostic:${String(index)}` as DiagnosticId,
    ruleId,
    ruleVersion: "1.0.0",
    severity: "warning",
    message: `Diagnostic ${String(index)}`,
    primary,
    related: [],
    suggestion: null,
    fingerprintBasis: { path: pathBasis, semantic: semanticBasis },
    fingerprints: {
      path: {
        method: PATH_FINGERPRINT_METHOD,
        value: computePathFingerprint({
          ruleId,
          ruleVersion: "1.0.0",
          path: primary.path,
          basis: pathBasis,
        }),
      },
      semantic: {
        method: SEMANTIC_FINGERPRINT_METHOD,
        value: computeSemanticFingerprint({
          ruleId,
          ruleVersion: "1.0.0",
          basis: semanticBasis,
        }),
      },
    },
  };
}

function bundleOf(
  directives: readonly ParsedSuppressionDirective[],
  diagnostics: readonly Diagnostic[],
): DiagnosticBundle {
  return {
    recordKind: "agent-context-diagnostics",
    contractVersion: DIAGNOSTIC_CONTRACT_VERSION,
    diagnostics,
    suppressions: directives.map((directive) => directive.record),
  };
}

function locationForLine(source: SourceDocument, lineNumber: number): DiagnosticSourceLocation {
  let currentLine = 0;
  let lineStart = 0;
  for (let index = 0; index <= source.text.length; index += 1) {
    const char = source.text[index];
    const atEnd = index === source.text.length;
    if (atEnd || char === "\r" || char === "\n") {
      if (currentLine === lineNumber) {
        return {
          sourceId: source.id,
          path: source.path,
          sourceDigest: source.sha256,
          range: {
            sourceId: source.id,
            start: positionAt(source.text, lineStart),
            end: positionAt(source.text, index),
          },
        };
      }
      if (char === "\r" && source.text[index + 1] === "\n") index += 1;
      currentLine += 1;
      lineStart = index + 1;
    }
  }
  throw new Error(`line ${String(lineNumber)} is absent`);
}

function expectProcessorError(
  operation: () => unknown,
  code: SuppressionProcessorError["code"],
): void {
  try {
    operation();
    throw new Error("expected suppression error");
  } catch (error) {
    expect(error).toBeInstanceOf(SuppressionProcessorError);
    expect(error).toMatchObject({ code });
  }
}

describe("targeted suppression grammar", () => {
  test("parses one closed directive, canonicalizes rules, and attaches the next physical line", () => {
    const text = [
      "<!-- agent-context-lint-disable-next-line ACL300, ACL250 -- intentional -->",
      "😀 target",
      "after",
    ].join("\n");
    const ir = irOf(text);
    const result = parseSuppressionDirectives(ir);

    expect(result.issues).toEqual([]);
    expect(result.directives).toHaveLength(1);
    const directive = result.directives[0];
    expect(directive).toMatchObject({
      profileScope: "all-profiles",
      record: {
        reason: "intentional",
        state: "applicable",
        targetRuleIds: ["ACL250", "ACL300"],
      },
    });
    if (directive === undefined) throw new Error("missing directive");
    expect(
      text.slice(
        directive.record.directive.range.start.utf16Offset,
        directive.record.directive.range.end.utf16Offset,
      ),
    ).toBe("<!-- agent-context-lint-disable-next-line ACL300, ACL250 -- intentional -->");
    expect(
      text.slice(directive.target.range.start.utf16Offset, directive.target.range.end.utf16Offset),
    ).toBe("😀 target");
    expect(validateDiagnosticBundle(bundleOf(result.directives, []), ir.sources)).toMatchObject({
      ok: true,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.directives)).toBe(true);
    expect(Object.isFrozen(directive)).toBe(true);
  });

  test("supports optional reasons and enforces the explicit mandatory-reason policy", () => {
    const ir = irOf("<!-- agent-context-lint-disable-next-line ACL250 -->\ntarget");
    const optional = parseSuppressionDirectives(ir);
    expect(optional.issues).toEqual([]);
    expect(optional.directives[0]?.record.reason).toBeNull();

    const required = parseSuppressionDirectives(ir, { requireReason: true });
    expect(required.directives).toEqual([]);
    expect(required.issues).toEqual([expect.objectContaining({ code: "missing-reason" })]);
    expect(DEFAULT_SUPPRESSION_LIMITS).toEqual({
      maxCandidates: 1024,
      maxCommentBytes: 4096,
      maxIssues: 128,
      maxReasonBytes: 1024,
      maxRulesPerDirective: 64,
    });
    expect(Object.isFrozen(DEFAULT_SUPPRESSION_LIMITS)).toBe(true);
  });

  test("accepts CommonMark HTML-comment indentation without changing the parser range", () => {
    for (let spaces = 0; spaces <= 3; spaces += 1) {
      const prefix = " ".repeat(spaces);
      const text = `${prefix}<!-- agent-context-lint-disable-next-line ACL250 -->\ntarget`;
      const result = parseSuppressionDirectives(irOf(text));
      expect(result.issues, `indent=${String(spaces)}`).toEqual([]);
      expect(result.directives, `indent=${String(spaces)}`).toHaveLength(1);
      const range = result.directives[0]?.record.directive.range;
      expect(text.slice(range?.start.utf16Offset, range?.end.utf16Offset)).toBe(
        text.split("\n")[0],
      );
    }
  });

  test("keeps four-space and tab-indented comments inert as CommonMark code", () => {
    for (const prefix of ["    ", "\t"]) {
      const text = `${prefix}<!-- agent-context-lint-disable-next-line ACL250 -->\ntarget`;
      const ir = structuredClone(irOf(text));
      const result = parseSuppressionDirectives(ir);
      expect(result.directives).toEqual([]);
      expect(result.issues).toEqual([]);

      const codeIndex = ir.nodes.findIndex((node) => node.kind === "code-block");
      const code = ir.nodes[codeIndex];
      if (codeIndex < 0 || code === undefined) throw new Error("missing indented code block");
      (ir.nodes as AstNode[])[codeIndex] = {
        id: code.id,
        sourceId: code.sourceId,
        childIds: [],
        kind: "html-comment",
        range: code.range,
      };
      const forgedValidation = validateInstructionIr(ir);
      if (!forgedValidation.ok) throw new Error(JSON.stringify(forgedValidation.issues));
      expect(parseSuppressionDirectives(ir).directives).toEqual([]);
    }
  });

  test("recognizes real HTML comments in prose but keeps prose, inline code, and fences inert", () => {
    const text = [
      "agent-context-lint-disable-next-line ACL250",
      "",
      "`<!-- agent-context-lint-disable-next-line ACL250 -->`",
      "",
      "```md",
      "<!-- agent-context-lint-disable-next-line ACL250 -->",
      "```",
      "",
      "before <!-- agent-context-lint-disable-next-line ACL250 -- inline --> after",
      "target",
    ].join("\n");
    const result = parseSuppressionDirectives(irOf(text));
    expect(result.issues).toEqual([]);
    expect(result.directives).toHaveLength(1);
    const target = result.directives[0]?.target.range;
    expect(target?.start.line).toBe(9);
    expect(text.slice(target?.start.utf16Offset, target?.end.utf16Offset)).toBe("target");
  });

  test("derives frontmatter authority from the real source envelope, not C06 node labels", () => {
    const text = [
      "---",
      "description: fixture",
      "<!-- agent-context-lint-disable-next-line ACL250 -- inert metadata -->",
      "---",
      "body",
      "<!-- agent-context-lint-disable-next-line ACL250 -- active body -->",
      "target",
    ].join("\n");
    const ir = irOf(text);
    expect(
      ir.nodes.some((node) => node.kind === "html-comment" && node.range.start.line === 2),
    ).toBe(true);
    expect(ir.nodes.some((node) => node.kind === "frontmatter")).toBe(false);

    const result = parseSuppressionDirectives(ir);
    expect(result.issues).toEqual([]);
    expect(result.directives).toHaveLength(1);
    expect(result.directives[0]?.record.reason).toBe("active body");
    expect(result.directives[0]?.target.range.start.line).toBe(6);

    const unclosed = parseSuppressionDirectives(
      irOf(
        [
          "---",
          "description: unclosed",
          "<!-- agent-context-lint-disable-next-line ACL250 -->",
          "target",
        ].join("\n"),
      ),
    );
    expect(unclosed.directives).toEqual([]);
    expect(unclosed.issues).toEqual([]);
  });

  test("source verification denies forged B03 comments inside fenced code", () => {
    const text = [
      "```md",
      "<!-- agent-context-lint-disable-next-line ACL250 -- forged -->",
      "```",
      "target",
    ].join("\n");
    const parsed = structuredClone(irOf(text));
    const codeIndex = parsed.nodes.findIndex((node) => node.kind === "code-block");
    const original = parsed.nodes[codeIndex];
    if (codeIndex < 0 || original === undefined) throw new Error("missing code block");
    const start = text.indexOf("<!--");
    const end = text.indexOf("-->", start) + 3;
    (parsed.nodes as AstNode[])[codeIndex] = {
      id: original.id,
      sourceId: original.sourceId,
      childIds: [],
      kind: "html-comment",
      range: {
        sourceId: original.sourceId,
        start: positionAt(text, start),
        end: positionAt(text, end),
      },
    };
    const validation = validateInstructionIr(parsed);
    if (!validation.ok) throw new Error(JSON.stringify(validation.issues));

    const result = parseSuppressionDirectives(parsed);
    expect(result.directives).toEqual([]);
    expect(result.issues).toEqual([]);
  });

  test.each([
    [
      "blockquote-nested tilde fence",
      [
        "> ~~~md",
        "> <!-- agent-context-lint-disable-next-line ACL250 -- forged -->",
        "> ~~~",
        "target",
      ].join("\n"),
      "code-block",
    ],
    [
      "list-nested backtick fence",
      [
        "- ```md",
        "  <!-- agent-context-lint-disable-next-line ACL250 -- forged -->",
        "  ```",
        "target",
      ].join("\n"),
      "code-block",
    ],
    [
      "double-backtick span after an unmatched single run",
      "` unmatched ``<!-- agent-context-lint-disable-next-line ACL250 -- forged -->``\ntarget",
      "inline-code",
    ],
    [
      "backslash-escaped comment lexeme",
      "\\<!-- agent-context-lint-disable-next-line ACL250 -- forged -->\ntarget",
      "text",
    ],
  ] as const)("reparses source and denies a relabeled %s", (_name, text, originalKind) => {
    const forged = relabelNodeAsHtmlComment(irOf(text), text, originalKind);
    const result = parseSuppressionDirectives(forged);
    expect(result.directives).toEqual([]);
    expect(result.issues).toEqual([]);
  });

  test("keeps real HTML comments active inside ordinary CommonMark containers", () => {
    const text = [
      "> before <!-- agent-context-lint-disable-next-line ACL250 -- quoted --> after",
      "target",
    ].join("\n");
    const result = parseSuppressionDirectives(irOf(text));
    expect(result.issues).toEqual([]);
    expect(result.directives).toHaveLength(1);
    expect(result.directives[0]?.record.reason).toBe("quoted");
    expect(result.directives[0]?.target.range.start.line).toBe(1);
  });

  test.each([
    ["<!-- agent-context-lint-disable ACL250 -->\ntarget", "unknown-directive"],
    ["<!-- agent-context-lint-disable-next-line * -->\ntarget", "broad-rule"],
    ["<!-- agent-context-lint-disable-next-line all -->\ntarget", "broad-rule"],
    ["<!-- agent-context-lint-disable-next-line ACL* -->\ntarget", "broad-rule"],
    ["<!-- agent-context-lint-disable-next-line BAD250 -->\ntarget", "invalid-rule"],
    ["<!-- agent-context-lint-disable-next-line ACL250, ACL250 -->\ntarget", "duplicate-rule"],
    ["<!-- agent-context-lint-disable-next-line ACL250, -->\ntarget", "malformed-directive"],
    ["<!-- agent-context-lint-disable-next-line -->\ntarget", "malformed-directive"],
    ["<!-- prefix agent-context-lint-disable-next-line ACL250 -->\ntarget", "unknown-directive"],
    ["<!-- agent-context-lint-disable-next-line ACL250 --  -->\ntarget", "malformed-directive"],
    ["<!-- agent-context-lint-disable-next-line ACL250\n-->\ntarget", "malformed-directive"],
  ] as const)("rejects malformed or broad syntax without emitting policy: %s", (text, code) => {
    const result = parseSuppressionDirectives(irOf(text));
    expect(result.directives).toEqual([]);
    expect(result.issues).toEqual([expect.objectContaining({ code })]);
  });

  test("rejects unclosed and end-of-file directives without granting suppression authority", () => {
    const unclosed = parseSuppressionDirectives(
      irOf("<!-- agent-context-lint-disable-next-line ACL250\ntarget"),
    );
    expect(unclosed.directives).toEqual([]);
    expect(unclosed.issues).toEqual([expect.objectContaining({ code: "malformed-directive" })]);

    const eof = parseSuppressionDirectives(
      irOf("<!-- agent-context-lint-disable-next-line ACL250 -->"),
    );
    expect(eof.directives).toEqual([]);
    expect(eof.issues).toEqual([expect.objectContaining({ code: "missing-target-line" })]);
  });

  test("derives source-exact byte and UTF-16 ranges for BOM, astral Unicode, tabs, and CRLF", () => {
    const text =
      "\uFEFF<!-- agent-context-lint-disable-next-line ACL250 -- potrzebne -->\r\n\t😀 cel\r\nafter";
    const result = parseSuppressionDirectives(irOf(text));
    const directive = result.directives[0];
    if (directive === undefined) throw new Error(JSON.stringify(result.issues));
    const expectedStart = text.indexOf("\t😀");
    const expectedEnd = text.indexOf("\r\n", expectedStart);
    expect(directive.target.range).toEqual({
      sourceId: "source:AGENTS.md",
      start: positionAt(text, expectedStart),
      end: positionAt(text, expectedEnd),
    });
    expect(directive.target.range.start.byteOffset).not.toBe(
      directive.target.range.start.utf16Offset,
    );
  });

  test("sorts directives by source path and offset independent of IR collection order", () => {
    const root = irOf("<!-- agent-context-lint-disable-next-line ACL250 -->\na", "z.md");
    const nested = irOf("<!-- agent-context-lint-disable-next-line ACL250 -->\nb", "a.md");
    const combined = combineIr(root, nested);
    const reversed = {
      ...combined,
      sources: [...combined.sources].reverse(),
      nodes: [...combined.nodes].reverse(),
    };
    const result = parseSuppressionDirectives(reversed);
    expect(result.directives.map((entry) => entry.record.directive.path)).toEqual(["a.md", "z.md"]);
  });

  test("copies authority-bearing ranges so later IR mutation cannot retarget a directive", () => {
    const ir = structuredClone(
      irOf("<!-- agent-context-lint-disable-next-line ACL250 -->\ntarget"),
    );
    const parsed = parseSuppressionDirectives(ir);
    const before = structuredClone(parsed.directives[0]?.target);
    const comment = ir.nodes.find((node) => node.kind === "html-comment");
    if (comment === undefined) throw new Error("missing comment");
    (comment.range.start as { line: number }).line = 999;
    (comment.range.end as { utf16Offset: number }).utf16Offset = 0;
    expect(parsed.directives[0]?.target).toEqual(before);
    expect(Object.isFrozen(parsed.directives[0]?.target.range.start)).toBe(true);
  });
});

describe("suppression matching and unused detection", () => {
  test("matches exact owner source/rule/start-line across all profiles and leaves unrelated findings visible", () => {
    const ir = irOf(
      "<!-- agent-context-lint-disable-next-line ACL250 -- reviewed -->\ntarget\nafter",
    );
    const parsed = parseSuppressionDirectives(ir);
    const directive = parsed.directives[0];
    if (directive === undefined) throw new Error(JSON.stringify(parsed.issues));
    const source = ir.sources[0];
    if (source === undefined) throw new Error("missing source");
    const diagnostics = [
      diagnostic(directive, 1, { profileIds: ["codex-cli"] }),
      diagnostic(directive, 2, { profileIds: ["gemini-cli"] }),
      diagnostic(directive, 3, { ruleId: "ACL300" }),
      diagnostic(directive, 4, { primary: locationForLine(source, 2) }),
    ];
    const input = bundleOf(parsed.directives, diagnostics);
    expect(validateDiagnosticBundle(input, ir.sources)).toMatchObject({ ok: true });

    const result = matchSuppressionDirectives(input, parsed.directives, ir.sources);
    expect(result.suppressedDiagnostics.map((entry) => entry.diagnostic.id)).toEqual([
      "diagnostic:1",
      "diagnostic:2",
    ]);
    expect(result.visibleDiagnostics.map((entry) => entry.id)).toEqual([
      "diagnostic:3",
      "diagnostic:4",
    ]);
    expect(result.bundle.suppressions[0]).toMatchObject({
      state: "suppressed",
      matchedPathFingerprints: [
        diagnostics[0]?.fingerprints.path.value,
        diagnostics[1]?.fingerprints.path.value,
      ].sort(),
    });
    expect(validateDiagnosticBundle(result.bundle, ir.sources)).toMatchObject({ ok: true });
  });

  test("marks syntactically valid future rule IDs unused instead of treating them as broad", () => {
    const ir = irOf("<!-- agent-context-lint-disable-next-line ACL999 -->\ntarget");
    const parsed = parseSuppressionDirectives(ir);
    expect(parsed.issues).toEqual([]);
    const result = matchSuppressionDirectives(
      bundleOf(parsed.directives, []),
      parsed.directives,
      ir.sources,
    );
    expect(result.bundle.suppressions).toEqual([
      expect.objectContaining({ state: "unused", targetRuleIds: ["ACL999"] }),
    ]);
  });

  test("never crosses source ownership even when rule and line are identical", () => {
    const policy = irOf("<!-- agent-context-lint-disable-next-line ACL250 -->\ntarget", "a.md");
    const other = irOf("heading\ntarget", "b.md");
    const ir = combineIr(policy, other);
    const parsed = parseSuppressionDirectives(ir);
    const directive = parsed.directives[0];
    const otherSource = ir.sources.find((source) => source.path === "b.md");
    if (directive === undefined || otherSource === undefined) throw new Error("missing fixture");
    const finding = diagnostic(directive, 1, {
      primary: locationForLine(otherSource, 1),
    });
    const result = matchSuppressionDirectives(
      bundleOf(parsed.directives, [finding]),
      parsed.directives,
      ir.sources,
    );
    expect(result.visibleDiagnostics).toEqual([finding]);
    expect(result.bundle.suppressions[0]?.state).toBe("unused");
  });

  test("assigns a diagnostic to the first canonical duplicate and reports the other unused", () => {
    const ir = irOf(
      "x <!-- agent-context-lint-disable-next-line ACL250 --> y <!-- agent-context-lint-disable-next-line ACL250 -->\ntarget",
    );
    const parsed = parseSuppressionDirectives(ir);
    expect(parsed.directives).toHaveLength(2);
    const first = parsed.directives[0];
    if (first === undefined) throw new Error("missing directive");
    const result = matchSuppressionDirectives(
      bundleOf(parsed.directives, [diagnostic(first, 1)]),
      parsed.directives,
      ir.sources,
    );
    expect(result.bundle.suppressions.map((record) => record.state)).toEqual([
      "suppressed",
      "unused",
    ]);
  });

  test("rejects forged attachments, altered bundle records, and hostile bundle ingress", () => {
    const ir = irOf("<!-- agent-context-lint-disable-next-line ACL250 -->\ntarget");
    const parsed = parseSuppressionDirectives(ir);
    const directive = parsed.directives[0];
    if (directive === undefined) throw new Error("missing directive");
    const bundle = bundleOf(parsed.directives, [diagnostic(directive, 1)]);

    expectProcessorError(
      () =>
        matchSuppressionDirectives(
          bundle,
          parsed.directives.map((entry) => ({ ...entry })),
          ir.sources,
        ),
      "SUPPRESSION_INVALID_OWNERSHIP",
    );
    expectProcessorError(
      () =>
        matchSuppressionDirectives(
          { ...bundle, suppressions: [{ ...directive.record, reason: "forged" }] },
          parsed.directives,
          ir.sources,
        ),
      "SUPPRESSION_INVALID_OWNERSHIP",
    );
    expectProcessorError(
      () => matchSuppressionDirectives(new Proxy({}, {}), parsed.directives, ir.sources),
      "SUPPRESSION_INVALID_BUNDLE",
    );
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    expectProcessorError(
      () => matchSuppressionDirectives(revoked.proxy, parsed.directives, ir.sources),
      "SUPPRESSION_INVALID_BUNDLE",
    );
  });

  test("accepts semantically identical suppression records independent of JSON property order", () => {
    const ir = irOf("<!-- agent-context-lint-disable-next-line ACL250 -->\ntarget");
    const parsed = parseSuppressionDirectives(ir);
    const directive = parsed.directives[0];
    if (directive === undefined) throw new Error("missing directive");
    const record = directive.record;
    const reordered = {
      targetRuleIds: record.targetRuleIds,
      id: record.id,
      evidence: record.evidence,
      reason: record.reason,
      directive: record.directive,
      state: record.state,
      matchedPathFingerprints: record.matchedPathFingerprints,
    };
    const bundle = {
      ...bundleOf(parsed.directives, []),
      suppressions: [reordered],
    };
    expect(() => matchSuppressionDirectives(bundle, parsed.directives, ir.sources)).not.toThrow();
    expect(() =>
      matchSuppressionDirectives(bundle, [...parsed.directives], ir.sources),
    ).not.toThrow();
  });

  test("rejects missing bundle ownership and sparse directive arrays", () => {
    const ir = irOf("<!-- agent-context-lint-disable-next-line ACL250 -->\ntarget");
    const parsed = parseSuppressionDirectives(ir);
    expectProcessorError(
      () =>
        matchSuppressionDirectives(
          { ...bundleOf(parsed.directives, []), suppressions: [] },
          parsed.directives,
          ir.sources,
        ),
      "SUPPRESSION_INVALID_OWNERSHIP",
    );
    const sparse = [...parsed.directives] as unknown[];
    sparse.length = 2;
    expectProcessorError(
      () => matchSuppressionDirectives(bundleOf(parsed.directives, []), sparse, ir.sources),
      "SUPPRESSION_INVALID_OWNERSHIP",
    );
  });
});

describe("suppression adversarial and resource boundaries", () => {
  test("rejects forged valid B03 sources beyond either C06 source ceiling before reparsing", () => {
    const text = "<!-- agent-context-lint-disable-next-line ACL250 -->\ntarget";
    const exact = replaceOnlySourceText(
      irOf(text),
      text +
        " ".repeat(SUPPRESSION_PROCESSOR_RESOURCE_LIMITS.maxUtf16CodeUnitsPerSource - text.length),
    );
    expect(parseSuppressionDirectives(exact).directives).toHaveLength(1);

    const utf16Oversized = replaceOnlySourceText(
      irOf(text),
      text +
        " ".repeat(
          SUPPRESSION_PROCESSOR_RESOURCE_LIMITS.maxUtf16CodeUnitsPerSource - text.length + 1,
        ),
    );
    expectProcessorError(
      () => parseSuppressionDirectives(utf16Oversized),
      "SUPPRESSION_RESOURCE_LIMIT",
    );

    const remainingBytes =
      SUPPRESSION_PROCESSOR_RESOURCE_LIMITS.maxUtf8BytesPerSource - Buffer.byteLength(text, "utf8");
    const utf8Oversized = replaceOnlySourceText(
      irOf(text),
      text + "é".repeat(Math.floor(remainingBytes / 2) + 1),
    );
    expect(utf8Oversized.sources[0]?.utf16Length).toBeLessThanOrEqual(
      SUPPRESSION_PROCESSOR_RESOURCE_LIMITS.maxUtf16CodeUnitsPerSource,
    );
    expectProcessorError(
      () => parseSuppressionDirectives(utf8Oversized),
      "SUPPRESSION_RESOURCE_LIMIT",
    );
  });

  test("caps potential HTML-comment nodes before candidate collection and sorting", () => {
    const text = Array.from(
      { length: DEFAULT_SUPPRESSION_LIMITS.maxCandidates + 1 },
      () => "<!-- inert candidate -->",
    ).join("\n");
    const ir = irOf(text);
    expect(ir.nodes.filter((node) => node.kind === "html-comment")).toHaveLength(
      DEFAULT_SUPPRESSION_LIMITS.maxCandidates + 1,
    );
    expectProcessorError(() => parseSuppressionDirectives(ir), "SUPPRESSION_RESOURCE_LIMIT");
  });

  test("caps source and node collections before building suppression indexes", () => {
    const emptyDigest = createHash("sha256").update("").digest("hex");
    const sources = Array.from(
      { length: SUPPRESSION_PROCESSOR_RESOURCE_LIMITS.maxSources + 1 },
      (_, index): SourceDocument => {
        const sourceId = `source:many:${String(index)}` as SourceDocumentId;
        return {
          id: sourceId,
          path: `many/${String(index)}.md` as RepositoryRelativePath,
          encoding: "utf-8",
          bom: "none",
          text: "",
          byteLength: 0,
          utf16Length: 0,
          sha256: emptyDigest,
          lineEnding: "none",
          parseState: { state: "complete" },
          rootNodeId: `ast:many:${String(index)}` as SourceDocument["rootNodeId"],
        };
      },
    );
    const sourceRoots = sources.map((source): AstNode => ({
      id: source.rootNodeId,
      sourceId: source.id,
      childIds: [],
      kind: "root",
      range: {
        sourceId: source.id,
        start: asciiPosition(0),
        end: asciiPosition(0),
      },
    }));
    const manySources = validateForgedIr({
      ...irOf(""),
      sources,
      nodes: sourceRoots,
    });
    expectProcessorError(
      () => parseSuppressionDirectives(manySources),
      "SUPPRESSION_RESOURCE_LIMIT",
    );

    const text = "x".repeat(SUPPRESSION_PROCESSOR_RESOURCE_LIMITS.maxNodes);
    const sourceId = "source:many-nodes" as SourceDocumentId;
    const rootId = "ast:many-nodes:root" as SourceDocument["rootNodeId"];
    const childIds = Array.from(
      { length: SUPPRESSION_PROCESSOR_RESOURCE_LIMITS.maxNodes },
      (_, index) => `ast:many-nodes:${String(index)}` as AstNode["id"],
    );
    const manyNodes = validateForgedIr({
      ...irOf(""),
      sources: [
        {
          id: sourceId,
          path: "many-nodes.md" as RepositoryRelativePath,
          encoding: "utf-8",
          bom: "none",
          text,
          byteLength: text.length,
          utf16Length: text.length,
          sha256: createHash("sha256").update(text).digest("hex"),
          lineEnding: "none",
          parseState: { state: "complete" },
          rootNodeId: rootId,
        },
      ],
      nodes: [
        {
          id: rootId,
          sourceId,
          childIds,
          kind: "root",
          range: {
            sourceId,
            start: asciiPosition(0),
            end: asciiPosition(text.length),
          },
        },
        ...childIds.map((id, index): AstNode => ({
          id,
          sourceId,
          childIds: [],
          kind: "text",
          range: {
            sourceId,
            start: asciiPosition(index),
            end: asciiPosition(index + 1),
          },
        })),
      ],
    });
    expectProcessorError(() => parseSuppressionDirectives(manyNodes), "SUPPRESSION_RESOURCE_LIMIT");
  });

  test("rejects proxy, revoked proxy, accessor, unknown, and invalid options without invoking code", () => {
    const ir = irOf("text");
    const getter = vi.fn(() => true);
    const options = Object.defineProperty({}, "requireReason", {
      enumerable: true,
      get: getter,
    });
    expectProcessorError(
      () => parseSuppressionDirectives(ir, options),
      "SUPPRESSION_INVALID_OPTIONS",
    );
    expect(getter).not.toHaveBeenCalled();
    expectProcessorError(
      () => parseSuppressionDirectives(ir, new Proxy({}, {})),
      "SUPPRESSION_INVALID_OPTIONS",
    );
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    expect(nodeTypes.isProxy(revoked.proxy)).toBe(true);
    expectProcessorError(
      () => parseSuppressionDirectives(ir, revoked.proxy),
      "SUPPRESSION_INVALID_OPTIONS",
    );
    expectProcessorError(
      () => parseSuppressionDirectives(ir, { unknown: true } as never),
      "SUPPRESSION_INVALID_OPTIONS",
    );
    expectProcessorError(
      () => parseSuppressionDirectives(ir, { maxIssues: 0 }),
      "SUPPRESSION_INVALID_OPTIONS",
    );
  });

  test("rejects inherited policy while accepting an explicit null-prototype option record", () => {
    const ir = irOf("<!-- agent-context-lint-disable-next-line ACL250 -->\ntarget");
    const inherited = Object.create({ requireReason: true }) as SuppressionOptions;
    expectProcessorError(
      () => parseSuppressionDirectives(ir, inherited),
      "SUPPRESSION_INVALID_OPTIONS",
    );

    class PolicyOptions {
      public readonly requireReason = true;
    }
    expectProcessorError(
      () => parseSuppressionDirectives(ir, new PolicyOptions()),
      "SUPPRESSION_INVALID_OPTIONS",
    );

    const explicit = Object.create(null) as { requireReason?: boolean };
    explicit.requireReason = true;
    const result = parseSuppressionDirectives(ir, explicit);
    expect(result.directives).toEqual([]);
    expect(result.issues).toEqual([expect.objectContaining({ code: "missing-reason" })]);
  });

  test("fails closed on proxy, deep, and huge sparse IR values", () => {
    expectProcessorError(
      () => parseSuppressionDirectives(new Proxy({}, {})),
      "SUPPRESSION_INVALID_INPUT",
    );
    const sparse = structuredClone(irOf("text")) as unknown as { nodes: unknown[] };
    sparse.nodes = [];
    sparse.nodes.length = 1_000_000_000;
    expectProcessorError(() => parseSuppressionDirectives(sparse), "SUPPRESSION_INVALID_INPUT");

    const deep = structuredClone(irOf("text")) as unknown as Record<string, unknown>;
    let value: unknown = "leaf";
    for (let index = 0; index < 400; index += 1) value = { value };
    deep["hostile"] = value;
    expectProcessorError(() => parseSuppressionDirectives(deep), "SUPPRESSION_INVALID_INPUT");
  });

  test("bounds candidates, comments, rules, reasons, and issue volume deterministically", () => {
    const directives = Array.from(
      { length: 3 },
      () => "<!-- agent-context-lint-disable-next-line ACL250 -->\ntarget",
    ).join("\n");
    const capped = parseSuppressionDirectives(irOf(directives), { maxCandidates: 1 });
    expect(capped.directives).toHaveLength(1);
    expect(capped.issues).toEqual([expect.objectContaining({ code: "resource-limit" })]);

    const longComment = parseSuppressionDirectives(
      irOf(`<!-- agent-context-lint-disable-next-line ACL250 -- ${"x".repeat(100)} -->\ntarget`),
      { maxCommentBytes: 64 },
    );
    expect(longComment.directives).toEqual([]);
    expect(longComment.issues[0]?.code).toBe("resource-limit");

    const longReason = parseSuppressionDirectives(
      irOf(`<!-- agent-context-lint-disable-next-line ACL250 -- ${"x".repeat(20)} -->\ntarget`),
      { maxReasonBytes: 10 },
    );
    expect(longReason.directives).toEqual([]);
    expect(longReason.issues[0]?.code).toBe("resource-limit");

    const tooManyRules = parseSuppressionDirectives(
      irOf("<!-- agent-context-lint-disable-next-line ACL250, ACL251 -->\ntarget"),
      { maxRulesPerDirective: 1 },
    );
    expect(tooManyRules.directives).toEqual([]);
    expect(tooManyRules.issues[0]?.code).toBe("resource-limit");

    const invalid = Array.from(
      { length: 5 },
      () => "<!-- agent-context-lint-disable-next-line * -->\ntarget",
    ).join("\n");
    const first = parseSuppressionDirectives(irOf(invalid), { maxIssues: 3 });
    const second = parseSuppressionDirectives(irOf(invalid), { maxIssues: 3 });
    expect(first).toEqual(second);
    expect(first.issues).toHaveLength(3);
    expect(first.issues.at(-1)?.code).toBe("resource-limit");
  });

  test("is deterministic over rule-order permutations and exact Unicode reasons", () => {
    let state = 0x7f4a7c15;
    for (let index = 0; index < 200; index += 1) {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      const rules = state % 2 === 0 ? "ACL300, ACL250" : "ACL250, ACL300";
      const text = `<!-- agent-context-lint-disable-next-line ${rules} -- powód 😀 ${String(index)} -->\ntarget`;
      const first = parseSuppressionDirectives(irOf(text));
      const second = parseSuppressionDirectives(irOf(text));
      expect(JSON.stringify(first)).toBe(JSON.stringify(second));
      expect(first.directives[0]?.record.targetRuleIds).toEqual(["ACL250", "ACL300"]);
    }
  });
});
