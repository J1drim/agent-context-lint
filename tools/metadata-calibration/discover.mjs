#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isCanonicalRepositoryPathForDiscovery } from "../../packages/evidence/built-in-instruction-paths.mjs";

import {
  FORMAT_STRATA,
  calibrationFormatsForPath,
  canonicalJson,
  prettyJson,
  selectCalibrationCorpus,
  validateCandidateSnapshot,
} from "./contracts.mjs";

export const API_BASE_URL = "https://api.github.com";
export const API_VERSION = "2022-11-28";
export const MAXIMUM_REQUESTS = 1024;
export const MAXIMUM_RESPONSE_BYTES = 7 * 1024 * 1024;
export const REQUEST_TIMEOUT_MS = 15_000;
export const SEARCH_QUERIES = Object.freeze([
  Object.freeze({ format: "agents-md", query: "filename:AGENTS.md" }),
  Object.freeze({ format: "claude", query: "filename:CLAUDE.md" }),
  Object.freeze({ format: "copilot", query: "filename:copilot-instructions.md path:.github" }),
  Object.freeze({ format: "cursor", query: "extension:mdc path:.cursor/rules" }),
  Object.freeze({ format: "gemini", query: "filename:GEMINI.md" }),
]);
const DOCUMENTATION = Object.freeze([
  "https://docs.github.com/en/rest/search/search?apiVersion=2022-11-28#search-code",
  "https://docs.github.com/en/rest/repos/repos?apiVersion=2022-11-28#get-a-repository",
  "https://docs.github.com/en/rest/commits/commits?apiVersion=2022-11-28#get-a-commit",
  "https://docs.github.com/en/rest/git/trees?apiVersion=2022-11-28#get-a-tree",
  "https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api?apiVersion=2022-11-28",
  "https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api?apiVersion=2022-11-28",
]);
const CONTENT_FIELD_NAMES = new Set(["content", "text", "text_matches"]);
const MONOREPO_MARKERS = new Set(["lerna.json", "nx.json", "pnpm-workspace.yaml"]);
export const MAXIMUM_TREE_ENTRIES = 100_000;
export const MAXIMUM_TREE_PATH_BYTES = 16 * 1024 * 1024;
const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(MODULE_DIRECTORY, "../..");
const ARTIFACT_DIRECTORY = path.join(REPOSITORY_ROOT, "calibration/metadata/v0");

export class GitHubMetadataResponseLimitError extends Error {
  name = "GitHubMetadataResponseLimitError";
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function assertNoContentFields(value, pointer = "$") {
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries())
      assertNoContentFields(entry, `${pointer}[${String(index)}]`);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if (CONTENT_FIELD_NAMES.has(key))
      throw new Error(`${pointer}.${key} is a forbidden repository-content field`);
    assertNoContentFields(entry, `${pointer}.${key}`);
  }
}

