import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";

import {
  RepositoryPathError,
  canonicalizeRepositoryRelativePath,
  compareRepositoryRelativePaths,
  repositoryRelativePathFromAbsolute,
  repositoryRelativePathToAbsolute,
} from "../../packages/core/dist/index.js";
import type {
  InstructionDocumentId,
  PathFlavor,
  RepositoryRelativePath,
  SourceDocumentId,
} from "../../packages/core/dist/index.js";
import {
  DEFAULT_IMPORT_GRAPH_LIMITS,
  IGNORE_ENGINE_DEFAULT_LIMITS,
  IgnoreEngineError,
  ImportGraphLoaderError,
  READ_ONLY_REPOSITORY_DEFAULT_LIMITS,
  ReadOnlyRepositoryError,
  ReadOnlyRepositoryErrorCode,
  ReadOnlyRepositoryFile,
  TRACKED_FILE_ENUMERATION_DEFAULT_LIMITS,
  applyIgnoreRules,
  loadImportGraph,
} from "../../packages/evidence/src/index.js";
import type {
  IgnoreEngineResult,
  ImportGraphResult,
  ReadOnlyRepository,
  TrackedFileEnumerationResult,
} from "../../packages/evidence/src/index.js";
import { MarkdownParserError, extractMarkdownContent } from "../../packages/markdown/src/index.js";
import {
  FrontmatterParserError,
  lexImportReferences,
  parseFrontmatter,
} from "../../packages/syntax/src/index.js";
import type { FrontmatterDialect, ImportDialect } from "../../packages/syntax/src/index.js";
import { SEEDED_RANDOM_ALGORITHM, SeededRandom } from "../../packages/test-kit/src/index.js";
import { describe, expect, test } from "vitest";

const FIXTURE = new URL("../fixtures/fuzz/parser-surfaces.v1.json", import.meta.url);
const CONTROL_SEQUENCE = new RegExp(
  String.raw`[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]`,
  "u",
);
const SOURCE_ID = "source:c12" as SourceDocumentId;
const DOCUMENT_ID = "document:c12" as InstructionDocumentId;

interface CorpusBounds {
  readonly generatedCasesPerSeed: number;
  readonly maxGeneratedInputBytes: number;
  readonly maxGeneratedInputUtf16CodeUnits: number;
  readonly maxPersistedCases: number;
  readonly maxPersistedTotalBytes: number;
  readonly maxSeeds: number;
}

interface TextRegression {
  readonly id: string;
  readonly text: string;
}

interface FrontmatterRegression {
  readonly bytesBase64: string;
  readonly dialect: FrontmatterDialect;
  readonly id: string;
}

interface ImportRegression extends TextRegression {
  readonly syntax: ImportDialect;
}

interface GraphRegression {
  readonly id: string;
  readonly sources: Readonly<Record<string, string>>;
}

interface IgnoreRegression {
  readonly id: string;
  readonly paths: readonly string[];
  readonly patterns: readonly string[];
}

interface PathRegression {
  readonly flavor: PathFlavor;
  readonly id: string;
  readonly input: string;
}

interface ParserFuzzCorpus {
  readonly algorithm: typeof SEEDED_RANDOM_ALGORITHM;
  readonly bounds: CorpusBounds;
  readonly recordKind: "agent-context-parser-fuzz-corpus";
  readonly regressions: {
    readonly frontmatter: readonly FrontmatterRegression[];
    readonly graphs: readonly GraphRegression[];
    readonly ignore: readonly IgnoreRegression[];
    readonly imports: readonly ImportRegression[];
    readonly markdown: readonly TextRegression[];
    readonly paths: readonly PathRegression[];
  };
  readonly schemaVersion: 1;
  readonly seeds: readonly number[];
}

interface CapturedOutcome {
  readonly fingerprint: string;
  readonly messages: readonly string[];
  readonly value: unknown;
}

function dataRecord(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new TypeError(`${label} must be a plain object`);
  return value as Readonly<Record<string, unknown>>;
}

function denseArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value) || Reflect.ownKeys(value).length !== value.length + 1)
    throw new TypeError(`${label} must be a dense array`);
  return value;
}

function requiredString(record: Readonly<Record<string, unknown>>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new TypeError(`${key} must be a string`);
  return value;
}

function requiredInteger(record: Readonly<Record<string, unknown>>, key: string): number {
  const value = record[key];
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new TypeError(`${key} must be a non-negative safe integer`);
  return value as number;
}

function exactKeys(record: Readonly<Record<string, unknown>>, expected: readonly string[]): void {
  expect(Object.keys(record).sort()).toEqual([...expected].sort());
}

