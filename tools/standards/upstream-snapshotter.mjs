import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createOfficialSourceTransport } from "./upstream-transport.mjs";

export const UPSTREAM_SNAPSHOT_CONTRACT_VERSION = "1.0.0";
export const UPSTREAM_EXTRACTOR_VERSION = "heading-v1";
export const MAX_UPSTREAM_SOURCE_BYTES = 1_048_576;
export const MAX_UPSTREAM_TOTAL_BYTES = 6 * MAX_UPSTREAM_SOURCE_BYTES;
export const MAX_UPSTREAM_SECTION_BYTES = 131_072;
export const MAX_UPSTREAM_ARTIFACT_BYTES = 10 * 1024 * 1024;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const upstreamCatalogPath = path.join(root, "tools/standards/upstream-sources.v1.json");
const SOURCE_FILE = "upstream-source.v1.json";
const PROVENANCE_FILE = "upstream-provenance.v1.json";
const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const DATE = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const ALLOWED_URLS = new Set([
  "https://agents.md/",
  "https://code.claude.com/docs/en/memory.md",
  "https://cursor.com/docs/rules.md",
  "https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-custom-instructions.md",
  "https://geminicli.com/docs/cli/gemini-md.md",
  "https://learn.chatgpt.com/docs/agent-configuration/agents-md.md",
]);

export class UpstreamSnapshotError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function fail(code, message) {
  throw new UpstreamSnapshotError(code, message);
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalValue(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value))
      fail("invalid-artifact", "canonical numbers must be safe integers");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
      fail("invalid-artifact", "canonical objects must be plain data");
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalValue(value[key])}`)
      .join(",")}}`;
  }
  fail("invalid-artifact", "canonical JSON contains an unsupported value");
}

export function canonicalJson(value) {
  return Buffer.from(`${canonicalValue(value)}\n`, "utf8");
}

function strictDate(value) {
  if (typeof value !== "string" || !DATE.test(value))
    fail("invalid-date", "retrieved date must be YYYY-MM-DD");
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value)
    fail("invalid-date", "retrieved date is not a calendar date");
  return value;
}

function decodeUtf8(bytes, label) {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength === 0 ||
    bytes.byteLength > MAX_UPSTREAM_SOURCE_BYTES
  )
    fail("resource-limit", `${label} has an invalid byte length`);
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
    fail("invalid-source", `${label} has an unsupported byte-order mark`);
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("invalid-source", `${label} is not valid UTF-8`);
  }
  if (text.includes("\0")) fail("invalid-source", `${label} contains NUL`);
  return text;
}

function parseJsonBytes(bytes, label) {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength === 0 ||
    bytes.byteLength > MAX_UPSTREAM_ARTIFACT_BYTES
  )
    fail("resource-limit", `${label} has an invalid byte length`);
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("invalid-artifact", `${label} is not valid UTF-8`);
  }
  if (text.charCodeAt(0) === 0xfeff || text.includes("\0"))
    fail("invalid-artifact", `${label} has unsupported text bytes`);
  let depth = 0;
  let values = 0;
  let string = false;
  let escaped = false;
  for (const character of text) {
    if (string) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') string = false;
      continue;
    }
    if (character === '"') string = true;
    else if (character === "{" || character === "[") {
      depth += 1;
      values += 1;
    } else if (character === "}" || character === "]") depth -= 1;
    else if (character === "," || character === ":") values += 1;
    if (depth < 0 || depth > 32 || values > 100_000)
      fail("resource-limit", `${label} exceeds JSON structure limits`);
  }
  if (string || depth !== 0) fail("invalid-artifact", `${label} is incomplete JSON`);
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail("invalid-artifact", `${label} is not valid JSON`);
  }
  return value;
}

