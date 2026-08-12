import { createHash } from "node:crypto";
import {
  appendFile,
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { AnySchema } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, onTestFinished, test, vi } from "vitest";

import {
  BUNDLED_MANIFEST_LENGTH,
  BUNDLED_MANIFEST_SHA256,
  BUNDLED_PACK_LOADER_CONTRACT_VERSION,
  BUNDLED_PACK_MANIFEST_VERSION,
  MAX_BUNDLED_MANIFEST_BYTES,
  MAX_BUNDLED_MANIFEST_ENTRIES,
  MAX_BUNDLED_PATH_BYTES,
  MAX_KNOWLEDGE_PACK_BYTES,
  MAX_TUF_METADATA_BYTES,
  canonicalizeJson,
  getAuthenticatedBundledTrustStore,
  isAuthenticatedBundledKnowledgePack,
  loadBundledKnowledgePack,
} from "../src/index.js";
import { loadBundledKnowledgePackFixtureForTest } from "../src/bundled-pack-loader.js";

import type { BundledPackLoadIssueCode, BundledPackLoadResult } from "../src/index.js";

const BUNDLED = fileURLToPath(new URL("../bundled", import.meta.url));
const MANIFEST_SCHEMA = new URL("../schemas/bundled-pack-manifest.v0.schema.json", import.meta.url);

interface Descriptor {
  readonly length: number;
  readonly path: string;
  readonly sha256: string;
}

function hash(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function descriptor(bytes: Uint8Array | string): Descriptor {
  return { length: Buffer.byteLength(bytes), path: "manifest.v0.json", sha256: hash(bytes) };
}

function expectIssue(result: BundledPackLoadResult, code: BundledPackLoadIssueCode): void {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected loader failure");
  expect(result.issues).toEqual([expect.objectContaining({ code })]);
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.issues)).toBe(true);
  expect(Object.isFrozen(result.issues[0])).toBe(true);
}

async function fixture(): Promise<string> {
  const parent = await mkdtemp(path.join(os.tmpdir(), "agent-context-h03-"));
  onTestFinished(async () => rm(parent, { force: true, recursive: true }));
  const root = path.join(parent, "bundled");
  await cp(BUNDLED, root, { recursive: true });
  return root;
}

async function manifest(root: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path.join(root, "manifest.v0.json"), "utf8")) as Record<
    string,
    unknown
  >;
}

function entry(value: Record<string, unknown>): Record<string, unknown> {
  const entries = value["entries"];
  if (!Array.isArray(entries) || entries[0] === null || typeof entries[0] !== "object")
    throw new TypeError("missing manifest entry");
  return entries[0] as Record<string, unknown>;
}

function nested(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = record[key];
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(key);
  return value as Record<string, unknown>;
}

async function rewriteManifest(
  root: string,
  operation: (value: Record<string, unknown>) => void,
): Promise<Descriptor> {
  const value = await manifest(root);
  operation(value);
  const canonical = canonicalizeJson(value);
  if (!canonical.ok) throw new Error(JSON.stringify(canonical.issues));
  await chmod(path.join(root, "manifest.v0.json"), 0o600);
  await writeFile(path.join(root, "manifest.v0.json"), canonical.text);
  return descriptor(canonical.text);
}

async function updateFileDescriptor(
  root: string,
  manifestValue: Record<string, unknown>,
  section: "content" | "delegatedTargets",
): Promise<void> {
  const selected = entry(manifestValue);
  const record =
    section === "content"
      ? nested(selected, "content")
      : nested(nested(selected, "metadata"), "delegatedTargets");
  const relative = record["path"];
  if (typeof relative !== "string") throw new TypeError("path");
  const bytes = await readFile(path.join(root, relative));
  record["length"] = bytes.byteLength;
  record["sha256"] = hash(bytes);
}

