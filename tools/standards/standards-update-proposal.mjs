import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const STANDARDS_UPDATE_PROPOSAL_CONTRACT_VERSION = "1.0.0";
export const PROPOSAL_RECORD_KIND = "agent-context-standards-update-proposal";
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_INPUT_BYTES = 10 * 1024 * 1024;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;

export class StandardsUpdateProposalError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "StandardsUpdateProposalError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new StandardsUpdateProposalError(code, message);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalJson(value) {
  const encode = (entry) => {
    if (entry === null || typeof entry === "boolean" || typeof entry === "string")
      return JSON.stringify(entry);
    if (typeof entry === "number") {
      if (!Number.isSafeInteger(entry))
        fail("invalid-input", "canonical numbers must be safe integers");
      return String(entry);
    }
    if (Array.isArray(entry)) return `[${entry.map(encode).join(",")}]`;
    if (entry !== null && typeof entry === "object") {
      const prototype = Object.getPrototypeOf(entry);
      if (prototype !== Object.prototype && prototype !== null)
        fail("invalid-input", "canonical objects must be plain data");
      return `{${Object.keys(entry)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${encode(entry[key])}`)
        .join(",")}}`;
    }
    fail("invalid-input", "canonical JSON contains an unsupported value");
  };
  return Buffer.from(`${encode(value)}\n`, "utf8");
}

function parseJson(bytes, label) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > MAX_INPUT_BYTES)
    fail("resource-limit", `${label} exceeds the bounded input size`);
  let value;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    fail("invalid-input", `${label} is not valid UTF-8 JSON`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value))
    fail("invalid-input", `${label} must be a JSON object`);
  return value;
}

function integer(value, label) {
  if (!Number.isSafeInteger(value) || value < 0)
    fail("invalid-input", `${label} must be a non-negative integer`);
  return value;
}

function validateReview(value) {
  if (value.status !== "draft-human-review-required")
    fail("invalid-input", "review status must remain draft-human-review-required");
  if (value.semanticAssessment !== "not-performed")
    fail("invalid-input", "review semantic assessment must remain not-performed");
  if (value.publicationAuthorized !== false)
    fail("invalid-input", "review publication must remain unauthorized");
  const summary = value.summary;
  if (summary === null || typeof summary !== "object" || Array.isArray(summary))
    fail("invalid-input", "review summary is missing");
  return {
    changedSectionCount: integer(summary.changedSectionCount, "review summary changedSectionCount"),
    rawOnlyChangedSourceCount: integer(
      summary.rawOnlyChangedSourceCount,
      "review summary rawOnlyChangedSourceCount",
    ),
    reviewSourceArtifactSha256: value.candidate?.sourceArtifactSha256,
  };
}

function validateDigest(value, label) {
  if (typeof value !== "string" || !SHA256.test(value))
    fail("invalid-input", `${label} is not a SHA-256 digest`);
  return value;
}

function validatePath(value, label) {
  if (typeof value !== "string" || value.length < 1 || value.length > 1024 || value.includes("\0"))
    fail("invalid-input", `${label} is not a valid path`);
  return path.resolve(value);
}

async function readBounded(file, label) {
  const selected = validatePath(file, label);
  const bytes = await readFile(selected);
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_INPUT_BYTES)
    fail("resource-limit", `${label} exceeds the bounded input size`);
  return bytes;
}

function bodyText({ review, manifestDigest }) {
  const lines = [
    "# Local standards update proposal",
    "",
    "> This is a draft evidence change. Semantic interpretation was not performed and no linter rule or standards pack is activated by this change.",
    "",
    `- Candidate source artifact: \`${review.reviewSourceArtifactSha256}\``,
    `- Proposal manifest: \`${manifestDigest}\``,
    `- Changed selected sections: ${String(review.changedSectionCount)}`,
    `- Raw-only source changes: ${String(review.rawOnlyChangedSourceCount)}`,
    "",
    "A maintainer must inspect the verified upstream snapshot, decide whether documented behavior changed, update repository-owned rules or fixtures separately when justified, and run the affected conformance tests. This local proposal tool does not publish, activate, or write a standards pack.",
    "",
    "The full bounded source/provenance and review artifacts are retained in the selected local output directory. They are untrusted documentation evidence and must not be executed or treated as client behavior without review.",
    "",
  ];
  const text = lines.join("\n");
  if (Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES)
    fail("resource-limit", "pull-request body exceeds the bounded text size");
  return text;
}