async function loadCorpus(): Promise<ParserFuzzCorpus> {
  const parsed: unknown = JSON.parse(await readFile(FIXTURE, "utf8"));
  const root = dataRecord(parsed, "corpus");
  exactKeys(root, ["algorithm", "bounds", "recordKind", "regressions", "schemaVersion", "seeds"]);
  if (
    root["algorithm"] !== SEEDED_RANDOM_ALGORITHM ||
    root["recordKind"] !== "agent-context-parser-fuzz-corpus" ||
    root["schemaVersion"] !== 1
  )
    throw new TypeError("corpus identity is invalid");
  const boundsRecord = dataRecord(root["bounds"], "corpus.bounds");
  exactKeys(boundsRecord, [
    "generatedCasesPerSeed",
    "maxGeneratedInputBytes",
    "maxGeneratedInputUtf16CodeUnits",
    "maxPersistedCases",
    "maxPersistedTotalBytes",
    "maxSeeds",
  ]);
  const bounds: CorpusBounds = Object.freeze({
    generatedCasesPerSeed: requiredInteger(boundsRecord, "generatedCasesPerSeed"),
    maxGeneratedInputBytes: requiredInteger(boundsRecord, "maxGeneratedInputBytes"),
    maxGeneratedInputUtf16CodeUnits: requiredInteger(
      boundsRecord,
      "maxGeneratedInputUtf16CodeUnits",
    ),
    maxPersistedCases: requiredInteger(boundsRecord, "maxPersistedCases"),
    maxPersistedTotalBytes: requiredInteger(boundsRecord, "maxPersistedTotalBytes"),
    maxSeeds: requiredInteger(boundsRecord, "maxSeeds"),
  });
  const seeds = denseArray(root["seeds"], "corpus.seeds").map((seed) => {
    if (!Number.isSafeInteger(seed) || (seed as number) < 0 || (seed as number) > 0xffff_ffff)
      throw new TypeError("corpus seed must be an unsigned 32-bit integer");
    return seed as number;
  });
  const regressions = dataRecord(root["regressions"], "corpus.regressions");
  exactKeys(regressions, ["frontmatter", "graphs", "ignore", "imports", "markdown", "paths"]);
  const textCases = (key: "markdown"): readonly TextRegression[] =>
    denseArray(regressions[key], `corpus.regressions.${key}`).map((value) => {
      const record = dataRecord(value, `${key} case`);
      exactKeys(record, ["id", "text"]);
      return Object.freeze({
        id: requiredString(record, "id"),
        text: requiredString(record, "text"),
      });
    });
  const frontmatter = denseArray(regressions["frontmatter"], "frontmatter cases").map((value) => {
    const record = dataRecord(value, "frontmatter case");
    exactKeys(record, ["bytesBase64", "dialect", "id"]);
    const dialect = requiredString(record, "dialect");
    if (dialect !== "mdc" && dialect !== "yaml") throw new TypeError("invalid frontmatter dialect");
    const bytesBase64 = requiredString(record, "bytesBase64");
    const decoded = Buffer.from(bytesBase64, "base64");
    if (decoded.toString("base64") !== bytesBase64)
      throw new TypeError("frontmatter bytes must use canonical base64");
    return Object.freeze({
      bytesBase64,
      dialect,
      id: requiredString(record, "id"),
    });
  });
  const imports = denseArray(regressions["imports"], "import cases").map((value) => {
    const record = dataRecord(value, "import case");
    exactKeys(record, ["id", "syntax", "text"]);
    const syntax = requiredString(record, "syntax");
    if (
      syntax !== "claude-code" &&
      syntax !== "copilot-cli" &&
      syntax !== "cursor-agent" &&
      syntax !== "gemini-cli"
    )
      throw new TypeError("invalid import dialect");
    return Object.freeze({
      id: requiredString(record, "id"),
      syntax,
      text: requiredString(record, "text"),
    });
  });
  const graphs = denseArray(regressions["graphs"], "graph cases").map((value) => {
    const record = dataRecord(value, "graph case");
    exactKeys(record, ["id", "sources"]);
    const sourcesRecord = dataRecord(record["sources"], "graph sources");
    if (Object.keys(sourcesRecord).length > DEFAULT_IMPORT_GRAPH_LIMITS.maxFiles)
      throw new TypeError("graph regression exceeds the file limit");
    const sources: Record<string, string> = {};
    for (const [path, text] of Object.entries(sourcesRecord)) {
      if (typeof text !== "string") throw new TypeError("graph source must be text");
      const canonical = canonicalizeRepositoryRelativePath(path);
      if (canonical !== path) throw new TypeError("graph source path must be canonical");
      sources[path] = text;
    }
    if (!Object.hasOwn(sources, "AGENTS.md"))
      throw new TypeError("graph regression must contain AGENTS.md");
    return Object.freeze({
      id: requiredString(record, "id"),
      sources: Object.freeze(sources),
    });
  });
  const ignore = denseArray(regressions["ignore"], "ignore cases").map((value) => {
    const record = dataRecord(value, "ignore case");
    exactKeys(record, ["id", "paths", "patterns"]);
    const strings = (key: "paths" | "patterns"): readonly string[] =>
      denseArray(record[key], key).map((item) => {
        if (typeof item !== "string") throw new TypeError(`${key} item must be a string`);
        return item;
      });
    return Object.freeze({
      id: requiredString(record, "id"),
      paths: Object.freeze(strings("paths")),
      patterns: Object.freeze(strings("patterns")),
    });
  });
  const paths = denseArray(regressions["paths"], "path cases").map((value) => {
    const record = dataRecord(value, "path case");
    exactKeys(record, ["flavor", "id", "input"]);
    const flavor = requiredString(record, "flavor");
    if (flavor !== "posix" && flavor !== "win32") throw new TypeError("invalid path flavor");
    return Object.freeze({
      flavor,
      id: requiredString(record, "id"),
      input: requiredString(record, "input"),
    });
  });
  return Object.freeze({
    algorithm: SEEDED_RANDOM_ALGORITHM,
    bounds,
    recordKind: "agent-context-parser-fuzz-corpus",
    regressions: Object.freeze({
      frontmatter: Object.freeze(frontmatter),
      graphs: Object.freeze(graphs),
      ignore: Object.freeze(ignore),
      imports: Object.freeze(imports),
      markdown: Object.freeze(textCases("markdown")),
      paths: Object.freeze(paths),
    }),
    schemaVersion: 1,
    seeds: Object.freeze(seeds),
  });
}

