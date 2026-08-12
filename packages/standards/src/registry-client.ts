import { Resolver } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { types as nodeTypes } from "node:util";

import type { ClientRequest, IncomingMessage } from "node:http";
import type { RequestOptions as HttpsRequestOptions } from "node:https";

import { MAX_KNOWLEDGE_PACK_BYTES } from "./knowledge-pack.js";
import { MAX_TUF_METADATA_BYTES } from "./tuf-trust.js";

export const STANDARDS_REGISTRY_CONTRACT_VERSION = "0.1.0" as const;
export const MAX_STANDARDS_REGISTRY_HEADERS = 64;
export const MAX_STANDARDS_REGISTRY_HEADER_BYTES = 16_384;
export const MAX_STANDARDS_REGISTRY_CONCURRENT_REQUESTS = 4;
export const STANDARDS_REGISTRY_DNS_TIMEOUT_MS = 2_000;
export const STANDARDS_REGISTRY_CONNECT_TIMEOUT_MS = 3_000;
export const STANDARDS_REGISTRY_TLS_TIMEOUT_MS = 3_000;
export const STANDARDS_REGISTRY_HEADERS_TIMEOUT_MS = 3_000;
export const STANDARDS_REGISTRY_BODY_TIMEOUT_MS = 3_000;
export const STANDARDS_REGISTRY_OVERALL_TIMEOUT_MS = 12_000;
export const STANDARDS_REGISTRY_CLEANUP_TIMEOUT_MS = 1_000;

export type StandardsRegistryMetadataRole =
  "root" | "snapshot" | "standards-preview" | "standards-stable" | "targets" | "timestamp";

export type StandardsRegistryObjectRequest =
  | {
      readonly kind: "metadata";
      readonly role: StandardsRegistryMetadataRole;
      readonly version: number | null;
    }
  | { readonly kind: "pack"; readonly sha256: string };

export type StandardsRegistryIssueCode =
  | "cancelled"
  | "cleanup-failure"
  | "concurrency-limit"
  | "dns-failure"
  | "invalid-input"
  | "network-failure"
  | "not-found"
  | "protocol-failure"
  | "registry-unconfigured"
  | "resource-limit"
  | "timeout"
  | "tls-failure"
  | "unsafe-address";

export interface StandardsRegistryIssue {
  readonly code: StandardsRegistryIssueCode;
  readonly message: string;
  readonly path: string;
}

export type StandardsRegistryResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly issues: readonly StandardsRegistryIssue[]; readonly ok: false };

export interface StandardsRegistryProvenance {
  readonly addressFamily: 4 | 6;
  readonly contentLength: number;
  readonly contractVersion: typeof STANDARDS_REGISTRY_CONTRACT_VERSION;
  readonly mediaType: "application/json";
  readonly method: "GET";
  readonly origin: `https://${string}`;
  readonly path: string;
}

export interface StandardsRegistryObject {
  readonly bytes: Uint8Array;
  readonly provenance: StandardsRegistryProvenance;
}

export interface StandardsRegistryRequestOptions {
  readonly signal: AbortSignal;
}

interface RegistryAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

interface AbortableOperation<T> {
  readonly result: Promise<T>;
  abort(): Promise<void>;
}

interface RegistryDnsCapability {
  start(hostname: string): AbortableOperation<readonly RegistryAddress[]>;
}

interface RegistryResponse {
  readonly body: AsyncIterable<Uint8Array>;
  readonly rawHeaders: readonly string[];
  readonly statusCode: number;
}

interface RegistryTransportRequest {
  readonly address: RegistryAddress;
  readonly hostname: string;
  readonly maxHeaderBytes: number;
  readonly method: "GET";
  readonly path: string;
  readonly port: 443;
}

interface RegistryTransportOperation {
  readonly connected: Promise<void>;
  readonly response: Promise<RegistryResponse>;
  readonly secured: Promise<void>;
  abort(): Promise<void>;
}

interface RegistryTransportCapability {
  start(request: RegistryTransportRequest): RegistryTransportOperation;
}

