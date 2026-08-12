import { createHash, createPrivateKey, createPublicKey, sign as cryptoSign } from "node:crypto";
import { readFile } from "node:fs/promises";

import { canonicalize } from "@tufjs/canonical-json";
import type { AnySchema } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it, vi } from "vitest";

import {
  MAX_TUF_ISSUE_MESSAGE_BYTES,
  MAX_TUF_ISSUE_PATH_BYTES,
  MAX_TUF_METADATA_BYTES,
  MAX_TUF_SEMVER_BYTES,
  MAX_TUF_TARGET_BYTES,
  MAX_TUF_TARGET_PATH_BYTES,
  OfflineTufTrustStore,
  TUF_PREVIEW_ROLE,
  TUF_SPECIFICATION_VERSION,
  TUF_STABLE_ROLE,
} from "../src/index.js";

import type { TufChannel, TufOfflineUpdateBundle, TufOfflineUpdateRequest } from "../src/index.js";

const SCHEMA = new URL("../schemas/tuf-metadata.v0.schema.json", import.meta.url);
const PACKAGE_JSON = new URL("../package.json", import.meta.url);
const PRODUCTION_SOURCE = new URL("../src/tuf-trust.ts", import.meta.url);
const START = "2026-08-02T12:00:00Z";
const TARGET_BYTES = new TextEncoder().encode(
  '{"fixture":"H02 deterministic non-production data"}',
);

interface TestKey {
  readonly id: string;
  readonly object: {
    readonly keytype: "ed25519";
    readonly keyval: { readonly public: string };
    readonly scheme: "ed25519";
  };
  readonly privateKey: ReturnType<typeof createPrivateKey>;
}

/**
 * These test-only Ed25519 seeds are deterministically derived from obvious
 * fixture labels. They are public, non-production material and never enter a
 * production source file, schema, built package, or published tarball.
 */
function testKey(label: string): TestKey {
  const seed = createHash("sha256")
    .update(`agent-context-lint:H02:NON-PRODUCTION:${label}`)
    .digest();
  const prefix = Buffer.from("302e020100300506032b657004220420", "hex");
  const privateKey = createPrivateKey({
    key: Buffer.concat([prefix, seed]),
    format: "der",
    type: "pkcs8",
  });
  const publicDer = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  const object = {
    keytype: "ed25519" as const,
    keyval: { public: Buffer.from(publicDer).subarray(-32).toString("hex") },
    scheme: "ed25519" as const,
  };
  return {
    id: createHash("sha256").update(canonicalize(object)).digest("hex"),
    object,
    privateKey,
  };
}

const KEYS = Object.freeze({
  preview: [testKey("preview-1"), testKey("preview-2"), testKey("preview-3")],
  previewNext: [testKey("preview-next-1"), testKey("preview-next-2"), testKey("preview-next-3")],
  root: [testKey("root-1"), testKey("root-2"), testKey("root-3")],
  rootNext: [testKey("root-next-1"), testKey("root-next-2"), testKey("root-next-3")],
  snapshot: [testKey("snapshot-1")],
  snapshotNext: [testKey("snapshot-next-1")],
  stable: [testKey("stable-1"), testKey("stable-2"), testKey("stable-3")],
  stableNext: [testKey("stable-next-1"), testKey("stable-next-2"), testKey("stable-next-3")],
  targets: [testKey("targets-1"), testKey("targets-2"), testKey("targets-3")],
  timestamp: [testKey("timestamp-1")],
  timestampNext: [testKey("timestamp-next-1")],
});

type Json = boolean | null | number | string | readonly Json[] | JsonObject;
interface JsonObject {
  readonly [key: string]: Json;
}

