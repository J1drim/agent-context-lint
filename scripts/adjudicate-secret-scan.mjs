import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baselineRelativePath = "config/secret-scan-baseline.v1.json";
const fingerprintDomain = "agent-context-secret-scan-v1\0";
const MAX_BASELINE_BYTES = 64 * 1024;
const MAX_FINDINGS = 512;
const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 100_000;
const MAX_LINE_BYTES = 2 * 1024 * 1024;
const MAX_STREAM_BYTES = 32 * 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/u;
const DETECTOR = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const REASON = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

function fail() {
  throw new Error("secret-scan adjudication input is invalid");
}

function ownObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return (
    ownObject(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort())
  );
}

function validateJsonStructure(text) {
  let index = 0;
  let nodes = 0;

  function skipWhitespace() {
    while (index < text.length) {
      const code = text.charCodeAt(index);
      if (code !== 0x09 && code !== 0x0a && code !== 0x0d && code !== 0x20) break;
      index += 1;
    }
  }

  function parseString() {
    if (text[index] !== '"') fail();
    const start = index;
    index += 1;
    while (index < text.length) {
      const code = text.charCodeAt(index);
      if (code === 0x22) {
        index += 1;
        return JSON.parse(text.slice(start, index));
      }
      if (code <= 0x1f) fail();
      if (code !== 0x5c) {
        index += 1;
        continue;
      }
      index += 1;
      const escape = text[index];
      if (escape === "u") {
        for (let offset = 1; offset <= 4; offset += 1) {
          const digit = text.charCodeAt(index + offset);
          if (!(
            (digit >= 0x30 && digit <= 0x39) ||
            (digit >= 0x41 && digit <= 0x46) ||
            (digit >= 0x61 && digit <= 0x66)
          ))
            fail();
        }
        index += 5;
      } else {
        if (!['"', "\\", "/", "b", "f", "n", "r", "t"].includes(escape)) fail();
        index += 1;
      }
    }
    fail();
  }

  function parseNumber() {
    if (text[index] === "-") index += 1;
    if (text[index] === "0") index += 1;
    else {
      if (text[index] < "1" || text[index] > "9") fail();
      while (text[index] >= "0" && text[index] <= "9") index += 1;
    }
    if (text[index] === ".") {
      index += 1;
      if (text[index] < "0" || text[index] > "9") fail();
      while (text[index] >= "0" && text[index] <= "9") index += 1;
    }
    if (text[index] === "e" || text[index] === "E") {
      index += 1;
      if (text[index] === "+" || text[index] === "-") index += 1;
      if (text[index] < "0" || text[index] > "9") fail();
      while (text[index] >= "0" && text[index] <= "9") index += 1;
    }
  }

  function parseValue(depth) {
    if (depth > MAX_JSON_DEPTH || ++nodes > MAX_JSON_NODES) fail();
    skipWhitespace();
    if (text[index] === '"') {
      parseString();
      return;
    }
    if (text[index] === "{") {
      parseObject(depth);
      return;
    }
    if (text[index] === "[") {
      parseArray(depth);
      return;
    }
    for (const literal of ["true", "false", "null"]) {
      if (text.startsWith(literal, index)) {
        index += literal.length;
        return;
      }
    }
    parseNumber();
  }

  function parseObject(depth) {
    index += 1;
    skipWhitespace();
    if (text[index] === "}") {
      index += 1;
      return;
    }
    const keys = new Set();
    for (;;) {
      skipWhitespace();
      const key = parseString();
      if (keys.has(key)) fail();
      keys.add(key);
      skipWhitespace();
      if (text[index] !== ":") fail();
      index += 1;
      parseValue(depth + 1);
      skipWhitespace();
      if (text[index] === "}") {
        index += 1;
        return;
      }
      if (text[index] !== ",") fail();
      index += 1;
    }
  }

  function parseArray(depth) {
    index += 1;
    skipWhitespace();
    if (text[index] === "]") {
      index += 1;
      return;
    }
    for (;;) {
      parseValue(depth + 1);
      skipWhitespace();
      if (text[index] === "]") {
        index += 1;
        return;
      }
      if (text[index] !== ",") fail();
      index += 1;
    }
  }

  parseValue(0);
  skipWhitespace();
  if (index !== text.length) fail();
}

function strictJson(bytes, maximum) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > maximum) fail();
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    validateJsonStructure(text);
    return JSON.parse(text);
  } catch {
    fail();
  }
}

function hasUnsafePathCodePoint(value) {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      codePoint === 0x061c ||
      codePoint === 0x200e ||
      codePoint === 0x200f ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069)
    )
      return true;
  }
  return false;
}