const corpus = await loadCorpus();

function errorFingerprint(
  error: Error & { readonly code?: unknown; readonly limitName?: unknown },
): string {
  return JSON.stringify({
    code: typeof error.code === "string" ? error.code : null,
    limitName: typeof error.limitName === "string" ? error.limitName : null,
    message: error.message,
    name: error.name,
  });
}

function capture(
  operation: () => unknown,
  expectedError: (error: unknown) => error is Error,
): CapturedOutcome {
  try {
    const value = operation();
    return { fingerprint: JSON.stringify(value), messages: diagnosticMessages(value), value };
  } catch (error) {
    if (!expectedError(error)) throw error;
    return {
      fingerprint: errorFingerprint(error),
      messages: [error.message],
      value: error,
    };
  }
}

async function captureAsync(
  operation: () => Promise<unknown>,
  expectedError: (error: unknown) => error is Error,
): Promise<CapturedOutcome> {
  try {
    const value = await operation();
    return { fingerprint: JSON.stringify(value), messages: diagnosticMessages(value), value };
  } catch (error) {
    if (!expectedError(error)) throw error;
    return {
      fingerprint: errorFingerprint(error),
      messages: [error.message],
      value: error,
    };
  }
}

function diagnosticMessages(value: unknown): readonly string[] {
  if (value === null || typeof value !== "object") return [];
  const output: string[] = [];
  const pending: object[] = [value];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);
    for (const [key, item] of Object.entries(current as Record<string, unknown>)) {
      if ((key === "message" || key === "code" || key === "operation") && typeof item === "string")
        output.push(item);
      else if (item !== null && typeof item === "object") pending.push(item);
    }
  }
  return output;
}

function expectSafeMessages(messages: readonly string[]): void {
  for (const message of messages) expect(message).not.toMatch(CONTROL_SEQUENCE);
}

function expectDeterministic(first: CapturedOutcome, second: CapturedOutcome): void {
  expect(second.fingerprint).toBe(first.fingerprint);
  expectSafeMessages(first.messages);
  expectSafeMessages(second.messages);
}

function expectRangesContained(value: unknown, text: string): void {
  if (value === null || typeof value !== "object" || value instanceof Error) return;
  const pending: object[] = [value];
  const seen = new Set<object>();
  const byteLength = Buffer.byteLength(text, "utf8");
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);
    const record = current as Record<string, unknown>;
    const start = record["start"];
    const end = record["end"];
    if (
      typeof record["sourceId"] === "string" &&
      start !== null &&
      typeof start === "object" &&
      end !== null &&
      typeof end === "object"
    ) {
      const startRecord = start as Record<string, unknown>;
      const endRecord = end as Record<string, unknown>;
      const startUtf16 = startRecord["utf16Offset"];
      const endUtf16 = endRecord["utf16Offset"];
      const startByte = startRecord["byteOffset"];
      const endByte = endRecord["byteOffset"];
      expect(startUtf16).toEqual(expect.any(Number));
      expect(endUtf16).toEqual(expect.any(Number));
      expect(startByte).toEqual(expect.any(Number));
      expect(endByte).toEqual(expect.any(Number));
      expect(startUtf16 as number).toBeGreaterThanOrEqual(0);
      expect(endUtf16 as number).toBeGreaterThanOrEqual(startUtf16 as number);
      expect(endUtf16 as number).toBeLessThanOrEqual(text.length);
      expect(startByte as number).toBeGreaterThanOrEqual(0);
      expect(endByte as number).toBeGreaterThanOrEqual(startByte as number);
      expect(endByte as number).toBeLessThanOrEqual(byteLength);
    }
    for (const item of Object.values(record))
      if (item !== null && typeof item === "object") pending.push(item);
  }
}

