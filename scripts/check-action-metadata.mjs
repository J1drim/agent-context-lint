import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseDocument } from "yaml";

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const actionMetadataPath = path.join(rootDirectory, "action", "action.yml");

function equal(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function parse(source, issues) {
  const document = parseDocument(source, { prettyErrors: true, uniqueKeys: true });
  for (const error of document.errors)
    issues.push(`action metadata has invalid YAML: ${error.message}`);
  if (document.errors.length > 0) return {};
  try {
    const value = document.toJS({ maxAliasCount: 0 });
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      issues.push("action metadata must be a YAML mapping");
      return {};
    }
    return value;
  } catch (error) {
    issues.push(`action metadata is unsafe: ${error.message}`);
    return {};
  }
}

export function validateActionMetadataSource(source) {
  const issues = [];
  const metadata = parse(source, issues);
  if (
    !equal(Object.keys(metadata).sort(), [
      "author",
      "branding",
      "description",
      "inputs",
      "name",
      "runs",
    ])
  )
    issues.push("action metadata contains an unreviewed root key");
  if (
    metadata.name !== "Agent Context Linter" ||
    metadata.description !==
      "Run the deterministic offline linter and emit bounded GitHub annotations" ||
    metadata.author !== "Area Automation"
  )
    issues.push("action identity is incomplete");
  if (!equal(metadata.branding, { color: "purple", icon: "check-circle" }))
    issues.push("action branding is outside the reviewed contract");
  if (
    metadata.runs?.main !== "dist/index.js" ||
    metadata.runs?.using !== "node24" ||
    !equal(Object.keys(metadata.runs ?? {}).sort(), ["main", "using"])
  )
    issues.push("action must execute only the bundled Node 24 entry point");
  const expectedInputs = {
    base: "",
    changed: "false",
    "fail-on": "warning",
    "max-annotations": "50",
    "working-directory": ".",
  };
  if (!equal(Object.keys(metadata.inputs ?? {}).sort(), Object.keys(expectedInputs).sort()))
    issues.push("action inputs must match the closed wrapper contract");
  for (const [name, fallback] of Object.entries(expectedInputs)) {
    const definition = metadata.inputs?.[name];
    if (
      definition === null ||
      typeof definition !== "object" ||
      Array.isArray(definition) ||
      typeof definition.description !== "string" ||
      definition.required !== false ||
      definition.default !== fallback ||
      Object.keys(definition).some((key) => !["default", "description", "required"].includes(key))
    )
      issues.push(`action input ${name} is outside the closed wrapper contract`);
  }
  if (issues.length > 0)
    throw new Error(`GitHub Action metadata violations:\n- ${issues.join("\n- ")}`);
  return Object.freeze(metadata);
}

export async function validateCommittedActionMetadata() {
  return validateActionMetadataSource(await readFile(actionMetadataPath, "utf8"));
}

const invoked =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  await validateCommittedActionMetadata();
  console.log("Validated reusable GitHub Action metadata without a hosted workflow.");
}
