import { readFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

const MARKER = "<!-- agent-context-lint-example ";
const EXAMPLE_PATTERN =
  /<!-- agent-context-lint-example (?<metadata>[^\r\n]+) -->\r?\n\r?\n```sh\r?\n(?<command>[^\r\n]+)\r?\n```/gu;
// eslint-disable-next-line no-control-regex -- generated metadata must reject controls.
const CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;

function invalidExamples() {
  throw new TypeError("generated command reference contains an invalid executable example");
}

function shellDisplay(argument) {
  return /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u.test(argument) ||
    /^--[A-Za-z0-9-]+$/u.test(argument)
    ? argument
    : `'${argument.replaceAll("'", `'\\''`)}'`;
}

function assertExample(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(["argv", "stdoutIncludes"])
  )
    invalidExamples();
  if (!Array.isArray(value.argv) || value.argv.length < 1 || value.argv.length > 8)
    invalidExamples();
  for (const argument of value.argv) {
    if (
      typeof argument !== "string" ||
      argument.length === 0 ||
      Buffer.byteLength(argument, "utf8") > 8_192 ||
      CONTROL_PATTERN.test(argument)
    )
      invalidExamples();
  }
  if (
    typeof value.stdoutIncludes !== "string" ||
    value.stdoutIncludes.length === 0 ||
    Buffer.byteLength(value.stdoutIncludes, "utf8") > 8_192 ||
    CONTROL_PATTERN.test(value.stdoutIncludes)
  )
    invalidExamples();
}

export function parseDocumentationExamples(markdown, cliName = "agent-context-lint") {
  if (typeof markdown !== "string" || markdown.length > 2 * 1_024 * 1_024) invalidExamples();
  const markerCount = markdown.split(MARKER).length - 1;
  const examples = [];
  const seen = new Set();
  for (const match of markdown.matchAll(EXAMPLE_PATTERN)) {
    let metadata;
    try {
      metadata = JSON.parse(match.groups?.metadata ?? "");
    } catch {
      invalidExamples();
    }
    assertExample(metadata);
    const expectedCommand = [cliName, ...metadata.argv].map(shellDisplay).join(" ");
    if (match.groups?.command !== expectedCommand) invalidExamples();
    const identity = JSON.stringify(metadata.argv);
    if (seen.has(identity)) invalidExamples();
    seen.add(identity);
    examples.push(
      Object.freeze({
        argv: Object.freeze([...metadata.argv]),
        stdoutIncludes: metadata.stdoutIncludes,
      }),
    );
  }
  if (examples.length === 0 || examples.length !== markerCount) invalidExamples();
  return Object.freeze(examples);
}

export async function verifyPackedDocumentationExamples(packageDirectory, markdownPath) {
  const packageManifest = JSON.parse(
    await readFile(path.join(packageDirectory, "package.json"), "utf8"),
  );
  const cliName = Object.keys(packageManifest.bin ?? {})[0];
  if (typeof cliName !== "string" || cliName !== "agent-context-lint") invalidExamples();
  const executable = path.join(packageDirectory, packageManifest.bin[cliName]);
  const examples = parseDocumentationExamples(await readFile(markdownPath, "utf8"), cliName);
  for (const example of examples) {
    const result = spawnSync(process.execPath, [executable, ...example.argv], {
      cwd: packageDirectory,
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1" },
      shell: false,
      timeout: 10_000,
    });
    if (
      result.error !== undefined ||
      result.signal !== null ||
      result.status !== 0 ||
      result.stderr !== "" ||
      !result.stdout.includes(example.stdoutIncludes)
    )
      throw new TypeError(
        `packed CLI documentation example failed: ${JSON.stringify(example.argv)}`,
      );
  }
  return Object.freeze({ exampleCount: examples.length });
}
