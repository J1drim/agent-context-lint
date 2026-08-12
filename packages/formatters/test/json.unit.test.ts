import { readFileSync } from "node:fs";

import type { AnySchema } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, test, vi } from "vitest";

import {
  canonicalizeRepositoryRelativePath,
  computePathFingerprint,
  computeSemanticFingerprint,
  validateInstructionIr,
  validateScanJsonOutput,
} from "@agent-context/core";

import {
  JSON_FORMATTER_DEFAULT_CHUNK_BYTES,
  JSON_FORMATTER_MAX_CHUNK_BYTES,
  JSON_FORMATTER_MIN_CHUNK_BYTES,
  formatJsonDiagnostics,
  writeJsonDiagnostics,
} from "../src/index.js";

import type { SourceDocument } from "@agent-context/core";
import type { JsonFormatterOptions, JsonFormatterResult } from "../src/index.js";

const DIAGNOSTICS = new URL("../../core/test/fixtures/diagnostics.valid.json", import.meta.url);
const IR = new URL("../../core/test/fixtures/instruction-ir.valid.json", import.meta.url);
const OUTPUT_SCHEMA = new URL("../../core/schemas/output-contract.v1.schema.json", import.meta.url);
const DIAGNOSTIC_SCHEMA = new URL(
  "../../core/schemas/diagnostic-contract.v0.schema.json",
  import.meta.url,
);
const ESCAPE = String.fromCharCode(0x1b);
const BIDI_OVERRIDE = String.fromCodePoint(0x202e);

class NonPlainOptions {
  readonly profileVersions = { "codex-cli": { clientVersion: null, profileVersion: "1.0.0" } };
}

function json(url: URL): unknown {
  return JSON.parse(readFileSync(url, "utf8")) as unknown;
}

function sources(): readonly SourceDocument[] {
  const result = validateInstructionIr(json(IR));
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.value.sources;
}

function bundle(): Record<string, unknown> {
  const result = structuredClone(json(DIAGNOSTICS)) as Record<string, unknown>;
  const suggestion = firstRecord(result, "diagnostics")["suggestion"];
  if (suggestion === null || typeof suggestion !== "object") {
    throw new TypeError("expected a diagnostic suggestion");
  }
  (suggestion as Record<string, unknown>)["fixPlan"] = null;
  return result;
}

function options(overrides: Partial<JsonFormatterOptions> = {}): JsonFormatterOptions {
  return {
    profileVersions: {
      "codex-cli": { clientVersion: "0.74.1", profileVersion: "2026.8.2" },
    },
    ...overrides,
  };
}

function firstRecord(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = record[key];
  if (!Array.isArray(value) || value[0] === null || typeof value[0] !== "object") {
    throw new TypeError(`expected ${key} to contain an object`);
  }
  return value[0] as Record<string, unknown>;
}

function diagnosticVariant(
  template: Record<string, unknown>,
  suffix: string,
  message: string,
): Record<string, unknown> {
  const diagnostic = structuredClone(template);
  const profileIds = ["codex-cli"];
  const pathBasis = { anchor: `statement:${suffix}`, profileIds };
  const semanticBasis = { components: [{ key: "case", value: suffix }], profileIds };
  diagnostic["id"] = `diagnostic:${suffix}`;
  diagnostic["message"] = message;
  diagnostic["related"] = [];
  diagnostic["suggestion"] = null;
  diagnostic["fingerprintBasis"] = { path: pathBasis, semantic: semanticBasis };
  diagnostic["fingerprints"] = {
    path: {
      method: "agent-context-lint/path/v1",
      value: computePathFingerprint({
        ruleId: "ACL250",
        ruleVersion: "1.0.0",
        path: canonicalizeRepositoryRelativePath("AGENTS.md"),
        basis: pathBasis,
      }),
    },
    semantic: {
      method: "agent-context-lint/semantic/v1",
      value: computeSemanticFingerprint({
        ruleId: "ACL250",
        ruleVersion: "1.0.0",
        basis: semanticBasis,
      }),
    },
  };
  return diagnostic;
}

