import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  parseActionInputs,
  isPathWithinForTest,
  renderSarifAnnotations,
  renderScanNotice,
  runGithubAction,
  validateActionPathBoundary,
} from "../dist/index.js";

const productionSarifFixture = JSON.parse(
  await readFile(
    new URL("../../packages/core/test/fixtures/sarif-output.valid.json", import.meta.url),
    "utf8",
  ),
);

function sarifDocument(results = []) {
  const document = structuredClone(productionSarifFixture);
  document.runs[0].results = results;
  return document;
}

function sarif(results = []) {
  return JSON.stringify(sarifDocument(results));
}

function result(overrides = {}) {
  return { ...structuredClone(productionSarifFixture.runs[0].results[0]), ...overrides };
}

const SHA1 = "0123456789abcdef0123456789abcdef01234567";
const SHA256 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

test("the built action scans a real read-only fixture without an install", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-context-i09-action-"));
  context.after(() => rm(root, { force: true, recursive: true }));
  const sourcePath = path.join(root, "AGENTS.md");
  const source = "Run npm run missing-task before committing.\n";
  await writeFile(sourcePath, source, "utf8");
  const execution = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("../dist/index.js", import.meta.url))],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_WORKSPACE: root,
        INPUT_BASE: "",
        INPUT_CHANGED: "false",
        INPUT_FAIL_ON: "never",
        INPUT_MAX_ANNOTATIONS: "50",
        INPUT_WORKING_DIRECTORY: ".",
      },
      maxBuffer: 1024 * 1024,
      timeout: 5_000,
    },
  );
  assert.ifError(execution.error);
  assert.equal(execution.signal, null);
  assert.equal(
    execution.status,
    0,
    `fixed-fixture action stdout:\n${execution.stdout}\nfixed-fixture action stderr:\n${execution.stderr}`,
  );
  assert.match(execution.stdout, /::(?:notice|warning) file=AGENTS\.md,/u);
  assert.equal(await readFile(sourcePath, "utf8"), source);
});

test("path containment rejects cross-volume Windows relatives", () => {
  assert.equal(isPathWithinForTest("D:\\a\\trusted", "D:\\a\\trusted\\target", path.win32), true);
  assert.equal(isPathWithinForTest("D:\\a\\trusted", "C:\\temp\\target", path.win32), false);
  assert.equal(isPathWithinForTest("/a/trusted", "/a/target", path.posix), false);
});

test("action inputs form a closed, bounded changed-mode invocation", () => {
  assert.deepEqual(
    parseActionInputs({
      INPUT_BASE: SHA1,
      INPUT_CHANGED: "true",
      INPUT_FAIL_ON: "error",
      INPUT_MAX_ANNOTATIONS: "1",
      INPUT_WORKING_DIRECTORY: "packages/example",
    }),
    {
      base: SHA1,
      changed: true,
      failOn: "error",
      maximumAnnotations: 1,
      workingDirectory: "packages/example",
    },
  );
  assert.equal(parseActionInputs({ INPUT_BASE: SHA256, INPUT_CHANGED: "true" }).base, SHA256);
  assert.equal(
    parseActionInputs({
      "INPUT_WORKING-DIRECTORY": "packages/example",
    }).workingDirectory,
    "packages/example",
  );
});

test("action inputs reject escapes, malformed booleans, ambiguous bases, and annotation limits", () => {
  for (const environment of [
    { INPUT_WORKING_DIRECTORY: "../outside" },
    { INPUT_WORKING_DIRECTORY: "/outside" },
    { INPUT_CHANGED: "yes" },
    { INPUT_CHANGED: "true" },
    { INPUT_BASE: SHA1 },
    { INPUT_CHANGED: "true", INPUT_BASE: "refs/remotes/origin/main" },
    { INPUT_CHANGED: "true", INPUT_BASE: SHA1.slice(0, -1) },
    { INPUT_CHANGED: "true", INPUT_BASE: `${SHA1}0` },
    { INPUT_CHANGED: "true", INPUT_BASE: SHA1.toUpperCase() },
    { INPUT_CHANGED: "true", INPUT_BASE: "g".repeat(40) },
    { INPUT_CHANGED: "true", INPUT_BASE: "--upload-pack=evil" },
    { INPUT_CHANGED: "true", INPUT_BASE: "refs/heads/a b" },
    { INPUT_CHANGED: "true", INPUT_BASE: "refs/heads/a.lock" },
    { INPUT_MAX_ANNOTATIONS: "0" },
    { INPUT_MAX_ANNOTATIONS: "51" },
    { INPUT_FAIL_ON: "info" },
    { INPUT_FAIL_ON: "warning\n::error::injected" },
    { INPUT_WORKING_DIRECTORY: "packages/\u0085c1" },
    { INPUT_WORKING_DIRECTORY: "packages/\u061carabic-mark" },
    { INPUT_WORKING_DIRECTORY: "packages/\u200elrm" },
    { INPUT_WORKING_DIRECTORY: "packages/\u200frlm" },
    { INPUT_WORKING_DIRECTORY: "packages/\u202eoverride" },
    { INPUT_WORKING_DIRECTORY: "packages/\u2066isolate" },
    { INPUT_WORKING_DIRECTORY: "packages/\ud800surrogate" },
  ])
    assert.throws(() => parseActionInputs(environment), /invalid action input/u);
});

