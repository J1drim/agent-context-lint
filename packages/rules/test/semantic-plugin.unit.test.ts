import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, test, vi } from "vitest";

import {
  REFERENCE_SEMANTIC_PLUGIN_ID,
  REFERENCE_SEMANTIC_PLUGIN_WASM_SHA256,
  SEMANTIC_PLUGIN_CONFIGURATION_RECORD_KIND,
  SEMANTIC_PLUGIN_CONTRACT_VERSION,
  SEMANTIC_PLUGIN_DISABLED_CONFIGURATION,
  SEMANTIC_PLUGIN_INPUT_RECORD_KIND,
  getReferenceSemanticPluginModuleBytes,
  runSemanticRulePlugin,
  scheduleRuleFamilies,
} from "../src/index.js";

import { fullRuleSchedulerInput } from "./helpers/rule-scheduler-full-families.js";

import type {
  SemanticPluginConfiguration,
  SemanticPluginDocument,
  SemanticPluginInput,
} from "../src/index.js";

const CONFIGURATION_SCHEMA = new URL(
  "../schemas/semantic-plugin-configuration.v0.schema.json",
  import.meta.url,
);
const INPUT_SCHEMA = new URL("../schemas/semantic-plugin-input.v0.schema.json", import.meta.url);
const RESULT_SCHEMA = new URL("../schemas/semantic-plugin-result.v0.schema.json", import.meta.url);
const GOLDEN = new URL("./fixtures/semantic-plugin-reference.golden.json", import.meta.url);
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

function document(overrides: Partial<SemanticPluginDocument> = {}): SemanticPluginDocument {
  return {
    documentId: "document:agents",
    path: "AGENTS.md",
    sourceDigest: DIGEST_A,
    text: "Introduction\nAlways run tests.\nNever run tests without the sandbox.",
    ...overrides,
  };
}

function input(documents: readonly SemanticPluginDocument[] = [document()]): SemanticPluginInput {
  return {
    contractVersion: SEMANTIC_PLUGIN_CONTRACT_VERSION,
    documents,
    recordKind: SEMANTIC_PLUGIN_INPUT_RECORD_KIND,
  };
}

function enabledConfiguration(): SemanticPluginConfiguration {
  return {
    contractVersion: SEMANTIC_PLUGIN_CONTRACT_VERSION,
    enabled: true,
    pluginId: REFERENCE_SEMANTIC_PLUGIN_ID,
    recordKind: SEMANTIC_PLUGIN_CONFIGURATION_RECORD_KIND,
  };
}

