import { createHash } from "node:crypto";

import {
  canonicalizeRepositoryRelativePath,
  type RepositoryRelativePath,
} from "@agent-context/core";
import {
  buildTargetedDiscoveryIndex,
  collectGitChangedFileMetadata,
  createChangedFileScanScope,
  createGitMetadataCapability,
  IGNORE_ENGINE_DEFAULT_LIMITS,
  READ_ONLY_REPOSITORY_DEFAULT_LIMITS,
  ReadOnlyRepositoryError,
  ReadOnlyRepositoryErrorCode,
  ReadOnlyRepositoryFile,
  TRACKED_FILE_ENUMERATION_DEFAULT_LIMITS,
  loadImportGraph,
  selectRepositoryRoot,
  type GitChangedFileMetadata,
  type GitMetadataResponse,
  type IgnoreEngineResult,
  type ReadOnlyRepository,
  type TargetedDiscoveryIndex,
  type TrackedFileEnumerationResult,
} from "@agent-context/evidence";
import {
  EFFECTIVE_CONTEXT_CONTRACT_VERSION,
  EFFECTIVE_CONTEXT_INPUT_RECORD_KIND,
  buildDocumentImportDag,
  createSyntheticTargetTrace,
  resolveCodexCliAgents,
  resolveCopilotProfile,
  resolveEffectiveContext,
  type EffectiveContextResolution,
} from "@agent-context/resolver";
import {
  resolveAgentContextConfiguration,
  type ConfigurationResolutionSuccess,
} from "@agent-context/syntax";
import { describe, expect, it, vi } from "vitest";

import {
  CHANGED_FILE_MODE_CONTRACT_VERSION,
  CHANGED_FILE_MODE_INPUT_KIND,
  createChangedFileModeEvidenceAuthority,
  isIssuedRuleSchedulerSuccess,
  planChangedFileMode,
  scheduleRuleFamilies,
  type ChangedFileModeInput,
  type RuleSchedulerSuccess,
} from "../src/index.js";
import { fullRuleSchedulerInput } from "./helpers/rule-scheduler-full-families.js";

const HEAD = "1".repeat(40);
const BASE = "2".repeat(40);
const MERGE = "3".repeat(40);
const encoder = new TextEncoder();
const REPOSITORY_SELECTION = await selectRepositoryRoot(process.cwd(), { mode: "explicit" });
const SCAN_SCOPE = createChangedFileScanScope(REPOSITORY_SELECTION);
const EMPTY_INDEX_HEADER = Buffer.from([0x44, 0x49, 0x52, 0x43, 0, 0, 0, 2, 0, 0, 0, 0]);
const EMPTY_INDEX = Buffer.concat([
  EMPTY_INDEX_HEADER,
  createHash("sha1").update(EMPTY_INDEX_HEADER).digest(),
]);
const CONFIGURATION_RESULT = await resolveAgentContextConfiguration(process.cwd());
if (!CONFIGURATION_RESULT.ok) throw new Error("I07 fixture configuration resolution failed");
const CONFIGURATION: ConfigurationResolutionSuccess = CONFIGURATION_RESULT;

function path(value: string): RepositoryRelativePath {
  return canonicalizeRepositoryRelativePath(value);
}

function response(stdout: string | Uint8Array, exitCode = 0): GitMetadataResponse {
  return { exitCode, stdout: typeof stdout === "string" ? Buffer.from(stdout) : stdout };
}