/**
 * Stage a deterministic, review-only proposal from already verified H11 artifacts.
 * The function intentionally does not copy raw upstream source bytes into the repository.
 */
export async function prepareStandardsUpdateProposal({
  reviewBytes,
  scaffoldBytes,
  markdownBytes,
  outputDirectory,
}) {
  const review = parseJson(reviewBytes, "review artifact");
  const scaffold = parseJson(scaffoldBytes, "fixture scaffold");
  const reviewSummary = validateReview(review);
  if (scaffold.status !== "draft-unreviewed" || scaffold.publicationAuthorized !== false)
    fail("invalid-input", "fixture scaffold is not an unreviewed, unauthorized draft");
  if (
    !(markdownBytes instanceof Uint8Array) ||
    markdownBytes.byteLength < 1 ||
    markdownBytes.byteLength > MAX_INPUT_BYTES
  )
    fail("resource-limit", "review Markdown exceeds the bounded input size");
  validateDigest(reviewSummary.reviewSourceArtifactSha256, "candidate source artifact");

  const changed =
    reviewSummary.changedSectionCount > 0 || reviewSummary.rawOnlyChangedSourceCount > 0;
  if (!changed) return Object.freeze({ changed: false, outputDirectory: null });

  const output = validatePath(outputDirectory, "outputDirectory");
  await mkdir(output, { recursive: true });
  const reviewFile = Buffer.from(reviewBytes);
  const scaffoldFile = Buffer.from(scaffoldBytes);
  const markdownFile = Buffer.from(markdownBytes);
  const reviewDigest = sha256(reviewFile);
  const scaffoldDigest = sha256(scaffoldFile);
  const markdownDigest = sha256(markdownFile);
  const manifest = canonicalJson({
    contractVersion: STANDARDS_UPDATE_PROPOSAL_CONTRACT_VERSION,
    markdownSha256: markdownDigest,
    publicationAuthorized: false,
    recordKind: PROPOSAL_RECORD_KIND,
    reviewSha256: reviewDigest,
    scaffoldSha256: scaffoldDigest,
    semanticAssessment: "not-performed",
    status: "draft-human-review-required",
  });
  const manifestDigest = sha256(manifest);
  const body = Buffer.from(
    bodyText({
      review: reviewSummary,
      manifestDigest,
    }),
    "utf8",
  );
  await Promise.all([
    writeFile(path.join(output, "upstream-review.v1.json"), reviewFile, { mode: 0o644 }),
    writeFile(path.join(output, "upstream-fixture-scaffold.v1.json"), scaffoldFile, {
      mode: 0o644,
    }),
    writeFile(path.join(output, "upstream-review.v1.md"), markdownFile, { mode: 0o644 }),
    writeFile(path.join(output, "proposal-manifest.v1.json"), manifest, { mode: 0o644 }),
    writeFile(path.join(output, "pull-request-body.md"), body, { mode: 0o644 }),
  ]);
  return Object.freeze({ changed: true, outputDirectory: output, manifestSha256: manifestDigest });
}

function parseArguments(argumentsList) {
  const values = new Map();
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (!argument?.startsWith("--") || index + 1 >= argumentsList.length)
      fail("usage", "every option requires one value");
    const value = argumentsList[index + 1];
    if (value.startsWith("--") || values.has(argument))
      fail("usage", "options must be unique and ordered as pairs");
    values.set(argument, value);
    index += 1;
  }
  const expected = ["--review", "--scaffold", "--markdown", "--output-dir"];
  if (values.size !== expected.length || expected.some((key) => !values.has(key)))
    fail("usage", `usage: standards-update-proposal.mjs ${expected.join(" <value> ")}`);
  return values;
}

export async function runProposalCli(argumentsList) {
  const values = parseArguments(argumentsList);
  const [reviewBytes, scaffoldBytes, markdownBytes] = await Promise.all([
    readBounded(values.get("--review"), "review artifact"),
    readBounded(values.get("--scaffold"), "fixture scaffold"),
    readBounded(values.get("--markdown"), "review Markdown"),
  ]);
  const result = await prepareStandardsUpdateProposal({
    reviewBytes,
    scaffoldBytes,
    markdownBytes,
    outputDirectory: values.get("--output-dir"),
  });
  return result;
}

const invoked =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invoked) {
  try {
    const result = await runProposalCli(process.argv.slice(2));
    process.stdout.write(result.changed ? "changed\n" : "unchanged\n");
  } catch (error) {
    const message =
      error instanceof StandardsUpdateProposalError
        ? error.message
        : "standards proposal failed closed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