function digest(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function metadataBytes(
  signed: Readonly<Record<string, Json>>,
  signers: readonly TestKey[],
): string {
  const signedBytes = Buffer.from(canonicalize(signed));
  const signatures = signers
    .map((key) => ({
      keyid: key.id,
      sig: cryptoSign(null, signedBytes, key.privateKey).toString("hex"),
    }))
    .sort((left, right) => left.keyid.localeCompare(right.keyid));
  return canonicalize({ signatures, signed });
}

function extension(issuedAt = "2026-08-01T00:00:00Z"): Readonly<Record<string, Json>> {
  return { issuedAt, policyVersion: "0.1.0", repositoryId: "agent-context-standards" };
}

function keyMap(groups: readonly (readonly TestKey[])[]): Readonly<Record<string, Json>> {
  const entries: [string, Json][] = groups.flat().map((key) => [key.id, key.object]);
  entries.sort(([left], [right]) => left.localeCompare(right));
  return Object.fromEntries(entries);
}

interface RootOptions {
  readonly expires?: string;
  readonly rootKeys?: readonly TestKey[];
  readonly signers?: readonly TestKey[];
  readonly snapshotKeys?: readonly TestKey[];
  readonly timestampKeys?: readonly TestKey[];
  readonly version?: number;
}

function rootMetadata(options: RootOptions = {}): string {
  const rootKeys = options.rootKeys ?? KEYS.root;
  const snapshotKeys = options.snapshotKeys ?? KEYS.snapshot;
  const timestampKeys = options.timestampKeys ?? KEYS.timestamp;
  const signed = {
    _type: "root",
    consistent_snapshot: true,
    expires: options.expires ?? "2027-07-31T00:00:00Z",
    keys: keyMap([rootKeys, KEYS.targets, snapshotKeys, timestampKeys]),
    roles: {
      root: { keyids: rootKeys.map((key) => key.id).sort(), threshold: 2 },
      snapshot: { keyids: snapshotKeys.map((key) => key.id).sort(), threshold: 1 },
      targets: { keyids: KEYS.targets.map((key) => key.id).sort(), threshold: 2 },
      timestamp: { keyids: timestampKeys.map((key) => key.id).sort(), threshold: 1 },
    },
    spec_version: TUF_SPECIFICATION_VERSION,
    version: options.version ?? 1,
    "x-agent-context": extension("2026-08-01T00:00:00Z"),
  };
  return metadataBytes(signed, options.signers ?? rootKeys.slice(0, 2));
}

interface RepositoryOptions {
  readonly channel?: TufChannel;
  readonly delegatedKeys?: Readonly<{ preview: readonly TestKey[]; stable: readonly TestKey[] }>;
  readonly delegatedSigners?: readonly TestKey[];
  readonly expires?: Partial<Record<"delegated" | "snapshot" | "targets" | "timestamp", string>>;
  readonly minEngineVersion?: string;
  readonly root?: string;
  readonly snapshotKeys?: readonly TestKey[];
  readonly targetBytes?: Uint8Array;
  readonly timestampKeys?: readonly TestKey[];
  readonly versions?: Partial<Record<"delegated" | "snapshot" | "targets" | "timestamp", number>>;
}

interface RepositoryFixture {
  readonly bundle: TufOfflineUpdateBundle;
  readonly delegated: Readonly<Record<TufChannel, string>>;
  readonly root: string;
  readonly snapshot: string;
  readonly targets: string;
  readonly timestamp: string;
}

function repository(options: RepositoryOptions = {}): RepositoryFixture {
  const channel = options.channel ?? "stable";
  const delegatedKeys = options.delegatedKeys ?? { preview: KEYS.preview, stable: KEYS.stable };
  const versions = options.versions ?? {};
  const targetBytes = options.targetBytes ?? TARGET_BYTES;
  const delegated: Record<TufChannel, string> = { preview: "", stable: "" };
  for (const delegatedChannel of ["preview", "stable"] as const) {
    const path = `knowledge/${delegatedChannel}/agent-context-${delegatedChannel}.json`;
    delegated[delegatedChannel] = metadataBytes(
      {
        _type: "targets",
        expires: options.expires?.delegated ?? "2026-10-01T00:00:00Z",
        spec_version: TUF_SPECIFICATION_VERSION,
        targets: {
          [path]: {
            custom: {
              channel: delegatedChannel,
              minEngineVersion: options.minEngineVersion ?? "0.0.0",
              packId: `agent-context-${delegatedChannel}`,
              packVersion: "2026.8.0",
              schemaVersion: "0.1.0",
            },
            hashes: { sha256: digest(targetBytes) },
            length: targetBytes.byteLength,
          },
        },
        version: versions.delegated ?? 1,
        "x-agent-context": extension(),
      },
      delegatedChannel === channel && options.delegatedSigners !== undefined
        ? options.delegatedSigners
        : delegatedKeys[delegatedChannel].slice(0, 2),
    );
  }
  const targets = metadataBytes(
    {
      _type: "targets",
      delegations: {
        keys: keyMap([delegatedKeys.preview, delegatedKeys.stable]),
        roles: [
          {
            keyids: delegatedKeys.preview.map((key) => key.id).sort(),
            name: TUF_PREVIEW_ROLE,
            paths: ["knowledge/preview/*"],
            terminating: true,
            threshold: 2,
          },
          {
            keyids: delegatedKeys.stable.map((key) => key.id).sort(),
            name: TUF_STABLE_ROLE,
            paths: ["knowledge/stable/*"],
            terminating: true,
            threshold: 2,
          },
        ],
      },
      expires: options.expires?.targets ?? "2026-10-01T00:00:00Z",
      spec_version: TUF_SPECIFICATION_VERSION,
      targets: {},
      version: versions.targets ?? 1,
      "x-agent-context": extension(),
    },
    KEYS.targets.slice(0, 2),
  );
  const meta = {
    "standards-preview.json": {
      hashes: { sha256: digest(delegated.preview) },
      length: Buffer.byteLength(delegated.preview),
      version: versions.delegated ?? 1,
    },
    "standards-stable.json": {
      hashes: { sha256: digest(delegated.stable) },
      length: Buffer.byteLength(delegated.stable),
      version: versions.delegated ?? 1,
    },
    "targets.json": {
      hashes: { sha256: digest(targets) },
      length: Buffer.byteLength(targets),
      version: versions.targets ?? 1,
    },
  };
  const snapshot = metadataBytes(
    {
      _type: "snapshot",
      expires: options.expires?.snapshot ?? "2026-08-08T00:00:00Z",
      meta,
      spec_version: TUF_SPECIFICATION_VERSION,
      version: versions.snapshot ?? 1,
      "x-agent-context": extension(),
    },
    options.snapshotKeys ?? KEYS.snapshot,
  );
  const timestamp = metadataBytes(
    {
      _type: "timestamp",
      expires: options.expires?.timestamp ?? "2026-08-02T23:00:00Z",
      meta: {
        "snapshot.json": {
          hashes: { sha256: digest(snapshot) },
          length: Buffer.byteLength(snapshot),
          version: versions.snapshot ?? 1,
        },
      },
      spec_version: TUF_SPECIFICATION_VERSION,
      version: versions.timestamp ?? 1,
      "x-agent-context": extension("2026-08-02T00:00:00Z"),
    },
    options.timestampKeys ?? KEYS.timestamp,
  );
  const root = options.root ?? rootMetadata();
  return {
    bundle: {
      delegatedTargets: delegated[channel],
      snapshot,
      target: targetBytes,
      targets,
      timestamp,
    },
    delegated,
    root,
    snapshot,
    targets,
    timestamp,
  };
}

function request(channel: TufChannel = "stable"): TufOfflineUpdateRequest {
  return {
    channel,
    engineVersion: "1.0.0",
    startedAt: START,
    targetPath: `knowledge/${channel}/agent-context-${channel}.json`,
  };
}

function bootstrap(root = rootMetadata()): OfflineTufTrustStore {
  const result = OfflineTufTrustStore.bootstrap(root);
  if (!result.ok) throw new Error(result.issues[0]?.message);
  return result.value;
}

function issueCode(result: ReturnType<OfflineTufTrustStore["verifyUpdate"]>): string | undefined {
  return result.ok ? undefined : result.issues[0]?.code;
}

function expectBoundedNonReflectiveIssue(
  result:
    | ReturnType<OfflineTufTrustStore["verifyUpdate"]>
    | ReturnType<typeof OfflineTufTrustStore.bootstrap>,
  canary: string,
): void {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.issues).toHaveLength(1);
  const issue = result.issues[0];
  if (issue === undefined) throw new Error("expected one trust issue");
  expect(issue.path).not.toContain(canary);
  expect(issue.message).not.toContain(canary);
  const issueText = `${issue.path}${issue.message}`;
  let containsUnsafeUnit = false;
  for (let index = 0; index < issueText.length; index += 1) {
    const unit = issueText.charCodeAt(index);
    containsUnsafeUnit ||=
      unit === 0x0d ||
      unit === 0x0a ||
      unit === 0x1b ||
      (unit >= 0x202a && unit <= 0x202e) ||
      (unit >= 0x2066 && unit <= 0x2069);
  }
  expect(containsUnsafeUnit).toBe(false);
  expect(Buffer.byteLength(issue.path, "utf8")).toBeLessThanOrEqual(MAX_TUF_ISSUE_PATH_BYTES);
  expect(Buffer.byteLength(issue.message, "utf8")).toBeLessThanOrEqual(MAX_TUF_ISSUE_MESSAGE_BYTES);
}

function replaceSigned(
  metadata: string,
  mutate: (signed: Record<string, unknown>) => void,
  signers: readonly TestKey[],
): string {
  const parsed = JSON.parse(metadata) as { signed: Record<string, unknown> };
  mutate(parsed.signed);
  return metadataBytes(parsed.signed as Readonly<Record<string, Json>>, signers);
}

