import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";

import {
  INSTRUCTION_IR_CONTRACT_VERSION,
  canonicalizeRepositoryRelativePath,
  validateInstructionIr,
} from "../packages/core/dist/index.js";
import {
  SafeFixError,
  SafeFixErrorCode,
  createReadOnlyRepository,
  createSafeFixPipeline,
  selectRepositoryRoot,
} from "../packages/evidence/dist/index.js";
import { parseMarkdown } from "../packages/markdown/dist/index.js";
import {
  evaluateSyntaxStructureRules,
  finalizeSyntaxSuppressions,
  planApprovedMechanicalFixes,
} from "../packages/rules/dist/index.js";
import { withTempWorkspace } from "../packages/test-kit/dist/index.js";
import { describe, expect, test } from "vitest";

import type {
  InstructionIr,
  SourceDocument,
  SourceDocumentId,
} from "../packages/core/dist/index.js";
import type {
  SafeFixPreviewRequest,
  SafeFixSourceSnapshot,
} from "../packages/evidence/dist/index.js";
import type {
  ApprovedMechanicalFixPlanResult,
  SyntaxStructureRuleInput,
} from "../packages/rules/dist/index.js";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function lineEnding(text: string): SourceDocument["lineEnding"] {
  const forms = new Set<"cr" | "crlf" | "lf">();
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\r" && text[index + 1] === "\n") {
      forms.add("crlf");
      index += 1;
    } else if (text[index] === "\r") forms.add("cr");
    else if (text[index] === "\n") forms.add("lf");
  }
  return forms.size === 0 ? "none" : forms.size === 1 ? ([...forms][0] ?? "none") : "mixed";
}

function input(pathValue: string, text: string): SyntaxStructureRuleInput {
  const path = canonicalizeRepositoryRelativePath(pathValue);
  const sourceId = `source:${sha256(`${pathValue}\0${text}`)}` as SourceDocumentId;
  const parsed = parseMarkdown({ sourceId, text });
  const source: SourceDocument = {
    bom: "none",
    byteLength: Buffer.byteLength(text, "utf8"),
    encoding: "utf-8",
    id: sourceId,
    lineEnding: lineEnding(text),
    parseState: parsed.parseState,
    path,
    rootNodeId: parsed.rootNodeId,
    sha256: sha256(text),
    text,
    utf16Length: text.length,
  };
  const candidate: InstructionIr = {
    activationRules: [],
    contractVersion: INSTRUCTION_IR_CONTRACT_VERSION,
    documents: [],
    events: [],
    imports: [],
    nodes: parsed.nodes,
    recordKind: "agent-context-instruction-ir",
    sources: [source],
    statements: [],
    targets: [],
  };
  const validated = validateInstructionIr(candidate);
  if (!validated.ok) throw new TypeError(JSON.stringify(validated.issues));
  return {
    contractVersion: "0.1.0",
    documents: [
      {
        dialect: null,
        fields: [],
        format: [],
        location: [],
        sourceId,
        vendorId: "fixture-vendor",
      },
    ],
    ir: validated.value,
    recordKind: "agent-context-syntax-structure-rule-input",
  };
}

function planned(pathValue: string, text: string): ApprovedMechanicalFixPlanResult {
  const evaluation = evaluateSyntaxStructureRules(input(pathValue, text));
  if (!evaluation.ok) throw new TypeError(JSON.stringify(evaluation.issues));
  const finalized = finalizeSyntaxSuppressions(evaluation);
  if (!finalized.ok) throw new TypeError(JSON.stringify(finalized.issues));
  const result = planApprovedMechanicalFixes(finalized);
  if (!result.ok) throw new TypeError(JSON.stringify(result.issues));
  return result;
}

function snapshot(
  result: ApprovedMechanicalFixPlanResult,
  identity: { readonly device: string; readonly inode: string },
): SafeFixSourceSnapshot {
  const source = result.sources[0];
  if (source === undefined) throw new TypeError("fixture source missing");
  return { identity, source };
}

function request(
  result: ApprovedMechanicalFixPlanResult,
  source: SafeFixSourceSnapshot,
): SafeFixPreviewRequest {
  return {
    bundle: result.bundle,
    candidates: result.candidates,
    selectedPlanIds: result.eligiblePlanIds,
    sources: [source],
  };
}

function expectSafeError(value: unknown, code: string): boolean {
  expect(value).toBeInstanceOf(SafeFixError);
  expect(value).toMatchObject({ code, committed: false });
  return true;
}

