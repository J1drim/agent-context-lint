import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  MAX_UPSTREAM_ARTIFACT_BYTES,
  UpstreamSnapshotError,
  canonicalJson,
  sha256,
  upstreamCatalogPath,
  verifyUpstreamSnapshot,
} from "./upstream-snapshotter.mjs";

export const UPSTREAM_REVIEW_CONTRACT_VERSION = "1.0.0";
export const UPSTREAM_DIFF_ALGORITHM = "bounded-lines-v1";
export const MAX_DIFF_EVIDENCE_LINES_PER_SIDE = 48;
export const MAX_DIFF_EVIDENCE_LINE_BYTES = 512;
export const MAX_REVIEW_JSON_BYTES = 2 * 1024 * 1024;
export const MAX_REVIEW_MARKDOWN_BYTES = 2 * 1024 * 1024;

const REVIEW_FILE = "upstream-review.v1.json";
const SCAFFOLD_FILE = "upstream-fixture-scaffold.v1.json";
const MARKDOWN_FILE = "upstream-review.v1.md";
const MAX_PATH_CHARACTERS = 4096;
const READ_CHUNK_BYTES = 64 * 1024;

export class UpstreamReviewError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function fail(code, message) {
  throw new UpstreamReviewError(code, message);
}

function snapshotBytes(value, label, maximum) {
  if (
    !(value instanceof Uint8Array) ||
    (Object.getPrototypeOf(value) !== Uint8Array.prototype && !Buffer.isBuffer(value))
  )
    fail("invalid-input", `${label} must be an intrinsic byte array`);
  if (value.byteLength < 1 || value.byteLength > maximum)
    fail("resource-limit", `${label} has an invalid byte length`);
  return Buffer.from(value);
}

function verifiedSnapshot(label, catalogBytes, sourceBytes, provenanceBytes) {
  const source = snapshotBytes(
    sourceBytes,
    `${label} source artifact`,
    MAX_UPSTREAM_ARTIFACT_BYTES,
  );
  const provenance = snapshotBytes(
    provenanceBytes,
    `${label} provenance artifact`,
    MAX_UPSTREAM_ARTIFACT_BYTES,
  );
  let verification;
  try {
    verification = verifyUpstreamSnapshot({
      catalogBytes,
      provenanceBytes: provenance,
      sourceBytes: source,
    });
  } catch (error) {
    if (error instanceof UpstreamSnapshotError)
      fail("invalid-snapshot", `${label} snapshot failed H10 verification`);
    fail("invalid-snapshot", `${label} snapshot could not be verified`);
  }
  return {
    provenance: JSON.parse(provenance.toString("utf8")),
    provenanceBytes: provenance,
    source: JSON.parse(source.toString("utf8")),
    sourceBytes: source,
    verification,
  };
}

function escapedEvidence(text) {
  let includedBytes = 0;
  let escapedText = "";
  for (const character of text) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (includedBytes + characterBytes > MAX_DIFF_EVIDENCE_LINE_BYTES) break;
    includedBytes += characterBytes;
    const point = character.codePointAt(0);
    if (point >= 0x20 && point <= 0x7e) {
      escapedText += character === "\\" ? "\\\\" : character;
    } else {
      escapedText += `\\u{${point.toString(16)}}`;
    }
  }
  const lineUtf8Bytes = Buffer.byteLength(text, "utf8");
  return {
    escapedText,
    lineSha256: sha256(Buffer.from(`${text}\n`, "utf8")),
    lineUtf8Bytes,
    omittedUtf8Bytes: lineUtf8Bytes - includedBytes,
  };
}

function evidenceIndices(length) {
  if (length <= MAX_DIFF_EVIDENCE_LINES_PER_SIDE)
    return Array.from({ length }, (_, index) => index);
  const leading = MAX_DIFF_EVIDENCE_LINES_PER_SIDE / 2;
  return [
    ...Array.from({ length: leading }, (_, index) => index),
    ...Array.from({ length: leading }, (_, index) => length - leading + index),
  ];
}

