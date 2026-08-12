import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

import {
  REAL_CLIENT_OBSERVATION_MAX_PLAN_BYTES,
  canonicalObservationJson,
  loadRealClientObservationPlan,
  redactRealClientObservationOutput,
  runRealClientObservation,
  validateRealClientObservationPlan,
  writeRealClientObservationTranscript,
} from "./real-client-observation.mjs";

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020.js").default;
const addFormats = require("ajv-formats").default;
const PLAN_PATH = "conformance/observations/v0/gemini-no-safe-signal.plan.json";
const PLAN_SCHEMA_PATH = "conformance/contracts/real-client-observation-plan.v0.schema.json";
const TRANSCRIPT_SCHEMA_PATH =
  "conformance/contracts/real-client-observation-transcript.v0.schema.json";
const SANDBOX_EXECUTABLE = "/usr/bin/sandbox-exec";
const SANDBOX_EXECUTABLE_SHA256 =
  process.platform === "darwin" ? sha256File(SANDBOX_EXECUTABLE) : "0".repeat(64);
const canonicalPlan = JSON.parse(fs.readFileSync(PLAN_PATH, "utf8"));

function clone(value = canonicalPlan) {
  return structuredClone(value);
}

function sha256File(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function versionPlan(executablePath = process.execPath, expectedVersion = process.version) {
  const plan = clone();
  plan.capabilityPolicy.allowed = ["pinned-client-version-metadata"];
  plan.caseId = "codex-version-probe";
  plan.client = {
    executablePath,
    executableSha256: sha256File(executablePath),
    expectedVersion,
  };
  plan.expectedLoadedSourceSequence = [];
  plan.fixtureFiles = [];
  plan.operation = "version-probe";
  plan.profileId = "codex-cli";
  plan.settingSources = ["isolated-home"];
  plan.supervisor = {
    executablePath: SANDBOX_EXECUTABLE,
    executableSha256: SANDBOX_EXECUTABLE_SHA256,
    kind: "macos-sandbox-exec-v1",
  };
  plan.surfaceId = "codex-cli/local-cli-single-cwd";
  return plan;
}

function assertHasError(errors, pattern) {
  assert.ok(
    errors.some((error) => pattern.test(error)),
    `expected error matching ${pattern}, received:\n${errors.join("\n")}`,
  );
}

function disposable(t, prefix = "real-client-observation-") {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function createExecutable(directory, body) {
  const executable = path.join(directory, "synthetic-client.mjs");
  fs.writeFileSync(executable, `#!/usr/bin/env node\n${body}\n`, { mode: 0o700 });
  fs.chmodSync(executable, 0o700);
  return executable;
}

function createNativeExecutable(directory, name, sourceText) {
  const source = path.join(directory, `${name}.c`);
  const executable = path.join(directory, name);
  fs.writeFileSync(source, sourceText);
  const compile = spawnSync("/usr/bin/clang", ["-O2", source, "-o", executable], {
    encoding: "utf8",
  });
  assert.equal(compile.status, 0, compile.stderr);
  return executable;
}

function isEnclosingSandboxDenial(probe) {
  return (
    probe.error === undefined &&
    probe.signal === null &&
    probe.status === 71 &&
    probe.stdout === "" &&
    probe.stderr === "sandbox-exec: sandbox_apply: Operation not permitted\n"
  );
}

function requireApplicableMacosSandbox(t) {
  if (process.platform !== "darwin") {
    t.skip("macos-sandbox-exec-v1 is intentionally macOS-only");
    return false;
  }

  const probe = spawnSync(
    SANDBOX_EXECUTABLE,
    ["-p", "(version 1) (allow default)", "/usr/bin/true"],
    {
      encoding: "utf8",
      shell: false,
    },
  );
  if (isEnclosingSandboxDenial(probe)) {
    t.skip("the enclosing execution environment prohibits applying a nested macOS sandbox");
    return false;
  }
  assert.equal(probe.error, undefined, "the exact sandbox supervisor must be executable");
  assert.equal(probe.signal, null, "the sandbox capability probe must not be signaled");
  assert.equal(probe.status, 0, probe.stderr);
  assert.equal(probe.stdout, "");
  assert.equal(probe.stderr, "");
  return true;
}

test("recognizes only the exact enclosing-sandbox capability denial", () => {
  const denial = {
    error: undefined,
    signal: null,
    status: 71,
    stderr: "sandbox-exec: sandbox_apply: Operation not permitted\n",
    stdout: "",
  };
  assert.equal(isEnclosingSandboxDenial(denial), true);
  for (const [field, value] of [
    ["error", new Error("spawn failed")],
    ["signal", "SIGKILL"],
    ["status", 1],
    ["stderr", "sandbox-exec: other failure\n"],
    ["stdout", "unexpected"],
  ]) {
    assert.equal(isEnclosingSandboxDenial({ ...denial, [field]: value }), false, field);
  }
});

test("accepts the canonical blocked observation plan and an empty fixture", () => {
  assert.deepEqual(validateRealClientObservationPlan(canonicalPlan), []);
  const empty = clone();
  empty.fixtureFiles = [{ content: "", markerId: null, path: "EMPTY.md" }];
  empty.expectedLoadedSourceSequence = ["EMPTY.md"];
  assert.deepEqual(validateRealClientObservationPlan(empty), []);
});

test("published schemas validate canonical plans and issued transcripts", async () => {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const planSchema = JSON.parse(fs.readFileSync(PLAN_SCHEMA_PATH, "utf8"));
  const transcriptSchema = JSON.parse(fs.readFileSync(TRANSCRIPT_SCHEMA_PATH, "utf8"));
  const validatePlan = ajv.compile(planSchema);
  const validateTranscript = ajv.compile(transcriptSchema);
  assert.equal(validatePlan(canonicalPlan), true, JSON.stringify(validatePlan.errors));
  const transcript = await runRealClientObservation(canonicalPlan);
  assert.equal(validateTranscript(transcript), true, JSON.stringify(validateTranscript.errors));
});

test("blocked observations execute nothing and retain explicit unknown evidence", async () => {
  const plan = clone();
  plan.fixtureFiles[0].path = "renamed/GEMINI.md";
  plan.expectedLoadedSourceSequence = ["renamed/GEMINI.md"];
  const transcript = await runRealClientObservation(plan);
  assert.equal(transcript.result.status, "blocked");
  assert.equal(transcript.result.blockedReason, "no-safe-no-model-signal");
  assert.equal(transcript.client, null);
  assert.equal(transcript.invocation, null);
  assert.deepEqual(transcript.actualLoadedSourceSequence, []);
  assert.deepEqual(transcript.settingSources, ["isolated-home", "repository-fixture"]);
  assert.ok(Object.isFrozen(transcript));
  assert.ok(Object.isFrozen(transcript.result));
  assert.ok(Object.isFrozen(transcript.fixtureManifest));
});

test("rejects capability broadening, mismatched surfaces, reasons, and timestamps", () => {
  const value = clone();
  value.capabilityPolicy.denied.pop();
  value.profileId = "codex-cli";
  value.surfaceId = "gemini-cli/local-terminal";
  value.observedAt = "2026-02-30T00:00:00Z";
  const errors = validateRealClientObservationPlan(value);
  assertHasError(errors, /capabilityPolicy\.denied must be exactly/);
  assertHasError(errors, /surfaceId must belong/);
  assertHasError(errors, /valid RFC 3339/);

  const hosted = clone();
  hosted.profileId = "copilot-cloud-agent";
  hosted.surfaceId = "copilot-cloud-agent/github-hosted";
  assertHasError(validateRealClientObservationPlan(hosted), /blocked reason must match/);
});

test("version probes require a pinned local binary and the exact compiled capability", () => {
  const value = versionPlan();
  assert.deepEqual(validateRealClientObservationPlan(value), []);
  value.capabilityPolicy.allowed = [];
  value.client.executableSha256 = "A".repeat(64);
  value.surfaceId = "cursor-agent/ide";
  value.supervisor.executablePath = "/tmp/not-a-supervisor";
  const errors = validateRealClientObservationPlan(value);
  assertHasError(errors, /capabilityPolicy\.allowed must be exactly/);
  assertHasError(errors, /lowercase SHA-256/);
  assertHasError(errors, /local CLI surface/);
  assertHasError(errors, /must be \/usr\/bin\/sandbox-exec/);
});

test("rejects hostile containers and never invokes accessors", () => {
  const accessor = clone();
  let invoked = false;
  Object.defineProperty(accessor, "caseId", {
    enumerable: true,
    get() {
      invoked = true;
      return "unsafe";
    },
  });
  assertHasError(validateRealClientObservationPlan(accessor), /enumerable data property/);
  assert.equal(invoked, false);

  const sparse = clone();
  sparse.fixtureFiles = new Array(1);
  assertHasError(validateRealClientObservationPlan(sparse), /dense/);

  const proxied = new Proxy(clone(), {});
  assertHasError(validateRealClientObservationPlan(proxied), /closed plain data object/);
});

test("rejects unsafe fixture paths, commands, credentials, duplicates, and marker drift", () => {
  const value = clone();
  value.fixtureFiles = [
    {
      content: "D15_DUP\n",
      markerId: "D15_DUP",
      path: "../escape.md",
    },
    {
      content: "D15_DUP\ncurl example.invalid",
      markerId: "D15_DUP",
      path: "../escape.md",
    },
    {
      content: "D15_SECRET\nghp_abcdefghijklmnopqrstuvwxyz",
      markerId: "D15_SECRET",
      path: "secret.md",
    },
    {
      content: "missing marker",
      markerId: "D15_MISSING",
      path: "missing.md",
    },
  ];
  value.expectedLoadedSourceSequence = ["unknown.md"];
  const errors = validateRealClientObservationPlan(value);
  assertHasError(errors, /normalized relative path/);
  assertHasError(errors, /markerId must be unique/);
  assertHasError(errors, /command-shaped text/);
  assertHasError(errors, /credential-shaped value/);
  assertHasError(errors, /contain markerId exactly once/);
  assertHasError(errors, /must reference a fixture path/);
});

test("rejects aggregate fixture content above the byte budget", () => {
  const value = clone();
  value.fixtureFiles = Array.from({ length: 17 }, (_, index) => ({
    content: `D15_BIG_${index}\n${"é".repeat(32_760)}`,
    markerId: `D15_BIG_${index}`,
    path: `fixture-${index}.md`,
  }));
  value.expectedLoadedSourceSequence = [];
  assertHasError(validateRealClientObservationPlan(value), /aggregate content exceeds/);
});

test("loads only a stable singly linked bounded UTF-8 plan file", (t) => {
  const directory = disposable(t);
  const valid = path.join(directory, "valid.json");
  fs.writeFileSync(valid, canonicalObservationJson(canonicalPlan));
  assert.deepEqual(loadRealClientObservationPlan(valid), canonicalPlan);

  const malformed = path.join(directory, "malformed.json");
  fs.writeFileSync(malformed, "{");
  assert.throws(() => loadRealClientObservationPlan(malformed), /malformed JSON/);

  const nul = path.join(directory, "nul.json");
  fs.writeFileSync(nul, Buffer.from([0x7b, 0x00, 0x7d]));
  assert.throws(() => loadRealClientObservationPlan(nul), /contains NUL/);

  const bom = path.join(directory, "bom.json");
  fs.writeFileSync(bom, Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d]));
  assert.throws(() => loadRealClientObservationPlan(bom), /UTF-8 BOM/);

  const invalidUtf8 = path.join(directory, "invalid.json");
  fs.writeFileSync(invalidUtf8, Buffer.from([0x7b, 0x22, 0x80, 0x22, 0x7d]));
  assert.throws(() => loadRealClientObservationPlan(invalidUtf8), /valid UTF-8/);

  const oversized = path.join(directory, "oversized.json");
  fs.writeFileSync(oversized, Buffer.alloc(REAL_CLIENT_OBSERVATION_MAX_PLAN_BYTES + 1, 0x20));
  assert.throws(() => loadRealClientObservationPlan(oversized), /exceeds 1048576 bytes/);

  const hardLink = path.join(directory, "hard-link.json");
  fs.linkSync(valid, hardLink);
  assert.throws(() => loadRealClientObservationPlan(valid), /singly linked ordinary file/);

  const symbolicLink = path.join(directory, "symbolic-link.json");
  fs.symlinkSync(malformed, symbolicLink);
  assert.throws(() => loadRealClientObservationPlan(symbolicLink), /singly linked ordinary file/);
});