function rebindBundle(
  fixture: RepositoryFixture,
  changes: {
    readonly channel?: TufChannel;
    readonly delegatedTargets?: string;
    readonly snapshot?: (signed: Record<string, unknown>) => void;
    readonly targets?: string;
    readonly timestamp?: (signed: Record<string, unknown>) => void;
  },
): TufOfflineUpdateBundle {
  const targets = changes.targets ?? fixture.targets;
  const delegatedChannel = changes.channel ?? "stable";
  const delegatedTargets = changes.delegatedTargets ?? fixture.delegated[delegatedChannel];
  const snapshotSigned = (JSON.parse(fixture.snapshot) as { signed: Record<string, unknown> })
    .signed;
  const snapshotMeta = snapshotSigned["meta"] as Record<
    string,
    { hashes: { sha256: string }; length: number; version: number }
  >;
  const targetSigned = (JSON.parse(targets) as { signed: { version: number } }).signed;
  const delegatedSigned = (JSON.parse(delegatedTargets) as { signed: { version: number } }).signed;
  snapshotMeta["targets.json"] = {
    hashes: { sha256: digest(targets) },
    length: Buffer.byteLength(targets),
    version: targetSigned.version,
  };
  snapshotMeta[`standards-${delegatedChannel}.json`] = {
    hashes: { sha256: digest(delegatedTargets) },
    length: Buffer.byteLength(delegatedTargets),
    version: delegatedSigned.version,
  };
  changes.snapshot?.(snapshotSigned);
  const snapshot = metadataBytes(snapshotSigned as Readonly<Record<string, Json>>, KEYS.snapshot);

  const timestampSigned = (JSON.parse(fixture.timestamp) as { signed: Record<string, unknown> })
    .signed;
  const timestampMeta = timestampSigned["meta"] as Record<
    string,
    { hashes: { sha256: string }; length: number; version: number }
  >;
  timestampMeta["snapshot.json"] = {
    hashes: { sha256: digest(snapshot) },
    length: Buffer.byteLength(snapshot),
    version: snapshotSigned["version"] as number,
  };
  changes.timestamp?.(timestampSigned);
  return {
    ...fixture.bundle,
    delegatedTargets,
    snapshot: metadataBytes(snapshotSigned as Readonly<Record<string, Json>>, KEYS.snapshot),
    targets,
    timestamp: metadataBytes(timestampSigned as Readonly<Record<string, Json>>, KEYS.timestamp),
  };
}