function expectGraphContained(
  outcome: CapturedOutcome,
  sources: Readonly<Record<string, string>>,
  reads: readonly string[],
): void {
  if (outcome.value instanceof Error) return;
  const graph = outcome.value as ImportGraphResult;
  expect(graph.usage.files).toBeLessThanOrEqual(DEFAULT_IMPORT_GRAPH_LIMITS.maxFiles);
  expect(graph.usage.edges).toBeLessThanOrEqual(DEFAULT_IMPORT_GRAPH_LIMITS.maxEdges);
  for (const node of graph.nodes) {
    expect(Object.hasOwn(sources, node.path)).toBe(true);
    expectRangesContained(node.imports, sources[node.path] ?? "");
  }
  expect(reads.every((path) => Object.hasOwn(sources, path))).toBe(true);
}

function expectIgnoreContained(
  outcome: CapturedOutcome,
  inputPaths: readonly RepositoryRelativePath[],
): void {
  if (outcome.value instanceof Error) return;
  const result = outcome.value as IgnoreEngineResult;
  const allowed = new Set(inputPaths);
  expect(result.rules.length).toBeLessThanOrEqual(IGNORE_ENGINE_DEFAULT_LIMITS.maximumPatterns);
  expect(result.paths.every((path) => allowed.has(path))).toBe(true);
  expect(result.ignored.every((decision) => allowed.has(decision.path))).toBe(true);
}

function isTypedParserError(error: unknown, prefixes: readonly string[]): error is Error {
  const code =
    error instanceof Error && "code" in error && typeof error.code === "string"
      ? error.code
      : undefined;
  return (
    error instanceof Error &&
    code !== undefined &&
    prefixes.some((prefix) => code.startsWith(prefix))
  );
}

function pick<T>(values: readonly T[], random: SeededRandom): T {
  const value = values[random.nextInteger(values.length)];
  if (value === undefined) throw new RangeError("fuzz token table is unexpectedly empty");
  return value;
}

const TEXT_TOKENS = [
  "a",
  " ",
  "\n",
  "\r\n",
  "# heading\n",
  "```",
  "~~~",
  "<!--",
  "-->",
  "@docs/file.md",
  "[link](../target.md)",
  "*",
  "_",
  "`code`",
  "\u001b[31m",
  "\u202e",
  "\ud800",
  "🧭",
  "日本語",
] as const;

function generatedText(random: SeededRandom): string {
  const count = random.nextInteger(49);
  let output = "";
  for (let index = 0; index < count; index += 1)
    output +=
      random.nextInteger(4) === 0
        ? String.fromCodePoint(random.nextInteger(0x11_0000))
        : pick(TEXT_TOKENS, random);
  expect(output.length).toBeLessThanOrEqual(corpus.bounds.maxGeneratedInputUtf16CodeUnits);
  expect(Buffer.byteLength(output, "utf8")).toBeLessThanOrEqual(
    corpus.bounds.maxGeneratedInputBytes,
  );
  return output;
}

function generatedBytes(random: SeededRandom): Uint8Array {
  const length = random.nextInteger(513);
  const output = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) output[index] = random.nextUint32() & 0xff;
  expect(output.byteLength).toBeLessThanOrEqual(corpus.bounds.maxGeneratedInputBytes);
  return output;
}

function enumeration(paths: readonly RepositoryRelativePath[]): TrackedFileEnumerationResult {
  return {
    certainty: "tracked",
    indexObjectFormat: "sha1",
    indexVersion: 2,
    limits: TRACKED_FILE_ENUMERATION_DEFAULT_LIMITS,
    omittedProblems: 0,
    paths,
    problems: [],
    reason: "verified-git-index",
    source: "git-index",
  };
}