function lineEvidence(lines, start, end) {
  const length = end - start;
  return evidenceIndices(length).map((relativeIndex) => ({
    line: start + relativeIndex + 1,
    ...escapedEvidence(lines[start + relativeIndex]),
  }));
}

function normalizedLines(text) {
  if (typeof text !== "string" || !text.endsWith("\n"))
    fail("invalid-snapshot", "verified section text is not normalized");
  return text.slice(0, -1).split("\n");
}

function boundedLineDiff(baselineText, candidateText) {
  const baseline = normalizedLines(baselineText);
  const candidate = normalizedLines(candidateText);
  let commonPrefixLines = 0;
  while (
    commonPrefixLines < baseline.length &&
    commonPrefixLines < candidate.length &&
    baseline[commonPrefixLines] === candidate[commonPrefixLines]
  )
    commonPrefixLines += 1;
  let commonSuffixLines = 0;
  while (
    commonSuffixLines < baseline.length - commonPrefixLines &&
    commonSuffixLines < candidate.length - commonPrefixLines &&
    baseline[baseline.length - commonSuffixLines - 1] ===
      candidate[candidate.length - commonSuffixLines - 1]
  )
    commonSuffixLines += 1;

  const baselineEnd = baseline.length - commonSuffixLines;
  const candidateEnd = candidate.length - commonSuffixLines;
  const baselineChangedLineCount = baselineEnd - commonPrefixLines;
  const candidateChangedLineCount = candidateEnd - commonPrefixLines;
  return {
    baselineChangedLineCount,
    baselineEvidence: lineEvidence(baseline, commonPrefixLines, baselineEnd),
    baselineLineCount: baseline.length,
    candidateChangedLineCount,
    candidateEvidence: lineEvidence(candidate, commonPrefixLines, candidateEnd),
    candidateLineCount: candidate.length,
    commonPrefixLines,
    commonSuffixLines,
    evidenceTruncated:
      baselineChangedLineCount > MAX_DIFF_EVIDENCE_LINES_PER_SIDE ||
      candidateChangedLineCount > MAX_DIFF_EVIDENCE_LINES_PER_SIDE,
  };
}

function snapshotReference(snapshot) {
  return {
    provenanceArtifactSha256: sha256(snapshot.provenanceBytes),
    retrievedAt: snapshot.verification.retrievedAt,
    sourceArtifactSha256: snapshot.verification.sourceArtifactSha256,
  };
}