export function createGitHubMetadataClient({ fetchImplementation = globalThis.fetch, token } = {}) {
  if (typeof fetchImplementation !== "function")
    throw new TypeError("fetch implementation is required");
  let requestCount = 0;
  async function request(method, pathname, { query = {} } = {}) {
    if (method !== "GET") throw new Error("metadata client permits only GET");
    if (!pathname.startsWith("/") || pathname.includes("\\") || pathname.includes("\0"))
      throw new Error("GitHub API path is invalid");
    requestCount += 1;
    if (requestCount > MAXIMUM_REQUESTS) throw new Error("GitHub metadata request budget exceeded");
    const url = new URL(pathname, API_BASE_URL);
    if (url.origin !== API_BASE_URL)
      throw new Error("GitHub metadata request escaped the API allowlist");
    if (
      pathname !== "/search/code" &&
      !/^\/repos\/[^/]+\/[^/]+(?:\/commits\/[^/]+|\/git\/trees\/[0-9a-f]{40})?$/.test(pathname)
    )
      throw new Error("GitHub API path is not an approved content-free metadata endpoint");
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response;
    try {
      response = await fetchImplementation(url, {
        headers: {
          Accept: "application/vnd.github+json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          "User-Agent": "agent-context-lint-metadata-calibration/0.1",
          "X-GitHub-Api-Version": API_VERSION,
        },
        method,
        redirect: "error",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
    if ([403, 429].includes(response.status)) {
      const retry = response.headers.get("retry-after");
      const reset = response.headers.get("x-ratelimit-reset");
      throw new Error(
        `GitHub metadata rate limit reached; stop without retry (retry-after=${retry ?? "unknown"}, reset=${reset ?? "unknown"})`,
      );
    }
    if (!response.ok) return { headers: response.headers, status: response.status, value: null };
    const declaredBytes = Number(response.headers.get("content-length") ?? "0");
    if (declaredBytes > MAXIMUM_RESPONSE_BYTES)
      throw new GitHubMetadataResponseLimitError("GitHub metadata response exceeds byte limit");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAXIMUM_RESPONSE_BYTES)
      throw new GitHubMetadataResponseLimitError("GitHub metadata response exceeds byte limit");
    let value;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw new Error("GitHub metadata response is not valid UTF-8 JSON");
    }
    assertNoContentFields(value);
    return { headers: response.headers, status: response.status, value };
  }
  return Object.freeze({
    get: (pathname, options) => request("GET", pathname, options),
    requestCount: () => requestCount,
  });
}

function encodedRepositoryPath(fullName, suffix = "") {
  return `${fullName.split("/").map(encodeURIComponent).join("/")}${suffix}`;
}

export function instructionEvidenceFromTree(apiUrl, treeSha, tree) {
  if (tree?.truncated !== false || !Array.isArray(tree.tree))
    throw new Error("GitHub recursive tree metadata is truncated or malformed");
  if (tree.sha !== treeSha)
    throw new Error("GitHub recursive tree root SHA does not match the requested tree");
  if (tree.tree.length > MAXIMUM_TREE_ENTRIES)
    throw new Error("GitHub recursive tree exceeds the entry limit");
  const seenPaths = new Set();
  const instructionEvidence = [];
  const monorepoEvidencePaths = [];
  let totalPathBytes = 0;
  for (const [index, entry] of tree.tree.entries()) {
    if (entry === null || typeof entry !== "object" || typeof entry.path !== "string")
      throw new Error(`GitHub recursive tree entry ${String(index)} is malformed`);
    const pathname = entry.path;
    totalPathBytes += Buffer.byteLength(pathname, "utf8");
    if (totalPathBytes > MAXIMUM_TREE_PATH_BYTES || pathname.length > 16_384)
      throw new Error("GitHub recursive tree path budget exceeded");
    if (!isCanonicalRepositoryPathForDiscovery(pathname))
      throw new Error("GitHub recursive tree contains a hostile non-canonical path");
    if (seenPaths.has(pathname)) throw new Error("GitHub recursive tree contains a duplicate path");
    seenPaths.add(pathname);
    if (!/^[0-9a-f]{40}$/.test(entry.sha ?? ""))
      throw new Error("GitHub recursive tree entry has an invalid SHA");
    const validModeType =
      (entry.type === "blob" && ["100644", "100755", "120000"].includes(entry.mode)) ||
      (entry.type === "tree" && entry.mode === "040000") ||
      (entry.type === "commit" && entry.mode === "160000");
    if (!validModeType)
      throw new Error("GitHub recursive tree entry has an invalid mode/type combination");
    if (entry.type === "blob" && (!Number.isSafeInteger(entry.size) || entry.size < 0))
      throw new Error("GitHub recursive tree blob entry has an invalid size");
    if (entry.type !== "blob" || entry.mode === "120000") continue;
    if (MONOREPO_MARKERS.has(pathname)) monorepoEvidencePaths.push(pathname);
    for (const format of calibrationFormatsForPath(pathname))
      instructionEvidence.push({
        blobSha: entry.sha,
        format,
        metadataUrl: `${apiUrl}/git/trees/${treeSha}`,
        path: pathname,
      });
  }
  instructionEvidence.sort((left, right) =>
    compareUtf8(`${left.format}\u0000${left.path}`, `${right.format}\u0000${right.path}`),
  );
  monorepoEvidencePaths.sort(compareUtf8);
  return Object.freeze({ instructionEvidence, monorepoEvidencePaths });
}

async function resolveRepository(client, fullName, retrievedAt) {
  const encoded = encodedRepositoryPath(fullName);
  const metadataResponse = await client.get(`/repos/${encoded}`);
  if (metadataResponse.status !== 200) return { exclusion: "repository-metadata-unavailable" };
  const metadata = metadataResponse.value;
  if (
    metadata === null ||
    typeof metadata !== "object" ||
    metadata.private !== false ||
    metadata.visibility !== "public" ||
    metadata.archived !== false ||
    metadata.fork !== false ||
    typeof metadata.default_branch !== "string" ||
    !Number.isInteger(metadata.size) ||
    metadata.size < 10 ||
    metadata.size > 2 * 1024 * 1024
  )
    return { exclusion: "ineligible-repository-metadata" };
  const spdxId = metadata.license?.spdx_id;
  if (typeof spdxId !== "string" || ["NOASSERTION", "OTHER"].includes(spdxId))
    return { exclusion: "unknown-license" };
  const commitResponse = await client.get(
    `/repos/${encoded}/commits/${encodeURIComponent(metadata.default_branch)}`,
  );
  const commitSha = commitResponse.value?.sha;
  if (commitResponse.status !== 200 || !/^[0-9a-f]{40}$/.test(commitSha ?? ""))
    return { exclusion: "default-commit-unavailable" };
  const treeSha = commitResponse.value?.commit?.tree?.sha;
  if (!/^[0-9a-f]{40}$/.test(treeSha ?? "")) return { exclusion: "default-tree-unavailable" };
  let treeResponse;
  try {
    treeResponse = await client.get(`/repos/${encoded}/git/trees/${treeSha}`, {
      query: { recursive: 1 },
    });
  } catch (error) {
    if (error instanceof GitHubMetadataResponseLimitError) return { exclusion: "oversized-tree" };
    throw error;
  }
  if (treeResponse.status !== 200) return { exclusion: "default-tree-unavailable" };
  if (treeResponse.value?.truncated !== false) return { exclusion: "truncated-tree" };
  const { instructionEvidence, monorepoEvidencePaths } = instructionEvidenceFromTree(
    metadata.url,
    treeSha,
    treeResponse.value,
  );
  if (instructionEvidence.length === 0) return { exclusion: "instruction-not-at-pinned-commit" };
  const strata = [...new Set(instructionEvidence.map((entry) => entry.format))].sort(compareUtf8);
  return {
    candidate: {
      apiUrl: metadata.url,
      archived: false,
      defaultBranch: metadata.default_branch,
      diskUsageKiB: metadata.size,
      fork: false,
      fullName: metadata.full_name,
      instructionEvidence,
      license: { metadataUrl: metadata.url, spdxId },
      monorepoEvidencePaths: monorepoEvidencePaths.sort(compareUtf8),
      pinnedCommitSha: commitSha,
      pinnedTreeSha: treeSha,
      primaryLanguage: typeof metadata.language === "string" ? metadata.language : null,
      publicSourceEvidence: {
        basis: "public-github-repository",
        observedAt: retrievedAt,
        url: metadata.html_url,
      },
      pushedAt: metadata.pushed_at,
      repositoryId: String(metadata.id),
      repositoryUrl: metadata.html_url,
      strata,
      traits: {
        monorepository: monorepoEvidencePaths.length > 0,
        multipleInstructionFormats: strata.length > 1,
      },
    },
  };
}

export async function captureCandidateSnapshot({
  client,
  retrievedAt = new Date().toISOString(),
  targetPerSearch = 14,
} = {}) {
  if (client === undefined) throw new TypeError("GitHub metadata client is required");
  if (!Number.isInteger(targetPerSearch) || targetPerSearch < 10 || targetPerSearch > 20)
    throw new RangeError("targetPerSearch must be an integer from 10 through 20");
  const queryRecords = [];
  const searchNamesByFormat = new Map();
  for (const definition of SEARCH_QUERIES) {
    const response = await client.get("/search/code", {
      query: { page: 1, per_page: 100, q: definition.query },
    });
    if (response.status !== 200 || !Array.isArray(response.value?.items))
      throw new Error(`GitHub code metadata search failed for ${definition.format}`);
    if (response.value.incomplete_results !== false)
      throw new Error(`GitHub code metadata search was incomplete for ${definition.format}`);
    const names = [];
    for (const item of response.value.items) {
      const fullName = item.repository?.full_name;
      if (
        typeof fullName !== "string" ||
        typeof item.path !== "string" ||
        typeof item.sha !== "string"
      )
        throw new Error("GitHub code metadata search item has an invalid closed shape");
      if (!names.includes(fullName)) names.push(fullName);
    }
    searchNamesByFormat.set(definition.format, names);
    queryRecords.push({
      format: definition.format,
      incompleteResults: false,
      query: definition.query,
      repositoryResultCount: names.length,
      totalCount: response.value.total_count,
    });
  }
  const candidates = new Map();
  let excludedUnknownLicenseCount = 0;
  let excludedTruncatedTreeCount = 0;
  let excludedOversizedTreeCount = 0;
  for (const format of FORMAT_STRATA) {
    let eligible = 0;
    for (const fullName of searchNamesByFormat.get(format) ?? []) {
      const folded = fullName.toLowerCase();
      if (candidates.has(folded)) {
        if (candidates.get(folded).strata.includes(format)) eligible += 1;
        if (eligible >= targetPerSearch) break;
        continue;
      }
      const resolved = await resolveRepository(client, fullName, retrievedAt);
      if (resolved.exclusion === "unknown-license") excludedUnknownLicenseCount += 1;
      if (resolved.exclusion === "truncated-tree") excludedTruncatedTreeCount += 1;
      if (resolved.exclusion === "oversized-tree") excludedOversizedTreeCount += 1;
      if (resolved.candidate !== undefined) {
        candidates.set(folded, resolved.candidate);
        if (resolved.candidate.strata.includes(format)) eligible += 1;
      }
      if (eligible >= targetPerSearch) break;
    }
    if (eligible < targetPerSearch)
      throw new Error(
        `GitHub search produced only ${String(eligible)} eligible ${format} repositories`,
      );
  }
  const snapshot = {
    candidates: [...candidates.values()].sort((left, right) =>
      compareUtf8(left.fullName.toLowerCase(), right.fullName.toLowerCase()),
    ),
    contractVersion: "0.1.0",
    recordKind: "agent-context-metadata-calibration-candidates",
    retrieval: {
      apiBaseUrl: API_BASE_URL,
      apiVersion: API_VERSION,
      authentication: "authenticated-public-read",
      documentation: [...DOCUMENTATION],
      queries: queryRecords,
      retrievedAt,
      samplingFrame: {
        codeSearchMaximumAccessibleResults: 1000,
        excludedUnknownLicenseCount,
        excludedTruncatedTreeCount,
        excludedOversizedTreeCount,
        firstPageRepositoriesOnly: true,
        pageSize: 100,
        searchIndexSnapshotNotCompletePopulation: true,
        unknownLicensePolicy: "excluded-and-counted",
      },
      transport: {
        httpMethods: ["GET"],
        maximumResponseBytes: MAXIMUM_RESPONSE_BYTES,
        maximumRequests: MAXIMUM_REQUESTS,
        redirects: "error",
        requestConcurrency: 1,
        timeoutMilliseconds: REQUEST_TIMEOUT_MS,
      },
    },
    sourcePolicy: {
      diagnosticOutputInspectedBeforeSelection: false,
      externalMutation: false,
      repositoryContentRetrieved: false,
      repositorySourceRedistributed: false,
    },
  };
  const checked = validateCandidateSnapshot(snapshot);
  if (!checked.valid) throw new Error(checked.errors.join("\n"));
  return snapshot;
}

async function writeFixedArtifact(filename, value) {
  await mkdir(ARTIFACT_DIRECTORY, { recursive: true });
  const rootReal = await realpath(REPOSITORY_ROOT);
  const directoryReal = await realpath(ARTIFACT_DIRECTORY);
  if (!directoryReal.startsWith(`${rootReal}${path.sep}`))
    throw new Error("artifact directory escaped repository root");
  const directoryStat = await lstat(ARTIFACT_DIRECTORY);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink())
    throw new Error("artifact directory is not a real directory");
  const target = path.join(ARTIFACT_DIRECTORY, filename);
  try {
    const targetStat = await lstat(target);
    if (!targetStat.isFile() || targetStat.isSymbolicLink())
      throw new Error("artifact target is not a regular file");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const temp = path.join(
    ARTIFACT_DIRECTORY,
    `.${filename}.${process.pid}.${createHash("sha256").update(canonicalJson(value)).digest("hex").slice(0, 16)}.tmp`,
  );
  let handle;
  try {
    handle = await open(temp, "wx", 0o600);
    await handle.writeFile(prettyJson(value), "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    if ((await realpath(ARTIFACT_DIRECTORY)) !== directoryReal)
      throw new Error("artifact directory changed during write");
    await rename(temp, target);
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temp).catch(() => {});
    throw error;
  }
}

async function main(arguments_) {
  const write = arguments_.includes("--write");
  const acknowledged = arguments_.includes("--acknowledge-reviewed-update");
  if (arguments_.some((entry) => !["--write", "--acknowledge-reviewed-update"].includes(entry)))
    throw new Error("Usage: discover.mjs [--write --acknowledge-reviewed-update]");
  if (write !== acknowledged)
    throw new Error("writing requires --write --acknowledge-reviewed-update together");
  const token = process.env.GITHUB_TOKEN;
  if (typeof token !== "string" || token.length === 0)
    throw new Error("GITHUB_TOKEN is required for bounded authenticated public metadata retrieval");
  const client = createGitHubMetadataClient({ token });
  const snapshot = await captureCandidateSnapshot({ client });
  const corpus = selectCalibrationCorpus(snapshot);
  if (!write) {
    process.stdout.write(
      `${prettyJson({ candidateSnapshotSha256: createHash("sha256").update(canonicalJson(snapshot)).digest("hex"), repositoryCount: corpus.repositories.length, requestCount: client.requestCount() })}`,
    );
    return;
  }
  await writeFixedArtifact("candidate-snapshot.json", snapshot);
  await writeFixedArtifact("corpus.json", corpus);
  process.stdout.write(
    `Wrote ${String(snapshot.candidates.length)} public metadata candidates and ${String(corpus.repositories.length)} selected repositories using ${String(client.requestCount())} GET requests.\n`,
  );
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "metadata capture failed"}\n`);
    process.exitCode = 1;
  }
}