test("the action and scan target must remain real, ordinary, and disjoint", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-context-i09-boundary-"));
  context.after(() => rm(root, { force: true, recursive: true }));
  const workspace = path.join(root, "workspace");
  const action = path.join(workspace, "trusted", "action");
  const target = path.join(workspace, "target");
  const outside = path.join(root, "outside");
  await Promise.all([
    mkdir(action, { recursive: true }),
    mkdir(path.join(target, "action"), { recursive: true }),
    mkdir(outside, { recursive: true }),
  ]);
  await assert.doesNotReject(
    validateActionPathBoundary({ GITHUB_WORKSPACE: workspace }, "target", action),
  );
  await assert.rejects(
    validateActionPathBoundary(
      { GITHUB_WORKSPACE: workspace },
      "target",
      path.join(target, "action"),
    ),
    /unsafe action path boundary/u,
  );
  await symlink(outside, path.join(workspace, "linked-target"));
  await assert.rejects(
    validateActionPathBoundary({ GITHUB_WORKSPACE: workspace }, "linked-target", action),
    /unsafe action path boundary/u,
  );
});

test("SARIF diagnostics become escaped, bounded inline annotations", () => {
  const output = renderSarifAnnotations(
    sarif([
      result({
        locations: [
          {
            physicalLocation: {
              artifactLocation: { uri: "docs/a%2Cb.md" },
              region: { endColumn: 10, endLine: 4, startColumn: 2, startLine: 4 },
            },
          },
        ],
        message: { text: "line one\n::error::not a command%" },
      }),
      result({ level: "note" }),
    ]),
    1,
  );
  assert.equal(output.total, 2);
  assert.equal(output.emitted, 1);
  assert.deepEqual(output.commands, [
    "::warning file=docs/a%2Cb.md,line=4,endLine=4,title=ACL100,col=2,endColumn=10::line one�::error::not a command%25",
  ]);
});

test("annotation limits cap emission only and malformed trailing SARIF fails closed", () => {
  assert.throws(
    () => renderSarifAnnotations(sarif([result(), result({ ruleId: "BAD" })]), 1),
    /invalid SARIF output/u,
  );
  const output = renderSarifAnnotations(sarif([result(), result(), result()]), 1);
  assert.equal(output.total, 3);
  assert.equal(output.emitted, 1);
});

test("multi-line annotations omit unsupported columns", () => {
  const output = renderSarifAnnotations(
    sarif([
      result({
        locations: [
          {
            physicalLocation: {
              artifactLocation: { uri: "AGENTS.md" },
              region: { endColumn: 3, endLine: 3, startColumn: 1, startLine: 2 },
            },
          },
        ],
      }),
    ]),
    50,
  );
  assert.equal(
    output.commands[0],
    "::warning file=AGENTS.md,line=2,endLine=3,title=ACL100::Invalid agent context",
  );
});

test("only the fixed conservative changed-mode fallback notice is surfaced", () => {
  assert.equal(renderScanNotice(""), null);
  assert.equal(
    renderScanNotice(
      "agent-context-lint: changed-file mode used the full scan (repository-changed).\n",
    ),
    "::warning title=Agent Context Linter::Changed mode conservatively used a complete scan (repository-changed).",
  );
  for (const unsafe of [
    "repository text",
    "agent-context-lint: changed-file mode used the full scan (bad\n::error::injected).\n",
    "agent-context-lint: changed-file mode used the full scan (UPPERCASE).\n",
  ])
    assert.throws(() => renderScanNotice(unsafe), /invalid scan notice/u);
});