function buildReview(baseline, candidate) {
  if (candidate.verification.retrievedAt < baseline.verification.retrievedAt)
    fail("invalid-snapshot-order", "candidate retrieval date precedes the baseline");
  if (
    baseline.source.catalogSha256 !== candidate.source.catalogSha256 ||
    baseline.provenance.catalogSha256 !== candidate.provenance.catalogSha256
  )
    fail("invalid-snapshot", "snapshot catalogs do not match");

  let changedSectionCount = 0;
  let unchangedSectionCount = 0;
  let relevantChangedSourceCount = 0;
  let rawOnlyChangedSourceCount = 0;
  let unchangedSourceCount = 0;
  const sources = baseline.source.sources.map((baselineSource, sourceIndex) => {
    const candidateSource = candidate.source.sources[sourceIndex];
    if (
      candidateSource === undefined ||
      baselineSource.id !== candidateSource.id ||
      baselineSource.url !== candidateSource.url ||
      baselineSource.sections.length !== candidateSource.sections.length
    )
      fail("invalid-snapshot", "verified snapshot source identities do not align");
    let sourceChanged = false;
    const sections = baselineSource.sections.map((baselineSection, sectionIndex) => {
      const candidateSection = candidateSource.sections[sectionIndex];
      if (
        candidateSection === undefined ||
        baselineSection.id !== candidateSection.id ||
        baselineSection.heading !== candidateSection.heading ||
        baselineSection.level !== candidateSection.level
      )
        fail("invalid-snapshot", "verified snapshot section identities do not align");
      const changed = baselineSection.normalized !== candidateSection.normalized;
      if (changed) {
        sourceChanged = true;
        changedSectionCount += 1;
      } else unchangedSectionCount += 1;
      return {
        baselineSha256: baselineSection.sha256,
        candidateSha256: candidateSection.sha256,
        diff: changed
          ? boundedLineDiff(baselineSection.normalized, candidateSection.normalized)
          : null,
        heading: baselineSection.heading,
        id: baselineSection.id,
        level: baselineSection.level,
        status: changed ? "text-changed" : "unchanged",
      };
    });
    const rawChanged = baselineSource.rawSha256 !== candidateSource.rawSha256;
    let relevantStatus;
    if (sourceChanged) {
      relevantStatus = "selected-text-changed";
      relevantChangedSourceCount += 1;
    } else if (rawChanged) {
      relevantStatus = "raw-only-change";
      rawOnlyChangedSourceCount += 1;
    } else {
      relevantStatus = "unchanged";
      unchangedSourceCount += 1;
    }
    return {
      baselineRawSha256: baselineSource.rawSha256,
      candidateRawSha256: candidateSource.rawSha256,
      id: baselineSource.id,
      rawStatus: rawChanged ? "changed" : "unchanged",
      relevantStatus,
      sections,
      url: baselineSource.url,
    };
  });
  return {
    artifactKind: "upstream-semantic-review-draft",
    baseline: snapshotReference(baseline),
    candidate: snapshotReference(candidate),
    catalogSha256: baseline.source.catalogSha256,
    contractVersion: UPSTREAM_REVIEW_CONTRACT_VERSION,
    diffAlgorithm: UPSTREAM_DIFF_ALGORITHM,
    limits: {
      evidenceLineUtf8Bytes: MAX_DIFF_EVIDENCE_LINE_BYTES,
      evidenceLinesPerSide: MAX_DIFF_EVIDENCE_LINES_PER_SIDE,
    },
    publicationAuthorized: false,
    semanticAssessment: "not-performed",
    sources,
    status: "draft-human-review-required",
    summary: {
      changedSectionCount,
      rawOnlyChangedSourceCount,
      relevantChangedSourceCount,
      unchangedSectionCount,
      unchangedSourceCount,
    },
  };
}

function buildScaffold(review, reviewBytes) {
  const updates = [];
  for (const source of review.sources)
    for (const section of source.sections)
      if (section.status === "text-changed")
        updates.push({
          baselineSectionSha256: section.baselineSha256,
          candidateSectionSha256: section.candidateSha256,
          fixtureOperations: [],
          reviewDecision: "pending",
          sectionId: section.id,
          semanticClaims: [],
          sourceId: source.id,
          url: source.url,
        });
  return {
    artifactKind: "upstream-fixture-update-scaffold",
    baselineSourceArtifactSha256: review.baseline.sourceArtifactSha256,
    candidateSourceArtifactSha256: review.candidate.sourceArtifactSha256,
    contractVersion: UPSTREAM_REVIEW_CONTRACT_VERSION,
    publicationAuthorized: false,
    requirements: [
      "human-semantic-review",
      "owned-synthetic-fixture",
      "profile-conformance-tests",
      "record-provenance-and-unknowns",
    ],
    reviewArtifactSha256: sha256(reviewBytes),
    semanticAssessment: "not-performed",
    status: "draft-unreviewed",
    updates,
  };
}

function markdownEvidence(label, entries) {
  if (entries.length === 0) return [`    ${label}: (no lines)`];
  return entries.map(
    (entry) =>
      `    ${label} L${entry.line} sha256:${entry.lineSha256} bytes:${entry.lineUtf8Bytes} omitted:${entry.omittedUtf8Bytes} ${JSON.stringify(entry.escapedText)}`,
  );
}