describe("H03 immutable bundled knowledge-pack loader", () => {
  test("loads the signed stable pack deterministically with immutable authenticated provenance", async () => {
    const request = { channel: "stable", engineVersion: "0.0.0" } as const;
    const first = await loadBundledKnowledgePack(request);
    const second = await loadBundledKnowledgePack(request);
    expect(first).toEqual(second);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(JSON.stringify(first.issues));
    expect(first.value).toMatchObject({
      contractVersion: BUNDLED_PACK_LOADER_CONTRACT_VERSION,
      origin: "bundled",
      pack: {
        channel: "stable",
        packId: "agent-context-bundled",
        packVersion: "2026.8.0",
        schemaVersion: "0.1.0",
      },
      provenance: {
        channel: "stable",
        contentLength: 1_115,
        contentSha256: "71cdbec6d7450b05d88f7f13cc7e1f66b98be2824846b526d358fef644d94e59",
        manifestSha256: BUNDLED_MANIFEST_SHA256,
        verificationTime: "2026-08-02T12:00:00Z",
      },
    });
    expect(first.value.provenance.target.sha256).toBe(first.value.provenance.contentSha256);
    expect(first.value.provenance.target.length).toBe(first.value.provenance.contentLength);
    expect(first.value.provenance.trustedState.delegated.stable?.version).toBe(1);
    expect(isAuthenticatedBundledKnowledgePack(first.value)).toBe(true);
    expect(getAuthenticatedBundledTrustStore(first.value)).toBeDefined();
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.value)).toBe(true);
    expect(Object.isFrozen(first.value.pack)).toBe(true);
    expect(Object.isFrozen(first.value.provenance)).toBe(true);
    expect(Object.isFrozen(first.value.provenance.target)).toBe(true);
    expect(Object.isFrozen(first.value.provenance.trustedState)).toBe(true);
  });

  test("ships an exact canonical closed manifest matching its compiled trust anchor and schema", async () => {
    const bytes = await readFile(path.join(BUNDLED, "manifest.v0.json"));
    expect(bytes.byteLength).toBe(BUNDLED_MANIFEST_LENGTH);
    expect(hash(bytes)).toBe(BUNDLED_MANIFEST_SHA256);
    expect(BUNDLED_MANIFEST_LENGTH).toBeLessThanOrEqual(MAX_BUNDLED_MANIFEST_BYTES);
    expect(BUNDLED_PACK_MANIFEST_VERSION).toBe("0.1.0");
    expect(MAX_BUNDLED_MANIFEST_ENTRIES).toBe(2);
    expect(MAX_BUNDLED_PATH_BYTES).toBe(256);
    const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
    const canonical = canonicalizeJson(parsed);
    expect(canonical).toEqual({ ok: true, text: bytes.toString("utf8") });
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    const schema = JSON.parse(await readFile(MANIFEST_SCHEMA, "utf8")) as AnySchema;
    const validate = ajv.compile(schema);
    expect(validate(parsed)).toBe(true);

    const metadataBoundary = structuredClone(parsed) as Record<string, unknown>;
    nested(nested(entry(metadataBoundary), "metadata"), "root")["length"] =
      MAX_TUF_METADATA_BYTES + 1;
    expect(validate(metadataBoundary)).toBe(false);

    const contentBoundary = structuredClone(parsed) as Record<string, unknown>;
    nested(entry(contentBoundary), "content")["length"] = MAX_KNOWLEDGE_PACK_BYTES;
    expect(validate(contentBoundary)).toBe(true);
    nested(entry(contentBoundary), "content")["length"] = MAX_KNOWLEDGE_PACK_BYTES + 1;
    expect(validate(contentBoundary)).toBe(false);
  });

  test("rejects malformed, accessor, proxy, unknown, channel, and engine requests before reads", async () => {
    let calls = 0;
    const accessor = Object.defineProperty({}, "channel", {
      enumerable: true,
      get() {
        calls += 1;
        return "stable";
      },
    });
    Object.defineProperty(accessor, "engineVersion", { enumerable: true, value: "0.0.0" });
    for (const request of [
      null,
      [],
      new Proxy({}, {}),
      accessor,
      { channel: "stable" },
      { channel: "stable", engineVersion: "0.0.0", extra: true },
      { channel: "beta", engineVersion: "0.0.0" },
      { channel: "stable", engineVersion: "01.0.0" },
      Object.assign(Object.create({ inherited: true }) as object, {
        channel: "stable",
        engineVersion: "0.0.0",
      }),
    ])
      expectIssue(await loadBundledKnowledgePack(request), "invalid-input");
    expect(calls).toBe(0);
    expectIssue(
      await loadBundledKnowledgePack({ channel: "preview", engineVersion: "0.0.0" }),
      "invalid-input",
    );
    expectIssue(
      await loadBundledKnowledgePack({ channel: "stable", engineVersion: "0.0.0-alpha" }),
      "trust-failure",
    );
  });

  test("does not authenticate structural clones, forged values, or test-fixture loads", async () => {
    const production = await loadBundledKnowledgePack({
      channel: "stable",
      engineVersion: "0.0.0",
    });
    expect(production.ok).toBe(true);
    if (!production.ok) throw new Error("expected bundled pack");
    expect(isAuthenticatedBundledKnowledgePack(structuredClone(production.value))).toBe(false);
    expect(getAuthenticatedBundledTrustStore(structuredClone(production.value))).toBeUndefined();
    expect(isAuthenticatedBundledKnowledgePack({ ...production.value })).toBe(false);
    expect(getAuthenticatedBundledTrustStore({ ...production.value })).toBeUndefined();
    expect(isAuthenticatedBundledKnowledgePack(new Proxy(production.value, {}))).toBe(false);
    const root = await fixture();
    const rawManifest = await readFile(path.join(root, "manifest.v0.json"));
    const testLoad = await loadBundledKnowledgePackFixtureForTest(root, descriptor(rawManifest), {
      channel: "stable",
      engineVersion: "0.0.0",
    });
    expect(testLoad.ok).toBe(true);
    if (testLoad.ok) {
      expect(isAuthenticatedBundledKnowledgePack(testLoad.value)).toBe(false);
      expect(getAuthenticatedBundledTrustStore(testLoad.value)).toBeUndefined();
    }
  });

  test("rejects wrong manifest authority, malformed UTF-8, noncanonical JSON, and unknown fields", async () => {
    const root = await fixture();
    const original = await readFile(path.join(root, "manifest.v0.json"));
    expectIssue(
      await loadBundledKnowledgePackFixtureForTest(
        root,
        { ...descriptor(original), sha256: "0".repeat(64) },
        { channel: "stable", engineVersion: "0.0.0" },
      ),
      "manifest-mismatch",
    );
    for (const bytes of [
      Buffer.from([0xff]),
      Buffer.from("\ufeff{}"),
      Buffer.from("{"),
      Buffer.from(` ${original.toString("utf8")}`),
      Buffer.from(original.toString("utf8").replace("{", '{"unknown":true,')),
    ]) {
      await chmod(path.join(root, "manifest.v0.json"), 0o600);
      await writeFile(path.join(root, "manifest.v0.json"), bytes);
      expectIssue(
        await loadBundledKnowledgePackFixtureForTest(root, descriptor(bytes), {
          channel: "stable",
          engineVersion: "0.0.0",
        }),
        "invalid-manifest",
      );
    }
  });

  test("rejects every malformed manifest boundary before reading referenced artifacts", async () => {
    const operations: readonly ((value: Record<string, unknown>) => void)[] = [
      (value): void => {
        value["unknown"] = true;
      },
      (value): void => {
        value["recordKind"] = "other";
      },
      (value): void => {
        value["schemaVersion"] = "9.9.9";
      },
      (value): void => {
        value["verificationTime"] = "2026-02-30T00:00:00Z";
      },
      (value): void => {
        value["verificationTime"] = "not-a-time";
      },
      (value): void => {
        value["entries"] = {};
      },
      (value): void => {
        value["entries"] = [];
      },
      (value): void => {
        entry(value)["channel"] = "nightly";
      },
      (value): void => {
        (value["entries"] as unknown[]).push(structuredClone(entry(value)));
      },
      (value): void => {
        entry(value)["metadata"] = null;
      },
      (value): void => {
        entry(value)["content"] = null;
      },
      (value): void => {
        nested(entry(value), "content")["sha256"] = "ABC";
      },
      (value): void => {
        nested(entry(value), "content")["length"] = 0;
      },
      (value): void => {
        nested(entry(value), "content")["path"] = "";
      },
    ];
    for (const operation of operations) {
      const root = await fixture();
      const selected = await rewriteManifest(root, operation);
      const result = await loadBundledKnowledgePackFixtureForTest(root, selected, {
        channel: "stable",
        engineVersion: "0.0.0",
      });
      expect(result.ok).toBe(false);
      if (!result.ok)
        expect(["invalid-manifest", "resource-limit", "unsafe-path"]).toContain(
          result.issues[0]?.code,
        );
    }

    const missingRoot = path.join(await fixture(), "missing");
    expectIssue(
      await loadBundledKnowledgePackFixtureForTest(
        missingRoot,
        { length: 1, path: "manifest.v0.json", sha256: "0".repeat(64) },
        { channel: "stable", engineVersion: "0.0.0" },
      ),
      "unsafe-file",
    );
    expectIssue(
      await loadBundledKnowledgePackFixtureForTest(
        await fixture(),
        { length: MAX_BUNDLED_MANIFEST_BYTES + 1, path: "manifest.v0.json", sha256: "x" },
        { channel: "stable", engineVersion: "0.0.0" },
      ),
      "invalid-manifest",
    );
  });

  test("rejects traversal, non-content-addressed packs, excess entries, and pre-read size widening", async () => {
    for (const operation of [
      (value: Record<string, unknown>): void => {
        nested(entry(value), "content")["path"] = "../outside.json";
      },
      (value: Record<string, unknown>): void => {
        nested(entry(value), "content")["path"] = "packs/renamed.json";
      },
      (value: Record<string, unknown>): void => {
        (value["entries"] as unknown[]).push(structuredClone(entry(value)));
        (value["entries"] as unknown[]).push(structuredClone(entry(value)));
      },
      (value: Record<string, unknown>): void => {
        nested(nested(entry(value), "metadata"), "root")["length"] = 512 * 1024 + 1;
      },
    ]) {
      const root = await fixture();
      const expected = await rewriteManifest(root, operation);
      const result = await loadBundledKnowledgePackFixtureForTest(root, expected, {
        channel: "stable",
        engineVersion: "0.0.0",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(["resource-limit", "unsafe-path"]).toContain(result.issues[0]?.code);
    }
  });

  test("rejects symbolic roots, symbolic ancestors and files, and non-regular targets", async () => {
    const root = await fixture();
    const rawManifest = await readFile(path.join(root, "manifest.v0.json"));
    const parent = path.dirname(root);
    const rootLink = path.join(parent, "root-link");
    await symlink(root, rootLink, "dir");
    expectIssue(
      await loadBundledKnowledgePackFixtureForTest(rootLink, descriptor(rawManifest), {
        channel: "stable",
        engineVersion: "0.0.0",
      }),
      "unsafe-file",
    );

    const content = nested(entry(await manifest(root)), "content");
    const contentPath = content["path"] as string;
    const absolute = path.join(root, contentPath);
    await rm(absolute);
    await symlink(path.join(BUNDLED, contentPath), absolute);
    expectIssue(
      await loadBundledKnowledgePackFixtureForTest(root, descriptor(rawManifest), {
        channel: "stable",
        engineVersion: "0.0.0",
      }),
      "unsafe-file",
    );

    await rm(absolute);
    await mkdir(absolute);
    expectIssue(
      await loadBundledKnowledgePackFixtureForTest(root, descriptor(rawManifest), {
        channel: "stable",
        engineVersion: "0.0.0",
      }),
      "unsafe-file",
    );
  });

  test("detects truncation, growth, and same-length mutation through the opened file identity", async () => {
    for (const mode of ["truncate", "grow", "mutate"] as const) {
      const root = await fixture();
      const rawManifest = await readFile(path.join(root, "manifest.v0.json"));
      const content = nested(entry(await manifest(root)), "content");
      const contentPath = content["path"] as string;
      const absolute = path.join(root, contentPath);
      await chmod(absolute, 0o600);
      let changed = false;
      const result = await loadBundledKnowledgePackFixtureForTest(
        root,
        descriptor(rawManifest),
        { channel: "stable", engineVersion: "0.0.0" },
        {
          async afterOpen(relativePath) {
            if (changed || relativePath !== contentPath) return;
            changed = true;
            if (mode === "truncate") await truncate(absolute, 1);
            else if (mode === "grow") await appendFile(absolute, "x");
            else {
              const bytes = await readFile(absolute);
              bytes[0] = bytes[0] === 0x7b ? 0x5b : 0x7b;
              await writeFile(absolute, bytes);
            }
          },
        },
      );
      expect(changed).toBe(true);
      expectIssue(result, "concurrent-change");
    }
  });

  test("rejects content digest changes before TUF and signed metadata changes at the H02 boundary", async () => {
    const trustRoot = await fixture();
    const trustManifestValue = await manifest(trustRoot);
    const rootDescriptor = nested(nested(entry(trustManifestValue), "metadata"), "root");
    const rootPath = path.join(trustRoot, rootDescriptor["path"] as string);
    await chmod(rootPath, 0o600);
    const rootBytes = await readFile(rootPath);
    const rootFirst = rootBytes[0];
    if (rootFirst === undefined) throw new Error("empty root fixture");
    rootBytes[0] = rootFirst ^ 1;
    await writeFile(rootPath, rootBytes);
    const trustManifest = await rewriteManifest(trustRoot, (value): void => {
      nested(nested(entry(value), "metadata"), "root")["sha256"] = hash(rootBytes);
    });
    expectIssue(
      await loadBundledKnowledgePackFixtureForTest(trustRoot, trustManifest, {
        channel: "stable",
        engineVersion: "0.0.0",
      }),
      "trust-failure",
    );

    const digestRoot = await fixture();
    const digestManifest = await readFile(path.join(digestRoot, "manifest.v0.json"));
    const content = nested(entry(await manifest(digestRoot)), "content");
    const contentPath = path.join(digestRoot, content["path"] as string);
    await chmod(contentPath, 0o600);
    const contentBytes = await readFile(contentPath);
    const contentByte = contentBytes[10];
    if (contentByte === undefined) throw new Error("short content fixture");
    contentBytes[10] = contentByte ^ 1;
    await writeFile(contentPath, contentBytes);
    expectIssue(
      await loadBundledKnowledgePackFixtureForTest(digestRoot, descriptor(digestManifest), {
        channel: "stable",
        engineVersion: "0.0.0",
      }),
      "manifest-mismatch",
    );

    const signatureRoot = await fixture();
    const manifestValue = await manifest(signatureRoot);
    const delegated = nested(nested(entry(manifestValue), "metadata"), "delegatedTargets");
    const delegatedPath = path.join(signatureRoot, delegated["path"] as string);
    await chmod(delegatedPath, 0o600);
    const delegatedBytes = await readFile(delegatedPath);
    const signatureIndex = delegatedBytes.length - 2;
    const signatureByte = delegatedBytes[signatureIndex];
    if (signatureByte === undefined) throw new Error("short delegated fixture");
    delegatedBytes[signatureIndex] = signatureByte ^ 1;
    await writeFile(delegatedPath, delegatedBytes);
    await updateFileDescriptor(signatureRoot, manifestValue, "delegatedTargets");
    const canonical = canonicalizeJson(manifestValue);
    if (!canonical.ok) throw new Error("invalid fixture manifest");
    await chmod(path.join(signatureRoot, "manifest.v0.json"), 0o600);
    await writeFile(path.join(signatureRoot, "manifest.v0.json"), canonical.text);
    expectIssue(
      await loadBundledKnowledgePackFixtureForTest(signatureRoot, descriptor(canonical.text), {
        channel: "stable",
        engineVersion: "0.0.0",
      }),
      "trust-failure",
    );
  });

  test("does not consult process, environment, network, or global configuration", async () => {
    const envBefore = { ...process.env };
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const first = await loadBundledKnowledgePack({ channel: "stable", engineVersion: "0.0.0" });
    const second = await loadBundledKnowledgePack({ channel: "stable", engineVersion: "0.0.0" });
    expect(first).toEqual(second);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    expect(process.env).toEqual(envBefore);
  });
});
