import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

import {
  OFFICIAL_CORPUS_MAX_FILE_BYTES,
  validateOfficialExampleCorpus,
} from "./validate-official-example-corpus.mjs";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CORPUS_PATH = "conformance/official-examples/v0/corpus.json";
const TOOL = path.join(REPOSITORY_ROOT, "tools/conformance/validate-official-example-corpus.mjs");
const temporaryPaths = [];

after(() => {
  for (const value of temporaryPaths) rmSync(value, { force: true, recursive: true });
});

function load(relative = CORPUS_PATH) {
  return JSON.parse(readFileSync(path.join(REPOSITORY_ROOT, ...relative.split("/")), "utf8"));
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function referencedPaths(corpus) {
  const review = load("conformance/observations/v0/d16/review.json");
  return new Set([
    "conformance/contracts/official-example-conformance-corpus.v0.schema.json",
    "conformance/contracts/ga-profile-observation-review.v0.schema.json",
    "conformance/contracts/real-client-observation-plan.v0.schema.json",
    "conformance/contracts/real-client-observation-transcript.v0.schema.json",
    corpus.inventory.path,
    corpus.observationReview.path,
    corpus.review.procedurePath,
    ...corpus.fixtures.map((fixture) => fixture.path),
    review.inventory.path,
    ...review.entries.flatMap((entry) => [
      entry.plan.path,
      entry.transcript.path,
      ...entry.fixtures.map((reference) => reference.path),
      ...entry.supportingEvidence.map((reference) => reference.path),
    ]),
  ]);
}

function materialize(corpus = load()) {
  const root = mkdtempSync(path.join(os.tmpdir(), "official-example-corpus-"));
  temporaryPaths.push(root);
  for (const relative of referencedPaths(corpus)) {
    const destination = path.join(root, ...relative.split("/"));
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(path.join(REPOSITORY_ROOT, ...relative.split("/")), destination);
  }
  return { corpus, root };
}

function rewriteFixture(corpus, root, fixtureIndex, mutate) {
  const reference = corpus.fixtures[fixtureIndex];
  const absolute = path.join(root, ...reference.path.split("/"));
  const fixture = JSON.parse(readFileSync(absolute, "utf8"));
  mutate(fixture);
  const bytes = Buffer.from(`${JSON.stringify(fixture, null, 2)}\n`);
  writeFileSync(absolute, bytes);
  reference.sha256 = digest(bytes);
  return fixture;
}

function errorsFor(corpus, repositoryRoot = REPOSITORY_ROOT, asOf = undefined) {
  return validateOfficialExampleCorpus(corpus, { asOf, repositoryRoot });
}

test("canonical corpus proves both polarities for all 22 GA capabilities", () => {
  const corpus = load();
  assert.deepEqual(errorsFor(corpus), []);
  assert.equal(corpus.capabilities.length, 22);
  assert.equal(corpus.fixtures.length, 14);
  assert.equal(new Set(corpus.capabilities.map((entry) => entry.surfaceId)).size, 7);
  assert.ok(corpus.capabilities.every((entry) => entry.positive && entry.negative));
});

test("validation is deterministic and does not mutate caller data", () => {
  const corpus = load();
  const snapshot = structuredClone(corpus);
  assert.deepEqual(errorsFor(corpus), errorsFor(structuredClone(corpus)));
  assert.deepEqual(corpus, snapshot);
});

test("closed schema rejects authority, owner, and cadence broadening", () => {
  const corpus = load();
  corpus.networkAuthority = true;
  corpus.review.primaryOwner = "@attacker/owners";
  corpus.review.cadence = "yearly";
  const errors = errorsFor(corpus).join("\n");
  assert.match(errors, /additional properties/u);
  assert.match(errors, /primaryOwner/u);
  assert.match(errors, /cadence/u);
});

test("monthly interval and explicit reproducible freshness gate are enforced", () => {
  const corpus = load();
  assert.deepEqual(errorsFor(corpus, REPOSITORY_ROOT, "2026-09-02"), []);
  assert.match(
    errorsFor(corpus, REPOSITORY_ROOT, "2026-09-03").join("\n"),
    /monthly review is overdue/u,
  );
  assert.match(errorsFor(corpus, REPOSITORY_ROOT, "bad-date").join("\n"), /valid YYYY-MM-DD/u);
  assert.match(errorsFor(corpus, REPOSITORY_ROOT, "2026-02-31").join("\n"), /valid YYYY-MM-DD/u);
  corpus.review.nextReviewDue = "2026-10-02";
  assert.match(errorsFor(corpus).join("\n"), /exactly one calendar month/u);
});

test("missing or duplicate entries cannot hide a GA capability", () => {
  const missing = load();
  const removed = missing.capabilities.pop();
  assert.match(
    errorsFor(missing).join("\n"),
    new RegExp(`missing positive and negative coverage for ${removed.surfaceId}`),
  );

  const duplicate = load();
  duplicate.capabilities[1] = structuredClone(duplicate.capabilities[0]);
  const errors = errorsFor(duplicate).join("\n");
  assert.match(errors, /duplicates a GA capability/u);
  assert.match(errors, /missing positive and negative coverage/u);
});

test("canonical support, evidence, owner, and coverage states cannot drift", () => {
  const corpus = load();
  const capability = corpus.capabilities.find((entry) => entry.supportStatus === "supported");
  capability.supportStatus = "unknown";
  capability.evidenceStatus = ["unknown"];
  capability.profileId = "cursor-agent";
  capability.coverageTags.reverse();
  const errors = errorsFor(corpus).join("\n");
  assert.match(errors, /supportStatus differs/u);
  assert.match(errors, /evidenceStatus differs/u);
  assert.match(errors, /profileId does not own/u);
  assert.match(errors, /coverageTags/u);
});

test("positive and negative references cannot swap polarity or reuse assertions", () => {
  const corpus = load();
  const capability = corpus.capabilities[0];
  capability.negative.fixtureId = capability.positive.fixtureId;
  capability.negative.assertionId = capability.positive.assertionId;
  const errors = errorsFor(corpus).join("\n");
  assert.match(errors, /wrong polarity or profile owner/u);
  assert.match(errors, /expectedState|declared capability outcome/u);
});

test("fixture, inventory, and D16 substitutions are rejected by digest", () => {
  for (const mutate of [
    (corpus) => {
      corpus.fixtures[0].sha256 = "0".repeat(64);
    },
    (corpus) => {
      corpus.inventory.sha256 = "1".repeat(64);
    },
    (corpus) => {
      corpus.observationReview.sha256 = "2".repeat(64);
    },
  ]) {
    const corpus = load();
    mutate(corpus);
    assert.match(errorsFor(corpus).join("\n"), /sha256 does not match/u);
  }
});

test("official derivation and surface-owned source provenance cannot be promoted", () => {
  const { corpus, root } = materialize();
  rewriteFixture(corpus, root, 0, (fixture) => {
    fixture.provenance.derivation = "synthetic-edge-case";
    fixture.provenance.sources[0].url = "https://example.invalid/profile";
  });
  const errors = errorsFor(corpus, root).join("\n");
  assert.match(errors, /must use official-example derivation/u);
  assert.match(errors, /source URL is not in the canonical research record/u);
});

test("fixture profile, assertion result, and K01 extension are cross-checked", () => {
  const { corpus, root } = materialize();
  const fixture = rewriteFixture(corpus, root, 0, (value) => {
    value.extensions["agent-context-lint.dev/k01"].polarity = "positive";
    value.assertions[0].expected.selection = "selected";
  });
  corpus.capabilities.find(
    (entry) => entry.negative.fixtureId === fixture.id,
  ).negative.expectedState = "selected";
  const errors = errorsFor(corpus, root).join("\n");
  assert.match(errors, /K01 polarity does not match/u);
  assert.match(errors, /expectedState differs|does not prove/u);
});

test("missing and unowned assertions fail completeness", () => {
  const corpus = load();
  corpus.capabilities[0].positive.assertionId = "missing-assertion";
  assert.match(errorsFor(corpus).join("\n"), /does not exist in the fixture/u);

  const { corpus: withExtra, root } = materialize();
  rewriteFixture(withExtra, root, 0, (fixture) => {
    fixture.assertions.push({
      evidenceRefs: ["extra"],
      evidenceStatus: "documented",
      expected: true,
      id: "assert-extra",
      predicate: "unowned",
    });
  });
  assert.match(errorsFor(withExtra, root).join("\n"), /has unowned assertion assert-extra/u);
});

test("symlinked, oversized, malformed, missing, and extra fixture files fail closed", () => {
  {
    const { corpus, root } = materialize();
    const reference = corpus.fixtures[0];
    const absolute = path.join(root, ...reference.path.split("/"));
    const outside = `${root}-outside.json`;
    temporaryPaths.push(outside);
    writeFileSync(outside, readFileSync(absolute));
    unlinkSync(absolute);
    symlinkSync(outside, absolute);
    assert.match(errorsFor(corpus, root).join("\n"), /ordinary non-symbolic-link file/u);
  }
  {
    const { corpus, root } = materialize();
    const reference = corpus.fixtures[1];
    const absolute = path.join(root, ...reference.path.split("/"));
    const bytes = Buffer.alloc(OFFICIAL_CORPUS_MAX_FILE_BYTES + 1, 0x61);
    writeFileSync(absolute, bytes);
    reference.sha256 = digest(bytes);
    assert.match(errorsFor(corpus, root).join("\n"), /exceeds 4194304 bytes/u);
  }
  {
    const { corpus, root } = materialize();
    const reference = corpus.fixtures[2];
    const absolute = path.join(root, ...reference.path.split("/"));
    const bytes = Buffer.from([0xff, 0xfe]);
    writeFileSync(absolute, bytes);
    reference.sha256 = digest(bytes);
    assert.match(errorsFor(corpus, root).join("\n"), /valid UTF-8 JSON/u);
  }
  {
    const { corpus, root } = materialize();
    unlinkSync(path.join(root, ...corpus.review.procedurePath.split("/")));
    assert.match(errorsFor(corpus, root).join("\n"), /procedurePath.*could not be read/u);
  }
  {
    const { corpus, root } = materialize();
    writeFileSync(
      path.join(root, "conformance/official-examples/v0/fixtures/unmanifested.fixture.json"),
      "{}\n",
    );
    assert.match(errorsFor(corpus, root).join("\n"), /do not exactly match the manifest/u);
  }
});

test("missing schema and unresolved root return bounded errors", () => {
  const { corpus, root } = materialize();
  unlinkSync(
    path.join(root, "conformance/contracts/official-example-conformance-corpus.v0.schema.json"),
  );
  assert.deepEqual(errorsFor(corpus, root), [
    "official-example corpus schema could not be compiled",
  ]);
  assert.deepEqual(errorsFor(load(), path.join(os.tmpdir(), "missing-k01-root")), [
    "repository root could not be resolved",
  ]);
});

test("CLI accepts canonical input and reports usage, overdue review, and malformed JSON", () => {
  const valid = spawnSync(process.execPath, [TOOL, path.join(REPOSITORY_ROOT, CORPUS_PATH)], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
  });
  assert.equal(valid.status, 0, valid.stderr);
  assert.match(valid.stdout, /valid .*corpus\.json/u);

  const overdue = spawnSync(
    process.execPath,
    [TOOL, path.join(REPOSITORY_ROOT, CORPUS_PATH), "--as-of", "2026-09-03"],
    { cwd: REPOSITORY_ROOT, encoding: "utf8" },
  );
  assert.equal(overdue.status, 1);
  assert.match(overdue.stderr, /monthly review is overdue/u);

  const usage = spawnSync(
    process.execPath,
    [TOOL, path.join(REPOSITORY_ROOT, CORPUS_PATH), "--as-of"],
    {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
    },
  );
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /usage:/u);

  const temporary = mkdtempSync(path.join(os.tmpdir(), "official-corpus-cli-"));
  temporaryPaths.push(temporary);
  const malformed = path.join(temporary, "corpus.json");
  writeFileSync(malformed, "{");
  const result = spawnSync(process.execPath, [TOOL, malformed], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /JSON/u);
});
