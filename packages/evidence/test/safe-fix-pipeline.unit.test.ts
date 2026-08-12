import { createHash } from "node:crypto";
import { chmod, link, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  DIAGNOSTIC_CONTRACT_VERSION,
  PATH_FINGERPRINT_METHOD,
  SEMANTIC_FINGERPRINT_METHOD,
  canonicalizeRepositoryRelativePath,
  computePathFingerprint,
  computeSemanticFingerprint,
} from "@agent-context/core";
import type {
  AtomicFixPlan,
  Diagnostic,
  DiagnosticBundle,
  DiagnosticId,
  FixPlanId,
  RepositoryRelativePath,
  SourceDocument,
  SourceDocumentId,
  SourcePosition,
  SourceRange,
} from "@agent-context/core";
import { withTempWorkspace } from "@agent-context/test-kit";
import { describe, expect, test } from "vitest";

import {
  SAFE_FIX_CONTRACT_VERSION,
  SAFE_FIX_HARD_MINIMUM_CONFIDENCE,
  SafeFixError,
  SafeFixErrorCode,
  createReadOnlyRepository,
  createSafeFixPipeline,
  issueSafeFixEligibility,
  selectRepositoryRoot,
} from "../src/index.js";
import type {
  RepositoryRootSelection,
  SafeFixEligibility,
  SafeFixPipeline,
  SafeFixPreviewRequest,
  SafeFixSourceSnapshot,
} from "../src/index.js";

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function lineEnding(text: string): SourceDocument["lineEnding"] {
  const forms = new Set<"cr" | "crlf" | "lf">();
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\r") {
      if (text[index + 1] === "\n") {
        forms.add("crlf");
        index += 1;
      } else forms.add("cr");
    } else if (text[index] === "\n") forms.add("lf");
  }
  return forms.size === 0 ? "none" : forms.size === 1 ? ([...forms][0] ?? "none") : "mixed";
}

function position(text: string, offset: number): SourcePosition {
  const prefix = text.slice(0, offset);
  let line = 0;
  let column = 0;
  for (let index = 0; index < prefix.length; index += 1) {
    const unit = prefix[index];
    if (unit === "\r") {
      if (prefix[index + 1] === "\n") continue;
      line += 1;
      column = 0;
    } else if (unit === "\n") {
      line += 1;
      column = 0;
    } else column += 1;
  }
  return {
    byteOffset: Buffer.byteLength(prefix, "utf8"),
    line,
    utf16Column: column,
    utf16Offset: offset,
  };
}

function range(source: SourceDocument, start: number, end: number): SourceRange {
  return {
    end: position(source.text, end),
    sourceId: source.id,
    start: position(source.text, start),
  };
}

function sourceDocument(pathValue: string, text: string): SourceDocument {
  const repositoryPath = canonicalizeRepositoryRelativePath(pathValue);
  const stable = sha256(`${pathValue}\0${sha256(text)}`);
  return {
    bom: text.startsWith("\uFEFF") ? "utf-8" : "none",
    byteLength: Buffer.byteLength(text, "utf8"),
    encoding: "utf-8",
    id: `source:${stable}` as SourceDocumentId,
    lineEnding: lineEnding(text),
    parseState: { state: "complete" },
    path: repositoryPath,
    rootNodeId: `ast:${stable}` as SourceDocument["rootNodeId"],
    sha256: sha256(text),
    text,
    utf16Length: text.length,
  };
}

function textPlan(
  source: SourceDocument,
  id: string,
  edits: readonly { readonly end: number; readonly newText: string; readonly start: number }[],
): AtomicFixPlan {
  return {
    application: "atomic",
    id: id as FixPlanId,
    operations: edits.map((edit) => ({
      kind: "text-edit" as const,
      newText: edit.newText,
      path: source.path,
      range: range(source, edit.start, edit.end),
      sourceDigest: source.sha256,
      sourceId: source.id,
    })),
    safety: "mechanical",
    title: `Mechanical edit ${id}`,
  };
}

function diagnostic(source: SourceDocument, plan: AtomicFixPlan, ordinal: number): Diagnostic {
  const ruleId = `ACL${String(100 + ordinal)}`;
  const ruleVersion = "1.0.0";
  const pathBasis = { anchor: `fix-${String(ordinal)}`, profileIds: [] } as const;
  const semanticBasis = {
    components: [{ key: "fix", value: String(ordinal) }],
    profileIds: [],
  } as const;
  return {
    fingerprintBasis: { path: pathBasis, semantic: semanticBasis },
    fingerprints: {
      path: {
        method: PATH_FINGERPRINT_METHOD,
        value: computePathFingerprint({ basis: pathBasis, path: source.path, ruleId, ruleVersion }),
      },
      semantic: {
        method: SEMANTIC_FINGERPRINT_METHOD,
        value: computeSemanticFingerprint({ basis: semanticBasis, ruleId, ruleVersion }),
      },
    },
    id: `diagnostic:${String(ordinal).padStart(4, "0")}` as DiagnosticId,
    message: "Mechanical source correction",
    primary: {
      path: source.path,
      range: range(source, 0, source.text.length),
      sourceDigest: source.sha256,
      sourceId: source.id,
    },
    related: [],
    ruleId,
    ruleVersion,
    severity: "warning",
    suggestion: { fixPlan: plan, message: "Preview the mechanical correction" },
  };
}

