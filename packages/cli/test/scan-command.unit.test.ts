import { mkdtemp, readFile, rm, writeFile, mkdir, readdir, symlink } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  BUILTIN_ESTIMATE_IDENTITY,
  accountOccurrenceTokens,
  countEstimatedTokens,
  type ContextEfficiencyReport,
  type EfficiencyMetricProfileInput,
} from "@agent-context/efficiency";
import { compareRepositoryRelativePaths } from "@agent-context/core";
import type { RepositoryRelativePath } from "@agent-context/core";
import {
  createReadOnlyRepository,
  loadImportGraph,
  selectRepositoryRoot,
} from "@agent-context/evidence";
import { buildDocumentImportDag, createSyntheticTargetTrace } from "@agent-context/resolver";
import type { ChangedFileModeResult } from "@agent-context/rules";
import { loadBundledKnowledgePack, serializeStandardsLockfile } from "@agent-context/standards";
import { afterEach, describe, expect, test, vi } from "vitest";

import { CLI_LIMITS, runCommandRouter, type CliInvocation } from "../src/command-router.js";
import { createEfficiencyCommandHandlers } from "../src/efficiency-command.js";
import { createScanEfficiencySource } from "../src/efficiency-source.js";
import { createNodeGitMetadataExecutor } from "../src/git-metadata-executor.js";
import {
  aggregateProfileVersions,
  classifyOccurrenceDecision,
  createScanCommandHandlers,
  writeBoundedScanOutput,
} from "../src/scan-command.js";

const roots: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function repository(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "agent-context-scan-"));
  roots.push(root);
  for (const [relative, text] of Object.entries(files)) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, text, "utf8");
  }
  await execFileAsync("git", ["init", "--quiet", root]);
  await execFileAsync("git", ["-C", root, "add", "."]);
  return root;
}

async function commitRepository(root: string, message = "fixture base"): Promise<string> {
  await execFileAsync(
    "git",
    [
      "-C",
      root,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--quiet",
      "-m",
      message,
    ],
    { env: { GIT_CONFIG_NOSYSTEM: "1", PATH: process.env["PATH"] } },
  );
  return (
    await execFileAsync("git", ["-C", root, "rev-parse", "HEAD"], {
      env: { GIT_CONFIG_NOSYSTEM: "1", PATH: process.env["PATH"] },
    })
  ).stdout.trim();
}

async function invoke(
  root: string,
  argv: readonly string[],
  controller = new AbortController(),
  observeSampling?: Parameters<typeof createScanCommandHandlers>[0]["observeSampling"],
  observeMetricProfiles?: (profiles: readonly EfficiencyMetricProfileInput[]) => void,
  observeParsed?: Parameters<typeof createScanCommandHandlers>[0]["observeParsed"],
  observeActivationRules?: Parameters<
    typeof createScanCommandHandlers
  >[0]["observeActivationRules"],
  environment: "ci" | "local" = "local",
  observeEfficiencyReport?: (report: ContextEfficiencyReport) => void,
  observePortabilityFormatObservations?: Parameters<
    typeof createScanCommandHandlers
  >[0]["observePortabilityFormatObservations"],
  observeEfficiencyScenarios?: Parameters<
    typeof createScanCommandHandlers
  >[0]["observeEfficiencyScenarios"],
): Promise<{ readonly exitCode: number; readonly stderr: string; readonly stdout: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const invocation: CliInvocation = {
    argv,
    signal: controller.signal,
    stderr: { write: (text) => void stderr.push(text) },
    stdout: { write: (text) => void stdout.push(text) },
  };
  let reported: unknown;
  const result = await runCommandRouter(
    invocation,
    createScanCommandHandlers({
      environment,
      now: () => "2026-08-08T00:00:00Z",
      ...(observeSampling === undefined ? {} : { observeSampling }),
      ...(observeMetricProfiles === undefined ? {} : { observeMetricProfiles }),
      ...(observeParsed === undefined ? {} : { observeParsed }),
      ...(observeActivationRules === undefined ? {} : { observeActivationRules }),
      ...(observeEfficiencyReport === undefined ? {} : { observeEfficiencyReport }),
      ...(observeEfficiencyScenarios === undefined ? {} : { observeEfficiencyScenarios }),
      ...(observePortabilityFormatObservations === undefined
        ? {}
        : { observePortabilityFormatObservations }),
      reportError: (error) => {
        reported = error;
      },
      workingDirectory: root,
    }),
  );
  if (reported !== undefined && result.exitCode === 2 && process.env["DEBUG_SCAN_TEST"] === "1")
    throw reported instanceof Error ? reported : new Error("scan reported a non-error failure");
  return { exitCode: result.exitCode, stderr: stderr.join(""), stdout: stdout.join("") };
}

async function invokeChanged(
  root: string,
  argv: readonly string[],
  observeChangedFileMode?: Parameters<
    typeof createScanCommandHandlers
  >[0]["observeChangedFileMode"],
  createGitMetadataExecutor: NonNullable<
    Parameters<typeof createScanCommandHandlers>[0]["createGitMetadataExecutor"]
  > = createNodeGitMetadataExecutor,
): Promise<{ readonly exitCode: number; readonly stderr: string; readonly stdout: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let reported: unknown;
  const result = await runCommandRouter(
    {
      argv,
      signal: new AbortController().signal,
      stderr: { write: (text: string): void => void stderr.push(text) },
      stdout: { write: (text: string): void => void stdout.push(text) },
    },
    createScanCommandHandlers({
      createGitMetadataExecutor,
      environment: "local",
      now: () => "2026-08-08T00:00:00Z",
      ...(observeChangedFileMode === undefined ? {} : { observeChangedFileMode }),
      reportError: (error) => {
        reported = error;
      },
      workingDirectory: root,
    }),
  );
  if (reported !== undefined && process.env["DEBUG_CHANGED_SCAN_TEST"] === "1")
    throw reported instanceof Error ? reported : new Error("changed scan reported a failure");
  return { exitCode: result.exitCode, stderr: stderr.join(""), stdout: stdout.join("") };
}

async function validStandardsLock(): Promise<string> {
  const bundled = await loadBundledKnowledgePack({ channel: "stable", engineVersion: "0.0.0" });
  if (!bundled.ok) throw new Error(JSON.stringify(bundled.issues));
  const serialized = serializeStandardsLockfile({
    channel: bundled.value.pack.channel,
    pack: {
      packId: bundled.value.pack.packId,
      packVersion: bundled.value.pack.packVersion,
      publishedAt: bundled.value.pack.publishedAt,
      schemaVersion: bundled.value.pack.schemaVersion,
    },
    recordKind: "agent-context-standards-lock",
    schemaVersion: "1.0.0",
    target: structuredClone(bundled.value.provenance.target),
    trustedState: structuredClone(bundled.value.provenance.trustedState),
    verificationTime: bundled.value.provenance.verificationTime,
  });
  if (!serialized.ok) throw new Error(JSON.stringify(serialized.issues));
  return serialized.text;
}

