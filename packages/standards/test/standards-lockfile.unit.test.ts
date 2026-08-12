import { readFileSync } from "node:fs";

import type { AnySchema } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, test, vi } from "vitest";

import {
  DEFAULT_STANDARDS_LOCKFILE_PATH,
  MAX_STANDARDS_LOCKFILE_BYTES,
  parseCanonicalStandardsLockfile,
  serializeStandardsLockfile,
  updateStandardsLockfile,
  validateStandardsLockfile,
} from "../src/index.js";
import type {
  StandardsLockfileAtomicWriteResult,
  StandardsLockfileIssueCode,
  StandardsLockfileValidationResult,
} from "../src/index.js";

const SCHEMA = new URL("../schemas/standards-lockfile.v1.schema.json", import.meta.url);
const PACKAGE_JSON = new URL("../package.json", import.meta.url);
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function summary(role: string, hash = HASH_A): Record<string, unknown> {
  return {
    expires: "2026-08-02T00:00:00Z",
    issuedAt: "2026-07-31T00:00:00Z",
    role,
    sha256: hash,
    version: 1,
  };
}

function lockfile(channel: "preview" | "stable" = "stable"): Record<string, unknown> {
  return {
    channel,
    pack: {
      packId: "agent-context-bundled",
      packVersion: "2026.8.0",
      publishedAt: "2026-08-01",
      schemaVersion: "0.1.0",
    },
    recordKind: "agent-context-standards-lock",
    schemaVersion: "1.0.0",
    target: {
      channel,
      length: 4096,
      minEngineVersion: "0.0.0",
      packId: "agent-context-bundled",
      packVersion: "2026.8.0",
      schemaVersion: "0.1.0",
      sha256: HASH_B,
      targetPath: `knowledge/${channel}/agent-context-bundled-2026.8.0.json`,
    },
    trustedState: {
      contractVersion: "0.1.0",
      delegated: {
        preview: channel === "preview" ? summary("standards-preview", HASH_B) : null,
        stable: channel === "stable" ? summary("standards-stable", HASH_B) : null,
      },
      repositoryId: "agent-context-standards",
      root: summary("root"),
      snapshot: summary("snapshot"),
      targets: summary("targets"),
      timestamp: summary("timestamp"),
    },
    verificationTime: "2026-08-01T12:00:00Z",
  };
}

function expectInvalid(
  result: StandardsLockfileValidationResult,
  code?: StandardsLockfileIssueCode,
): void {
  expect(result.ok).toBe(false);
  if (!result.ok && code !== undefined)
    expect(result.issues.map((entry) => entry.code)).toContain(code);
}

function successfulWrite(): StandardsLockfileAtomicWriteResult {
  return Object.freeze({
    bytesWritten: 1,
    contractVersion: "0.1.0",
    directorySync: "synced",
    durability: "file-and-directory",
    identity: Object.freeze({ device: "1", inode: "2" }),
    mode: 0o644,
    path: DEFAULT_STANDARDS_LOCKFILE_PATH,
    previousSha256: HASH_A,
    sha256: HASH_B,
  });
}