test("runs the production version adapter against an exact binary without fixture activation", async (t) => {
  if (!requireApplicableMacosSandbox(t)) return;
  const transcript = await runRealClientObservation(versionPlan());
  assert.equal(transcript.result.status, "observed");
  assert.equal(transcript.result.exitCode, 0);
  assert.equal(transcript.result.signal, null);
  assert.equal(transcript.result.versionMatched, true);
  assert.equal(transcript.result.workspaceUnchanged, true);
  assert.match(transcript.result.stdout, new RegExp(process.version.replaceAll(".", "\\.")));
  assert.deepEqual(transcript.actualLoadedSourceSequence, []);
  assert.deepEqual(transcript.invocation.arguments, ["--version"]);
  assert.equal(transcript.invocation.shell, false);
  assert.match(transcript.client.executableIdentitySha256, /^[0-9a-f]{64}$/u);
  assert.equal(transcript.client.executableSha256, sha256File(process.execPath));
});

test("fails before execution when the client digest is not pinned exactly", async (t) => {
  if (process.platform !== "darwin") {
    t.skip("macos-sandbox-exec-v1 is intentionally macOS-only");
    return;
  }
  const plan = versionPlan();
  plan.client.executableSha256 = "0".repeat(64);
  await assert.rejects(runRealClientObservation(plan), /digest does not match/);
});