function discovery(
  values: readonly string[] = [
    ".agent-context-lint.yml",
    ".gitignore",
    "AGENTS.md",
    "packages/api/index.ts",
    "src/main.ts",
    "unmapped.ts",
  ],
  uncertain = false,
): TargetedDiscoveryIndex {
  const listedPaths = Object.freeze(values.map(path).sort());
  const enumeration: TrackedFileEnumerationResult = Object.freeze({
    certainty: uncertain ? "all-files-not-tracked" : "tracked",
    ...(uncertain ? {} : { indexObjectFormat: "sha1" as const, indexVersion: 2 as const }),
    limits: TRACKED_FILE_ENUMERATION_DEFAULT_LIMITS,
    omittedProblems: 0,
    paths: listedPaths,
    problems: Object.freeze([]),
    reason: uncertain ? "git-index-missing" : "verified-git-index",
    source: uncertain ? "filesystem-fallback" : "git-index",
  });
  const ignored: IgnoreEngineResult = Object.freeze({
    appliedProfileFactIds: Object.freeze([]),
    certainty: uncertain ? "fallback-tracking-uncertain" : "exact-tracked-input",
    deferredProfileFacts: Object.freeze([]),
    ignored: Object.freeze([]),
    limits: IGNORE_ENGINE_DEFAULT_LIMITS,
    omittedProblems: 0,
    paths: listedPaths,
    problems: Object.freeze([]),
    profileCertainty: "known",
    profileFacts: Object.freeze([]),
    rules: Object.freeze([]),
    trackingCertainty: uncertain ? "fallback-mixed-unknown" : "tracked",
  });
  return buildTargetedDiscoveryIndex(enumeration, ignored);
}

const DISCOVERY = discovery();

async function metadata(
  entries: readonly {
    readonly path: string;
    readonly previousPath?: string;
    readonly status: "A" | "C100" | "D" | "M" | "R100" | "T";
  }[],
): Promise<GitChangedFileMetadata> {
  const parts: string[] = [];
  for (const entry of entries) {
    parts.push(entry.status, entry.previousPath ?? entry.path);
    if (entry.previousPath !== undefined) parts.push(entry.path);
  }
  const outputs = [
    response(`${HEAD}\n`),
    response(`${BASE}\n`),
    response(`${MERGE}\n`),
    response(Buffer.from(`${parts.join("\0")}\0`)),
    response(EMPTY_INDEX),
    response(""),
    response(`${HEAD}\n`),
  ];
  let call = 0;
  return collectGitChangedFileMetadata(
    createGitMetadataCapability(SCAN_SCOPE, () => outputs[call++] ?? response("", 1)),
    { baseReference: "main", signal: new AbortController().signal },
  );
}

function resolution(
  targetPath: string,
  options: {
    readonly document?: "present" | "absent";
    readonly externalContext?: "supplied" | "unavailable";
  } = {},
): EffectiveContextResolution {
  const target = path(targetPath);
  const profile = resolveCodexCliAgents({
    discovery: {
      certainty: "known",
      entries:
        options.document === "absent"
          ? []
          : [
              {
                bytes: encoder.encode("Run npm run missing\n"),
                errorCode: null,
                kind: "file",
                path: path("AGENTS.md"),
                resolvedTarget: null,
              },
            ],
      reason: "complete I07 fixture",
      rootMarkerPaths: [path(".git")],
    },
    externalContext:
      options.externalContext === "unavailable"
        ? { mode: "unavailable" }
        : { globalBase: null, globalOverride: null, mode: "supplied" },
    launchCwd: path("."),
    settings: {
      projectDocFallbackFilenames: [],
      projectDocMaxBytes: 32_768,
      projectRootMarkers: [".git"],
    },
    targetPath: target,
  });
  return resolveEffectiveContext({
    contractVersion: EFFECTIVE_CONTEXT_CONTRACT_VERSION,
    importDags: [],
    profileResolution: profile,
    recordKind: EFFECTIVE_CONTEXT_INPUT_RECORD_KIND,
    targetPath: target,
  });
}