function exactObject(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    fail("invalid-artifact", `${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index]))
    fail("invalid-artifact", `${label} fields do not match the contract`);
  return value;
}

function validateCatalog(value) {
  const catalog = exactObject(value, ["extractorVersion", "schemaVersion", "sources"], "catalog");
  if (
    catalog.schemaVersion !== UPSTREAM_SNAPSHOT_CONTRACT_VERSION ||
    catalog.extractorVersion !== UPSTREAM_EXTRACTOR_VERSION
  )
    fail("invalid-catalog", "catalog version is unsupported");
  if (!Array.isArray(catalog.sources) || catalog.sources.length !== ALLOWED_URLS.size)
    fail("invalid-catalog", "catalog must contain every reviewed official source exactly once");
  let previous = "";
  const urls = new Set();
  for (const [sourceIndex, entry] of catalog.sources.entries()) {
    const source = exactObject(
      entry,
      ["format", "id", "sections", "url"],
      `catalog source ${sourceIndex}`,
    );
    if (typeof source.id !== "string" || !ID.test(source.id) || source.id <= previous)
      fail("invalid-catalog", "catalog source identifiers must be unique and sorted");
    previous = source.id;
    if (!ALLOWED_URLS.has(source.url) || urls.has(source.url))
      fail("invalid-catalog", "catalog URL is not in the compiled exact allowlist");
    urls.add(source.url);
    const parsed = new URL(source.url);
    if (
      parsed.protocol !== "https:" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.port !== "" ||
      parsed.hash !== "" ||
      parsed.search !== ""
    )
      fail("invalid-catalog", "catalog URLs must be simple credential-free HTTPS URLs");
    if (source.format !== "html" && source.format !== "markdown")
      fail("invalid-catalog", "catalog source format is unsupported");
    if (
      !Array.isArray(source.sections) ||
      source.sections.length < 1 ||
      source.sections.length > 16
    )
      fail("invalid-catalog", "catalog source has an invalid section count");
    const sectionIds = new Set();
    for (const [sectionIndex, entrySection] of source.sections.entries()) {
      const section = exactObject(
        entrySection,
        ["heading", "id", "level"],
        `catalog section ${sectionIndex}`,
      );
      if (typeof section.id !== "string" || !ID.test(section.id) || sectionIds.has(section.id))
        fail("invalid-catalog", "catalog section identifier is invalid or duplicated");
      if (
        typeof section.heading !== "string" ||
        section.heading.length < 1 ||
        section.heading.length > 128 ||
        /[\0\r\n]/u.test(section.heading)
      )
        fail("invalid-catalog", "catalog section heading is invalid");
      if (!Number.isSafeInteger(section.level) || section.level < 1 || section.level > 6)
        fail("invalid-catalog", "catalog section heading level is invalid");
      sectionIds.add(section.id);
    }
  }
  if ([...ALLOWED_URLS].some((url) => !urls.has(url)))
    fail("invalid-catalog", "catalog omits a compiled official URL");
  return catalog;
}

export function parseCatalogBytes(bytes) {
  const value = parseJsonBytes(bytes, "catalog");
  return validateCatalog(value);
}

function htmlEntities(value) {
  const named = { amp: "&", apos: "'", gt: ">", lt: "<", nbsp: " ", quot: '"' };
  return value.replaceAll(
    /&(?:(#\d+)|(#x[0-9a-f]+)|([a-z]+));/giu,
    (match, decimal, hexadecimal, name) => {
      if (decimal !== undefined) {
        const point = Number(decimal.slice(1));
        return Number.isInteger(point) && point > 0 && point <= 0x10ffff
          ? String.fromCodePoint(point)
          : match;
      }
      if (hexadecimal !== undefined) {
        const point = Number.parseInt(hexadecimal.slice(2), 16);
        return Number.isInteger(point) && point > 0 && point <= 0x10ffff
          ? String.fromCodePoint(point)
          : match;
      }
      return named[name?.toLowerCase()] ?? match;
    },
  );
}

function visibleHtml(value) {
  const withoutUnsafe = value
    .replaceAll(
      /<(?:script|style|template|svg)\b[^>]*>[\s\S]*?<\/(?:script|style|template|svg)>/giu,
      "",
    )
    .replaceAll(/<!--[\s\S]*?-->/gu, "")
    .replaceAll(/<(?:br|hr)\s*\/?>/giu, "\n")
    .replaceAll(/<\/(?:p|div|li|pre|blockquote|table|tr|ul|ol)>/giu, "\n")
    .replaceAll(/<[^>]+>/gu, "");
  return htmlEntities(withoutUnsafe);
}

function normalizeText(value) {
  const lines = value
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .normalize("NFC")
    .split("\n")
    .map((line) => line.replace(/[\t ]+$/gu, ""));
  while (lines[0] === "") lines.shift();
  while (lines.at(-1) === "") lines.pop();
  const output = [];
  let blanks = 0;
  for (const line of lines) {
    if (line === "") {
      blanks += 1;
      if (blanks > 1) continue;
    } else blanks = 0;
    output.push(line);
  }
  return `${output.join("\n")}\n`;
}

function markdownHeadings(text) {
  const headings = [];
  let offset = 0;
  for (const line of text.split(/(?<=\n)/u)) {
    const match = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*(?:\n)?$/u.exec(line);
    if (match !== null)
      headings.push({
        bodyStart: offset + line.length,
        heading: match[2].trim(),
        level: match[1].length,
        start: offset,
      });
    offset += line.length;
  }
  return headings;
}

function htmlHeadings(text) {
  const headings = [];
  const expression = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/giu;
  for (const match of text.matchAll(expression)) {
    headings.push({
      bodyStart: (match.index ?? 0) + match[0].length,
      heading: normalizeText(visibleHtml(match[2])).trim(),
      level: Number(match[1]),
      start: match.index ?? 0,
    });
  }
  return headings;
}

function extractSections(text, source) {
  const normalizedSource = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const headings =
    source.format === "markdown"
      ? markdownHeadings(normalizedSource)
      : htmlHeadings(normalizedSource);
  const results = [];
  for (const requested of source.sections) {
    const matches = headings.filter(
      (heading) => heading.heading === requested.heading && heading.level === requested.level,
    );
    if (matches.length !== 1)
      fail(
        "section-mismatch",
        `official source ${source.id} does not contain exactly one ${requested.id} heading at level ${requested.level}`,
      );
    const selected = matches[0];
    const next = headings.find(
      (heading) => heading.start > selected.start && heading.level <= selected.level,
    );
    const raw = normalizedSource.slice(selected.bodyStart, next?.start ?? normalizedSource.length);
    const normalized = normalizeText(source.format === "html" ? visibleHtml(raw) : raw);
    const bytes = Buffer.from(normalized, "utf8");
    if (bytes.byteLength === 1 || bytes.byteLength > MAX_UPSTREAM_SECTION_BYTES)
      fail(
        "resource-limit",
        `official source ${source.id} section ${requested.id} has an invalid size`,
      );
    results.push({
      heading: requested.heading,
      id: requested.id,
      level: selected.level,
      normalized,
      sha256: sha256(bytes),
    });
  }
  return results;
}

function buildArtifacts(catalog, retrievedAt, responses) {
  if (responses.length !== catalog.sources.length)
    fail("invalid-source", "transport response count does not match catalog");
  let total = 0;
  const sourceEntries = [];
  const provenanceEntries = [];
  for (const [index, source] of catalog.sources.entries()) {
    const response = responses[index];
    if (response === undefined || !(response.bytes instanceof Uint8Array))
      fail("invalid-source", "transport returned invalid source bytes");
    if (response.mediaType !== (source.format === "html" ? "text/html" : "text/markdown"))
      fail("invalid-source", `official source ${source.id} returned the wrong media type`);
    total += response.bytes.byteLength;
    if (total > MAX_UPSTREAM_TOTAL_BYTES)
      fail("resource-limit", "official source capture exceeds the total byte limit");
    const text = decodeUtf8(response.bytes, `official source ${source.id}`);
    const sections = extractSections(text, source);
    const rawHash = sha256(response.bytes);
    sourceEntries.push({
      format: source.format,
      id: source.id,
      rawBase64: Buffer.from(response.bytes).toString("base64"),
      rawBytes: response.bytes.byteLength,
      rawSha256: rawHash,
      sections,
      url: source.url,
    });
    provenanceEntries.push({
      id: source.id,
      mediaType: response.mediaType,
      method: "GET",
      rawBytes: response.bytes.byteLength,
      rawSha256: rawHash,
      retrievedAt,
      sectionHashes: sections.map(({ id, sha256: sectionHash }) => ({ id, sha256: sectionHash })),
      status: 200,
      url: source.url,
    });
  }
  const catalogBytes = canonicalJson(catalog);
  const sourceArtifact = {
    catalogSha256: sha256(catalogBytes),
    extractorVersion: UPSTREAM_EXTRACTOR_VERSION,
    schemaVersion: UPSTREAM_SNAPSHOT_CONTRACT_VERSION,
    sources: sourceEntries,
  };
  const sourceBytes = canonicalJson(sourceArtifact);
  const provenanceArtifact = {
    catalogSha256: sourceArtifact.catalogSha256,
    contractVersion: UPSTREAM_SNAPSHOT_CONTRACT_VERSION,
    retrievedAt,
    sourceArtifactSha256: sha256(sourceBytes),
    sources: provenanceEntries,
  };
  return {
    provenanceArtifact,
    provenanceBytes: canonicalJson(provenanceArtifact),
    sourceArtifact,
    sourceBytes,
  };
}

export async function captureUpstreamSnapshot({ catalogBytes, retrievedAt, signal, transport }) {
  const catalog = parseCatalogBytes(catalogBytes);
  const date = strictDate(retrievedAt);
  if (!(signal instanceof AbortSignal) || Object.getPrototypeOf(signal) !== AbortSignal.prototype)
    fail("invalid-input", "signal must be a native AbortSignal");
  if (signal.aborted) fail("cancelled", "upstream capture was cancelled");
  if (transport === null || typeof transport !== "object" || typeof transport.fetch !== "function")
    fail("invalid-input", "transport capability is invalid");
  const responses = [];
  for (const source of catalog.sources) {
    if (signal.aborted) fail("cancelled", "upstream capture was cancelled");
    let response;
    try {
      response = await transport.fetch(source, { signal });
    } catch (error) {
      if (error instanceof UpstreamSnapshotError)
        throw new UpstreamSnapshotError(
          error.code,
          `official source ${source.id} failed: ${error.message}`,
        );
      if (signal.aborted) fail("cancelled", "upstream capture was cancelled");
      fail("network-failure", "official source fetch failed closed");
    }
    responses.push(response);
  }
  return buildArtifacts(catalog, date, responses);
}

export function verifyUpstreamSnapshot({ catalogBytes, provenanceBytes, sourceBytes }) {
  const catalog = parseCatalogBytes(catalogBytes);
  const sourceArtifact = parseJsonBytes(sourceBytes, "source artifact");
  const provenanceArtifact = parseJsonBytes(provenanceBytes, "provenance artifact");
  if (
    !Buffer.from(sourceBytes).equals(canonicalJson(sourceArtifact)) ||
    !Buffer.from(provenanceBytes).equals(canonicalJson(provenanceArtifact))
  )
    fail("invalid-artifact", "snapshot artifacts must use canonical JSON bytes");
  const sourceRoot = exactObject(
    sourceArtifact,
    ["catalogSha256", "extractorVersion", "schemaVersion", "sources"],
    "source artifact",
  );
  const provenanceRoot = exactObject(
    provenanceArtifact,
    ["catalogSha256", "contractVersion", "retrievedAt", "sourceArtifactSha256", "sources"],
    "provenance artifact",
  );
  strictDate(provenanceRoot.retrievedAt);
  const expectedCatalogHash = sha256(canonicalJson(catalog));
  if (
    sourceRoot.schemaVersion !== UPSTREAM_SNAPSHOT_CONTRACT_VERSION ||
    sourceRoot.extractorVersion !== UPSTREAM_EXTRACTOR_VERSION ||
    sourceRoot.catalogSha256 !== expectedCatalogHash ||
    provenanceRoot.catalogSha256 !== expectedCatalogHash ||
    provenanceRoot.contractVersion !== UPSTREAM_SNAPSHOT_CONTRACT_VERSION ||
    provenanceRoot.sourceArtifactSha256 !== sha256(sourceBytes)
  )
    fail("invalid-artifact", "snapshot artifact identity or digest does not match");
  if (!Array.isArray(sourceRoot.sources) || sourceRoot.sources.length !== catalog.sources.length)
    fail("invalid-artifact", "source artifact source count does not match catalog");
  const responses = sourceRoot.sources.map((entry, index) => {
    const source = exactObject(
      entry,
      ["format", "id", "rawBase64", "rawBytes", "rawSha256", "sections", "url"],
      `source artifact entry ${index}`,
    );
    const catalogSource = catalog.sources[index];
    if (
      catalogSource === undefined ||
      source.id !== catalogSource.id ||
      source.url !== catalogSource.url ||
      source.format !== catalogSource.format ||
      typeof source.rawBase64 !== "string" ||
      source.rawBase64.length > Math.ceil(MAX_UPSTREAM_SOURCE_BYTES / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(source.rawBase64)
    )
      fail("invalid-artifact", "source artifact entry does not match catalog");
    const bytes = Buffer.from(source.rawBase64, "base64");
    if (
      !Number.isSafeInteger(source.rawBytes) ||
      source.rawBytes !== bytes.byteLength ||
      !SHA256.test(source.rawSha256) ||
      source.rawSha256 !== sha256(bytes)
    )
      fail("invalid-artifact", "source artifact raw source digest does not match");
    return { bytes, mediaType: source.format === "html" ? "text/html" : "text/markdown" };
  });
  const rebuilt = buildArtifacts(catalog, provenanceRoot.retrievedAt, responses);
  if (
    !rebuilt.sourceBytes.equals(Buffer.from(sourceBytes)) ||
    !rebuilt.provenanceBytes.equals(Buffer.from(provenanceBytes))
  )
    fail("invalid-artifact", "offline replay does not reproduce the snapshot artifacts");
  return {
    ok: true,
    retrievedAt: provenanceRoot.retrievedAt,
    sourceArtifactSha256: sha256(sourceBytes),
    sources: catalog.sources.length,
  };
}

export async function writeSnapshotArtifacts(outputDirectory, artifacts) {
  const selected = path.resolve(outputDirectory);
  const parent = path.dirname(selected);
  const parentMetadata = await lstat(parent);
  if (
    parentMetadata.isSymbolicLink() ||
    !parentMetadata.isDirectory() ||
    (await realpath(parent)) !== parent
  )
    fail("unsafe-output", "snapshot output parent must be a real canonical directory");
  try {
    await mkdir(selected, { mode: 0o700 });
  } catch {
    fail("unsafe-output", "snapshot output directory must not already exist");
  }
  const temporarySource = path.join(selected, `.${SOURCE_FILE}.tmp`);
  const temporaryProvenance = path.join(selected, `.${PROVENANCE_FILE}.tmp`);
  try {
    for (const [temporary, finalName, bytes] of [
      [temporarySource, SOURCE_FILE, artifacts.sourceBytes],
      [temporaryProvenance, PROVENANCE_FILE, artifacts.provenanceBytes],
    ]) {
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, path.join(selected, finalName));
    }
  } catch (error) {
    await rm(selected, { force: true, recursive: true });
    throw error;
  }
  return {
    provenancePath: path.join(selected, PROVENANCE_FILE),
    sourcePath: path.join(selected, SOURCE_FILE),
  };
}

function argumentsMap(arguments_) {
  const command = arguments_[0];
  const rest = arguments_.slice(1);
  if (command === "capture") {
    if (rest.length !== 3 || rest[0] !== "--output-dir" || rest[2] !== "--acknowledge-network")
      fail(
        "usage",
        "usage: upstream-snapshotter.mjs capture --output-dir DIR --acknowledge-network",
      );
    return { command, outputDirectory: rest[1] };
  }
  if (command === "verify") {
    if (rest.length !== 4 || rest[0] !== "--source" || rest[2] !== "--provenance")
      fail("usage", "usage: upstream-snapshotter.mjs verify --source FILE --provenance FILE");
    return { command, provenancePath: rest[3], sourcePath: rest[1] };
  }
  fail("usage", "expected capture or verify command");
}

export async function runMaintainerCli(arguments_, dependencies = {}) {
  const selected = argumentsMap(arguments_);
  const catalogBytes = await readFile(upstreamCatalogPath);
  if (selected.command === "verify") {
    const result = verifyUpstreamSnapshot({
      catalogBytes,
      provenanceBytes: await readFile(selected.provenancePath),
      sourceBytes: await readFile(selected.sourcePath),
    });
    return `Verified ${result.sources} official sources at ${result.retrievedAt}; source artifact ${result.sourceArtifactSha256}.\n`;
  }
  const controller = new AbortController();
  let now;
  try {
    now = dependencies.now === undefined ? Date.now() : dependencies.now();
  } catch {
    fail("invalid-date", "maintainer capture clock failed");
  }
  if (
    !Number.isSafeInteger(now) ||
    now < Date.UTC(1970, 0, 1) ||
    now > Date.UTC(9999, 11, 31, 23, 59, 59)
  )
    fail("invalid-date", "maintainer capture clock is outside UTC bounds");
  const retrievedAt = new Date(now).toISOString().slice(0, 10);
  const artifacts = await captureUpstreamSnapshot({
    catalogBytes,
    retrievedAt,
    signal: controller.signal,
    transport: dependencies.transport ?? createOfficialSourceTransport(),
  });
  const written = await writeSnapshotArtifacts(selected.outputDirectory, artifacts);
  return `Captured ${artifacts.sourceArtifact.sources.length} official sources.\nSource: ${written.sourcePath}\nProvenance: ${written.provenancePath}\n`;
}

const invoked =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invoked) {
  try {
    process.stdout.write(await runMaintainerCli(process.argv.slice(2)));
  } catch (error) {
    const message =
      error instanceof UpstreamSnapshotError
        ? `${error.code}: ${error.message}`
        : "unexpected-failure: snapshotter failed closed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