function bundle(diagnostics: readonly Diagnostic[]): DiagnosticBundle {
  return {
    contractVersion: DIAGNOSTIC_CONTRACT_VERSION,
    diagnostics,
    recordKind: "agent-context-diagnostics",
    suppressions: [],
  };
}

function eligibility(diagnosticValue: Diagnostic, confidence = 1): SafeFixEligibility {
  const plan = diagnosticValue.suggestion?.fixPlan;
  if (plan === null || plan === undefined) throw new TypeError("test diagnostic lacks a plan");
  return issueSafeFixEligibility({
    confidence,
    diagnosticId: diagnosticValue.id,
    plan,
    policyState: "eligible",
    ruleId: diagnosticValue.ruleId,
    ruleVersion: diagnosticValue.ruleVersion,
  });
}

interface Fixture {
  readonly pipeline: SafeFixPipeline;
  readonly root: string;
  readonly selection: RepositoryRootSelection;
  readonly snapshot: SafeFixSourceSnapshot;
  readonly source: SourceDocument;
  readonly target: string;
}

async function fixture(
  resolvePath: (relative: string) => string,
  text = "alpha\nbeta\ngamma\n",
  pathValue = "AGENTS.md",
): Promise<Fixture> {
  const root = resolvePath("repo");
  const target = resolvePath(`repo/${pathValue}`);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, text);
  const selection = await selectRepositoryRoot(root, { mode: "explicit" });
  const reader = await createReadOnlyRepository(selection);
  const observed = await reader.readFile(pathValue);
  const source = sourceDocument(pathValue, text);
  return {
    pipeline: await createSafeFixPipeline(selection),
    root,
    selection,
    snapshot: { identity: observed.identity, source },
    source,
    target,
  };
}

function request(
  snapshots: readonly SafeFixSourceSnapshot[],
  diagnostics: readonly Diagnostic[],
  confidence = 1,
): SafeFixPreviewRequest {
  const candidates = diagnostics.map((item) => eligibility(item, confidence));
  return {
    bundle: bundle(diagnostics),
    candidates,
    minimumConfidence: SAFE_FIX_HARD_MINIMUM_CONFIDENCE,
    selectedPlanIds: candidates.map((item) => item.planId),
    sources: snapshots,
  };
}

function expectSafeError(value: unknown, code: SafeFixErrorCode, committed = false): boolean {
  expect(value).toBeInstanceOf(SafeFixError);
  expect(value).toMatchObject({ code, committed });
  expect(Object.isFrozen(value)).toBe(true);
  return true;
}

