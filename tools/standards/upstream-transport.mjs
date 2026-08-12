import { Resolver } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

import { MAX_UPSTREAM_SOURCE_BYTES, UpstreamSnapshotError } from "./upstream-snapshotter.mjs";

export const UPSTREAM_DNS_TIMEOUT_MS = 3_000;
export const UPSTREAM_REQUEST_TIMEOUT_MS = 12_000;
export const MAX_UPSTREAM_HEADERS = 64;
export const MAX_UPSTREAM_HEADER_BYTES = 16_384;
export const MAX_UPSTREAM_BODY_CHUNKS = 4_096;

const OFFICIAL_SOURCE_FORMATS = new Map([
  ["https://agents.md/", "html"],
  ["https://code.claude.com/docs/en/memory.md", "markdown"],
  ["https://cursor.com/docs/rules.md", "markdown"],
  [
    "https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-custom-instructions.md",
    "markdown",
  ],
  ["https://geminicli.com/docs/cli/gemini-md.md", "markdown"],
  ["https://learn.chatgpt.com/docs/agent-configuration/agents-md.md", "markdown"],
]);

function fail(code, message) {
  throw new UpstreamSnapshotError(code, message);
}

function ipv4Bytes(value) {
  const parts = value.split(".");
  if (parts.length !== 4) return undefined;
  const result = [];
  for (const part of parts) {
    if (!/^(?:0|[1-9]\d{0,2})$/u.test(part)) return undefined;
    const number = Number(part);
    if (number > 255) return undefined;
    result.push(number);
  }
  return result;
}

function ipv4Public(value) {
  const bytes = ipv4Bytes(value);
  if (bytes === undefined) return false;
  const [a = 0, b = 0, c = 0] = bytes;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 0 && [0, 2].includes(c)) return false;
  if (a === 192 && b === 31 && c === 196) return false;
  if (a === 192 && b === 52 && c === 193) return false;
  if (a === 192 && b === 88 && c === 99) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 175 && c === 48) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function ipv6Bytes(value) {
  if (value.includes("%") || isIP(value) !== 6) return undefined;
  let selected = value.toLowerCase();
  if (selected.includes(".")) {
    const split = selected.lastIndexOf(":");
    const v4 = ipv4Bytes(selected.slice(split + 1));
    if (split < 0 || v4 === undefined) return undefined;
    selected = `${selected.slice(0, split)}:${((v4[0] ?? 0) * 256 + (v4[1] ?? 0)).toString(16)}:${((v4[2] ?? 0) * 256 + (v4[3] ?? 0)).toString(16)}`;
  }
  const halves = selected.split("::");
  if (halves.length > 2) return undefined;
  const left = halves[0] === "" ? [] : halves[0].split(":");
  const right = halves.length === 1 || halves[1] === "" ? [] : halves[1].split(":");
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1))
    return undefined;
  const words = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  if (words.length !== 8) return undefined;
  const result = new Uint8Array(16);
  for (const [index, word] of words.entries()) {
    if (!/^[0-9a-f]{1,4}$/u.test(word)) return undefined;
    const number = Number.parseInt(word, 16);
    result[index * 2] = number >>> 8;
    result[index * 2 + 1] = number & 0xff;
  }
  return result;
}

function prefix(bytes, expected, bits) {
  const whole = Math.floor(bits / 8);
  for (let index = 0; index < whole; index += 1) if (bytes[index] !== expected[index]) return false;
  const remainder = bits % 8;
  if (remainder === 0) return true;
  const mask = 0xff << (8 - remainder);
  return ((bytes[whole] ?? 0) & mask) === ((expected[whole] ?? 0) & mask);
}

function ipv6Public(value) {
  const bytes = ipv6Bytes(value);
  if (bytes === undefined) return false;
  if (prefix(bytes, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff], 96)) return false;
  if (!prefix(bytes, [0x20], 3)) return false;
  if (prefix(bytes, [0x20, 0x01, 0, 0], 23)) return false;
  if (prefix(bytes, [0x20, 0x01, 0x0d, 0xb8], 32)) return false;
  if (prefix(bytes, [0x20, 0x02], 16)) return false;
  if (prefix(bytes, [0x26, 0x20, 0x00, 0x4f, 0x80, 0], 48)) return false;
  if (prefix(bytes, [0x3f, 0xff], 20)) return false;
  return true;
}

