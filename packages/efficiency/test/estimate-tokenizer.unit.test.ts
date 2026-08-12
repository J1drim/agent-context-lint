import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

import {
  BUILTIN_ESTIMATE_PROVIDER_ID,
  ESTIMATE_UTF8_BYTES_PER_TOKEN,
  MAX_TOKENIZER_INPUT_BYTES,
  countEstimatedTokens,
  resolveTokenizerProvider,
} from "../src/index.js";

interface EstimateFixture {
  readonly inputCodeUnits: number;
  readonly inputUtf8Bytes: number;
  readonly name: string;
  readonly text: string;
  readonly tokens: number;
}

const FIXTURE_URL = new URL("fixtures/estimate-tokenizer.v1.json", import.meta.url);
const FIXTURES = JSON.parse(readFileSync(FIXTURE_URL, "utf8")) as readonly EstimateFixture[];

describe("G02 deterministic estimate tokenizer", () => {
  test.each(FIXTURES)("matches hand-worked $name fixture", (fixture) => {
    const result = countEstimatedTokens(fixture.text);
    expect(result).toEqual({
      ok: true,
      value: {
        contractVersion: "1.0.0",
        identity: {
          id: "agent-context-estimate",
          measurement: "estimate",
          version: "1.0.0",
        },
        inputCodeUnits: fixture.inputCodeUnits,
        inputUtf8Bytes: fixture.inputUtf8Bytes,
        tokens: fixture.tokens,
      },
    });
    expect(result.ok && result.value.tokens).toBe(
      Math.ceil(fixture.inputUtf8Bytes / ESTIMATE_UTF8_BYTES_PER_TOKEN),
    );
  });

  test("preserves the selected provider identity and returns frozen data", () => {
    const provider = resolveTokenizerProvider(BUILTIN_ESTIMATE_PROVIDER_ID);
    const result = countEstimatedTokens("stable");
    expect(provider.ok).toBe(true);
    expect(result.ok).toBe(true);
    if (!provider.ok || !result.ok) return;

    expect(result.value.identity).toBe(provider.value.identity);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(result.value.identity)).toBe(true);
  });

  test("uses UTF-8 replacement semantics for malformed UTF-16 without normalization", () => {
    expect(countEstimatedTokens("\ud800")).toEqual({
      ok: true,
      value: expect.objectContaining({
        inputCodeUnits: 1,
        inputUtf8Bytes: 3,
        tokens: 1,
      }) as unknown,
    });
    expect(countEstimatedTokens("é")).not.toEqual(countEstimatedTokens("e\u0301"));
  });

  test("accepts the exact byte ceiling and rejects both code-unit and UTF-8 overflow", () => {
    const asciiBoundary = "a".repeat(MAX_TOKENIZER_INPUT_BYTES);
    const unicodeBoundary = "é".repeat(MAX_TOKENIZER_INPUT_BYTES / 2);

    expect(countEstimatedTokens(asciiBoundary)).toMatchObject({
      ok: true,
      value: {
        inputUtf8Bytes: MAX_TOKENIZER_INPUT_BYTES,
        tokens: MAX_TOKENIZER_INPUT_BYTES / ESTIMATE_UTF8_BYTES_PER_TOKEN,
      },
    });
    expect(countEstimatedTokens(unicodeBoundary)).toMatchObject({
      ok: true,
      value: { inputUtf8Bytes: MAX_TOKENIZER_INPUT_BYTES },
    });
    expect(countEstimatedTokens(`${asciiBoundary}a`)).toMatchObject({
      issues: [{ code: "input-limit", path: "$input" }],
      ok: false,
    });
    expect(countEstimatedTokens(`${unicodeBoundary}é`)).toMatchObject({
      issues: [{ code: "input-limit", path: "$input" }],
      ok: false,
    });
  });

  test.each([null, undefined, 0, false, 1n, {}, [], Promise.resolve("text")])(
    "rejects non-string input %# without coercion",
    (input) => {
      expect(countEstimatedTokens(input)).toMatchObject({
        issues: [{ code: "invalid-input", path: "$input" }],
        ok: false,
      });
    },
  );

  test("does not inspect hostile object input", () => {
    let traps = 0;
    const hostile = new Proxy(Object.create(null) as object, {
      get(): never {
        traps += 1;
        throw new Error("must not inspect");
      },
      getPrototypeOf(): never {
        traps += 1;
        throw new Error("must not inspect");
      },
    });
    expect(countEstimatedTokens(hostile)).toMatchObject({
      issues: [{ code: "invalid-input" }],
      ok: false,
    });
    expect(traps).toBe(0);
  });

  test("is deterministic over repeated mixed Markdown and Unicode inputs", () => {
    const input = "```ts\nconst café = '😀';\n```\n\n> 漢字 and e\u0301\n";
    const first = countEstimatedTokens(input);
    for (let index = 0; index < 100; index += 1) {
      expect(countEstimatedTokens(input)).toEqual(first);
    }
  });
});