function renderMarkdown(review, scaffold, reviewBytes, scaffoldBytes) {
  const lines = [
    "# Upstream standards review draft",
    "",
    "> **Human review required.** Semantic assessment was not performed. The bounded text below is untrusted upstream evidence, not a compatibility, runtime-behavior, deprecation, precedence, activation, field-support, or security conclusion.",
    "",
    `- Review artifact SHA-256: \`${sha256(reviewBytes)}\``,
    `- Fixture scaffold SHA-256: \`${sha256(scaffoldBytes)}\``,
    `- Baseline source artifact: \`${review.baseline.sourceArtifactSha256}\` (${review.baseline.retrievedAt})`,
    `- Candidate source artifact: \`${review.candidate.sourceArtifactSha256}\` (${review.candidate.retrievedAt})`,
    `- Diff algorithm: \`${review.diffAlgorithm}\``,
    `- Selected sections changed: ${review.summary.changedSectionCount}`,
    `- Raw-only source changes: ${review.summary.rawOnlyChangedSourceCount}`,
    "- Publication authorized: **no**",
    "- Fixture operations generated: **none**",
    "",
  ];
  for (const source of review.sources) {
    if (source.relevantStatus === "unchanged") continue;
    lines.push(`## ${source.id}`, "", `Official source: <${source.url}>`, "");
    if (source.relevantStatus === "raw-only-change") {
      lines.push(
        "The raw document changed, but no selected section text changed under the pinned extractor.",
        "",
      );
      continue;
    }
    for (const section of source.sections) {
      if (section.diff === null) continue;
      lines.push(
        `### ${section.id}`,
        "",
        `Heading selector: level ${section.level}, ${JSON.stringify(section.heading)}`,
        "",
        `Baseline section SHA-256: \`${section.baselineSha256}\``,
        "",
        `Candidate section SHA-256: \`${section.candidateSha256}\``,
        "",
        `Common prefix/suffix lines: ${section.diff.commonPrefixLines}/${section.diff.commonSuffixLines}`,
        "",
        ...markdownEvidence("-", section.diff.baselineEvidence),
        ...markdownEvidence("+", section.diff.candidateEvidence),
        "",
      );
      if (section.diff.evidenceTruncated)
        lines.push(
          `Evidence is truncated to ${MAX_DIFF_EVIDENCE_LINES_PER_SIDE} lines per side; use the bound snapshot hashes for complete review.`,
          "",
        );
    }
  }
  lines.push(
    "## Required maintainer decisions",
    "",
    "For every scaffold entry, determine whether documented behavior changed, update only repository-owned synthetic fixtures when justified, preserve unknown or conditional behavior, run profile conformance tests, and use the separate approval-protected publication process. This draft performs none of those actions.",
    "",
  );
  const bytes = Buffer.from(lines.join("\n"), "utf8");
  if (bytes.byteLength > MAX_REVIEW_MARKDOWN_BYTES)
    fail("resource-limit", "review Markdown exceeds its byte limit");
  return bytes;
}

export function generateUpstreamReviewArtifacts({
  baselineProvenanceBytes,
  baselineSourceBytes,
  candidateProvenanceBytes,
  candidateSourceBytes,
  catalogBytes,
}) {
  const catalog = snapshotBytes(catalogBytes, "catalog", MAX_UPSTREAM_ARTIFACT_BYTES);
  const baseline = verifiedSnapshot(
    "baseline",
    catalog,
    baselineSourceBytes,
    baselineProvenanceBytes,
  );
  const candidate = verifiedSnapshot(
    "candidate",
    catalog,
    candidateSourceBytes,
    candidateProvenanceBytes,
  );
  const reviewArtifact = buildReview(baseline, candidate);
  const reviewBytes = canonicalJson(reviewArtifact);
  if (reviewBytes.byteLength > MAX_REVIEW_JSON_BYTES)
    fail("resource-limit", "review artifact exceeds its byte limit");
  const scaffoldArtifact = buildScaffold(reviewArtifact, reviewBytes);
  const scaffoldBytes = canonicalJson(scaffoldArtifact);
  if (scaffoldBytes.byteLength > MAX_REVIEW_JSON_BYTES)
    fail("resource-limit", "fixture scaffold exceeds its byte limit");
  const markdownBytes = renderMarkdown(
    reviewArtifact,
    scaffoldArtifact,
    reviewBytes,
    scaffoldBytes,
  );
  return { markdownBytes, reviewArtifact, reviewBytes, scaffoldArtifact, scaffoldBytes };
}