interface RegistryCapabilities {
  readonly dns: RegistryDnsCapability;
  readonly transport: RegistryTransportCapability;
}

interface ResolverLike {
  cancel(): void;
  resolve4(hostname: string): Promise<readonly string[]>;
  resolve6(hostname: string): Promise<readonly string[]>;
}

type ResolverFactory = () => ResolverLike;
type HttpsRequestFactory = (
  options: HttpsRequestOptions,
  callback: (response: IncomingMessage) => void,
) => ClientRequest;

interface RegistryOrigin {
  readonly hostname: string;
  readonly origin: `https://${string}`;
}

class RegistryFailure extends Error {
  readonly issue: StandardsRegistryIssue;

  constructor(code: StandardsRegistryIssueCode, path: string, message: string) {
    super(message);
    this.issue = Object.freeze({ code, message, path });
  }
}

const SHA256 = /^[a-f0-9]{64}$/u;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
const INTEGER = /^(?:0|[1-9][0-9]*)$/u;
const ROLES: readonly StandardsRegistryMetadataRole[] = Object.freeze([
  "root",
  "snapshot",
  "standards-preview",
  "standards-stable",
  "targets",
  "timestamp",
]);
let activeRequests = 0;

function fail(code: StandardsRegistryIssueCode, path: string, message: string): never {
  throw new RegistryFailure(code, path, message);
}

function success<T>(value: T): StandardsRegistryResult<T> {
  return Object.freeze({ ok: true, value });
}

function failure<T>(error: unknown): StandardsRegistryResult<T> {
  const issue =
    error instanceof RegistryFailure
      ? error.issue
      : Object.freeze({
          code: "network-failure" as const,
          message: "standards registry operation failed closed",
          path: "$",
        });
  return Object.freeze({ issues: Object.freeze([issue]), ok: false });
}

function ownData(value: unknown, keys: readonly string[]): Map<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    nodeTypes.isProxy(value)
  )
    fail("invalid-input", "$request", "registry request must be a plain data object");
  const prototype = Reflect.getPrototypeOf(value);
  const ownKeys = Reflect.ownKeys(value);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))
  )
    fail("invalid-input", "$request", "registry request fields do not match the closed contract");
  const fields = new Map<string, unknown>();
  for (const key of ownKeys as readonly string[]) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor))
      fail("invalid-input", "$request", "registry request must contain only data properties");
    fields.set(key, descriptor.value as unknown);
  }
  return fields;
}

function requestPath(value: unknown): { maximum: number; path: string } {
  if (value === null || typeof value !== "object" || nodeTypes.isProxy(value))
    fail("invalid-input", "$request", "registry request is invalid");
  const kindDescriptor = Reflect.getOwnPropertyDescriptor(value, "kind");
  if (kindDescriptor === undefined || !("value" in kindDescriptor))
    fail("invalid-input", "$request.kind", "registry request kind is required");
  if (kindDescriptor.value === "pack") {
    const fields = ownData(value, ["kind", "sha256"]);
    const sha256 = fields.get("sha256");
    if (typeof sha256 !== "string" || !SHA256.test(sha256))
      fail("invalid-input", "$request.sha256", "pack digest must be lowercase SHA-256");
    return { maximum: MAX_KNOWLEDGE_PACK_BYTES, path: `/v1/packs/sha256-${sha256}.json` };
  }
  if (kindDescriptor.value !== "metadata")
    fail("invalid-input", "$request.kind", "registry request kind is unsupported");
  const fields = ownData(value, ["kind", "role", "version"]);
  const role = fields.get("role");
  const version = fields.get("version");
  if (typeof role !== "string" || !ROLES.includes(role as StandardsRegistryMetadataRole))
    fail("invalid-input", "$request.role", "metadata role is unsupported");
  if (
    version !== null &&
    (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1)
  )
    fail(
      "invalid-input",
      "$request.version",
      "metadata version must be null or a positive integer",
    );
  if (role === "timestamp" && version !== null)
    fail("invalid-input", "$request.version", "timestamp metadata is never version-prefixed");
  const prefix = version === null ? "" : `${String(version)}.`;
  return { maximum: MAX_TUF_METADATA_BYTES, path: `/v1/metadata/${prefix}${role}.json` };
}

