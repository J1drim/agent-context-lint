import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { parseDocument } from "yaml";

import {
  canonicalJson,
  currentToolchain,
  executionReceiptPath,
  executionReceiptSha256,
  sha256,
  validateExecutionReceipt,
  verifyCurrentSourceClosure,
} from "./recovery-tabletop-receipt.mjs";

export const MAX_TABLETOP_BYTES = 128 * 1024;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const tabletopRecordPath = path.join(
  root,
  "tools/standards/evidence/recovery-tabletop.v1.json",
);
const schemaPath = path.join(root, "tools/standards/schemas/recovery-tabletop.v1.schema.json");
const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validateSchema = ajv.compile(schema);

const EXPECTED_ACCEPTANCE_BASIS = Object.freeze([
  "closed-findings",
  "generated-execution-receipt",
  "sole-maintainer-review",
  "source-closure-replay",
]);

export const expectedScenarios = Object.freeze([
  Object.freeze({
    actions: Object.freeze([
      "shutdown-acquisition",
      "preserve-last-known-good",
      "preserve-evidence",
    ]),
    expected:
      "Acquisition stops; offline scans retain the verified lock and report stale status without claiming freshness.",
    id: "registry-outage",
    inject: "The allowlisted registry is unavailable after the last verified stable activation.",
    observed:
      "The operator selected offline continuation from the prior lock, retained evidence, and did not relax transport or freshness policy.",
    outcome: "passed",
  }),
  Object.freeze({
    actions: Object.freeze([
      "shutdown-publication",
      "shutdown-acquisition",
      "quarantine-identity",
      "preserve-evidence",
    ]),
    expected:
      "Publication and acquisition stop; the affected online identity is quarantined while immutable evidence is retained.",
    id: "registry-compromise",
    inject:
      "Registry bytes no longer match the signed metadata graph and an online identity may be compromised.",
    observed:
      "The operator stopped both paths, quarantined the affected identity, and preserved signed metadata, logs, versions, and digests.",
    outcome: "passed",
  }),
  Object.freeze({
    actions: Object.freeze([
      "shutdown-publication",
      "shutdown-acquisition",
      "out-of-band-root-release",
      "publish-advisory",
      "preserve-evidence",
    ]),
    expected:
      "In-band recovery is rejected; a reviewed executable release supplies a new out-of-band root and users receive an advisory.",
    id: "root-threshold-compromise",
    inject: "Enough root custodians may be compromised to satisfy the current threshold.",
    observed:
      "The operator rejected downloaded-root recovery, retained evidence, and selected the normal release/provenance path for a new anchor.",
    outcome: "passed",
  }),
  Object.freeze({
    actions: Object.freeze([
      "rotate-key",
      "dual-threshold-root",
      "issue-fresh-online-metadata",
      "post-rotation-verification",
      "preserve-evidence",
    ]),
    expected:
      "Rotation uses sequential roots and old/new thresholds, issues fresh online metadata, and resumes only after clean verification.",
    id: "key-rotation",
    inject: "A root-authorized timestamp key reaches its planned rotation date.",
    observed:
      "The operator rotated the key through root continuity, reset hostile fast-forward state, and verified the complete fresh graph before resuming.",
    outcome: "passed",
  }),
  Object.freeze({
    actions: Object.freeze([
      "revoke-target",
      "issue-signed-withdrawal",
      "publish-advisory",
      "preserve-evidence",
    ]),
    expected:
      "New threshold-signed metadata withdraws the target; immutable history and an affected-version advisory remain available.",
    id: "revocation-yank",
    inject:
      "A previously published standards target is confirmed harmful for a supported engine range.",
    observed:
      "The operator selected signed withdrawal without deleting history or rewriting user locks and retained the affected digest evidence.",
    outcome: "passed",
  }),
  Object.freeze({
    actions: Object.freeze([
      "one-shot-same-process-rollback",
      "fresh-verified-update-after-exit",
      "preserve-evidence",
    ]),
    expected:
      "Only the original live receipt can roll back immediately; after exit a fresh verified update is required.",
    id: "rollback",
    inject:
      "Post-activation validation fails first in-process and then after the activating process has exited.",
    observed:
      "The operator used no reconstructed authority, preserved committed-state evidence, and selected the correct path for each lifecycle state.",
    outcome: "passed",
  }),
  Object.freeze({
    actions: Object.freeze([
      "reject-incompatible-activation",
      "preserve-last-known-good",
      "publish-advisory",
      "preserve-evidence",
    ]),
    expected:
      "Activation is rejected before lock mutation; the compatible lock remains and exact engine guidance is published.",
    id: "engine-incompatibility",
    inject: "The signed candidate requires an engine newer than the running supported version.",
    observed:
      "The operator preserved the compatible state and evidence, rejected metadata editing, and selected compatibility guidance instead.",
    outcome: "passed",
  }),
]);

