import { spawnSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, test } from "vitest";

import {
  BUILTIN_ESTIMATE_PROVIDER_ID,
  EXACT_TOKENIZER_MAX_TIMEOUT_MS,
  EXACT_TOKENIZER_MIN_TIMEOUT_MS,
  OPTIONAL_UTF8_BYTE_PROVIDER_ID,
  countTokensWithProvider,
  resolveTokenizerProvider,
} from "../src/index.js";
import {
  countTokensWithProviderAtBase,
  loadExactTokenizerArtifact,
  runExactTokenizerWorkerForTest,
} from "../src/exact-tokenizer.js";

const OPTIONAL_PACKAGE = new URL("../../../optional-tokenizers/utf8-byte/", import.meta.url);
const VALID_WASM = Buffer.from(
  "AGFzbQEAAAABBwFgAn9/AX8CEQEDZW52Bm1lbW9yeQIBAYECAwIBAAcJAQVjb3VudAAACgYBBAAgAQs=",
  "base64",
);
const HANGING_WASM = Buffer.from(
  "AGFzbQEAAAABBwFgAn9/AX8CEQEDZW52Bm1lbW9yeQIBAYECAwIBAAcJAQVjb3VudAAACgsBCQADQAwAC0EACw==",
  "base64",
);
const NEGATIVE_WASM = Buffer.from(
  "AGFzbQEAAAABBwFgAn9/AX8CEQEDZW52Bm1lbW9yeQIBAYECAwIBAAcJAQVjb3VudAAACgYBBABBfws=",
  "base64",
);

async function withPackage(
  mutate?: (directory: string) => Promise<void>,
): Promise<{ readonly baseUrl: string; readonly root: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "acl-exact-tokenizer-"));
  const directory = path.join(root, "node_modules", "@agent-context", "tokenizer-utf8-byte");
  await mkdir(directory, { recursive: true });
  for (const name of ["package.json", "manifest.v1.json", "provider.wasm.b64"]) {
    await copyFile(new URL(name, OPTIONAL_PACKAGE), path.join(directory, name));
  }
  if (mutate !== undefined) await mutate(directory);
  return { baseUrl: pathToFileURL(path.join(root, "host.mjs")).href, root };
}