function parseIpv4(value: string): readonly number[] | undefined {
  const parts = value.split(".");
  if (parts.length !== 4) return undefined;
  const numbers: number[] = [];
  for (const part of parts) {
    if (!INTEGER.test(part) || (part.length > 1 && part.startsWith("0"))) return undefined;
    const number = Number(part);
    if (number > 255) return undefined;
    numbers.push(number);
  }
  return numbers;
}

function ipv4Public(value: string): boolean {
  const bytes = parseIpv4(value);
  if (bytes === undefined) return false;
  const [a = 0, b = 0, c = 0] = bytes;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 0 && c === 0) return false;
  if (a === 192 && b === 0 && c === 2) return false;
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

function ipv6Bytes(value: string): Uint8Array | undefined {
  if (value.includes("%") || isIP(value) !== 6) return undefined;
  let selected = value.toLowerCase();
  if (selected.includes(".")) {
    const split = selected.lastIndexOf(":");
    const v4 = parseIpv4(selected.slice(split + 1));
    if (split < 0 || v4 === undefined) return undefined;
    selected = `${selected.slice(0, split)}:${((v4[0] ?? 0) * 256 + (v4[1] ?? 0)).toString(16)}:${((v4[2] ?? 0) * 256 + (v4[3] ?? 0)).toString(16)}`;
  }
  const halves = selected.split("::");
  if (halves.length > 2) return undefined;
  const left = halves[0] === "" ? [] : (halves[0]?.split(":") ?? []);
  const right = halves.length === 1 || halves[1] === "" ? [] : (halves[1]?.split(":") ?? []);
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

function prefix(bytes: Uint8Array, expected: readonly number[], bits: number): boolean {
  const whole = Math.floor(bits / 8);
  for (let index = 0; index < whole; index += 1) if (bytes[index] !== expected[index]) return false;
  const remainder = bits % 8;
  if (remainder === 0) return true;
  const mask = 0xff << (8 - remainder);
  return ((bytes[whole] ?? 0) & mask) === ((expected[whole] ?? 0) & mask);
}

function ipv6Public(value: string): boolean {
  const bytes = ipv6Bytes(value);
  if (bytes === undefined) return false;
  if (prefix(bytes, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff], 96)) {
    return false;
  }
  if (!prefix(bytes, [0x20], 3)) return false;
  if (prefix(bytes, [0x20, 0x01, 0, 0], 23)) return false;
  if (prefix(bytes, [0x20, 0x01, 0x0d, 0xb8], 32)) return false;
  if (prefix(bytes, [0x20, 0x02], 16)) return false;
  if (prefix(bytes, [0x26, 0x20, 0x00, 0x4f, 0x80, 0], 48)) return false;
  if (prefix(bytes, [0x3f, 0xff], 20)) return false;
  return true;
}

function validateAddresses(values: readonly RegistryAddress[]): RegistryAddress {
  if (values.length === 0 || values.length > 32)
    fail("dns-failure", "$dns", "registry DNS returned an invalid address count");
  const validated: RegistryAddress[] = [];
  for (const value of values) {
    if (
      value.address.length > 64 ||
      (value.family === 4 ? !ipv4Public(value.address) : !ipv6Public(value.address))
    )
      fail("unsafe-address", "$dns", "registry DNS returned a non-public or malformed address");
    validated.push({ address: value.address, family: value.family });
  }
  validated.sort((left, right) =>
    left.family === right.family
      ? left.address.localeCompare(right.address)
      : left.family - right.family,
  );
  const selected = validated[0];
  if (selected === undefined) fail("dns-failure", "$dns", "registry DNS returned no address");
  return selected;
}