async function importedResolution(
  targetPath: string,
  importPath = "shared.md",
): Promise<EffectiveContextResolution> {
  const sources: Readonly<Record<string, string>> = {
    "AGENTS.md": `@${importPath}\n`,
    [importPath]: "Shared imported policy.\n",
  };
  const repository: ReadOnlyRepository = {
    limits: READ_ONLY_REPOSITORY_DEFAULT_LIMITS,
    root: "/synthetic",
    inspect: () => Promise.reject(new Error("not used")),
    readDirectory: () => Promise.reject(new Error("not used")),
    readFile(value) {
      const sourcePath = path(String(value));
      const source = sources[sourcePath];
      if (source === undefined)
        throw new ReadOnlyRepositoryError(
          ReadOnlyRepositoryErrorCode.pathUnavailable,
          "missing synthetic source",
          "read-file",
          sourcePath,
        );
      return Promise.resolve(
        new ReadOnlyRepositoryFile(
          sourcePath,
          encoder.encode(source),
          { device: "fixture", inode: sourcePath },
          0,
        ),
      );
    },
    usage: () => ({ elapsedMs: 0, entries: 0, metadataOperations: 0, totalBytes: 0 }),
  };
  const graph = await loadImportGraph({
    entryPath: path("AGENTS.md"),
    repository,
    syntax: "claude-code",
  });
  const dag = buildDocumentImportDag({
    graph,
    trace: createSyntheticTargetTrace({
      launchCwd: path("."),
      purpose: "changed-file-mode-test",
      targetPath: path(targetPath),
      workspaceRoots: [path(".")],
    }),
  });
  const profile = resolveCodexCliAgents({
    discovery: {
      certainty: "known",
      entries: [
        {
          bytes: encoder.encode(`@${importPath}\n`),
          errorCode: null,
          kind: "file",
          path: path("AGENTS.md"),
          resolvedTarget: null,
        },
      ],
      reason: "complete I07 import fixture",
      rootMarkerPaths: [path(".git")],
    },
    externalContext: { globalBase: null, globalOverride: null, mode: "supplied" },
    launchCwd: path("."),
    settings: {
      projectDocFallbackFilenames: [],
      projectDocMaxBytes: 32_768,
      projectRootMarkers: [".git"],
    },
    targetPath: path(targetPath),
  });
  return resolveEffectiveContext({
    contractVersion: EFFECTIVE_CONTEXT_CONTRACT_VERSION,
    importDags: [dag],
    profileResolution: profile,
    recordKind: EFFECTIVE_CONTEXT_INPUT_RECORD_KIND,
    targetPath: path(targetPath),
  });
}

async function scheduler(
  parseState: "complete" | "malformed" = "complete",
): Promise<RuleSchedulerSuccess> {
  const result = await scheduleRuleFamilies(await fullRuleSchedulerInput({ parseState }), {
    maximumConcurrency: 3,
    scheduleSeed: 9173,
  });
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result;
}

function input(
  schedulerResult: RuleSchedulerSuccess,
  changedMetadata: GitChangedFileMetadata,
  resolutions: readonly EffectiveContextResolution[],
  overrides: Partial<ChangedFileModeInput> = {},
  discovered: TargetedDiscoveryIndex = DISCOVERY,
  configuration: ConfigurationResolutionSuccess = CONFIGURATION,
  criticalPathsComplete = true,
): ChangedFileModeInput {
  return {
    contractVersion: CHANGED_FILE_MODE_CONTRACT_VERSION,
    evidence: createChangedFileModeEvidenceAuthority(
      SCAN_SCOPE,
      REPOSITORY_SELECTION,
      configuration,
      discovered,
      resolutions,
      schedulerResult,
      criticalPathsComplete,
    ),
    metadata: changedMetadata,
    recordKind: CHANGED_FILE_MODE_INPUT_KIND,
    scope: SCAN_SCOPE,
    ...overrides,
  };
}