test("redacts fixture content, markers, credentials, accounts, user paths, ANSI, and controls", () => {
  const plan = clone();
  const raw = [
    plan.fixtureFiles[0].content,
    plan.fixtureFiles[0].markerId,
    "Authorization: Bearer secret-value",
    "person@example.com",
    "/Users/alice/private",
    "/tmp/client",
    "/tmp/workspace",
    "\u001b[31mred\u001b[0m",
    "\u0001",
  ].join("\n");
  const redacted = redactRealClientObservationOutput(raw, plan, "/tmp/workspace", "/tmp/client");
  assert.doesNotMatch(redacted, /D15_GEMINI_ROOT|secret-value|person@example|alice/u);
  assert.equal(redacted.includes("\u001b"), false);
  assert.equal(redacted.includes("\u0001"), false);
  assert.match(redacted, /REDACTED_CONTENT/);
  assert.match(redacted, /REDACTED_SECRET/);
  assert.match(redacted, /REDACTED_ACCOUNT/);
  assert.match(redacted, /\$CLIENT_BINARY/);
  assert.match(redacted, /\$OBSERVATION_ROOT/);
});

test("the bounded supervisor enforces output and deadline limits", async (t) => {
  if (!requireApplicableMacosSandbox(t)) return;
  const directory = disposable(t);
  const noisy = createNativeExecutable(
    directory,
    "noisy-client",
    "#include <stdio.h>\nint main(void) { for (int i = 0; i < 70000; i++) putchar('x'); return 0; }\n",
  );
  await assert.rejects(
    runRealClientObservation(versionPlan(noisy, "unused-version")),
    /output exceeded/,
  );

  const slow = createNativeExecutable(
    directory,
    "slow-client",
    "#include <unistd.h>\nint main(void) { sleep(30); return 0; }\n",
  );
  const startedAt = Date.now();
  await assert.rejects(
    runRealClientObservation(versionPlan(slow, "unused-version")),
    /exceeded its deadline/,
  );
  assert.ok(Date.now() - startedAt >= 9_000);
});