export function verifyUpstreamReviewArtifacts({
  baselineProvenanceBytes,
  baselineSourceBytes,
  candidateProvenanceBytes,
  candidateSourceBytes,
  catalogBytes,
  markdownBytes,
  reviewBytes,
  scaffoldBytes,
}) {
  const suppliedReview = snapshotBytes(reviewBytes, "review artifact", MAX_REVIEW_JSON_BYTES);
  const suppliedScaffold = snapshotBytes(scaffoldBytes, "fixture scaffold", MAX_REVIEW_JSON_BYTES);
  const suppliedMarkdown = snapshotBytes(
    markdownBytes,
    "review Markdown",
    MAX_REVIEW_MARKDOWN_BYTES,
  );
  const generated = generateUpstreamReviewArtifacts({
    baselineProvenanceBytes,
    baselineSourceBytes,
    candidateProvenanceBytes,
    candidateSourceBytes,
    catalogBytes,
  });
  if (
    !suppliedReview.equals(generated.reviewBytes) ||
    !suppliedScaffold.equals(generated.scaffoldBytes) ||
    !suppliedMarkdown.equals(generated.markdownBytes)
  )
    fail("invalid-review", "offline replay does not reproduce the review artifacts");
  return {
    changedSections: generated.reviewArtifact.summary.changedSectionCount,
    ok: true,
    reviewArtifactSha256: sha256(generated.reviewBytes),
  };
}

function validPathInput(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_PATH_CHARACTERS &&
    !value.includes("\0")
  );
}

function sameMetadata(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

export async function readReviewInput(filePath, maximum = MAX_UPSTREAM_ARTIFACT_BYTES) {
  if (!validPathInput(filePath) || !Number.isSafeInteger(maximum) || maximum < 1)
    fail("invalid-input", "review input path or limit is invalid");
  const selected = path.resolve(filePath);
  let handle;
  try {
    const before = await lstat(selected, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n)
      fail("unsafe-input", "review input must be one unlinked regular file");
    if (before.size < 1n || before.size > BigInt(maximum))
      fail("resource-limit", "review input has an invalid byte length");
    if ((await realpath(selected)) !== selected)
      fail("unsafe-input", "review input path must be canonical and contain no symlink");
    const noFollow = fsConstants.O_NOFOLLOW ?? 0;
    handle = await open(selected, fsConstants.O_RDONLY | noFollow);
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameMetadata(before, opened))
      fail("unsafe-input", "review input changed before it was opened");
    const chunks = [];
    let total = 0;
    while (true) {
      const remaining = maximum + 1 - total;
      if (remaining <= 0) fail("resource-limit", "review input exceeds its byte limit");
      const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, remaining));
      const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      chunks.push(chunk.subarray(0, bytesRead));
    }
    const after = await handle.stat({ bigint: true });
    if (!sameMetadata(opened, after) || (await realpath(selected)) !== selected)
      fail("unsafe-input", "review input changed while it was read");
    if (total < 1 || total > maximum)
      fail("resource-limit", "review input has an invalid byte length");
    return Buffer.concat(chunks, total);
  } catch (error) {
    if (error instanceof UpstreamReviewError) throw error;
    fail("unsafe-input", "review input could not be read safely");
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function writeUpstreamReviewArtifacts(outputDirectory, artifacts) {
  if (!validPathInput(outputDirectory)) fail("invalid-input", "review output path is invalid");
  const reviewBytes = snapshotBytes(
    artifacts.reviewBytes,
    "review artifact",
    MAX_REVIEW_JSON_BYTES,
  );
  const scaffoldBytes = snapshotBytes(
    artifacts.scaffoldBytes,
    "fixture scaffold",
    MAX_REVIEW_JSON_BYTES,
  );
  const markdownBytes = snapshotBytes(
    artifacts.markdownBytes,
    "review Markdown",
    MAX_REVIEW_MARKDOWN_BYTES,
  );
  const selected = path.resolve(outputDirectory);
  const parent = path.dirname(selected);
  try {
    const parentMetadata = await lstat(parent);
    if (
      parentMetadata.isSymbolicLink() ||
      !parentMetadata.isDirectory() ||
      (await realpath(parent)) !== parent
    )
      fail("unsafe-output", "review output parent must be a real canonical directory");
    await mkdir(selected, { mode: 0o700 });
  } catch (error) {
    if (error instanceof UpstreamReviewError) throw error;
    fail("unsafe-output", "review output directory must not already exist");
  }
  try {
    for (const [name, bytes] of [
      [REVIEW_FILE, reviewBytes],
      [SCAFFOLD_FILE, scaffoldBytes],
      [MARKDOWN_FILE, markdownBytes],
    ]) {
      const temporary = path.join(selected, `.${name}.tmp`);
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, path.join(selected, name));
    }
  } catch (error) {
    await rm(selected, { force: true, recursive: true });
    if (error instanceof UpstreamReviewError) throw error;
    fail("unsafe-output", "review artifacts could not be written atomically");
  }
  return {
    markdownPath: path.join(selected, MARKDOWN_FILE),
    reviewPath: path.join(selected, REVIEW_FILE),
    scaffoldPath: path.join(selected, SCAFFOLD_FILE),
  };
}

