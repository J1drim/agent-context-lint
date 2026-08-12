import { readFileSync } from "node:fs";
import { types as nodeTypes } from "node:util";

import type { AnySchema } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, test, vi } from "vitest";

import {
  KNOWLEDGE_KINDS,
  KNOWLEDGE_MATCHER_IDS,
  KNOWLEDGE_PACK_CHANNELS,
  KNOWLEDGE_PACK_CONTRACT_VERSION,
  KNOWLEDGE_VALUE_TYPES,
  LOCATION_SCOPES,
  MAX_KNOWLEDGE_PACK_BYTES,
  MAX_KNOWLEDGE_PACK_DEPTH,
  MAX_KNOWLEDGE_PACK_STRING_BYTES,
  MAX_KNOWLEDGE_PACK_STRING_CODE_POINTS,
  canonicalizeJson,
  parseCanonicalKnowledgePack,
  serializeKnowledgePack,
  validateKnowledgePack,
} from "../src/index.js";

import type { KnowledgePackIssueCode, KnowledgePackValidationResult } from "../src/index.js";

const SCHEMA = new URL("../schemas/knowledge-pack.v0.schema.json", import.meta.url);
const PACKAGE_JSON = new URL("../package.json", import.meta.url);
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function pack(): Record<string, unknown> {
  return {
    recordKind: "agent-context-knowledge-pack",
    schemaVersion: "0.1.0",
    channel: "stable",
    packId: "official.agent-context",
    packVersion: "1.2.3-rc.1+review.7",
    publishedAt: "2026-08-01",
    compatibility: [
      {
        adapterVersion: "1.0.0-alpha.1",
        channel: "stable",
        contentDigests: {
          "https://example.test/specification/v1/": HASH_B,
        },
        formatId: "agents-markdown",
        minEngineVersion: "0.1.0",
        profileId: null,
        retrievedAt: "2026-07-31",
        rulesetVersion: "1.2.3-rc.1",
        specificationUrls: ["https://example.test/specification/v1/"],
        surfaceId: null,
        upstreamRevision: "revision.abc123",
      },
    ],
    sources: [
      {
        id: "source.codex",
        url: "https://github.com/openai/codex/blob/abc/README.md",
        retrievedAt: "2026-08-01",
        sha256: HASH_A,
      },
      {
        id: "source.spec",
        url: "https://example.test/specification/v1/",
        retrievedAt: "2026-07-31",
        sha256: HASH_B,
      },
    ],
    knowledge: [
      {
        id: "knowledge.deprecated-field",
        kind: "deprecation",
        profileId: "codex-cli",
        surfaceId: "codex-cli.local",
        summary: "The legacy field is deprecated.",
        ruleIds: ["ACL106"],
        sourceIds: ["source.codex"],
        matcher: { id: "identifier-equals", operands: { identifier: "legacyField" } },
        deprecation: {
          subjectId: "legacyField",
          replacementId: "description",
          deprecatedSince: "2026-01-31",
          removalVersion: "3.0.0-beta.1+build.5",
        },
      },
      {
        id: "knowledge.description-field",
        kind: "known-field",
        profileId: "codex-cli",
        surfaceId: "codex-cli.local",
        summary: "Description is a known optional string field.",
        ruleIds: ["ACL101", "ACL102"],
        sourceIds: ["source.codex", "source.spec"],
        matcher: {
          id: "field-type",
          operands: { fieldName: "description", valueType: "string" },
        },
        field: { name: "description", required: false, valueType: "string" },
      },
      {
        id: "knowledge.root-location",
        kind: "known-location",
        profileId: null,
        surfaceId: null,
        summary: "The root AGENTS.md location is known.",
        ruleIds: ["ACL105"],
        sourceIds: ["source.spec"],
        matcher: {
          id: "location-exact",
          operands: { path: "AGENTS.md", scope: "repository-root" },
        },
        location: { path: "AGENTS.md", scope: "repository-root" },
      },
      {
        id: "knowledge.use-description",
        kind: "migration-hint",
        profileId: "codex-cli",
        surfaceId: "codex-cli.local",
        summary: "Use the current field.",
        ruleIds: ["ACL106"],
        sourceIds: ["source.codex"],
        matcher: {
          id: "identifier-transition",
          operands: { fromId: "legacyField", toId: "description" },
        },
        migration: {
          fromId: "legacyField",
          toId: "description",
          guidance: "Replace the deprecated field with description.",
        },
      },
    ],
  };
}

function expectInvalid(
  result: KnowledgePackValidationResult,
  code?: KnowledgePackIssueCode,
  path?: string,
): void {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  if (code !== undefined) expect(result.issues).toContainEqual(expect.objectContaining({ code }));
  if (path !== undefined) expect(result.issues).toContainEqual(expect.objectContaining({ path }));
}