function inertRepository(
  sources: Readonly<Record<string, string | Uint8Array>> = {},
  reads: string[] = [],
): ReadOnlyRepository {
  return {
    inspect(): ReturnType<ReadOnlyRepository["inspect"]> {
      return Promise.reject(new Error("fuzz repository inspect is not permitted"));
    },
    limits: READ_ONLY_REPOSITORY_DEFAULT_LIMITS,
    readDirectory(): ReturnType<ReadOnlyRepository["readDirectory"]> {
      return Promise.reject(new Error("fuzz repository directory reads are not permitted"));
    },
    readFile(pathValue): ReturnType<ReadOnlyRepository["readFile"]> {
      const path = canonicalizeRepositoryRelativePath(String(pathValue));
      reads.push(path);
      const source = sources[path];
      if (source === undefined)
        throw new ReadOnlyRepositoryError(
          ReadOnlyRepositoryErrorCode.pathUnavailable,
          "fuzz fixture path is unavailable",
          "read-file",
          path,
        );
      const bytes = typeof source === "string" ? Buffer.from(source, "utf8") : source;
      return Promise.resolve(
        new ReadOnlyRepositoryFile(path, bytes, { device: "1", inode: String(reads.length) }, 0),
      );
    },
    root: "/c12-fuzz-fixture",
    usage(): ReturnType<ReadOnlyRepository["usage"]> {
      return { elapsedMs: 0, entries: reads.length, metadataOperations: 0, totalBytes: 0 };
    },
  };
}

function generatedCanonicalPaths(random: SeededRandom): readonly RepositoryRelativePath[] {
  const segments = ["src", "docs", "a.ts", "b.md", "café", "日本語", "🧭"] as const;
  const values = new Set<RepositoryRelativePath>();
  const count = 1 + random.nextInteger(24);
  while (values.size < count) {
    const depth = 1 + random.nextInteger(4);
    const selected = Array.from({ length: depth }, () => pick(segments, random));
    values.add(canonicalizeRepositoryRelativePath(selected.join("/")));
  }
  return Object.freeze([...values].sort(compareRepositoryRelativePaths));
}

function generatedPatterns(random: SeededRandom): readonly string[] {
  const tokens = ["*", "**", "?", "[ab]", "src/", "docs/", "!", "a.ts", "*.md"] as const;
  return Object.freeze(
    Array.from({ length: 1 + random.nextInteger(12) }, () => {
      let pattern = "";
      const count = 1 + random.nextInteger(8);
      for (let index = 0; index < count; index += 1) pattern += pick(tokens, random);
      return pattern;
    }),
  );
}

function generatedPathInput(random: SeededRandom): string {
  const tokens = ["src", ".", "..", "", "C:", "\\", "/", "\u001b", "\ud800", "café", "🧭"] as const;
  const count = 1 + random.nextInteger(16);
  let output = "";
  for (let index = 0; index < count; index += 1) {
    output += pick(tokens, random);
    if (index + 1 < count) output += random.nextInteger(2) === 0 ? "/" : "\\";
  }
  return output;
}

function generatedGraph(random: SeededRandom): Readonly<Record<string, string>> {
  const count = 1 + random.nextInteger(16);
  const sources: Record<string, string> = { "AGENTS.md": "" };
  for (let index = 0; index < count; index += 1) sources[`docs/${String(index)}.md`] = "";
  const names = Object.keys(sources);
  for (const name of names) {
    const references: string[] = [];
    const fanOut = random.nextInteger(5);
    for (let index = 0; index < fanOut; index += 1) {
      const target = names[random.nextInteger(names.length)] ?? "AGENTS.md";
      const prefix = name === "AGENTS.md" ? "" : "../";
      references.push(`@${prefix}${target}`);
    }
    if (random.nextInteger(8) === 0) references.push("@../../outside.md");
    sources[name] = references.join("\n");
  }
  return sources;
}

describe("C12 persisted corpus contract", () => {
  test("is closed, bounded, stable, and contains every required fuzz surface", () => {
    expect(corpus.algorithm).toBe(SEEDED_RANDOM_ALGORITHM);
    expect(corpus.bounds).toEqual({
      generatedCasesPerSeed: 24,
      maxGeneratedInputBytes: 8192,
      maxGeneratedInputUtf16CodeUnits: 4096,
      maxPersistedCases: 64,
      maxPersistedTotalBytes: 65536,
      maxSeeds: 16,
    });
    expect(corpus.seeds.length).toBeGreaterThan(0);
    expect(corpus.seeds.length).toBeLessThanOrEqual(corpus.bounds.maxSeeds);
    expect(new Set(corpus.seeds).size).toBe(corpus.seeds.length);
    const cases = Object.values(corpus.regressions).flat();
    expect(cases.length).toBeLessThanOrEqual(corpus.bounds.maxPersistedCases);
    expect(Object.values(corpus.regressions).every((values) => values.length > 0)).toBe(true);
    const ids = cases.map((item) => item.id);
    expect(ids.every((id) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(id))).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect(Buffer.byteLength(JSON.stringify(cases), "utf8")).toBeLessThanOrEqual(
      corpus.bounds.maxPersistedTotalBytes,
    );
    expect(corpus.bounds.generatedCasesPerSeed).toBeGreaterThanOrEqual(16);
    expect(corpus.bounds.generatedCasesPerSeed).toBeLessThanOrEqual(256);
  });
});