describe("H02 TUF trust model", () => {
  it("ships a closed Draft 2020-12 schema for every supported role", async () => {
    const schema = JSON.parse(await readFile(SCHEMA, "utf8")) as AnySchema;
    const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
    const fixture = repository();
    for (const metadata of [
      fixture.root,
      fixture.timestamp,
      fixture.snapshot,
      fixture.targets,
      fixture.delegated.stable,
    ]) {
      expect(validate(JSON.parse(metadata))).toBe(true);
    }
    const unknown = JSON.parse(fixture.root) as { signed: Record<string, unknown> };
    unknown.signed["plugin"] = "forbidden";
    expect(validate(unknown)).toBe(false);

    const delegated = JSON.parse(fixture.delegated.stable) as {
      signed: { targets: Record<string, { custom: Record<string, unknown> }> };
    };
    const requested = delegated.signed.targets[request().targetPath];
    if (requested === undefined) throw new Error("delegated schema fixture target missing");
    delegated.signed.targets["knowledge/stable/z-unrequested.json"] = structuredClone(requested);
    const unrequested = delegated.signed.targets["knowledge/stable/z-unrequested.json"];
    unrequested.custom["unknown"] = true;
    expect(validate(delegated)).toBe(false);
  });

  it("exports the schema while excluding all test key material from the private package payload", async () => {
    const manifest = JSON.parse(await readFile(PACKAGE_JSON, "utf8")) as {
      exports?: Record<string, unknown>;
      files?: string[];
      private?: boolean;
    };
    expect(manifest.private).toBe(true);
    expect(manifest.files).toEqual(["LICENSE", "NOTICE", "bundled", "dist", "schemas"]);
    expect(manifest.exports?.["./schemas/tuf-metadata.v0.schema.json"]).toBe(
      "./schemas/tuf-metadata.v0.schema.json",
    );
    expect(await readFile(PRODUCTION_SOURCE, "utf8")).not.toMatch(
      /PRIVATE KEY|agent-context-lint:H02:NON-PRODUCTION/u,
    );
  });

  it("bootstraps only the self-threshold-verified 2-of-3 out-of-band root", () => {
    const accepted = OfflineTufTrustStore.bootstrap(rootMetadata());
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(accepted.value.snapshot()).toMatchObject({
      contractVersion: "0.1.0",
      repositoryId: "agent-context-standards",
      root: { role: "root", version: 1 },
      timestamp: null,
    });
    expect(Object.isFrozen(accepted.value)).toBe(true);
    expect(Object.isFrozen(accepted.value.snapshot())).toBe(true);
    expect(
      OfflineTufTrustStore.bootstrap(rootMetadata({ signers: KEYS.root.slice(0, 1) })).ok,
    ).toBe(false);
  });

  it("verifies a complete stable update offline with exact parent bindings and returns defensive target bytes", () => {
    const fixture = repository();
    const now = vi.spyOn(Date, "now").mockImplementation(() => {
      throw new Error("ambient clock used");
    });
    const result = bootstrap().verifyUpdate(fixture.bundle, request());
    now.mockRestore();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.target).toMatchObject({
      channel: "stable",
      length: TARGET_BYTES.byteLength,
      minEngineVersion: "0.0.0",
      packId: "agent-context-stable",
      schemaVersion: "0.1.0",
    });
    result.value.targetBytes[0] = 0;
    expect(result.value.state.snapshot().delegated.stable?.sha256).toBe(
      digest(fixture.delegated.stable),
    );
    expect(result.value.state.snapshot().delegated.preview).toBeNull();
  });

  it("applies sequential root rotation under old and new thresholds and resets fast-forward state on online-key rotation", () => {
    const first = repository({
      versions: { delegated: 50, snapshot: 50, targets: 50, timestamp: 50 },
    });
    const trusted = bootstrap().verifyUpdate(first.bundle, request());
    expect(trusted.ok).toBe(true);
    if (!trusted.ok) return;
    const rotatedRoot = rootMetadata({
      rootKeys: KEYS.rootNext,
      signers: [...KEYS.root.slice(0, 2), ...KEYS.rootNext.slice(0, 2)],
      snapshotKeys: KEYS.snapshotNext,
      timestampKeys: KEYS.timestampNext,
      version: 2,
    });
    const recovered = repository({
      root: rotatedRoot,
      snapshotKeys: KEYS.snapshotNext,
      timestampKeys: KEYS.timestampNext,
      versions: { delegated: 1, snapshot: 1, targets: 1, timestamp: 1 },
    });
    const result = trusted.value.state.verifyUpdate(
      { ...recovered.bundle, roots: [rotatedRoot] },
      request(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.recovery).toEqual({
      rootVersionsApplied: [2],
      snapshotAuthorityRotated: true,
      timestampAuthorityRotated: true,
    });
    expect(result.value.state.snapshot().timestamp?.version).toBe(1);
  });

  it("rejects skipped roots and candidates missing either old or new root threshold", () => {
    const skipped = rootMetadata({
      rootKeys: KEYS.rootNext,
      signers: [...KEYS.root.slice(0, 2), ...KEYS.rootNext.slice(0, 2)],
      version: 3,
    });
    const fixture = repository();
    expect(
      issueCode(bootstrap().verifyUpdate({ ...fixture.bundle, roots: [skipped] }, request())),
    ).toBe("root-continuity");

    const noOld = rootMetadata({
      rootKeys: KEYS.rootNext,
      signers: KEYS.rootNext.slice(0, 2),
      version: 2,
    });
    expect(
      issueCode(bootstrap().verifyUpdate({ ...fixture.bundle, roots: [noOld] }, request())),
    ).toBe("invalid-signature");

    const noNew = rootMetadata({
      rootKeys: KEYS.rootNext,
      signers: KEYS.root.slice(0, 2),
      version: 2,
    });
    expect(
      issueCode(bootstrap().verifyUpdate({ ...fixture.bundle, roots: [noNew] }, request())),
    ).toBe("invalid-signature");
  });

  it("requires 2-of-3 delegated signatures and enforces delegated key revocation", () => {
    const oneSigner = repository({ delegatedSigners: KEYS.stable.slice(0, 1) });
    expect(issueCode(bootstrap().verifyUpdate(oneSigner.bundle, request()))).toBe(
      "invalid-signature",
    );

    const revoked = repository({
      delegatedKeys: { preview: KEYS.preview, stable: KEYS.stableNext },
      delegatedSigners: KEYS.stable.slice(0, 2),
    });
    expect(issueCode(bootstrap().verifyUpdate(revoked.bundle, request()))).toBe(
      "invalid-signature",
    );
    const rotated = repository({
      delegatedKeys: { preview: KEYS.preview, stable: KEYS.stableNext },
    });
    expect(bootstrap().verifyUpdate(rotated.bundle, request()).ok).toBe(true);
  });

  it("keeps stable and preview delegations isolated", () => {
    const preview = repository({ channel: "preview" });
    expect(bootstrap().verifyUpdate(preview.bundle, request("preview")).ok).toBe(true);
    expect(issueCode(bootstrap().verifyUpdate(preview.bundle, request("stable")))).toBe(
      "length-mismatch",
    );
    const wrongRequest = {
      ...request("stable"),
      targetPath: "knowledge/preview/agent-context-preview.json",
    };
    expect(issueCode(bootstrap().verifyUpdate(preview.bundle, wrongRequest))).toBe(
      "channel-mismatch",
    );
  });

  it("rejects expired, future-issued, and overlong online metadata using one explicit start time", () => {
    const expired = repository({ expires: { timestamp: START } });
    expect(issueCode(bootstrap().verifyUpdate(expired.bundle, request()))).toBe("expired-metadata");

    const overlongTimestamp = repository({ expires: { timestamp: "2026-08-04T00:00:00Z" } });
    expect(issueCode(bootstrap().verifyUpdate(overlongTimestamp.bundle, request()))).toBe(
      "invalid-policy",
    );

    const fixture = repository();
    const future = replaceSigned(
      fixture.timestamp,
      (signed) => {
        signed["x-agent-context"] = extension("2026-08-03T00:00:00Z");
      },
      KEYS.timestamp,
    );
    const futureBundle = { ...fixture.bundle, timestamp: future };
    expect(issueCode(bootstrap().verifyUpdate(futureBundle, request()))).toBe("invalid-policy");
  });

  it("rejects timestamp replay and snapshot rollback without changing prior trusted state", () => {
    const first = repository();
    const trusted = bootstrap().verifyUpdate(first.bundle, request());
    expect(trusted.ok).toBe(true);
    if (!trusted.ok) return;
    expect(issueCode(trusted.value.state.verifyUpdate(first.bundle, request()))).toBe("replay");
    expect(trusted.value.state.snapshot().timestamp?.version).toBe(1);
  });

  it("rejects mix-and-match metadata and target length or hash changes", () => {
    const fixture = repository();
    expect(
      issueCode(
        bootstrap().verifyUpdate(
          { ...fixture.bundle, snapshot: `${fixture.snapshot} ` },
          request(),
        ),
      ),
    ).toBe("invalid-metadata");
    const truncatedTarget = TARGET_BYTES.subarray(0, TARGET_BYTES.byteLength - 1);
    expect(
      issueCode(
        bootstrap().verifyUpdate({ ...fixture.bundle, target: truncatedTarget }, request()),
      ),
    ).toBe("length-mismatch");
    const changedTarget = new Uint8Array(TARGET_BYTES);
    const firstByte = changedTarget[0];
    if (firstByte === undefined) throw new Error("target fixture must not be empty");
    changedTarget[0] = firstByte ^ 1;
    expect(
      issueCode(bootstrap().verifyUpdate({ ...fixture.bundle, target: changedTarget }, request())),
    ).toBe("hash-mismatch");

    const wrongSnapshotHash = replaceSigned(
      fixture.timestamp,
      (signed) => {
        const meta = signed["meta"] as Record<string, { hashes: { sha256: string } }>;
        const snapshot = meta["snapshot.json"];
        if (snapshot === undefined) throw new Error("timestamp snapshot binding missing");
        snapshot.hashes.sha256 = "0".repeat(64);
      },
      KEYS.timestamp,
    );
    expect(
      issueCode(
        bootstrap().verifyUpdate({ ...fixture.bundle, timestamp: wrongSnapshotHash }, request()),
      ),
    ).toBe("hash-mismatch");

    const wrongSnapshotVersion = replaceSigned(
      fixture.timestamp,
      (signed) => {
        const meta = signed["meta"] as Record<string, { version: number }>;
        const snapshot = meta["snapshot.json"];
        if (snapshot === undefined) throw new Error("timestamp snapshot binding missing");
        snapshot.version = 2;
      },
      KEYS.timestamp,
    );
    expect(
      issueCode(
        bootstrap().verifyUpdate({ ...fixture.bundle, timestamp: wrongSnapshotVersion }, request()),
      ),
    ).toBe("mix-and-match");
  });

  it("rejects an engine below the signed minimum while accepting exact and higher versions", () => {
    const fixture = repository({ minEngineVersion: "2.0.0-rc.1" });
    expect(
      issueCode(bootstrap().verifyUpdate(fixture.bundle, { ...request(), engineVersion: "1.9.9" })),
    ).toBe("incompatible-engine");
    expect(
      bootstrap().verifyUpdate(fixture.bundle, { ...request(), engineVersion: "2.0.0" }).ok,
    ).toBe(true);

    const prereleaseCases = [
      ["2.0.0-alpha.1", "2.0.0-alpha.1", true],
      ["2.0.0-alpha.1", "2.0.0-alpha", false],
      ["2.0.0-alpha.2", "2.0.0-alpha.10", true],
      ["2.0.0-alpha.beta", "2.0.0-alpha.1", false],
      ["2.0.0-alpha.beta", "2.0.0-alpha.gamma", true],
    ] as const;
    for (const [minimum, engine, accepted] of prereleaseCases) {
      const candidate = repository({ minEngineVersion: minimum });
      expect(
        bootstrap().verifyUpdate(candidate.bundle, { ...request(), engineVersion: engine }).ok,
      ).toBe(accepted);
    }

    const exactCases = [
      ["9007199254740993.0.0", "9007199254740992.0.0", false],
      [
        "99999999999999999999999999999999999999.0.0",
        "99999999999999999999999999999999999998.0.0",
        false,
      ],
      [
        "99999999999999999999999999999999999998.0.0",
        "99999999999999999999999999999999999999.0.0",
        true,
      ],
      ["1.0.0-9007199254740993", "1.0.0-9007199254740992", false],
      ["1.0.0-99999999999999999998", "1.0.0-99999999999999999999", true],
      ["2.0.0+signed-build", "2.0.0+caller-build", true],
    ] as const;
    for (const [minimum, engine, accepted] of exactCases) {
      const candidate = repository({ minEngineVersion: minimum });
      expect(
        bootstrap().verifyUpdate(candidate.bundle, { ...request(), engineVersion: engine }).ok,
      ).toBe(accepted);
    }

    const hugeEqualCore = `${"9".repeat(MAX_TUF_SEMVER_BYTES - 4)}.0.0`;
    const hugeEqual = repository({ minEngineVersion: hugeEqualCore });
    expect(
      bootstrap().verifyUpdate(hugeEqual.bundle, {
        ...request(),
        engineVersion: hugeEqualCore,
      }).ok,
    ).toBe(true);
  });

  it("bounds every request string before pattern work and preserves distinct resource failures", () => {
    const fixture = repository();
    const hugeEngine = `${"9".repeat(MAX_TUF_SEMVER_BYTES)}.0.0`;
    const byteLength = vi.spyOn(Buffer, "byteLength");
    expect(
      issueCode(
        bootstrap().verifyUpdate(fixture.bundle, { ...request(), engineVersion: hugeEngine }),
      ),
    ).toBe("resource-limit");
    expect(byteLength.mock.calls.some(([value]) => value === hugeEngine)).toBe(false);
    byteLength.mockRestore();

    const wideEngine = "é".repeat(Math.floor(MAX_TUF_SEMVER_BYTES / 2) + 1);
    expect(
      issueCode(
        bootstrap().verifyUpdate(fixture.bundle, { ...request(), engineVersion: wideEngine }),
      ),
    ).toBe("resource-limit");
    expect(
      issueCode(
        bootstrap().verifyUpdate(fixture.bundle, {
          ...request(),
          channel: "previewx" as TufChannel,
        }),
      ),
    ).toBe("resource-limit");
    expect(
      issueCode(
        bootstrap().verifyUpdate(fixture.bundle, {
          ...request(),
          startedAt: `${START}x`,
        }),
      ),
    ).toBe("resource-limit");
    expect(
      issueCode(
        bootstrap().verifyUpdate(fixture.bundle, {
          ...request(),
          targetPath: "x".repeat(MAX_TUF_TARGET_PATH_BYTES + 1),
        }),
      ),
    ).toBe("resource-limit");
  });

  it("rejects malformed, noncanonical, duplicate, BOM, deep, and oversized metadata before authority use", () => {
    expect(OfflineTufTrustStore.bootstrap(` ${rootMetadata()}`).ok).toBe(false);
    expect(OfflineTufTrustStore.bootstrap('{"signatures":[],"signatures":[],"signed":{}}').ok).toBe(
      false,
    );
    expect(OfflineTufTrustStore.bootstrap(`\uFEFF${rootMetadata()}`).ok).toBe(false);
    expect(OfflineTufTrustStore.bootstrap("[".repeat(65) + "]".repeat(65)).ok).toBe(false);
    expect(OfflineTufTrustStore.bootstrap("x".repeat(MAX_TUF_METADATA_BYTES + 1)).ok).toBe(false);
  });

  it("bounds string ingress before UTF-8 allocation and rejects surrogate replacement aliases", () => {
    const hugeMetadata = "x".repeat(MAX_TUF_METADATA_BYTES + 1);
    const from = vi.spyOn(Buffer, "from");
    const byteLength = vi.spyOn(Buffer, "byteLength");
    expect(OfflineTufTrustStore.bootstrap(hugeMetadata).ok).toBe(false);
    expect(from.mock.calls.some(([value]) => value === hugeMetadata)).toBe(false);
    expect(byteLength.mock.calls.some(([value]) => value === hugeMetadata)).toBe(false);
    const wideMetadata = "é".repeat(Math.floor(MAX_TUF_METADATA_BYTES / 2) + 1);
    expect(OfflineTufTrustStore.bootstrap(wideMetadata).ok).toBe(false);
    expect(byteLength.mock.calls.some(([value]) => value === wideMetadata)).toBe(true);
    expect(from.mock.calls.some(([value]) => value === wideMetadata)).toBe(false);
    from.mockRestore();
    byteLength.mockRestore();

    expect(OfflineTufTrustStore.bootstrap("😀").ok).toBe(false);

    for (const surrogate of ["\ud800", "\udc00"]) {
      expect(OfflineTufTrustStore.bootstrap(`${surrogate}${rootMetadata()}`).ok).toBe(false);
      const fixture = repository();
      expect(
        issueCode(bootstrap().verifyUpdate({ ...fixture.bundle, target: surrogate }, request())),
      ).toBe("invalid-input");
    }

    const fixture = repository();
    const hugeTarget = "x".repeat(MAX_TUF_TARGET_BYTES + 1);
    const targetFrom = vi.spyOn(Buffer, "from");
    const targetByteLength = vi.spyOn(Buffer, "byteLength");
    expect(
      issueCode(bootstrap().verifyUpdate({ ...fixture.bundle, target: hugeTarget }, request())),
    ).toBe("resource-limit");
    expect(targetFrom.mock.calls.some(([value]) => value === hugeTarget)).toBe(false);
    expect(targetByteLength.mock.calls.some(([value]) => value === hugeTarget)).toBe(false);
    targetFrom.mockRestore();
    targetByteLength.mockRestore();
  });

  it("rejects proxies, getters, sparse roots, exotic byte views, and extra byte authority", () => {
    const proxy = new Proxy(repository().bundle, {});
    expect(issueCode(bootstrap().verifyUpdate(proxy, request()))).toBe("invalid-input");

    const accessor = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessor, "timestamp", {
      get: () => {
        throw new Error("must not run");
      },
      enumerable: true,
    });
    expect(
      issueCode(bootstrap().verifyUpdate(accessor as unknown as TufOfflineUpdateBundle, request())),
    ).toBe("invalid-input");

    const fixture = repository();
    const roots = Array(1) as unknown as string[];
    expect(issueCode(bootstrap().verifyUpdate({ ...fixture.bundle, roots }, request()))).toBe(
      "invalid-input",
    );

    class ExoticBytes extends Uint8Array {}
    expect(OfflineTufTrustStore.bootstrap(new ExoticBytes(Buffer.from(rootMetadata()))).ok).toBe(
      false,
    );

    const extra = new Uint8Array(Buffer.from(rootMetadata()));
    Object.defineProperty(extra, "authority", { value: "no" });
    expect(OfflineTufTrustStore.bootstrap(extra).ok).toBe(false);
  });

  it("rejects key-role reuse and wrong root policy identity", () => {
    const parsed = JSON.parse(rootMetadata()) as { signed: Record<string, unknown> };
    const roles = parsed.signed["roles"] as Record<string, { keyids: string[] }>;
    const timestamp = roles["timestamp"];
    const snapshot = roles["snapshot"];
    if (timestamp === undefined || snapshot === undefined)
      throw new Error("root fixture roles missing");
    timestamp.keyids = snapshot.keyids;
    const bad = metadataBytes(
      parsed.signed as Readonly<Record<string, Json>>,
      KEYS.root.slice(0, 2),
    );
    expect(OfflineTufTrustStore.bootstrap(bad).ok).toBe(false);

    const wrongRepository = replaceSigned(
      rootMetadata(),
      (signed) => {
        signed["x-agent-context"] = { ...extension(), repositoryId: "other" };
      },
      KEYS.root.slice(0, 2),
    );
    expect(OfflineTufTrustStore.bootstrap(wrongRepository).ok).toBe(false);
  });

  it("rejects malformed root policy, authority, time, and signature structures", () => {
    const mutations: readonly ((signed: Record<string, unknown>) => void)[] = [
      (signed): void => {
        signed["spec_version"] = "1.0.34";
      },
      (signed): void => {
        const value = signed["x-agent-context"] as Record<string, unknown>;
        value["policyVersion"] = "9.0.0";
      },
      (signed): void => {
        signed["consistent_snapshot"] = false;
      },
      (signed): void => {
        signed["expires"] = "2026-08-01T00:00:00Z";
      },
      (signed): void => {
        signed["expires"] = "2027-08-03T00:00:00Z";
      },
      (signed): void => {
        signed["expires"] = "2026-13-01T00:00:00Z";
      },
      (signed): void => {
        signed["expires"] = "2026-08-01T24:00:00Z";
      },
      (signed): void => {
        signed["version"] = 0;
      },
      (signed): void => {
        signed["extra"] = true;
      },
      (signed): void => {
        const roles = signed["roles"] as Record<string, Record<string, unknown>>;
        const root = roles["root"];
        if (root === undefined) throw new Error("root role missing");
        root["threshold"] = 1;
      },
      (signed): void => {
        const roles = signed["roles"] as Record<string, { keyids: string[] }>;
        const root = roles["root"];
        if (root === undefined) throw new Error("root role missing");
        root.keyids = root.keyids.slice(0, 2);
      },
      (signed): void => {
        const keys = signed["keys"] as Record<string, Record<string, unknown>>;
        const first = keys[Object.keys(keys)[0] ?? ""];
        if (first === undefined) throw new Error("root key missing");
        first["keytype"] = "rsa";
      },
      (signed): void => {
        const keys = signed["keys"] as Record<string, { keyval: { public: string } }>;
        const first = keys[Object.keys(keys)[0] ?? ""];
        if (first === undefined) throw new Error("root key missing");
        first.keyval.public = "not-a-key";
      },
      (signed): void => {
        const keys = signed["keys"] as Record<string, { keyval: { public: string } }>;
        const first = keys[Object.keys(keys)[0] ?? ""];
        if (first === undefined) throw new Error("root key missing");
        first.keyval.public = "0".repeat(64);
      },
      (signed): void => {
        const keys = signed["keys"] as Record<string, unknown>;
        const first = Object.keys(keys)[0];
        if (first === undefined) throw new Error("root key missing");
        signed["keys"] = Object.fromEntries(Object.entries(keys).filter(([id]) => id !== first));
      },
      (signed): void => {
        const roles = signed["roles"] as Record<string, { keyids: string[] }>;
        const root = roles["root"];
        if (root === undefined) throw new Error("root role missing");
        root.keyids = ["0".repeat(64), ...root.keyids.slice(1)].sort();
      },
      (signed): void => {
        signed["keys"] = {};
      },
    ];
    for (const mutate of mutations) {
      expect(
        OfflineTufTrustStore.bootstrap(replaceSigned(rootMetadata(), mutate, KEYS.root.slice(0, 2)))
          .ok,
      ).toBe(false);
    }

    const reversed = JSON.parse(rootMetadata()) as {
      signatures: Record<string, string>[];
      signed: Record<string, unknown>;
    };
    reversed.signatures.reverse();
    expect(OfflineTufTrustStore.bootstrap(canonicalize(reversed)).ok).toBe(false);

    const malformedSignature = JSON.parse(rootMetadata()) as {
      signatures: { keyid: string; sig: string }[];
      signed: Record<string, unknown>;
    };
    const firstSignature = malformedSignature.signatures[0];
    if (firstSignature === undefined) throw new Error("root signature missing");
    firstSignature.sig = "ABC";
    expect(OfflineTufTrustStore.bootstrap(canonicalize(malformedSignature)).ok).toBe(false);

    const tooMany = JSON.parse(rootMetadata()) as {
      signatures: { keyid: string; sig: string }[];
      signed: Record<string, unknown>;
    };
    tooMany.signatures = Array.from({ length: 33 }, (_, index) => ({
      keyid: index.toString(16).padStart(64, "0"),
      sig: "0".repeat(128),
    }));
    expect(OfflineTufTrustStore.bootstrap(canonicalize(tooMany)).ok).toBe(false);
  });

  it("rejects hostile byte containers, JSON values, bundles, root chains, and requests", () => {
    for (const input of [null, 1, "[]", '"metadata"', "{", "}", new Uint8Array([0xff])]) {
      expect(OfflineTufTrustStore.bootstrap(input as string).ok).toBe(false);
    }

    if (typeof SharedArrayBuffer !== "undefined") {
      const shared = new Uint8Array(new SharedArrayBuffer(8));
      expect(OfflineTufTrustStore.bootstrap(shared).ok).toBe(false);
    }

    const fixture = repository();
    const invalidRequests: unknown[] = [
      null,
      { ...request(), channel: "edge" },
      { ...request(), engineVersion: "v1" },
      { ...request(), startedAt: 1 },
      { ...request(), startedAt: "2026-08-02T99:00:00Z" },
      { ...request(), startedAt: "2026-08-02T12:00:00.000Z" },
      { ...request(), targetPath: "../escape" },
      { ...request(), unknown: true },
      Object.assign(Object.create({ inherited: true }), request()),
    ];
    const symbolic = request() as TufOfflineUpdateRequest & Record<symbol, unknown>;
    symbolic[Symbol("authority")] = true;
    invalidRequests.push(symbolic);
    for (const invalid of invalidRequests) {
      expect(bootstrap().verifyUpdate(fixture.bundle, invalid as TufOfflineUpdateRequest).ok).toBe(
        false,
      );
    }

    const bundleWithUnknown = { ...fixture.bundle, unknown: true };
    expect(
      issueCode(bootstrap().verifyUpdate(bundleWithUnknown as TufOfflineUpdateBundle, request())),
    ).toBe("invalid-input");
    expect(
      issueCode(bootstrap().verifyUpdate({ ...fixture.bundle, roots: "root" } as never, request())),
    ).toBe("invalid-input");
    expect(
      issueCode(
        bootstrap().verifyUpdate(
          { ...fixture.bundle, roots: Array.from({ length: 33 }, () => rootMetadata()) },
          request(),
        ),
      ),
    ).toBe("resource-limit");
    expect(
      issueCode(bootstrap().verifyUpdate({ ...fixture.bundle, roots: [1] } as never, request())),
    ).toBe("invalid-input");
  });

  it("rejects delegated policy and target bindings outside their exact authority", () => {
    const fixture = repository();
    const delegatedMutations: readonly ((signed: Record<string, unknown>) => void)[] = [
      (signed): void => {
        signed["targets"] = {};
      },
      (signed): void => {
        const targets = signed["targets"] as Record<string, unknown>;
        const value = targets[request().targetPath];
        signed["targets"] = { "knowledge/preview/escaped.json": value };
      },
      (signed): void => {
        const targets = signed["targets"] as Record<string, Record<string, unknown>>;
        const target = targets[request().targetPath];
        if (target === undefined) throw new Error("target missing");
        const custom = target["custom"] as Record<string, unknown>;
        custom["channel"] = "preview";
      },
      (signed): void => {
        const targets = signed["targets"] as Record<string, Record<string, unknown>>;
        const target = targets[request().targetPath];
        if (target === undefined) throw new Error("target missing");
        const custom = target["custom"] as Record<string, unknown>;
        custom["schemaVersion"] = "9.0.0";
      },
      (signed): void => {
        const targets = signed["targets"] as Record<string, Record<string, unknown>>;
        const target = targets[request().targetPath];
        if (target === undefined) throw new Error("target missing");
        const custom = target["custom"] as Record<string, unknown>;
        custom["minEngineVersion"] = "v1";
      },
      (signed): void => {
        const targets = signed["targets"] as Record<string, Record<string, unknown>>;
        const target = targets[request().targetPath];
        if (target === undefined) throw new Error("target missing");
        const custom = target["custom"] as Record<string, unknown>;
        custom["packId"] = "bad id";
      },
      (signed): void => {
        const targets = signed["targets"] as Record<string, Record<string, unknown>>;
        const target = targets[request().targetPath];
        if (target === undefined) throw new Error("target missing");
        const hashes = target["hashes"] as Record<string, unknown>;
        hashes["sha256"] = "ABC";
      },
    ];
    for (const mutate of delegatedMutations) {
      const delegatedTargets = replaceSigned(
        fixture.delegated.stable,
        mutate,
        KEYS.stable.slice(0, 2),
      );
      expect(
        bootstrap().verifyUpdate(rebindBundle(fixture, { delegatedTargets }), request()).ok,
      ).toBe(false);
    }

    const topLevelMutations: readonly ((signed: Record<string, unknown>) => void)[] = [
      (signed): void => {
        const delegations = signed["delegations"] as { roles: Record<string, unknown>[] };
        const role = delegations.roles[0];
        if (role === undefined) throw new Error("delegated role missing");
        role["terminating"] = false;
      },
      (signed): void => {
        const delegations = signed["delegations"] as { roles: Record<string, unknown>[] };
        const role = delegations.roles[0];
        if (role === undefined) throw new Error("delegated role missing");
        role["paths"] = ["knowledge/stable/*"];
      },
      (signed): void => {
        const delegations = signed["delegations"] as { roles: Record<string, unknown>[] };
        delegations.roles = delegations.roles.slice(0, 1);
      },
      (signed): void => {
        const delegations = signed["delegations"] as { roles: Record<string, unknown>[] };
        const first = delegations.roles[0];
        const second = delegations.roles[1];
        if (first === undefined || second === undefined) throw new Error("delegated roles missing");
        second["name"] = first["name"];
      },
      (signed): void => {
        const delegations = signed["delegations"] as { roles: { keyids: string[] }[] };
        const stable = delegations.roles.find((role) =>
          role.keyids.includes(KEYS.stable[0]?.id ?? ""),
        );
        if (stable === undefined) throw new Error("stable delegated role missing");
        stable.keyids = ["0".repeat(64), ...stable.keyids.slice(1)].sort();
      },
      (signed): void => {
        const delegations = signed["delegations"] as {
          keys: Record<string, Json>;
          roles: { keyids: string[] }[];
        };
        const delegatedKey = KEYS.stable[0];
        const reusedKey = KEYS.targets[0];
        if (delegatedKey === undefined || reusedKey === undefined)
          throw new Error("authority fixture key missing");
        delegations.keys = Object.fromEntries(
          Object.entries(delegations.keys)
            .filter(([id]) => id !== delegatedKey.id)
            .concat([[reusedKey.id, reusedKey.object]])
            .sort(([left], [right]) => left.localeCompare(right)),
        );
        const stable = delegations.roles.find((role) => role.keyids.includes(delegatedKey.id));
        if (stable === undefined) throw new Error("stable delegated role missing");
        stable.keyids = [
          reusedKey.id,
          ...stable.keyids.filter((id) => id !== delegatedKey.id),
        ].sort();
      },
    ];
    for (const mutate of topLevelMutations) {
      const targets = replaceSigned(fixture.targets, mutate, KEYS.targets.slice(0, 2));
      expect(bootstrap().verifyUpdate(rebindBundle(fixture, { targets }), request()).ok).toBe(
        false,
      );
    }

    expect(
      issueCode(
        bootstrap().verifyUpdate(fixture.bundle, {
          ...request(),
          targetPath: "knowledge/stable/missing.json",
        }),
      ),
    ).toBe("target-not-found");

    const futureTimestamp = replaceSigned(
      fixture.timestamp,
      (signed) => {
        signed["x-agent-context"] = extension("2026-08-02T12:06:00Z");
      },
      KEYS.timestamp,
    );
    expect(
      issueCode(
        bootstrap().verifyUpdate({ ...fixture.bundle, timestamp: futureTimestamp }, request()),
      ),
    ).toBe("invalid-policy");
  });

  it("validates every delegated target entry before selecting the requested binding", () => {
    const fixture = repository();
    const invalidEntries = [
      {
        code: "invalid-metadata",
        name: "knowledge/stable/z-unknown-custom.json",
        mutate: (target: Record<string, unknown>): void => {
          const custom = target["custom"] as Record<string, unknown>;
          custom["unknown"] = true;
        },
      },
      {
        code: "channel-mismatch",
        name: "knowledge/stable/z-wrong-channel.json",
        mutate: (target: Record<string, unknown>): void => {
          const custom = target["custom"] as Record<string, unknown>;
          custom["channel"] = "preview";
        },
      },
      {
        code: "resource-limit",
        name: "knowledge/stable/z-oversized-semver.json",
        mutate: (target: Record<string, unknown>): void => {
          const custom = target["custom"] as Record<string, unknown>;
          custom["minEngineVersion"] = `${"9".repeat(MAX_TUF_SEMVER_BYTES)}.0.0`;
        },
      },
      {
        code: "invalid-metadata",
        name: "knowledge/stable/z-malformed.json",
        mutate: (target: Record<string, unknown>): void => {
          delete target["hashes"];
        },
      },
      {
        code: "channel-mismatch",
        name: "knowledge/preview/z-outside-authority.json",
        mutate: (): void => undefined,
      },
      {
        code: "resource-limit",
        name: "x".repeat(MAX_TUF_TARGET_PATH_BYTES + 1),
        mutate: (): void => undefined,
      },
    ] as const;

    for (const invalid of invalidEntries) {
      const delegatedTargets = replaceSigned(
        fixture.delegated.stable,
        (signed) => {
          const targets = signed["targets"] as Record<string, Record<string, unknown>>;
          const requested = targets[request().targetPath];
          if (requested === undefined) throw new Error("requested delegated target missing");
          const extra = structuredClone(requested);
          invalid.mutate(extra);
          targets[invalid.name] = extra;
        },
        KEYS.stable.slice(0, 2),
      );
      expect(
        issueCode(bootstrap().verifyUpdate(rebindBundle(fixture, { delegatedTargets }), request())),
      ).toBe(invalid.code);
    }
  });

  it("never reflects hostile map keys or accessor names in bounded diagnostics", () => {
    const canary = "TOP_SECRET_CANARY";
    const hostileNames = [
      canary,
      `${canary}\r\n\u001b\u202e`,
      `${canary}${"x".repeat(MAX_TUF_ISSUE_PATH_BYTES + 64)}`,
    ];
    for (const hostileName of hostileNames) {
      const parsed = JSON.parse(rootMetadata()) as {
        signed: {
          keys: Record<string, Json>;
          roles: Record<string, { keyids: string[] }>;
        };
      };
      const oldId = Object.keys(parsed.signed.keys)[0];
      if (oldId === undefined) throw new Error("root key fixture missing");
      const key = parsed.signed.keys[oldId];
      if (key === undefined) throw new Error("root key value missing");
      Reflect.deleteProperty(parsed.signed.keys, oldId);
      parsed.signed.keys[hostileName] = key;
      for (const role of Object.values(parsed.signed.roles))
        role.keyids = role.keyids.map((id) => (id === oldId ? hostileName : id)).sort();
      const result = OfflineTufTrustStore.bootstrap(
        metadataBytes(parsed.signed, KEYS.root.slice(0, 2)),
      );
      expectBoundedNonReflectiveIssue(result, canary);
    }

    const fixture = repository();
    const delegatedTargets = replaceSigned(
      fixture.delegated.stable,
      (signed) => {
        const targets = signed["targets"] as Record<string, Record<string, unknown>>;
        const requested = targets[request().targetPath];
        if (requested === undefined) throw new Error("requested delegated target missing");
        targets[`${canary}\u202e`] = structuredClone(requested);
      },
      KEYS.stable.slice(0, 2),
    );
    expectBoundedNonReflectiveIssue(
      bootstrap().verifyUpdate(rebindBundle(fixture, { delegatedTargets }), request()),
      canary,
    );

    const oversizedDelegatedTargets = replaceSigned(
      fixture.delegated.stable,
      (signed) => {
        const targets = signed["targets"] as Record<string, Record<string, unknown>>;
        const requested = targets[request().targetPath];
        if (requested === undefined) throw new Error("requested delegated target missing");
        targets[`${canary}${"x".repeat(MAX_TUF_TARGET_PATH_BYTES)}`] = structuredClone(requested);
      },
      KEYS.stable.slice(0, 2),
    );
    expectBoundedNonReflectiveIssue(
      bootstrap().verifyUpdate(
        rebindBundle(fixture, { delegatedTargets: oversizedDelegatedTargets }),
        request(),
      ),
      canary,
    );

    const accessorRequest = { ...request() } as TufOfflineUpdateRequest & Record<string, unknown>;
    Object.defineProperty(accessorRequest, `${canary}\r\n\u001b\u202e`, {
      enumerable: true,
      get: () => {
        throw new Error("hostile accessor must never execute");
      },
    });
    expectBoundedNonReflectiveIssue(
      bootstrap().verifyUpdate(fixture.bundle, accessorRequest),
      canary,
    );
  });

  it("retains an unchanged unselected delegation across a later channel update", () => {
    const preview = repository({ channel: "preview" });
    const first = bootstrap().verifyUpdate(preview.bundle, request("preview"));
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const stable = repository({
      versions: { delegated: 2, snapshot: 2, targets: 2, timestamp: 2 },
    });
    const bundle = rebindBundle(stable, {
      snapshot: (signed) => {
        const meta = signed["meta"] as Record<string, unknown>;
        meta["standards-preview.json"] = {
          hashes: { sha256: digest(preview.delegated.preview) },
          length: Buffer.byteLength(preview.delegated.preview),
          version: 1,
        };
      },
    });
    const second = first.value.state.verifyUpdate(bundle, request());
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.state.snapshot().delegated.preview?.sha256).toBe(
      digest(preview.delegated.preview),
    );
  });

  it("detects timestamp and snapshot rollback while preserving the trusted state", () => {
    const first = repository({
      versions: { delegated: 2, snapshot: 2, targets: 2, timestamp: 2 },
    });
    const trusted = bootstrap().verifyUpdate(first.bundle, request());
    expect(trusted.ok).toBe(true);
    if (!trusted.ok) return;

    const oldTimestamp = repository({
      versions: { delegated: 2, snapshot: 2, targets: 2, timestamp: 1 },
    });
    expect(issueCode(trusted.value.state.verifyUpdate(oldTimestamp.bundle, request()))).toBe(
      "rollback",
    );

    const oldSnapshotReference = repository({
      versions: { delegated: 2, snapshot: 1, targets: 2, timestamp: 3 },
    });
    expect(
      issueCode(trusted.value.state.verifyUpdate(oldSnapshotReference.bundle, request())),
    ).toBe("rollback");

    const rolledTargets = repository({
      versions: { delegated: 1, snapshot: 3, targets: 1, timestamp: 3 },
    });
    expect(issueCode(trusted.value.state.verifyUpdate(rolledTargets.bundle, request()))).toBe(
      "rollback",
    );
    expect(trusted.value.state.snapshot().timestamp?.version).toBe(2);
  });
});