const GENERATE_ARGUMENTS = [
  "--baseline-source",
  "--baseline-provenance",
  "--candidate-source",
  "--candidate-provenance",
  "--output-dir",
];
const VERIFY_ARGUMENTS = [
  "--baseline-source",
  "--baseline-provenance",
  "--candidate-source",
  "--candidate-provenance",
  "--review",
  "--scaffold",
  "--markdown",
];

function parseArguments(arguments_) {
  const command = arguments_[0];
  const expected =
    command === "generate" ? GENERATE_ARGUMENTS : command === "verify" ? VERIFY_ARGUMENTS : null;
  if (expected === null || arguments_.length !== 1 + expected.length * 2)
    fail("usage", "expected generate or verify with every required artifact path");
  const values = {};
  for (const [index, flag] of expected.entries()) {
    if (arguments_[1 + index * 2] !== flag || !validPathInput(arguments_[2 + index * 2]))
      fail("usage", "review artifact arguments must use the documented fixed order");
    values[flag] = arguments_[2 + index * 2];
  }
  return { command, values };
}

export async function runReviewCli(arguments_) {
  const selected = parseArguments(arguments_);
  const catalogBytes = await readReviewInput(upstreamCatalogPath);
  const common = {
    baselineProvenanceBytes: await readReviewInput(selected.values["--baseline-provenance"]),
    baselineSourceBytes: await readReviewInput(selected.values["--baseline-source"]),
    candidateProvenanceBytes: await readReviewInput(selected.values["--candidate-provenance"]),
    candidateSourceBytes: await readReviewInput(selected.values["--candidate-source"]),
    catalogBytes,
  };
  if (selected.command === "verify") {
    const result = verifyUpstreamReviewArtifacts({
      ...common,
      markdownBytes: await readReviewInput(
        selected.values["--markdown"],
        MAX_REVIEW_MARKDOWN_BYTES,
      ),
      reviewBytes: await readReviewInput(selected.values["--review"], MAX_REVIEW_JSON_BYTES),
      scaffoldBytes: await readReviewInput(selected.values["--scaffold"], MAX_REVIEW_JSON_BYTES),
    });
    return `Verified draft review ${result.reviewArtifactSha256} with ${result.changedSections} changed sections; semantic assessment not performed.\n`;
  }
  const artifacts = generateUpstreamReviewArtifacts(common);
  await writeUpstreamReviewArtifacts(selected.values["--output-dir"], artifacts);
  return `Generated draft review for ${artifacts.reviewArtifact.summary.changedSectionCount} changed sections; semantic assessment not performed. Fixed review, scaffold, and Markdown files were written to the selected new directory.\n`;
}

const invoked =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invoked) {
  try {
    process.stdout.write(await runReviewCli(process.argv.slice(2)));
  } catch (error) {
    const message =
      error instanceof UpstreamReviewError
        ? `${error.code}: ${error.message}`
        : "unexpected-failure: review generator failed closed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
