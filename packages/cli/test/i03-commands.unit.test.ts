import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parseAgentContextConfiguration } from "@agent-context/syntax";
import { canonicalizeRepositoryRelativePath } from "@agent-context/core";
import { createSyntheticTargetTrace } from "@agent-context/resolver";
import { afterEach, describe, expect, it } from "vitest";

import { runCommandRouter, type CliInvocation } from "../src/command-router.js";
import {
  I03_OUTPUT_CONTRACT_VERSION,
  STARTER_CONFIGURATION,
  createI03CommandHandlers,
} from "../src/i03-commands.js";

interface InvocationResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
  readonly stdoutChunks?: readonly string[];
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function temporaryRepository(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-context-i03-"));
  temporaryDirectories.push(root);
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, ...relative.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }
  return root;
}

async function invoke(
  workingDirectory: string,
  argv: readonly string[],
  captureChunks = false,
): Promise<InvocationResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const invocation: CliInvocation = {
    argv,
    signal: new AbortController().signal,
    stderr: { write: (text): void => void stderr.push(text) },
    stdout: { write: (text): void => void stdout.push(text) },
  };
  const result = await runCommandRouter(invocation, createI03CommandHandlers({ workingDirectory }));
  return {
    exitCode: result.exitCode,
    stderr: stderr.join(""),
    stdout: stdout.join(""),
    ...(captureChunks ? { stdoutChunks: Object.freeze([...stdout]) } : {}),
  };
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function requiredAt<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new Error("fixture entry is missing");
  return value;
}

async function populatedRepository(): Promise<string> {
  return temporaryRepository({
    ".cursor/rules/always.mdc": "---\nalwaysApply: true\n---\nCursor policy.\n",
    ".cursorrules": "Legacy Cursor policy.\n",
    ".github/copilot-instructions.md": "Copilot repository policy.\n",
    ".github/instructions/typescript.instructions.md":
      "---\napplyTo: '**/*.ts'\n---\nCopilot TypeScript policy.\n",
    ".github/instructions/bad.instructions.md": "---\napplyTo: [\n---\nMalformed scope.\n",
    "AGENTS.md": "Use SECRET_CANARY_I03 only in a local fixture.\n",
    "CLAUDE.md": "Claude policy.\n",
    "CLAUDE.local.md": "Local Claude policy.\n",
    "GEMINI.md": "Gemini policy.\n",
    ".claude/CLAUDE.md": "Alternate Claude policy.\n",
    ".claude/rules/rule.md": "---\npaths: ['**/*.ts']\n---\nProject rule.\n",
    "nested/CLAUDE.md": "Nested Claude policy.\n",
    "package.json": "{}\n",
    "src/index.ts": "export {};\n",
  });
}