function canonicalPath(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 1_024 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    hasUnsafePathCodePoint(value) ||
    value.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")
  )
    fail();
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) fail();
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) fail();
  }
  return value;
}

function safeDetector(value) {
  if (typeof value !== "string" || !DETECTOR.test(value)) fail();
  return value;
}

function identityKey(value) {
  return `${value.fingerprint}\0${value.path}\0${value.detector}`;
}

export function fingerprintSecret(value) {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value) > 1024 * 1024)
    fail();
  return createHash("sha256").update(fingerprintDomain, "utf8").update(value, "utf8").digest("hex");
}

export function validateSecretScanBaseline(bytes) {
  const value = strictJson(bytes, MAX_BASELINE_BYTES);
  if (!exactKeys(value, ["findings", "fingerprintMethod", "schemaVersion"])) fail();
  if (
    value.schemaVersion !== 1 ||
    value.fingerprintMethod !== "sha256:agent-context-secret-scan-v1"
  )
    fail();
  if (!Array.isArray(value.findings) || value.findings.length > MAX_FINDINGS) fail();
  const findings = [];
  let previous = "";
  for (const entry of value.findings) {
    if (!exactKeys(entry, ["detector", "fingerprint", "path", "reason"])) fail();
    const finding = Object.freeze({
      detector: safeDetector(entry.detector),
      fingerprint:
        typeof entry.fingerprint === "string" && SHA256.test(entry.fingerprint)
          ? entry.fingerprint
          : fail(),
      path: canonicalPath(entry.path),
      reason:
        typeof entry.reason === "string" && entry.reason.length <= 128 && REASON.test(entry.reason)
          ? entry.reason
          : fail(),
    });
    const key = `${identityKey(finding)}\0${finding.reason}`;
    if (key <= previous) fail();
    previous = key;
    findings.push(finding);
  }
  return Object.freeze(findings);
}

function safeFinding(line) {
  const value = strictJson(line, MAX_LINE_BYTES);
  if (!ownObject(value)) fail();
  const raw = typeof value.RawV2 === "string" && value.RawV2.length > 0 ? value.RawV2 : value.Raw;
  const git = value.SourceMetadata?.Data?.Git;
  return Object.freeze({
    detector: safeDetector(value.DetectorName),
    fingerprint: fingerprintSecret(raw),
    path: canonicalPath(git?.file),
  });
}

export async function adjudicateSecretScan(chunks, baselineBytes) {
  const baseline = validateSecretScanBaseline(baselineBytes);
  const admitted = new Set(baseline.map(identityKey));
  const seen = new Map();
  let pending = Buffer.alloc(0);
  let totalBytes = 0;
  for await (const chunk of chunks) {
    if (!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) fail();
    const bytes = Buffer.from(chunk);
    totalBytes += bytes.length;
    if (totalBytes > MAX_STREAM_BYTES) fail();
    pending = Buffer.concat([pending, bytes]);
    for (;;) {
      const newline = pending.indexOf(0x0a);
      if (newline < 0) break;
      if (newline === 0 || newline > MAX_LINE_BYTES) fail();
      const line = pending.subarray(0, newline);
      pending = pending.subarray(newline + 1);
      const finding = safeFinding(line);
      seen.set(identityKey(finding), finding);
      if (seen.size > MAX_FINDINGS) fail();
    }
    if (pending.length > MAX_LINE_BYTES) fail();
  }
  if (pending.length !== 0) fail();
  const unadjudicated = [...seen.entries()]
    .filter(([key]) => !admitted.has(key))
    .map(([, finding]) => finding)
    .sort((left, right) =>
      Buffer.compare(Buffer.from(identityKey(left)), Buffer.from(identityKey(right))),
    );
  return Object.freeze({
    adjudicatedCount: seen.size - unadjudicated.length,
    totalCount: seen.size,
    unadjudicated: Object.freeze(unadjudicated),
  });
}

async function main() {
  if (process.argv.length !== 3 || process.argv[2] !== baselineRelativePath) fail();
  const baselinePath = path.join(rootDirectory, ...baselineRelativePath.split("/"));
  const metadata = await lstat(baselinePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) fail();
  const baseline = await readFile(baselinePath);
  const result = await adjudicateSecretScan(process.stdin, baseline);
  if (result.unadjudicated.length > 0) {
    process.stderr.write(
      `Secret scan found ${String(result.unadjudicated.length)} unadjudicated nonsecret identity record(s):\n`,
    );
    for (const finding of result.unadjudicated)
      process.stderr.write(
        `- fingerprint=${finding.fingerprint} path=${finding.path} detector=${finding.detector}\n`,
      );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `Secret scan accepted ${String(result.adjudicatedCount)} exact adjudicated identity record(s).\n`,
  );
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