export function selectPublicAddress(addresses) {
  if (!Array.isArray(addresses) || addresses.length < 1 || addresses.length > 32)
    fail("dns-failure", "official source DNS returned an invalid address count");
  const normalized = [];
  for (const entry of addresses) {
    if (
      entry === null ||
      typeof entry !== "object" ||
      (entry.family !== 4 && entry.family !== 6) ||
      typeof entry.address !== "string" ||
      entry.address.length > 64
    )
      fail("dns-failure", "official source DNS returned malformed address data");
    if (entry.family === 4 ? !ipv4Public(entry.address) : !ipv6Public(entry.address))
      fail("unsafe-address", "official source DNS returned a non-public address");
    normalized.push({ address: entry.address, family: entry.family });
  }
  normalized.sort(
    (left, right) => left.family - right.family || left.address.localeCompare(right.address),
  );
  return normalized[0];
}

function mediaType(value) {
  if (typeof value !== "string") return undefined;
  return value.split(";", 1)[0].trim().toLowerCase();
}

export function validateResponseHeaders(rawHeaders, statusCode, source) {
  if (statusCode !== 200) fail("protocol-failure", "official source returned a non-success status");
  if (
    !Array.isArray(rawHeaders) ||
    rawHeaders.length % 2 !== 0 ||
    rawHeaders.length / 2 > MAX_UPSTREAM_HEADERS
  )
    fail("resource-limit", "official source response header count exceeded its limit");
  const headers = new Map();
  const singletonHeaders = new Set([
    "content-encoding",
    "content-length",
    "content-type",
    "location",
    "transfer-encoding",
  ]);
  let bytes = 0;
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index];
    const value = rawHeaders[index + 1];
    if (
      typeof name !== "string" ||
      typeof value !== "string" ||
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name) ||
      /[\0\r\n]/u.test(value)
    )
      fail("protocol-failure", "official source returned malformed headers");
    bytes += Buffer.byteLength(name) + Buffer.byteLength(value) + 4;
    if (bytes > MAX_UPSTREAM_HEADER_BYTES)
      fail("resource-limit", "official source headers exceeded their byte limit");
    const normalized = name.toLowerCase();
    if (headers.has(normalized) && singletonHeaders.has(normalized))
      fail("protocol-failure", "official source returned duplicate headers");
    if (!headers.has(normalized)) headers.set(normalized, value.trim());
  }
  const encoding = headers.get("content-encoding");
  if (encoding !== undefined && encoding.toLowerCase() !== "identity")
    fail("protocol-failure", "compressed official source responses are unsupported");
  const transfer = headers.get("transfer-encoding");
  if (transfer !== undefined && transfer.toLowerCase() !== "chunked")
    fail("protocol-failure", "official source transfer encoding is unsupported");
  const type = mediaType(headers.get("content-type"));
  const allowed =
    source.format === "html" ? new Set(["text/html"]) : new Set(["text/markdown", "text/plain"]);
  if (!allowed.has(type)) fail("protocol-failure", "official source content type is unsupported");
  const lengthText = headers.get("content-length");
  if (lengthText !== undefined) {
    if (!/^(?:0|[1-9]\d*)$/u.test(lengthText))
      fail("protocol-failure", "official source content length is invalid");
    const length = Number(lengthText);
    if (!Number.isSafeInteger(length) || length < 1 || length > MAX_UPSTREAM_SOURCE_BYTES)
      fail("resource-limit", "official source declared length exceeds its limit");
  }
  return {
    declaredLength: lengthText === undefined ? undefined : Number(lengthText),
    mediaType: source.format === "html" ? "text/html" : "text/markdown",
  };
}

