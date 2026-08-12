import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const WORKSPACE = fileURLToPath(new URL("..", import.meta.url));
const CLI = path.join(WORKSPACE, "packages/cli/dist/cli.js");
let repository = "";

function run(arguments_: readonly string[]): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [CLI, ...arguments_], {
    cwd: repository,
    encoding: "utf8",
    env: { PATH: process.env["PATH"] ?? "" },
    shell: false,
    timeout: 20_000,
  });
}

beforeAll(async () => {
  repository = await mkdtemp(path.join(os.tmpdir(), "agent-context-i03-packed-"));
  await mkdir(path.join(repository, "src"));
  await writeFile(path.join(repository, "AGENTS.md"), "Packaged CLI policy.\n", "utf8");
  await writeFile(path.join(repository, "src/index.ts"), "export {};\n", "utf8");
  await chmod(CLI, 0o755);
});

afterAll(async () => {
  if (repository !== "") await rm(repository, { force: true, recursive: true });
});

describe("I03 built CLI", () => {
  it("runs list, explain, and rules through the built executable", () => {
    const listed = run(["list", "--format", "json"]);
    const explained = run(["explain", "src/index.ts", "--agent", "codex-cli", "--format", "json"]);
    const rules = run(["rules", "--format", "json"]);

    for (const result of [listed, explained, rules]) {
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(() => {
        JSON.parse(result.stdout);
      }).not.toThrow();
    }
    expect(JSON.parse(listed.stdout)).toMatchObject({
      recordKind: "agent-context-instruction-list",
      summary: { total: 1 },
    });
    expect(JSON.parse(explained.stdout)).toMatchObject({
      explanation: { profileId: "codex-cli" },
      recordKind: "agent-context-explanation",
    });
    expect(JSON.parse(rules.stdout)).toMatchObject({
      recordKind: "agent-context-rule-list",
      summary: { total: 69 },
    });
  });

  it("performs non-destructive init through the built executable", async () => {
    const first = run(["init"]);
    const source = await readFile(path.join(repository, ".agent-context-lint.yml"), "utf8");
    const second = run(["init"]);

    expect(first.status).toBe(0);
    expect(first.stdout).toBe("Created .agent-context-lint.yml.\n");
    expect(second.status).toBe(2);
    expect(await readFile(path.join(repository, ".agent-context-lint.yml"), "utf8")).toBe(source);
  });
});