test("malformed, escaping, oversized, and hostile SARIF fail closed", () => {
  const missing = sarifDocument([result()]);
  delete missing.$schema;
  const extra = sarifDocument([result()]);
  extra.unreviewed = true;
  const brokenRelationship = sarifDocument([result({ ruleIndex: 1 })]);
  const unsafeArtifactUris = [
    "docs/%01c0.md",
    "docs/%C2%85c1.md",
    "docs/%D8%9Carabic-mark.md",
    "docs/%E2%80%8Elrm.md",
    "docs/%E2%80%8Frlm.md",
    "docs/%E2%80%AEoverride.md",
    "docs/%E2%81%A6isolate.md",
    "docs/%ED%A0%80surrogate.md",
  ];
  for (const source of [
    "not json",
    JSON.stringify({ runs: [], version: "2.1.0" }),
    JSON.stringify(missing),
    JSON.stringify(extra),
    JSON.stringify(brokenRelationship),
    sarif([result({ ruleId: "BAD" })]),
    sarif([result({ message: { text: "before\ud800after" } })]),
    sarif([
      result({
        locations: [
          {
            physicalLocation: {
              artifactLocation: { uri: "..%2Fsecret" },
              region: { endLine: 1, startLine: 1 },
            },
          },
        ],
      }),
    ]),
    sarif([result({ level: "none" })]),
    ...unsafeArtifactUris.map((uri) =>
      sarif([
        result({
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri },
                region: { endColumn: 5, endLine: 1, startColumn: 1, startLine: 1 },
              },
            },
          ],
        }),
      ]),
    ),
    sarif([
      result({
        locations: [
          {
            physicalLocation: {
              artifactLocation: { uri: "docs/%41GENTS.md" },
              region: { endColumn: 5, endLine: 1, startColumn: 1, startLine: 1 },
            },
          },
        ],
      }),
    ]),
  ])
    assert.throws(() => renderSarifAnnotations(source, 50), /invalid SARIF/u);
});

test("complete C0, C1, and bidi text is sanitized after production SARIF validation", () => {
  const controls = String.fromCodePoint(
    ...Array.from({ length: 0x20 }, (_value, index) => index),
    ...Array.from({ length: 0x21 }, (_value, index) => 0x7f + index),
    0x061c,
    0x200e,
    0x200f,
    ...Array.from({ length: 5 }, (_value, index) => 0x202a + index),
    ...Array.from({ length: 4 }, (_value, index) => 0x2066 + index),
  );
  const output = renderSarifAnnotations(
    sarif([
      result({
        locations: [
          {
            physicalLocation: {
              artifactLocation: { uri: "docs/context.md" },
              region: { endColumn: 5, endLine: 1, startColumn: 1, startLine: 1 },
            },
          },
        ],
        message: { text: `before${controls}after` },
      }),
    ]),
    50,
  );
  assert.equal(output.total, 1);
  assert.match(output.commands[0], /file=docs\/context\.md/u);
  assert.match(output.commands[0], /before�+after/u);
  assert.doesNotMatch(
    output.commands[0],
    // eslint-disable-next-line no-control-regex -- verifies every hostile control partition is inert.
    /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\ud800-\udfff]/u,
  );
});

test("the wrapper emits annotations before preserving lint failure", async () => {
  const logs = [];
  let arguments_;
  const exitCode = await runGithubAction({
    environment: {},
    log: (line) => logs.push(line),
    scan: async (argv, stdout) => {
      arguments_ = argv;
      await stdout.write(sarif([result()]), new AbortController().signal);
      return { exitCode: 1 };
    },
  });
  assert.equal(exitCode, 1);
  assert.deepEqual(arguments_, ["scan", ".", "--format", "sarif", "--fail-on", "warning"]);
  assert.match(logs[0], /^::warning file=AGENTS\.md/u);
  assert.equal(
    logs[1],
    "::notice title=Agent Context Linter::Scan reported 1 diagnostics; emitted 1 bounded annotations.",
  );
});

test("the wrapper makes a conservative full-scan fallback visible", async () => {
  const logs = [];
  const exitCode = await runGithubAction({
    environment: {},
    log: (line) => logs.push(line),
    scan: async (_arguments, stdout, stderr) => {
      await stdout.write(sarif([]), new AbortController().signal);
      await stderr.write(
        "agent-context-lint: changed-file mode used the full scan (git-metadata-unavailable).\n",
        new AbortController().signal,
      );
      return { exitCode: 0 };
    },
  });
  assert.equal(exitCode, 0);
  assert.equal(
    logs[0],
    "::warning title=Agent Context Linter::Changed mode conservatively used a complete scan (git-metadata-unavailable).",
  );
});

test("operational failures and malformed scan output reveal no captured repository text", async () => {
  for (const scan of [
    async () => {
      throw new Error("secret");
    },
    async (_arguments, stdout, stderr) => {
      await stdout.write("attacker text", new AbortController().signal);
      await stderr.write("secret", new AbortController().signal);
      return { exitCode: 2 };
    },
    async (_arguments, stdout) => {
      await stdout.write("attacker text", new AbortController().signal);
      return { exitCode: 0 };
    },
  ]) {
    const logs = [];
    assert.equal(
      await runGithubAction({ environment: {}, log: (line) => logs.push(line), scan }),
      2,
    );
    assert.doesNotMatch(logs.join("\n"), /secret|attacker/u);
  }
});