describe("I02 production scan command", () => {
  test("aggregates multi-surface profile versions without order-dependent client claims", () => {
    const contexts: Parameters<typeof aggregateProfileVersions>[0] = [
      {
        clientVersion: "0.50.0-cli",
        profileId: "cursor-agent",
        profileVersion: "0.1.0",
      },
      {
        clientVersion: "0.50.0-ide",
        profileId: "cursor-agent",
        profileVersion: "0.1.0",
      },
    ];
    const expected = {
      "cursor-agent": { clientVersion: null, profileVersion: "0.1.0" },
    };
    expect(aggregateProfileVersions(contexts, new Set(["cursor-agent"]))).toEqual(expected);
    expect(aggregateProfileVersions([...contexts].reverse(), new Set(["cursor-agent"]))).toEqual(
      expected,
    );
    expect(() =>
      aggregateProfileVersions(
        [
          ...contexts,
          {
            clientVersion: "0.50.0-cli",
            profileId: "cursor-agent",
            profileVersion: "0.2.0",
          },
        ],
        new Set(["cursor-agent"]),
      ),
    ).toThrow("disagree on the cursor-agent profile contract version");
  });

  test("streams scalar-safe bounded output with backpressure and preflights total size", async () => {
    const output = `prefix-${"🙂".repeat(400_000)}-suffix`;
    const chunks: string[] = [];
    let active = 0;
    let maximumActive = 0;
    await writeBoundedScanOutput(async (chunk): Promise<void> => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await Promise.resolve();
      chunks.push(chunk);
      active -= 1;
    }, output);
    expect(chunks.length).toBeGreaterThan(1);
    expect(maximumActive).toBe(1);
    expect(chunks.join("")).toBe(output);
    expect(
      chunks.every(
        (chunk) =>
          Buffer.byteLength(chunk, "utf8") <= CLI_LIMITS.maximumOutputChunkBytes &&
          !/[\uD800-\uDBFF]$/u.test(chunk) &&
          !/^[\uDC00-\uDFFF]/u.test(chunk),
      ),
    ).toBe(true);

    let writes = 0;
    await expect(
      writeBoundedScanOutput(
        (): Promise<void> => {
          writes += 1;
          return Promise.resolve();
        },
        "x".repeat(CLI_LIMITS.maximumOutputBytes + 1),
      ),
    ).rejects.toThrow("exceeds the aggregate byte limit");
    expect(writes).toBe(0);
  });

  test("composes the efficiency command from genuine production scan evidence", async () => {
    const root = await repository({
      "AGENTS.md": "Keep changes focused.\n",
      "src/main.ts": "export const main = true;\n",
    });
    const stdout: string[] = [];
    const stderr: string[] = [];
    const result = await runCommandRouter(
      {
        argv: ["efficiency", root, "--format", "json", "--agent", "codex-cli"],
        signal: new AbortController().signal,
        stderr: { write: (text: string) => void stderr.push(text) },
        stdout: { write: (text: string) => void stdout.push(text) },
      },
      createEfficiencyCommandHandlers({
        source: createScanEfficiencySource({ environment: "local", workingDirectory: root }),
      }),
    );
    expect(result.exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(JSON.parse(stdout.join(""))).toMatchObject({
      qualityClaim: false,
      recordKind: "agent-context-efficiency-report",
      semanticQualityPreservationClaim: false,
    });
  });

  test("scans repository evidence through the scheduler and emits native JSON", async () => {
    const root = await repository({
      "AGENTS.md": "Run npm run missing-task before committing.\n",
      "package.json": '{"name":"fixture","scripts":{"test":"vitest"}}\n',
    });
    const result = await invoke(root, [
      "scan",
      "--format",
      "json",
      "--rule",
      "ACL300",
      "--fail-on",
      "warning",
    ]);
    expect(result.stderr).toBe("");
    const output = JSON.parse(result.stdout) as {
      diagnostics: { diagnostics: readonly { ruleId: string }[] };
      recordKind: string;
    };
    expect(output.recordKind).toBe("agent-context-scan-output");
    const ruleIds = output.diagnostics.diagnostics.map((entry) => entry.ruleId);
    expect(ruleIds).toContain("ACL300");
    expect(result.exitCode, JSON.stringify(ruleIds)).toBe(1);
  });

  test("applies configured package-manager and ACL350 token policies", async () => {
    const root = await repository({
      ".agent-context-lint.yml":
        "version: 1\ncommands:\n  packageManager: pnpm\nrules:\n  ACL350:\n    severity: warning\n    maxTokens: 1\n",
      ".claude/rules/repository.md":
        "Run npm test before committing. Keep this instruction deliberately long.\n",
      "src/main.ts": "export {};\n",
    });
    const result = await invoke(root, [
      "scan",
      "--format",
      "json",
      "--rule",
      "ACL301",
      "--rule",
      "ACL350",
      "--fail-on",
      "never",
    ]);
    expect(result.stderr).toBe("");
    const ruleIds = (
      JSON.parse(result.stdout) as {
        diagnostics: { diagnostics: readonly { ruleId: string }[] };
      }
    ).diagnostics.diagnostics.map((entry) => entry.ruleId);
    expect(ruleIds).toEqual(expect.arrayContaining(["ACL301", "ACL350"]));

    const resetRoot = await repository({
      ".agent-context-lint.yml":
        "version: 1\ncommands:\n  packageManager: auto\nrules:\n  ACL350:\n    severity: warning\n    maxTokens: null\n",
      ".claude/rules/repository.md": "Run npm test before committing.\n",
    });
    const reset = await invoke(resetRoot, [
      "scan",
      "--format",
      "json",
      "--rule",
      "ACL301",
      "--rule",
      "ACL350",
      "--fail-on",
      "never",
    ]);
    const resetRuleIds = (
      JSON.parse(reset.stdout) as {
        diagnostics: { diagnostics: readonly { ruleId: string }[] };
      }
    ).diagnostics.diagnostics.map((entry) => entry.ruleId);
    expect(resetRuleIds).not.toContain("ACL301");
    expect(resetRuleIds).not.toContain("ACL350");
  });

  test("passes resolved efficiency configuration into the issued score", async () => {
    const root = await repository({
      ".agent-context-lint.yml":
        "version: 1\nefficiency:\n  budgets:\n    alwaysOnTokens: 7\n    effectiveP95Tokens: 9\n",
      "AGENTS.md": "Repository policy.\n",
      "src/main.ts": "export {};\n",
    });
    let report: ContextEfficiencyReport | undefined;
    const result = await invoke(
      root,
      ["scan", "--rule", "ACL550", "--fail-on", "never"],
      new AbortController(),
      undefined,
      undefined,
      undefined,
      undefined,
      "local",
      (value) => {
        report = value;
      },
    );
    expect(result.stderr).toBe("");
    expect(report?.score.configuration.budgets).toMatchObject({
      alwaysOnTokens: 7,
      effectiveP95Tokens: 9,
    });
  });

  test("projects a real exact-duplicate counterfactual through G08", async () => {
    const duplicate = "Run tests before committing.\n";
    const root = await repository({
      "AGENTS.md": duplicate,
      "src/AGENTS.md": duplicate,
      "src/main.ts": "export {};\n",
    });
    let report: ContextEfficiencyReport | undefined;
    let scenarioCount = -1;
    let duplicateClusterCount = -1;
    const result = await invoke(
      root,
      ["scan", "--profile", "codex-cli", "--rule", "ACL552", "--fail-on", "never"],
      new AbortController(),
      undefined,
      undefined,
      undefined,
      undefined,
      "local",
      (value) => {
        report = value;
      },
      undefined,
      (metrics, scenarios) => {
        duplicateClusterCount = metrics.duplication.exact.clusters.length;
        scenarioCount = scenarios.length;
      },
    );
    expect(result.stderr).toBe("");
    expect(duplicateClusterCount).toBe(1);
    expect(scenarioCount).toBe(1);
    expect(report?.recommendations.evaluations[0]).toMatchObject({
      baselineTokens: null,
      kind: "exact-duplicate-consolidation",
      projectedTokens: null,
      reasonCodes: [
        "baseline-metrics-mismatch",
        "content-retention-unknown",
        "evidence-incomplete",
        "no-saving-target",
        "projection-partial",
        "tokenizer-unavailable",
      ],
      state: "indeterminate",
    });
    expect(report?.recommendations.evaluations[0]?.targetProjections[0]?.retention).toMatchObject({
      missingContentSha256s: [],
      mode: "unique-content-identities",
      state: "unknown",
    });
    expect(report?.recommendations.recommendations).toEqual([]);
  });

  test("keeps identical syntax findings at distinct paths uniquely addressable", async () => {
    const invalid = "---\npaths: src/**/*.ts\n---\nPolicy.\n";
    const root = await repository({
      ".claude/rules/first.md": invalid,
      ".claude/rules/second.md": invalid,
      "src/main.ts": "export {};\n",
    });
    const result = await invoke(root, [
      "scan",
      "--format",
      "json",
      "--profile",
      "claude-code",
      "--rule",
      "ACL101",
      "--fail-on",
      "never",
    ]);
    expect(result.stderr).toBe("");
    const diagnostics = (
      JSON.parse(result.stdout) as {
        diagnostics: {
          diagnostics: readonly {
            fingerprints: { semantic: { value: string } };
            id: string;
            ruleId: string;
          }[];
        };
      }
    ).diagnostics.diagnostics;
    expect(diagnostics.map((entry) => entry.ruleId)).toEqual(["ACL101", "ACL101"]);
    expect(new Set(diagnostics.map((entry) => entry.id)).size).toBe(2);
    expect(new Set(diagnostics.map((entry) => entry.fingerprints.semantic.value)).size).toBe(1);
  });

  test("honors import depth and fan-out limits without leaving the repository jail", async () => {
    const root = await repository({
      ".agent-context-lint.yml": "version: 1\nlimits:\n  maxImportDepth: 1\n  maxImportFanOut: 1\n",
      "CLAUDE.md": "@one.md\n@two.md\n",
      "one.md": "@deep.md\nOne.\n",
      "two.md": "Two.\n",
      "deep.md": "Deep.\n",
    });
    let issueCodes: readonly string[] = [];
    const result = await invoke(
      root,
      ["scan", "--profile", "claude-code", "--rule", "ACL156", "--fail-on", "never"],
      new AbortController(),
      undefined,
      undefined,
      (parsed) => {
        issueCodes = parsed.graphs.flatMap((entry) =>
          entry.graph.issues.map((issue) => issue.code),
        );
      },
    );
    expect(result.stderr).toBe("");
    expect(issueCodes).toEqual(
      expect.arrayContaining(["IMPORT_GRAPH_DEPTH_LIMIT", "IMPORT_GRAPH_FAN_OUT_LIMIT"]),
    );
  });

  test("maps security allowances only to their corresponding policy diagnostics", async () => {
    const scan = async (security: string): Promise<readonly string[]> => {
      const root = await repository({
        ".agent-context-lint.yml": `version: 1\nsecurity:\n${security}`,
        "CLAUDE.md": "@../outside.md\n@/etc/passwd\n@https://example.com/rules.md\n",
      });
      const result = await invoke(root, [
        "scan",
        "--format",
        "json",
        "--profile",
        "claude-code",
        "--rule",
        "ACL152",
        "--rule",
        "ACL153",
        "--rule",
        "ACL154",
        "--rule",
        "ACL406",
        "--fail-on",
        "never",
      ]);
      expect(result.stderr).toBe("");
      return (
        JSON.parse(result.stdout) as {
          diagnostics: { diagnostics: readonly { ruleId: string }[] };
        }
      ).diagnostics.diagnostics.map((entry) => entry.ruleId);
    };
    const denied = await scan("  allowAbsolutePaths: false\n  allowNetworkReferences: false\n");
    expect(denied).toEqual(expect.arrayContaining(["ACL152", "ACL153", "ACL154", "ACL406"]));
    const allowed = await scan("  allowAbsolutePaths: true\n  allowNetworkReferences: true\n");
    expect(allowed).toContain("ACL152");
    expect(allowed).toContain("ACL406");
    expect(allowed).not.toContain("ACL153");
    expect(allowed).not.toContain("ACL154");
  });

  test("uses stable bundled evidence for offline preview and ignores unknown configured rule IDs", async () => {
    const root = await repository({
      ".agent-context-lint.yml":
        "version: 1\nstandards:\n  channel: preview\nrules:\n  ACL999: off\n",
      "AGENTS.md": "Repository policy.\n",
    });
    const result = await invoke(root, ["scan", "--fail-on", "never"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
  });

  test("routes Cursor MDC through vendor syntax and honors suppressions", async () => {
    const root = await repository({
      ".cursor/rules/broken.mdc":
        "---\nglobs: ../escape\nunknown: true\n---\n<!-- agent-context-lint-disable-next-line ACL300 -- reason: fixture -->\nRun npm run absent\n",
      "package.json": '{"name":"fixture","scripts":{}}\n',
    });
    const result = await invoke(root, ["scan", "--format", "json", "--fail-on", "warning"]);
    expect(result.stderr).toBe("");
    const output = JSON.parse(result.stdout) as {
      diagnostics: {
        diagnostics: readonly { ruleId: string }[];
        suppressions: readonly { state: string }[];
      };
    };
    expect(output.diagnostics.diagnostics.map((entry) => entry.ruleId)).toEqual(
      expect.arrayContaining(["ACL102", "ACL103"]),
    );
    const suppressionStates = output.diagnostics.suppressions.map((entry) => entry.state);
    expect(suppressionStates, JSON.stringify(suppressionStates)).toContain("suppressed");
  });

  test("is deterministic and supports stylish and SARIF renderers", async () => {
    const root = await repository({ "AGENTS.md": "Never expose an API token.\n" });
    const first = await invoke(root, ["scan", "--format", "json"]);
    const second = await invoke(root, ["scan", "--format", "json"]);
    expect(second).toEqual(first);
    expect(
      (JSON.parse(first.stdout) as { profileVersions: Record<string, unknown> }).profileVersions,
    ).toMatchObject({
      "cursor-agent": { clientVersion: null, profileVersion: "0.1.0" },
    });
    expect((await invoke(root, ["scan", "--format", "stylish"])).stdout).toContain("problem");
    const sarif = await invoke(root, ["scan", "--format", "sarif"]);
    expect(JSON.parse(sarif.stdout)).toMatchObject({
      runs: [
        {
          properties: {
            profileVersions: {
              "cursor-agent": { clientVersion: null, profileVersion: "0.1.0" },
            },
          },
        },
      ],
      version: "2.1.0",
    });
  });

  test("does not connect, execute child processes, or modify repository files", async () => {
    const root = await repository({ "AGENTS.md": "Keep changes focused.\n" });
    const before = await readFile(path.join(root, "AGENTS.md"), "utf8");
    const namesBefore = await readdir(root);
    const net = await import("node:net");
    const connect = vi.spyOn(net.Socket.prototype, "connect");
    const result = await invoke(root, ["scan", "--format", "json"]);
    expect(result.stderr).toBe("");
    expect(connect).not.toHaveBeenCalled();
    expect(await readFile(path.join(root, "AGENTS.md"), "utf8")).toBe(before);
    expect(await readdir(root)).toEqual(namesBefore);
  });

  test("accepts an empty repository without inventing diagnostics", async () => {
    const root = await repository({});
    const result = await invoke(root, ["scan", "--format", "json"]);
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      diagnostics: { diagnostics: [] },
      recordKind: "agent-context-scan-output",
    });
  });

  test("scans a source-only repository with an honest zero context accounting", async () => {
    const root = await repository({ "src/main.ts": "export const main = true;\n" });
    let profiles: readonly EfficiencyMetricProfileInput[] = [];
    const result = await invoke(
      root,
      ["scan", "--format", "json", "--profile", "codex-cli"],
      new AbortController(),
      undefined,
      (observed) => {
        profiles = observed;
      },
    );
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ diagnostics: { diagnostics: [] } });
    expect(profiles).toHaveLength(1);
    expect(profiles[0]?.accountings).toHaveLength(1);
    expect(profiles[0]?.accountings[0]?.accounting).toMatchObject({
      state: "complete",
      totals: { always: 0, effective: 0, imported: 0, raw: 0, unique: 0 },
    });
  });

  test("does not charge a profile for another profile's document", async () => {
    const text = "Claude-only policy.\n";
    const root = await repository({
      "CLAUDE.md": text,
      "src/main.ts": "export const main = true;\n",
    });
    let profiles: readonly EfficiencyMetricProfileInput[] = [];
    const result = await invoke(
      root,
      ["scan", "--profile", "claude-code", "--profile", "codex-cli", "--rule", "ACL550"],
      new AbortController(),
      undefined,
      (observed) => {
        profiles = observed;
      },
    );
    expect(result.stderr).toBe("");
    const byProfile = new Map(profiles.map((entry) => [entry.profile.profileId, entry]));
    const claude = byProfile.get("claude-code")?.accountings[0]?.accounting;
    const codex = byProfile.get("codex-cli")?.accountings[0]?.accounting;
    const count = countEstimatedTokens(text);
    if (!count.ok) throw new Error("token fixture failed");
    expect(claude?.totals).toMatchObject({
      effective: count.value.tokens,
      raw: count.value.tokens,
      unique: count.value.tokens,
    });
    expect(codex).toMatchObject({
      state: "complete",
      totals: { always: 0, effective: 0, imported: 0, raw: 0, unique: 0 },
    });
  });

  test("returns exact cancellation and operational contracts", async () => {
    const root = await repository({ "AGENTS.md": "Keep changes focused.\n" });
    const controller = new AbortController();
    controller.abort();
    expect((await invoke(root, ["scan"], controller)).exitCode).toBe(130);
    const failed = await invoke(root, ["scan", "missing"]);
    expect(failed.exitCode).toBe(2);
    expect(failed.stderr).toContain("unable to scan repository");
    expect((await invoke(root, ["scan", "--fix-dry-run"])).exitCode).toBe(0);
  });

  test("previews only a genuine approved ACL109 fix and remains read-only", async () => {
    const directive =
      "<!-- agent-context-lint-disable-next-line ACL100 -- reason: stale fixture -->\n";
    const root = await repository({ "AGENTS.md": `${directive}Body\n` });
    const first = await invoke(root, ["scan", "--fix-dry-run"]);
    const second = await invoke(root, ["scan", "--fix-dry-run"]);
    expect(first).toEqual(second);
    expect(first.exitCode).toBe(0);
    expect(first.stdout).toContain("ACL109");
    expect(first.stdout).toContain(`-${directive.trimEnd()}`);
    expect(await readFile(path.join(root, "AGENTS.md"), "utf8")).toBe(`${directive}Body\n`);
    expect((await invoke(root, ["scan", "--format", "json", "--fix-dry-run"])).exitCode).toBe(2);
    expect((await invoke(root, ["scan", "--fix-dry-run", "--format", "sarif"])).exitCode).toBe(2);
  });

  test("does not preview ACL109 fixes outside visible scheduled authority", async () => {
    const stale =
      "<!-- agent-context-lint-disable-next-line ACL100 -- reason: stale fixture -->\nBody\n";
    const cases: readonly {
      readonly args: readonly string[];
      readonly files: Readonly<Record<string, string>>;
    }[] = [
      {
        args: ["scan", "--fix-dry-run", "--rule", "ACL100"],
        files: { "AGENTS.md": stale },
      },
      {
        args: ["scan", "--fix-dry-run", "--severity", "ACL109=off"],
        files: { "AGENTS.md": stale },
      },
      {
        args: ["scan", "--fix-dry-run"],
        files: {
          ".agent-context-lint.yml": "version: 1\nrules:\n  ACL109: off\n",
          "AGENTS.md": stale,
        },
      },
      {
        args: ["scan", "--fix-dry-run"],
        files: {
          "AGENTS.md":
            "<!-- agent-context-lint-disable-next-line ACL109 -- reason: retained intentionally -->\n" +
            stale,
        },
      },
    ];
    const staleFirstLine = stale.split("\n")[0];
    if (staleFirstLine === undefined) throw new Error("stale directive fixture is empty");
    for (const fixture of cases) {
      const root = await repository(fixture.files);
      const result = await invoke(root, fixture.args);
      expect(result.stderr).toBe("");
      expect(result.stdout).not.toContain(`-${staleFirstLine}`);
      expect(await readFile(path.join(root, "AGENTS.md"), "utf8")).toBe(fixture.files["AGENTS.md"]);
    }
  });

  test("uses path activation evidence before deterministic E08 sampling", async () => {
    const files: Record<string, string> = {
      ".cursor/rules/special.mdc": "---\nglobs: special/**\n---\nOnly for special sources.\n",
    };
    for (let index = 0; index < 1_001; index += 1)
      files[`ordinary/file-${index.toString().padStart(4, "0")}.ts`] = "export {};\n";
    files["special/selected.ts"] = "export const selected = true;\n";
    const root = await repository(files);
    const samples: string[][] = [];
    const args = [
      "scan",
      "--profile",
      "cursor-agent",
      "--surface",
      "cursor-agent/ide",
      "--rule",
      "ACL200",
    ];
    await invoke(root, args, new AbortController(), (sampling) => {
      samples.push(sampling.selected.map((entry) => entry.path));
    });
    await invoke(root, args, new AbortController(), (sampling) => {
      samples.push(sampling.selected.map((entry) => entry.path));
    });
    expect(samples[0]).toEqual(samples[1]);
    expect(samples[0]).toContain("special/selected.ts");
  }, 20_000);

  test("samples only source targets and never instruction or configuration artifacts", async () => {
    const root = await repository({
      ".agent-context-lint.yml": "version: 1\n",
      "AGENTS.md": "Repository policy.\n",
      "package.json": '{"name":"fixture"}\n',
      "src/main.ts": "export const main = true;\n",
    });
    let selected: readonly string[] = [];
    await invoke(root, ["scan", "--profile", "codex-cli"], new AbortController(), (sampling) => {
      selected = sampling.selected.map((entry) => entry.path);
    });
    expect(selected).toEqual(["src/main.ts"]);
  });

  test("represents unconditional and unknown activation syntax without inventing globs", async () => {
    const cases = [
      {
        expectedKind: "always",
        file: ".claude/rules/unconditional.md",
        text: "Unconditional Claude rule.\n",
      },
      {
        expectedKind: "always",
        file: ".cursor/rules/always.mdc",
        text: "---\nalwaysApply: true\n---\nAlways Cursor rule.\n",
      },
      {
        expectedKind: "unknown",
        file: ".cursor/rules/unknown.mdc",
        text: "---\nalwaysApply: false\n---\nConditional Cursor rule.\n",
      },
    ] as const;
    for (const fixture of cases) {
      const root = await repository({
        [fixture.file]: fixture.text,
        "src/main.ts": "export const main = true;\n",
      });
      let kinds: readonly string[] = [];
      const result = await invoke(
        root,
        ["scan", "--format", "json", "--rule", "ACL200", "--fail-on", "never"],
        new AbortController(),
        undefined,
        undefined,
        undefined,
        (rules) => {
          kinds = rules.map((rule) => rule.kind);
        },
      );
      expect(result.stderr).toBe("");
      expect(kinds).toContain(fixture.expectedKind);
    }
  });

  test("keeps configured ignored paths out of sampling, evidence, and import reads", async () => {
    const root = await repository({
      ".agent-context-lint.yml": "version: 1\nignore:\n  - ignored/**\n  - package.json\n",
      "CLAUDE.md": "@ignored/shared.md\n\nRun npm run present-only-in-ignored-package.\n",
      "ignored/hidden.ts": "export const hidden = true;\n",
      "ignored/shared.md": "Ignored imported policy.\n",
      "package.json":
        '{"name":"fixture","scripts":{"present-only-in-ignored-package":"echo ignored"}}\n',
      "src/main.ts": "export const main = true;\n",
    });
    let selected: readonly string[] = [];
    const result = await invoke(
      root,
      ["scan", "--format", "json", "--profile", "claude-code", "--fail-on", "never"],
      new AbortController(),
      (sampling) => {
        selected = sampling.selected.map((entry) => entry.path);
      },
    );
    expect(result.stderr).toBe("");
    expect(selected).toEqual(["src/main.ts"]);
    const output = JSON.parse(result.stdout) as {
      diagnostics: { diagnostics: readonly { ruleId: string }[] };
    };
    expect(output.diagnostics.diagnostics.map((entry) => entry.ruleId)).toEqual(
      expect.arrayContaining(["ACL150", "ACL300"]),
    );
  });

  test("orders non-ASCII activation targets by canonical UTF-8 bytes", async () => {
    const paths: readonly RepositoryRelativePath[] = [
      "src/z.ts" as RepositoryRelativePath,
      "src/ä.ts" as RepositoryRelativePath,
      "src/Ω.ts" as RepositoryRelativePath,
      "src/𠀀.ts" as RepositoryRelativePath,
    ];
    const files: Record<string, string> = {
      ".cursor/rules/all.mdc": "---\nglobs: src/**\n---\nApply to every source.\n",
    };
    for (const entry of paths) files[entry] = "export {};\n";
    const root = await repository(files);
    let selected: readonly string[] = [];
    await invoke(
      root,
      ["scan", "--profile", "cursor-agent", "--surface", "cursor-agent/ide", "--rule", "ACL200"],
      new AbortController(),
      (sampling) => {
        selected = sampling.selected.map((entry) => entry.path);
      },
    );
    expect(selected.filter((entry) => entry.startsWith("src/"))).toEqual(
      [...paths].sort(compareRepositoryRelativePaths),
    );
  });

  test("accounts nested path rules and genuine imports per sampled target", async () => {
    const rootText = "@rules/shared.md\nRoot policy.\n";
    const importedText = "Imported policy.\n";
    const nestedText = "---\npaths: special/**\n---\nNested policy.\n";
    const root = await repository({
      ".claude/rules/special.md": nestedText,
      "CLAUDE.md": rootText,
      "ordinary/app.ts": "export const ordinary = true;\n",
      "rules/shared.md": importedText,
      "special/app.ts": "export const special = true;\n",
    });
    let profiles: readonly EfficiencyMetricProfileInput[] = [];
    const result = await invoke(
      root,
      [
        "scan",
        "--profile",
        "claude-code",
        "--surface",
        "claude-code/local-session",
        "--rule",
        "ACL550",
      ],
      new AbortController(),
      undefined,
      (observed) => {
        profiles = observed;
      },
    );
    expect(result.stderr).toBe("");
    expect(profiles).toHaveLength(1);
    const accountings = new Map(
      profiles[0]?.accountings.map((entry) => [entry.path, entry.accounting.totals]),
    );
    const ordinary = accountings.get("ordinary/app.ts" as RepositoryRelativePath);
    const special = accountings.get("special/app.ts" as RepositoryRelativePath);
    const rootTokens = countEstimatedTokens(rootText);
    const importedTokens = countEstimatedTokens(importedText);
    const nestedTokens = countEstimatedTokens(nestedText);
    if (!rootTokens.ok || !importedTokens.ok || !nestedTokens.ok)
      throw new Error("token fixture failed");
    expect(ordinary).toMatchObject({
      effective: rootTokens.value.tokens + importedTokens.value.tokens,
      imported: importedTokens.value.tokens,
      raw: rootTokens.value.tokens + importedTokens.value.tokens + nestedTokens.value.tokens,
      unique: rootTokens.value.tokens + importedTokens.value.tokens,
    });
    expect(special).toMatchObject({
      effective: rootTokens.value.tokens + importedTokens.value.tokens + nestedTokens.value.tokens,
      imported: importedTokens.value.tokens,
      raw: rootTokens.value.tokens + importedTokens.value.tokens + nestedTokens.value.tokens,
      unique: rootTokens.value.tokens + importedTokens.value.tokens + nestedTokens.value.tokens,
    });
    expect(special?.raw).toBe(ordinary?.raw);
  });

  test("accounts genuine imported occurrences only from their own context evidence", async () => {
    const rootText = "@rules.md\nRoot policy.\n";
    const importedText = "Imported policy.\n";
    const root = await repository({ "CLAUDE.md": rootText, "rules.md": importedText });
    const selection = await selectRepositoryRoot(root, { mode: "explicit" });
    const facade = await createReadOnlyRepository(selection, {
      maximumEntries: 100,
      maximumFileBytes: 1_024,
      maximumTotalBytes: 8_192,
      maximumTraversalDepth: 16,
    });
    const graph = await loadImportGraph({
      entryPath: "CLAUDE.md" as RepositoryRelativePath,
      repository: facade,
      syntax: "claude-code",
    });
    const dag = buildDocumentImportDag({
      graph,
      trace: createSyntheticTargetTrace({
        launchCwd: "." as RepositoryRelativePath,
        purpose: "scan-occurrence-test",
        targetPath: "src/main.ts" as RepositoryRelativePath,
        workspaceRoots: ["." as RepositoryRelativePath],
      }),
    });
    const tokenByPath = new Map(
      [
        ["CLAUDE.md", rootText],
        ["rules.md", importedText],
      ].map(([documentPath, text]) => {
        const count = countEstimatedTokens(text);
        if (!count.ok) throw new Error("token fixture failed");
        return [documentPath, count.value] as const;
      }),
    );
    const documentMeasurements = dag.documents.map((document) => {
      const count = tokenByPath.get(document.path);
      if (count === undefined) throw new Error("document measurement is unavailable");
      return { count, documentId: document.documentId };
    });
    const context = (
      state?: "conditional" | "inactive",
    ): {
      readonly documents: readonly {
        readonly path: RepositoryRelativePath;
        readonly state: "conditional" | "effective" | "inactive";
      }[];
    } => ({
      documents: [
        { path: "CLAUDE.md" as RepositoryRelativePath, state: "effective" as const },
        ...(state === undefined ? [] : [{ path: "rules.md" as RepositoryRelativePath, state }]),
      ],
    });
    const accounting = (
      state: "conditional" | "inactive",
    ): ReturnType<typeof accountOccurrenceTokens> =>
      accountOccurrenceTokens({
        dag,
        documentMeasurements,
        identity: BUILTIN_ESTIMATE_IDENTITY,
        occurrenceDecisions: dag.occurrences.map((occurrence) => {
          const decision = classifyOccurrenceDecision(context(state), dag, occurrence);
          const measurement = documentMeasurements.find(
            (entry) => entry.documentId === occurrence.targetDocumentId,
          );
          return {
            activation: decision.activation,
            count: decision.disposition === "included" ? (measurement?.count ?? null) : null,
            disposition: decision.disposition,
            occurrenceId: occurrence.id,
            sourceBytesConsumed:
              decision.disposition === "included"
                ? (dag.documents.find((entry) => entry.documentId === occurrence.targetDocumentId)
                    ?.byteLength ?? null)
                : null,
          };
        }),
      });
    const rootTokens = tokenByPath.get("CLAUDE.md");
    const importedTokens = tokenByPath.get("rules.md");
    if (rootTokens === undefined || importedTokens === undefined)
      throw new Error("token fixture failed");
    expect(accounting("conditional").totals).toEqual({
      always: rootTokens.tokens,
      effective: rootTokens.tokens + importedTokens.tokens,
      imported: importedTokens.tokens,
      raw: rootTokens.tokens + importedTokens.tokens,
      unique: rootTokens.tokens + importedTokens.tokens,
    });
    expect(accounting("inactive").totals).toEqual({
      always: rootTokens.tokens,
      effective: rootTokens.tokens,
      imported: 0,
      raw: rootTokens.tokens + importedTokens.tokens,
      unique: rootTokens.tokens,
    });
    const importedOccurrence = dag.occurrences.find((occurrence) => occurrence.state === "loaded");
    if (importedOccurrence === undefined) throw new Error("import occurrence is unavailable");
    expect(classifyOccurrenceDecision(context(), dag, importedOccurrence)).toEqual({
      activation: "always",
      disposition: "included",
    });
  });

  test("reports a malformed escaping import without following it or failing the scan", async () => {
    const root = await repository({ "CLAUDE.md": "@../outside.md\n" });
    const result = await invoke(root, [
      "scan",
      "--format",
      "json",
      "--profile",
      "claude-code",
      "--rule",
      "ACL152",
      "--fail-on",
      "never",
    ]);
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout) as {
      diagnostics: { diagnostics: readonly { ruleId: string }[] };
    };
    expect(output.diagnostics.diagnostics.map((entry) => entry.ruleId)).toContain("ACL152");

    const unrelated = await invoke(root, [
      "scan",
      "--format",
      "json",
      "--profile",
      "codex-cli",
      "--rule",
      "ACL152",
      "--fail-on",
      "never",
    ]);
    expect(unrelated.stderr).toBe("");
    expect(unrelated.exitCode).toBe(0);
    const unrelatedOutput = JSON.parse(unrelated.stdout) as {
      diagnostics: { diagnostics: readonly { ruleId: string }[] };
    };
    expect(unrelatedOutput.diagnostics.diagnostics.map((entry) => entry.ruleId)).not.toContain(
      "ACL152",
    );
  });

  test("deduplicates import profile authority across multiple sampled targets", async () => {
    const root = await repository({
      "CLAUDE.md": "@rules.md\n",
      "rules.md": "Shared policy.\n",
      "src/first.ts": "export const first = true;\n",
      "src/second.ts": "export const second = true;\n",
    });
    const result = await invoke(root, [
      "scan",
      "--format",
      "json",
      "--profile",
      "claude-code",
      "--rule",
      "ACL150",
      "--fail-on",
      "never",
    ]);
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  test("retains imported AGENTS.md as a distinct Claude and Codex interpretation", async () => {
    const claudeText = "@AGENTS.md\nClaude policy.\n";
    const agentsText = "Shared agent policy.\n";
    const root = await repository({
      "AGENTS.md": agentsText,
      "CLAUDE.md": claudeText,
      "src/main.ts": "export const main = true;\n",
    });
    let profiles: readonly EfficiencyMetricProfileInput[] = [];
    let interpretations: readonly string[] = [];
    let statementIds: readonly string[] = [];
    const result = await invoke(
      root,
      ["scan", "--format", "json", "--profile", "claude-code", "--profile", "codex-cli"],
      new AbortController(),
      undefined,
      (observed) => {
        profiles = observed;
      },
      (parsed) => {
        const sources = new Map(parsed.ir.sources.map((source) => [source.id, source.path]));
        interpretations = parsed.ir.documents
          .filter((document) => sources.get(document.sourceId) === "AGENTS.md")
          .map((document) => document.formatId)
          .sort();
        statementIds = parsed.ir.statements.map((statement) => statement.id);
      },
    );
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(interpretations).toEqual(["agents-markdown", "claude-code-import"]);
    expect(new Set(statementIds).size).toBe(statementIds.length);
    const byProfile = new Map(profiles.map((entry) => [entry.profile.profileId, entry]));
    const claude = byProfile.get("claude-code")?.accountings[0]?.accounting.totals;
    const codex = byProfile.get("codex-cli")?.accountings[0]?.accounting.totals;
    const claudeCount = countEstimatedTokens(claudeText);
    const agentsCount = countEstimatedTokens(agentsText);
    if (!claudeCount.ok || !agentsCount.ok) throw new Error("token fixture failed");
    expect(claude).toMatchObject({
      effective: claudeCount.value.tokens + agentsCount.value.tokens,
      imported: agentsCount.value.tokens,
      raw: claudeCount.value.tokens + agentsCount.value.tokens,
    });
    expect(codex?.effective).toBe(agentsCount.value.tokens);
    expect(codex?.imported).toBe(0);
  });

  test("retains nested Claude and top-level Gemini import interpretations", async () => {
    const root = await repository({
      "CLAUDE.md": "@GEMINI.md\nClaude root.\n",
      "GEMINI.md": "@child.md\nGemini root.\n",
      "child.md": "Child policy.\n",
      "src/main.ts": "export const main = true;\n",
    });
    let interpretations: readonly string[] = [];
    let graphs: readonly string[] = [];
    const result = await invoke(
      root,
      ["scan", "--format", "json", "--profile", "claude-code", "--profile", "gemini-cli"],
      new AbortController(),
      undefined,
      undefined,
      (parsed) => {
        const sources = new Map(parsed.ir.sources.map((source) => [source.id, source.path]));
        interpretations = parsed.ir.documents
          .filter((document) => sources.get(document.sourceId) === "GEMINI.md")
          .map((document) => document.formatId)
          .sort();
        graphs = parsed.graphs.map((entry) => entry.graph.entryPath).sort();
      },
    );
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(graphs).toEqual(["CLAUDE.md", "GEMINI.md"]);
    expect(interpretations).toEqual(["claude-code-import", "gemini-context-markdown"]);
  });

  test("keeps shared files distinct when Claude and Gemini import the same path", async () => {
    const root = await repository({
      "CLAUDE.md": "@shared.md\n",
      "GEMINI.md": "@shared.md\n",
      "shared.md": "Shared policy.\n",
      "src/main.ts": "export const main = true;\n",
    });
    let sharedFormats: readonly string[] = [];
    const result = await invoke(
      root,
      ["scan", "--format", "json", "--profile", "claude-code", "--profile", "gemini-cli"],
      new AbortController(),
      undefined,
      undefined,
      (parsed) => {
        const sources = new Map(parsed.ir.sources.map((source) => [source.id, source.path]));
        sharedFormats = parsed.ir.documents
          .filter((document) => sources.get(document.sourceId) === "shared.md")
          .map((document) => document.formatId)
          .sort();
      },
    );
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(sharedFormats).toEqual(["claude-code-import", "gemini-cli-import"]);
  });

  test("uses the configured standards lock offline and diagnoses missing or malformed state", async () => {
    const lock = await validStandardsLock();
    const configuration = (requireCurrentInCI: boolean): string =>
      [
        "version: 1",
        "standards:",
        "  channel: stable",
        "  lockfile: config/standards.lock.json",
        `  requireCurrentInCI: ${String(requireCurrentInCI)}`,
        "",
      ].join("\n");
    const scan = async (
      files: Readonly<Record<string, string>>,
      environment: "ci" | "local",
    ): Promise<readonly string[]> => {
      const root = await repository(files);
      const result = await invoke(
        root,
        ["scan", "--format", "json", "--fail-on", "never"],
        new AbortController(),
        undefined,
        undefined,
        undefined,
        undefined,
        environment,
      );
      expect(result.stderr).toBe("");
      return (
        JSON.parse(result.stdout) as {
          diagnostics: { diagnostics: readonly { ruleId: string }[] };
        }
      ).diagnostics.diagnostics.map((entry) => entry.ruleId);
    };
    const valid = await scan(
      {
        ".agent-context-lint.yml": configuration(true),
        "AGENTS.md": "Policy.\n",
        "config/standards.lock.json": lock,
      },
      "ci",
    );
    expect(valid).not.toContain("ACL503");
    expect(valid).not.toContain("ACL505");
    expect(
      await scan(
        { ".agent-context-lint.yml": configuration(true), "AGENTS.md": "Policy.\n" },
        "ci",
      ),
    ).toContain("ACL505");
    expect(
      await scan(
        {
          ".agent-context-lint.yml": configuration(false),
          "AGENTS.md": "Policy.\n",
          "config/standards.lock.json": "{}\n",
        },
        "local",
      ),
    ).toContain("ACL503");
    expect(
      await scan(
        { ".agent-context-lint.yml": configuration(false), "AGENTS.md": "Policy.\n" },
        "ci",
      ),
    ).not.toContain("ACL505");
  });

  test("reports and suppresses the documented Cursor legacy deprecation", async () => {
    const scan = async (
      text: string,
    ): Promise<{
      readonly diagnostics: {
        readonly diagnostics: readonly { readonly ruleId: string }[];
        readonly suppressions: readonly { readonly state: string }[];
      };
    }> => {
      const root = await repository({ ".cursorrules": text });
      const result = await invoke(root, [
        "scan",
        "--format",
        "json",
        "--rule",
        "ACL504",
        "--fail-on",
        "never",
      ]);
      expect(result.stderr).toBe("");
      return JSON.parse(result.stdout) as {
        diagnostics: {
          diagnostics: readonly { ruleId: string }[];
          suppressions: readonly { state: string }[];
        };
      };
    };
    expect((await scan("Legacy policy.\n")).diagnostics.diagnostics).toContainEqual(
      expect.objectContaining({ ruleId: "ACL504" }),
    );
    const suppressed = await scan(
      "<!-- agent-context-lint-disable-next-line ACL504 -- reason: migration tracked -->\nLegacy policy.\n",
    );
    expect(suppressed.diagnostics.diagnostics).toContainEqual(
      expect.objectContaining({ ruleId: "ACL504" }),
    );
    expect(suppressed.diagnostics.suppressions.map((entry) => entry.state)).toContain("suppressed");
  });

  test("composes portability from profile claims without turning unknown support into absence", async () => {
    const root = await repository({
      "CLAUDE.md": "Always use npm.\n",
      "src/main.ts": "export const main = true;\n",
    });
    let observations: readonly {
      readonly profileId: string;
      readonly state: string;
      readonly surfaceId: string;
    }[] = [];
    const result = await invoke(
      root,
      [
        "scan",
        "--format",
        "json",
        "--rule",
        "ACL450",
        "--rule",
        "ACL452",
        "--rule",
        "ACL453",
        "--fail-on",
        "never",
      ],
      new AbortController(),
      undefined,
      undefined,
      undefined,
      undefined,
      "local",
      undefined,
      (value) => {
        observations = value;
      },
    );
    expect(result.stderr).toBe("");
    const diagnostics = (
      JSON.parse(result.stdout) as {
        diagnostics: { diagnostics: readonly { ruleId: string }[] };
      }
    ).diagnostics.diagnostics.map((entry) => entry.ruleId);
    expect(observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ profileId: "claude-code", state: "supported" }),
        expect.objectContaining({ profileId: "copilot-code-review", state: "recognized" }),
      ]),
    );
    // E07 cannot prove divergent effective scope for this fixture, so F12 conservatively withholds
    // ACL450 instead of turning the explicit `recognized` state into unsupported behavior.
    expect(diagnostics).not.toContain("ACL450");
    // Current closed profiles contain conditional/unknown—not unsupported—counterparts for
    // import/nesting and editor-only behaviors. F12 must remain silent until that evidence exists.
    expect(diagnostics).not.toContain("ACL452");
    expect(diagnostics).not.toContain("ACL453");
  });

  test("does not initialize Git process authority for a default scan", async () => {
    const root = await repository({ "AGENTS.md": "Keep changes focused.\n" });
    const createExecutor = vi.fn(() =>
      Promise.reject(new Error("default scan requested Git authority")),
    );

    const result = await invokeChanged(
      root,
      ["scan", "--fail-on", "never"],
      undefined,
      createExecutor,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(createExecutor).not.toHaveBeenCalled();
  });

  test("runs explicit changed mode against the exact merge base and dependency-expanded context", async () => {
    const root = await repository({
      ".github/copilot-instructions.md": "Run npm run missing-task before committing.\n",
      "package.json": '{"name":"changed-mode-fixture","scripts":{"test":"vitest"}}\n',
      "src/main.ts": "export const value = 1;\n",
    });
    const base = await commitRepository(root);
    await writeFile(path.join(root, "src/main.ts"), "export const value = 2;\n", "utf8");
    let observed:
      | Parameters<
          NonNullable<Parameters<typeof createScanCommandHandlers>[0]["observeChangedFileMode"]>
        >[0]
      | null = null;

    const result = await invokeChanged(
      root,
      [
        "scan",
        "--changed",
        "--base",
        base,
        "--format",
        "json",
        "--profile",
        "copilot-vscode",
        "--surface",
        "copilot-vscode/local-chat",
        "--rule",
        "ACL300",
        "--fail-on",
        "never",
      ],
      (value) => {
        observed = value;
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(observed).toMatchObject({
      changedPaths: ["src/main.ts"],
      mode: "changed",
      reason: null,
    });
    const output = JSON.parse(result.stdout) as {
      diagnostics: { diagnostics: readonly { readonly ruleId: string }[] };
    };
    expect(output.diagnostics.diagnostics).toContainEqual(
      expect.objectContaining({ ruleId: "ACL300" }),
    );
  });

  test("runs scan . in changed mode from an explicit linked-worktree root", async () => {
    const root = await repository({
      ".github/copilot-instructions.md": "Run npm run missing-task before committing.\n",
      "package.json": '{"name":"linked-fixture","scripts":{"test":"vitest"}}\n',
      "src/main.ts": "export const value = 1;\n",
    });
    const base = await commitRepository(root);
    const linked = path.join(root, "linked-worktree");
    await execFileAsync("git", [
      "-C",
      root,
      "worktree",
      "add",
      "--quiet",
      "-b",
      "changed-scan-linked",
      linked,
      base,
    ]);
    await writeFile(path.join(linked, "src/main.ts"), "export const value = 2;\n", "utf8");
    let observed:
      | Parameters<
          NonNullable<Parameters<typeof createScanCommandHandlers>[0]["observeChangedFileMode"]>
        >[0]
      | null = null;

    const result = await invokeChanged(
      linked,
      [
        "scan",
        ".",
        "--changed",
        "--base",
        base,
        "--format",
        "json",
        "--profile",
        "copilot-vscode",
        "--surface",
        "copilot-vscode/local-chat",
        "--rule",
        "ACL300",
        "--fail-on",
        "never",
      ],
      (value) => {
        observed = value;
      },
    );

    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(observed).toMatchObject({
      changedPaths: ["src/main.ts"],
      mode: "changed",
      reason: null,
    });
    const output = JSON.parse(result.stdout) as {
      diagnostics: { diagnostics: readonly { ruleId: string }[] };
    };
    expect(output.diagnostics.diagnostics).toContainEqual(
      expect.objectContaining({ ruleId: "ACL300" }),
    );
  });

  test("uses a full scan when the bounded included inventory contains an untracked path", async () => {
    const root = await repository({
      "src/main.ts": "export const value = 1;\n",
    });
    const base = await commitRepository(root);
    await writeFile(path.join(root, "src/main.ts"), "export const value = 2;\n", "utf8");
    await writeFile(
      path.join(root, "AGENTS.md"),
      "<!-- agent-context-lint-disable-next-line ACL100 -- stale -->\nBody.\n",
      "utf8",
    );
    let observed: ChangedFileModeResult | null = null;

    const result = await invokeChanged(
      root,
      [
        "scan",
        "--changed",
        "--base",
        base,
        "--profile",
        "codex-cli",
        "--rule",
        "ACL109",
        "--fail-on",
        "never",
      ],
      (value) => {
        observed = value;
      },
    );

    expect(result).toMatchObject({ exitCode: 0 });
    expect(result.stderr).toBe(
      "agent-context-lint: changed-file mode used the full scan (untracked-files).\n",
    );
    expect(observed).toMatchObject({ mode: "full", reason: "untracked-files" });
    expect(result.stdout).toContain("ACL109");
  });

  test("does not treat a configured ignored generated tree as relevant untracked input", async () => {
    const root = await repository({
      ".agent-context-lint.yml": "version: 1\nignore:\n  - generated/**\n",
      ".github/copilot-instructions.md": "Run npm run missing-task before committing.\n",
      "src/main.ts": "export const value = 1;\n",
    });
    const base = await commitRepository(root);
    await mkdir(path.join(root, "generated"));
    await writeFile(path.join(root, "generated", "cache.ts"), "untracked\n", "utf8");
    await writeFile(path.join(root, "src/main.ts"), "export const value = 2;\n", "utf8");
    let observed: ChangedFileModeResult | null = null;

    const result = await invokeChanged(
      root,
      [
        "scan",
        "--changed",
        "--base",
        base,
        "--profile",
        "copilot-vscode",
        "--surface",
        "copilot-vscode/local-chat",
        "--rule",
        "ACL300",
        "--fail-on",
        "never",
      ],
      (value) => {
        observed = value;
      },
    );

    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(observed).toMatchObject({ changedPaths: ["src/main.ts"], mode: "changed" });
  });

  test("falls back when a changed file mutates again during the scan", async () => {
    const root = await repository({
      "AGENTS.md": "Run npm run missing-task before committing.\n",
      "src/main.ts": "export const value = 1;\n",
    });
    const base = await commitRepository(root);
    await writeFile(path.join(root, "src/main.ts"), "export const value = 2;\n", "utf8");
    let observed:
      | Parameters<
          NonNullable<Parameters<typeof createScanCommandHandlers>[0]["observeChangedFileMode"]>
        >[0]
      | null = null;
    const createRacingExecutor: NonNullable<
      Parameters<typeof createScanCommandHandlers>[0]["createGitMetadataExecutor"]
    > = async (selection) => {
      const executor = await createNodeGitMetadataExecutor(selection);
      let headResolutions = 0;
      return async (request, signal) => {
        const response = await executor(request, signal);
        if (request.kind === "resolve-head") {
          headResolutions += 1;
          if (headResolutions === 2)
            await writeFile(path.join(root, "src/main.ts"), "export const value = 3;\n", "utf8");
        }
        return response;
      };
    };

    const result = await invokeChanged(
      root,
      [
        "scan",
        "--changed",
        "--base",
        base,
        "--format",
        "json",
        "--rule",
        "ACL300",
        "--fail-on",
        "never",
      ],
      (value) => {
        observed = value;
      },
      createRacingExecutor,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe(
      "agent-context-lint: changed-file mode used the full scan (repository-changed).\n",
    );
    expect(observed).toMatchObject({ mode: "full", reason: "repository-changed" });
    const output = JSON.parse(result.stdout) as {
      diagnostics: { diagnostics: readonly { readonly ruleId: string }[] };
    };
    expect(output.diagnostics.diagnostics).toContainEqual(
      expect.objectContaining({ ruleId: "ACL300" }),
    );
  });

  test("falls back when configuration bytes used by scheduling differ from final bytes", async () => {
    const configurationPath = ".agent-context-lint.yml";
    const original = "version: 1\nignore:\n  - a.tmp\n";
    const transient = "version: 1\nignore:\n  - b.tmp\n";
    const root = await repository({
      [configurationPath]: original,
      "AGENTS.md": "Run npm run missing-task before committing.\n",
      "src/main.ts": "export const value = 1;\n",
    });
    const base = await commitRepository(root);
    await writeFile(path.join(root, "src/main.ts"), "export const value = 2;\n", "utf8");
    let observed: ChangedFileModeResult | null = null;
    const createRacingExecutor: NonNullable<
      Parameters<typeof createScanCommandHandlers>[0]["createGitMetadataExecutor"]
    > = async (selection) => {
      const executor = await createNodeGitMetadataExecutor(selection);
      let requests = 0;
      return async (request, signal) => {
        const response = await executor(request, signal);
        requests += 1;
        if (requests === 7) await writeFile(path.join(root, configurationPath), transient, "utf8");
        if (requests === 8) await writeFile(path.join(root, configurationPath), original, "utf8");
        return response;
      };
    };

    const result = await invokeChanged(
      root,
      ["scan", "--changed", "--base", base, "--rule", "ACL300", "--fail-on", "never"],
      (value) => {
        observed = value;
      },
      createRacingExecutor,
    );

    expect(result.stderr).toBe(
      "agent-context-lint: changed-file mode used the full scan (repository-changed).\n",
    );
    expect(observed).toMatchObject({ mode: "full", reason: "repository-changed" });
  });

  test("closes subset authority with Git state after final repository revalidation", async () => {
    const root = await repository({
      "AGENTS.md": "Run npm run missing-task before committing.\n",
      "src/main.ts": "export const value = 1;\n",
    });
    const base = await commitRepository(root);
    await writeFile(path.join(root, "src/main.ts"), "export const value = 2;\n", "utf8");
    let observed: ChangedFileModeResult | null = null;
    const createRacingExecutor: NonNullable<
      Parameters<typeof createScanCommandHandlers>[0]["createGitMetadataExecutor"]
    > = async (selection) => {
      const executor = await createNodeGitMetadataExecutor(selection);
      let requests = 0;
      return async (request, signal) => {
        const response = await executor(request, signal);
        requests += 1;
        if (requests === 14)
          await execFileAsync("git", ["-C", root, "rm", "--cached", "--quiet", "AGENTS.md"]);
        return response;
      };
    };

    const result = await invokeChanged(
      root,
      ["scan", "--changed", "--base", base, "--rule", "ACL300", "--fail-on", "never"],
      (value) => {
        observed = value;
      },
      createRacingExecutor,
    );

    expect(result.stderr).toBe(
      "agent-context-lint: changed-file mode used the full scan (repository-changed).\n",
    );
    expect(observed).toMatchObject({ mode: "full", reason: "repository-changed" });
  });

  test.runIf(process.platform !== "win32")(
    "falls back when the untracked inventory omits an outside-root symlink",
    async () => {
      const root = await repository({
        "AGENTS.md": "Run npm run missing-task before committing.\n",
        "src/main.ts": "export const value = 1;\n",
      });
      const base = await commitRepository(root);
      await writeFile(path.join(root, "src/main.ts"), "export const value = 2;\n", "utf8");
      const outside = await mkdtemp(path.join(tmpdir(), "agent-context-scan-outside-"));
      roots.push(outside);
      await writeFile(path.join(outside, "policy.md"), "outside\n", "utf8");
      await symlink(path.join(outside, "policy.md"), path.join(root, "outside.md"));
      let observed: ChangedFileModeResult | null = null;

      const result = await invokeChanged(
        root,
        ["scan", "--changed", "--base", base, "--rule", "ACL300", "--fail-on", "never"],
        (value) => {
          observed = value;
        },
      );

      expect(result.stderr).toBe(
        "agent-context-lint: changed-file mode used the full scan (repository-changed).\n",
      );
      expect(observed).toMatchObject({ mode: "full", reason: "repository-changed" });
    },
  );

  test("falls back when index staging changes but aggregate worktree content does not", async () => {
    const root = await repository({
      "AGENTS.md": "Run npm run missing-task before committing.\n",
      "src/main.ts": "export const value = 1;\n",
    });
    const base = await commitRepository(root);
    await writeFile(path.join(root, "src/main.ts"), "export const value = 2;\n", "utf8");
    let observed:
      | Parameters<
          NonNullable<Parameters<typeof createScanCommandHandlers>[0]["observeChangedFileMode"]>
        >[0]
      | null = null;
    const createRacingExecutor: NonNullable<
      Parameters<typeof createScanCommandHandlers>[0]["createGitMetadataExecutor"]
    > = async (selection) => {
      const executor = await createNodeGitMetadataExecutor(selection);
      let headResolutions = 0;
      return async (request, signal) => {
        const response = await executor(request, signal);
        if (request.kind === "resolve-head") {
          headResolutions += 1;
          if (headResolutions === 2) await execFileAsync("git", ["-C", root, "add", "src/main.ts"]);
        }
        return response;
      };
    };

    const result = await invokeChanged(
      root,
      ["scan", "--changed", "--base", base, "--rule", "ACL300", "--fail-on", "never"],
      (value) => {
        observed = value;
      },
      createRacingExecutor,
    );

    expect(result).toMatchObject({ exitCode: 0 });
    expect(result.stderr).toBe(
      "agent-context-lint: changed-file mode used the full scan (repository-changed).\n",
    );
    expect(observed).toMatchObject({ mode: "full", reason: "repository-changed" });
    expect(result.stdout).toContain("ACL300");
  });

  test("falls back when a relevant untracked path appears at the final inventory check", async () => {
    const root = await repository({
      ".github/copilot-instructions.md": "Run npm run missing-task before committing.\n",
      "src/main.ts": "export const value = 1;\n",
    });
    const base = await commitRepository(root);
    await writeFile(path.join(root, "src/main.ts"), "export const value = 2;\n", "utf8");
    let observed: ChangedFileModeResult | null = null;
    const createRacingExecutor: NonNullable<
      Parameters<typeof createScanCommandHandlers>[0]["createGitMetadataExecutor"]
    > = async (selection) => {
      const executor = await createNodeGitMetadataExecutor(selection);
      let headResolutions = 0;
      return async (request, signal) => {
        const response = await executor(request, signal);
        if (request.kind === "resolve-head") {
          headResolutions += 1;
          if (headResolutions === 3)
            await writeFile(path.join(root, "late.ts"), "export const late = true;\n", "utf8");
        }
        return response;
      };
    };

    const result = await invokeChanged(
      root,
      [
        "scan",
        "--changed",
        "--base",
        base,
        "--profile",
        "copilot-vscode",
        "--surface",
        "copilot-vscode/local-chat",
        "--rule",
        "ACL300",
        "--fail-on",
        "never",
      ],
      (value) => {
        observed = value;
      },
      createRacingExecutor,
    );

    expect(result).toMatchObject({ exitCode: 0 });
    expect(result.stderr).toBe(
      "agent-context-lint: changed-file mode used the full scan (repository-changed).\n",
    );
    expect(observed).toMatchObject({ mode: "full", reason: "repository-changed" });
  });

  test.each([[15], [21]] as const)(
    "revalidates nested inventory directories after request %i of three collections",
    async (mutationRequest) => {
      const root = await repository({
        ".github/copilot-instructions.md": "Run npm run missing-task before committing.\n",
        ".github/instructions/existing.instructions.md":
          "---\napplyTo: src/**/*.ts\n---\nKeep changes focused.\n",
        "package.json": '{"name":"late-inventory-fixture","scripts":{"test":"vitest"}}\n',
        "src/main.ts": "export const value = 1;\n",
        "src/nested/existing.ts": "export const existing = true;\n",
      });
      const base = await commitRepository(root);
      await writeFile(path.join(root, "src/main.ts"), "export const value = 2;\n", "utf8");
      let observed: ChangedFileModeResult | null = null;
      const createRacingExecutor: NonNullable<
        Parameters<typeof createScanCommandHandlers>[0]["createGitMetadataExecutor"]
      > = async (selection) => {
        const executor = await createNodeGitMetadataExecutor(selection);
        let requests = 0;
        return async (request, signal) => {
          const response = await executor(request, signal);
          requests += 1;
          if (requests === mutationRequest) {
            await Promise.all([
              writeFile(
                path.join(root, ".github", "instructions", "late.instructions.md"),
                "---\napplyTo: [\n---\nlate invalid instruction\n",
                "utf8",
              ),
              writeFile(
                path.join(root, "src", "nested", "late.ts"),
                "export const late = true;\n",
                "utf8",
              ),
            ]);
          }
          return response;
        };
      };

      const result = await invokeChanged(
        root,
        [
          "scan",
          "--changed",
          "--base",
          base,
          "--profile",
          "copilot-vscode",
          "--surface",
          "copilot-vscode/local-chat",
          "--rule",
          "ACL300",
          "--fail-on",
          "never",
        ],
        (value) => {
          observed = value;
        },
        createRacingExecutor,
      );

      expect(result).toMatchObject({ exitCode: 0 });
      expect(result.stderr).toBe(
        "agent-context-lint: changed-file mode used the full scan (repository-changed).\n",
      );
      expect(observed).toMatchObject({ mode: "full", reason: "repository-changed" });
    },
  );

  test("preserves relevant suppressed diagnostics while removing unrelated suppression state", async () => {
    const suppressed =
      "<!-- agent-context-lint-disable-next-line ACL300 -- reason: migration tracked -->\n" +
      "Run npm run missing-task before committing.\n";
    const root = await repository({
      ".github/instructions/docs.instructions.md": `---\napplyTo: 'docs/**'\n---\n${suppressed}`,
      ".github/instructions/src.instructions.md": `---\napplyTo: 'src/**'\n---\n${suppressed}`,
      "package.json": '{"name":"suppression-fixture","scripts":{"test":"vitest"}}\n',
      "src/main.ts": "export const value = 1;\n",
    });
    const base = await commitRepository(root);
    await writeFile(path.join(root, "src/main.ts"), "export const value = 2;\n", "utf8");
    const common = [
      "scan",
      "--changed",
      "--base",
      base,
      "--profile",
      "copilot-vscode",
      "--surface",
      "copilot-vscode/local-chat",
      "--rule",
      "ACL300",
      "--fail-on",
      "never",
    ] as const;

    const json = await invokeChanged(root, [...common, "--format", "json"]);
    expect(json.stderr).toBe("");
    const jsonOutput = JSON.parse(json.stdout) as {
      diagnostics: {
        diagnostics: readonly { primary: { path: string }; ruleId: string }[];
        suppressions: readonly { directive: { path: string }; state: string }[];
      };
      summary: { infos: number; suppressed: number };
    };
    expect(jsonOutput.diagnostics.diagnostics).toHaveLength(1);
    expect(jsonOutput.diagnostics.diagnostics[0]).toMatchObject({
      primary: { path: ".github/instructions/src.instructions.md" },
      ruleId: "ACL300",
    });
    expect(jsonOutput.diagnostics.suppressions).toHaveLength(1);
    expect(jsonOutput.diagnostics.suppressions[0]).toMatchObject({
      directive: { path: ".github/instructions/src.instructions.md" },
      state: "suppressed",
    });
    expect(jsonOutput.summary).toMatchObject({ infos: 0, suppressed: 1 });

    const stylish = await invokeChanged(root, [...common, "--format", "stylish"]);
    expect(stylish).toMatchObject({
      exitCode: 0,
      stderr: "",
      stdout: "0 problems (0 errors, 0 warnings, 0 infos, 1 suppressed)\n",
    });

    const sarif = await invokeChanged(root, [...common, "--format", "sarif"]);
    expect(sarif.stderr).toBe("");
    const sarifOutput = JSON.parse(sarif.stdout) as {
      runs: readonly { readonly results: readonly unknown[] }[];
    };
    // I06 intentionally omits suppressed diagnostics from SARIF while JSON retains the complete
    // selected B04 bundle and stylish reports the selected suppressed count.
    expect(sarifOutput.runs[0]?.results).toEqual([]);
  });

  test("keeps relevant ACL109 diagnostics and unused bookkeeping but removes unrelated records", async () => {
    const nestedSuppressions =
      "<!-- agent-context-lint-disable-next-line ACL109 -- reason: suppress stale report -->\n" +
      "<!-- agent-context-lint-disable-next-line ACL100 -- reason: intentionally stale -->\n" +
      "Body.\n";
    const root = await repository({
      ".github/instructions/docs.instructions.md": `---\napplyTo: 'docs/**'\n---\n${nestedSuppressions}`,
      ".github/instructions/src.instructions.md": `---\napplyTo: 'src/**'\n---\n${nestedSuppressions}`,
      "src/main.ts": "export const value = 1;\n",
    });
    const base = await commitRepository(root);
    await writeFile(path.join(root, "src/main.ts"), "export const value = 2;\n", "utf8");
    const common = [
      "scan",
      "--changed",
      "--base",
      base,
      "--profile",
      "copilot-vscode",
      "--surface",
      "copilot-vscode/local-chat",
      "--rule",
      "ACL109",
      "--fail-on",
      "never",
    ] as const;

    const json = await invokeChanged(root, [...common, "--format", "json"]);
    expect(json.stderr).toBe("");
    const output = JSON.parse(json.stdout) as {
      diagnostics: {
        diagnostics: readonly { primary: { path: string }; ruleId: string }[];
        suppressions: readonly { directive: { path: string }; state: string }[];
      };
      summary: { suppressed: number };
    };
    expect(output.diagnostics.diagnostics).toHaveLength(2);
    expect(
      output.diagnostics.diagnostics.every(
        (entry) =>
          entry.primary.path === ".github/instructions/src.instructions.md" &&
          entry.ruleId === "ACL109",
      ),
    ).toBe(true);
    expect(output.diagnostics.suppressions).toHaveLength(2);
    expect(output.diagnostics.suppressions.map((entry) => entry.state)).toEqual([
      "unused",
      "unused",
    ]);
    expect(
      output.diagnostics.suppressions.every(
        (entry) => entry.directive.path === ".github/instructions/src.instructions.md",
      ),
    ).toBe(true);
    expect(output.summary.suppressed).toBe(0);

    const stylish = await invokeChanged(root, [...common, "--format", "stylish"]);
    expect(stylish).toMatchObject({ exitCode: 0, stderr: "" });
    expect(stylish.stdout.match(/ACL109/gu)).toHaveLength(2);
    const sarif = await invokeChanged(root, [...common, "--format", "sarif"]);
    expect(sarif.stderr).toBe("");
    const sarifOutput = JSON.parse(sarif.stdout) as {
      runs: readonly {
        results: readonly { ruleId: string; suppressions?: readonly unknown[] }[];
      }[];
    };
    expect(sarifOutput.runs[0]?.results).toHaveLength(2);
    expect(sarifOutput.runs[0]?.results.every((entry) => entry.ruleId === "ACL109")).toBe(true);
  });

  test("does not emit a dry-run patch for ACL109 in an unchanged dependency", async () => {
    const stale =
      "<!-- agent-context-lint-disable-next-line ACL100 -- reason: stale fixture -->\nBody\n";
    const root = await repository({
      ".github/instructions/a.instructions.md": `---\napplyTo: 'a/**'\n---\n${stale}`,
      "b/main.ts": "export const value = 1;\n",
    });
    const base = await commitRepository(root);
    await writeFile(path.join(root, "b/main.ts"), "export const value = 2;\n", "utf8");
    let observed:
      | Parameters<
          NonNullable<Parameters<typeof createScanCommandHandlers>[0]["observeChangedFileMode"]>
        >[0]
      | null = null;

    const result = await invokeChanged(
      root,
      [
        "scan",
        "--changed",
        "--base",
        base,
        "--fix-dry-run",
        "--profile",
        "copilot-vscode",
        "--surface",
        "copilot-vscode/local-chat",
        "--fail-on",
        "never",
      ],
      (value) => {
        observed = value;
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(observed).toMatchObject({ changedPaths: ["b/main.ts"], mode: "changed" });
    expect(result.stdout).not.toContain(stale.split("\n")[0]);
    expect(await readFile(path.join(root, ".github/instructions/a.instructions.md"), "utf8")).toBe(
      `---\napplyTo: 'a/**'\n---\n${stale}`,
    );
  });

  test("rejects unknown, duplicate, and relationally empty selectors", async () => {
    const root = await repository({ "AGENTS.md": "Keep changes focused.\n" });
    expect((await invoke(root, ["scan", "--rule", "ACL999"])).exitCode).toBe(2);
    expect((await invoke(root, ["scan", "--rule", "ACL100", "--rule", "ACL100"])).exitCode).toBe(2);
    expect((await invoke(root, ["scan", "--severity", "ACL100=loud"])).exitCode).toBe(2);
    expect(
      (await invoke(root, ["scan", "--rule", "ACL100", "--severity", "ACL101=error"])).exitCode,
    ).toBe(2);
    expect(
      (await invoke(root, ["scan", "--profile", "codex-cli", "--surface", "cursor-agent/ide"]))
        .exitCode,
    ).toBe(2);
  });
});