describe("I11 preview-first safe fix pipeline", () => {
  test("previews and atomically applies multiple disjoint edits to one exact source", async () => {
    await withTempWorkspace({}, async (workspace) => {
      const state = await fixture((relative) => workspace.resolvePath(relative));
      const plan = textPlan(state.source, "fix:0001", [
        { end: 5, newText: "ALPHA", start: 0 },
        { end: 16, newText: "GAMMA", start: 11 },
      ]);
      const diagnosticValue = diagnostic(state.source, plan, 1);

      const preview = state.pipeline.preview(request([state.snapshot], [diagnosticValue]));

      expect(preview).toMatchObject({
        contractVersion: SAFE_FIX_CONTRACT_VERSION,
        minimumConfidence: 0.95,
        selectedPlanIds: ["fix:0001"],
      });
      expect(preview.changes).toEqual([
        expect.objectContaining({ editCount: 2, kind: "text-edit", path: "AGENTS.md" }),
      ]);
      expect(preview.patch).toContain("-alpha");
      expect(preview.patch).toContain("+ALPHA");
      expect(sha256(preview.patch)).toBe(preview.patchSha256);
      expect(Object.isFrozen(preview)).toBe(true);
      expect(Object.isFrozen(preview.changes)).toBe(true);

      const applied = await state.pipeline.apply(preview);
      expect(await readFile(state.target, "utf8")).toBe("ALPHA\nbeta\nGAMMA\n");
      expect(applied).toMatchObject({
        appliedPaths: ["AGENTS.md"],
        patchSha256: preview.patchSha256,
      });
      expect(["file-and-directory", "file-only"]).toContain(applied.durability);
      expect(await readdir(state.root)).toEqual(["AGENTS.md"]);
    });
  });

  test("accepts adjacent edits and preserves BOM, CRLF, astral coordinates, and no-final-newline", async () => {
    await withTempWorkspace({}, async (workspace) => {
      const text = "\uFEFF🧭a\r\nb";
      const state = await fixture((relative) => workspace.resolvePath(relative), text);
      const start = text.indexOf("a");
      const plan = textPlan(state.source, "fix:0001", [
        { end: start + 1, newText: "A", start },
        { end: text.length, newText: "B", start: text.length - 1 },
      ]);
      const preview = state.pipeline.preview(
        request([state.snapshot], [diagnostic(state.source, plan, 1)]),
      );
      expect(preview.patch).toContain("No newline at end of file");
      await state.pipeline.apply(preview);
      expect(await readFile(state.target, "utf8")).toBe("\uFEFF🧭A\r\nB");
    });
  });

  test("requires explicit selection and returns an honest immutable no-op", async () => {
    await withTempWorkspace({}, async (workspace) => {
      const state = await fixture((relative) => workspace.resolvePath(relative));
      const preview = state.pipeline.preview({
        bundle: bundle([]),
        candidates: [],
        selectedPlanIds: [],
        sources: [state.snapshot],
      });
      expect(preview).toMatchObject({ changes: [], patch: "", selectedPlanIds: [] });
      expect(await state.pipeline.apply(preview)).toMatchObject({
        appliedPaths: [],
        durability: "not-applicable",
      });
      expect(await readFile(state.target, "utf8")).toBe(state.source.text);
    });
  });

  test("enforces the confidence floor at its exact boundary", async () => {
    await withTempWorkspace({}, async (workspace) => {
      const state = await fixture((relative) => workspace.resolvePath(relative));
      const plan = textPlan(state.source, "fix:0001", [{ end: 5, newText: "ALPHA", start: 0 }]);
      const diagnosticValue = diagnostic(state.source, plan, 1);
      expect(() =>
        state.pipeline.preview(request([state.snapshot], [diagnosticValue], 0.95)),
      ).not.toThrow();
      expect(() =>
        state.pipeline.preview(request([state.snapshot], [diagnosticValue], 0.9499999999999998)),
      ).toThrow(SafeFixError);
      const belowFloor = {
        ...request([state.snapshot], [diagnosticValue]),
        minimumConfidence: 0.94,
      };
      expect(() => state.pipeline.preview(belowFloor)).toThrow(SafeFixError);
    });
  });

  test("rejects forged, cloned, proxied, mismatched, and non-eligible authorities", async () => {
    await withTempWorkspace({}, async (workspace) => {
      const state = await fixture((relative) => workspace.resolvePath(relative));
      const plan = textPlan(state.source, "fix:0001", [{ end: 5, newText: "ALPHA", start: 0 }]);
      const diagnosticValue = diagnostic(state.source, plan, 1);
      const base = request([state.snapshot], [diagnosticValue]);
      for (const candidate of [
        { confidence: 1, diagnosticId: diagnosticValue.id, planId: plan.id },
        structuredClone(base.candidates[0]),
        new Proxy(base.candidates[0] as object, {}),
      ]) {
        expect(() => state.pipeline.preview({ ...base, candidates: [candidate] })).toThrow(
          SafeFixError,
        );
      }
      expect(() =>
        issueSafeFixEligibility({
          confidence: 1,
          diagnosticId: diagnosticValue.id,
          plan,
          policyState: "suppressed",
          ruleId: diagnosticValue.ruleId,
          ruleVersion: diagnosticValue.ruleVersion,
        }),
      ).toThrow(SafeFixError);

      const authorized = eligibility(diagnosticValue);
      const changedPlan = textPlan(state.source, "fix:0001", [
        { end: 5, newText: "OTHER", start: 0 },
      ]);
      const changedDiagnostic = diagnostic(state.source, changedPlan, 1);
      expect(() =>
        state.pipeline.preview({
          ...request([state.snapshot], [changedDiagnostic]),
          candidates: [authorized],
        }),
      ).toThrow(SafeFixError);
    });
  });

  test("rejects cross-plan overlaps and same-position insertions before filesystem work", async () => {
    await withTempWorkspace({}, async (workspace) => {
      const state = await fixture((relative) => workspace.resolvePath(relative));
      const first = diagnostic(
        state.source,
        textPlan(state.source, "fix:0001", [{ end: 5, newText: "one", start: 0 }]),
        1,
      );
      const second = diagnostic(
        state.source,
        textPlan(state.source, "fix:0002", [{ end: 6, newText: "two", start: 4 }]),
        2,
      );
      expect(() => state.pipeline.preview(request([state.snapshot], [first, second]))).toThrow(
        SafeFixError,
      );

      const insertOne = diagnostic(
        state.source,
        textPlan(state.source, "fix:0003", [{ end: 5, newText: "!", start: 5 }]),
        3,
      );
      const insertTwo = diagnostic(
        state.source,
        textPlan(state.source, "fix:0004", [{ end: 5, newText: "?", start: 5 }]),
        4,
      );
      expect(() =>
        state.pipeline.preview(request([state.snapshot], [insertOne, insertTwo])),
      ).toThrow(SafeFixError);
      expect(await readFile(state.target, "utf8")).toBe(state.source.text);
    });
  });

  test("redacts credentials and makes terminal controls inert in the deterministic patch", async () => {
    await withTempWorkspace({}, async (workspace) => {
      const secret = "github_pat_12345678901234567890";
      const state = await fixture(
        (relative) => workspace.resolvePath(relative),
        `token=${secret}\nplain\n`,
      );
      const start = state.source.text.indexOf("plain");
      const plan = textPlan(state.source, "fix:0001", [
        { end: start + 5, newText: "safe\u001b[31m\u202e", start },
      ]);
      const preview = state.pipeline.preview(
        request([state.snapshot], [diagnostic(state.source, plan, 1)]),
      );
      expect(preview.patch).not.toContain(secret);
      expect(preview.patch).not.toContain("\u001b");
      expect(preview.patch).not.toContain("\u202e");
      expect(preview.patch).toContain("REDACTED");
      expect(preview.patch).toContain("�");
    });
  });

  test("fails closed on patch and replacement byte limits", async () => {
    await withTempWorkspace({}, async (workspace) => {
      const state = await fixture((relative) => workspace.resolvePath(relative));
      const plan = textPlan(state.source, "fix:0001", [{ end: 5, newText: "expanded", start: 0 }]);
      const diagnosticValue = diagnostic(state.source, plan, 1);
      const tinyPatch = await createSafeFixPipeline(state.selection, { maximumPatchBytes: 8 });
      expect(() => tinyPatch.preview(request([state.snapshot], [diagnosticValue]))).toThrow(
        SafeFixError,
      );
      const tinyFile = await createSafeFixPipeline(state.selection, { maximumBytes: 19 });
      expect(() => tinyFile.preview(request([state.snapshot], [diagnosticValue]))).toThrow(
        SafeFixError,
      );
    });
  });

  test("revalidates content and filesystem identity after preview", async () => {
    await withTempWorkspace({}, async (workspace) => {
      const state = await fixture((relative) => workspace.resolvePath(relative));
      const plan = textPlan(state.source, "fix:0001", [{ end: 5, newText: "ALPHA", start: 0 }]);
      const preview = state.pipeline.preview(
        request([state.snapshot], [diagnostic(state.source, plan, 1)]),
      );
      await writeFile(state.target, "changed but same-ish");
      await expect(state.pipeline.apply(preview)).rejects.toSatisfy((error: unknown) =>
        expectSafeError(error, SafeFixErrorCode.concurrentChange),
      );

      const replacement = workspace.resolvePath("repo/replacement");
      await writeFile(replacement, state.source.text);
      await rename(replacement, state.target);
      const second = state.pipeline.preview(
        request([state.snapshot], [diagnostic(state.source, plan, 1)]),
      );
      await expect(state.pipeline.apply(second)).rejects.toSatisfy((error: unknown) =>
        expectSafeError(error, SafeFixErrorCode.concurrentChange),
      );
    });
  });

  test("copies plan/source state and rejects reused, cloned, foreign, and concurrent previews", async () => {
    await withTempWorkspace({}, async (workspace) => {
      const state = await fixture((relative) => workspace.resolvePath(relative));
      const plan = textPlan(state.source, "fix:0001", [{ end: 5, newText: "ALPHA", start: 0 }]);
      const diagnosticValue = diagnostic(state.source, plan, 1);
      const preview = state.pipeline.preview(request([state.snapshot], [diagnosticValue]));
      (plan.operations[0] as { newText: string }).newText = "HOSTILE";
      (state.source as { text: string }).text = "HOSTILE";

      const foreign = await createSafeFixPipeline(state.selection);
      await expect(foreign.apply(preview)).rejects.toSatisfy((error: unknown) =>
        expectSafeError(error, SafeFixErrorCode.invalidPreview),
      );
      await expect(state.pipeline.apply(structuredClone(preview))).rejects.toSatisfy(
        (error: unknown) => expectSafeError(error, SafeFixErrorCode.invalidPreview),
      );
      const [first, second] = await Promise.allSettled([
        state.pipeline.apply(preview),
        state.pipeline.apply(preview),
      ]);
      expect([first.status, second.status].sort()).toEqual(["fulfilled", "rejected"]);
      expect(await readFile(state.target, "utf8")).toBe("ALPHA\nbeta\ngamma\n");
      await expect(state.pipeline.apply(preview)).rejects.toSatisfy((error: unknown) =>
        expectSafeError(error, SafeFixErrorCode.invalidPreview),
      );
    });
  });

  test("rejects multi-file application before either file changes", async () => {
    await withTempWorkspace({}, async (workspace) => {
      const first = await fixture((relative) => workspace.resolvePath(relative), "first\n", "a.md");
      const reader = await createReadOnlyRepository(first.selection);
      const secondPath = workspace.resolvePath("repo/b.md");
      await writeFile(secondPath, "second\n");
      const secondSource = sourceDocument("b.md", "second\n");
      const secondObserved = await reader.readFile("b.md");
      const secondSnapshot = { identity: secondObserved.identity, source: secondSource };
      const firstDiagnostic = diagnostic(
        first.source,
        textPlan(first.source, "fix:0001", [{ end: 5, newText: "FIRST", start: 0 }]),
        1,
      );
      const secondDiagnostic = diagnostic(
        secondSource,
        textPlan(secondSource, "fix:0002", [{ end: 6, newText: "SECOND", start: 0 }]),
        2,
      );
      const preview = first.pipeline.preview(
        request([first.snapshot, secondSnapshot], [firstDiagnostic, secondDiagnostic]),
      );
      await expect(first.pipeline.apply(preview)).rejects.toSatisfy((error: unknown) =>
        expectSafeError(error, SafeFixErrorCode.unsupportedOperation),
      );
      expect(await readFile(first.target, "utf8")).toBe("first\n");
      expect(await readFile(secondPath, "utf8")).toBe("second\n");
    });
  });

  test("previews create and move deterministically but refuses unsafe no-clobber application", async () => {
    await withTempWorkspace({}, async (workspace) => {
      const state = await fixture((relative) => workspace.resolvePath(relative));
      const createPlan: AtomicFixPlan = {
        application: "atomic",
        id: "fix:0001" as FixPlanId,
        operations: [
          {
            content: "new\n",
            contentDigest: sha256("new\n"),
            destinationPrecondition: "absent",
            kind: "create-document",
            path: "new.md" as RepositoryRelativePath,
          },
        ],
        safety: "mechanical",
        title: "Create document",
      };
      const movePlan: AtomicFixPlan = {
        application: "atomic",
        id: "fix:0002" as FixPlanId,
        operations: [
          {
            destinationPath: "moved.md" as RepositoryRelativePath,
            destinationPrecondition: "absent",
            kind: "move-document",
            path: state.source.path,
            sourceDigest: state.source.sha256,
            sourceId: state.source.id,
          },
        ],
        safety: "mechanical",
        title: "Move document",
      };
      const diagnostics = [
        diagnostic(state.source, createPlan, 1),
        diagnostic(state.source, movePlan, 2),
      ];
      const preview = state.pipeline.preview(request([state.snapshot], diagnostics));
      expect(preview.changes.map((change) => change.kind)).toEqual([
        "move-document",
        "create-document",
      ]);
      expect(preview.patch).toContain("rename from AGENTS.md");
      expect(preview.patch).toContain("new file mode 100644");
      const emptyCreate: AtomicFixPlan = {
        ...createPlan,
        id: "fix:0003" as FixPlanId,
        operations: [
          {
            content: "",
            contentDigest: sha256(""),
            destinationPrecondition: "absent",
            kind: "create-document",
            path: "empty.md" as RepositoryRelativePath,
          },
        ],
      };
      const emptyPreview = state.pipeline.preview(
        request([state.snapshot], [diagnostic(state.source, emptyCreate, 3)]),
      );
      expect(emptyPreview.patch).toContain("@@ -0,0 +0,0 @@");
      await expect(state.pipeline.apply(preview)).rejects.toSatisfy((error: unknown) =>
        expectSafeError(error, SafeFixErrorCode.unsupportedOperation),
      );
      expect(await readdir(state.root)).toEqual(["AGENTS.md"]);
    });
  });

  test("rejects duplicate move sources across selected plans", async () => {
    await withTempWorkspace({}, async (workspace) => {
      const state = await fixture((relative) => workspace.resolvePath(relative));
      const move = (id: string, destination: string): AtomicFixPlan => ({
        application: "atomic",
        id: id as FixPlanId,
        operations: [
          {
            destinationPath: destination as RepositoryRelativePath,
            destinationPrecondition: "absent",
            kind: "move-document",
            path: state.source.path,
            sourceDigest: state.source.sha256,
            sourceId: state.source.id,
          },
        ],
        safety: "mechanical",
        title: "Move document",
      });
      const diagnostics = [
        diagnostic(state.source, move("fix:0001", "a.md"), 1),
        diagnostic(state.source, move("fix:0002", "b.md"), 2),
      ];
      expect(() => state.pipeline.preview(request([state.snapshot], diagnostics))).toThrow(
        SafeFixError,
      );
    });
  });

  test("fails closed on read-only and hard-linked targets", async () => {
    await withTempWorkspace({}, async (workspace) => {
      const state = await fixture((relative) => workspace.resolvePath(relative));
      const plan = textPlan(state.source, "fix:0001", [{ end: 5, newText: "ALPHA", start: 0 }]);
      const diagnosticValue = diagnostic(state.source, plan, 1);
      const preview = state.pipeline.preview(request([state.snapshot], [diagnosticValue]));
      if (process.platform !== "win32") {
        await chmod(state.target, 0o444);
        await expect(state.pipeline.apply(preview)).rejects.toSatisfy((error: unknown) =>
          expectSafeError(error, SafeFixErrorCode.applyFailed),
        );
        await chmod(state.target, 0o644);
      }

      const fresh = await fixture(
        (relative) => workspace.resolvePath(relative),
        "linked\n",
        "linked.md",
      );
      await link(fresh.target, workspace.resolvePath("repo/alias.md"));
      const linkedPlan = textPlan(fresh.source, "fix:0001", [
        { end: 6, newText: "LINKED", start: 0 },
      ]);
      const linkedPreview = fresh.pipeline.preview(
        request([fresh.snapshot], [diagnostic(fresh.source, linkedPlan, 1)]),
      );
      await expect(fresh.pipeline.apply(linkedPreview)).rejects.toSatisfy((error: unknown) =>
        expectSafeError(error, SafeFixErrorCode.concurrentChange),
      );
    });
  });

  test("rejects malformed request shapes and already-aborted work without mutation", async () => {
    await withTempWorkspace({}, async (workspace) => {
      const state = await fixture((relative) => workspace.resolvePath(relative));
      expect(() => state.pipeline.preview(new Proxy({}, {}))).toThrow(SafeFixError);
      const accessor = {};
      Object.defineProperty(accessor, "bundle", { get: () => bundle([]), enumerable: true });
      expect(() => state.pipeline.preview(accessor)).toThrow(SafeFixError);

      const controller = new AbortController();
      controller.abort();
      await expect(
        createSafeFixPipeline(state.selection, { signal: controller.signal }),
      ).rejects.toThrow();
      const laterController = new AbortController();
      const later = await createSafeFixPipeline(state.selection, {
        signal: laterController.signal,
      });
      laterController.abort();
      expect(() =>
        later.preview({
          bundle: bundle([]),
          candidates: [],
          selectedPlanIds: [],
          sources: [state.snapshot],
        }),
      ).toThrow(SafeFixError);
      expect(await readFile(state.target, "utf8")).toBe(state.source.text);
    });
  });

  test("rejects hostile eligibility numbers, plans, symbols, accessors, and sparse arrays", async () => {
    await withTempWorkspace({}, async (workspace) => {
      const state = await fixture((relative) => workspace.resolvePath(relative));
      const plan = textPlan(state.source, "fix:0001", [{ end: 5, newText: "ALPHA", start: 0 }]);
      const diagnosticValue = diagnostic(state.source, plan, 1);
      const base = {
        confidence: 1,
        diagnosticId: diagnosticValue.id,
        plan,
        policyState: "eligible",
        ruleId: diagnosticValue.ruleId,
        ruleVersion: diagnosticValue.ruleVersion,
      };
      for (const value of [-0, Number.NaN, Number.POSITIVE_INFINITY, -1, 1.01])
        expect(() => issueSafeFixEligibility({ ...base, confidence: value })).toThrow(SafeFixError);
      expect(() => issueSafeFixEligibility({ ...base, ruleId: "bad rule" })).toThrow(SafeFixError);
      expect(() => issueSafeFixEligibility({ ...base, plan: new Proxy(plan, {}) })).toThrow(
        SafeFixError,
      );
      const symbolic = structuredClone(plan) as AtomicFixPlan & Record<symbol, string>;
      symbolic[Symbol("hostile")] = "value";
      expect(() => issueSafeFixEligibility({ ...base, plan: symbolic })).toThrow(SafeFixError);
      const accessor = structuredClone(plan);
      Object.defineProperty(accessor, "title", { enumerable: true, get: () => "forged" });
      expect(() => issueSafeFixEligibility({ ...base, plan: accessor })).toThrow(SafeFixError);
      const sparse = structuredClone(plan) as unknown as { operations: unknown[] };
      sparse.operations = new Array(2);
      expect(() => issueSafeFixEligibility({ ...base, plan: sparse })).toThrow(SafeFixError);

      const inherited = Object.assign(Object.create({ inherited: true }), plan) as AtomicFixPlan;
      expect(() => issueSafeFixEligibility({ ...base, plan: inherited })).toThrow(SafeFixError);
      expect(() =>
        issueSafeFixEligibility({ ...base, plan: { ...plan, title: undefined } }),
      ).toThrow(SafeFixError);
      expect(() =>
        issueSafeFixEligibility({ ...base, plan: { ...plan, title: new Date(0) } }),
      ).toThrow(SafeFixError);
      let nested: unknown = "leaf";
      for (let depth = 0; depth < 34; depth += 1) nested = { nested };
      expect(() => issueSafeFixEligibility({ ...base, plan: { ...plan, title: nested } })).toThrow(
        SafeFixError,
      );
    });
  });

  test("rejects inherited records and hostile dense-array representations", async () => {
    await withTempWorkspace({}, async (workspace) => {
      const state = await fixture((relative) => workspace.resolvePath(relative));
      const plan = textPlan(state.source, "fix:0001", [{ end: 5, newText: "ALPHA", start: 0 }]);
      const diagnosticValue = diagnostic(state.source, plan, 1);
      const base = request([state.snapshot], [diagnosticValue]);

      expect(() => state.pipeline.preview(Object.create(base))).toThrow(SafeFixError);
      expect(() => state.pipeline.preview({ ...base, candidates: {} })).toThrow(SafeFixError);
      expect(() =>
        state.pipeline.preview({ ...base, candidates: new Array(1_025).fill(base.candidates[0]) }),
      ).toThrow(SafeFixError);

      const accessorArray = new Array(1);
      Object.defineProperty(accessorArray, "0", {
        enumerable: true,
        get: () => base.candidates[0],
      });
      expect(() => state.pipeline.preview({ ...base, candidates: accessorArray })).toThrow(
        SafeFixError,
      );
      expect(() =>
        state.pipeline.preview({
          ...base,
          sources: [
            {
              ...state.snapshot,
              source: { ...state.source, path: 1 },
            },
          ],
        }),
      ).toThrow(SafeFixError);
    });
  });

  test("rejects invalid pipeline limits, signals, and repository selections", async () => {
    await withTempWorkspace({}, async (workspace) => {
      const state = await fixture((relative) => workspace.resolvePath(relative));
      for (const options of [
        { maximumBytes: 0 },
        { maximumBytes: 67_108_865 },
        { maximumPatchBytes: 0 },
        { maximumPatchBytes: 67_108_865 },
        { signal: {} },
        { unknown: true },
      ])
        await expect(
          createSafeFixPipeline(state.selection, options as never),
        ).rejects.toBeInstanceOf(SafeFixError);
      await expect(createSafeFixPipeline({} as RepositoryRootSelection)).rejects.toBeInstanceOf(
        SafeFixError,
      );
    });
  });

  test("rejects unknown/missing fields, sparse selections, bad identities, duplicate sources, and ordering", async () => {
    await withTempWorkspace({}, async (workspace) => {
      const state = await fixture((relative) => workspace.resolvePath(relative));
      const first = diagnostic(
        state.source,
        textPlan(state.source, "fix:0001", [{ end: 5, newText: "ALPHA", start: 0 }]),
        1,
      );
      const second = diagnostic(
        state.source,
        textPlan(state.source, "fix:0002", [{ end: 10, newText: "BETA", start: 6 }]),
        2,
      );
      const base = request([state.snapshot], [first, second]);
      for (const malformed of [
        { ...base, unknown: true },
        {
          candidates: base.candidates,
          selectedPlanIds: base.selectedPlanIds,
          sources: base.sources,
        },
        { ...base, bundle: {} },
        { ...base, candidates: [], selectedPlanIds: ["fix:0001"] },
        { ...base, selectedPlanIds: ["fix:0002", "fix:0001"] },
        { ...base, selectedPlanIds: ["fix:0001", "fix:0001"] },
        { ...base, candidates: [...base.candidates].reverse() },
        { ...base, sources: [state.snapshot, state.snapshot] },
        {
          ...base,
          sources: [{ ...state.snapshot, identity: { device: "01", inode: "2" } }],
        },
        {
          ...base,
          sources: [
            {
              ...state.snapshot,
              source: { ...state.source, sha256: "0".repeat(64) },
            },
          ],
        },
      ])
        expect(() => state.pipeline.preview(malformed)).toThrow(SafeFixError);
      const sparse = new Array(2);
      sparse[0] = "fix:0001";
      expect(() => state.pipeline.preview({ ...base, selectedPlanIds: sparse })).toThrow(
        SafeFixError,
      );
    });
  });

  test("rejects suppressed diagnostics and no-op/edit-move/destination conflicts", async () => {
    await withTempWorkspace({}, async (workspace) => {
      const state = await fixture((relative) => workspace.resolvePath(relative));
      const plan = textPlan(state.source, "fix:0001", [{ end: 5, newText: "alpha", start: 0 }]);
      const diagnosticValue = diagnostic(state.source, plan, 1);
      const suppressedBundle: DiagnosticBundle = {
        ...bundle([diagnosticValue]),
        suppressions: [
          {
            directive: diagnosticValue.primary,
            evidence: [],
            id: "suppression:0001" as never,
            matchedPathFingerprints: [diagnosticValue.fingerprints.path.value],
            reason: "Reviewed locally",
            state: "suppressed",
            targetRuleIds: [diagnosticValue.ruleId],
          },
        ],
      };
      const candidate = eligibility(diagnosticValue);
      expect(() =>
        state.pipeline.preview({
          bundle: suppressedBundle,
          candidates: [candidate],
          selectedPlanIds: [candidate.planId],
          sources: [state.snapshot],
        }),
      ).toThrow(SafeFixError);
      expect(() => state.pipeline.preview(request([state.snapshot], [diagnosticValue]))).toThrow(
        SafeFixError,
      );

      const movePlan: AtomicFixPlan = {
        application: "atomic",
        id: "fix:0002" as FixPlanId,
        operations: [
          {
            destinationPath: "new.md" as RepositoryRelativePath,
            destinationPrecondition: "absent",
            kind: "move-document",
            path: state.source.path,
            sourceDigest: state.source.sha256,
            sourceId: state.source.id,
          },
        ],
        safety: "mechanical",
        title: "Move source",
      };
      const editDiagnostic = diagnostic(
        state.source,
        textPlan(state.source, "fix:0001", [{ end: 5, newText: "ALPHA", start: 0 }]),
        1,
      );
      const moveDiagnostic = diagnostic(state.source, movePlan, 2);
      expect(() =>
        state.pipeline.preview(request([state.snapshot], [editDiagnostic, moveDiagnostic])),
      ).toThrow(SafeFixError);

      const create = (id: string, pathValue = "same.md"): Diagnostic =>
        diagnostic(
          state.source,
          {
            application: "atomic",
            id: id as FixPlanId,
            operations: [
              {
                content: "x",
                contentDigest: sha256("x"),
                destinationPrecondition: "absent",
                kind: "create-document",
                path: pathValue as RepositoryRelativePath,
              },
            ],
            safety: "mechanical",
            title: "Create source",
          },
          Number(id.at(-1)),
        );
      expect(() =>
        state.pipeline.preview(request([state.snapshot], [create("fix:0003"), create("fix:0004")])),
      ).toThrow(SafeFixError);
      expect(() =>
        state.pipeline.preview(request([state.snapshot], [create("fix:0005", "AGENTS.md")])),
      ).toThrow(SafeFixError);
    });
  });

  test("cancellation after preview is consumed before preflight and malformed previews are rejected", async () => {
    await withTempWorkspace({}, async (workspace) => {
      const root = workspace.resolvePath("repo");
      await mkdir(root);
      const target = workspace.resolvePath("repo/AGENTS.md");
      await writeFile(target, "alpha\n");
      const selection = await selectRepositoryRoot(root, { mode: "explicit" });
      const reader = await createReadOnlyRepository(selection);
      const observed = await reader.readFile("AGENTS.md");
      const source = sourceDocument("AGENTS.md", "alpha\n");
      const controller = new AbortController();
      const pipeline = await createSafeFixPipeline(selection, { signal: controller.signal });
      const diagnosticValue = diagnostic(
        source,
        textPlan(source, "fix:0001", [{ end: 5, newText: "ALPHA", start: 0 }]),
        1,
      );
      const preview = pipeline.preview(
        request([{ identity: observed.identity, source }], [diagnosticValue]),
      );
      controller.abort();
      await expect(pipeline.apply(preview)).rejects.toSatisfy((error: unknown) =>
        expectSafeError(error, SafeFixErrorCode.aborted),
      );
      await expect(pipeline.apply(null)).rejects.toSatisfy((error: unknown) =>
        expectSafeError(error, SafeFixErrorCode.invalidPreview),
      );
      await expect(pipeline.apply(new Proxy(preview, {}))).rejects.toSatisfy((error: unknown) =>
        expectSafeError(error, SafeFixErrorCode.invalidPreview),
      );
      expect(await readFile(target, "utf8")).toBe("alpha\n");
    });
  });
});
