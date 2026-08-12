import assert from "node:assert/strict";
import test from "node:test";

import {
  MAXIMUM_RESPONSE_BYTES,
  createGitHubMetadataClient,
  instructionEvidenceFromTree,
} from "./discover.mjs";

function jsonResponse(value, init = {}) {
  const body = JSON.stringify(value);
  return new Response(body, {
    ...init,
    headers: { "content-length": String(Buffer.byteLength(body)), ...init.headers },
  });
}

test("metadata transport is serial, allowlisted, redirect-denied, and token-safe", async () => {
  const calls = [];
  const client = createGitHubMetadataClient({
    fetchImplementation: async (url, options) => {
      calls.push({ options, url: String(url) });
      return jsonResponse({ incomplete_results: false, items: [], total_count: 0 });
    },
    token: "secret-token",
  });
  await client.get("/search/code", { query: { q: "filename:AGENTS.md" } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.startsWith("https://api.github.com/search/code?"), true);
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(calls[0].options.headers.Authorization, "Bearer secret-token");
  await assert.rejects(client.get("//evil.example/repos/a/b"), /allowlist/);
  assert.equal(JSON.stringify(calls).includes("secret-token"), true);
});

test("capture fails closed on source text, match fragments, README bodies, and content", async () => {
  for (const forbidden of [
    { content: "source" },
    { readme: { content: "source" } },
    { text: "source" },
    { text_matches: [{ fragment: "source" }] },
  ]) {
    const client = createGitHubMetadataClient({
      fetchImplementation: async () => jsonResponse(forbidden),
    });
    await assert.rejects(client.get("/search/code"), /forbidden repository-content field/);
  }
});

test("recursive tree metadata recognizes every exact product grammar and rejects case variants", () => {
  const supported = [
    "AGENTS.md",
    "packages/api/AGENTS.override.md",
    "CLAUDE.md",
    "packages/api/CLAUDE.local.md",
    ".claude/rules/testing.md",
    "nested/.claude/rules/deep/style.md",
    ".github/copilot-instructions.md",
    "nested/.github/copilot-instructions.md",
    ".github/instructions/test.instructions.md",
    "nested/.github/instructions/deep/test.instructions.md",
    ".cursor/rules/project.mdc",
    "nested/.cursor/rules/deep/project.mdc",
    ".cursorrules",
    "GEMINI.md",
    "packages/api/GEMINI.md",
  ];
  const rejected = [
    ".GitHub/copilot-instructions.md",
    ".gitHub/copilot-instructions.md",
    "gemini.md",
    "agents.md",
    ".Cursor/rules/project.mdc",
    "nested/.cursorrules",
    ".claude/Rules/project.md",
    ".github/instructions/not.md",
  ];
  const tree = {
    sha: "b".repeat(40),
    tree: [...supported, ...rejected].map((pathValue, index) => ({
      mode: "100644",
      path: pathValue,
      sha: (index % 10).toString().repeat(40),
      size: 1,
      type: "blob",
      url: `https://api.github.com/blob/${String(index)}`,
    })),
    truncated: false,
  };
  const result = instructionEvidenceFromTree(
    "https://api.github.com/repos/example/project",
    tree.sha,
    tree,
  );
  assert.deepEqual(
    result.instructionEvidence.map((entry) => entry.path).sort(),
    [...supported].sort(),
  );
  assert.equal(
    result.instructionEvidence.every(
      (entry) =>
        entry.metadataUrl === `https://api.github.com/repos/example/project/git/trees/${tree.sha}`,
    ),
    true,
  );
});

test("recursive tree metadata rejects truncation, duplicates, hostile paths, and invalid blob SHAs", () => {
  const valid = { mode: "100644", path: "AGENTS.md", sha: "a".repeat(40), size: 1, type: "blob" };
  const parse = (tree) =>
    instructionEvidenceFromTree("https://api.github.com/repos/example/project", "b".repeat(40), {
      sha: "b".repeat(40),
      ...tree,
    });
  assert.throws(() => parse({ tree: [valid], truncated: true }), /truncated/);
  assert.throws(() => parse({ tree: [valid, valid], truncated: false }), /duplicate path/);
  assert.throws(
    () => parse({ tree: [{ ...valid, path: "../AGENTS.md" }], truncated: false }),
    /hostile/,
  );
  assert.throws(
    () => parse({ tree: [{ ...valid, sha: "invalid" }], truncated: false }),
    /invalid SHA/,
  );
  assert.throws(() => parse({ sha: "c".repeat(40), tree: [valid], truncated: false }), /root SHA/);
  assert.throws(
    () => parse({ tree: [{ ...valid, mode: "040000", type: "blob" }], truncated: false }),
    /mode\/type/,
  );
});

test("tree evidence accepts regular and executable files but excludes instruction symlinks", () => {
  const treeSha = "b".repeat(40);
  const result = instructionEvidenceFromTree(
    "https://api.github.com/repos/example/project",
    treeSha,
    {
      sha: treeSha,
      tree: [
        { mode: "100644", path: "AGENTS.md", sha: "a".repeat(40), size: 1, type: "blob" },
        {
          mode: "100755",
          path: "nested/GEMINI.md",
          sha: "c".repeat(40),
          size: 2,
          type: "blob",
        },
        { mode: "120000", path: "CLAUDE.md", sha: "d".repeat(40), size: 10, type: "blob" },
        { mode: "040000", path: "nested", sha: "e".repeat(40), type: "tree" },
        { mode: "160000", path: "vendor", sha: "f".repeat(40), type: "commit" },
      ],
      truncated: false,
    },
  );
  assert.deepEqual(
    result.instructionEvidence.map((entry) => entry.path),
    ["AGENTS.md", "nested/GEMINI.md"],
  );
  assert.throws(
    () =>
      instructionEvidenceFromTree("https://api.github.com/repos/example/project", treeSha, {
        sha: treeSha,
        tree: [{ mode: "100644", path: "AGENTS.md", sha: "a".repeat(40), type: "blob" }],
        truncated: false,
      }),
    /invalid size/,
  );
});

test("rate limits, malformed UTF-8, and oversized metadata stop without retry", async () => {
  let calls = 0;
  const limited = createGitHubMetadataClient({
    fetchImplementation: async () => {
      calls += 1;
      return new Response(null, {
        headers: { "retry-after": "60", "x-ratelimit-reset": "1800000000" },
        status: 429,
      });
    },
  });
  await assert.rejects(limited.get("/search/code"), /stop without retry/);
  assert.equal(calls, 1);

  const oversized = createGitHubMetadataClient({
    fetchImplementation: async () =>
      new Response("{}", { headers: { "content-length": String(MAXIMUM_RESPONSE_BYTES + 1) } }),
  });
  await assert.rejects(oversized.get("/search/code"), /byte limit/);

  const malformed = createGitHubMetadataClient({
    fetchImplementation: async () =>
      new Response(Uint8Array.from([0xff]), { headers: { "content-length": "1" } }),
  });
  await assert.rejects(malformed.get("/search/code"), /valid UTF-8 JSON/);
});
