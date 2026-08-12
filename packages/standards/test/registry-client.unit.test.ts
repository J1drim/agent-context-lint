import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

import { describe, expect, test, vi } from "vitest";

import {
  MAX_STANDARDS_REGISTRY_CONCURRENT_REQUESTS,
  MAX_STANDARDS_REGISTRY_HEADER_BYTES,
  MAX_STANDARDS_REGISTRY_HEADERS,
  STANDARDS_REGISTRY_BODY_TIMEOUT_MS,
  STANDARDS_REGISTRY_CLEANUP_TIMEOUT_MS,
  STANDARDS_REGISTRY_CONNECT_TIMEOUT_MS,
  STANDARDS_REGISTRY_CONTRACT_VERSION,
  STANDARDS_REGISTRY_DNS_TIMEOUT_MS,
  STANDARDS_REGISTRY_HEADERS_TIMEOUT_MS,
  STANDARDS_REGISTRY_TLS_TIMEOUT_MS,
  StandardsRegistryClient,
} from "../src/index.js";
import {
  createNodeRegistryCapabilitiesFixtureForTest,
  createStandardsRegistryClientFixtureForTest,
} from "../src/registry-client.js";

import type { ClientRequest, IncomingMessage } from "node:http";
import type { RequestOptions as HttpsRequestOptions } from "node:https";

import type {
  StandardsRegistryIssueCode,
  StandardsRegistryObject,
  StandardsRegistryObjectRequest,
  StandardsRegistryResult,
} from "../src/index.js";

interface Address {
  readonly address: string;
  readonly family: 4 | 6;
}

interface TransportRequest {
  readonly address: Address;
  readonly hostname: string;
  readonly maxHeaderBytes: number;
  readonly method: "GET";
  readonly path: string;
  readonly port: 443;
}

interface FakeResponse {
  readonly body: AsyncIterable<Uint8Array>;
  readonly rawHeaders: readonly string[];
  readonly statusCode: number;
}

interface FakeSetup {
  readonly addresses?: readonly Address[];
  readonly connected?: Promise<void>;
  readonly dns?: Promise<readonly Address[]>;
  readonly dnsAbort?: () => Promise<void>;
  readonly response?: Promise<FakeResponse>;
  readonly secured?: Promise<void>;
  readonly transportAbort?: () => Promise<void>;
}

const BODY = Buffer.from('{"signed":true}', "utf8");
const PUBLIC_V4 = Object.freeze({ address: "93.184.216.34", family: 4 as const });
const JSON_HEADERS = Object.freeze([
  "Content-Type",
  "application/json; charset=utf-8",
  "Content-Length",
  String(BODY.byteLength),
  "Content-Encoding",
  "identity",
]);

function chunks(...values: readonly Uint8Array[]): AsyncIterable<Uint8Array> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
      let index = 0;
      return {
        next(): Promise<IteratorResult<Uint8Array>> {
          const value = values[index];
          index += 1;
          return Promise.resolve(
            value === undefined ? { done: true, value: undefined } : { done: false, value },
          );
        },
      };
    },
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  reject(reason: unknown): void;
  resolve(value: T): void;
} {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((reason: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    reject: (reason): void => {
      rejectPromise?.(reason);
    },
    resolve: (value): void => {
      resolvePromise?.(value);
    },
  };
}

function fake(setup: FakeSetup = {}): {
  readonly client: StandardsRegistryClient;
  readonly dnsAbort: ReturnType<typeof vi.fn>;
  readonly dnsHosts: string[];
  readonly requests: TransportRequest[];
  readonly transportAbort: ReturnType<typeof vi.fn>;
} {
  const dnsAbort = vi.fn(setup.dnsAbort ?? ((): Promise<void> => Promise.resolve()));
  const transportAbort = vi.fn(setup.transportAbort ?? ((): Promise<void> => Promise.resolve()));
  const dnsHosts: string[] = [];
  const requests: TransportRequest[] = [];
  const response =
    setup.response ??
    Promise.resolve({ body: chunks(BODY), rawHeaders: JSON_HEADERS, statusCode: 200 });
  const client = createStandardsRegistryClientFixtureForTest({
    dns: {
      start(hostname) {
        dnsHosts.push(hostname);
        return {
          abort: dnsAbort,
          result: setup.dns ?? Promise.resolve(setup.addresses ?? [PUBLIC_V4]),
        };
      },
    },
    transport: {
      start(request) {
        requests.push(request);
        return {
          abort: transportAbort,
          connected: setup.connected ?? Promise.resolve(),
          response,
          secured: setup.secured ?? Promise.resolve(),
        };
      },
    },
  });
  return { client, dnsAbort, dnsHosts, requests, transportAbort };
}

function options(signal: AbortSignal = new AbortController().signal): { signal: AbortSignal } {
  return { signal };
}

function metadata(): { kind: "metadata"; role: "root"; version: null } {
  return { kind: "metadata", role: "root", version: null };
}

function expectIssue(
  result: StandardsRegistryResult<StandardsRegistryObject>,
  code: StandardsRegistryIssueCode,
): void {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected registry failure");
  expect(result.issues).toEqual([expect.objectContaining({ code })]);
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.issues)).toBe(true);
  expect(Object.isFrozen(result.issues[0])).toBe(true);
}