async function resolvePublic(hostname, signal) {
  const resolver = new Resolver();
  let timer;
  const abort = () => resolver.cancel();
  signal.addEventListener("abort", abort, { once: true });
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        resolver.cancel();
        reject(new UpstreamSnapshotError("timeout", "official source DNS timed out"));
      }, UPSTREAM_DNS_TIMEOUT_MS);
    });
    const lookup = Promise.allSettled([
      resolver.resolve4(hostname),
      resolver.resolve6(hostname),
    ]).then((results) => {
      if (signal.aborted) fail("cancelled", "official source fetch was cancelled");
      const addresses = [];
      for (const [index, result] of results.entries()) {
        if (result.status === "fulfilled")
          for (const address of result.value)
            addresses.push({ address, family: index === 0 ? 4 : 6 });
      }
      return selectPublicAddress(addresses);
    });
    return await Promise.race([lookup, timeout]);
  } catch (error) {
    if (signal.aborted) fail("cancelled", "official source fetch was cancelled");
    if (error instanceof UpstreamSnapshotError) throw error;
    fail("dns-failure", "official source DNS failed closed");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

async function requestPinned(source, address, signal) {
  if (signal.aborted) fail("cancelled", "official source fetch was cancelled");
  const url = new URL(source.url);
  return new Promise((resolve, reject) => {
    let settled = false;
    let chunks = 0;
    let bytes = 0;
    const body = [];
    const complete = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (error === undefined) resolve(value);
      else reject(error);
    };
    const request = httpsRequest(
      {
        autoSelectFamily: false,
        headers: {
          accept: source.format === "html" ? "text/html" : "text/markdown, text/plain;q=0.9",
          "accept-encoding": "identity",
          connection: "close",
          "user-agent": "svetovid-standards-snapshotter/1.0",
        },
        hostname: url.hostname,
        insecureHTTPParser: false,
        joinDuplicateHeaders: false,
        lookup: (_hostname, options, callback) => {
          if (typeof options === "object" && options !== null && options.all === true)
            callback(null, [address]);
          else callback(null, address.address, address.family);
        },
        maxHeaderSize: MAX_UPSTREAM_HEADER_BYTES,
        method: "GET",
        minVersion: "TLSv1.2",
        path: url.pathname,
        port: 443,
        rejectUnauthorized: true,
        servername: url.hostname,
      },
      (response) => {
        let validated;
        try {
          validated = validateResponseHeaders(response.rawHeaders, response.statusCode, source);
        } catch (error) {
          response.destroy();
          complete(error);
          return;
        }
        response.on("data", (chunk) => {
          chunks += 1;
          bytes += chunk.byteLength;
          if (chunks > MAX_UPSTREAM_BODY_CHUNKS || bytes > MAX_UPSTREAM_SOURCE_BYTES) {
            response.destroy();
            complete(
              new UpstreamSnapshotError(
                "resource-limit",
                "official source response body exceeded its limit",
              ),
            );
            return;
          }
          body.push(Buffer.from(chunk));
        });
        response.once("aborted", () =>
          complete(
            new UpstreamSnapshotError("network-failure", "official source response was truncated"),
          ),
        );
        response.once("error", () =>
          complete(
            new UpstreamSnapshotError("network-failure", "official source response failed closed"),
          ),
        );
        response.once("end", () => {
          if (
            bytes < 1 ||
            (validated.declaredLength !== undefined && validated.declaredLength !== bytes)
          ) {
            complete(
              new UpstreamSnapshotError(
                "network-failure",
                "official source response length did not match",
              ),
            );
            return;
          }
          complete(undefined, { bytes: Buffer.concat(body), mediaType: validated.mediaType });
        });
      },
    );
    const abort = () => {
      request.destroy();
      complete(new UpstreamSnapshotError("cancelled", "official source fetch was cancelled"));
    };
    const timer = setTimeout(() => {
      request.destroy();
      complete(new UpstreamSnapshotError("timeout", "official source request timed out"));
    }, UPSTREAM_REQUEST_TIMEOUT_MS);
    signal.addEventListener("abort", abort, { once: true });
    request.once("error", () =>
      complete(
        new UpstreamSnapshotError("network-failure", "official source request failed closed"),
      ),
    );
    request.end();
  });
}

export function createOfficialSourceTransport() {
  return Object.freeze({
    async fetch(source, { signal }) {
      if (
        source === null ||
        typeof source !== "object" ||
        OFFICIAL_SOURCE_FORMATS.get(source.url) !== source.format
      )
        fail("invalid-catalog", "official source transport rejected a non-allowlisted request");
      if (signal.aborted) fail("cancelled", "official source fetch was cancelled");
      const url = new URL(source.url);
      const address = await resolvePublic(url.hostname, signal);
      return requestPinned(source, address, signal);
    },
  });
}