function objectAt(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = record[key];
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(key);
  return value as Record<string, unknown>;
}

function arrayAt(record: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const value = record[key];
  if (!Array.isArray(value)) throw new TypeError(key);
  return value as Record<string, unknown>[];
}

function recordAt(
  record: Record<string, unknown>,
  key: string,
  index: number,
): Record<string, unknown> {
  const value = arrayAt(record, key)[index];
  if (value === undefined) throw new RangeError(`${key}[${String(index)}]`);
  return value;
}

function mutateKnowledge(
  input: Record<string, unknown>,
  index: number,
  operation: (record: Record<string, unknown>) => void,
): Record<string, unknown> {
  operation(recordAt(input, "knowledge", index));
  return input;
}

describe("H01 canonical data-only knowledge pack", () => {
  test("accepts every closed knowledge kind and returns a deeply immutable copy", () => {
    const input = pack();
    const result = validateKnowledgePack(input);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.value.knowledge.map((record) => record.kind)).toEqual([
      "deprecation",
      "known-field",
      "known-location",
      "migration-hint",
    ]);
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(result.value.knowledge)).toBe(true);
    expect(Object.isFrozen(result.value.knowledge[0])).toBe(true);
    expect(Object.isFrozen(result.value.knowledge[0]?.matcher.operands)).toBe(true);
    (arrayAt(recordAt(input, "knowledge", 0), "ruleIds") as unknown as string[])[0] = "ACL999";
    expect(result.value.knowledge[0]?.ruleIds).toEqual(["ACL106"]);
  });

  test("exports frozen closed vocabularies", () => {
    expect(KNOWLEDGE_PACK_CONTRACT_VERSION).toBe("0.1.0");
    expect(KNOWLEDGE_PACK_CHANNELS).toEqual(["preview", "stable"]);
    expect(KNOWLEDGE_KINDS).toEqual([
      "known-field",
      "known-location",
      "deprecation",
      "migration-hint",
    ]);
    expect(KNOWLEDGE_MATCHER_IDS).toEqual([
      "field-presence",
      "field-type",
      "identifier-equals",
      "identifier-transition",
      "location-exact",
    ]);
    expect(KNOWLEDGE_VALUE_TYPES).toEqual(["array", "boolean", "number", "object", "string"]);
    expect(LOCATION_SCOPES).toEqual(["repository-root", "scope-root"]);
    for (const vocabulary of [
      KNOWLEDGE_KINDS,
      KNOWLEDGE_MATCHER_IDS,
      KNOWLEDGE_PACK_CHANNELS,
      KNOWLEDGE_VALUE_TYPES,
      LOCATION_SCOPES,
    ])
      expect(Object.isFrozen(vocabulary)).toBe(true);
  });

  test("matches RFC 8785 number and UTF-16 property-order vectors", () => {
    expect(
      canonicalizeJson({
        numbers: [333_333_333.333_333_3, 1e30, 4.5, 2e-3, 1e-27, -0],
        string: '€$\u000f\nA\'B"\\\\"/',
        literals: [null, true, false],
      }),
    ).toEqual({
      ok: true,
      text: '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27,0],"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
    });
    expect(
      canonicalizeJson({
        "€": "Euro Sign",
        "\r": "Carriage Return",
        דּ: "Hebrew Letter Dalet With Dagesh",
        "1": "One",
        "😀": "Emoji: Grinning Face",
        "\u0080": "Control",
        ö: "Latin Small Letter O With Diaeresis",
      }),
    ).toEqual({
      ok: true,
      text: '{"\\r":"Carriage Return","1":"One","":"Control","ö":"Latin Small Letter O With Diaeresis","€":"Euro Sign","😀":"Emoji: Grinning Face","דּ":"Hebrew Letter Dalet With Dagesh"}',
    });
    expect(canonicalizeJson({ nested: [{ z: 1, a: 2 }] })).toEqual({
      ok: true,
      text: '{"nested":[{"a":2,"z":1}]}',
    });
    expect(canonicalizeJson({ composed: "é", decomposed: "e\u0301" })).toEqual({
      ok: true,
      text: '{"composed":"é","decomposed":"é"}',
    });
  });

  test("round-trips only exact canonical UTF-8 bytes", () => {
    const serialized = serializeKnowledgePack(pack());
    expect(serialized).toMatchObject({ ok: true });
    if (!serialized.ok) throw new Error(JSON.stringify(serialized.issues));
    expect(serialized.text.endsWith("\n")).toBe(false);
    const fromString = parseCanonicalKnowledgePack(serialized.text);
    const fromBytes = parseCanonicalKnowledgePack(Buffer.from(serialized.text));
    expect(fromString).toMatchObject({ ok: true, canonicalJson: serialized.text });
    expect(fromBytes).toEqual(fromString);
    if (fromString.ok) expect(serializeKnowledgePack(fromString.value)).toEqual(serialized);
  });

  test.each([
    ["leading whitespace", (text: string): string => ` ${text}`],
    ["trailing newline", (text: string): string => `${text}\n`],
    ["alternate slash escape", (text: string): string => text.replace("https://", "https:\\/\\/")],
    [
      "alternate Unicode escape",
      (text: string): string => text.replace("current", "\\u0063urrent"),
    ],
    [
      "duplicate key",
      (text: string): string => text.replace('{"channel"', '{"packId":"shadow","channel"'),
    ],
  ])("rejects noncanonical raw JSON: %s", (_name, mutate) => {
    const serialized = serializeKnowledgePack(pack());
    if (!serialized.ok) throw new Error(JSON.stringify(serialized.issues));
    expect(parseCanonicalKnowledgePack(mutate(serialized.text))).toMatchObject({
      ok: false,
      issues: [{ code: "non-canonical" }],
    });
  });

  test("rejects malformed UTF-8, BOMs, lone surrogates, invalid JSON, and raw overflow", () => {
    expect(parseCanonicalKnowledgePack(new Uint8Array([0xc3, 0x28]))).toMatchObject({ ok: false });
    expect(parseCanonicalKnowledgePack(Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d]))).toMatchObject({
      ok: false,
    });
    expect(parseCanonicalKnowledgePack("\ud800")).toMatchObject({ ok: false });
    expect(parseCanonicalKnowledgePack("{")).toMatchObject({ ok: false });
    expect(parseCanonicalKnowledgePack("x".repeat(MAX_KNOWLEDGE_PACK_BYTES + 1))).toMatchObject({
      ok: false,
      issues: [{ code: "resource-limit" }],
    });
    expect(
      parseCanonicalKnowledgePack("€".repeat(Math.floor(MAX_KNOWLEDGE_PACK_BYTES / 2))),
    ).toMatchObject({ ok: false, issues: [{ code: "resource-limit" }] });
    expect(parseCanonicalKnowledgePack(new Uint8Array(MAX_KNOWLEDGE_PACK_BYTES + 1))).toMatchObject(
      { ok: false, issues: [{ code: "resource-limit" }] },
    );
  });

  test("copies ordinary byte ingress and rejects wrong, shared, detached, and exotic views", () => {
    const serialized = serializeKnowledgePack(pack());
    if (!serialized.ok) throw new Error(JSON.stringify(serialized.issues));
    const ordinary = new Uint8Array(Buffer.from(serialized.text));
    expect(parseCanonicalKnowledgePack(ordinary)).toMatchObject({ ok: true });
    expect(
      parseCanonicalKnowledgePack(new DataView(ordinary.buffer) as unknown as Uint8Array),
    ).toMatchObject({
      ok: false,
    });
    class ExoticBytes extends Uint8Array {}
    expect(parseCanonicalKnowledgePack(new ExoticBytes(ordinary) as Uint8Array)).toMatchObject({
      ok: false,
    });
    if (typeof SharedArrayBuffer !== "undefined")
      expect(
        parseCanonicalKnowledgePack(
          new Uint8Array(new SharedArrayBuffer(serialized.text.length)) as Uint8Array,
        ),
      ).toMatchObject({ ok: false });
    const detached = new Uint8Array(Buffer.from(serialized.text));
    structuredClone(detached.buffer, { transfer: [detached.buffer] });
    expect(parseCanonicalKnowledgePack(detached)).toMatchObject({ ok: false });
    const revoked = Proxy.revocable(ordinary, {});
    revoked.revoke();
    expect(() => parseCanonicalKnowledgePack(revoked.proxy)).not.toThrow();
    expect(parseCanonicalKnowledgePack(revoked.proxy)).toMatchObject({ ok: false });
  });

  test("never invokes authority-bearing byte-view properties", () => {
    const serialized = serializeKnowledgePack(pack());
    if (!serialized.ok) throw new Error(JSON.stringify(serialized.issues));
    const attacks: { readonly bytes: Uint8Array; readonly getter: ReturnType<typeof vi.fn> }[] = [];
    for (const [factory, key] of [
      [(): Uint8Array => new Uint8Array(Buffer.from(serialized.text)), "byteLength"],
      [(): Uint8Array => Buffer.from(serialized.text), "buffer"],
      [(): Uint8Array => new Uint8Array(Buffer.from(serialized.text)), Symbol.iterator],
    ] as const) {
      const bytes = factory();
      const getter = vi.fn(() => {
        throw new Error("hostile getter executed");
      });
      Reflect.defineProperty(bytes, key, { configurable: true, get: getter });
      attacks.push({ bytes, getter });
    }
    if (typeof SharedArrayBuffer !== "undefined") {
      const getter = vi.fn(() => {
        throw new Error("shared getter executed");
      });
      const bytes = new Uint8Array(new SharedArrayBuffer(serialized.text.length));
      Reflect.defineProperty(bytes, "byteLength", { configurable: true, get: getter });
      attacks.push({ bytes, getter });
    }
    for (const attack of attacks) {
      expect(() => parseCanonicalKnowledgePack(attack.bytes)).not.toThrow();
      expect(parseCanonicalKnowledgePack(attack.bytes)).toMatchObject({ ok: false });
      expect(attack.getter).not.toHaveBeenCalled();
    }
    const extra = new Uint8Array(Buffer.from(serialized.text));
    Reflect.defineProperty(extra, "authority", { configurable: true, value: "unexpected" });
    expect(parseCanonicalKnowledgePack(extra)).toMatchObject({ ok: false });
  });

  test("applies nesting and container ceilings before JSON.parse", () => {
    const deep = `${"[".repeat(MAX_KNOWLEDGE_PACK_DEPTH + 2)}0${"]".repeat(
      MAX_KNOWLEDGE_PACK_DEPTH + 2,
    )}`;
    expect(parseCanonicalKnowledgePack(deep)).toMatchObject({
      ok: false,
      issues: [{ code: "resource-limit" }],
    });
  });

  test("bounds direct and escaped decoded strings before JSON.parse", () => {
    const parse = vi.spyOn(JSON, "parse");
    const boundaryCases = [
      `"${"a".repeat(MAX_KNOWLEDGE_PACK_STRING_CODE_POINTS)}"`,
      `"${"\\u0061".repeat(MAX_KNOWLEDGE_PACK_STRING_CODE_POINTS)}"`,
      `"${"😀".repeat(MAX_KNOWLEDGE_PACK_STRING_CODE_POINTS)}"`,
      `"${"\\ud83d\\ude00".repeat(MAX_KNOWLEDGE_PACK_STRING_CODE_POINTS)}"`,
    ];
    for (const input of boundaryCases) {
      parse.mockClear();
      expect(parseCanonicalKnowledgePack(input)).toMatchObject({ ok: false });
      expect(parse).toHaveBeenCalledOnce();
    }
    expect(MAX_KNOWLEDGE_PACK_STRING_BYTES).toBe(16_384);
    const overCases = [
      `"${"a".repeat(MAX_KNOWLEDGE_PACK_STRING_CODE_POINTS + 1)}"`,
      `"${"\\u0061".repeat(MAX_KNOWLEDGE_PACK_STRING_CODE_POINTS + 1)}"`,
      `"${"😀".repeat(MAX_KNOWLEDGE_PACK_STRING_CODE_POINTS + 1)}"`,
      `"${"\\ud83d\\ude00".repeat(MAX_KNOWLEDGE_PACK_STRING_CODE_POINTS + 1)}"`,
    ];
    for (const input of overCases) {
      parse.mockClear();
      expect(parseCanonicalKnowledgePack(input)).toMatchObject({
        ok: false,
        issues: [{ code: "resource-limit" }],
      });
      expect(parse).not.toHaveBeenCalled();
    }
    parse.mockRestore();
  });

  test("handles escape classes and malformed escaped Unicode without parsing authority", () => {
    for (const input of ['"\\u00Af"', '"\\b\\f\\n\\r\\t"', '"unterminated'])
      expect(parseCanonicalKnowledgePack(input)).toMatchObject({ ok: false });
    const parse = vi.spyOn(JSON, "parse");
    for (const input of ['"\\ud800"', '"\\ud800x"', '"\\ud800\\u0041"', '"\\udc00"']) {
      parse.mockClear();
      expect(parseCanonicalKnowledgePack(input)).toMatchObject({
        ok: false,
        issues: [{ code: "invalid-json" }],
      });
      expect(parse).not.toHaveBeenCalled();
    }
    parse.mockRestore();
    expect(parseCanonicalKnowledgePack('"\\uZZZZ"')).toMatchObject({ ok: false });
  });

  test("rejects every named executable capability and unknown matcher dispatch", () => {
    for (const field of [
      "regex",
      "glob",
      "script",
      "module",
      "expression",
      "template",
      "code",
      "callback",
      "plugin",
      "command",
      "eval",
    ]) {
      const input = pack();
      recordAt(input, "knowledge", 0)[field] = "danger";
      expectInvalid(validateKnowledgePack(input), "forbidden-field");
    }
    expectInvalid(
      validateKnowledgePack(
        mutateKnowledge(pack(), 0, (record): void => {
          objectAt(record, "matcher")["id"] = "dynamic-plugin";
        }),
      ),
      "invalid-value",
    );
    expectInvalid(
      validateKnowledgePack(
        mutateKnowledge(pack(), 0, (record): void => {
          objectAt(objectAt(record, "matcher"), "operands")["handler"] = "load";
        }),
      ),
      "forbidden-field",
    );
  });

  test("rejects hostile runtime values without invoking accessors or proxy traps", () => {
    const values: unknown[] = [];
    const callable = pack();
    callable["callback"] = (): void => undefined;
    values.push(callable);
    const symbolic = pack();
    Reflect.defineProperty(symbolic, Symbol("hidden"), { enumerable: true, value: true });
    values.push(symbolic);
    const getter = vi.fn(() => "1.0.0");
    const accessor = pack();
    Object.defineProperty(accessor, "packVersion", { enumerable: true, get: getter });
    values.push(accessor, new Proxy(pack(), {}));
    const cyclic = pack();
    cyclic["cycle"] = cyclic;
    values.push(cyclic);
    const sparse = pack();
    sparse["knowledge"] = new Array(2);
    values.push(sparse, Object.assign(Object.create({ inherited: true }) as object, pack()));
    for (const value of values) expectInvalid(validateKnowledgePack(value));
    expect(getter).not.toHaveBeenCalled();
    const revoked = Proxy.revocable(pack(), {});
    revoked.revoke();
    expect(nodeTypes.isProxy(revoked.proxy)).toBe(true);
    expect(() => validateKnowledgePack(revoked.proxy)).not.toThrow();
    expectInvalid(validateKnowledgePack(revoked.proxy), "invalid-json");
    expectInvalid(validateKnowledgePack({ value: 1n }), "invalid-json");
    expectInvalid(validateKnowledgePack({ value: Number.NaN }), "invalid-json");
  });

  test("rejects prototype-pollution fields without changing prototypes", () => {
    const input = JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>;
    Object.assign(input, pack());
    expectInvalid(validateKnowledgePack(input), "unknown-field", "$.__proto__");
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    for (const key of ["constructor", "prototype"]) {
      const polluted = pack();
      polluted[key] = { polluted: true };
      expectInvalid(validateKnowledgePack(polluted), "unknown-field", `$.${key}`);
    }
  });

  test("rejects every I-JSON Unicode noncharacter in keys, values, and raw packs", () => {
    const noncharacters: number[] = [];
    for (let codePoint = 0xfdd0; codePoint <= 0xfdef; codePoint += 1) noncharacters.push(codePoint);
    for (let plane = 0; plane <= 16; plane += 1)
      noncharacters.push(plane * 0x10000 + 0xfffe, plane * 0x10000 + 0xffff);
    expect(noncharacters).toHaveLength(66);
    const serialized = serializeKnowledgePack(pack());
    if (!serialized.ok) throw new Error(JSON.stringify(serialized.issues));
    for (const codePoint of noncharacters) {
      const noncharacter = String.fromCodePoint(codePoint);
      expect(canonicalizeJson(noncharacter)).toMatchObject({
        ok: false,
        issues: [{ code: "invalid-json" }],
      });
      expect(canonicalizeJson({ [`key${noncharacter}`]: true })).toMatchObject({
        ok: false,
        issues: [{ code: "invalid-json" }],
      });
      expect(
        parseCanonicalKnowledgePack(serialized.text.replace("legacy", noncharacter)),
      ).toMatchObject({ ok: false, issues: [{ code: "invalid-json" }] });
    }
    expect(canonicalizeJson(["\ufdcf", "\ufdf0", "\u{1fffd}", "\u{10fffd}"])).toMatchObject({
      ok: true,
    });
    const inMemory = pack();
    recordAt(inMemory, "knowledge", 0)["summary"] = "\ufdcf \ufdf0 \u{1fffd} \u{10fffd}";
    expect(validateKnowledgePack(inMemory)).toMatchObject({ ok: true });
    recordAt(inMemory, "knowledge", 0)["summary"] = `invalid \u{1fffe}`;
    expectInvalid(validateKnowledgePack(inMemory), "invalid-json");
    expect(
      parseCanonicalKnowledgePack(serialized.text.replace("legacy", "\\ud83f\\udffe")),
    ).toMatchObject({ ok: false, issues: [{ code: "invalid-json" }] });
  });

  test("enforces exact SemVer syntax in pack and compatibility identities", () => {
    for (const version of ["v1.0.0", "1.0", "01.0.0", "1.0.0-01", "1.0.0+", "1.0.0-α"]) {
      const input = pack();
      input["packVersion"] = version;
      expectInvalid(validateKnowledgePack(input), "invalid-value", "$.packVersion");
    }
    for (const key of ["adapterVersion", "minEngineVersion", "rulesetVersion"]) {
      const input = pack();
      const compatibility = recordAt(input, "compatibility", 0);
      compatibility[key] = "1.0";
      expectInvalid(validateKnowledgePack(input), "invalid-value");
    }
  });

  test("rejects impossible dates, noncanonical or credentialed HTTPS, digests, and identifiers", () => {
    const mutations: ((input: Record<string, unknown>) => void)[] = [
      (input): void => {
        input["publishedAt"] = "2026-02-30";
      },
      (input): void => {
        recordAt(input, "sources", 0)["retrievedAt"] = "0000-01-01";
      },
      (input): void => {
        recordAt(input, "sources", 0)["url"] = "http://example.test/spec";
      },
      (input): void => {
        recordAt(input, "sources", 0)["url"] = "https://user:pass@example.test/spec";
      },
      (input): void => {
        recordAt(input, "sources", 0)["url"] = "https://example.test/%";
      },
      (input): void => {
        recordAt(input, "sources", 0)["sha256"] = "A".repeat(64);
      },
      (input): void => {
        input["packId"] = "bad id";
      },
    ];
    for (const mutate of mutations) {
      const input = pack();
      mutate(input);
      expectInvalid(validateKnowledgePack(input), "invalid-value");
    }
    const futureSource = pack();
    futureSource["publishedAt"] = "2026-07-30";
    expectInvalid(validateKnowledgePack(futureSource), "invalid-relationship");
  });

  test("accepts canonical bracketed HTTPS IPv6 literals in schema and runtime", () => {
    const schema = JSON.parse(readFileSync(SCHEMA, "utf8")) as AnySchema;
    const validateSchema = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
    const canonicalUrl = "https://[2001:db8::1]/specification/v1/";
    const valid = pack();
    recordAt(valid, "sources", 1)["url"] = canonicalUrl;
    const compatibility = recordAt(valid, "compatibility", 0);
    compatibility["specificationUrls"] = [canonicalUrl];
    compatibility["contentDigests"] = { [canonicalUrl]: HASH_B };
    expect(validateSchema(valid), JSON.stringify(validateSchema.errors)).toBe(true);
    expect(validateKnowledgePack(valid)).toMatchObject({ ok: true });

    const invalidUrl = "https://2001:db8::1/specification/v1/";
    const invalid = structuredClone(valid);
    recordAt(invalid, "sources", 1)["url"] = invalidUrl;
    const invalidCompatibility = recordAt(invalid, "compatibility", 0);
    invalidCompatibility["specificationUrls"] = [invalidUrl];
    invalidCompatibility["contentDigests"] = { [invalidUrl]: HASH_B };
    expect(validateSchema(invalid)).toBe(false);
    expectInvalid(validateKnowledgePack(invalid), "invalid-value");
  });

  test("enforces unique UTF-16 order and exact source/rule references", () => {
    const unsortedSources = pack();
    unsortedSources["sources"] = [...arrayAt(unsortedSources, "sources")].reverse();
    expectInvalid(validateKnowledgePack(unsortedSources), "invalid-order");
    const duplicateSource = pack();
    arrayAt(duplicateSource, "sources").push(
      structuredClone(recordAt(duplicateSource, "sources", 1)),
    );
    expectInvalid(validateKnowledgePack(duplicateSource), "duplicate-id");
    const unsortedKnowledge = pack();
    unsortedKnowledge["knowledge"] = [...arrayAt(unsortedKnowledge, "knowledge")].reverse();
    expectInvalid(validateKnowledgePack(unsortedKnowledge), "invalid-order");
    const badRules = pack();
    recordAt(badRules, "knowledge", 1)["ruleIds"] = ["ACL102", "ACL101"];
    expectInvalid(validateKnowledgePack(badRules), "invalid-order");
    const duplicateRules = pack();
    recordAt(duplicateRules, "knowledge", 1)["ruleIds"] = ["ACL101", "ACL101"];
    expectInvalid(validateKnowledgePack(duplicateRules), "duplicate-id");
    const badRule = pack();
    recordAt(badRule, "knowledge", 1)["ruleIds"] = ["ACL099"];
    expectInvalid(validateKnowledgePack(badRule), "invalid-value");
    const unknownSource = pack();
    recordAt(unknownSource, "knowledge", 0)["sourceIds"] = ["source.missing"];
    expectInvalid(validateKnowledgePack(unknownSource), "invalid-relationship");
    const duplicateCompatibility = pack();
    arrayAt(duplicateCompatibility, "compatibility").push(
      structuredClone(recordAt(duplicateCompatibility, "compatibility", 0)),
    );
    expectInvalid(validateKnowledgePack(duplicateCompatibility), "duplicate-id");
  });

  test("enforces payload/matcher equality and kind-specific closed shapes", () => {
    const mutations: Record<string, (record: Record<string, unknown>) => void> = {
      "field-name": (record): void => {
        objectAt(objectAt(record, "matcher"), "operands")["fieldName"] = "other";
      },
      "field-type": (record): void => {
        objectAt(objectAt(record, "matcher"), "operands")["valueType"] = "number";
      },
      location: (record): void => {
        objectAt(record, "location")["path"] = "other.md";
      },
      deprecation: (record): void => {
        objectAt(objectAt(record, "matcher"), "operands")["identifier"] = "other";
      },
      migration: (record): void => {
        objectAt(record, "migration")["toId"] = "other";
      },
    };
    for (const [name, mutate] of Object.entries(mutations)) {
      const index = name.startsWith("field")
        ? 1
        : name === "location"
          ? 2
          : name === "deprecation"
            ? 0
            : 3;
      expectInvalid(
        validateKnowledgePack(mutateKnowledge(pack(), index, mutate)),
        "invalid-relationship",
      );
    }
    const presence = pack();
    const fieldRecord = recordAt(presence, "knowledge", 1);
    fieldRecord["matcher"] = { id: "field-presence", operands: { fieldName: "description" } };
    expect(validateKnowledgePack(presence)).toMatchObject({ ok: true });
    const wrongKind = pack();
    recordAt(wrongKind, "knowledge", 1)["kind"] = "future-kind";
    expectInvalid(validateKnowledgePack(wrongKind), "invalid-value");
  });

  test("rejects malformed compatibility provenance and channel mixing", () => {
    const mutations: ((input: Record<string, unknown>) => void)[] = [
      (input): void => {
        input["channel"] = "nightly";
      },
      (input): void => {
        recordAt(input, "compatibility", 0)["channel"] = "preview";
      },
      (input): void => {
        recordAt(input, "compatibility", 0)["channel"] = "nightly";
      },
      (input): void => {
        recordAt(input, "compatibility", 0)["retrievedAt"] = "today";
      },
      (input): void => {
        recordAt(input, "compatibility", 0)["specificationUrls"] = ["https://["];
      },
      (input): void => {
        recordAt(input, "compatibility", 0)["contentDigests"] = {};
      },
      (input): void => {
        const compatibility = recordAt(input, "compatibility", 0);
        compatibility["contentDigests"] = { "https://other.test/spec": HASH_B };
      },
      (input): void => {
        const compatibility = recordAt(input, "compatibility", 0);
        compatibility["contentDigests"] = { "https://example.test/specification/v1/": "bad" };
      },
      (input): void => {
        recordAt(input, "sources", 1)["sha256"] = HASH_A;
      },
      (input): void => {
        Reflect.deleteProperty(recordAt(input, "compatibility", 0), "profileId");
      },
      (input): void => {
        Reflect.deleteProperty(recordAt(input, "compatibility", 0), "contentDigests");
      },
      (input): void => {
        input["compatibility"] = [];
      },
      (input): void => {
        input["sources"] = [];
      },
      (input): void => {
        input["sources"] = ["not-an-object"];
      },
    ];
    for (const mutate of mutations) {
      const input = pack();
      mutate(input);
      expectInvalid(validateKnowledgePack(input));
    }
  });

  test("rejects malformed matcher operands and kind payload boundaries", () => {
    const cases: [number, (record: Record<string, unknown>) => void][] = [
      [
        1,
        (record): void => {
          objectAt(objectAt(record, "matcher"), "operands")["valueType"] = "callable";
        },
      ],
      [
        1,
        (record): void => {
          objectAt(record, "field")["required"] = "yes";
        },
      ],
      [
        1,
        (record): void => {
          objectAt(record, "field")["valueType"] = "callable";
        },
      ],
      [
        2,
        (record): void => {
          objectAt(objectAt(record, "matcher"), "operands")["path"] = "../outside";
        },
      ],
      [
        2,
        (record): void => {
          objectAt(objectAt(record, "matcher"), "operands")["scope"] = "host";
        },
      ],
      [
        2,
        (record): void => {
          objectAt(record, "location")["path"] = "../outside";
        },
      ],
      [
        2,
        (record): void => {
          objectAt(record, "location")["scope"] = "host";
        },
      ],
      [
        0,
        (record): void => {
          objectAt(record, "deprecation")["deprecatedSince"] = "today";
        },
      ],
      [
        0,
        (record): void => {
          objectAt(record, "deprecation")["removalVersion"] = "v3";
        },
      ],
      [
        0,
        (record): void => {
          objectAt(record, "deprecation")["replacementId"] = "legacyField";
        },
      ],
      [
        0,
        (record): void => {
          Reflect.deleteProperty(objectAt(record, "deprecation"), "removalVersion");
        },
      ],
      [
        0,
        (record): void => {
          record["matcher"] = [];
        },
      ],
      [
        3,
        (record): void => {
          objectAt(record, "migration")["toId"] = "legacyField";
          objectAt(objectAt(record, "matcher"), "operands")["toId"] = "legacyField";
        },
      ],
    ];
    for (const [index, mutate] of cases)
      expectInvalid(validateKnowledgePack(mutateKnowledge(pack(), index, mutate)));
    const nullableRemoval = pack();
    objectAt(recordAt(nullableRemoval, "knowledge", 0), "deprecation")["removalVersion"] = null;
    expect(validateKnowledgePack(nullableRemoval)).toMatchObject({ ok: true });
  });

  test("enforces text, depth, count, and shape limits", () => {
    const boundary = pack();
    recordAt(boundary, "knowledge", 0)["summary"] = "😀".repeat(
      MAX_KNOWLEDGE_PACK_STRING_CODE_POINTS,
    );
    expect(validateKnowledgePack(boundary)).toMatchObject({ ok: true });
    const over = pack();
    recordAt(over, "knowledge", 0)["summary"] = "x".repeat(
      MAX_KNOWLEDGE_PACK_STRING_CODE_POINTS + 1,
    );
    expectInvalid(validateKnowledgePack(over), "invalid-json");
    let deep: unknown = "leaf";
    for (let index = 0; index < MAX_KNOWLEDGE_PACK_DEPTH + 2; index += 1) deep = { value: deep };
    expectInvalid(validateKnowledgePack(deep), "resource-limit");
    expectInvalid(validateKnowledgePack(null), "invalid-value");
    const missing = pack();
    Reflect.deleteProperty(missing, "packId");
    expectInvalid(validateKnowledgePack(missing), "missing-field", "$.packId");
    const extra = pack();
    extra["unknown"] = true;
    expectInvalid(validateKnowledgePack(extra), "unknown-field");
    const wrongIdentity = pack();
    wrongIdentity["recordKind"] = "other";
    wrongIdentity["schemaVersion"] = "9.0.0";
    expectInvalid(validateKnowledgePack(wrongIdentity), "unsupported-version");
    const tooManyIssues = pack();
    for (let index = 0; index < 300; index += 1) tooManyIssues[`unknown${String(index)}`] = true;
    const capped = validateKnowledgePack(tooManyIssues);
    expectInvalid(capped, "resource-limit");
    if (!capped.ok) expect(capped.issues).toHaveLength(256);
    const extraArrayField = pack();
    const knowledge = arrayAt(extraArrayField, "knowledge") as unknown as Record<string, unknown>;
    knowledge["named"] = true;
    expectInvalid(validateKnowledgePack(extraArrayField), "invalid-json");
    const invalidArrays = pack();
    invalidArrays["sources"] = "not-an-array";
    invalidArrays["knowledge"] = undefined;
    expectInvalid(validateKnowledgePack(invalidArrays));
    expect(canonicalizeJson("\udc00")).toMatchObject({
      ok: false,
      issues: [{ code: "invalid-json" }],
    });
  });

  test("keeps Draft 2020-12 schema and runtime aligned for structural boundaries", () => {
    const schema = JSON.parse(readFileSync(SCHEMA, "utf8")) as AnySchema;
    const validateSchema = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
    const valid = pack();
    expect(validateSchema(valid), JSON.stringify(validateSchema.errors)).toBe(true);
    expect(validateKnowledgePack(valid)).toMatchObject({ ok: true });
    const cases = [
      mutateKnowledge(pack(), 0, (record): void => {
        record["script"] = "run";
      }),
      mutateKnowledge(pack(), 0, (record): void => {
        objectAt(record, "matcher")["id"] = "unknown";
      }),
      mutateKnowledge(pack(), 1, (record): void => {
        record["ruleIds"] = ["ACL099"];
      }),
      mutateKnowledge(pack(), 1, (record): void => {
        record["summary"] = "x".repeat(MAX_KNOWLEDGE_PACK_STRING_CODE_POINTS + 1);
      }),
    ];
    for (const value of cases) {
      expect(validateSchema(value)).toBe(false);
      expect(validateKnowledgePack(value).ok).toBe(false);
    }
  });

  test("ships the versioned schema through the package export map", () => {
    const manifest = JSON.parse(readFileSync(PACKAGE_JSON, "utf8")) as {
      exports?: Record<string, unknown>;
      files?: string[];
    };
    expect(manifest.files).toContain("schemas");
    expect(manifest.exports?.["./schemas/knowledge-pack.v0.schema.json"]).toBe(
      "./schemas/knowledge-pack.v0.schema.json",
    );
    const schema = JSON.parse(readFileSync(SCHEMA, "utf8")) as { $schema?: string; $id?: string };
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.$id).toMatch(/knowledge-pack\.v0\.schema\.json$/u);
  });
});