describe("F17 semantic plug-in boundary", () => {
  test("is disabled by default without inspecting repository content or touching fetch", async () => {
    let reads = 0;
    const hostileInput: Record<string, unknown> = {};
    Object.defineProperty(hostileInput, "documents", {
      enumerable: true,
      get: () => {
        reads += 1;
        throw new Error("must not read disabled input");
      },
    });
    const originalFetch = globalThis.fetch;
    const fetchSpy = vi.fn();
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: fetchSpy });
    try {
      await expect(runSemanticRulePlugin(hostileInput)).resolves.toEqual({
        contractVersion: "0.1.0",
        determinism: "non-deterministic",
        enabled: false,
        findings: [],
        networkAccess: "denied",
        ok: true,
        plugin: null,
        qualityClaim: false,
        recordKind: "agent-context-semantic-plugin-result",
      });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(reads).toBe(0);
    } finally {
      Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
    }
  });

  test("requires explicit closed configuration and matches the reviewed golden", async () => {
    const expected = JSON.parse(await readFile(GOLDEN, "utf8")) as unknown;
    await expect(runSemanticRulePlugin(input(), enabledConfiguration())).resolves.toEqual(expected);
    expect(Object.isFrozen(await runSemanticRulePlugin(input(), enabledConfiguration()))).toBe(
      true,
    );

    await expect(
      runSemanticRulePlugin(input(), { ...enabledConfiguration(), pluginId: "repository-module" }),
    ).resolves.toMatchObject({
      issues: [{ code: "invalid-configuration", path: "$configuration.pluginId" }],
      ok: false,
    });
    await expect(
      runSemanticRulePlugin(input(), {
        ...enabledConfiguration(),
        modulePath: "./rule.js",
      }),
    ).resolves.toMatchObject({ issues: [{ code: "invalid-configuration" }], ok: false });
  });

  test("keeps enabled output isolated, capability-free, visibly non-deterministic, and offline", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const result = await runSemanticRulePlugin(input(), enabledConfiguration());
      expect(result).toMatchObject({
        determinism: "non-deterministic",
        networkAccess: "denied",
        ok: true,
        plugin: {
          capabilities: [],
          module: { importedFunctions: 0, maximumMemoryBytes: 0 },
        },
        qualityClaim: false,
      });
      expect(result).not.toHaveProperty("bundle");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("executes the fixed import-free, memory-free WebAssembly module in a fresh instance", async () => {
    const firstBytes = getReferenceSemanticPluginModuleBytes();
    const secondBytes = getReferenceSemanticPluginModuleBytes();
    expect(firstBytes).not.toBe(secondBytes);
    expect(createHash("sha256").update(firstBytes).digest("hex")).toBe(
      REFERENCE_SEMANTIC_PLUGIN_WASM_SHA256,
    );
    const noCandidate = await runSemanticRulePlugin(
      input([document({ text: "Always run tests." })]),
      enabledConfiguration(),
    );
    const candidate = await runSemanticRulePlugin(input(), enabledConfiguration());
    expect(noCandidate).toMatchObject({ findings: [], ok: true });
    expect(candidate).toMatchObject({ findings: [{ code: "contradiction-candidate" }], ok: true });
  });

  test("fails closed when the WebAssembly runtime is unavailable", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "WebAssembly");
    Object.defineProperty(globalThis, "WebAssembly", { configurable: true, value: undefined });
    try {
      await expect(runSemanticRulePlugin(input(), enabledConfiguration())).resolves.toMatchObject({
        issues: [{ code: "plugin-failure", path: "$plugin.module" }],
        ok: false,
      });
    } finally {
      if (descriptor !== undefined) Object.defineProperty(globalThis, "WebAssembly", descriptor);
    }
  });

  test("fails closed when the WebAssembly runtime violates the fixed module contract", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "WebAssembly");
    function moduleConstructor(
      imports: readonly unknown[] = [],
      exports: readonly { readonly kind: string; readonly name: string }[] = [
        { kind: "function", name: "classify" },
      ],
      throws = false,
    ): unknown {
      function Module(bytes: Uint8Array): void {
        void bytes;
        if (throws) throw new Error("synthetic runtime failure");
      }
      return Object.assign(Module, {
        exports: (): readonly { readonly kind: string; readonly name: string }[] => exports,
        imports: (): readonly unknown[] => imports,
      });
    }
    class ValidInstance {
      readonly exports: Readonly<Record<string, (...arguments_: readonly number[]) => unknown>> = {
        classify: (alwaysPresent, neverPresent) => alwaysPresent & neverPresent,
      };
    }
    const baseRuntime = {
      Instance: ValidInstance,
      Module: moduleConstructor(),
      validate: (): boolean => true,
    };
    const cases: readonly unknown[] = [
      { ...baseRuntime, validate: (): boolean => false },
      {
        ...baseRuntime,
        Module: moduleConstructor([{}]),
      },
      {
        ...baseRuntime,
        Module: moduleConstructor([], [{ kind: "memory", name: "memory" }]),
      },
      {
        ...baseRuntime,
        Instance: class {
          readonly exports = {};
        },
      },
      {
        ...baseRuntime,
        Instance: class {
          readonly exports = { classify: (): number => 2 };
        },
      },
      {
        ...baseRuntime,
        Module: moduleConstructor([], [{ kind: "function", name: "classify" }], true),
      },
    ];
    try {
      for (const runtime of cases) {
        Object.defineProperty(globalThis, "WebAssembly", { configurable: true, value: runtime });
        await expect(runSemanticRulePlugin(input(), enabledConfiguration())).resolves.toMatchObject(
          {
            issues: [{ code: "plugin-failure" }],
            ok: false,
          },
        );
      }
    } finally {
      if (descriptor !== undefined) Object.defineProperty(globalThis, "WebAssembly", descriptor);
    }
  });

  test("rejects accessors, proxies, symbols, sparse arrays, traversal, and malformed digests", async () => {
    let calls = 0;
    const accessor = {
      contractVersion: SEMANTIC_PLUGIN_CONTRACT_VERSION,
      recordKind: SEMANTIC_PLUGIN_INPUT_RECORD_KIND,
    } as Record<string, unknown>;
    Object.defineProperty(accessor, "documents", {
      enumerable: true,
      get: () => {
        calls += 1;
        return [];
      },
    });
    const proxy = new Proxy(input(), {
      get: (): undefined => {
        calls += 1;
        return undefined;
      },
    });
    const symbolInput = { ...input(), [Symbol("hostile")]: true };
    const sparse = Array<SemanticPluginDocument>(1);

    for (const candidate of [accessor, proxy, symbolInput])
      await expect(runSemanticRulePlugin(candidate, enabledConfiguration())).resolves.toMatchObject(
        {
          issues: [{ code: "invalid-input" }],
          ok: false,
        },
      );
    await expect(
      runSemanticRulePlugin(input(sparse), enabledConfiguration()),
    ).resolves.toMatchObject({
      issues: [{ code: "invalid-input" }],
      ok: false,
    });
    await expect(
      runSemanticRulePlugin(input([document({ path: "../secret" })]), enabledConfiguration()),
    ).resolves.toMatchObject({ issues: [{ code: "invalid-input" }], ok: false });
    for (const path of [
      "escape\u001b.md",
      "line\nbreak.md",
      "bad\ud800.md",
      "a//b",
      "a/./b",
      "C:drive",
      ".",
    ])
      await expect(
        runSemanticRulePlugin(input([document({ path })]), enabledConfiguration()),
      ).resolves.toMatchObject({
        issues: [{ code: "invalid-input", path: "$input.documents[0].path" }],
        ok: false,
      });
    await expect(
      runSemanticRulePlugin(input([document({ sourceDigest: "bad" })]), enabledConfiguration()),
    ).resolves.toMatchObject({ issues: [{ code: "invalid-input" }], ok: false });
    await expect(
      runSemanticRulePlugin(
        input([document(), document({ path: "other.md", sourceDigest: DIGEST_B })]),
        enabledConfiguration(),
      ),
    ).resolves.toMatchObject({
      issues: [{ code: "invalid-input", path: "$input.documents[1].documentId" }],
      ok: false,
    });
    await expect(
      runSemanticRulePlugin(
        input([document(), document({ documentId: "document:other", sourceDigest: DIGEST_B })]),
        enabledConfiguration(),
      ),
    ).resolves.toMatchObject({
      issues: [{ code: "invalid-input", path: "$input.documents[1].path" }],
      ok: false,
    });
    expect(calls).toBe(0);
  });

  test("enforces document, byte, work, finding, and option hard limits", async () => {
    await expect(
      runSemanticRulePlugin(input([document(), document()]), enabledConfiguration(), {
        maximumDocuments: 1,
      }),
    ).resolves.toMatchObject({ issues: [{ code: "resource-limit" }], ok: false });
    await expect(
      runSemanticRulePlugin(input([document({ text: "Always. Never." })]), enabledConfiguration(), {
        maximumInputBytes: 1,
      }),
    ).resolves.toMatchObject({ issues: [{ code: "resource-limit" }], ok: false });
    await expect(
      runSemanticRulePlugin(input([document({ text: "Always. Never." })]), enabledConfiguration(), {
        maximumWorkUnits: 1,
      }),
    ).resolves.toMatchObject({ issues: [{ code: "resource-limit" }], ok: false });
    await expect(
      runSemanticRulePlugin(
        input([
          document(),
          document({ documentId: "document:second", path: "second.md", sourceDigest: DIGEST_B }),
        ]),
        enabledConfiguration(),
        { maximumFindings: 1 },
      ),
    ).resolves.toMatchObject({ issues: [{ code: "resource-limit" }], ok: false });
    await expect(
      runSemanticRulePlugin(input(), enabledConfiguration(), { maximumDocuments: 2_049 }),
    ).resolves.toMatchObject({ issues: [{ code: "invalid-options" }], ok: false });
  });

  test("rejects oversized text before linear string and UTF-8 work", async () => {
    const oversized = "x".repeat(100_000);
    const includesSpy = vi.spyOn(String.prototype, "includes");
    const byteLengthSpy = vi.spyOn(Buffer, "byteLength");
    try {
      await expect(
        runSemanticRulePlugin(input([document({ text: oversized })]), enabledConfiguration(), {
          maximumInputBytes: 10,
        }),
      ).resolves.toMatchObject({ issues: [{ code: "resource-limit" }], ok: false });
      expect(includesSpy.mock.contexts.some((context) => String(context) === oversized)).toBe(
        false,
      );
      expect(byteLengthSpy.mock.calls.some(([value]) => value === oversized)).toBe(false);

      includesSpy.mockClear();
      byteLengthSpy.mockClear();
      await expect(
        runSemanticRulePlugin(input([document({ text: oversized })]), enabledConfiguration(), {
          maximumInputBytes: 200_000,
          maximumWorkUnits: 1,
        }),
      ).resolves.toMatchObject({ issues: [{ code: "resource-limit" }], ok: false });
      expect(includesSpy.mock.contexts.some((context) => String(context) === oversized)).toBe(
        false,
      );
      expect(byteLengthSpy.mock.calls.some(([value]) => value === oversized)).toBe(false);
    } finally {
      includesSpy.mockRestore();
      byteLengthSpy.mockRestore();
    }
  });

  test("reports source lines consistently for LF, CRLF, and CR documents", async () => {
    for (const newline of ["\n", "\r\n", "\r"]) {
      const result = await runSemanticRulePlugin(
        input([
          document({ text: ["heading", "always run tests", "never skip tests"].join(newline) }),
        ]),
        enabledConfiguration(),
      );
      expect(result).toMatchObject({ findings: [{ line: 2 }], ok: true });
    }
  });

  test("rejects malformed option, configuration, input, and document states", async () => {
    const optionAccessor: Record<string, unknown> = {};
    Object.defineProperty(optionAccessor, "maximumDocuments", {
      enumerable: true,
      get: (): number => 1,
    });
    for (const options of [null, optionAccessor, { signal: { aborted: false } }])
      await expect(
        runSemanticRulePlugin(input(), enabledConfiguration(), options as never),
      ).resolves.toMatchObject({ issues: [{ code: "invalid-options" }], ok: false });

    for (const configuration of [
      { ...enabledConfiguration(), contractVersion: "9.9.9" },
      { ...enabledConfiguration(), enabled: false },
    ])
      await expect(runSemanticRulePlugin(input(), configuration)).resolves.toMatchObject({
        issues: [{ code: "invalid-configuration" }],
        ok: false,
      });

    const proxiedDocuments = new Proxy([document()], {});
    for (const candidate of [
      { ...input(), recordKind: "wrong-record" },
      { ...input(), documents: proxiedDocuments },
      input([document({ documentId: "" })]),
      input([document({ text: "contains\0nul" })]),
      input([document({ text: 42 as unknown as string })]),
    ])
      await expect(runSemanticRulePlugin(candidate, enabledConfiguration())).resolves.toMatchObject(
        {
          issues: [{ code: "invalid-input" }],
          ok: false,
        },
      );
  });

  test("honors native cancellation before admission and between detached documents", async () => {
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await expect(
      runSemanticRulePlugin(input(), enabledConfiguration(), { signal: alreadyAborted.signal }),
    ).resolves.toMatchObject({ issues: [{ code: "cancelled" }], ok: false });

    const controller = new AbortController();
    const operation = runSemanticRulePlugin(
      input([
        document({ text: "No candidate." }),
        document({ documentId: "document:second", path: "second.md", sourceDigest: DIGEST_B }),
      ]),
      enabledConfiguration(),
      { signal: controller.signal },
    );
    controller.abort();
    await expect(operation).resolves.toMatchObject({ issues: [{ code: "cancelled" }], ok: false });

    const finalController = new AbortController();
    const finalOperation = runSemanticRulePlugin(
      input([document({ text: "No candidate." })]),
      enabledConfiguration(),
      { signal: finalController.signal },
    );
    finalController.abort();
    await expect(finalOperation).resolves.toMatchObject({
      issues: [{ code: "cancelled" }],
      ok: false,
    });
  });

  test("is order-stable and detaches input before asynchronous execution", async () => {
    const first = document({ documentId: "document:z", path: "z.md" });
    const second = document({ documentId: "document:a", path: "a.md", sourceDigest: DIGEST_B });
    const mutable = [first, second];
    const pending = runSemanticRulePlugin(input(mutable), enabledConfiguration());
    mutable[1] = document({ text: "mutated" });
    const forward = await pending;
    const reverse = await runSemanticRulePlugin(input([second, first]), enabledConfiguration());
    expect(JSON.stringify(forward)).toBe(JSON.stringify(reverse));

    const equalLineUnicodeA = document({
      documentId: "document:unicode-a",
      path: "ą.md",
      sourceDigest: DIGEST_A,
    });
    const equalLineUnicodeB = document({
      documentId: "document:unicode-b",
      path: "z.md",
      sourceDigest: DIGEST_B,
    });
    const unicodeForward = await runSemanticRulePlugin(
      input([equalLineUnicodeA, equalLineUnicodeB]),
      enabledConfiguration(),
    );
    const unicodeReverse = await runSemanticRulePlugin(
      input([equalLineUnicodeB, equalLineUnicodeA]),
      enabledConfiguration(),
    );
    expect(JSON.stringify(unicodeForward)).toBe(JSON.stringify(unicodeReverse));
  });

  test("publishes a strict schema and package export for success and failure results", async () => {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    const validateConfiguration = ajv.compile(
      JSON.parse(await readFile(CONFIGURATION_SCHEMA, "utf8")) as object,
    );
    const validateInput = ajv.compile(JSON.parse(await readFile(INPUT_SCHEMA, "utf8")) as object);
    const validateResult = ajv.compile(JSON.parse(await readFile(RESULT_SCHEMA, "utf8")) as object);
    expect(validateConfiguration(enabledConfiguration())).toBe(true);
    expect(validateConfiguration({ ...enabledConfiguration(), modulePath: "rule.wasm" })).toBe(
      false,
    );
    expect(validateInput(input())).toBe(true);
    expect(validateInput(input([document({ path: "../escape" })]))).toBe(false);
    for (const path of ["escape\u001b.md", "line\nbreak.md", "bad\ud800.md", "a//b", "a/./b"])
      expect(validateInput(input([document({ path })]))).toBe(false);
    expect(validateResult(await runSemanticRulePlugin(input(), enabledConfiguration()))).toBe(true);
    const valid = await runSemanticRulePlugin(input(), enabledConfiguration());
    expect(validateResult({ ...valid, unexpected: true })).toBe(false);
    if (!valid.ok) throw new Error("expected semantic plug-in success");
    expect(
      validateResult({
        ...valid,
        findings: valid.findings.map((finding) => ({ ...finding, path: "escape\u001b.md" })),
      }),
    ).toBe(false);
    expect(
      validateResult(
        await runSemanticRulePlugin(input(), { ...enabledConfiguration(), pluginId: "bad" }),
      ),
    ).toBe(true);

    const manifest = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { exports?: Record<string, string> };
    expect(manifest.exports?.["./schemas/semantic-plugin-result.v0.schema.json"]).toBe(
      "./schemas/semantic-plugin-result.v0.schema.json",
    );
    expect(manifest.exports?.["./schemas/semantic-plugin-configuration.v0.schema.json"]).toBe(
      "./schemas/semantic-plugin-configuration.v0.schema.json",
    );
    expect(manifest.exports?.["./schemas/semantic-plugin-input.v0.schema.json"]).toBe(
      "./schemas/semantic-plugin-input.v0.schema.json",
    );
  });

  test("retains the frozen disabled configuration as the sole implicit selection", () => {
    expect(SEMANTIC_PLUGIN_DISABLED_CONFIGURATION).toEqual({
      contractVersion: "0.1.0",
      enabled: false,
      pluginId: null,
      recordKind: "agent-context-semantic-plugin-configuration",
    });
    expect(Object.isFrozen(SEMANTIC_PLUGIN_DISABLED_CONFIGURATION)).toBe(true);
  });

  test("leaves complete F15 result bytes unchanged and adds no default network activity", async () => {
    const schedulerInput = await fullRuleSchedulerInput();
    const before = await scheduleRuleFamilies(schedulerInput, { scheduleSeed: 17 });
    expect(before.ok).toBe(true);
    const beforeBytes = JSON.stringify(before);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      await runSemanticRulePlugin(new Proxy({}, { get: (): undefined => undefined }));
      const after = await scheduleRuleFamilies(schedulerInput, { scheduleSeed: 17 });
      expect(JSON.stringify(after)).toBe(beforeBytes);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