describe("C12 Markdown and frontmatter fuzz targets", () => {
  test.each(corpus.seeds)("replays Markdown seed %i deterministically", (seed) => {
    const firstRandom = new SeededRandom(seed);
    const secondRandom = new SeededRandom(seed);
    for (let index = 0; index < corpus.bounds.generatedCasesPerSeed; index += 1) {
      const firstText = generatedText(firstRandom);
      const secondText = generatedText(secondRandom);
      expect(secondText).toBe(firstText);
      const run = (text: string): CapturedOutcome =>
        capture(
          () => extractMarkdownContent({ sourceId: SOURCE_ID, text }),
          (error): error is Error => error instanceof MarkdownParserError,
        );
      const first = run(firstText);
      const second = run(secondText);
      expectDeterministic(first, second);
      expectRangesContained(first.value, firstText);
    }
  });

  test.each(corpus.regressions.markdown)("replays Markdown regression $id", ({ text }) => {
    const run = (): CapturedOutcome =>
      capture(
        () => extractMarkdownContent({ sourceId: SOURCE_ID, text }),
        (error): error is Error => error instanceof MarkdownParserError,
      );
    const first = run();
    expectDeterministic(first, run());
    expectRangesContained(first.value, text);
  });

  test.each(corpus.seeds)("replays frontmatter seed %i deterministically", (seed) => {
    const firstRandom = new SeededRandom(seed);
    const secondRandom = new SeededRandom(seed);
    for (let index = 0; index < corpus.bounds.generatedCasesPerSeed; index += 1) {
      const firstBytes = generatedBytes(firstRandom);
      const secondBytes = generatedBytes(secondRandom);
      expect(secondBytes).toEqual(firstBytes);
      const dialect: FrontmatterDialect = index % 2 === 0 ? "yaml" : "mdc";
      const run = (bytes: Uint8Array): CapturedOutcome =>
        capture(
          () => parseFrontmatter({ bytes, dialect, sourceId: SOURCE_ID }),
          (error): error is Error => error instanceof FrontmatterParserError,
        );
      const first = run(firstBytes);
      expectDeterministic(first, run(secondBytes));
      if (!(first.value instanceof Error)) {
        const result = first.value as { readonly text: string | null };
        if (result.text !== null) expectRangesContained(first.value, result.text);
      }
    }
  });

  test.each(corpus.regressions.frontmatter)(
    "replays frontmatter regression $id",
    ({ bytesBase64, dialect }) => {
      const bytes = Buffer.from(bytesBase64, "base64");
      const run = (): CapturedOutcome =>
        capture(
          () => parseFrontmatter({ bytes, dialect, sourceId: SOURCE_ID }),
          (error): error is Error => error instanceof FrontmatterParserError,
        );
      const first = run();
      expectDeterministic(first, run());
      if (!(first.value instanceof Error)) {
        const result = first.value as { readonly text: string | null };
        if (result.text !== null) expectRangesContained(first.value, result.text);
      }
    },
  );
});