describe("G10 optional exact tokenizer", () => {
  test("registers immutable exact provider metadata without loading package code", () => {
    const resolved = resolveTokenizerProvider(OPTIONAL_UTF8_BYTE_PROVIDER_ID);
    expect(resolved).toEqual({
      ok: true,
      value: {
        contractVersion: "1.0.0",
        execution: "isolated",
        identity: { id: "utf8.byte", measurement: "exact", version: "1.0.0" },
        providerId: OPTIONAL_UTF8_BYTE_PROVIDER_ID,
      },
    });
    expect(resolved.ok && Object.isFrozen(resolved.value)).toBe(true);
    expect(resolved.ok && Object.isFrozen(resolved.value.identity)).toBe(true);
  });

  test("keeps the optional package data-only and outside every default dependency graph", async () => {
    expect((await readdir(OPTIONAL_PACKAGE)).sort()).toEqual([
      "LICENSE",
      "NOTICE",
      "README.md",
      "manifest.v1.json",
      "package.json",
      "provider.wasm.b64",
    ]);
    const manifest = JSON.parse(
      await readFile(new URL("package.json", OPTIONAL_PACKAGE), "utf8"),
    ) as Record<string, unknown>;
    expect(manifest).not.toHaveProperty("dependencies");
    expect(manifest).not.toHaveProperty("optionalDependencies");
    expect(manifest).not.toHaveProperty("peerDependencies");
    expect(manifest).not.toHaveProperty("scripts");
    expect(manifest["files"]).toEqual([
      "LICENSE",
      "NOTICE",
      "README.md",
      "manifest.v1.json",
      "provider.wasm.b64",
    ]);

    const rootManifest = await readFile(new URL("../../../package.json", import.meta.url), "utf8");
    const workspace = await readFile(
      new URL("../../../pnpm-workspace.yaml", import.meta.url),
      "utf8",
    );
    expect(rootManifest).not.toContain("tokenizer-utf8-byte");
    expect(workspace).not.toContain("optional-tokenizers");
  });

  test("loads the separately installed digest-pinned package and counts exact UTF-8 bytes", async () => {
    const fixture = await withPackage();
    try {
      expect(
        await loadExactTokenizerArtifact(OPTIONAL_UTF8_BYTE_PROVIDER_ID, fixture.baseUrl),
      ).toMatchObject({
        status: "available",
      });
      const result = await countTokensWithProviderAtBase(
        OPTIONAL_UTF8_BYTE_PROVIDER_ID,
        "é😀",
        undefined,
        fixture.baseUrl,
      );
      expect(result).toEqual({
        ok: true,
        value: {
          count: {
            contractVersion: "1.0.0",
            identity: { id: "utf8.byte", measurement: "exact", version: "1.0.0" },
            inputCodeUnits: 3,
            inputUtf8Bytes: 6,
            tokens: 6,
          },
          requestedProviderId: OPTIONAL_UTF8_BYTE_PROVIDER_ID,
          resolvedProvider: {
            contractVersion: "1.0.0",
            execution: "isolated",
            identity: { id: "utf8.byte", measurement: "exact", version: "1.0.0" },
            providerId: OPTIONAL_UTF8_BYTE_PROVIDER_ID,
          },
        },
      });
      expect(result.ok && Object.isFrozen(result.value)).toBe(true);
      expect(result.ok && Object.isFrozen(result.value.count)).toBe(true);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  test("resolves the explicitly installed package from pnpm's strict node_modules layout", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "acl-pnpm-exact-tokenizer-"));
    try {
      await writeFile(
        path.join(root, "package.json"),
        `${JSON.stringify(
          {
            name: "exact-tokenizer-install-conformance",
            private: true,
            version: "0.0.0",
            dependencies: {
              "@agent-context/tokenizer-utf8-byte": `file:${fileURLToPath(OPTIONAL_PACKAGE)}`,
            },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      const installation = spawnSync(
        "pnpm",
        [
          "install",
          "--offline",
          "--ignore-scripts",
          "--ignore-workspace",
          "--lockfile=false",
          "--package-import-method=copy",
        ],
        {
          cwd: root,
          encoding: "utf8",
          env: process.env,
          shell: false,
          timeout: 30_000,
        },
      );
      expect({
        error: installation.error?.message,
        signal: installation.signal,
        status: installation.status,
        stderr: installation.stderr,
      }).toMatchObject({ status: 0 });

      await expect(
        countTokensWithProviderAtBase(
          OPTIONAL_UTF8_BYTE_PROVIDER_ID,
          "pnpm: 🧪",
          undefined,
          pathToFileURL(path.join(root, "host.mjs")).href,
        ),
      ).resolves.toMatchObject({
        ok: true,
        value: {
          count: { identity: { measurement: "exact" }, inputUtf8Bytes: 10, tokens: 10 },
          requestedProviderId: OPTIONAL_UTF8_BYTE_PROVIDER_ID,
        },
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("degrades a missing package to the labeled estimate with explicit provenance", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "acl-missing-tokenizer-"));
    try {
      const baseUrl = pathToFileURL(path.join(root, "host.mjs")).href;
      expect(await loadExactTokenizerArtifact(OPTIONAL_UTF8_BYTE_PROVIDER_ID, baseUrl)).toEqual({
        status: "unavailable",
      });
      const result = await countTokensWithProviderAtBase(
        OPTIONAL_UTF8_BYTE_PROVIDER_ID,
        "é😀",
        {},
        baseUrl,
      );
      expect(result).toMatchObject({
        ok: true,
        value: {
          count: {
            identity: { id: "agent-context-estimate", measurement: "estimate" },
            inputUtf8Bytes: 6,
            tokens: 2,
          },
          fallback: {
            code: "provider-unavailable",
            requestedProviderId: OPTIONAL_UTF8_BYTE_PROVIDER_ID,
          },
          requestedProviderId: OPTIONAL_UTF8_BYTE_PROVIDER_ID,
          resolvedProvider: { providerId: BUILTIN_ESTIMATE_PROVIDER_ID },
        },
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("rejects unknown loader identities, non-files, links, and pre-cancelled reads", async () => {
    const fixture = await withPackage();
    try {
      await expect(loadExactTokenizerArtifact("optional:forged", fixture.baseUrl)).resolves.toEqual(
        {
          status: "unavailable",
        },
      );

      const artifact = path.join(
        fixture.root,
        "node_modules",
        "@agent-context",
        "tokenizer-utf8-byte",
        "provider.wasm.b64",
      );
      const cancelled = new AbortController();
      cancelled.abort();
      await expect(
        loadExactTokenizerArtifact(
          OPTIONAL_UTF8_BYTE_PROVIDER_ID,
          fixture.baseUrl,
          cancelled.signal,
        ),
      ).resolves.toEqual({ status: "invalid" });

      await rm(artifact);
      await mkdir(artifact);
      await expect(
        loadExactTokenizerArtifact(OPTIONAL_UTF8_BYTE_PROVIDER_ID, fixture.baseUrl),
      ).resolves.toEqual({ status: "unavailable" });

      await rm(artifact, { recursive: true });
      await symlink(new URL("provider.wasm.b64", OPTIONAL_PACKAGE), artifact);
      await expect(
        loadExactTokenizerArtifact(OPTIONAL_UTF8_BYTE_PROVIDER_ID, fixture.baseUrl),
      ).resolves.toEqual({ status: "invalid" });
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  test.each([
    ["manifest.v1.json", "{}\n"],
    ["manifest.v1.json", "x".repeat(4_097)],
    ["provider.wasm.b64", "not canonical base64\n"],
    ["provider.wasm.b64", VALID_WASM.toString("base64")],
    ["provider.wasm.b64", `${Buffer.from("wrong artifact").toString("base64")}\n`],
  ])("rejects corrupt optional package file %s and falls back", async (name, content) => {
    const fixture = await withPackage(async (directory) => {
      await writeFile(path.join(directory, name), content, "utf8");
    });
    try {
      await expect(
        loadExactTokenizerArtifact(OPTIONAL_UTF8_BYTE_PROVIDER_ID, fixture.baseUrl),
      ).resolves.toEqual({ status: "invalid" });
      const result = await countTokensWithProviderAtBase(
        OPTIONAL_UTF8_BYTE_PROVIDER_ID,
        "abcd",
        undefined,
        fixture.baseUrl,
      );
      expect(result).toMatchObject({
        ok: true,
        value: {
          count: { identity: { measurement: "estimate" }, tokens: 1 },
          fallback: { code: "provider-invalid" },
        },
      });
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  test("built-in selection is independent of package resolution and has no fallback", async () => {
    await expect(
      countTokensWithProviderAtBase(BUILTIN_ESTIMATE_PROVIDER_ID, "tests", {}, "invalid-base"),
    ).resolves.toEqual({
      ok: true,
      value: {
        count: {
          contractVersion: "1.0.0",
          identity: {
            id: "agent-context-estimate",
            measurement: "estimate",
            version: "1.0.0",
          },
          inputCodeUnits: 5,
          inputUtf8Bytes: 5,
          tokens: 2,
        },
        requestedProviderId: BUILTIN_ESTIMATE_PROVIDER_ID,
        resolvedProvider: expect.objectContaining({
          providerId: BUILTIN_ESTIMATE_PROVIDER_ID,
        }) as unknown,
      },
    });
  });

  test("rejects unsupported providers, non-strings, and oversized input without execution", async () => {
    await expect(countTokensWithProvider("optional:forged", "text")).resolves.toMatchObject({
      issues: [{ code: "unsupported-provider" }],
      ok: false,
    });
    await expect(
      countTokensWithProvider(BUILTIN_ESTIMATE_PROVIDER_ID, null),
    ).resolves.toMatchObject({ issues: [{ code: "invalid-input" }], ok: false });
    await expect(
      countTokensWithProvider(BUILTIN_ESTIMATE_PROVIDER_ID, "a".repeat(16_777_217)),
    ).resolves.toMatchObject({ issues: [{ code: "input-limit" }], ok: false });
  });

  test.each([
    null,
    [],
    { extra: true },
    { timeoutMs: 9 },
    { timeoutMs: EXACT_TOKENIZER_MAX_TIMEOUT_MS + 1 },
    { timeoutMs: 10.5 },
    { signal: Object.create(AbortSignal.prototype) as AbortSignal },
  ])("rejects malformed options %#", async (options) => {
    await expect(
      countTokensWithProvider(BUILTIN_ESTIMATE_PROVIDER_ID, "text", options as never),
    ).resolves.toMatchObject({
      issues: [{ code: "invalid-options" }],
      ok: false,
    });
  });

  test("rejects accessors and proxies without invoking traps", async () => {
    let traps = 0;
    const accessor = Object.defineProperty({}, "timeoutMs", {
      get(): number {
        traps += 1;
        return EXACT_TOKENIZER_MIN_TIMEOUT_MS;
      },
    });
    const proxy = new Proxy(
      {},
      {
        ownKeys(): never {
          traps += 1;
          throw new Error("must not inspect proxy");
        },
      },
    );
    for (const options of [accessor, proxy]) {
      await expect(
        countTokensWithProvider(BUILTIN_ESTIMATE_PROVIDER_ID, "text", options),
      ).resolves.toMatchObject({ ok: false, issues: [{ code: "invalid-options" }] });
    }
    expect(traps).toBe(0);
  });

  test("honors cancellation before selection and during isolated execution", async () => {
    const before = new AbortController();
    before.abort();
    await expect(
      countTokensWithProvider(BUILTIN_ESTIMATE_PROVIDER_ID, "text", { signal: before.signal }),
    ).resolves.toMatchObject({ ok: false, issues: [{ code: "cancelled" }] });

    const during = new AbortController();
    const pending = runExactTokenizerWorkerForTest(
      HANGING_WASM,
      Buffer.from("text"),
      EXACT_TOKENIZER_MAX_TIMEOUT_MS,
      during.signal,
    );
    during.abort();
    await expect(pending).resolves.toEqual({ status: "cancelled" });
  });

  test("terminates non-settling modules and rejects malformed modules/results", async () => {
    await expect(
      runExactTokenizerWorkerForTest(VALID_WASM, Buffer.from("text"), 1_000),
    ).resolves.toEqual({ status: "success", tokens: 4 });
    await expect(
      runExactTokenizerWorkerForTest(
        HANGING_WASM,
        Buffer.from("text"),
        EXACT_TOKENIZER_MIN_TIMEOUT_MS,
      ),
    ).resolves.toEqual({ status: "timeout" });
    await expect(
      runExactTokenizerWorkerForTest(Buffer.from("not wasm"), Buffer.from("text"), 1_000),
    ).resolves.toEqual({ status: "failed" });
    await expect(
      runExactTokenizerWorkerForTest(NEGATIVE_WASM, Buffer.from("text"), 1_000),
    ).resolves.toEqual({ status: "failed" });
  });

  test("keeps the public production resolver fail-safe when the optional package is absent", async () => {
    await expect(
      countTokensWithProvider(OPTIONAL_UTF8_BYTE_PROVIDER_ID, "abcd"),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        count: { identity: { measurement: "estimate" } },
        fallback: { code: "provider-unavailable" },
      },
    });
  });
});