function successful(
  optionsValue: JsonFormatterOptions = options(),
): Extract<JsonFormatterResult, { readonly ok: true }> {
  const result = formatJsonDiagnostics(bundle(), sources(), optionsValue);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result;
}

describe("I05 stable JSON formatter", () => {
  test("emits deterministic golden bytes accepted by the B05 runtime and published schema", () => {
    const result = successful();
    const repeated = successful();
    expect(result.text).toMatchSnapshot();
    expect(repeated.text).toBe(result.text);
    expect(result.byteLength).toBe(Buffer.byteLength(result.text, "utf8"));
    expect(result.chunks.join("")).toBe(result.text);
    expect(result.text.endsWith("\n")).toBe(true);
    expect(result.text.slice(0, -1)).not.toContain("\n");
    expect(result.text.startsWith('{"diagnostics":')).toBe(true);
    expect(result.output).toMatchObject({
      recordKind: "agent-context-scan-output",
      schemaVersion: "1.0.0",
      failureThreshold: "error",
      profileVersions: {
        "codex-cli": { clientVersion: "0.74.1", profileVersion: "2026.8.2" },
      },
      summary: { errors: 1, exitCode: 1, infos: 0, suppressed: 0, warnings: 0 },
    });
    expect(validateScanJsonOutput(result.output, sources()).ok).toBe(true);

    const ajv = new Ajv2020({ allErrors: true, strict: true });
    ajv.addSchema(json(DIAGNOSTIC_SCHEMA) as AnySchema);
    const validateSchema = ajv.compile(json(OUTPUT_SCHEMA) as AnySchema);
    expect(validateSchema(result.output), JSON.stringify(validateSchema.errors)).toBe(true);
  });

  test("preserves validated diagnostic order while F15 remains the sorting owner", () => {
    const candidate = bundle();
    const template = firstRecord(candidate, "diagnostics");
    const alpha = diagnosticVariant(template, "alpha", "alpha-order-marker");
    const omega = diagnosticVariant(template, "omega", "omega-order-marker");
    candidate["suppressions"] = [];
    candidate["diagnostics"] = [omega, alpha];
    const before = JSON.stringify(candidate);
    const omegaFirst = formatJsonDiagnostics(candidate, sources(), options());
    expect(omegaFirst.ok).toBe(true);
    if (!omegaFirst.ok) throw new Error(JSON.stringify(omegaFirst.issues));
    expect(omegaFirst.text.indexOf("omega-order-marker")).toBeLessThan(
      omegaFirst.text.indexOf("alpha-order-marker"),
    );
    expect(JSON.stringify(candidate)).toBe(before);

    candidate["diagnostics"] = [alpha, omega];
    const alphaFirst = formatJsonDiagnostics(candidate, sources(), options());
    expect(alphaFirst.ok).toBe(true);
    if (!alphaFirst.ok) throw new Error(JSON.stringify(alphaFirst.issues));
    expect(alphaFirst.text.indexOf("alpha-order-marker")).toBeLessThan(
      alphaFirst.text.indexOf("omega-order-marker"),
    );
    expect(alphaFirst.text).not.toBe(omegaFirst.text);
  });

  test("derives active, suppressed, and threshold summaries from B04 relationships", () => {
    const candidate = bundle();
    const diagnostic = firstRecord(candidate, "diagnostics");
    const suppression = firstRecord(candidate, "suppressions");
    const fingerprints = diagnostic["fingerprints"] as Record<string, unknown>;
    const pathFingerprint = fingerprints["path"] as Record<string, unknown>;
    suppression["state"] = "suppressed";
    suppression["matchedPathFingerprints"] = [pathFingerprint["value"]];
    const suppressed = formatJsonDiagnostics(
      candidate,
      sources(),
      options({ failureThreshold: "warning" }),
    );
    expect(suppressed.ok).toBe(true);
    if (!suppressed.ok) throw new Error(JSON.stringify(suppressed.issues));
    expect(suppressed.output.summary).toEqual({
      errors: 0,
      exitCode: 0,
      infos: 0,
      suppressed: 1,
      warnings: 0,
    });

    diagnostic["severity"] = "warning";
    suppression["state"] = "unused";
    suppression["matchedPathFingerprints"] = [];
    const warning = formatJsonDiagnostics(
      candidate,
      sources(),
      options({ failureThreshold: "warning" }),
    );
    const never = formatJsonDiagnostics(
      candidate,
      sources(),
      options({ failureThreshold: "never" }),
    );
    expect(warning.ok && warning.output.summary.exitCode).toBe(1);
    expect(never.ok && never.output.summary.exitCode).toBe(0);

    diagnostic["severity"] = "info";
    const informational = formatJsonDiagnostics(candidate, sources(), options());
    expect(informational.ok && informational.output.summary).toEqual({
      errors: 0,
      exitCode: 0,
      infos: 1,
      suppressed: 0,
      warnings: 0,
    });
  });

  test("retains rule, profile, and spec provenance while making repository text inert", () => {
    const candidate = bundle();
    const diagnostic = firstRecord(candidate, "diagnostics");
    diagnostic["message"] =
      'quoted "value" \\ path password=top-secret-value\nforged ' +
      `${ESCAPE}[31mred${ESCAPE}[0m ${BIDI_OVERRIDE} SECRET_CANARY_I05`;
    const result = formatJsonDiagnostics(candidate, sources(), options());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.text).not.toContain("top-secret-value");
    expect(result.text).not.toContain("SECRET_CANARY_I05");
    expect(result.text).not.toContain(ESCAPE);
    expect(result.text).not.toContain(BIDI_OVERRIDE);
    expect(result.text).toContain("password=REDACTED");
    expect(result.text).toContain('quoted \\"value\\" \\\\ path');
    const emittedDiagnostic = result.output.diagnostics.diagnostics[0];
    expect(emittedDiagnostic).toMatchObject({
      ruleId: "ACL250",
      ruleVersion: "1.0.0",
      fingerprintBasis: { path: { profileIds: ["codex-cli"] } },
    });
    expect(
      emittedDiagnostic?.related.some(
        (related) =>
          related.kind === "spec" && related.specSnapshotId === "codex-cli/0.146.0/2026-08-01",
      ),
    ).toBe(true);
  });

  test("uses explicit null client versions and rejects omitted profile identity fields", () => {
    const nullable = successful(
      options({
        profileVersions: { "codex-cli": { clientVersion: null, profileVersion: "1.0.0" } },
      }),
    );
    expect(nullable.output.profileVersions["codex-cli"]?.clientVersion).toBeNull();
    const omitted = formatJsonDiagnostics(bundle(), sources(), {
      profileVersions: { "codex-cli": { profileVersion: "1.0.0" } },
    } as unknown as JsonFormatterOptions);
    expect(omitted).toMatchObject({
      ok: false,
      issues: [{ code: "invalid-options", path: "$options.profileVersions" }],
    });
  });

  test.each([
    [
      "small chunk",
      options({ chunkBytes: JSON_FORMATTER_MIN_CHUNK_BYTES - 1 }),
      "$options.chunkBytes",
    ],
    [
      "large chunk",
      options({ chunkBytes: JSON_FORMATTER_MAX_CHUNK_BYTES + 1 }),
      "$options.chunkBytes",
    ],
    ["fractional chunk", options({ chunkBytes: 256.5 }), "$options.chunkBytes"],
    ["undefined chunk", { ...options(), chunkBytes: undefined }, "$options.chunkBytes"],
    [
      "unknown threshold",
      options({ failureThreshold: "info" as never }),
      "$options.failureThreshold",
    ],
    [
      "undefined threshold",
      { ...options(), failureThreshold: undefined },
      "$options.failureThreshold",
    ],
    ["empty profiles", options({ profileVersions: {} }), "$options.profileVersions"],
    [
      "bad profile version",
      options({ profileVersions: { "codex-cli": { clientVersion: null, profileVersion: "v1" } } }),
      "$options.profileVersions",
    ],
    ["array", [], "$options"],
    ["class instance", new NonPlainOptions(), "$options"],
  ])("rejects %s options without coercion", (_name, value, path) => {
    const result = formatJsonDiagnostics(bundle(), sources(), value as JsonFormatterOptions);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid options");
    expect(result.issues[0]?.path).toBe(path);
  });

  test("rejects unknown fields, symbols, accessors, proxies, and oversized option records inertly", () => {
    let calls = 0;
    const accessor = Object.defineProperty({}, "profileVersions", {
      enumerable: true,
      get() {
        calls += 1;
        return options().profileVersions;
      },
    });
    const nestedAccessor = {
      profileVersions: {
        "codex-cli": Object.defineProperty({ clientVersion: null }, "profileVersion", {
          enumerable: true,
          get() {
            calls += 1;
            return "1.0.0";
          },
        }),
      },
    };
    const oversized: Record<string, unknown> = { profileVersions: options().profileVersions };
    Object.defineProperty(oversized, "chunkBytes", {
      enumerable: true,
      get() {
        calls += 1;
        return JSON_FORMATTER_DEFAULT_CHUNK_BYTES;
      },
    });
    for (let index = 0; index < 10_000; index += 1) oversized[`extra-${String(index)}`] = index;
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();
    for (const value of [
      accessor,
      nestedAccessor,
      oversized,
      { ...options(), unknown: true },
      { ...options(), [Symbol("option")]: true },
      revocable.proxy,
    ]) {
      expect(formatJsonDiagnostics(bundle(), sources(), value as JsonFormatterOptions).ok).toBe(
        false,
      );
    }
    expect(calls).toBe(0);
  });

  test("bounds and closes profile maps before constructing B05 output", () => {
    let calls = 0;
    const profileAccessor = Object.defineProperty({}, "codex-cli", {
      enumerable: true,
      get() {
        calls += 1;
        return { clientVersion: null, profileVersion: "1.0.0" };
      },
    });
    const profileSymbol = {
      "codex-cli": { clientVersion: null, profileVersion: "1.0.0" },
      [Symbol("profile")]: { clientVersion: null, profileVersion: "1.0.0" },
    };
    const identitySymbol = {
      "codex-cli": {
        clientVersion: null,
        profileVersion: "1.0.0",
        [Symbol("identity")]: true,
      },
    };
    const hugeProfiles: Record<string, unknown> = {};
    for (let index = 0; index <= 10_000; index += 1) {
      hugeProfiles[`profile-${String(index)}`] = {
        clientVersion: null,
        profileVersion: "1.0.0",
      };
    }
    const cases: readonly unknown[] = [
      {},
      { profileVersions: null },
      { profileVersions: profileAccessor },
      { profileVersions: profileSymbol },
      { profileVersions: identitySymbol },
      { profileVersions: { "not valid": { clientVersion: null, profileVersion: "1.0.0" } } },
      { profileVersions: { "codex-cli": null } },
      { profileVersions: { "codex-cli": { clientVersion: null } } },
      {
        profileVersions: {
          "codex-cli": { clientVersion: "\ud800", profileVersion: "1.0.0" },
        },
      },
      {
        profileVersions: {
          "codex-cli": { clientVersion: "\udc00", profileVersion: "1.0.0" },
        },
      },
      {
        profileVersions: {
          "codex-cli": { clientVersion: "😀", profileVersion: "1.0.0" },
          "z-profile": { clientVersion: null, profileVersion: "1.0.0" },
        },
      },
      { profileVersions: hugeProfiles },
    ];
    for (const candidate of cases) {
      const result = formatJsonDiagnostics(bundle(), sources(), candidate as JsonFormatterOptions);
      expect(result.ok).toBe(false);
    }
    expect(calls).toBe(0);
  });

  test("rejects a valid bundle when declared profiles do not match its fingerprints", () => {
    const result = formatJsonDiagnostics(bundle(), sources(), {
      profileVersions: {
        "copilot-cli": { clientVersion: null, profileVersion: "1.0.0" },
      },
    });
    expect(result).toMatchObject({
      ok: false,
      issues: [{ code: "invalid-options", path: "$options.profileVersions" }],
    });
  });

  test("rejects malformed, sparse, duplicate, oversized, and revoked diagnostic data with fixed errors", () => {
    const malformed = bundle();
    firstRecord(malformed, "diagnostics")["message"] = "SECRET_CANARY_I05\ud800";
    const sparse = bundle();
    sparse["diagnostics"] = Array(2);
    const duplicate = bundle();
    const template = firstRecord(duplicate, "diagnostics");
    duplicate["diagnostics"] = [template, structuredClone(template)];
    const oversized = bundle();
    firstRecord(oversized, "diagnostics")["message"] = "x".repeat(16_385);
    for (const candidate of [malformed, sparse, duplicate, oversized]) {
      const result = formatJsonDiagnostics(candidate, sources(), options());
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected invalid diagnostics");
      expect(result.issues).toHaveLength(1);
      expect(JSON.stringify(result.issues)).not.toContain("SECRET_CANARY_I05");
      expect(["invalid-diagnostics", "resource-limit"]).toContain(result.issues[0]?.code);
    }
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();
    expect(() => formatJsonDiagnostics(revocable.proxy, sources(), options())).not.toThrow();
    expect(formatJsonDiagnostics(revocable.proxy, sources(), options()).ok).toBe(false);

    const aggregateLimit = bundle();
    firstRecord(aggregateLimit, "diagnostics")["message"] = "x".repeat(1_048_577);
    expect(formatJsonDiagnostics(aggregateLimit, sources(), options())).toMatchObject({
      ok: false,
      issues: [{ code: "resource-limit" }],
    });
  });

  test("builds scalar-safe chunks at exact UTF-8 boundaries", () => {
    const candidate = bundle();
    firstRecord(candidate, "diagnostics")["message"] = `prefix-${"ą👩‍💻漢".repeat(100)}-suffix`;
    const result = formatJsonDiagnostics(
      candidate,
      sources(),
      options({ chunkBytes: JSON_FORMATTER_MIN_CHUNK_BYTES }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.chunks.length).toBeGreaterThan(1);
    expect(result.chunks.join("")).toBe(result.text);
    for (const chunk of result.chunks) {
      expect(Buffer.byteLength(chunk, "utf8")).toBeLessThanOrEqual(JSON_FORMATTER_MIN_CHUNK_BYTES);
      const firstUnit = chunk.charCodeAt(0);
      const lastUnit = chunk.charCodeAt(chunk.length - 1);
      expect(firstUnit < 0xdc00 || firstUnit > 0xdfff).toBe(true);
      expect(lastUnit < 0xd800 || lastUnit > 0xdbff).toBe(true);
      expect(chunk.length).toBeGreaterThan(0);
    }
  });

  test("streams exact buffered bytes sequentially under sink backpressure", async () => {
    const candidate = bundle();
    firstRecord(candidate, "diagnostics")["message"] = "stream-content-".repeat(200);
    const selectedOptions = options({ chunkBytes: JSON_FORMATTER_MIN_CHUNK_BYTES });
    const buffered = formatJsonDiagnostics(candidate, sources(), selectedOptions);
    expect(buffered.ok).toBe(true);
    if (!buffered.ok) throw new Error(JSON.stringify(buffered.issues));
    const chunks: string[] = [];
    let active = 0;
    let maximumActive = 0;
    const streamed = await writeJsonDiagnostics(candidate, sources(), selectedOptions, {
      async write(chunk) {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await Promise.resolve();
        chunks.push(chunk);
        active -= 1;
      },
    });
    expect(streamed).toMatchObject({
      ok: true,
      byteLength: buffered.byteLength,
      chunksWritten: buffered.chunks.length,
    });
    expect(maximumActive).toBe(1);
    expect(chunks.join("")).toBe(buffered.text);
  });

  test("never calls the sink when complete preflight fails", async () => {
    let calls = 0;
    const malformed = bundle();
    firstRecord(malformed, "diagnostics")["message"] = "\ud800";
    const result = await writeJsonDiagnostics(malformed, sources(), options(), {
      write() {
        calls += 1;
      },
    });
    expect(result).toMatchObject({
      ok: false,
      byteLength: 0,
      chunksWritten: 0,
      issues: [{ code: "invalid-diagnostics" }],
    });
    expect(calls).toBe(0);
  });

  test("fails closed when sanitizer changes identity-linked fix content", async () => {
    let calls = 0;
    const originalFixture = structuredClone(json(DIAGNOSTICS));
    const result = await writeJsonDiagnostics(originalFixture, sources(), options(), {
      write() {
        calls += 1;
      },
    });
    expect(result).toMatchObject({
      ok: false,
      byteLength: 0,
      chunksWritten: 0,
      issues: [{ code: "serialization-failed", path: "$" }],
    });
    expect(calls).toBe(0);
  });

  test("maps an unexpected serialization runtime failure to a fixed non-reflective issue", () => {
    const candidate = bundle();
    const registry = sources();
    const parse = vi.spyOn(JSON, "parse").mockImplementationOnce(() => {
      throw new Error("SECRET_CANARY_JSON_RUNTIME");
    });
    try {
      const result = formatJsonDiagnostics(candidate, registry, options());
      expect(result).toMatchObject({ ok: false, issues: [{ code: "invalid-diagnostics" }] });
      expect(JSON.stringify(result)).not.toContain("SECRET_CANARY_JSON_RUNTIME");
    } finally {
      parse.mockRestore();
    }
  });

  test("reports throwing and rejecting sinks without reflecting their errors", async () => {
    const secret = "SECRET_CANARY_SINK";
    const throwing = await writeJsonDiagnostics(bundle(), sources(), options(), {
      write() {
        throw new Error(secret);
      },
    });
    const rejecting = await writeJsonDiagnostics(bundle(), sources(), options(), {
      write() {
        return Promise.reject(new Error(secret));
      },
    });
    for (const result of [throwing, rejecting]) {
      expect(result).toMatchObject({
        ok: false,
        byteLength: 0,
        chunksWritten: 0,
        issues: [{ code: "sink-failed", path: "$sink" }],
      });
      expect(JSON.stringify(result)).not.toContain(secret);
    }
  });

  test("reports the exact acknowledged prefix when a later sink chunk fails", async () => {
    const candidate = bundle();
    firstRecord(candidate, "diagnostics")["message"] = "prefix-accounting-".repeat(200);
    const selectedOptions = options({ chunkBytes: JSON_FORMATTER_MIN_CHUNK_BYTES });
    const buffered = formatJsonDiagnostics(candidate, sources(), selectedOptions);
    expect(buffered.ok).toBe(true);
    if (!buffered.ok) throw new Error(JSON.stringify(buffered.issues));
    let calls = 0;
    const result = await writeJsonDiagnostics(candidate, sources(), selectedOptions, {
      write(): void {
        calls += 1;
        if (calls === 2) throw new Error("second chunk failed");
      },
    });
    expect(result).toMatchObject({
      ok: false,
      byteLength: Buffer.byteLength(buffered.chunks[0] ?? "", "utf8"),
      chunksWritten: 1,
      issues: [{ code: "sink-failed" }],
    });
  });

  test("supports successful and failed writes through a live AbortSignal", async () => {
    const controller = new AbortController();
    const chunks: string[] = [];
    const success = await writeJsonDiagnostics(
      bundle(),
      sources(),
      options({ chunkBytes: JSON_FORMATTER_MIN_CHUNK_BYTES }),
      {
        write(chunk): Promise<void> {
          chunks.push(chunk);
          return Promise.resolve();
        },
      },
      controller.signal,
    );
    expect(success.ok).toBe(true);
    expect(chunks.join("")).toBe(successful(options({ chunkBytes: 256 })).text);

    for (const write of [
      (): Promise<void> => Promise.reject(new Error("rejected")),
      (): void => {
        throw new Error("thrown");
      },
      (): PromiseLike<void> =>
        Object.defineProperty({}, "then", {
          get() {
            throw new Error("hostile thenable");
          },
        }) as PromiseLike<void>,
    ]) {
      const failed = await writeJsonDiagnostics(
        bundle(),
        sources(),
        options(),
        { write },
        controller.signal,
      );
      expect(failed).toMatchObject({ ok: false, issues: [{ code: "sink-failed" }] });
    }
  });

  test("linearizes synchronous abort during a pending signalled write", async () => {
    const controller = new AbortController();
    const result = await writeJsonDiagnostics(
      bundle(),
      sources(),
      options(),
      {
        write(): Promise<void> {
          controller.abort();
          return Promise.resolve();
        },
      },
      controller.signal,
    );
    expect(result).toMatchObject({
      ok: false,
      chunksWritten: 0,
      issues: [{ code: "interrupted" }],
    });
    await Promise.resolve();
  });

  test("cancels a nonsettling sink and reports only its acknowledged prefix", async () => {
    const controller = new AbortController();
    let calls = 0;
    const pending = writeJsonDiagnostics(
      bundle(),
      sources(),
      options({ chunkBytes: JSON_FORMATTER_MIN_CHUNK_BYTES }),
      {
        write() {
          calls += 1;
          return new Promise<void>(() => undefined);
        },
      },
      controller.signal,
    );
    await Promise.resolve();
    controller.abort(new Error("SECRET_CANARY_ABORT"));
    const result = await pending;
    expect(calls).toBe(1);
    expect(result).toMatchObject({
      ok: false,
      byteLength: 0,
      chunksWritten: 0,
      issues: [{ code: "interrupted", path: "$signal" }],
    });
    expect(JSON.stringify(result)).not.toContain("SECRET_CANARY_ABORT");
  });

  test("rejects pre-aborted, forged, accessor, and revoked sinks without writing", async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const preAborted = await writeJsonDiagnostics(
      bundle(),
      sources(),
      options(),
      {
        write() {
          calls += 1;
        },
      },
      controller.signal,
    );
    expect(preAborted).toMatchObject({ ok: false, issues: [{ code: "interrupted" }] });
    const accessor = Object.defineProperty({}, "write", {
      get(): () => void {
        calls += 1;
        return () => undefined;
      },
    });
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();
    for (const sink of [
      null,
      {},
      accessor,
      { write: "no" },
      { write: (): void => undefined, extra: true },
      revocable.proxy,
    ]) {
      const result = await writeJsonDiagnostics(bundle(), sources(), options(), sink as never);
      expect(result).toMatchObject({ ok: false, issues: [{ code: "invalid-sink" }] });
    }
    expect(calls).toBe(0);

    const revokedSignal = Proxy.revocable({}, {});
    revokedSignal.revoke();
    for (const signal of [
      {},
      Object.create(AbortSignal.prototype) as AbortSignal,
      revokedSignal.proxy,
    ]) {
      const result = await writeJsonDiagnostics(
        bundle(),
        sources(),
        options(),
        { write: (): void => undefined },
        signal as AbortSignal,
      );
      expect(result).toMatchObject({ ok: false, issues: [{ path: "$signal" }] });
    }
  });

  test("deeply freezes successful and failed result models", () => {
    const success = successful();
    const failed = formatJsonDiagnostics(bundle(), sources(), options({ chunkBytes: 0 }));
    expect(Object.isFrozen(success)).toBe(true);
    expect(Object.isFrozen(success.chunks)).toBe(true);
    expect(Object.isFrozen(success.output)).toBe(true);
    expect(Object.isFrozen(success.output.diagnostics)).toBe(true);
    expect(Object.isFrozen(success.output.diagnostics.diagnostics)).toBe(true);
    expect(Object.isFrozen(success.output.diagnostics.diagnostics[0])).toBe(true);
    expect(Object.isFrozen(success.output.summary)).toBe(true);
    expect(Object.isFrozen(failed)).toBe(true);
    if (!failed.ok) {
      expect(Object.isFrozen(failed.issues)).toBe(true);
      expect(Object.isFrozen(failed.issues[0])).toBe(true);
    }
  });
});
