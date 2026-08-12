import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { link, lstat, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createRequire } from "node:module";

import {
  MAX_DIFF_EVIDENCE_LINE_BYTES,
  MAX_DIFF_EVIDENCE_LINES_PER_SIDE,
  MAX_REVIEW_JSON_BYTES,
  UpstreamReviewError,
  generateUpstreamReviewArtifacts,
  readReviewInput,
  runReviewCli,
  verifyUpstreamReviewArtifacts,
  writeUpstreamReviewArtifacts,
} from "./upstream-review.mjs";
import {
  canonicalJson,
  captureUpstreamSnapshot,
  parseCatalogBytes,
  sha256,
  upstreamCatalogPath,
} from "./upstream-snapshotter.mjs";

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020.js").default;
const addFormats = require("ajv-formats").default;
const fixturePath = path.join(
  process.cwd(),
  "tools/standards/fixtures/h11/golden-document-change.v1.json",
);
const schemasPath = path.join(process.cwd(), "tools/standards/schemas");

function expectCode(error, code) {
  assert.ok(error instanceof UpstreamReviewError);
  assert.equal(error.code, code);
  return true;
}

function escapeHtml(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function validateGoldenFixture(value, catalog) {
  assert.deepEqual(Object.keys(value).sort(), [
    "baselineRetrievedAt",
    "candidateRetrievedAt",
    "changes",
    "schemaVersion",
  ]);
  assert.equal(value.schemaVersion, "1.0.0");
  assert.equal(value.changes.length, catalog.sources.length);
  const sourceIds = new Set();
  for (const change of value.changes) {
    assert.deepEqual(Object.keys(change).sort(), [
      "baselineLines",
      "candidateLines",
      "sectionId",
      "sourceId",
    ]);
    const source = catalog.sources.find(({ id }) => id === change.sourceId);
    assert.ok(source);
    assert.ok(source.sections.some(({ id }) => id === change.sectionId));
    assert.ok(!sourceIds.has(change.sourceId));
    assert.ok(change.baselineLines.length > 0 && change.candidateLines.length > 0);
    sourceIds.add(change.sourceId);
  }
}

function sourceBody(source, fixture, side, overrides = new Map(), appendix = "Stable appendix.") {
  const sections = source.sections.map((section, index) => {
    const key = `${source.id}/${section.id}`;
    const explicit = overrides.get(key);
    const change = fixture.changes.find(
      (entry) => entry.sourceId === source.id && entry.sectionId === section.id,
    );
    const selected =
      explicit ??
      (change === undefined
        ? [`Stable ${source.id}/${section.id} line ${index + 1}.`]
        : change[`${side}Lines`]);
    if (source.format === "html")
      return `<h${section.level}>${escapeHtml(section.heading)}</h${section.level}>${selected.map((line) => `<p>${escapeHtml(line)}</p>`).join("")}<h${Math.min(section.level + 1, 6)}>Nested detail</h${Math.min(section.level + 1, 6)}><p>Stable nested detail.</p>`;
    return `${"#".repeat(section.level)} ${section.heading}\n\n${selected.join("\n")}\n\n${"#".repeat(Math.min(section.level + 1, 6))} Nested detail\n\nStable nested detail.\n\n`;
  });
  if (source.format === "html")
    return Buffer.from(
      `<html><body><h1>${source.id}</h1>${sections.join("")}<h2>Unselected appendix</h2><p>${escapeHtml(appendix)}</p></body></html>`,
    );
  return Buffer.from(
    `# ${source.id}\n\n${sections.join("")}## Unselected appendix\n\n${appendix}\n`,
  );
}

async function goldenContext(options = {}) {
  const catalogBytes = await readFile(upstreamCatalogPath);
  const catalog = parseCatalogBytes(catalogBytes);
  const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
  validateGoldenFixture(fixture, catalog);
  const capture = async (side, retrievedAt, overrides, appendix) =>
    captureUpstreamSnapshot({
      catalogBytes,
      retrievedAt,
      signal: new AbortController().signal,
      transport: {
        async fetch(source) {
          return {
            bytes: sourceBody(source, fixture, side, overrides, appendix),
            mediaType: source.format === "html" ? "text/html" : "text/markdown",
          };
        },
      },
    });
  const baseline = await capture(
    "baseline",
    options.baselineDate ?? fixture.baselineRetrievedAt,
    options.baselineOverrides,
    options.baselineAppendix,
  );
  const candidate = await capture(
    "candidate",
    options.candidateDate ?? fixture.candidateRetrievedAt,
    options.candidateOverrides,
    options.candidateAppendix,
  );
  const inputs = {
    baselineProvenanceBytes: baseline.provenanceBytes,
    baselineSourceBytes: baseline.sourceBytes,
    candidateProvenanceBytes: candidate.provenanceBytes,
    candidateSourceBytes: candidate.sourceBytes,
    catalogBytes,
  };
  return { baseline, candidate, catalog, fixture, inputs };
}

function mutateCanonical(bytes, mutate) {
  const value = JSON.parse(bytes);
  mutate(value);
  return canonicalJson(value);
}

async function writeInputs(directory, context) {
  const paths = {
    baselineProvenance: path.join(directory, "baseline-provenance.json"),
    baselineSource: path.join(directory, "baseline-source.json"),
    candidateProvenance: path.join(directory, "candidate-provenance.json"),
    candidateSource: path.join(directory, "candidate-source.json"),
  };
  await Promise.all([
    writeFile(paths.baselineProvenance, context.baseline.provenanceBytes, { mode: 0o600 }),
    writeFile(paths.baselineSource, context.baseline.sourceBytes, { mode: 0o600 }),
    writeFile(paths.candidateProvenance, context.candidate.provenanceBytes, { mode: 0o600 }),
    writeFile(paths.candidateSource, context.candidate.sourceBytes, { mode: 0o600 }),
  ]);
  return paths;
}

test("golden six-source change produces a deterministic claim-free draft", async () => {
  const context = await goldenContext();
  const first = generateUpstreamReviewArtifacts(context.inputs);
  const second = generateUpstreamReviewArtifacts(context.inputs);
  assert.deepEqual(first.reviewBytes, second.reviewBytes);
  assert.deepEqual(first.scaffoldBytes, second.scaffoldBytes);
  assert.deepEqual(first.markdownBytes, second.markdownBytes);
  assert.deepEqual(
    {
      markdown: sha256(first.markdownBytes),
      review: sha256(first.reviewBytes),
      scaffold: sha256(first.scaffoldBytes),
    },
    {
      markdown: "b0f6ac31018266d7ec0fa114aa759d8ad59fb791284efbe9e34bafb9adbc5021",
      review: "991280ad7f6f78ab3690882a441f162efeea5089cce17977b45dd1fd0735eac4",
      scaffold: "4101ed9092accab88942c554c6ed166813aa057c2fa0e842a7d2e7aef043477d",
    },
  );
  assert.equal(first.reviewArtifact.semanticAssessment, "not-performed");
  assert.equal(first.reviewArtifact.publicationAuthorized, false);
  assert.equal(first.reviewArtifact.summary.changedSectionCount, 6);
  assert.equal(first.reviewArtifact.summary.relevantChangedSourceCount, 6);
  assert.equal(first.scaffoldArtifact.updates.length, 6);
  assert.ok(first.scaffoldArtifact.updates.every((entry) => entry.reviewDecision === "pending"));
  assert.ok(first.scaffoldArtifact.updates.every((entry) => entry.semanticClaims.length === 0));
  assert.ok(first.scaffoldArtifact.updates.every((entry) => entry.fixtureOperations.length === 0));
  assert.match(first.markdownBytes.toString(), /Semantic assessment was not performed/u);
  assert.match(first.markdownBytes.toString(), /Publication authorized: \*\*no\*\*/u);
  assert.ok(!first.markdownBytes.toString().includes("GOLDEN_"));
});

test("review and fixture scaffold satisfy closed published schemas", async () => {
  const generated = generateUpstreamReviewArtifacts((await goldenContext()).inputs);
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  for (const [file, artifact] of [
    ["upstream-review.v1.schema.json", generated.reviewArtifact],
    ["upstream-fixture-scaffold.v1.schema.json", generated.scaffoldArtifact],
  ]) {
    const schema = JSON.parse(await readFile(path.join(schemasPath, file), "utf8"));
    assert.equal(ajv.validate(schema, artifact), true, JSON.stringify(ajv.errors));
    const hostile = structuredClone(artifact);
    hostile.publicationAuthorized = true;
    assert.equal(ajv.validate(schema, hostile), false);
    hostile.publicationAuthorized = false;
    hostile.automaticConclusion = "behavior changed";
    assert.equal(ajv.validate(schema, hostile), false);
  }
});

test("raw-only and identical changes remain distinct from selected text changes", async () => {
  const rawOnly = await goldenContext({
    baselineAppendix: "Before appendix.",
    candidateAppendix: "After appendix.",
    baselineOverrides: new Map(
      (await goldenContext()).catalog.sources.flatMap((source) =>
        source.sections.map((section) => [
          `${source.id}/${section.id}`,
          [`Stable ${source.id}/${section.id}.`],
        ]),
      ),
    ),
    candidateOverrides: new Map(
      (await goldenContext()).catalog.sources.flatMap((source) =>
        source.sections.map((section) => [
          `${source.id}/${section.id}`,
          [`Stable ${source.id}/${section.id}.`],
        ]),
      ),
    ),
  });
  const generated = generateUpstreamReviewArtifacts(rawOnly.inputs);
  assert.equal(generated.reviewArtifact.summary.changedSectionCount, 0);
  assert.equal(generated.reviewArtifact.summary.rawOnlyChangedSourceCount, 6);
  assert.equal(generated.scaffoldArtifact.updates.length, 0);
  assert.ok(
    generated.reviewArtifact.sources.every((source) => source.relevantStatus === "raw-only-change"),
  );
});

test("bounded line evidence caps work and escapes hostile Unicode deterministically", async () => {
  const base = await goldenContext();
  const selectedSource = base.catalog.sources[1];
  const selectedSection = selectedSource.sections[0];
  const key = `${selectedSource.id}/${selectedSection.id}`;
  const baselineLines = Array.from({ length: 100 }, (_, index) => `baseline-${index}`);
  const candidateLines = Array.from(
    { length: 100 },
    (_, index) => `candidate-${index}-${"é".repeat(400)}-\u202e-<script>-\u0001`,
  );
  const context = await goldenContext({
    baselineOverrides: new Map([[key, baselineLines]]),
    candidateOverrides: new Map([[key, candidateLines]]),
  });
  const generated = generateUpstreamReviewArtifacts(context.inputs);
  const section = generated.reviewArtifact.sources[1].sections[0];
  assert.equal(section.diff.evidenceTruncated, true);
  assert.equal(section.diff.baselineEvidence.length, MAX_DIFF_EVIDENCE_LINES_PER_SIDE);
  assert.equal(section.diff.candidateEvidence.length, MAX_DIFF_EVIDENCE_LINES_PER_SIDE);
  assert.ok(section.diff.candidateEvidence.every((entry) => entry.omittedUtf8Bytes > 0));
  assert.ok(
    section.diff.candidateEvidence.every(
      (entry) => Buffer.byteLength(entry.escapedText, "ascii") <= MAX_DIFF_EVIDENCE_LINE_BYTES * 3,
    ),
  );
  assert.ok(!generated.markdownBytes.toString().includes("\u202e"));
  assert.ok(!generated.markdownBytes.includes(0));
  assert.ok([...generated.markdownBytes].every((byte) => byte < 0x80));
});

test("insertions and deletions retain explicit zero-sided bounded evidence", async () => {
  const base = await goldenContext();
  const first = base.catalog.sources[0];
  const second = base.catalog.sources[1];
  const insertionKey = `${first.id}/${first.sections[0].id}`;
  const deletionKey = `${second.id}/${second.sections[0].id}`;
  const context = await goldenContext({
    baselineOverrides: new Map([
      [insertionKey, ["same"]],
      [deletionKey, ["same", "removed"]],
    ]),
    candidateOverrides: new Map([
      [insertionKey, ["same", "added"]],
      [deletionKey, ["same"]],
    ]),
  });
  const generated = generateUpstreamReviewArtifacts(context.inputs);
  const insertion = generated.reviewArtifact.sources[0].sections[0].diff;
  const deletion = generated.reviewArtifact.sources[1].sections[0].diff;
  assert.equal(insertion.baselineChangedLineCount, 0);
  assert.deepEqual(insertion.baselineEvidence, []);
  assert.equal(insertion.candidateChangedLineCount, 1);
  assert.equal(deletion.candidateChangedLineCount, 0);
  assert.deepEqual(deletion.candidateEvidence, []);
  assert.equal(deletion.baselineChangedLineCount, 1);
});

test("offline replay rejects review, scaffold, Markdown, and snapshot tampering", async () => {
  const context = await goldenContext();
  const generated = generateUpstreamReviewArtifacts(context.inputs);
  assert.deepEqual(verifyUpstreamReviewArtifacts({ ...context.inputs, ...generated }), {
    changedSections: 6,
    ok: true,
    reviewArtifactSha256: sha256(generated.reviewBytes),
  });
  for (const mutation of [
    { reviewBytes: Buffer.concat([Buffer.from(" "), generated.reviewBytes]) },
    { scaffoldBytes: mutateCanonical(generated.scaffoldBytes, (value) => value.updates.pop()) },
    { markdownBytes: Buffer.from(`${generated.markdownBytes.toString()}tampered\n`) },
  ]) {
    assert.throws(
      () => verifyUpstreamReviewArtifacts({ ...context.inputs, ...generated, ...mutation }),
      (error) => expectCode(error, "invalid-review"),
    );
  }
  const candidateSourceBytes = mutateCanonical(context.inputs.candidateSourceBytes, (value) => {
    value.sources[0].rawSha256 = "0".repeat(64);
  });
  assert.throws(
    () => generateUpstreamReviewArtifacts({ ...context.inputs, candidateSourceBytes }),
    (error) => expectCode(error, "invalid-snapshot"),
  );
});

test("candidate chronology fails closed without reflecting hostile artifact text", async () => {
  const reversed = await goldenContext({ baselineDate: "2026-08-03", candidateDate: "2026-08-02" });
  assert.throws(
    () => generateUpstreamReviewArtifacts(reversed.inputs),
    (error) => expectCode(error, "invalid-snapshot-order"),
  );
  const candidateSourceBytes = Buffer.from("secret hostile malformed artifact");
  assert.throws(
    () => generateUpstreamReviewArtifacts({ ...reversed.inputs, candidateSourceBytes }),
    (error) => {
      expectCode(error, "invalid-snapshot");
      assert.ok(!error.message.includes("secret"));
      assert.ok(!error.message.includes("hostile"));
      return true;
    },
  );
});

test("safe reader bounds files and rejects symlink and hard-link aliases", async () => {
  const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), "svetovid-review-read-")));
  try {
    const regular = path.join(temporary, "regular.json");
    const symbolic = path.join(temporary, "symbolic.json");
    const hard = path.join(temporary, "hard.json");
    await writeFile(regular, "{}\n", { mode: 0o600 });
    assert.deepEqual(await readReviewInput(regular), Buffer.from("{}\n"));
    await symlink(regular, symbolic);
    await assert.rejects(readReviewInput(symbolic), (error) => expectCode(error, "unsafe-input"));
    await link(regular, hard);
    await assert.rejects(readReviewInput(regular), (error) => expectCode(error, "unsafe-input"));
    await assert.rejects(readReviewInput(hard), (error) => expectCode(error, "unsafe-input"));
    const huge = path.join(temporary, "huge.json");
    await writeFile(huge, Buffer.alloc(MAX_REVIEW_JSON_BYTES + 1, 0x20));
    await assert.rejects(readReviewInput(huge, MAX_REVIEW_JSON_BYTES), (error) =>
      expectCode(error, "resource-limit"),
    );
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
});