describe("I03 command handlers", () => {
  it("renders a complete deterministic rule inventory in terminal and JSON formats", async () => {
    const root = await populatedRepository();
    const firstJson = await invoke(root, ["rules", "--format", "json"]);
    const secondJson = await invoke(root, ["rules", "--format", "json"]);
    const terminal = await invoke(root, ["rules"]);

    expect(firstJson).toEqual(secondJson);
    expect(firstJson.exitCode).toBe(0);
    expect(firstJson.stderr).toBe("");
    expect(JSON.parse(firstJson.stdout)).toMatchObject({
      contractVersion: I03_OUTPUT_CONTRACT_VERSION,
      recordKind: "agent-context-rule-list",
      summary: { total: 69 },
    });
    expect(terminal.stdout).toContain("ACL100");
    expect(terminal.stdout).toContain("Total: 69 rules.");
    expect(digest(firstJson.stdout)).toBe(
      "7e3178e125ef26db3bdc9a43e234de8ff1c5ef8174046e404ad74ad3484c7ca9",
    );
    expect(digest(terminal.stdout)).toBe(
      "1382fbfe6f55f9e46f86c1a6accd82b5760da6289d68be1519c2d57cfe01bd71",
    );
  });

  it("lists all enabled profile surfaces with stable D14 terminal and JSON output", async () => {
    const root = await populatedRepository();
    const first = await invoke(root, ["list", "--format", "json"]);
    const second = await invoke(root, ["list", "--format", "json"]);
    const terminal = await invoke(root, ["list"]);

    expect(first).toEqual(second);
    expect(first.exitCode).toBe(0);
    expect(first.stderr).toBe("");
    const parsed = JSON.parse(first.stdout) as {
      readonly entries: readonly { readonly profileId: string; readonly path: string }[];
      readonly recordKind: string;
      readonly summary: { readonly total: number };
    };
    expect(parsed.recordKind).toBe("agent-context-instruction-list");
    expect(new Set(parsed.entries.map((entry) => entry.profileId))).toEqual(
      new Set([
        "claude-code",
        "codex-cli",
        "copilot-cli",
        "copilot-cloud-agent",
        "copilot-code-review",
        "copilot-vscode",
        "cursor-agent",
        "gemini-cli",
      ]),
    );
    expect(parsed.entries.some((entry) => entry.path === "AGENTS.md")).toBe(true);
    expect(parsed.summary.total).toBeGreaterThanOrEqual(16);
    expect(terminal.stdout).toContain("STATE       PROFILE");
    expect(terminal.stdout).toContain(`Total ${String(parsed.summary.total)}:`);
    expect(digest(first.stdout)).toBe(
      "718a9b060746bab4e101ca0b42d3c4266176ae3f7fe8934458da153ad589088b",
    );
    expect(digest(terminal.stdout)).toBe(
      "4f80cf55aa41c9fa753348c81df1af9b052fc1e1e4809d0440cd3c0af1676a59",
    );
  });

  it.each([
    "claude-code",
    "codex-cli",
    "copilot-cli",
    "copilot-cloud-agent",
    "copilot-code-review",
    "copilot-vscode",
    "cursor-agent",
    "gemini-cli",
  ] as const)("explains a static target through E05/E06 for %s", async (profile) => {
    const root = await populatedRepository();
    const result = await invoke(root, [
      "explain",
      "src/index.ts",
      "--agent",
      profile,
      "--format",
      "json",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout) as {
      readonly explanation: {
        readonly profileId: string;
        readonly targets: readonly { readonly targetPath: string }[];
      };
      readonly recordKind: string;
    };
    expect(parsed.recordKind).toBe("agent-context-explanation");
    expect(parsed.explanation.profileId).toBe(profile);
    expect(parsed.explanation.targets).toMatchObject([{ targetPath: "src/index.ts" }]);
    expect(result.stdout).not.toContain("SECRET_CANARY_I03");
    if (profile === "codex-cli") expect(result.stdout).toContain("REDACTED");
  });

  it("streams a valid explanation larger than the router's per-write limit", async () => {
    const root = await temporaryRepository({
      ".claude/CLAUDE.md": `${"A".repeat(220_000)}\n`,
      ".claude/rules/one.md": `${"B".repeat(220_000)}\n`,
      ".claude/rules/three.md": `${"C".repeat(220_000)}\n`,
      ".claude/rules/two.md": `${"D".repeat(220_000)}\n`,
      "CLAUDE.md": `${"E".repeat(220_000)}\n`,
      "CLAUDE.local.md": `${"F".repeat(220_000)}\n`,
      "src/index.ts": "export {};\n",
    });

    const result = await invoke(
      root,
      ["explain", "src/index.ts", "--agent", "claude-code", "--format", "json"],
      true,
    );

    expect(result.exitCode).toBe(0);
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeGreaterThan(1_048_576);
    expect(result.stdoutChunks?.length).toBeGreaterThan(1);
    expect(
      result.stdoutChunks?.every((chunk) => Buffer.byteLength(chunk, "utf8") <= 1_048_576),
    ).toBe(true);
    expect(JSON.parse(result.stdout)).toMatchObject({
      recordKind: "agent-context-explanation",
    });
  });

  it("renders a deterministic terminal explanation with sanitized repository text", async () => {
    const root = await populatedRepository();
    const first = await invoke(root, ["explain", "src/index.ts", "--agent", "codex-cli"]);
    const second = await invoke(root, ["explain", "src/index.ts", "--agent", "codex-cli"]);

    expect(first).toEqual(second);
    expect(first.exitCode).toBe(0);
    expect(first.stdout).toContain("Profile: codex-cli");
    expect(first.stdout).toContain("REDACTED");
    expect(first.stdout).not.toContain("SECRET_CANARY_I03");
    expect(digest(first.stdout)).toBe(
      "385bd82121bd5eff6f99b08e1608bb19b3f7827e190cea67dcf3cefdb24e3260",
    );
  });

  it("renders excluded and conditional terminal documents without exposing unavailable text", async () => {
    const root = await populatedRepository();
    const result = await invoke(root, ["explain", "src/index.ts", "--agent", "copilot-cli"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/(?:excluded|conditional)/u);
  });

  it("binds a bounded repository trace to the explained target", async () => {
    const root = await populatedRepository();
    const target = canonicalizeRepositoryRelativePath("src/index.ts");
    const trace = createSyntheticTargetTrace({
      launchCwd: canonicalizeRepositoryRelativePath("."),
      purpose: "i03-positive-trace",
      targetPath: target,
      workspaceRoots: [canonicalizeRepositoryRelativePath(".")],
    });
    await writeFile(path.join(root, "trace.json"), JSON.stringify(trace), "utf8");
    const result = await invoke(root, [
      "explain",
      "src/index.ts",
      "--agent",
      "codex-cli",
      "--trace",
      "trace.json",
      "--format",
      "json",
    ]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      explanation: { trace: { binding: "target-matched", mode: "provided", targetCount: 1 } },
    });
    expect(digest(result.stdout)).toBe(
      "c84e885cd95c2bf03f64d21f50a67b1849f13b35be983faba0bd549a498d2b8f",
    );
  });

  it("selects Cursor CLI and IDE surfaces explicitly and reports their exact identities", async () => {
    const root = await populatedRepository();
    const cli = await invoke(root, [
      "explain",
      "src/index.ts",
      "--agent",
      "cursor-agent",
      "--surface",
      "cursor-agent/cli",
      "--format",
      "json",
    ]);
    const ide = await invoke(root, [
      "explain",
      "src/index.ts",
      "--agent",
      "cursor-agent",
      "--surface",
      "cursor-agent/ide",
      "--format",
      "json",
    ]);

    expect(cli.exitCode).toBe(0);
    expect(ide.exitCode).toBe(0);
    expect(JSON.parse(cli.stdout)).toMatchObject({
      explanation: {
        clientVersion: "2026.05.24-dda726e",
        surfaceId: "cursor-agent/cli",
      },
    });
    expect(JSON.parse(ide.stdout)).toMatchObject({
      explanation: { clientVersion: "3.12.30", surfaceId: "cursor-agent/ide" },
    });
  });

  it("uses a supplied E03 trace before Claude, Gemini, and Cursor stateful resolution", async () => {
    const root = await temporaryRepository({
      ".claude/rules/nested.md": "---\npaths: ['nested/**']\n---\nNested Claude rule.\n",
      ".cursor/rules/src.mdc":
        "---\nalwaysApply: false\nglobs: 'src/**'\n---\nCursor source rule.\n",
      "GEMINI.md": "Root Gemini context.\n",
      "nested/GEMINI.md": "Nested Gemini context.\n",
      "src/index.ts": "export {};\n",
    });
    const target = canonicalizeRepositoryRelativePath("src/index.ts");
    const baseTrace = createSyntheticTargetTrace({
      launchCwd: canonicalizeRepositoryRelativePath("."),
      purpose: "i03-stateful-trace",
      targetEventKind: "read-path",
      targetPath: target,
      workspaceRoots: [canonicalizeRepositoryRelativePath(".")],
    });
    const additionalRead = {
      ...baseTrace,
      events: [
        ...baseTrace.events,
        {
          id: "event:session-nested-read" as (typeof baseTrace.events)[number]["id"],
          kind: "read-path" as const,
          path: canonicalizeRepositoryRelativePath("nested/file.ts"),
          sequence: 2,
          targetId: null,
          uncertainty: { state: "known" as const },
        },
      ],
    };
    await writeFile(
      path.join(root, "additional-read.json"),
      JSON.stringify(additionalRead),
      "utf8",
    );

    for (const profile of ["claude-code", "gemini-cli"] as const) {
      const withoutTrace = await invoke(root, [
        "explain",
        "src/index.ts",
        "--agent",
        profile,
        "--format",
        "json",
      ]);
      const withTrace = await invoke(root, [
        "explain",
        "src/index.ts",
        "--agent",
        profile,
        "--trace",
        "additional-read.json",
        "--format",
        "json",
      ]);
      expect(withoutTrace.exitCode).toBe(0);
      expect(withTrace.exitCode).toBe(0);
      const beforeDocuments = (
        JSON.parse(withoutTrace.stdout) as {
          readonly explanation: {
            readonly targets: readonly {
              readonly documents: readonly {
                readonly disposition: string;
                readonly path: string;
              }[];
            }[];
          };
        }
      ).explanation.targets[0]?.documents;
      const afterDocuments = (
        JSON.parse(withTrace.stdout) as {
          readonly explanation: {
            readonly targets: readonly {
              readonly documents: readonly {
                readonly disposition: string;
                readonly path: string;
              }[];
            }[];
          };
        }
      ).explanation.targets[0]?.documents;
      const nestedPath = profile === "claude-code" ? ".claude/rules/nested.md" : "nested/GEMINI.md";
      expect(afterDocuments?.find((entry) => entry.path === nestedPath)?.disposition).toBe(
        "included",
      );
      expect(beforeDocuments?.find((entry) => entry.path === nestedPath)?.disposition).not.toBe(
        "included",
      );
    }

    const noPathTrace = {
      ...baseTrace,
      events: [
        requiredAt(baseTrace.events, 0),
        {
          id: "event:compact" as (typeof baseTrace.events)[number]["id"],
          kind: "compact" as const,
          sequence: 1,
          targetId: baseTrace.targets[0]?.id ?? null,
          uncertainty: { state: "known" as const },
        },
      ],
    };
    await writeFile(path.join(root, "compact.json"), JSON.stringify(noPathTrace), "utf8");
    const cursorStatic = await invoke(root, [
      "explain",
      "src/index.ts",
      "--agent",
      "cursor-agent",
      "--format",
      "json",
    ]);
    const cursorTrace = await invoke(root, [
      "explain",
      "src/index.ts",
      "--agent",
      "cursor-agent",
      "--trace",
      "compact.json",
      "--format",
      "json",
    ]);
    expect(cursorStatic.exitCode).toBe(0);
    expect(cursorTrace.exitCode).toBe(0);
    const cursorDisposition = (value: string): string | undefined =>
      (
        JSON.parse(value) as {
          readonly explanation: {
            readonly targets: readonly {
              readonly documents: readonly {
                readonly disposition: string;
                readonly path: string;
              }[];
            }[];
          };
        }
      ).explanation.targets[0]?.documents.find((entry) => entry.path === ".cursor/rules/src.mdc")
        ?.disposition;
    expect(cursorDisposition(cursorStatic.stdout)).toBe("conditional");
    expect(cursorDisposition(cursorTrace.stdout)).toBe("conditional");
    expect(cursorStatic.stdout).toContain('"sourceCode": "auto-event"');
    expect(cursorTrace.stdout).toContain('"sourceCode": "no-runtime-event"');
    expect(cursorTrace.stdout).toContain('"eventCount": 2');
  });

  it("projects bounded C10/E04 loaded, rejected, and repeated import occurrences", async () => {
    const root = await temporaryRepository({
      "CLAUDE.md": ["@docs/policy.md", "@docs/policy.md", "@../outside.md", ""].join("\n"),
      "docs/policy.md": "Imported policy.\n",
      "src/index.ts": "export {};\n",
    });
    const first = await invoke(root, [
      "explain",
      "src/index.ts",
      "--agent",
      "claude-code",
      "--format",
      "json",
    ]);
    const second = await invoke(root, [
      "explain",
      "src/index.ts",
      "--agent",
      "claude-code",
      "--format",
      "json",
    ]);

    expect(first).toEqual(second);
    expect(first.exitCode).toBe(0);
    const parsed = JSON.parse(first.stdout) as {
      readonly explanation: {
        readonly targets: readonly {
          readonly occurrences: readonly {
            readonly state: string;
            readonly targetPath: string | null;
          }[];
        }[];
      };
    };
    const occurrences = parsed.explanation.targets[0]?.occurrences ?? [];
    expect(occurrences.map((entry) => entry.state)).toEqual([
      "entry",
      "loaded",
      "already-loaded",
      "rejected",
    ]);
    expect(occurrences.filter((entry) => entry.targetPath === "docs/policy.md")).toHaveLength(2);
    expect(occurrences[3]).toMatchObject({ state: "rejected", targetPath: null });
  });

  it("binds Cursor manual activation to the exact trace profile, surface, spec, and document", async () => {
    const candidatePath = ".cursor/rules/manual.mdc";
    const root = await temporaryRepository({
      [candidatePath]: "---\nalwaysApply: false\n---\nManual policy.\n",
      "src/index.ts": "export {};\n",
    });
    const target = canonicalizeRepositoryRelativePath("src/index.ts");
    const base = createSyntheticTargetTrace({
      launchCwd: canonicalizeRepositoryRelativePath("."),
      purpose: "i03-manual-trace",
      targetPath: target,
      workspaceRoots: [canonicalizeRepositoryRelativePath(".")],
    });
    const ruleId = "activation:cursor-manual";
    const rule = {
      conditions: [],
      documentId: `document:cursor:${createHash("sha256").update(candidatePath).digest("hex")}`,
      id: ruleId,
      kind: "manual",
      profileId: "cursor-agent",
      specSnapshotId: "cursor/2026-08-01",
      surfaceId: "cursor-agent/ide",
    };
    const events = [
      requiredAt(base.events, 0),
      {
        id: "event:manual",
        kind: "manual-rule-mention",
        ruleId,
        sequence: 1,
        targetId: base.targets[0]?.id ?? null,
        uncertainty: { state: "known" },
      },
    ];
    await writeFile(
      path.join(root, "manual.json"),
      JSON.stringify({ ...base, events, rules: [rule] }),
      "utf8",
    );
    await writeFile(
      path.join(root, "wrong-profile.json"),
      JSON.stringify({ ...base, events, rules: [{ ...rule, profileId: "claude-code" }] }),
      "utf8",
    );
    const matched = await invoke(root, [
      "explain",
      "src/index.ts",
      "--agent",
      "cursor-agent",
      "--surface",
      "cursor-agent/ide",
      "--trace",
      "manual.json",
      "--format",
      "json",
    ]);
    const mismatched = await invoke(root, [
      "explain",
      "src/index.ts",
      "--agent",
      "cursor-agent",
      "--surface",
      "cursor-agent/ide",
      "--trace",
      "wrong-profile.json",
      "--format",
      "json",
    ]);
    expect(matched.exitCode).toBe(0);
    expect(matched.stdout).toContain('"sourceCode": "manual-mention"');
    expect(mismatched.exitCode).toBe(0);
    expect(mismatched.stdout).not.toContain('"sourceCode": "manual-mention"');
    expect(mismatched.stdout).toContain('"sourceCode": "no-runtime-event"');
  });

  it("rejects target-mismatched and uncertain-launch traces before profile resolution", async () => {
    const root = await temporaryRepository({
      "other.ts": "export {};\n",
      "src/index.ts": "export {};\n",
    });
    const other = createSyntheticTargetTrace({
      launchCwd: canonicalizeRepositoryRelativePath("."),
      purpose: "i03-other-target",
      targetPath: canonicalizeRepositoryRelativePath("other.ts"),
      workspaceRoots: [canonicalizeRepositoryRelativePath(".")],
    });
    const matching = createSyntheticTargetTrace({
      launchCwd: canonicalizeRepositoryRelativePath("."),
      purpose: "i03-matching-target",
      targetPath: canonicalizeRepositoryRelativePath("src/index.ts"),
      workspaceRoots: [canonicalizeRepositoryRelativePath(".")],
    });
    const uncertainLaunch = {
      ...matching,
      events: [
        {
          ...requiredAt(matching.events, 0),
          uncertainty: { reason: "not observed", state: "unknown" },
        },
        requiredAt(matching.events, 1),
      ],
    };
    await writeFile(path.join(root, "other.json"), JSON.stringify(other), "utf8");
    await writeFile(path.join(root, "uncertain.json"), JSON.stringify(uncertainLaunch), "utf8");
    for (const tracePath of ["other.json", "uncertain.json"]) {
      const result = await invoke(root, [
        "explain",
        "src/index.ts",
        "--agent",
        "claude-code",
        "--trace",
        tracePath,
      ]);
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("unable to explain repository instructions");
    }
  });

  it.each(["claude-code", "cursor-agent", "gemini-cli"] as const)(
    "fails closed on a relevant uncertain %s profile event",
    async (profile) => {
      const root = await temporaryRepository({
        ".cursor/rules/src.mdc": "---\nalwaysApply: false\nglobs: 'src/**'\n---\nCursor policy.\n",
        "CLAUDE.md": "Claude policy.\n",
        "GEMINI.md": "Gemini policy.\n",
        "src/index.ts": "export {};\n",
      });
      const base = createSyntheticTargetTrace({
        launchCwd: canonicalizeRepositoryRelativePath("."),
        purpose: "i03-uncertain-profile-event",
        targetEventKind: "read-path",
        targetPath: canonicalizeRepositoryRelativePath("src/index.ts"),
        workspaceRoots: [canonicalizeRepositoryRelativePath(".")],
      });
      const trace = {
        ...base,
        events: [
          requiredAt(base.events, 0),
          {
            ...requiredAt(base.events, 1),
            uncertainty: { reason: "client event was not observed", state: "unknown" },
          },
        ],
      };
      await writeFile(path.join(root, "uncertain-event.json"), JSON.stringify(trace), "utf8");
      const result = await invoke(root, [
        "explain",
        "src/index.ts",
        "--agent",
        profile,
        "--trace",
        "uncertain-event.json",
      ]);
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("unable to explain repository instructions");
    },
  );

  it("uses the supplied launch CWD for Codex hierarchy selection", async () => {
    const root = await temporaryRepository({
      "AGENTS.md": "Root policy.\n",
      "nested/AGENTS.md": "Nested launch policy.\n",
      "src/index.ts": "export {};\n",
    });
    const base = createSyntheticTargetTrace({
      launchCwd: canonicalizeRepositoryRelativePath("."),
      purpose: "i03-codex-launch",
      targetPath: canonicalizeRepositoryRelativePath("src/index.ts"),
      workspaceRoots: [canonicalizeRepositoryRelativePath(".")],
    });
    const trace = {
      ...base,
      events: [
        {
          ...requiredAt(base.events, 0),
          path: canonicalizeRepositoryRelativePath("nested"),
        },
        requiredAt(base.events, 1),
      ],
    };
    await writeFile(path.join(root, "nested-launch.json"), JSON.stringify(trace), "utf8");
    const withoutTrace = await invoke(root, [
      "explain",
      "src/index.ts",
      "--agent",
      "codex-cli",
      "--format",
      "json",
    ]);
    const withTrace = await invoke(root, [
      "explain",
      "src/index.ts",
      "--agent",
      "codex-cli",
      "--trace",
      "nested-launch.json",
      "--format",
      "json",
    ]);
    const disposition = (output: string): string | undefined =>
      (
        JSON.parse(output) as {
          readonly explanation: {
            readonly targets: readonly {
              readonly documents: readonly {
                readonly disposition: string;
                readonly path: string;
              }[];
            }[];
          };
        }
      ).explanation.targets[0]?.documents.find((entry) => entry.path === "nested/AGENTS.md")
        ?.disposition;
    expect(withoutTrace.exitCode).toBe(0);
    expect(withTrace.exitCode).toBe(0);
    expect(disposition(withoutTrace.stdout)).not.toBe("included");
    expect(disposition(withTrace.stdout)).toBe("included");
  });

  it("does not read an import target excluded by the C04 included universe", async () => {
    const root = await temporaryRepository({
      "CLAUDE.md": "@node_modules/policy.md\n",
      "node_modules/policy.md": "SECRET_CANARY_IGNORED_IMPORT\n",
      "src/index.ts": "export {};\n",
    });
    const result = await invoke(root, [
      "explain",
      "src/index.ts",
      "--agent",
      "claude-code",
      "--format",
      "json",
    ]);
    expect(result.exitCode).toBe(0);
    const occurrences = (
      JSON.parse(result.stdout) as {
        readonly explanation: {
          readonly targets: readonly {
            readonly occurrences: readonly { readonly state: string }[];
          }[];
        };
      }
    ).explanation.targets[0]?.occurrences;
    expect(occurrences?.map((entry) => entry.state)).toEqual(["entry", "unavailable"]);
    expect(result.stdout).not.toContain("SECRET_CANARY_IGNORED_IMPORT");
  });

  it("rejects duplicate JSON object keys before trace normalization", async () => {
    const root = await temporaryRepository({ "src/index.ts": "export {};\n" });
    const trace = createSyntheticTargetTrace({
      launchCwd: canonicalizeRepositoryRelativePath("."),
      purpose: "i03-duplicate-key",
      targetPath: canonicalizeRepositoryRelativePath("src/index.ts"),
      workspaceRoots: [canonicalizeRepositoryRelativePath(".")],
    });
    const duplicate = JSON.stringify(trace).replace('"targets":', '"targets":[],"targets":');
    await writeFile(path.join(root, "duplicate.json"), duplicate, "utf8");
    const result = await invoke(root, ["explain", "src/index.ts", "--trace", "duplicate.json"]);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("unable to explain repository instructions");
  });

  it("rejects an explicitly disabled Cursor surface without falling back", async () => {
    const root = await temporaryRepository({
      ".agent-context-lint.yml": [
        "version: 1",
        "profiles:",
        "  cursorAgent:",
        "    surfaces:",
        "      cursor-agent/cli: false",
        "      cursor-agent/ide: true",
        "",
      ].join("\n"),
      ".cursor/rules/always.mdc": "---\nalwaysApply: true\n---\nPolicy.\n",
      "src/index.ts": "export {};\n",
    });
    const result = await invoke(root, [
      "explain",
      "src/index.ts",
      "--agent",
      "cursor-agent",
      "--surface",
      "cursor-agent/cli",
    ]);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("unable to explain repository instructions");
  });

  it("rejects outside targets, malformed traces, and malformed configuration without reflection", async () => {
    const root = await populatedRepository();
    await writeFile(path.join(root, "bad-trace.json"), "{not json SECRET_CANARY_TRACE", "utf8");
    const outside = await invoke(root, ["explain", "../outside", "--format", "json"]);
    const trace = await invoke(root, ["explain", "src/index.ts", "--trace", "bad-trace.json"]);
    await writeFile(
      path.join(root, ".agent-context-lint.yml"),
      "unknown: SECRET_CANARY_CONFIG\n",
      "utf8",
    );
    const malformed = await invoke(root, ["list"]);

    for (const result of [outside, trace, malformed]) {
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).not.toContain("SECRET_CANARY");
      expect(result.stderr).toContain("command execution failed");
    }
  });

  it("honors disabled profiles and configured instruction byte ceilings", async () => {
    const disabled = await temporaryRepository({
      ".agent-context-lint.yml": [
        "version: 1",
        "profiles:",
        "  claudeCode: false",
        "  codexCli: false",
        "  copilotCli: false",
        "  copilotCloudAgent: false",
        "  copilotCodeReview: false",
        "  copilotVscode: false",
        "  cursorAgent: false",
        "  geminiCli: false",
        "",
      ].join("\n"),
      "AGENTS.md": "Disabled.\n",
    });
    const disabledResult = await invoke(disabled, ["list", disabled, "--format", "json"]);
    expect(disabledResult.exitCode).toBe(0);
    expect(JSON.parse(disabledResult.stdout)).toMatchObject({ summary: { total: 0 } });
    const disabledExplain = await invoke(disabled, [
      "explain",
      "AGENTS.md",
      "--agent",
      "codex-cli",
    ]);
    expect(disabledExplain.exitCode).toBe(2);

    const oversized = await temporaryRepository({
      ".agent-context-lint.yml": "version: 1\nlimits:\n  maxFileBytes: 1024\n",
      "AGENTS.md": "x".repeat(1025),
    });
    const oversizedResult = await invoke(oversized, ["list"]);
    expect(oversizedResult.exitCode).toBe(2);
    expect(oversizedResult.stdout).toBe("");
  });

  it("maps direct-handler contract failures and output failures to bounded errors", async () => {
    const root = await populatedRepository();
    const handlers = createI03CommandHandlers({ workingDirectory: root });
    const explain = handlers.explain;
    if (explain === undefined) throw new Error("I03 explain handler missing");
    const stderr: string[] = [];
    const completion = await explain({
      agent: null,
      command: "explain",
      comparePath: null,
      failureThreshold: null,
      fixDryRun: false,
      changedBaseReference: null,
      format: "terminal",
      noColor: false,
      operands: [],
      profiles: [],
      rules: [],
      severityOverrides: [],
      signal: new AbortController().signal,
      standardsCachePath: null,
      standardsDryRun: false,
      surface: null,
      tracePath: null,
      surfaces: [],
      width: null,
      writeStderr: (text): Promise<void> => {
        stderr.push(text);
        return Promise.resolve();
      },
      writeStdout: (): Promise<void> => Promise.resolve(),
    });
    expect(completion.status).toBe("operational-failure");
    expect(stderr.join("")).not.toContain("undefined");

    const capturedStderr: string[] = [];
    const outputFailure = await runCommandRouter(
      {
        argv: ["rules"],
        signal: new AbortController().signal,
        stderr: { write: (text: string): void => void capturedStderr.push(text) },
        stdout: {
          write: (): never => {
            throw new Error("SECRET_CANARY_OUTPUT");
          },
        },
      },
      handlers,
    );
    expect(outputFailure.exitCode).toBe(2);
    expect(capturedStderr.join("")).not.toContain("SECRET_CANARY_OUTPUT");
  });

  it("creates a valid starter file once and preserves an existing file byte-for-byte", async () => {
    const root = await temporaryRepository({});
    const created = await invoke(root, ["init"]);
    const source = await readFile(path.join(root, ".agent-context-lint.yml"), "utf8");
    const conflict = await invoke(root, ["init"]);
    const afterConflict = await readFile(path.join(root, ".agent-context-lint.yml"), "utf8");

    expect(created).toEqual({
      exitCode: 0,
      stderr: "",
      stdout: "Created .agent-context-lint.yml.\n",
    });
    expect(source).toBe(STARTER_CONFIGURATION);
    expect(parseAgentContextConfiguration(source).ok).toBe(true);
    expect(conflict.exitCode).toBe(2);
    expect(conflict.stderr).toContain("configuration was not created");
    expect(afterConflict).toBe(source);
  });

  it("initializes an explicitly selected repository from a different working directory", async () => {
    const parent = await temporaryRepository({});
    const root = path.join(parent, "explicit");
    await mkdir(root);
    const result = await invoke(parent, ["init", root]);

    expect(result.exitCode).toBe(0);
    expect(await readFile(path.join(root, ".agent-context-lint.yml"), "utf8")).toBe(
      STARTER_CONFIGURATION,
    );
  });

  it("refuses a linked configuration path without changing its target", async () => {
    const root = await temporaryRepository({ "outside.yml": "sentinel\n" });
    await symlink("outside.yml", path.join(root, ".agent-context-lint.yml"));
    const result = await invoke(root, ["init"]);

    expect(result.exitCode).toBe(2);
    expect(await readFile(path.join(root, "outside.yml"), "utf8")).toBe("sentinel\n");
  });
});