describe("C12 import lexer and graph fuzz targets", () => {
  test.each(corpus.seeds)("replays import-lexer seed %i deterministically", (seed) => {
    const firstRandom = new SeededRandom(seed);
    const secondRandom = new SeededRandom(seed);
    const dialects: readonly ImportDialect[] = [
      "claude-code",
      "copilot-cli",
      "cursor-agent",
      "gemini-cli",
    ];
    for (let index = 0; index < corpus.bounds.generatedCasesPerSeed; index += 1) {
      const firstText = generatedText(firstRandom);
      const secondText = generatedText(secondRandom);
      const syntax = dialects[index % dialects.length] ?? "claude-code";
      const run = (text: string): CapturedOutcome =>
        capture(
          () => lexImportReferences({ documentId: DOCUMENT_ID, sourceId: SOURCE_ID, syntax, text }),
          (error): error is Error => isTypedParserError(error, ["IMPORT_LEXER_", "MARKDOWN_"]),
        );
      const first = run(firstText);
      expectDeterministic(first, run(secondText));
      expectRangesContained(first.value, firstText);
    }
  });

  test.each(corpus.regressions.imports)("replays import regression $id", ({ syntax, text }) => {
    const run = (): CapturedOutcome =>
      capture(
        () => lexImportReferences({ documentId: DOCUMENT_ID, sourceId: SOURCE_ID, syntax, text }),
        (error): error is Error => isTypedParserError(error, ["IMPORT_LEXER_", "MARKDOWN_"]),
      );
    const first = run();
    expectDeterministic(first, run());
    expectRangesContained(first.value, text);
  });

  test.each(corpus.seeds)("replays import-graph seed %i deterministically", async (seed) => {
    const firstSources = generatedGraph(new SeededRandom(seed));
    const secondSources = generatedGraph(new SeededRandom(seed));
    expect(secondSources).toEqual(firstSources);
    const run = async (sources: Readonly<Record<string, string>>): Promise<CapturedOutcome> => {
      const reads: string[] = [];
      const outcome = await captureAsync(
        () =>
          loadImportGraph({
            entryPath: canonicalizeRepositoryRelativePath("AGENTS.md"),
            repository: inertRepository(sources, reads),
            syntax: "claude-code",
          }),
        (error): error is Error => error instanceof ImportGraphLoaderError,
      );
      expect(reads.every((path) => !path.includes("..") && !path.startsWith("/"))).toBe(true);
      expectGraphContained(outcome, sources, reads);
      return outcome;
    };
    expectDeterministic(await run(firstSources), await run(secondSources));
  });

  test.each(corpus.regressions.graphs)(
    "replays import-graph regression $id",
    async ({ sources }) => {
      const run = async (): Promise<CapturedOutcome> => {
        const reads: string[] = [];
        const outcome = await captureAsync(
          () =>
            loadImportGraph({
              entryPath: canonicalizeRepositoryRelativePath("AGENTS.md"),
              repository: inertRepository(sources, reads),
              syntax: "claude-code",
            }),
          (error): error is Error => error instanceof ImportGraphLoaderError,
        );
        expectGraphContained(outcome, sources, reads);
        return outcome;
      };
      const first = await run();
      expectDeterministic(first, await run());
      if (!(first.value instanceof Error)) {
        const graph = first.value as ImportGraphResult;
        expect(graph.issues.some((issue) => issue.code === "IMPORT_GRAPH_CYCLE")).toBe(true);
        expect(graph.issues.some((issue) => issue.code === "IMPORT_GRAPH_ROOT_BOUNDARY")).toBe(
          true,
        );
      }
    },
  );
});

describe("C12 ignore/glob and path fuzz targets", () => {
  test.each(corpus.seeds)("replays ignore/glob seed %i deterministically", async (seed) => {
    const firstRandom = new SeededRandom(seed);
    const secondRandom = new SeededRandom(seed);
    for (let index = 0; index < corpus.bounds.generatedCasesPerSeed; index += 1) {
      const firstPaths = generatedCanonicalPaths(firstRandom);
      const firstPatterns = generatedPatterns(firstRandom);
      const secondPaths = generatedCanonicalPaths(secondRandom);
      const secondPatterns = generatedPatterns(secondRandom);
      expect(secondPaths).toEqual(firstPaths);
      expect(secondPatterns).toEqual(firstPatterns);
      const run = (
        paths: readonly RepositoryRelativePath[],
        patterns: readonly string[],
      ): Promise<CapturedOutcome> =>
        captureAsync(
          () =>
            applyIgnoreRules(inertRepository(), enumeration(paths), {
              configurationPatterns: patterns,
              maximumMatchWork: 100_000,
            }),
          (error): error is Error => error instanceof IgnoreEngineError,
        );
      const first = await run(firstPaths, firstPatterns);
      expectDeterministic(first, await run(secondPaths, secondPatterns));
      expectIgnoreContained(first, firstPaths);
    }
  });

  test.each(corpus.regressions.ignore)(
    "replays ignore/glob regression $id",
    async ({ paths, patterns }) => {
      const canonical = Object.freeze(
        paths
          .map((path) => canonicalizeRepositoryRelativePath(path))
          .sort(compareRepositoryRelativePaths),
      );
      const run = (): Promise<CapturedOutcome> =>
        captureAsync(
          () =>
            applyIgnoreRules(inertRepository(), enumeration(canonical), {
              configurationPatterns: patterns,
            }),
          (error): error is Error => error instanceof IgnoreEngineError,
        );
      const first = await run();
      expectDeterministic(first, await run());
      expectIgnoreContained(first, canonical);
    },
  );

  test.each(corpus.seeds)("replays path seed %i deterministically", (seed) => {
    const firstRandom = new SeededRandom(seed);
    const secondRandom = new SeededRandom(seed);
    for (let index = 0; index < corpus.bounds.generatedCasesPerSeed; index += 1) {
      const firstInput = generatedPathInput(firstRandom);
      const secondInput = generatedPathInput(secondRandom);
      const flavor: PathFlavor = index % 2 === 0 ? "posix" : "win32";
      const run = (input: string): CapturedOutcome =>
        capture(
          () => {
            const relative = canonicalizeRepositoryRelativePath(input, flavor);
            const root = flavor === "posix" ? "/repository" : "C:\\repository";
            const absolute = repositoryRelativePathToAbsolute(root, relative, flavor);
            expect(repositoryRelativePathFromAbsolute(root, absolute, flavor)).toBe(relative);
            return relative;
          },
          (error): error is Error => error instanceof RepositoryPathError,
        );
      expectDeterministic(run(firstInput), run(secondInput));
    }
  });

  test.each(corpus.regressions.paths)("replays path regression $id", ({ flavor, input }) => {
    const run = (): CapturedOutcome =>
      capture(
        () => canonicalizeRepositoryRelativePath(input, flavor),
        (error): error is Error => error instanceof RepositoryPathError,
      );
    expectDeterministic(run(), run());
  });
});