test("artifact writer is private, exclusive, canonical-path-only, and locally contained", async () => {
  const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), "svetovid-review-write-")));
  try {
    const generated = generateUpstreamReviewArtifacts((await goldenContext()).inputs);
    const output = path.join(temporary, "review");
    const written = await writeUpstreamReviewArtifacts(output, generated);
    assert.deepEqual(await readFile(written.reviewPath), generated.reviewBytes);
    assert.deepEqual(await readFile(written.scaffoldPath), generated.scaffoldBytes);
    assert.deepEqual(await readFile(written.markdownPath), generated.markdownBytes);
    assert.equal((await lstat(output)).mode & 0o777, 0o700);
    for (const file of Object.values(written))
      assert.equal((await lstat(file)).mode & 0o777, 0o600);
    await assert.rejects(writeUpstreamReviewArtifacts(output, generated), (error) =>
      expectCode(error, "unsafe-output"),
    );
    const linkedParent = path.join(temporary, "linked");
    await symlink(temporary, linkedParent);
    await assert.rejects(
      writeUpstreamReviewArtifacts(path.join(linkedParent, "other"), generated),
      (error) => expectCode(error, "unsafe-output"),
    );
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
});

test("maintainer CLI generates and replays offline without socket or command capability", async () => {
  const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), "svetovid-review-cli-")));
  try {
    const context = await goldenContext();
    const paths = await writeInputs(temporary, context);
    const output = path.join(temporary, "output");
    const arguments_ = [
      "generate",
      "--baseline-source",
      paths.baselineSource,
      "--baseline-provenance",
      paths.baselineProvenance,
      "--candidate-source",
      paths.candidateSource,
      "--candidate-provenance",
      paths.candidateProvenance,
      "--output-dir",
      output,
    ];
    const generatedMessage = await runReviewCli(arguments_);
    assert.match(generatedMessage, /semantic assessment not performed/u);
    assert.ok(!generatedMessage.includes(output));
    const review = path.join(output, "upstream-review.v1.json");
    const scaffold = path.join(output, "upstream-fixture-scaffold.v1.json");
    const markdown = path.join(output, "upstream-review.v1.md");
    assert.match(
      await runReviewCli([
        "verify",
        "--baseline-source",
        paths.baselineSource,
        "--baseline-provenance",
        paths.baselineProvenance,
        "--candidate-source",
        paths.candidateSource,
        "--candidate-provenance",
        paths.candidateProvenance,
        "--review",
        review,
        "--scaffold",
        scaffold,
        "--markdown",
        markdown,
      ]),
      /Verified draft review/u,
    );

    const preloader = path.join(temporary, "deny-capabilities.cjs");
    await writeFile(
      preloader,
      `'use strict';\nconst net = require('node:net');\nconst dns = require('node:dns');\nconst https = require('node:https');\nconst child = require('node:child_process');\nnet.Socket.prototype.connect = function () { throw new Error('network forbidden'); };\ndns.lookup = dns.resolve = function () { throw new Error('dns forbidden'); };\nhttps.request = https.get = function () { throw new Error('https forbidden'); };\nchild.exec = child.execFile = child.spawn = function () { throw new Error('commands forbidden'); };\n`,
      { mode: 0o600 },
    );
    assert.match(
      execFileSync(
        process.execPath,
        [
          "tools/standards/upstream-review.mjs",
          "verify",
          "--baseline-source",
          paths.baselineSource,
          "--baseline-provenance",
          paths.baselineProvenance,
          "--candidate-source",
          paths.candidateSource,
          "--candidate-provenance",
          paths.candidateProvenance,
          "--review",
          review,
          "--scaffold",
          scaffold,
          "--markdown",
          markdown,
        ],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: { ...process.env, NODE_OPTIONS: `--require=${preloader}` },
        },
      ),
      /semantic assessment not performed/u,
    );
    await assert.rejects(runReviewCli(["generate"]), (error) => expectCode(error, "usage"));
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
});

test("argument and byte boundaries fail before filesystem or artifact mutation", async () => {
  const context = await goldenContext();
  for (const invalid of [null, {}, new Uint8Array(0), Buffer.alloc(10 * 1024 * 1024 + 1)])
    assert.throws(
      () => generateUpstreamReviewArtifacts({ ...context.inputs, candidateSourceBytes: invalid }),
      UpstreamReviewError,
    );
  await assert.rejects(readReviewInput(""), (error) => expectCode(error, "invalid-input"));
  await assert.rejects(
    writeUpstreamReviewArtifacts("", generateUpstreamReviewArtifacts(context.inputs)),
    (error) => expectCode(error, "invalid-input"),
  );
});
