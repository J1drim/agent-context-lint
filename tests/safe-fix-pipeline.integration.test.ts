import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";

import { validateDiagnosticBundle, validateInstructionIr } from "../packages/core/dist/index.js";
import type {
  AtomicFixPlan,
  DiagnosticBundle,
  SourceDocument,
} from "../packages/core/dist/index.js";
import {
  SafeFixError,
  createReadOnlyRepository,
  createSafeFixPipeline,
  issueSafeFixEligibility,
  selectRepositoryRoot,
} from "../packages/evidence/src/index.js";
import type { SafeFixEligibility } from "../packages/evidence/src/index.js";
import { withTempWorkspace } from "../packages/test-kit/src/index.js";
import { describe, expect, test } from "vitest";

const IR_FIXTURE = new URL(
  "../packages/core/test/fixtures/instruction-ir.valid.json",
  import.meta.url,
);
const DIAGNOSTIC_FIXTURE = new URL(
  "../packages/core/test/fixtures/diagnostics.valid.json",
  import.meta.url,
);

async function json(url: URL): Promise<unknown> {
  return JSON.parse(await readFile(url, "utf8")) as unknown;
}

async function fixtureContracts(): Promise<{
  readonly bundle: DiagnosticBundle;
  readonly source: SourceDocument;
}> {
  const ir = validateInstructionIr(await json(IR_FIXTURE));
  if (!ir.ok) throw new Error(JSON.stringify(ir.issues));
  const bundle = validateDiagnosticBundle(await json(DIAGNOSTIC_FIXTURE), ir.value.sources);
  if (!bundle.ok) throw new Error(JSON.stringify(bundle.issues));
  const source = ir.value.sources[0];
  if (source === undefined) throw new TypeError("fixture source missing");
  return { bundle: bundle.value, source };
}

function eligibility(bundle: DiagnosticBundle): SafeFixEligibility {
  const diagnostic = bundle.diagnostics[0];
  const plan = diagnostic?.suggestion?.fixPlan;
  if (diagnostic === undefined || plan === null || plan === undefined)
    throw new TypeError("fixture plan missing");
  return issueSafeFixEligibility({
    confidence: 1,
    diagnosticId: diagnostic.id,
    plan,
    policyState: "eligible",
    ruleId: diagnostic.ruleId,
    ruleVersion: diagnostic.ruleVersion,
  });
}

describe("I11 safe fix integration", () => {
  test("renders the maintained B03/B04 fixture twice without mutating repository bytes", async () => {
    await withTempWorkspace({}, async (workspace) => {
      const contracts = await fixtureContracts();
      const root = workspace.resolvePath("repo");
      await mkdir(root);
      await writeFile(workspace.resolvePath("repo/AGENTS.md"), contracts.source.text);
      const selection = await selectRepositoryRoot(root, { mode: "explicit" });
      const reader = await createReadOnlyRepository(selection);
      const observed = await reader.readFile("AGENTS.md");
      const pipeline = await createSafeFixPipeline(selection);
      const candidate = eligibility(contracts.bundle);
      const input = {
        bundle: contracts.bundle,
        candidates: [candidate],
        selectedPlanIds: [candidate.planId],
        sources: [{ identity: observed.identity, source: contracts.source }],
      };
      const before = createHash("sha256")
        .update(await readFile(workspace.resolvePath("repo/AGENTS.md")))
        .digest("hex");

      const first = pipeline.preview(input);
      const second = pipeline.preview(input);

      expect(second.patch).toBe(first.patch);
      expect(second.patchSha256).toBe(first.patchSha256);
      expect(await readdir(root)).toEqual(["AGENTS.md"]);
      expect(
        createHash("sha256")
          .update(await readFile(workspace.resolvePath("repo/AGENTS.md")))
          .digest("hex"),
      ).toBe(before);
    });
  });

  test("applies a fixture text edit only after exact identity revalidation", async () => {
    await withTempWorkspace({}, async (workspace) => {
      const contracts = await fixtureContracts();
      const diagnostic = structuredClone(contracts.bundle.diagnostics[0]);
      const plan = diagnostic?.suggestion?.fixPlan;
      if (diagnostic === undefined || plan === null || plan === undefined)
        throw new TypeError("fixture plan missing");
      const operation = plan.operations[0];
      if (operation === undefined) throw new TypeError("fixture operation missing");
      (plan as { operations: AtomicFixPlan["operations"] }).operations = [operation];
      const selectedBundle: DiagnosticBundle = { ...contracts.bundle, diagnostics: [diagnostic] };
      const root = workspace.resolvePath("repo");
      await mkdir(root);
      const target = workspace.resolvePath("repo/AGENTS.md");
      await writeFile(target, contracts.source.text);
      const selection = await selectRepositoryRoot(root, { mode: "explicit" });
      const reader = await createReadOnlyRepository(selection);
      const observed = await reader.readFile("AGENTS.md");
      const pipeline = await createSafeFixPipeline(selection);
      const candidate = eligibility(selectedBundle);
      const preview = pipeline.preview({
        bundle: selectedBundle,
        candidates: [candidate],
        selectedPlanIds: [candidate.planId],
        sources: [{ identity: observed.identity, source: contracts.source }],
      });

      await pipeline.apply(preview);

      expect(await readFile(target, "utf8")).toContain("Use pnpm.");
      expect(await readdir(root)).toEqual(["AGENTS.md"]);
      await expect(pipeline.apply(preview)).rejects.toBeInstanceOf(SafeFixError);
    });
  });
});
