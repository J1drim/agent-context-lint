import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  adjudicateSecretScan,
  fingerprintSecret,
  validateSecretScanBaseline,
} from "./adjudicate-secret-scan.mjs";

const emptyBaseline = Buffer.from(
  '{"findings":[],"fingerprintMethod":"sha256:agent-context-secret-scan-v1","schemaVersion":1}\n',
);
const secret = "synthetic-secret-never-log-7f6a";
const adjudicatedReason =
  "intentional-static-credential-in-uri-rejection-fixture-on-reserved-example-domain-no-deployable-secret";
const adjudicatedFixtures = [
  [
    "05e868445ff6e953a25e852275751a0dff90071d50b8c57bdaed578734e313a2",
    "packages/rules/test/rule-registry.unit.test.ts",
  ],
  [
    "2020ba95db9bf35f22c69b9992d8486b440f18d8c835c8c01daa2186a4b1be07",
    "packages/core/test/diagnostic-contracts.unit.test.ts",
  ],
  [
    "24f74c1bcade1bc56006c2efc3d2d59b3ec031d3ff4f7c205582bbe3feb7b518",
    "packages/evidence/test/discovery-index.unit.test.ts",
  ],
  [
    "262b84f5ed85338c5147c599dcadf4eab6da89e50c008885bd201d519280de47",
    "packages/rules/test/security.unit.test.ts",
  ],
  [
    "325d1d76ae6bead66337c0aac5e2f9e8944c1a5878267be28ddb135a05c9da79",
    "packages/standards/test/registry-client.unit.test.ts",
  ],
  [
    "5925568a36da0e45ff2c597a9de32a9706927692a8d53446e4e53bea7613a035",
    "packages/core/test/profile-contracts.unit.test.ts",
  ],
  [
    "818bdbdba9ce9740519bbac2576a42365e55501a8588af90680956617081cd03",
    "packages/core/test/output-contracts.unit.test.ts",
  ],
  [
    "94423c5770eab5d29b22c2964b127d34025a9940a7bd97f94153d6a132793e2b",
    "packages/formatters/test/sarif.unit.test.ts",
  ],
  [
    "bb553964207e37f75f5328e7c50257c313a459253710c403274208ab8e6bd615",
    "packages/standards/test/knowledge-pack.unit.test.ts",
  ],
];

function finding(overrides = {}) {
  return {
    DetectorName: "GitHubPersonalAccessToken",
    Raw: secret,
    RawV2: "",
    Redacted: "redacted-canary-never-log",
    SecretParts: { token: "parts-canary-never-log" },
    SourceMetadata: { Data: { Git: { file: "tests/fixture.txt", line: 3 } } },
    ...overrides,
  };
}

function lines(...values) {
  return Buffer.from(`${values.map((value) => JSON.stringify(value)).join("\n")}\n`);
}

function baselineFor(value, reason = "synthetic-security-regression") {
  return Buffer.from(
    `${JSON.stringify({
      findings: [
        {
          detector: value.DetectorName,
          fingerprint: fingerprintSecret(value.RawV2 || value.Raw),
          path: value.SourceMetadata.Data.Git.file,
          reason,
        },
      ],
      fingerprintMethod: "sha256:agent-context-secret-scan-v1",
      schemaVersion: 1,
    })}\n`,
  );
}

test("empty baseline reports only a nonsecret deterministic identity", async () => {
  const result = await adjudicateSecretScan([lines(finding())], emptyBaseline);
  assert.equal(result.totalCount, 1);
  assert.equal(result.adjudicatedCount, 0);
  assert.deepEqual(result.unadjudicated, [
    {
      detector: "GitHubPersonalAccessToken",
      fingerprint: fingerprintSecret(secret),
      path: "tests/fixture.txt",
    },
  ]);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-secret|redacted-canary|parts-canary/u);
});

test("packaged adjudicator emits only safe identities and fails an empty baseline", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/adjudicate-secret-scan.mjs", "config/secret-scan-baseline.v1.json"],
    {
      cwd: new URL("..", import.meta.url),
      encoding: "utf8",
      input: lines(finding()),
      shell: false,
    },
  );
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, new RegExp(fingerprintSecret(secret), "u"));
  assert.match(result.stderr, /path=tests\/fixture\.txt detector=GitHubPersonalAccessToken/u);
  assert.doesNotMatch(
    result.stderr,
    /synthetic-secret|redacted-canary|parts-canary|RawV2|SecretParts/u,
  );
});

