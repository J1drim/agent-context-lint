import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const DOCUMENTATION_COVERAGE_VERSION = "1.0.0";
const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;

const TOPICS = [
  {
    id: "user-guide",
    files: [
      ["docs/user/getting-started.md", ["## Install", "## Run the first scan"]],
      ["docs/user/commands.md", ["# Listing, explaining, rules, and initialization"]],
      ["docs/user/scanning.md", ["# Scanning repositories"]],
    ],
  },
  {
    id: "concepts",
    files: [
      [
        "docs/user/effective-context.md",
        ["# Understanding effective context", "assembly.state: exact"],
      ],
      ["docs/user/explain.md", ["# Understanding an explanation", "conditional"]],
    ],
  },
  {
    id: "rules",
    files: [
      ["docs/rules/catalog.md", ["# Rule catalog", "### ACL100", "### ACL558"]],
      ["docs/rules/mechanical-fix-safety.md", ["# Mechanical-fix safety matrix", "ACL109"]],
    ],
  },
  {
    id: "profiles",
    files: [
      ["docs/user/profiles.md", ["# Profile limitations and surfaces", "copilot-code-review"]],
      ["docs/profiles/README.md", ["# Client profile specifications", "Unknown"]],
      ["docs/profiles/codex-cli-agents.md", ["# Codex CLI"]],
      ["docs/profiles/claude-code/compatibility.md", ["# Claude Code"]],
      ["docs/profiles/copilot-surface-support.md", ["# GitHub Copilot"]],
      ["docs/profiles/gemini-cli/compatibility.md", ["# Gemini CLI"]],
      ["docs/profiles/cursor/compatibility.md", ["# Cursor"]],
    ],
  },
  {
    id: "migration",
    files: [
      ["docs/user/migration.md", ["# Migrating multi-agent instruction layouts", "rollback"]],
      ["docs/user/canonical-policy-sync.md", ["# Synchronizing a canonical policy"]],
    ],
  },
  {
    id: "ci",
    files: [
      ["docs/user/ci.md", ["# CI integration", "contents: read"]],
      [
        "action/README.md",
        ["# Agent Context Linter action", "reviewed full 40-character commit SHAs"],
      ],
      [
        "docs/development/continuous-integration.md",
        ["# Continuous integration", "Required matrix"],
      ],
    ],
  },
  {
    id: "security",
    files: [
      ["SECURITY.md", ["# Security Policy"]],
      ["docs/security/threat-model.md", ["# Agent Context Linter threat model"]],
      ["docs/security/security-response.md", ["# Security response"]],
    ],
  },
  {
    id: "standards",
    files: [
      ["docs/user/standards.md", ["# Standards knowledge and updates", "registry-unconfigured"]],
      ["docs/api/offline-standards-status.md", ["# Offline standards status API"]],
      ["docs/api/standards-check.md", ["# Signed standards freshness check"]],
      ["docs/api/standards-update.md", ["# Verified standards update API"]],
      [
        "docs/operations/standards-update-rollback.md",
        ["# Standards activation and rollback runbook"],
      ],
    ],
  },
  {
    id: "efficiency",
    files: [
      ["docs/user/context-efficiency-score.md", ["# Reading a context-efficiency score"]],
      ["docs/user/context-efficiency-reports.md", ["# Context-efficiency reports"]],
      [
        "docs/user/context-efficiency-recommendations.md",
        ["# Understanding efficiency recommendations"],
      ],
      ["docs/api/efficiency-score-specification.md", ["# Efficiency score specification"]],
    ],
  },
];

export const DOCUMENTATION_COVERAGE_TOPICS = Object.freeze(
  TOPICS.map((topic) =>
    Object.freeze({
      id: topic.id,
      files: Object.freeze(topic.files.map(([relativePath]) => relativePath)),
    }),
  ),
);

export const REQUIRED_DOCUMENTATION_FILES = Object.freeze(
  [
    "README.md",
    "docs/user/README.md",
    ...TOPICS.flatMap((topic) => topic.files.map(([relativePath]) => relativePath)),
  ]
    .filter((relativePath, index, entries) => entries.indexOf(relativePath) === index)
    .sort(),
);

