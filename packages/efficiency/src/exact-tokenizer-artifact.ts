import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

export const EXACT_TOKENIZER_MAX_ARTIFACT_TEXT_BYTES = 33_554_432 as const;

export interface ArtifactRecord {
  readonly artifact: ArrayBuffer;
  readonly status: "available";
}

export type ArtifactLoadResult = ArtifactRecord | { readonly status: "invalid" | "unavailable" };

const MANIFEST_MAX_BYTES = 4_096;
const OPTIONAL_UTF8_BYTE_PROVIDER_ID = "optional:utf8-byte";
const TOKENIZER_PLUGIN_CONTRACT_VERSION = "1.0.0";
const UTF8_BYTE_PACKAGE = "@agent-context/tokenizer-utf8-byte";
const UTF8_BYTE_MANIFEST_SPECIFIER = `${UTF8_BYTE_PACKAGE}/manifest.v1.json`;
const UTF8_BYTE_ARTIFACT_SPECIFIER = `${UTF8_BYTE_PACKAGE}/provider.wasm.b64`;
const UTF8_BYTE_MANIFEST_SHA256 =
  "6b07fd8d56cd45aa939cedf1b065611191c5403750d2a6e030a011cdc42c7705";
const UTF8_BYTE_ARTIFACT_SHA256 =
  "7bc6247983e4fbd1eaa3cbd92600448d952aac151e79c5b4b87002347742fb26";

async function resolveLogicalPackageFile(
  require: NodeJS.Require,
  specifier: string,
  filename: string,
): Promise<string | undefined> {
  const resolved = require.resolve(specifier);
  const searchRoots = require.resolve.paths(UTF8_BYTE_PACKAGE);
  if (searchRoots === null) return undefined;
  for (const searchRoot of searchRoots) {
    const candidate = path.join(searchRoot, "@agent-context", "tokenizer-utf8-byte", filename);
    try {
      if ((await lstat(candidate)).isSymbolicLink()) return candidate;
      const canonicalCandidate = await realpath(candidate);
      if (resolved === candidate || resolved === canonicalCandidate) return candidate;
    } catch {
      // Continue through Node's deterministic lookup roots without reflecting filesystem details.
    }
  }
  return undefined;
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readBoundedRegularFile(
  filePath: string,
  maximumBytes: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  const pathMetadata = await lstat(filePath);
  if (!pathMetadata.isFile()) throw new TypeError("invalid artifact path");
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const nonBlocking = typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0;
  const handle = await open(filePath, constants.O_RDONLY | noFollow | nonBlocking);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > maximumBytes) {
      throw new TypeError("invalid artifact file");
    }
    const bytes = Buffer.alloc(metadata.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      if (signal?.aborted === true) throw new TypeError("artifact read cancelled");
      const length = Math.min(65_536, bytes.length - offset);
      const result = await handle.read(bytes, offset, length, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    if (offset !== metadata.size || offset > maximumBytes) {
      throw new TypeError("unstable artifact file");
    }
    return bytes.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

function exactManifestMatches(bytes: Buffer): boolean {
  if (digest(bytes) !== UTF8_BYTE_MANIFEST_SHA256) return false;
  try {
    const value = JSON.parse(bytes.toString("utf8")) as unknown;
    return (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      JSON.stringify(value) ===
        JSON.stringify({
          schemaVersion: 1,
          contractVersion: TOKENIZER_PLUGIN_CONTRACT_VERSION,
          providerId: OPTIONAL_UTF8_BYTE_PROVIDER_ID,
          identity: { id: "utf8.byte", measurement: "exact", version: "1.0.0" },
          artifact: {
            abi: "agent-context-tokenizer-wasm-v1",
            encoding: "base64",
            sha256: UTF8_BYTE_ARTIFACT_SHA256,
          },
        })
    );
  } catch {
    return false;
  }
}

function decodeCanonicalBase64(bytes: Buffer): Uint8Array | undefined {
  if (bytes.length < 5 || bytes.at(-1) !== 0x0a || (bytes.length - 1) % 4 !== 0) {
    return undefined;
  }
  const encodedLength = bytes.length - 1;
  for (let index = 0; index < encodedLength; index += 1) {
    const byte = bytes.readUInt8(index);
    const alphabet =
      (byte >= 0x41 && byte <= 0x5a) ||
      (byte >= 0x61 && byte <= 0x7a) ||
      (byte >= 0x30 && byte <= 0x39) ||
      byte === 0x2b ||
      byte === 0x2f;
    const padding = byte === 0x3d && index >= encodedLength - 2;
    if (!alphabet && !padding) return undefined;
  }
  const text = bytes.toString("ascii");
  const decoded = Buffer.from(text.slice(0, -1), "base64");
  if (`${decoded.toString("base64")}\n` !== text) return undefined;
  return decoded;
}

/** Load a release-owned data-only provider after bounded path and digest validation. */
export async function loadExactTokenizerArtifact(
  providerId: string,
  resolutionBaseUrl: string,
  signal?: AbortSignal,
): Promise<ArtifactLoadResult> {
  if (providerId !== OPTIONAL_UTF8_BYTE_PROVIDER_ID) return { status: "unavailable" };
  let manifestPath: string;
  let artifactPath: string;
  try {
    const require = createRequire(resolutionBaseUrl);
    const resolvedManifest = await resolveLogicalPackageFile(
      require,
      UTF8_BYTE_MANIFEST_SPECIFIER,
      "manifest.v1.json",
    );
    const resolvedArtifact = await resolveLogicalPackageFile(
      require,
      UTF8_BYTE_ARTIFACT_SPECIFIER,
      "provider.wasm.b64",
    );
    if (resolvedManifest === undefined || resolvedArtifact === undefined) {
      return { status: "unavailable" };
    }
    manifestPath = resolvedManifest;
    artifactPath = resolvedArtifact;
  } catch {
    return { status: "unavailable" };
  }
  try {
    const [manifest, encodedArtifact] = await Promise.all([
      readBoundedRegularFile(manifestPath, MANIFEST_MAX_BYTES, signal),
      readBoundedRegularFile(artifactPath, EXACT_TOKENIZER_MAX_ARTIFACT_TEXT_BYTES, signal),
    ]);
    const artifact = decodeCanonicalBase64(encodedArtifact);
    if (
      !exactManifestMatches(manifest) ||
      artifact === undefined ||
      digest(artifact) !== UTF8_BYTE_ARTIFACT_SHA256
    ) {
      return { status: "invalid" };
    }
    return Object.freeze({ artifact: Uint8Array.from(artifact).buffer, status: "available" });
  } catch {
    return { status: "invalid" };
  }
}