describe("I12 approved mechanical fixes through I11/I10", () => {
  test("preserves every outside byte, CRLF, Unicode, and file mode and is idempotent", async () => {
    const pathValue = ".github/instructions/test.instructions.md";
    const prefix = "# Żółw 🧭\r\n";
    const directive =
      "<!-- agent-context-lint-disable-next-line ACL100 -- stale suppression 🧪 -->";
    const suffix = "\r\nKeep this body byte-for-byte.\r\n";
    const before = `${prefix}${directive}${suffix}`;
    await withTempWorkspace({ [`repo/${pathValue}`]: before }, async (workspace) => {
      const root = workspace.resolvePath("repo");
      const target = workspace.resolvePath(`repo/${pathValue}`);
      await chmod(target, 0o640);
      const selection = await selectRepositoryRoot(root, { mode: "explicit" });
      const reader = await createReadOnlyRepository(selection);
      const observed = await reader.readFile(pathValue);
      const result = planned(pathValue, before);
      const candidate = result.candidates[0];
      expect(candidate).toBeDefined();
      const pipeline = await createSafeFixPipeline(selection);
      const preview = pipeline.preview(request(result, snapshot(result, observed.identity)));
      expect(preview.changes).toEqual([
        expect.objectContaining({ editCount: 1, kind: "text-edit", path: pathValue }),
      ]);
      const applied = await pipeline.apply(preview);
      expect(applied.appliedPaths).toEqual([pathValue]);
      const after = await readFile(target, "utf8");
      expect(after).toBe(`${prefix}${suffix}`);
      expect(after.slice(0, prefix.length)).toBe(prefix);
      expect(after.slice(prefix.length)).toBe(suffix);
      expect((await stat(target)).mode & 0o777).toBe(0o640);
      expect(planned(pathValue, after).eligiblePlanIds).toEqual([]);
    });
  });

  test("rejects concurrent mutation and a copied eligibility capability without partial writes", async () => {
    const pathValue = "AGENTS.md";
    const before = "<!-- agent-context-lint-disable-next-line ACL100 -- stale -->\nBody remains.\n";
    await withTempWorkspace({ [`repo/${pathValue}`]: before }, async (workspace) => {
      const root = workspace.resolvePath("repo");
      const target = workspace.resolvePath(`repo/${pathValue}`);
      const selection = await selectRepositoryRoot(root, { mode: "explicit" });
      const reader = await createReadOnlyRepository(selection);
      const observed = await reader.readFile(pathValue);
      const result = planned(pathValue, before);
      const source = snapshot(result, observed.identity);
      const pipeline = await createSafeFixPipeline(selection);
      const copied = structuredClone(result.candidates[0]);
      expect(() =>
        pipeline.preview({
          ...request(result, source),
          candidates: [copied],
        }),
      ).toThrow(SafeFixError);

      const preview = pipeline.preview(request(result, source));
      const concurrent = `${before}concurrent\n`;
      await writeFile(target, concurrent);
      await expect(pipeline.apply(preview)).rejects.toSatisfy((error: unknown) =>
        expectSafeError(error, SafeFixErrorCode.concurrentChange),
      );
      expect(await readFile(target, "utf8")).toBe(concurrent);
    });
  });

  test("rejects symlink substitution and cancellation before any repository mutation", async () => {
    const pathValue = "AGENTS.md";
    const before = "<!-- agent-context-lint-disable-next-line ACL100 -- stale -->\nBody remains.\n";
    await withTempWorkspace({ outside: before }, async (workspace) => {
      const root = workspace.resolvePath("repo");
      const target = workspace.resolvePath(`repo/${pathValue}`);
      await mkdir(root);
      await symlink(workspace.resolvePath("outside"), target);
      const linkIdentity = await lstat(target);
      const selection = await selectRepositoryRoot(root, { mode: "explicit" });
      const result = planned(pathValue, before);
      const source = snapshot(result, {
        device: String(linkIdentity.dev),
        inode: String(linkIdentity.ino),
      });
      const pipeline = await createSafeFixPipeline(selection);
      const preview = pipeline.preview(request(result, source));
      await expect(pipeline.apply(preview)).rejects.toSatisfy((error: unknown) =>
        expectSafeError(error, SafeFixErrorCode.concurrentChange),
      );
      expect(await readFile(workspace.resolvePath("outside"), "utf8")).toBe(before);

      const controller = new AbortController();
      const cancelled = await createSafeFixPipeline(selection, { signal: controller.signal });
      controller.abort();
      expect(() => cancelled.preview(request(result, source))).toThrow(
        expect.objectContaining({ code: SafeFixErrorCode.aborted }),
      );
      expect(await readFile(workspace.resolvePath("outside"), "utf8")).toBe(before);
    });
  });
});