test("a script client cannot escape through an unlisted interpreter", async (t) => {
  if (!requireApplicableMacosSandbox(t)) return;
  const directory = disposable(t);
  const executable = createExecutable(
    directory,
    'await import("node:fs").then(({ writeFileSync }) => writeFileSync("mutation.txt", "x")); process.stdout.write("fake-v1");',
  );
  const transcript = await runRealClientObservation(versionPlan(executable, "fake-v1"));
  assert.equal(transcript.result.status, "failed");
  assert.equal(transcript.result.workspaceUnchanged, true);
  assert.notEqual(transcript.result.exitCode, 0);
});

test("unsupported platforms fail before any client execution", async (t) => {
  if (process.platform === "darwin") {
    t.skip("the production supervisor is available on macOS");
    return;
  }
  await assert.rejects(runRealClientObservation(versionPlan()), /unavailable on this platform/);
});

test("the production sandbox denies network, writes, other execution, and user-home reads", async (t) => {
  if (!requireApplicableMacosSandbox(t)) return;
  const directory = disposable(t);
  const source = path.join(directory, "sandbox-adversary.c");
  const executable = path.join(directory, "sandbox-adversary");
  fs.writeFileSync(
    source,
    [
      "#include <arpa/inet.h>",
      "#include <errno.h>",
      "#include <fcntl.h>",
      "#include <spawn.h>",
      "#include <stdio.h>",
      "#include <sys/socket.h>",
      "#include <unistd.h>",
      "extern char **environ;",
      "static int denied(void) { return errno == EPERM || errno == EACCES; }",
      "int main(void) {",
      "  int network_denied = 0;",
      "  int socket_fd = socket(AF_INET, SOCK_STREAM, 0);",
      "  if (socket_fd < 0) network_denied = denied();",
      "  else {",
      "    struct sockaddr_in address = {0};",
      "    address.sin_family = AF_INET;",
      "    address.sin_port = htons(9);",
      "    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);",
      "    errno = 0;",
      "    network_denied = connect(socket_fd, (struct sockaddr *)&address, sizeof(address)) < 0 && denied();",
      "    close(socket_fd);",
      "  }",
      "  errno = 0;",
      '  int write_fd = open("forbidden-write", O_CREAT | O_WRONLY, 0600);',
      "  int write_denied = write_fd < 0 && denied();",
      "  if (write_fd >= 0) close(write_fd);",
      "  pid_t child = 0;",
      '  char *arguments[] = {"/usr/bin/true", NULL};',
      "  errno = 0;",
      '  int spawn_result = posix_spawn(&child, "/usr/bin/true", NULL, NULL, arguments, environ);',
      "  int exec_denied = spawn_result == EPERM || spawn_result == EACCES;",
      "  errno = 0;",
      '  int home_fd = open("/Users", O_RDONLY);',
      "  int home_denied = home_fd < 0 && denied();",
      "  if (home_fd >= 0) close(home_fd);",
      '  printf("sandbox-policy-v1 network=%d write=%d exec=%d home=%d\\n", network_denied, write_denied, exec_denied, home_denied);',
      "  return network_denied && write_denied && exec_denied && home_denied ? 0 : 42;",
      "}",
    ].join("\n"),
  );
  const compile = spawnSync("/usr/bin/clang", ["-O2", source, "-o", executable], {
    encoding: "utf8",
  });
  assert.equal(compile.status, 0, compile.stderr);
  const transcript = await runRealClientObservation(versionPlan(executable, "sandbox-policy-v1"));
  assert.equal(transcript.result.status, "observed", transcript.result.stderr);
  assert.match(transcript.result.stdout, /network=1 write=1 exec=1 home=1/u);
  assert.equal(transcript.result.workspaceUnchanged, true);
});

