import assert from "node:assert/strict";
import test from "node:test";

import { parseDocumentationExamples } from "./check-documentation-examples.mjs";

function documentFor(metadata, command = "agent-context-lint --help") {
  return `# Reference\n\n<!-- agent-context-lint-example ${JSON.stringify(metadata)} -->\n\n\`\`\`sh\n${command}\n\`\`\`\n`;
}

test("documentation examples bind structured argv to the visible shell command", () => {
  assert.deepEqual(
    parseDocumentationExamples(documentFor({ argv: ["--help"], stdoutIncludes: "Usage:" })),
    [{ argv: ["--help"], stdoutIncludes: "Usage:" }],
  );
  assert.deepEqual(
    parseDocumentationExamples(
      documentFor(
        { argv: ["explain", "file with space", "--help"], stdoutIncludes: "Usage:" },
        "agent-context-lint explain 'file with space' --help",
      ),
    )[0]?.argv,
    ["explain", "file with space", "--help"],
  );
});

test("documentation examples reject malformed, duplicated, hidden, and mismatched commands", () => {
  const valid = documentFor({ argv: ["--help"], stdoutIncludes: "Usage:" });
  const malformedCases = [
    "",
    "<!-- agent-context-lint-example nope -->",
    documentFor({ argv: [], stdoutIncludes: "Usage:" }),
    documentFor({ argv: ["--help"], stdoutIncludes: "" }),
    documentFor({ argv: ["--help"], stdoutIncludes: "Usage:", extra: true }),
    documentFor({ argv: ["bad\nvalue"], stdoutIncludes: "Usage:" }),
    documentFor({ argv: ["--help"], stdoutIncludes: "Usage:" }, "agent-context-lint --version"),
    `${valid}\n${valid}`,
    `${valid}\n<!-- agent-context-lint-example {"argv":["--version"],"stdoutIncludes":"0"} -->`,
  ];
  for (const source of malformedCases)
    assert.throws(() => parseDocumentationExamples(source), /invalid executable example/u);
});

test("documentation example parser bounds source and argv resources", () => {
  assert.throws(
    () => parseDocumentationExamples("x".repeat(2 * 1_024 * 1_024 + 1)),
    /invalid executable example/u,
  );
  assert.throws(
    () =>
      parseDocumentationExamples(
        documentFor({ argv: Array.from({ length: 9 }, () => "x"), stdoutIncludes: "x" }),
      ),
    /invalid executable example/u,
  );
});