describe("C12 deterministic complexity guards", () => {
  test("rejects delimiter, YAML, import, glob, and graph pressure finitely", async () => {
    const markdown = capture(
      () =>
        extractMarkdownContent(
          { sourceId: SOURCE_ID, text: `${"*".repeat(129)}\n` },
          { maxDelimiterRun: 128 },
        ),
      (error): error is Error => error instanceof MarkdownParserError,
    );
    expect(markdown.value).toBeInstanceOf(MarkdownParserError);

    const importLexer = capture(
      () =>
        lexImportReferences(
          {
            documentId: DOCUMENT_ID,
            sourceId: SOURCE_ID,
            syntax: "claude-code",
            text: `@${"a".repeat(65)}`,
          },
          { maxSpecifierUtf16CodeUnits: 64 },
        ),
      (error): error is Error => isTypedParserError(error, ["IMPORT_LEXER_"]),
    );
    expect(importLexer.value).toMatchObject({
      code: "IMPORT_LEXER_RESOURCE_LIMIT",
      limitName: "maxSpecifierUtf16CodeUnits",
    });

    const nestedYaml = `---\nvalue: ${"[".repeat(80)}0${"]".repeat(80)}\n---\n`;
    const frontmatter = parseFrontmatter(
      { bytes: Buffer.from(nestedYaml), dialect: "yaml", sourceId: SOURCE_ID },
      { maxDepth: 8 },
    );
    expect(frontmatter.issues.some((issue) => issue.code === "resource-limit")).toBe(true);

    const oversizedScalar = parseFrontmatter(
      {
        bytes: Buffer.from(`---\nvalue: ${"a".repeat(129)}\n---\n`),
        dialect: "yaml",
        sourceId: SOURCE_ID,
      },
      { maxScalarBytes: 128 },
    );
    expect(oversizedScalar.issues.some((issue) => issue.code === "resource-limit")).toBe(true);

    const glob = await captureAsync(
      () =>
        applyIgnoreRules(
          inertRepository(),
          enumeration([canonicalizeRepositoryRelativePath(`${"a".repeat(128)}.txt`)]),
          {
            configurationPatterns: [`${"*a".repeat(64)}b`],
            maximumMatchWork: 32,
          },
        ),
      (error): error is Error => error instanceof IgnoreEngineError,
    );
    expect(glob.value).toBeInstanceOf(IgnoreEngineError);

    const fanOut = DEFAULT_IMPORT_GRAPH_LIMITS.maxFanOut + 1;
    const sources: Record<string, string> = {
      "AGENTS.md": Array.from({ length: fanOut }, (_, index) => `@docs/${String(index)}.md`).join(
        "\n",
      ),
    };
    for (let index = 0; index < fanOut; index += 1) sources[`docs/${String(index)}.md`] = "";
    const graph = await loadImportGraph({
      entryPath: canonicalizeRepositoryRelativePath("AGENTS.md"),
      repository: inertRepository(sources),
      syntax: "claude-code",
    });
    expect(graph.usage.edges).toBeLessThanOrEqual(DEFAULT_IMPORT_GRAPH_LIMITS.maxFanOut + 1);
    expect(graph.issues.some((issue) => issue.code === "IMPORT_GRAPH_FAN_OUT_LIMIT")).toBe(true);
    expectSafeMessages([
      ...markdown.messages,
      ...importLexer.messages,
      ...frontmatter.issues.map((issue) => issue.message),
      ...oversizedScalar.issues.map((issue) => issue.message),
      ...glob.messages,
      ...graph.issues.map((issue) => issue.code),
    ]);
    expect(IGNORE_ENGINE_DEFAULT_LIMITS.maximumMatchWork).toBeGreaterThan(32);

    const longPath = `${"a/".repeat(2_047)}a`;
    expect(longPath.length).toBeLessThanOrEqual(corpus.bounds.maxGeneratedInputUtf16CodeUnits);
    const canonicalLongPath = canonicalizeRepositoryRelativePath(longPath);
    expect(canonicalLongPath.split("/")).toHaveLength(2_048);
    expect(canonicalizeRepositoryRelativePath(canonicalLongPath)).toBe(canonicalLongPath);
  });
});
