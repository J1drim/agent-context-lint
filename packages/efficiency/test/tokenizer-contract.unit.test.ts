import { readFileSync } from "node:fs";

import type { AnySchema } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, test } from "vitest";

import {
  BUILTIN_ESTIMATE_PROVIDER_ID,
  MAX_TOKENIZER_ID_BYTES,
  MAX_TOKENIZER_VERSION_BYTES,
  TOKENIZER_PLUGIN_CONTRACT_VERSION,
  compareTokenizerIdentities,
  resolveTokenizerProvider,
  validateTokenizerIdentity,
} from "../src/index.js";

import type { TokenizerIdentity } from "../src/index.js";

const IDENTITY_SCHEMA = new URL("../schemas/tokenizer-identity.v1.schema.json", import.meta.url);

function identity(overrides: Partial<TokenizerIdentity> = {}): TokenizerIdentity {
  return {
    id: "unicode.code-point",
    measurement: "estimate",
    version: "2026-08-02",
    ...overrides,
  };
}

describe("G01 tokenizer provider contract", () => {
  test("resolves the immutable built-in estimate from the engine-owned registry", () => {
    const first = resolveTokenizerProvider(BUILTIN_ESTIMATE_PROVIDER_ID);
    const second = resolveTokenizerProvider(BUILTIN_ESTIMATE_PROVIDER_ID);

    expect(first).toEqual(second);
    expect(first).toEqual({
      ok: true,
      value: {
        contractVersion: TOKENIZER_PLUGIN_CONTRACT_VERSION,
        execution: "builtin",
        identity: {
          id: "agent-context-estimate",
          measurement: "estimate",
          version: "1.0.0",
        },
        providerId: BUILTIN_ESTIMATE_PROVIDER_ID,
      },
    });
    expect(Object.isFrozen(first)).toBe(true);
    expect(first.ok && Object.isFrozen(first.value)).toBe(true);
    expect(first.ok && Object.isFrozen(first.value.identity)).toBe(true);
  });

  test("rejects caller-declared exact providers and never touches executable-looking fields", () => {
    let getterCalls = 0;
    const forged = Object.defineProperty(
      {
        identity: { id: "forged-exact", measurement: "exact", version: "1" },
        providerId: "optional:forged-exact",
      },
      "countTokens",
      {
        get(): never {
          getterCalls += 1;
          throw new Error("must not execute or inspect repository-supplied code");
        },
      },
    );

    expect(resolveTokenizerProvider(forged)).toMatchObject({
      issues: [{ code: "invalid-provider-id" }],
      ok: false,
    });
    expect(resolveTokenizerProvider("optional:forged-exact")).toMatchObject({
      issues: [{ code: "unsupported-provider" }],
      ok: false,
    });
    expect(getterCalls).toBe(0);
  });

  test.each([
    null,
    undefined,
    "",
    "bad provider",
    "two::parts",
    "bad\nvalue",
    "a".repeat(MAX_TOKENIZER_ID_BYTES + 1),
    new Proxy(Object.create(null) as object, {
      get(): never {
        throw new Error("must not inspect object input");
      },
    }),
  ])("rejects malformed provider selection %#", (candidate) => {
    expect(resolveTokenizerProvider(candidate)).toMatchObject({
      issues: [{ code: "invalid-provider-id" }],
      ok: false,
    });
  });

  test.each([
    identity({ measurement: "exact" }),
    identity({ id: "o200k_base", version: "1.2.3-beta.1+build.4" }),
    identity({ id: "a".repeat(MAX_TOKENIZER_ID_BYTES) }),
    identity({ version: "v".repeat(MAX_TOKENIZER_VERSION_BYTES) }),
  ])("accepts identity boundary %#", (candidate) => {
    const result = validateTokenizerIdentity(candidate);
    expect(result).toMatchObject({ ok: true, value: candidate });
    expect(result.ok && Object.isFrozen(result.value)).toBe(true);
  });

  test.each([
    null,
    [],
    {},
    identity({ id: "" }),
    identity({ id: "two..parts" }),
    identity({ id: "bad\nvalue" }),
    identity({ id: "a".repeat(MAX_TOKENIZER_ID_BYTES + 1) }),
    identity({ measurement: "approximate" as "exact" }),
    identity({ version: "" }),
    identity({ version: "bad version" }),
    identity({ version: "v".repeat(MAX_TOKENIZER_VERSION_BYTES + 1) }),
    { ...identity(), extra: true },
    Object.create({ inherited: true }) as unknown,
  ])("rejects malformed identity %#", (candidate) => {
    expect(validateTokenizerIdentity(candidate)).toMatchObject({
      issues: [{ code: "invalid-identity" }],
      ok: false,
    });
  });

  test("rejects proxy, accessor, and symbolic identities without invoking accessors", () => {
    let getterCalls = 0;
    const accessor = Object.defineProperty({ id: "estimate", measurement: "estimate" }, "version", {
      get(): string {
        getterCalls += 1;
        return "1";
      },
    });
    const candidates: readonly unknown[] = [
      accessor,
      new Proxy(identity(), {}),
      { ...identity(), [Symbol("unknown")]: true },
    ];
    for (const candidate of candidates) {
      expect(validateTokenizerIdentity(candidate)).toMatchObject({
        issues: [{ code: "invalid-identity" }],
        ok: false,
      });
    }
    expect(getterCalls).toBe(0);
  });

  test("accepts comparison only for byte-identical identity triples", () => {
    const left = identity({ measurement: "exact", version: "1.0.0" });
    const compatible = compareTokenizerIdentities(left, { ...left });
    expect(compatible).toEqual({
      compatible: true,
      identity: left,
      key: "5:exact18:unicode.code-point5:1.0.0",
    });
    expect(Object.isFrozen(compatible)).toBe(true);
    expect(compatible.compatible && Object.isFrozen(compatible.identity)).toBe(true);
  });

  test.each([
    [identity(), identity({ measurement: "exact" }), "incompatible-measurement"],
    [identity(), identity({ id: "other" }), "incompatible-id"],
    [identity(), identity({ version: "2026-08-03" }), "incompatible-version"],
  ])("rejects incompatible comparison %#", (left, right, code) => {
    expect(compareTokenizerIdentities(left, right)).toMatchObject({
      compatible: false,
      issues: [{ code }],
    });
  });

  test("rejects malformed comparison identities with side-specific paths", () => {
    expect(compareTokenizerIdentities({}, identity())).toMatchObject({
      compatible: false,
      issues: [{ code: "invalid-identity", path: "$left" }],
    });
    expect(compareTokenizerIdentities(identity(), {})).toMatchObject({
      compatible: false,
      issues: [{ code: "invalid-identity", path: "$right" }],
    });
  });

  test("keeps JSON Schema identity acceptance aligned with runtime validation", () => {
    const schema = JSON.parse(readFileSync(IDENTITY_SCHEMA, "utf8")) as AnySchema;
    const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
    const fixtures: readonly unknown[] = [
      identity(),
      identity({ measurement: "exact", version: "1.2.3-beta.1+build.4" }),
      identity({ id: "" }),
      identity({ measurement: "unknown" as "exact" }),
      identity({ version: "bad version" }),
      { ...identity(), extra: true },
    ];
    for (const fixture of fixtures) {
      expect(validate(fixture), JSON.stringify(validate.errors)).toBe(
        validateTokenizerIdentity(fixture).ok,
      );
    }
  });
});