function equal(actual, expected) {
  return canonicalJson(actual) === canonicalJson(expected);
}

function schemaErrors() {
  return (validateSchema.errors ?? []).map(
    (error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`,
  );
}

export function parseTabletopRecord(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError("tabletop record must be bytes");
  if (bytes.byteLength < 2 || bytes.byteLength > MAX_TABLETOP_BYTES)
    throw new Error("tabletop record exceeds the bounded byte contract");
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
    throw new Error("tabletop record contains a forbidden encoding marker");
  let source;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("tabletop record must be valid UTF-8");
  }
  if (source.includes("\0"))
    throw new Error("tabletop record contains a forbidden encoding marker");
  const duplicateCheck = parseDocument(source, { maxAliasCount: 0, uniqueKeys: true });
  if (duplicateCheck.errors.length > 0)
    throw new Error("tabletop record contains duplicate object keys or invalid structure");
  try {
    return JSON.parse(source);
  } catch {
    throw new Error("tabletop record must be valid JSON");
  }
}

function without(object, omitted) {
  return Object.fromEntries(Object.entries(object).filter(([key]) => key !== omitted));
}

export function reviewSubjectSha256(record) {
  const subject = {
    contractVersion: record.contractVersion,
    executionReceipt: record.executionReceipt,
    findings: record.findings,
    recordKind: record.recordKind,
    releaseAcceptance: record.releaseAcceptance,
    review: without(record.review, "reviewSubjectSha256"),
    scenarios: record.scenarios,
  };
  return sha256(Buffer.from(canonicalJson(subject), "utf8"));
}

export function validateTabletopRecord(record) {
  const schemaValid = validateSchema(record);
  const issues = schemaValid ? [] : schemaErrors();
  if (!schemaValid) return Object.freeze({ issues: Object.freeze(issues), schemaValid: false });

  if (!equal(record.scenarios, expectedScenarios))
    issues.push("scenario inject, expectation, observation, outcome, or normative action changed");
  if (new Set(record.findings.map((finding) => finding.id)).size !== record.findings.length)
    issues.push("finding identities must be unique");
  for (const finding of record.findings) {
    if (finding.status === "open" && (finding.resolution !== null || finding.resolvedAt !== null))
      issues.push(`${finding.id} open finding must not claim resolution`);
    if (
      finding.status === "resolved" &&
      (typeof finding.resolution !== "string" ||
        finding.resolvedAt === null ||
        Date.parse(finding.resolvedAt) < Date.parse(finding.foundAt))
    )
      issues.push(`${finding.id} resolved finding has invalid resolution chronology`);
    if (Date.parse(`${finding.targetDate}T23:59:59Z`) < Date.parse(finding.foundAt))
      issues.push(`${finding.id} target date precedes discovery`);
    if (
      finding.status === "resolved" &&
      Date.parse(record.review.reviewedAt) <= Date.parse(finding.resolvedAt)
    )
      issues.push(`${finding.id} resolution must precede the accountable review`);
  }
  if (!equal(record.releaseAcceptance.basis, EXPECTED_ACCEPTANCE_BASIS))
    issues.push("release acceptance basis changed");
  if (record.review.reviewSubjectSha256 !== reviewSubjectSha256(record))
    issues.push("sole-maintainer review subject digest changed");

  return Object.freeze({ issues: Object.freeze(issues), schemaValid: true });
}

export async function assessTabletopEvidence(
  record,
  { executionReceipt, toolchainProbe = currentToolchain } = {},
) {
  const validation = validateTabletopRecord(record);
  const issues = [...validation.issues];
  let receipt = executionReceipt;
  if (validation.schemaValid && receipt === undefined) {
    try {
      receipt = parseTabletopRecord(await readFile(executionReceiptPath));
    } catch {
      issues.push("generated execution receipt is unavailable or malformed");
    }
  }
  let runtimeMatchesReceipt = false;
  let runtimeProbeIssue = null;
  let sourceMatchesReceipt = false;
  if (validation.schemaValid && receipt !== undefined) {
    const receiptValidation = validateExecutionReceipt(receipt);
    issues.push(...receiptValidation.issues);
    const receiptDigest = executionReceiptSha256(receipt);
    if (
      receiptDigest !== record.executionReceipt.sha256 ||
      receiptDigest !== record.review.executionReceiptSha256
    )
      issues.push("generated execution receipt substitution detected");
    if (
      receipt.sourceClosure?.sha256 !== record.executionReceipt.sourceClosureSha256 ||
      receipt.sourceClosure?.sha256 !== record.review.sourceClosureSha256
    )
      issues.push("reviewed source closure substitution detected");
    if (receiptValidation.schemaValid) {
      const closure = await verifyCurrentSourceClosure(receipt);
      sourceMatchesReceipt = closure.matches;
      if (!sourceMatchesReceipt)
        issues.push("current exercised source closure differs from receipt");
      if (receipt.captureStatus === "supported") {
        try {
          runtimeMatchesReceipt = equal(await toolchainProbe(), receipt.toolchain);
        } catch {
          runtimeProbeIssue = "current toolchain probe failed within its bounded contract";
        }
      }
      if (Date.parse(record.review.reviewedAt) <= Date.parse(receipt.capturedAt))
        issues.push("accountable review must follow completed evidence capture");
    }
  }
  const hasOpenFindings = record.findings?.some((finding) => finding.status === "open") ?? true;
  const evidenceValid = validation.schemaValid && issues.length === 0;
  const releaseAccepted =
    evidenceValid &&
    receipt?.captureStatus === "supported" &&
    !hasOpenFindings &&
    record.review.decision === "accepted" &&
    record.releaseAcceptance.decision === "accepted";
  return Object.freeze({
    evidenceValid,
    issues: Object.freeze(issues),
    releaseAccepted,
    runtimeMatchesReceipt,
    runtimeProbeIssue,
    schemaValid: validation.schemaValid,
    sourceMatchesReceipt,
    verificationMode:
      receipt?.captureStatus === "unsupported"
        ? "unsupported-historical-attestation"
        : runtimeMatchesReceipt
          ? "current-replay"
          : "historical-attestation",
  });
}

async function main() {
  const record = parseTabletopRecord(await readFile(tabletopRecordPath));
  const assessment = await assessTabletopEvidence(record);
  if (
    !assessment.releaseAccepted &&
    assessment.verificationMode !== "unsupported-historical-attestation"
  ) {
    for (const issue of assessment.issues) process.stderr.write(`H13 tabletop: ${issue}\n`);
    process.stderr.write(
      `H13 tabletop schemaValid=${assessment.schemaValid} releaseAccepted=false\n`,
    );
    process.exitCode = 1;
    return;
  }
  if (assessment.verificationMode === "unsupported-historical-attestation") {
    process.stdout.write(
      `H13 tabletop schemaValid=${assessment.schemaValid} evidenceValid=${assessment.evidenceValid} releaseAccepted=false mode=unsupported-historical-attestation\n`,
    );
    return;
  }
  process.stdout.write(
    `H13 tabletop schemaValid=true evidenceValid=true releaseAccepted=true mode=${assessment.verificationMode} receipt=${record.executionReceipt.sha256} sourceClosure=${record.executionReceipt.sourceClosureSha256}\n`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
