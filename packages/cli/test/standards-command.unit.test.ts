import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadBundledKnowledgePack, serializeStandardsLockfile } from "@agent-context/standards";
import { afterEach, describe, expect, test } from "vitest";

import {
  runCommandRouter,
  type CliCommandHandlers,
  type CliInvocation,
} from "../src/command-router.js";
import { createStandardsCommandHandlers } from "../src/standards-command.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function repository(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "agent-context-standards-cli-"));
  roots.push(root);
  await mkdir(path.join(root, ".git"));
  await writeFile(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");
  return root;
}

function invoke(
  _root: string,
  argv: readonly string[],
  handlers: CliCommandHandlers,
): Promise<{
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}> {
  const stderr: string[] = [];
  const stdout: string[] = [];
  const invocation: CliInvocation = {
    argv,
    signal: new AbortController().signal,
    stderr: { write: (text): void => void stderr.push(text) },
    stdout: { write: (text): void => void stdout.push(text) },
  };
  return runCommandRouter(invocation, handlers).then((result) => ({
    exitCode: result.exitCode,
    stderr: stderr.join(""),
    stdout: stdout.join(""),
  }));
}

function handlers(root: string): CliCommandHandlers {
  return createStandardsCommandHandlers({
    now: () => "2026-08-11T12:00:00Z",
    workingDirectory: root,
  });
}

async function bundledLock(): Promise<string> {
  const loaded = await loadBundledKnowledgePack({ channel: "stable", engineVersion: "0.0.0" });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues));
  const bundle = loaded.value;
  const serialized = serializeStandardsLockfile({
    channel: bundle.pack.channel,
    pack: {
      packId: bundle.pack.packId,
      packVersion: bundle.pack.packVersion,
      publishedAt: bundle.pack.publishedAt,
      schemaVersion: bundle.pack.schemaVersion,
    },
    recordKind: "agent-context-standards-lock",
    schemaVersion: "1.0.0",
    target: bundle.provenance.target,
    trustedState: bundle.provenance.trustedState,
    verificationTime: bundle.provenance.verificationTime,
  });
  if (!serialized.ok) throw new Error(JSON.stringify(serialized.issues));
  return serialized.text;
}

describe("standards CLI handlers", () => {
  test("renders deterministic offline status JSON with no lockfile", async () => {
    const root = await repository();
    const first = await invoke(root, ["standards", "status", "--format", "json"], handlers(root));
    const second = await invoke(root, ["standards", "status", "--format", "json"], handlers(root));

    expect(first.exitCode).toBe(0);
    expect(first.stderr).toBe("");
    expect(first.stdout).toBe(second.stdout);
    expect(JSON.parse(first.stdout)).toMatchObject({
      contractVersion: "0.1.0",
      output: {
        activation: "bundled",
        channel: "stable",
        freshness: "offline-unknown",
        locked: null,
      },
      recordKind: "agent-context-offline-standards-status",
    });
  });

  test("reports malformed repository lock state without reading outside the root", async () => {
    const root = await repository();
    await writeFile(path.join(root, "agent-context-standards.lock.json"), "{}\n", "utf8");
    const result = await invoke(root, ["standards", "status", "--format", "json"], handlers(root));

    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.stdout) as {
      readonly issues: readonly { readonly code: string }[];
    };
    expect(report.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "invalid-lockfile" })]),
    );
  });

  test("fails closed when the explicit registry is not configured", async () => {
    const root = await repository();
    const result = await invoke(root, ["standards", "check", "--format", "json"], handlers(root));

    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout)).toEqual({
      contractVersion: "0.1.0",
      issues: [expect.objectContaining({ code: "registry-unconfigured", source: "registry" })],
      operation: "check",
      recordKind: "agent-context-standards-command-error",
    });
    expect(result.stdout).not.toContain("http");
  });

  test("requires an existing lock and explicit private cache for a write-capable update", async () => {
    const root = await repository();
    const missing = await invoke(root, ["standards", "update", "--format", "json"], handlers(root));
    expect(missing.exitCode).toBe(2);
    expect(missing.stdout).toContain("agent-context-standards-command-error");

    const lockPath = path.join(root, "agent-context-standards.lock.json");
    await writeFile(lockPath, await bundledLock(), "utf8");
    const dryRun = await invoke(
      root,
      ["standards", "update", "--dry-run", "--format", "json"],
      handlers(root),
    );
    expect(dryRun.exitCode).toBe(2);
    expect(dryRun.stdout).toContain('"operation":"update"');
    const lockBefore = await readFile(lockPath, "utf8");
    const noCache = await invoke(root, ["standards", "update"], handlers(root));
    expect(noCache.exitCode).toBe(2);
    expect(await readFile(lockPath, "utf8")).toBe(lockBefore);
  });

  test.each([
    ["standards", "status", "--dry-run"],
    ["standards", "status", "--cache", "/tmp/cache"],
    ["standards", "update", "--cache", "relative-cache"],
    ["standards", "update", "--dry-run", "--dry-run"],
    ["standards", "update", "--dry-run", "--cache", "/tmp/cache"],
  ] as const)("rejects unsafe standards option grammar %j", async (...argv) => {
    const root = await repository();
    const result = await invoke(root, argv, handlers(root));
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
  });
});