function validateSelectedAddress(address: RegistryAddress): void {
  if (address.family === 4 ? !ipv4Public(address.address) : !ipv6Public(address.address))
    fail("unsafe-address", "$dns", "selected registry address is no longer valid");
}

function abortFailure(): RegistryFailure {
  return new RegistryFailure("cancelled", "$signal", "standards registry request was cancelled");
}

async function boundedAbort(operation: { abort(): Promise<void> }): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new RegistryFailure("cleanup-failure", "$network", "network cleanup did not settle"));
    }, STANDARDS_REGISTRY_CLEANUP_TIMEOUT_MS);
  });
  try {
    await Promise.race([operation.abort(), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function phase<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal,
  deadline: number,
): Promise<T> {
  if (signal.aborted) throw abortFailure();
  const remaining = deadline - performance.now();
  if (remaining <= 0) fail("timeout", "$network", "standards registry overall timeout expired");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let listener: (() => void) | undefined;
  const boundary = new Promise<never>((_resolve, reject) => {
    const overallWins = remaining <= timeoutMs;
    timer = setTimeout(
      () => {
        reject(
          new RegistryFailure(
            "timeout",
            "$network",
            overallWins
              ? "standards registry overall timeout expired"
              : "standards registry phase timed out",
          ),
        );
      },
      Math.min(timeoutMs, remaining),
    );
    listener = (): void => {
      reject(abortFailure());
    };
    signal.addEventListener("abort", listener, { once: true });
  });
  try {
    return await Promise.race([promise, boundary]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (listener !== undefined) signal.removeEventListener("abort", listener);
  }
}

function validateResponse(response: RegistryResponse, maximum: number): number {
  if (response.statusCode === 404)
    fail("not-found", "$response.status", "registry object was not found");
  if (
    !Number.isSafeInteger(response.statusCode) ||
    response.statusCode < 200 ||
    response.statusCode > 299
  )
    fail("protocol-failure", "$response.status", "registry returned a non-success status");
  if (
    response.rawHeaders.length % 2 !== 0 ||
    response.rawHeaders.length / 2 > MAX_STANDARDS_REGISTRY_HEADERS
  )
    fail(
      "resource-limit",
      "$response.headers",
      "registry response header count exceeded its limit",
    );
  let bytes = 0;
  const headers = new Map<string, string>();
  for (let index = 0; index < response.rawHeaders.length; index += 2) {
    const name = response.rawHeaders[index];
    const value = response.rawHeaders[index + 1];
    if (
      name === undefined ||
      value === undefined ||
      !HEADER_NAME.test(name) ||
      /[\0\r\n]/u.test(value)
    )
      fail("protocol-failure", "$response.headers", "registry returned malformed headers");
    bytes += Buffer.byteLength(name) + Buffer.byteLength(value) + 4;
    if (bytes > MAX_STANDARDS_REGISTRY_HEADER_BYTES)
      fail(
        "resource-limit",
        "$response.headers",
        "registry response headers exceeded their byte limit",
      );
    const normalized = name.toLowerCase();
    if (headers.has(normalized))
      fail("protocol-failure", "$response.headers", "registry returned duplicate headers");
    headers.set(normalized, value.trim());
  }
  if (headers.has("transfer-encoding"))
    fail("protocol-failure", "$response.headers", "registry transfer encoding is unsupported");
  const encoding = headers.get("content-encoding");
  if (encoding !== undefined && encoding.toLowerCase() !== "identity")
    fail("protocol-failure", "$response.headers", "registry content encoding is unsupported");
  const type = headers.get("content-type")?.toLowerCase();
  if (type !== "application/json" && type !== "application/json; charset=utf-8")
    fail("protocol-failure", "$response.headers", "registry content type is unsupported");
  const lengthText = headers.get("content-length");
  if (lengthText === undefined || !INTEGER.test(lengthText))
    fail("protocol-failure", "$response.headers", "registry content length is required");
  const length = Number(lengthText);
  if (!Number.isSafeInteger(length) || length > maximum)
    fail("resource-limit", "$response.body", "registry response body exceeded its byte limit");
  return length;
}

async function readExactBody(
  body: AsyncIterable<Uint8Array>,
  expected: number,
  signal: AbortSignal,
  deadline: number,
): Promise<Uint8Array> {
  const result = new Uint8Array(expected);
  const iterator = body[Symbol.asyncIterator]();
  let offset = 0;
  for (let chunkIndex = 0; chunkIndex <= 1_024; chunkIndex += 1) {
    const item = await phase(iterator.next(), STANDARDS_REGISTRY_BODY_TIMEOUT_MS, signal, deadline);
    if (item.done) {
      if (offset !== expected)
        fail("protocol-failure", "$response.body", "registry response body was truncated");
      return result;
    }
    if (chunkIndex === 1_024)
      fail("resource-limit", "$response.body", "registry response body chunk limit was exceeded");
    if (offset + item.value.byteLength > expected)
      fail("protocol-failure", "$response.body", "registry response body contained extra bytes");
    result.set(item.value, offset);
    offset += item.value.byteLength;
  }
  fail("resource-limit", "$response.body", "registry response body chunk limit was exceeded");
}

class ProductionDnsCapability implements RegistryDnsCapability {
  readonly #createResolver: ResolverFactory;

  constructor(
    createResolver: ResolverFactory = (): ResolverLike =>
      new Resolver({ timeout: STANDARDS_REGISTRY_DNS_TIMEOUT_MS, tries: 1 }),
  ) {
    this.#createResolver = createResolver;
  }

  start(hostname: string): AbortableOperation<readonly RegistryAddress[]> {
    const resolver = this.#createResolver();
    const result = Promise.allSettled([
      resolver.resolve4(hostname),
      resolver.resolve6(hostname),
    ]).then((records): readonly RegistryAddress[] => {
      const addresses: RegistryAddress[] = [];
      const v4 = records[0];
      const v6 = records[1];
      if (v4.status === "fulfilled")
        addresses.push(...v4.value.map((address) => ({ address, family: 4 as const })));
      if (v6.status === "fulfilled")
        addresses.push(...v6.value.map((address) => ({ address, family: 6 as const })));
      if (addresses.length === 0) fail("dns-failure", "$dns", "registry DNS resolution failed");
      return addresses;
    });
    return {
      abort: async (): Promise<void> => {
        resolver.cancel();
        await result.catch(() => undefined);
      },
      result,
    };
  }
}

class ProductionTransportCapability implements RegistryTransportCapability {
  readonly #request: HttpsRequestFactory;

  constructor(
    request: HttpsRequestFactory = (options, callback): ClientRequest =>
      httpsRequest(options, callback),
  ) {
    this.#request = request;
  }

  start(selected: RegistryTransportRequest): RegistryTransportOperation {
    let response: import("node:http").IncomingMessage | undefined;
    let closed = false;
    let resolveClosed: (() => void) | undefined;
    const closedPromise = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    let resolveConnected: (() => void) | undefined;
    let rejectConnected: ((reason: RegistryFailure) => void) | undefined;
    const connected = new Promise<void>((resolve, reject) => {
      resolveConnected = resolve;
      rejectConnected = reject;
    });
    let resolveSecured: (() => void) | undefined;
    let rejectSecured: ((reason: RegistryFailure) => void) | undefined;
    const secured = new Promise<void>((resolve, reject) => {
      resolveSecured = resolve;
      rejectSecured = reject;
    });
    let resolveResponse: ((value: RegistryResponse) => void) | undefined;
    let rejectResponse: ((reason: RegistryFailure) => void) | undefined;
    const responsePromise = new Promise<RegistryResponse>((resolve, reject) => {
      resolveResponse = resolve;
      rejectResponse = reject;
    });
    connected.catch(() => undefined);
    secured.catch(() => undefined);
    responsePromise.catch(() => undefined);
    const request = this.#request(
      {
        agent: false,
        family: selected.address.family,
        headers: {
          Accept: "application/json",
          "Accept-Encoding": "identity",
          Connection: "close",
          Host: selected.hostname,
        },
        hostname: selected.hostname,
        insecureHTTPParser: false,
        joinDuplicateHeaders: false,
        lookup: (_hostname, _options, callback): void => {
          callback(null, selected.address.address, selected.address.family);
        },
        maxHeaderSize: selected.maxHeaderBytes,
        method: selected.method,
        minVersion: "TLSv1.2",
        path: selected.path,
        port: selected.port,
        rejectUnauthorized: true,
        servername: selected.hostname,
      },
      (incoming) => {
        response = incoming;
        resolveResponse?.({
          body: incoming,
          rawHeaders: Object.freeze([...incoming.rawHeaders]),
          statusCode: incoming.statusCode ?? 0,
        });
      },
    );
    request.once("socket", (socket) => {
      socket.once("connect", () => resolveConnected?.());
      socket.once("secureConnect", () => resolveSecured?.());
    });
    request.once("error", () => {
      const error = new RegistryFailure(
        "network-failure",
        "$network",
        "registry connection failed",
      );
      rejectConnected?.(error);
      rejectSecured?.(new RegistryFailure("tls-failure", "$tls", "registry TLS handshake failed"));
      rejectResponse?.(error);
    });
    request.once("close", () => {
      closed = true;
      resolveClosed?.();
    });
    request.end();
    return {
      abort: async (): Promise<void> => {
        response?.destroy();
        request.destroy();
        if (!closed) await closedPromise;
      },
      connected,
      response: responsePromise,
      secured,
    };
  }
}

const PRODUCTION_CAPABILITIES: RegistryCapabilities = Object.freeze({
  dns: new ProductionDnsCapability(),
  transport: new ProductionTransportCapability(),
});

let constructClient: (
  capabilities: RegistryCapabilities,
  origin: RegistryOrigin | undefined,
) => StandardsRegistryClient;

export class StandardsRegistryClient {
  readonly #capabilities: RegistryCapabilities;
  readonly #origin: RegistryOrigin | undefined;

  private constructor(capabilities: RegistryCapabilities, origin: RegistryOrigin | undefined) {
    this.#capabilities = capabilities;
    this.#origin = origin;
    Object.freeze(this);
  }

  static {
    constructClient = (capabilities, origin): StandardsRegistryClient =>
      new StandardsRegistryClient(capabilities, origin);
  }

  static create(): StandardsRegistryClient {
    return new StandardsRegistryClient(PRODUCTION_CAPABILITIES, undefined);
  }

  async fetchObject(
    requestInput: StandardsRegistryObjectRequest,
    options: StandardsRegistryRequestOptions,
  ): Promise<StandardsRegistryResult<StandardsRegistryObject>>;
  async fetchObject(
    requestInput: unknown,
    options: unknown,
  ): Promise<StandardsRegistryResult<StandardsRegistryObject>> {
    let dns: AbortableOperation<readonly RegistryAddress[]> | undefined;
    let transport: RegistryTransportOperation | undefined;
    let acquired = false;
    try {
      const selected = requestPath(requestInput);
      if (
        options === null ||
        typeof options !== "object" ||
        nodeTypes.isProxy(options) ||
        Reflect.getPrototypeOf(options) !== Object.prototype ||
        Reflect.ownKeys(options).length !== 1
      )
        fail("invalid-input", "$options", "registry options require one native AbortSignal");
      const signalDescriptor = Reflect.getOwnPropertyDescriptor(options, "signal");
      if (
        signalDescriptor === undefined ||
        !("value" in signalDescriptor) ||
        signalDescriptor.value === null ||
        typeof signalDescriptor.value !== "object" ||
        nodeTypes.isProxy(signalDescriptor.value) ||
        !(signalDescriptor.value instanceof AbortSignal) ||
        Reflect.getPrototypeOf(signalDescriptor.value) !== AbortSignal.prototype
      )
        fail("invalid-input", "$options.signal", "registry cancellation signal is invalid");
      const signal = signalDescriptor.value;
      const origin = this.#origin;
      if (origin === undefined)
        fail(
          "registry-unconfigured",
          "$registry",
          "no release-owned standards registry is configured",
        );
      if (activeRequests >= MAX_STANDARDS_REGISTRY_CONCURRENT_REQUESTS)
        fail("concurrency-limit", "$network", "registry concurrency limit was reached");
      activeRequests += 1;
      acquired = true;
      const deadline = performance.now() + STANDARDS_REGISTRY_OVERALL_TIMEOUT_MS;
      dns = this.#capabilities.dns.start(origin.hostname);
      let addresses: readonly RegistryAddress[];
      try {
        addresses = await phase(dns.result, STANDARDS_REGISTRY_DNS_TIMEOUT_MS, signal, deadline);
      } catch (error) {
        const activeDns = dns;
        dns = undefined;
        await boundedAbort(activeDns);
        if (error instanceof RegistryFailure) throw error;
        fail("dns-failure", "$dns", "registry DNS resolution failed");
      }
      const resolvedDns = dns;
      dns = undefined;
      await boundedAbort(resolvedDns);
      const address = validateAddresses(addresses);
      validateSelectedAddress(address);
      transport = this.#capabilities.transport.start({
        address,
        hostname: origin.hostname,
        maxHeaderBytes: MAX_STANDARDS_REGISTRY_HEADER_BYTES,
        method: "GET",
        path: selected.path,
        port: 443,
      });
      try {
        await phase(transport.connected, STANDARDS_REGISTRY_CONNECT_TIMEOUT_MS, signal, deadline);
      } catch (error) {
        if (error instanceof RegistryFailure) throw error;
        fail("network-failure", "$network", "registry connection failed");
      }
      try {
        await phase(transport.secured, STANDARDS_REGISTRY_TLS_TIMEOUT_MS, signal, deadline);
      } catch (error) {
        if (error instanceof RegistryFailure) throw error;
        fail("tls-failure", "$tls", "registry TLS handshake failed");
      }
      let response: RegistryResponse;
      try {
        response = await phase(
          transport.response,
          STANDARDS_REGISTRY_HEADERS_TIMEOUT_MS,
          signal,
          deadline,
        );
      } catch (error) {
        if (error instanceof RegistryFailure) throw error;
        fail("network-failure", "$network", "registry response headers failed");
      }
      const length = validateResponse(response, selected.maximum);
      const bytes = await readExactBody(response.body, length, signal, deadline);
      const completedTransport = transport;
      transport = undefined;
      await boundedAbort(completedTransport);
      const provenance: StandardsRegistryProvenance = Object.freeze({
        addressFamily: address.family,
        contentLength: length,
        contractVersion: STANDARDS_REGISTRY_CONTRACT_VERSION,
        mediaType: "application/json",
        method: "GET",
        origin: origin.origin,
        path: selected.path,
      });
      return success(Object.freeze({ bytes, provenance }));
    } catch (error) {
      try {
        if (transport !== undefined) await boundedAbort(transport);
        if (dns !== undefined) await boundedAbort(dns);
      } catch (cleanupError) {
        return failure(cleanupError);
      }
      return failure(error);
    } finally {
      if (acquired) activeRequests -= 1;
    }
  }
}

/** @internal Fake DNS/TLS entry point; not exported from the package root. */
export function createStandardsRegistryClientFixtureForTest(
  capabilities: RegistryCapabilities,
): StandardsRegistryClient {
  return constructClient(
    capabilities,
    Object.freeze({
      hostname: "registry.example.invalid",
      origin: "https://registry.example.invalid",
    }),
  );
}

/** @internal Node adapter injection entry point; not exported from the package root. */
export function createNodeRegistryCapabilitiesFixtureForTest(
  resolver: ResolverFactory,
  request: HttpsRequestFactory,
): RegistryCapabilities {
  return {
    dns: new ProductionDnsCapability(resolver),
    transport: new ProductionTransportCapability(request),
  };
}