describe("I07 changed-file selection over E05 and F15", () => {
  it("enforces exact 4,096-path subset and critical-source completeness boundaries", async () => {
    const scheduled = await scheduler();
    const entries = (count: number): readonly { readonly path: string; readonly status: "M" }[] =>
      Array.from({ length: count }, (_, index) => ({
        path: `src/file-${String(index).padStart(4, "0")}.ts`,
        status: "M" as const,
      }));
    const atLimit = planChangedFileMode(input(scheduled, await metadata(entries(4_096)), []));
    const overLimit = planChangedFileMode(input(scheduled, await metadata(entries(4_097)), []));
    const incomplete = planChangedFileMode(
      input(
        scheduled,
        await metadata([{ path: "src/main.ts", status: "M" }]),
        [resolution("src/main.ts")],
        {},
        DISCOVERY,
        CONFIGURATION,
        false,
      ),
    );

    expect(atLimit.reason).not.toBe("resource-limit");
    expect(overLimit).toMatchObject({ mode: "full", reason: "resource-limit" });
    expect(incomplete).toMatchObject({ mode: "full", reason: "resource-limit" });
  });

  it("expands a changed target through its effective instruction scope and retains its diagnostics", async () => {
    const scheduled = await scheduler();
    expect(isIssuedRuleSchedulerSuccess(scheduled)).toBe(true);
    expect(isIssuedRuleSchedulerSuccess(structuredClone(scheduled))).toBe(false);
    const plan = planChangedFileMode(
      input(scheduled, await metadata([{ path: "src/main.ts", status: "M" }]), [
        resolution("src/main.ts"),
      ]),
    );
    expect(plan).toMatchObject({ mode: "changed", reason: null });
    expect(plan.changedPaths).toEqual(["src/main.ts"]);
    expect(plan.selectedPaths).toEqual(["AGENTS.md", "src/main.ts"]);
    expect(plan.includedDiagnosticIds.length).toBeGreaterThan(0);
    expect(plan.excludedDiagnosticIds).toEqual([]);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.selectedPaths)).toBe(true);
  });

  it("expands a changed instruction to every E05 target where it is effective", async () => {
    const scheduled = await scheduler();
    const plan = planChangedFileMode(
      input(scheduled, await metadata([{ path: "AGENTS.md", status: "M" }]), [
        resolution("packages/api/index.ts"),
        resolution("src/main.ts"),
      ]),
    );
    expect(plan.mode).toBe("changed");
    expect(plan.selectedPaths).toEqual(["AGENTS.md", "packages/api/index.ts", "src/main.ts"]);
    expect(plan.includedDiagnosticIds).toEqual(
      [...plan.includedDiagnosticIds].sort((left, right) =>
        Buffer.compare(Buffer.from(left), Buffer.from(right)),
      ),
    );
  });

  it("expands a changed imported instruction through its direct E05 dependency", async () => {
    const scheduled = await scheduler();
    const plan = planChangedFileMode(
      input(scheduled, await metadata([{ path: "shared.md", status: "M" }]), [
        await importedResolution("src/main.ts"),
      ]),
    );
    expect(plan).toMatchObject({ mode: "changed", reason: null });
    expect(plan.selectedPaths).toEqual(["AGENTS.md", "shared.md", "src/main.ts"]);
  });

  it("expands a shared import to every represented E05 target that consumes it", async () => {
    const scheduled = await scheduler();
    const resolutions = await Promise.all([
      importedResolution("packages/api/index.ts"),
      importedResolution("src/main.ts"),
    ]);
    const plan = planChangedFileMode(
      input(scheduled, await metadata([{ path: "shared.md", status: "M" }]), resolutions),
    );
    expect(plan).toMatchObject({ mode: "changed", reason: null });
    expect(plan.selectedPaths).toEqual([
      "AGENTS.md",
      "packages/api/index.ts",
      "shared.md",
      "src/main.ts",
    ]);
  });

  it("is byte-stable under E05 input-order perturbation", async () => {
    const scheduled = await scheduler();
    const changed = await metadata([{ path: "AGENTS.md", status: "M" }]);
    const resolutions = [resolution("z.ts"), resolution("a.ts")];
    const first = planChangedFileMode(input(scheduled, changed, resolutions));
    const second = planChangedFileMode(input(scheduled, changed, resolutions.toReversed()));
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it.each([
    ["D", "structural-change"],
    ["R100", "structural-change"],
    ["C100", "structural-change"],
    ["T", "structural-change"],
  ] as const)("uses a full fallback for structural status %s", async (status, reason) => {
    const scheduled = await scheduler();
    const changed =
      status === "R100" || status === "C100"
        ? await metadata([{ path: "renamed.ts", previousPath: "old.ts", status }])
        : await metadata([{ path: "src/main.ts", status }]);
    const plan = planChangedFileMode(input(scheduled, changed, [resolution("src/main.ts")]));
    expect(plan).toMatchObject({ mode: "full", reason });
    expect(plan.includedDiagnosticIds).toHaveLength(scheduled.bundle.diagnostics.length);
    expect(plan.excludedDiagnosticIds).toEqual([]);
  });

  it("falls back for control changes, incomplete E05, and unmapped paths/instructions", async () => {
    const scheduled = await scheduler();
    const control = planChangedFileMode(
      input(scheduled, await metadata([{ path: ".agent-context-lint.yml", status: "M" }]), [
        resolution("src/main.ts"),
      ]),
    );
    expect(control).toMatchObject({ mode: "full", reason: "configuration-changed" });

    const discoveredControl = planChangedFileMode(
      input(scheduled, await metadata([{ path: ".gitignore", status: "M" }]), [
        resolution("src/main.ts"),
      ]),
    );
    expect(discoveredControl).toMatchObject({ mode: "full", reason: "configuration-changed" });

    const externalOnly = planChangedFileMode(
      input(scheduled, await metadata([{ path: "src/main.ts", status: "M" }]), [
        resolution("src/main.ts", { externalContext: "unavailable" }),
      ]),
    );
    expect(externalOnly).toMatchObject({ mode: "changed", reason: null });

    const instruction = planChangedFileMode(
      input(scheduled, await metadata([{ path: "AGENTS.md", status: "M" }]), [
        resolution("src/main.ts", { document: "absent" }),
      ]),
    );
    expect(instruction).toMatchObject({ mode: "full", reason: "unmapped-instruction-change" });

    const target = planChangedFileMode(
      input(scheduled, await metadata([{ path: "unmapped.ts", status: "M" }]), [
        resolution("src/main.ts"),
      ]),
    );
    expect(target).toMatchObject({ mode: "full", reason: "unmapped-changed-path" });
  });

  it("falls back when E05 cannot prove target and activation dependency scope", async () => {
    const scheduled = await scheduler();
    const copilot = resolveCopilotProfile({
      candidates: [
        {
          bytes: encoder.encode("Repository policy.\n"),
          format: "repository-wide",
          path: path(".github/copilot-instructions.md"),
        },
      ],
      profileId: "copilot-vscode",
      runtime: {
        applyingInstructions: "enabled",
        eventState: "present",
        instructionFolders: [{ path: path(".github/instructions"), workspaceRoot: path(".") }],
        kind: "copilot-vscode",
        manualAttachments: [],
        targetPaths: [path("other/main.ts")],
        workspaceRoots: [path(".")],
      },
    });
    const unresolved = resolveEffectiveContext({
      contractVersion: EFFECTIVE_CONTEXT_CONTRACT_VERSION,
      importDags: [],
      profileResolution: copilot,
      recordKind: EFFECTIVE_CONTEXT_INPUT_RECORD_KIND,
      targetPath: path("src/main.ts"),
    });
    expect(unresolved.ambiguities.map((entry) => entry.kind)).toEqual(
      expect.arrayContaining(["activation", "target-scope"]),
    );

    const plan = planChangedFileMode(
      input(scheduled, await metadata([{ path: "src/main.ts", status: "M" }]), [unresolved]),
    );
    expect(plan).toMatchObject({ mode: "full", reason: "incomplete-resolution" });
  });

  it("derives the custom standards lockfile from issued B06 configuration evidence", async () => {
    const configured = await resolveAgentContextConfiguration(process.cwd(), {
      cliOverrides: { standards: { lockfile: "config/custom-standards.lock.json" } },
    });
    if (!configured.ok) throw new Error("custom I07 fixture configuration resolution failed");
    const scheduled = await scheduler();
    const plan = planChangedFileMode(
      input(
        scheduled,
        await metadata([{ path: "config/custom-standards.lock.json", status: "M" }]),
        [resolution("src/main.ts")],
        {},
        DISCOVERY,
        configured,
      ),
    );
    expect(plan).toMatchObject({ mode: "full", reason: "configuration-changed" });
  });

  it("uses a structural full fallback when the root configuration is deleted", async () => {
    const scheduled = await scheduler();
    const plan = planChangedFileMode(
      input(scheduled, await metadata([{ path: ".agent-context-lint.yml", status: "D" }]), [
        resolution("src/main.ts"),
      ]),
    );
    expect(plan).toMatchObject({ mode: "full", reason: "structural-change" });
  });

  it("rejects forged scheduler, metadata, E05, sparse arrays, and accessor inputs", async () => {
    const scheduled = await scheduler();
    const changed = await metadata([{ path: "src/main.ts", status: "M" }]);
    const resolved = resolution("src/main.ts");
    const valid = input(scheduled, changed, [resolved]);
    const cases: ChangedFileModeInput[] = [
      { ...valid, evidence: structuredClone(valid.evidence) },
      input(scheduled, structuredClone(changed), [resolved]),
    ];
    for (const candidate of cases)
      expect(planChangedFileMode(candidate)).toMatchObject({
        mode: "full",
        reason: "invalid-input",
      });
    expect(() =>
      createChangedFileModeEvidenceAuthority(
        SCAN_SCOPE,
        REPOSITORY_SELECTION,
        CONFIGURATION,
        DISCOVERY,
        [structuredClone(resolved)],
        scheduled,
      ),
    ).toThrow(TypeError);
    expect(() =>
      createChangedFileModeEvidenceAuthority(
        SCAN_SCOPE,
        REPOSITORY_SELECTION,
        CONFIGURATION,
        discovery(["AGENTS.md", "nested/AGENTS.md"]),
        [resolved],
        scheduled,
      ),
    ).toThrow(TypeError);
    expect(() =>
      createChangedFileModeEvidenceAuthority(
        SCAN_SCOPE,
        REPOSITORY_SELECTION,
        CONFIGURATION,
        DISCOVERY,
        Array.from({ length: 2 }) as never,
        scheduled,
      ),
    ).toThrow(TypeError);
    expect(() =>
      createChangedFileModeEvidenceAuthority(
        SCAN_SCOPE,
        REPOSITORY_SELECTION,
        CONFIGURATION,
        structuredClone(DISCOVERY),
        [resolved],
        scheduled,
      ),
    ).toThrow(TypeError);
    expect(() =>
      createChangedFileModeEvidenceAuthority(
        SCAN_SCOPE,
        REPOSITORY_SELECTION,
        structuredClone(CONFIGURATION),
        DISCOVERY,
        [resolved],
        scheduled,
      ),
    ).toThrow(TypeError);

    const getter = vi.fn(() => valid.evidence);
    const hostile = Object.create(null) as Record<string, unknown>;
    for (const [key, value] of Object.entries(input(scheduled, changed, [resolved]))) {
      if (key !== "evidence") Object.defineProperty(hostile, key, { enumerable: true, value });
    }
    Object.defineProperty(hostile, "evidence", { enumerable: true, get: getter });
    expect(planChangedFileMode(hostile as never)).toMatchObject({
      mode: "full",
      reason: "invalid-input",
    });
    expect(getter).not.toHaveBeenCalled();
  });

  it("keeps the complete F15 diagnostic set when Git metadata is unavailable", async () => {
    const scheduled = await scheduler();
    const failed = await collectGitChangedFileMetadata(
      createGitMetadataCapability(SCAN_SCOPE, () => response("private failure", 1)),
      { baseReference: "main", signal: new AbortController().signal },
    );
    const plan = planChangedFileMode(input(scheduled, failed, [resolution("src/main.ts")]));
    expect(plan).toMatchObject({ mode: "full", reason: "git-metadata-unavailable" });
    expect(plan.includedDiagnosticIds).toHaveLength(scheduled.bundle.diagnostics.length);
    expect(JSON.stringify(plan)).not.toContain("private failure");
  });

  it("uses a full fallback when C05 could not prove a complete tracked inventory", async () => {
    const scheduled = await scheduler();
    const plan = planChangedFileMode(
      input(
        scheduled,
        await metadata([{ path: "src/main.ts", status: "M" }]),
        [resolution("src/main.ts")],
        {},
        discovery(undefined, true),
      ),
    );
    expect(plan).toMatchObject({ mode: "full", reason: "incomplete-discovery" });
    expect(plan.includedDiagnosticIds).toHaveLength(scheduled.bundle.diagnostics.length);
  });

  it("keeps all F15 diagnostics when any issued source has an incomplete parse state", async () => {
    const scheduled = await scheduler("malformed");
    const plan = planChangedFileMode(
      input(scheduled, await metadata([{ path: "src/main.ts", status: "M" }]), [
        resolution("src/main.ts"),
      ]),
    );
    expect(plan).toMatchObject({ mode: "full", reason: "incomplete-parser-result" });
    expect(plan.includedDiagnosticIds).toHaveLength(scheduled.bundle.diagnostics.length);
  });

  it("rejects cross-repository replay between opaque scan-operation scopes", async () => {
    const scheduled = await scheduler();
    const changed = await metadata([{ path: "src/main.ts", status: "M" }]);
    const otherScope = createChangedFileScanScope(REPOSITORY_SELECTION);
    const otherEvidence = createChangedFileModeEvidenceAuthority(
      otherScope,
      REPOSITORY_SELECTION,
      CONFIGURATION,
      DISCOVERY,
      [resolution("src/main.ts")],
      scheduled,
    );
    const mixed = input(scheduled, changed, [resolution("src/main.ts")], {
      evidence: otherEvidence,
      scope: otherScope,
    });
    expect(planChangedFileMode(mixed)).toMatchObject({ mode: "full", reason: "invalid-input" });
    expect(JSON.stringify(planChangedFileMode(mixed))).not.toContain("/private/");
  });

  it("rejects issued configuration/discovery/scheduler evidence swapped between real roots", async () => {
    const firstRoot = await mkdtemp(join(tmpdir(), "agent-context-i07-first-"));
    const secondRoot = await mkdtemp(join(tmpdir(), "agent-context-i07-second-"));
    try {
      await Promise.all([
        mkdir(join(firstRoot, ".git")),
        mkdir(join(secondRoot, ".git")),
        writeFile(join(firstRoot, "AGENTS.md"), "First repository.\n"),
        writeFile(join(secondRoot, "AGENTS.md"), "Second repository.\n"),
      ]);
      await Promise.all([
        writeFile(join(firstRoot, ".git", "HEAD"), "ref: refs/heads/main\n"),
        writeFile(join(secondRoot, ".git", "HEAD"), "ref: refs/heads/main\n"),
      ]);
      const [firstSelection, secondSelection, firstConfiguration, secondConfiguration] =
        await Promise.all([
          selectRepositoryRoot(firstRoot, { mode: "explicit" }),
          selectRepositoryRoot(secondRoot, { mode: "explicit" }),
          resolveAgentContextConfiguration(firstRoot),
          resolveAgentContextConfiguration(secondRoot),
        ]);
      if (!firstConfiguration.ok || !secondConfiguration.ok)
        throw new Error("cross-root I07 fixture configuration failed");
      const firstScope = createChangedFileScanScope(firstSelection);
      const firstDiscovery = discovery(["AGENTS.md"]);
      const secondDiscovery = discovery(["AGENTS.md"]);
      const [firstScheduler, secondScheduler] = await Promise.all([scheduler(), scheduler()]);
      const resolved = [resolution("src/main.ts")];

      expect(() =>
        createChangedFileModeEvidenceAuthority(
          firstScope,
          firstSelection,
          firstConfiguration,
          firstDiscovery,
          resolved,
          firstScheduler,
        ),
      ).not.toThrow();
      expect(() =>
        createChangedFileModeEvidenceAuthority(
          firstScope,
          firstSelection,
          secondConfiguration,
          secondDiscovery,
          resolved,
          secondScheduler,
        ),
      ).toThrow(TypeError);
      expect(secondSelection.identity).not.toEqual(firstSelection.identity);
    } finally {
      await Promise.all([
        rm(firstRoot, { force: true, recursive: true }),
        rm(secondRoot, { force: true, recursive: true }),
      ]);
    }
  });
});
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