describe("H07 explicit standards registry client", () => {
  test("fetches an allowlisted metadata resource as inert bytes over the pinned contract", async () => {
    vi.stubEnv("HTTP_PROXY", "http://user:password@127.0.0.1:8888");
    vi.stubEnv("HTTPS_PROXY", "http://user:password@127.0.0.1:8888");
    const selected = fake();
    const result = await selected.client.fetchObject(metadata(), options());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect([...result.value.bytes]).toEqual([...BODY]);
    expect(result.value.provenance).toEqual({
      addressFamily: 4,
      contentLength: BODY.byteLength,
      contractVersion: STANDARDS_REGISTRY_CONTRACT_VERSION,
      mediaType: "application/json",
      method: "GET",
      origin: "https://registry.example.invalid",
      path: "/v1/metadata/root.json",
    });
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(result.value.provenance)).toBe(true);
    expect(selected.dnsHosts).toEqual(["registry.example.invalid"]);
    expect(selected.requests).toEqual([
      {
        address: PUBLIC_V4,
        hostname: "registry.example.invalid",
        maxHeaderBytes: MAX_STANDARDS_REGISTRY_HEADER_BYTES,
        method: "GET",
        path: "/v1/metadata/root.json",
        port: 443,
      },
    ]);
    expect(JSON.stringify(selected.requests)).not.toMatch(/proxy|password|authorization|cookie/iu);
    expect(selected.dnsAbort).toHaveBeenCalledOnce();
    expect(selected.transportAbort).toHaveBeenCalledOnce();
    vi.unstubAllEnvs();
  });

  test("uses deterministic paths for versioned roles and content-addressed packs", async () => {
    const digest = "a".repeat(64);
    const root = fake();
    expect(
      (await root.client.fetchObject({ kind: "metadata", role: "root", version: 42 }, options()))
        .ok,
    ).toBe(true);
    expect(root.requests[0]?.path).toBe("/v1/metadata/42.root.json");
    const pack = fake();
    expect((await pack.client.fetchObject({ kind: "pack", sha256: digest }, options())).ok).toBe(
      true,
    );
    expect(pack.requests[0]?.path).toBe(`/v1/packs/sha256-${digest}.json`);
  });

  test("accepts a globally routable IPv6 address without exposing it in provenance", async () => {
    const selected = fake({
      addresses: [{ address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 }],
    });
    const result = await selected.client.fetchObject(metadata(), options());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.value.provenance.addressFamily).toBe(6);
    expect(result.value.provenance).not.toHaveProperty("address");
  });

  test("the production factory is default-deny until a release registry is configured", async () => {
    const result = await StandardsRegistryClient.create().fetchObject(metadata(), options());
    expectIssue(result, "registry-unconfigured");
  });

  test.each([
    null,
    {},
    { kind: "other" },
    { extra: true, kind: "pack", sha256: "a".repeat(64) },
    { kind: "pack", sha256: "A".repeat(64) },
    { kind: "pack", sha256: "../root" },
    { kind: "metadata", role: "unknown", version: null },
    { kind: "metadata", role: "root", version: 0 },
    { kind: "metadata", role: "timestamp", version: 1 },
  ])("rejects malformed and path-injection input without DNS: %j", async (request) => {
    const selected = fake();
    const result = await selected.client.fetchObject(
      request as StandardsRegistryObjectRequest,
      options(),
    );
    expectIssue(result, "invalid-input");
    expect(selected.dnsHosts).toEqual([]);
  });

  test.each([
    ["0.0.0.0", 4],
    ["10.0.0.1", 4],
    ["100.64.0.1", 4],
    ["127.0.0.1", 4],
    ["169.254.1.1", 4],
    ["172.16.0.1", 4],
    ["192.0.0.1", 4],
    ["192.0.2.1", 4],
    ["192.168.0.1", 4],
    ["198.18.0.1", 4],
    ["198.51.100.1", 4],
    ["203.0.113.1", 4],
    ["224.0.0.1", 4],
    ["240.0.0.1", 4],
    ["0177.0.0.1", 4],
    ["2130706433", 4],
    ["::", 6],
    ["::1", 6],
    ["::ffff:93.184.216.34", 6],
    ["64:ff9b::1", 6],
    ["100::1", 6],
    ["2001::1", 6],
    ["2001:db8::1", 6],
    ["2002::1", 6],
    ["3fff::1", 6],
    ["fc00::1", 6],
    ["fe80::1", 6],
    ["ff02::1", 6],
    ["fe80::1%lo0", 6],
  ] as const)(
    "rejects reserved, local, mapped, or alternate address %s",
    async (address, family) => {
      const selected = fake({ addresses: [{ address, family }] });
      expectIssue(await selected.client.fetchObject(metadata(), options()), "unsafe-address");
      expect(selected.requests).toEqual([]);
    },
  );

  test("rejects the complete DNS answer when one address is unsafe", async () => {
    const selected = fake({ addresses: [PUBLIC_V4, { address: "127.0.0.1", family: 4 }] });
    expectIssue(await selected.client.fetchObject(metadata(), options()), "unsafe-address");
    expect(selected.requests).toEqual([]);
  });

  test("rejects empty or excessive DNS answer sets", async () => {
    for (const addresses of [[], Array.from({ length: 33 }, () => PUBLIC_V4)]) {
      const selected = fake({ addresses });
      expectIssue(await selected.client.fetchObject(metadata(), options()), "dns-failure");
      expect(selected.requests).toEqual([]);
    }
  });

  test("revalidates a selected address and catches mutation/rebinding", async () => {
    let reads = 0;
    const changing = Object.create(null) as { address: string; family: 4 };
    Object.defineProperties(changing, {
      address: {
        enumerable: true,
        get: () => (++reads < 3 ? "93.184.216.34" : "127.0.0.1"),
      },
      family: { enumerable: true, value: 4 },
    });
    const selected = fake({ addresses: [changing] });
    expectIssue(await selected.client.fetchObject(metadata(), options()), "unsafe-address");
    expect(selected.requests).toEqual([]);
  });

  test.each([201, 204, 299])(
    "accepts all otherwise valid 2xx statuses (%i)",
    async (statusCode) => {
      const selected = fake({
        response: Promise.resolve({ body: chunks(BODY), rawHeaders: JSON_HEADERS, statusCode }),
      });
      expect((await selected.client.fetchObject(metadata(), options())).ok).toBe(true);
    },
  );

  test.each([300, 301, 302, 307, 308, 400, 401, 500])(
    "rejects redirects and non-success status %i without reflecting server data",
    async (statusCode) => {
      const selected = fake({
        response: Promise.resolve({
          body: chunks(Buffer.from("secret remote failure")),
          rawHeaders: [...JSON_HEADERS, "Location", "https://127.0.0.1/private"],
          statusCode,
        }),
      });
      const result = await selected.client.fetchObject(metadata(), options());
      expectIssue(result, "protocol-failure");
      expect(JSON.stringify(result)).not.toMatch(/secret|127\.0\.0\.1/iu);
    },
  );

  test("classifies a missing object without reflecting remote response data", async () => {
    const selected = fake({
      response: Promise.resolve({
        body: chunks(Buffer.from("secret missing-object detail")),
        rawHeaders: JSON_HEADERS,
        statusCode: 404,
      }),
    });
    const result = await selected.client.fetchObject(metadata(), options());
    expectIssue(result, "not-found");
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  test.each([
    [["Content-Length", String(BODY.byteLength)], "protocol-failure"],
    [["Content-Type", "text/plain", "Content-Length", String(BODY.byteLength)], "protocol-failure"],
    [[...JSON_HEADERS, "Content-Encoding", "gzip"], "protocol-failure"],
    [[...JSON_HEADERS, "Transfer-Encoding", "chunked"], "protocol-failure"],
    [[...JSON_HEADERS, "Content-Length", String(BODY.byteLength)], "protocol-failure"],
    [["Bad\r\nName", "x", ...JSON_HEADERS], "protocol-failure"],
    [["X-Test", "bad\nvalue", ...JSON_HEADERS], "protocol-failure"],
  ] as const)("rejects malformed response headers %#", async (rawHeaders, code) => {
    const selected = fake({
      response: Promise.resolve({ body: chunks(BODY), rawHeaders, statusCode: 200 }),
    });
    expectIssue(await selected.client.fetchObject(metadata(), options()), code);
  });

  test("bounds response header count and bytes", async () => {
    const count = Array.from({ length: MAX_STANDARDS_REGISTRY_HEADERS + 1 }, (_, index) => [
      `X-${String(index)}`,
      "x",
    ]).flat();
    const tooMany = fake({
      response: Promise.resolve({ body: chunks(BODY), rawHeaders: count, statusCode: 200 }),
    });
    expectIssue(await tooMany.client.fetchObject(metadata(), options()), "resource-limit");
    const tooLarge = fake({
      response: Promise.resolve({
        body: chunks(BODY),
        rawHeaders: ["X-Large", "x".repeat(MAX_STANDARDS_REGISTRY_HEADER_BYTES), ...JSON_HEADERS],
        statusCode: 200,
      }),
    });
    expectIssue(await tooLarge.client.fetchObject(metadata(), options()), "resource-limit");
  });

  test("rejects truncated and extra response bodies", async () => {
    const truncated = fake({
      response: Promise.resolve({
        body: chunks(BODY.subarray(0, BODY.byteLength - 1)),
        rawHeaders: JSON_HEADERS,
        statusCode: 200,
      }),
    });
    expectIssue(await truncated.client.fetchObject(metadata(), options()), "protocol-failure");
    const extra = fake({
      response: Promise.resolve({
        body: chunks(BODY, Uint8Array.of(0)),
        rawHeaders: JSON_HEADERS,
        statusCode: 200,
      }),
    });
    expectIssue(await extra.client.fetchObject(metadata(), options()), "protocol-failure");
  });

  test("bounds a zero-byte response chunk flood", async () => {
    const selected = fake({
      response: Promise.resolve({
        body: chunks(...Array.from({ length: 1_025 }, () => new Uint8Array())),
        rawHeaders: ["Content-Type", "application/json", "Content-Length", "0"],
        statusCode: 200,
      }),
    });
    expectIssue(await selected.client.fetchObject(metadata(), options()), "resource-limit");
  });

  test("rejects declared bodies over the role limit before consuming them", async () => {
    const selected = fake({
      response: Promise.resolve({
        body: chunks(),
        rawHeaders: ["Content-Type", "application/json", "Content-Length", "524289"],
        statusCode: 200,
      }),
    });
    expectIssue(await selected.client.fetchObject(metadata(), options()), "resource-limit");
  });

  test.each([
    ["dns", STANDARDS_REGISTRY_DNS_TIMEOUT_MS],
    ["connect", STANDARDS_REGISTRY_CONNECT_TIMEOUT_MS],
    ["tls", STANDARDS_REGISTRY_TLS_TIMEOUT_MS],
    ["headers", STANDARDS_REGISTRY_HEADERS_TIMEOUT_MS],
    ["body", STANDARDS_REGISTRY_BODY_TIMEOUT_MS],
  ] as const)("times out a nonsettling %s phase and confirms cleanup", async (phase, duration) => {
    vi.useFakeTimers();
    const never = new Promise<never>(() => undefined);
    const setup: FakeSetup =
      phase === "dns"
        ? { dns: never }
        : phase === "connect"
          ? { connected: never }
          : phase === "tls"
            ? { secured: never }
            : phase === "headers"
              ? { response: never }
              : {
                  response: Promise.resolve({
                    body: { [Symbol.asyncIterator]: () => ({ next: () => never }) },
                    rawHeaders: JSON_HEADERS,
                    statusCode: 200,
                  }),
                };
    const selected = fake(setup);
    const resultPromise = selected.client.fetchObject(metadata(), options());
    await vi.advanceTimersByTimeAsync(duration + 1);
    const result = await resultPromise;
    expectIssue(result, "timeout");
    expect(phase === "dns" ? selected.dnsAbort : selected.transportAbort).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  test("enforces the overall deadline across individually timely phases", async () => {
    vi.useFakeTimers();
    const after = <T>(milliseconds: number, value: T): Promise<T> =>
      new Promise((resolve) =>
        setTimeout(() => {
          resolve(value);
        }, milliseconds),
      );
    const selected = fake({
      connected: after(4_500, undefined),
      dns: after(1_900, [PUBLIC_V4]),
      response: after(9_500, {
        body: {
          [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
            return { next: (): Promise<never> => new Promise<never>(() => undefined) };
          },
        },
        rawHeaders: JSON_HEADERS,
        statusCode: 200,
      }),
      secured: after(7_000, undefined),
    });
    const resultPromise = selected.client.fetchObject(metadata(), options());
    await vi.advanceTimersByTimeAsync(12_001);
    const result = await resultPromise;
    expectIssue(result, "timeout");
    if (!result.ok) expect(result.issues[0]?.message).toContain("overall");
    expect(selected.transportAbort).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  test("cancels an in-flight request and confirms cleanup", async () => {
    const controller = new AbortController();
    const selected = fake({ connected: new Promise<never>(() => undefined) });
    const resultPromise = selected.client.fetchObject(metadata(), options(controller.signal));
    await vi.waitFor(() => {
      expect(selected.requests).toHaveLength(1);
    });
    controller.abort(new Error("private cancellation reason"));
    const result = await resultPromise;
    expectIssue(result, "cancelled");
    expect(JSON.stringify(result)).not.toContain("private cancellation reason");
    expect(selected.transportAbort).toHaveBeenCalledOnce();
  });

  test("classifies TLS rejection without reflecting the transport error", async () => {
    const selected = fake({ secured: Promise.reject(new Error("certificate internal detail")) });
    const result = await selected.client.fetchObject(metadata(), options());
    expectIssue(result, "tls-failure");
    expect(JSON.stringify(result)).not.toContain("certificate internal detail");
  });

  test("bounds process-wide concurrent requests and releases every permit", async () => {
    const gate = deferred<undefined>();
    const running = Array.from({ length: MAX_STANDARDS_REGISTRY_CONCURRENT_REQUESTS }, () =>
      fake({ connected: gate.promise }),
    );
    const requests = running.map((selected) => selected.client.fetchObject(metadata(), options()));
    await vi.waitFor(() => {
      expect(running.every((selected) => selected.requests.length === 1)).toBe(true);
    });
    const rejected = await fake().client.fetchObject(metadata(), options());
    expectIssue(rejected, "concurrency-limit");
    gate.resolve(undefined);
    for (const result of await Promise.all(requests)) expect(result.ok).toBe(true);
    expect((await fake().client.fetchObject(metadata(), options())).ok).toBe(true);
  });

  test("fails closed when abort cleanup itself does not settle", async () => {
    vi.useFakeTimers();
    const selected = fake({
      connected: Promise.reject(new Error("connect")),
      transportAbort: () => new Promise<never>(() => undefined),
    });
    const resultPromise = selected.client.fetchObject(metadata(), options());
    await vi.advanceTimersByTimeAsync(STANDARDS_REGISTRY_CLEANUP_TIMEOUT_MS + 1);
    expectIssue(await resultPromise, "cleanup-failure");
    vi.useRealTimers();
  });

  test("the Node adapters pin resolved bytes while preserving strict TLS hostname settings", async () => {
    const cancel = vi.fn();
    let capturedOptions: HttpsRequestOptions | undefined;
    let responseCallback: ((response: IncomingMessage) => void) | undefined;
    const request = new EventEmitter() as EventEmitter & {
      destroy(): void;
      end(): void;
    };
    request.destroy = (): void => {
      request.emit("close");
    };
    request.end = (): void => {
      const socket = new EventEmitter();
      request.emit("socket", socket);
      socket.emit("connect");
      socket.emit("secureConnect");
      const incoming = Readable.from([BODY]) as IncomingMessage;
      Object.defineProperties(incoming, {
        rawHeaders: { value: [...JSON_HEADERS] },
        statusCode: { value: 200 },
      });
      responseCallback?.(incoming);
    };
    const capabilities = createNodeRegistryCapabilitiesFixtureForTest(
      () => ({
        cancel,
        resolve4: (): Promise<readonly string[]> => Promise.resolve([PUBLIC_V4.address]),
        resolve6: (): Promise<readonly string[]> =>
          Promise.resolve(["2606:2800:220:1:248:1893:25c8:1946"]),
      }),
      (requestOptions, callback): ClientRequest => {
        capturedOptions = requestOptions;
        responseCallback = callback;
        return request as unknown as ClientRequest;
      },
    );
    const client = createStandardsRegistryClientFixtureForTest(capabilities);
    const result = await client.fetchObject(metadata(), options());
    expect(result.ok).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
    expect(capturedOptions).toEqual(
      expect.objectContaining({
        agent: false,
        family: 4,
        hostname: "registry.example.invalid",
        insecureHTTPParser: false,
        maxHeaderSize: MAX_STANDARDS_REGISTRY_HEADER_BYTES,
        method: "GET",
        minVersion: "TLSv1.2",
        path: "/v1/metadata/root.json",
        port: 443,
        rejectUnauthorized: true,
        servername: "registry.example.invalid",
      }),
    );
    expect(capturedOptions?.headers).toEqual({
      Accept: "application/json",
      "Accept-Encoding": "identity",
      Connection: "close",
      Host: "registry.example.invalid",
    });
    const lookup = capturedOptions?.lookup;
    expect(typeof lookup).toBe("function");
    const lookupResult = deferred<{ address: string; family: number }>();
    if (typeof lookup === "function")
      lookup("ignored", {}, (error, address, family) => {
        if (error !== null) lookupResult.reject(error);
        else if (typeof address === "string")
          lookupResult.resolve({ address, family: family ?? 0 });
      });
    expect(await lookupResult.promise).toEqual(PUBLIC_V4);
  });

  test("the Node DNS adapter sanitizes total resolver failure", async () => {
    const cancel = vi.fn();
    const capabilities = createNodeRegistryCapabilitiesFixtureForTest(
      () => ({
        cancel,
        resolve4: (): Promise<readonly string[]> => Promise.reject(new Error("resolver v4 detail")),
        resolve6: (): Promise<readonly string[]> => Promise.reject(new Error("resolver v6 detail")),
      }),
      (): ClientRequest => {
        throw new Error("transport must not start");
      },
    );
    const result = await createStandardsRegistryClientFixtureForTest(capabilities).fetchObject(
      metadata(),
      options(),
    );
    expectIssue(result, "dns-failure");
    expect(JSON.stringify(result)).not.toContain("resolver");
    expect(cancel).toHaveBeenCalledOnce();
  });

  test("the Node transport adapter closes and sanitizes a failed TLS handshake", async () => {
    const request = new EventEmitter() as EventEmitter & {
      destroy(): void;
      end(): void;
    };
    request.destroy = (): void => {
      request.emit("close");
    };
    request.end = (): void => {
      const socket = new EventEmitter();
      request.emit("socket", socket);
      socket.emit("connect");
      request.emit("error", new Error("private certificate detail"));
    };
    const capabilities = createNodeRegistryCapabilitiesFixtureForTest(
      () => ({
        cancel: (): void => undefined,
        resolve4: (): Promise<readonly string[]> => Promise.resolve([PUBLIC_V4.address]),
        resolve6: (): Promise<readonly string[]> => Promise.reject(new Error("no v6")),
      }),
      (): ClientRequest => request as unknown as ClientRequest,
    );
    const result = await createStandardsRegistryClientFixtureForTest(capabilities).fetchObject(
      metadata(),
      options(),
    );
    expectIssue(result, "tls-failure");
    expect(JSON.stringify(result)).not.toContain("certificate");
  });
});