test("writes only issued transcripts privately, exclusively, and canonically", async (t) => {
  const directory = disposable(t);
  const output = path.join(directory, "transcript.json");
  const transcript = await runRealClientObservation(canonicalPlan);
  writeRealClientObservationTranscript(output, transcript);
  assert.deepEqual(JSON.parse(fs.readFileSync(output, "utf8")), transcript);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(output).mode & 0o777, 0o600);
  }
  assert.throws(() => writeRealClientObservationTranscript(output, transcript), /already exists/);
  assert.throws(
    () =>
      writeRealClientObservationTranscript(path.join(directory, "untrusted.json"), {
        secret: "value",
      }),
    /only a transcript issued/,
  );
});

test("CLI validation and blocked recording require exact arguments", (t) => {
  const directory = disposable(t);
  const output = path.join(directory, "transcript.json");
  const validate = spawnSync(
    process.execPath,
    ["tools/conformance/real-client-observation.mjs", "validate", PLAN_PATH],
    { encoding: "utf8" },
  );
  assert.equal(validate.status, 0, validate.stderr);
  assert.match(validate.stdout, /valid gemini-no-safe-signal/);

  const missingAcknowledgement = spawnSync(
    process.execPath,
    ["tools/conformance/real-client-observation.mjs", "run", PLAN_PATH, output],
    { encoding: "utf8" },
  );
  assert.equal(missingAcknowledgement.status, 1);
  assert.match(missingAcknowledgement.stderr, /explicit execution acknowledgement/);
  assert.equal(fs.existsSync(output), false);

  const run = spawnSync(
    process.execPath,
    [
      "tools/conformance/real-client-observation.mjs",
      "run",
      PLAN_PATH,
      output,
      "--acknowledge-client-execution",
    ],
    { encoding: "utf8" },
  );
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /recorded gemini-no-safe-signal blocked/);
  assert.equal(JSON.parse(fs.readFileSync(output, "utf8")).result.status, "blocked");
});