const DISCOVERABILITY_LINKS = Object.freeze([
  ["README.md", "docs/user/README.md"],
  ["docs/user/README.md", "getting-started.md"],
  ["docs/user/README.md", "commands.md"],
  ["docs/user/README.md", "../rules/catalog.md"],
  ["docs/user/README.md", "scanning.md"],
  ["docs/user/README.md", "effective-context.md"],
  ["docs/user/README.md", "explain.md"],
  ["docs/user/README.md", "migration.md"],
  ["docs/user/README.md", "profiles.md"],
  ["docs/user/README.md", "canonical-policy-sync.md"],
  ["docs/user/README.md", "ci.md"],
  ["docs/user/README.md", "standards.md"],
  ["docs/user/README.md", "mechanical-fixes.md"],
  ["docs/user/README.md", "shell-completion.md"],
  ["docs/user/README.md", "context-efficiency-score.md"],
  ["docs/user/README.md", "context-efficiency-reports.md"],
  ["docs/user/README.md", "context-efficiency-metrics.md"],
  ["docs/user/README.md", "context-efficiency-recommendations.md"],
  ["docs/user/README.md", "library-api.md"],
  ["docs/user/README.md", "machine-reference.md"],
  ["docs/user/README.md", "../profiles/README.md"],
  ["docs/user/README.md", "../security/threat-model.md"],
  ["docs/user/README.md", "../api/command-reference.md"],
]);

function fail(message) {
  throw new TypeError(message);
}

async function readDocument(rootDirectory, relativePath) {
  const absolutePath = path.join(rootDirectory, relativePath);
  let metadata;
  try {
    metadata = await lstat(absolutePath);
  } catch (error) {
    if (error?.code === "ENOENT") fail(`documentation coverage missing file: ${relativePath}`);
    fail(`documentation coverage could not inspect file: ${relativePath}`);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink())
    fail(`documentation coverage requires an ordinary file: ${relativePath}`);
  if (metadata.size > MAX_DOCUMENT_BYTES)
    fail(`documentation coverage file is too large: ${relativePath}`);
  try {
    return await readFile(absolutePath, "utf8");
  } catch {
    fail(`documentation coverage could not read file: ${relativePath}`);
  }
}

function hasMarkdownLink(source, destination) {
  return source.includes(`](${destination})`) || source.includes(`](<${destination}>)`);
}

export async function checkDocumentationCoverage(rootDirectory) {
  if (typeof rootDirectory !== "string" || rootDirectory.length === 0)
    fail("documentation coverage root is required");
  const root = path.resolve(rootDirectory);
  const documents = new Map();
  for (const relativePath of REQUIRED_DOCUMENTATION_FILES)
    documents.set(relativePath, await readDocument(root, relativePath));

  const issues = [];
  for (const topic of TOPICS) {
    for (const [relativePath, markers] of topic.files) {
      const source = documents.get(relativePath);
      if (source === undefined) continue;
      for (const marker of markers) {
        if (!source.includes(marker))
          issues.push(`${topic.id}:${relativePath}: missing required topic marker`);
      }
    }
  }
  for (const [sourcePath, destination] of DISCOVERABILITY_LINKS) {
    const source = documents.get(sourcePath);
    if (source === undefined || !hasMarkdownLink(source, destination))
      issues.push(`${sourcePath}: missing discoverability link`);
  }
  if (issues.length > 0)
    fail(
      `documentation coverage failed (${String(issues.length)} issue${issues.length === 1 ? "" : "s"}): ${issues.join("; ")}`,
    );

  return Object.freeze({
    schemaVersion: DOCUMENTATION_COVERAGE_VERSION,
    topicCount: TOPICS.length,
    documentCount: documents.size,
    discoverabilityLinkCount: DISCOVERABILITY_LINKS.length,
    topics: DOCUMENTATION_COVERAGE_TOPICS,
  });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await checkDocumentationCoverage(process.argv[2] ?? process.cwd());
    process.stdout.write(
      `Documentation coverage is complete (${String(result.topicCount)} topics, ${String(result.documentCount)} documents, ${String(result.discoverabilityLinkCount)} index links).\n`,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