describe("standards lockfile contract", () => {
  test.each(["stable", "preview"] as const)("round-trips a canonical %s lock", (channel) => {
    const serialized = serializeStandardsLockfile(lockfile(channel));
    expect(serialized.ok).toBe(true);
    if (!serialized.ok) return;
    expect(serialized.text.endsWith("\n")).toBe(false);
    expect(serialized.text.startsWith('{"channel"')).toBe(true);
    const parsed = parseCanonicalStandardsLockfile(Buffer.from(serialized.text));
    expect(parsed).toMatchObject({ canonicalJson: serialized.text, ok: true });
    if (parsed.ok) {
      expect(Object.isFrozen(parsed.value)).toBe(true);
      expect(Object.isFrozen(parsed.value.target)).toBe(true);
      expect(Object.isFrozen(parsed.value.trustedState.delegated)).toBe(true);
    }
  });

  test("is deterministic and validates against the published schema", () => {
    const first = serializeStandardsLockfile(lockfile());
    const second = serializeStandardsLockfile(structuredClone(lockfile()));
    expect(first).toEqual(second);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const schema = JSON.parse(readFileSync(SCHEMA, "utf8")) as AnySchema;
    const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
    expect(validate(JSON.parse(first.text))).toBe(true);
  });

  test.each([
    [
      "wrong record kind",
      (value: Record<string, unknown>): void => {
        value["recordKind"] = "knowledge";
      },
    ],
    [
      "future contract",
      (value: Record<string, unknown>): void => {
        value["schemaVersion"] = "2.0.0";
      },
    ],
    [
      "unknown field",
      (value: Record<string, unknown>): void => {
        value["command"] = "run";
      },
    ],
    [
      "channel mismatch",
      (value: Record<string, unknown>): void => {
        (value["target"] as Record<string, unknown>)["channel"] = "preview";
      },
    ],
    [
      "pack mismatch",
      (value: Record<string, unknown>): void => {
        (value["target"] as Record<string, unknown>)["packVersion"] = "2026.9.0";
      },
    ],
    [
      "wrong role",
      (value: Record<string, unknown>): void => {
        ((value["trustedState"] as Record<string, unknown>)["root"] as Record<string, unknown>)[
          "role"
        ] = "targets";
      },
    ],
    [
      "expired authority",
      (value: Record<string, unknown>): void => {
        (
          (value["trustedState"] as Record<string, unknown>)["timestamp"] as Record<string, unknown>
        )["expires"] = "2026-08-01T11:00:00Z";
      },
    ],
    [
      "missing selected delegation",
      (value: Record<string, unknown>): void => {
        (
          (value["trustedState"] as Record<string, unknown>)["delegated"] as Record<string, unknown>
        )["stable"] = null;
      },
    ],
    [
      "wrong target path",
      (value: Record<string, unknown>): void => {
        (value["target"] as Record<string, unknown>)["targetPath"] = "knowledge/preview/pack.json";
      },
    ],
    [
      "future publication",
      (value: Record<string, unknown>): void => {
        (value["pack"] as Record<string, unknown>)["publishedAt"] = "2026-08-02";
      },
    ],
    [
      "invalid calendar date",
      (value: Record<string, unknown>): void => {
        (value["pack"] as Record<string, unknown>)["publishedAt"] = "2026-02-30";
      },
    ],
    [
      "invalid verification instant",
      (value: Record<string, unknown>): void => {
        value["verificationTime"] = "2026-02-30T00:00:00Z";
      },
    ],
    [
      "wrong pack schema",
      (value: Record<string, unknown>): void => {
        (value["pack"] as Record<string, unknown>)["schemaVersion"] = "0.2.0";
      },
    ],
    [
      "wrong target schema",
      (value: Record<string, unknown>): void => {
        (value["target"] as Record<string, unknown>)["schemaVersion"] = "0.2.0";
      },
    ],
    [
      "pack identifier mismatch",
      (value: Record<string, unknown>): void => {
        (value["target"] as Record<string, unknown>)["packId"] = "another-pack";
      },
    ],
    [
      "invalid target channel",
      (value: Record<string, unknown>): void => {
        (value["target"] as Record<string, unknown>)["channel"] = "nightly";
      },
    ],
    [
      "invalid root channel",
      (value: Record<string, unknown>): void => {
        value["channel"] = "nightly";
      },
    ],
    [
      "invalid target length",
      (value: Record<string, unknown>): void => {
        (value["target"] as Record<string, unknown>)["length"] = 0;
      },
    ],
    [
      "wrong TUF contract",
      (value: Record<string, unknown>): void => {
        (value["trustedState"] as Record<string, unknown>)["contractVersion"] = "0.2.0";
      },
    ],
    [
      "wrong TUF repository",
      (value: Record<string, unknown>): void => {
        (value["trustedState"] as Record<string, unknown>)["repositoryId"] = "another";
      },
    ],
    [
      "missing snapshot authority",
      (value: Record<string, unknown>): void => {
        (value["trustedState"] as Record<string, unknown>)["snapshot"] = null;
      },
    ],
    [
      "invalid metadata expiration",
      (value: Record<string, unknown>): void => {
        ((value["trustedState"] as Record<string, unknown>)["root"] as Record<string, unknown>)[
          "expires"
        ] = "2026-02-30T00:00:00Z";
      },
    ],
    [
      "invalid metadata issue time",
      (value: Record<string, unknown>): void => {
        ((value["trustedState"] as Record<string, unknown>)["root"] as Record<string, unknown>)[
          "issuedAt"
        ] = "2026-02-30T00:00:00Z";
      },
    ],
    [
      "reversed metadata interval",
      (value: Record<string, unknown>): void => {
        ((value["trustedState"] as Record<string, unknown>)["root"] as Record<string, unknown>)[
          "issuedAt"
        ] = "2026-08-03T00:00:00Z";
      },
    ],
    [
      "missing required field",
      (value: Record<string, unknown>): void => {
        delete (value["target"] as Record<string, unknown>)["sha256"];
      },
    ],
    [
      "non-object pack",
      (value: Record<string, unknown>): void => {
        value["pack"] = null;
      },
    ],
  ])("rejects %s", (_label, mutate) => {
    const value = lockfile();
    mutate(value);
    expectInvalid(validateStandardsLockfile(value));
  });

  test("rejects malformed, duplicate, noncanonical, BOM, invalid UTF-8, and oversized input", () => {
    const serialized = serializeStandardsLockfile(lockfile());
    expect(serialized.ok).toBe(true);
    if (!serialized.ok) return;
    expect(parseCanonicalStandardsLockfile("{")).toMatchObject({ ok: false });
    expect(
      parseCanonicalStandardsLockfile(`{"channel":"stable",${serialized.text.slice(1)}`),
    ).toMatchObject({ ok: false });
    expect(parseCanonicalStandardsLockfile(`${serialized.text} `)).toMatchObject({ ok: false });
    expect(
      parseCanonicalStandardsLockfile(
        Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(serialized.text)]),
      ),
    ).toMatchObject({ ok: false });
    expect(parseCanonicalStandardsLockfile(new Uint8Array([0xc3, 0x28]))).toMatchObject({
      ok: false,
    });
    expect(
      parseCanonicalStandardsLockfile("x".repeat(MAX_STANDARDS_LOCKFILE_BYTES + 1)),
    ).toMatchObject({ ok: false });
    const extra = Buffer.from(serialized.text);
    Object.defineProperty(extra, "extra", { enumerable: true, value: true });
    expect(parseCanonicalStandardsLockfile(extra)).toMatchObject({ ok: false });
    if (typeof SharedArrayBuffer !== "undefined") {
      const shared = new Uint8Array(new SharedArrayBuffer(Buffer.byteLength(serialized.text)));
      shared.set(Buffer.from(serialized.text));
      expect(parseCanonicalStandardsLockfile(shared)).toMatchObject({ ok: false });
    }
    expect(
      parseCanonicalStandardsLockfile(new DataView(new ArrayBuffer(8)) as unknown as Uint8Array),
    ).toMatchObject({ ok: false });
    class ExoticBytes extends Uint8Array {}
    expect(parseCanonicalStandardsLockfile(new ExoticBytes(8))).toMatchObject({ ok: false });
    expect(
      parseCanonicalStandardsLockfile(new Uint8Array(MAX_STANDARDS_LOCKFILE_BYTES + 1)),
    ).toMatchObject({ ok: false });
  });

  test("rejects exotic, cyclic, accessor, proxy, and shared inputs without throwing", () => {
    const cyclic = lockfile();
    cyclic["cycle"] = cyclic;
    const accessor = lockfile();
    Object.defineProperty(accessor, "channel", { enumerable: true, get: () => "stable" });
    const revoked = Proxy.revocable(lockfile(), {});
    revoked.revoke();
    const values: unknown[] = [
      cyclic,
      accessor,
      revoked.proxy,
      new Date(),
      { bytes: new Uint8Array(1) },
    ];
    if (typeof SharedArrayBuffer !== "undefined")
      values.push(new Uint8Array(new SharedArrayBuffer(8)));
    for (const value of values) {
      expect(() => validateStandardsLockfile(value)).not.toThrow();
      expect(validateStandardsLockfile(value)).toMatchObject({ ok: false });
    }
    expect(validateStandardsLockfile(null)).toMatchObject({ ok: false });
    expect(
      validateStandardsLockfile({ padding: "x".repeat(MAX_STANDARDS_LOCKFILE_BYTES + 1) }),
    ).toMatchObject({ ok: false });
    expect(serializeStandardsLockfile({})).toMatchObject({ ok: false });
    expect(parseCanonicalStandardsLockfile("{}")).toMatchObject({ ok: false });
  });

  test("updates only after validation and passes canonical bytes to the writer", async () => {
    const result = successfulWrite();
    const write = vi.fn((request: unknown): Promise<StandardsLockfileAtomicWriteResult> => {
      void request;
      return Promise.resolve(result);
    });
    await expect(
      updateStandardsLockfile(
        { write },
        {
          expected: { identity: { device: "1", inode: "2" }, sha256: HASH_A },
          lockfile: lockfile(),
          path: DEFAULT_STANDARDS_LOCKFILE_PATH,
        },
      ),
    ).resolves.toBe(result);
    expect(write).toHaveBeenCalledTimes(1);
    const request = write.mock.calls[0]?.[0] as { replacement: Uint8Array };
    expect(parseCanonicalStandardsLockfile(request.replacement)).toMatchObject({ ok: true });
  });

  test("does not invoke mutation for invalid state, path, or lock content", async () => {
    const write = vi.fn((request: unknown): Promise<StandardsLockfileAtomicWriteResult> => {
      void request;
      return Promise.resolve(successfulWrite());
    });
    for (const request of [
      {
        expected: { identity: { device: "1", inode: "2" }, sha256: "bad" },
        lockfile: lockfile(),
        path: DEFAULT_STANDARDS_LOCKFILE_PATH,
      },
      {
        expected: { identity: { device: "1", inode: "2" }, sha256: HASH_A },
        lockfile: lockfile(),
        path: "../outside",
      },
      {
        expected: { identity: { device: "1", inode: "2" }, sha256: HASH_A },
        lockfile: lockfile(),
        path: ".",
      },
      {
        expected: { identity: { device: "1", inode: "2" }, sha256: HASH_A },
        lockfile: { command: "run" },
        path: DEFAULT_STANDARDS_LOCKFILE_PATH,
      },
    ])
      await expect(updateStandardsLockfile({ write }, request)).rejects.toThrow(TypeError);
    expect(write).not.toHaveBeenCalled();
  });

  test("preserves the writer's pre- and post-commit failure truth", async () => {
    for (const committed of [false, true]) {
      const marker = Object.freeze(Object.assign(new Error("write failed"), { committed }));
      const writer = {
        write: vi.fn((request: unknown): Promise<StandardsLockfileAtomicWriteResult> => {
          void request;
          return Promise.reject(marker);
        }),
      };
      await expect(
        updateStandardsLockfile(writer, {
          expected: { identity: { device: "1", inode: "2" }, sha256: HASH_A },
          lockfile: lockfile(),
          path: DEFAULT_STANDARDS_LOCKFILE_PATH,
        }),
      ).rejects.toBe(marker);
    }
  });

  test("ships the schema and implementation in the private package", () => {
    const manifest = JSON.parse(readFileSync(PACKAGE_JSON, "utf8")) as {
      exports?: Record<string, unknown>;
      files?: string[];
    };
    expect(manifest.files).toContain("schemas");
    expect(manifest.exports?.["./schemas/standards-lockfile.v1.schema.json"]).toBe(
      "./schemas/standards-lockfile.v1.schema.json",
    );
  });
});