test("adjudicator executes with built-ins only when node_modules is absent", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "secret-adjudicator-standalone-"));
  try {
    await mkdir(path.join(temporaryRoot, "scripts"));
    await mkdir(path.join(temporaryRoot, "config"));
    const scriptPath = path.join(temporaryRoot, "scripts", "adjudicate-secret-scan.mjs");
    await copyFile(new URL("adjudicate-secret-scan.mjs", import.meta.url), scriptPath);
    await writeFile(
      path.join(temporaryRoot, "config", "secret-scan-baseline.v1.json"),
      emptyBaseline,
      { flag: "wx" },
    );
    const result = spawnSync(
      process.execPath,
      [await realpath(scriptPath), "config/secret-scan-baseline.v1.json"],
      {
        cwd: temporaryRoot,
        encoding: "utf8",
        input: lines(finding()),
        shell: false,
      },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(fingerprintSecret(secret), "u"));
    assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND|synthetic-secret|redacted-canary/u);
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
});

test("exact fingerprint, path, and detector match one reasoned baseline entry", async () => {
  const value = finding();
  const result = await adjudicateSecretScan([lines(value, value)], baselineFor(value));
  assert.deepEqual(result, { adjudicatedCount: 1, totalCount: 1, unadjudicated: [] });
  for (const changed of [
    finding({ DetectorName: "AWS" }),
    finding({ Raw: `${secret}-changed` }),
    finding({ SourceMetadata: { Data: { Git: { file: "tests/other.txt" } } } }),
  ]) {
    const mismatch = await adjudicateSecretScan([lines(changed)], baselineFor(value));
    assert.equal(mismatch.unadjudicated.length, 1);
  }
});

test("baseline is closed, sorted, unique, reasoned, and contains no raw material", () => {
  assert.deepEqual(validateSecretScanBaseline(emptyBaseline), []);
  const value = finding();
  const valid = JSON.parse(baselineFor(value).toString("utf8"));
  for (const invalid of [
    { ...valid, unknown: true },
    { ...valid, fingerprintMethod: "sha256" },
    { ...valid, findings: [{ ...valid.findings[0], reason: "" }] },
    { ...valid, findings: [{ ...valid.findings[0], raw: secret }] },
    { ...valid, findings: [valid.findings[0], valid.findings[0]] },
  ])
    assert.throws(
      () => validateSecretScanBaseline(Buffer.from(JSON.stringify(invalid))),
      /adjudication input is invalid/u,
    );
  assert.throws(
    () => validateSecretScanBaseline(Buffer.from('{"schemaVersion":1,"schemaVersion":1}')),
    /adjudication input is invalid/u,
  );
  assert.throws(
    () => validateSecretScanBaseline(Buffer.from('{"schemaVersion":1,"\\u0073chemaVersion":1}')),
    /adjudication input is invalid/u,
  );
});

test("committed adjudication contains only the nine reviewed URI fixture identities", async () => {
  const baseline = validateSecretScanBaseline(
    await readFile(new URL("../config/secret-scan-baseline.v1.json", import.meta.url)),
  );
  assert.deepEqual(
    baseline.map(({ detector, fingerprint, path, reason }) => [
      fingerprint,
      path,
      detector,
      reason,
    ]),
    adjudicatedFixtures.map(([fingerprint, fixturePath]) => [
      fingerprint,
      fixturePath,
      "URI",
      adjudicatedReason,
    ]),
  );
});

test("malformed, truncated, oversized, unsafe, and secretless scanner output fails closed", async () => {
  const cases = [
    [Buffer.from("{not-json}\n")],
    [Buffer.from(JSON.stringify(finding()))],
    [Buffer.from("\n")],
    [lines(finding({ Raw: "", RawV2: "" }))],
    [lines(finding({ DetectorName: "bad detector" }))],
    [lines(finding({ SourceMetadata: { Data: { Git: { file: "../secret" } } } }))],
    [
      Buffer.from(
        '{"DetectorName":"AWS","Raw":"safe-test","SourceMetadata":{"Data":{"Git":{"file":"a","file":"b"}}}}\n',
      ),
    ],
    [Buffer.from(`${"[".repeat(65)}0${"]".repeat(65)}\n`)],
    [Buffer.alloc(2 * 1024 * 1024 + 2, 0x61)],
  ];
  for (const chunks of cases)
    await assert.rejects(
      adjudicateSecretScan(chunks, emptyBaseline),
      /adjudication input is invalid/u,
    );
});

test("streaming chunk boundaries preserve exact results without retaining raw fields", async () => {
  const bytes = lines(finding(), finding({ Raw: "second-synthetic", RawV2: "second-v2" }));
  const chunks = [];
  for (let index = 0; index < bytes.length; index += 7)
    chunks.push(bytes.subarray(index, index + 7));
  const result = await adjudicateSecretScan(chunks, emptyBaseline);
  assert.equal(result.unadjudicated.length, 2);
  assert.doesNotMatch(JSON.stringify(result), /synthetic|redacted|parts/u);
});
