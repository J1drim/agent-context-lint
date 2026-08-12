import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(new URL("../../packages/standards/package.json", import.meta.url));
const { canonicalize } = require("@tufjs/canonical-json");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const output = path.join(root, "packages/standards/bundled");
const requested = process.argv.slice(2);
if (requested.length !== 1 || requested[0] !== "--create-new-bootstrap")
  throw new TypeError("usage: generate-bundled-bootstrap.mjs --create-new-bootstrap");
try {
  await stat(output);
  throw new Error(
    "bundled bootstrap already exists; remove only during an explicitly reviewed rotation",
  );
} catch (error) {
  if (error instanceof Error && !error.message.includes("ENOENT")) throw error;
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function key() {
  const pair = generateKeyPairSync("ed25519");
  const publicDer = pair.publicKey.export({ format: "der", type: "spki" });
  const object = {
    keytype: "ed25519",
    keyval: { public: Buffer.from(publicDer).subarray(-32).toString("hex") },
    scheme: "ed25519",
  };
  return { id: digest(canonicalize(object)), object, privateKey: pair.privateKey };
}

function keys(count) {
  return Array.from({ length: count }, key);
}

function keyMap(groups) {
  return Object.fromEntries(
    groups
      .flat()
      .map((item) => [item.id, item.object])
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function signed(signedValue, signers) {
  const bytes = Buffer.from(canonicalize(signedValue));
  return canonicalize({
    signatures: signers
      .map((item) => ({ keyid: item.id, sig: sign(null, bytes, item.privateKey).toString("hex") }))
      .sort((left, right) => left.keyid.localeCompare(right.keyid)),
    signed: signedValue,
  });
}

function extension(issuedAt) {
  return { issuedAt, policyVersion: "0.1.0", repositoryId: "agent-context-standards" };
}

function binding(value, version = 1) {
  return { hashes: { sha256: digest(value) }, length: Buffer.byteLength(value), version };
}

const sourceDigest = "eda3020070376c5cc61d15044b5bfbbd0cdf73267d1d82063bb0659df36add64";
const sourceUrl = "https://agents.md/";
const pack = canonicalize({
  channel: "stable",
  compatibility: [
    {
      adapterVersion: "0.1.0",
      channel: "stable",
      contentDigests: { [sourceUrl]: sourceDigest },
      formatId: "agents-markdown",
      minEngineVersion: "0.0.0",
      profileId: null,
      retrievedAt: "2026-08-02",
      rulesetVersion: "0.1.0",
      specificationUrls: [sourceUrl],
      surfaceId: null,
      upstreamRevision: null,
    },
  ],
  knowledge: [
    {
      id: "knowledge.agents-root-location",
      kind: "known-location",
      location: { path: "AGENTS.md", scope: "repository-root" },
      matcher: { id: "location-exact", operands: { path: "AGENTS.md", scope: "repository-root" } },
      profileId: null,
      ruleIds: ["ACL105"],
      sourceIds: ["source.agents-spec"],
      summary: "AGENTS.md is an instruction-file name at the repository root.",
      surfaceId: null,
    },
  ],
  packId: "agent-context-bundled",
  packVersion: "2026.8.0",
  publishedAt: "2026-08-02",
  recordKind: "agent-context-knowledge-pack",
  schemaVersion: "0.1.0",
  sources: [
    { id: "source.agents-spec", retrievedAt: "2026-08-02", sha256: sourceDigest, url: sourceUrl },
  ],
});

const authority = {
  preview: keys(3),
  root: keys(3),
  snapshot: keys(1),
  stable: keys(3),
  targets: keys(3),
  timestamp: keys(1),
};
const rootMetadata = signed(
  {
    _type: "root",
    consistent_snapshot: true,
    expires: "2027-07-31T00:00:00Z",
    keys: keyMap([authority.root, authority.snapshot, authority.targets, authority.timestamp]),
    roles: {
      root: { keyids: authority.root.map(({ id }) => id).sort(), threshold: 2 },
      snapshot: { keyids: authority.snapshot.map(({ id }) => id), threshold: 1 },
      targets: { keyids: authority.targets.map(({ id }) => id).sort(), threshold: 2 },
      timestamp: { keyids: authority.timestamp.map(({ id }) => id), threshold: 1 },
    },
    spec_version: "1.0.35",
    version: 1,
    "x-agent-context": extension("2026-08-01T00:00:00Z"),
  },
  authority.root.slice(0, 2),
);
const targetPath = "knowledge/stable/agent-context-bundled.json";
const stableMetadata = signed(
  {
    _type: "targets",
    expires: "2026-10-01T00:00:00Z",
    spec_version: "1.0.35",
    targets: {
      [targetPath]: {
        custom: {
          channel: "stable",
          minEngineVersion: "0.0.0",
          packId: "agent-context-bundled",
          packVersion: "2026.8.0",
          schemaVersion: "0.1.0",
        },
        hashes: { sha256: digest(pack) },
        length: Buffer.byteLength(pack),
      },
    },
    version: 1,
    "x-agent-context": extension("2026-08-02T00:00:00Z"),
  },
  authority.stable.slice(0, 2),
);
const previewMetadata = signed(
  {
    _type: "targets",
    expires: "2026-10-01T00:00:00Z",
    spec_version: "1.0.35",
    targets: {
      "knowledge/preview/unavailable.json": {
        custom: {
          channel: "preview",
          minEngineVersion: "9999.0.0",
          packId: "unavailable-preview",
          packVersion: "0.0.0",
          schemaVersion: "0.1.0",
        },
        hashes: { sha256: "0".repeat(64) },
        length: 1,
      },
    },
    version: 1,
    "x-agent-context": extension("2026-08-02T00:00:00Z"),
  },
  authority.preview.slice(0, 2),
);
const targetsMetadata = signed(
  {
    _type: "targets",
    delegations: {
      keys: keyMap([authority.preview, authority.stable]),
      roles: [
        {
          keyids: authority.preview.map(({ id }) => id).sort(),
          name: "standards-preview",
          paths: ["knowledge/preview/*"],
          terminating: true,
          threshold: 2,
        },
        {
          keyids: authority.stable.map(({ id }) => id).sort(),
          name: "standards-stable",
          paths: ["knowledge/stable/*"],
          terminating: true,
          threshold: 2,
        },
      ],
    },
    expires: "2026-10-01T00:00:00Z",
    spec_version: "1.0.35",
    targets: {},
    version: 1,
    "x-agent-context": extension("2026-08-02T00:00:00Z"),
  },
  authority.targets.slice(0, 2),
);
const snapshotMetadata = signed(
  {
    _type: "snapshot",
    expires: "2026-08-09T00:00:00Z",
    meta: {
      "standards-preview.json": binding(previewMetadata),
      "standards-stable.json": binding(stableMetadata),
      "targets.json": binding(targetsMetadata),
    },
    spec_version: "1.0.35",
    version: 1,
    "x-agent-context": extension("2026-08-02T00:00:00Z"),
  },
  authority.snapshot,
);
const timestampMetadata = signed(
  {
    _type: "timestamp",
    expires: "2026-08-03T12:00:00Z",
    meta: { "snapshot.json": binding(snapshotMetadata) },
    spec_version: "1.0.35",
    version: 1,
    "x-agent-context": extension("2026-08-02T12:00:00Z"),
  },
  authority.timestamp,
);

const files = {
  "metadata/root.json": rootMetadata,
  "metadata/snapshot.json": snapshotMetadata,
  "metadata/standards-stable.json": stableMetadata,
  "metadata/targets.json": targetsMetadata,
  "metadata/timestamp.json": timestampMetadata,
  [`packs/sha256-${digest(pack)}.json`]: pack,
};
const fileDescriptor = (filePath) => ({
  length: Buffer.byteLength(files[filePath]),
  path: filePath,
  sha256: digest(files[filePath]),
});
const manifest = canonicalize({
  entries: [
    {
      channel: "stable",
      content: fileDescriptor(`packs/sha256-${digest(pack)}.json`),
      metadata: {
        delegatedTargets: fileDescriptor("metadata/standards-stable.json"),
        root: fileDescriptor("metadata/root.json"),
        snapshot: fileDescriptor("metadata/snapshot.json"),
        targets: fileDescriptor("metadata/targets.json"),
        timestamp: fileDescriptor("metadata/timestamp.json"),
      },
      targetPath,
    },
  ],
  recordKind: "agent-context-bundled-pack-manifest",
  schemaVersion: "0.1.0",
  verificationTime: "2026-08-02T12:00:00Z",
});

await mkdir(output, { recursive: false });
for (const [filePath, text] of Object.entries({ ...files, "manifest.v0.json": manifest })) {
  const destination = path.join(output, filePath);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, text, { encoding: "utf8", flag: "wx", mode: 0o444 });
}
console.log(
  JSON.stringify({ manifestLength: Buffer.byteLength(manifest), manifestSha256: digest(manifest) }),
);
