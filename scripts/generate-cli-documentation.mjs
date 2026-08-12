import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import prettier from "prettier";

import {
  CLI_COMMAND_DEFINITIONS,
  CLI_COMMAND_REGISTRY_VERSION,
  CLI_GLOBAL_OPTIONS,
  CLI_NAME,
  CLI_VERSION,
} from "../packages/cli/src/command-router.ts";
import {
  CLI_DOCUMENTATION_REFERENCE_VERSION,
  renderBashCompletion,
  renderCliDocumentationReferenceJson,
  renderCommandReferenceMarkdown,
  renderFishCompletion,
  renderManPage,
  renderZshCompletion,
  validateCliDocumentationReference,
} from "../packages/cli/src/documentation-artifacts.ts";
import { CONFIGURATION_FILE_NAME } from "../packages/core/src/configuration-contracts.ts";
import { RULE_REGISTRY } from "../packages/rules/src/registry.ts";

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configurationSchemaPath = path.join(
  rootDirectory,
  "packages/core/schemas/agent-context-lint-config.v1.schema.json",
);
const referenceSchemaPath = path.join(
  rootDirectory,
  "packages/cli/schemas/agent-context-lint-reference.v1.schema.json",
);

export const GENERATED_CLI_DOCUMENTATION_PATHS = Object.freeze([
  "docs/api/command-reference.md",
  "packages/cli/completions/agent-context-lint.bash",
  "packages/cli/completions/_agent-context-lint",
  "packages/cli/completions/agent-context-lint.fish",
  "packages/cli/man/agent-context-lint.1",
  "packages/cli/reference/agent-context-lint-reference.v1.json",
  "tests/goldens/i14-documentation-artifacts.v1.json",
]);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function cloneCommand(command) {
  return {
    completion: command.completion,
    description: command.description,
    implementationTicket: command.implementationTicket,
    maximumOperands: command.maximumOperands,
    minimumOperands: command.minimumOperands,
    name: command.name,
    options: command.options.map(cloneOption),
    usage: command.usage,
    validFirstOperands: [...command.validFirstOperands],
  };
}

function cloneOption(option) {
  return {
    completion: option.completion,
    description: option.description,
    names: [...option.names],
    valueName: option.valueName,
    values: [...option.values],
  };
}

export async function buildCliDocumentationReference() {
  const schemaBytes = await readFile(configurationSchemaPath);
  const schema = JSON.parse(schemaBytes.toString("utf8"));
  const reference = {
    commands: [...CLI_COMMAND_DEFINITIONS]
      .sort((left, right) => left.name.localeCompare(right.name, "en"))
      .map(cloneCommand),
    configuration: {
      fileName: CONFIGURATION_FILE_NAME,
      schema,
      schemaId: schema.$id,
      schemaSha256: sha256(schemaBytes),
    },
    globalOptions: CLI_GLOBAL_OPTIONS.map(cloneOption),
    product: {
      cliName: CLI_NAME,
      cliVersion: CLI_VERSION,
      commandRegistryVersion: CLI_COMMAND_REGISTRY_VERSION,
    },
    rules: {
      contractVersion: RULE_REGISTRY.contractVersion,
      entries: RULE_REGISTRY.rules.map((rule) => ({ ...rule })),
    },
    schemaVersion: CLI_DOCUMENTATION_REFERENCE_VERSION,
  };
  validateCliDocumentationReference(reference);
  return reference;
}

export async function renderCliDocumentationArtifacts() {
  const reference = await buildCliDocumentationReference();
  const markdownPath = path.join(rootDirectory, "docs/api/command-reference.md");
  const prettierConfig = (await prettier.resolveConfig(markdownPath)) ?? {};
  const markdown = await prettier.format(renderCommandReferenceMarkdown(reference), {
    ...prettierConfig,
    filepath: markdownPath,
  });
  const artifacts = new Map([
    ["docs/api/command-reference.md", markdown],
    ["packages/cli/completions/agent-context-lint.bash", renderBashCompletion(reference)],
    ["packages/cli/completions/_agent-context-lint", renderZshCompletion(reference)],
    ["packages/cli/completions/agent-context-lint.fish", renderFishCompletion(reference)],
    ["packages/cli/man/agent-context-lint.1", renderManPage(reference)],
    [
      "packages/cli/reference/agent-context-lint-reference.v1.json",
      renderCliDocumentationReferenceJson(reference),
    ],
  ]);
  const golden = {
    artifacts: [...artifacts]
      .map(([relativePath, contents]) => ({
        path: relativePath,
        sha256: sha256(Buffer.from(contents, "utf8")),
      }))
      .sort((left, right) => left.path.localeCompare(right.path, "en")),
    schemaVersion: "1.0.0",
  };
  artifacts.set(
    "tests/goldens/i14-documentation-artifacts.v1.json",
    `${JSON.stringify(golden, null, 2)}\n`,
  );
  if (
    artifacts.size !== GENERATED_CLI_DOCUMENTATION_PATHS.length ||
    GENERATED_CLI_DOCUMENTATION_PATHS.some((entry) => !artifacts.has(entry))
  )
    throw new TypeError("generated CLI documentation artifact inventory is inconsistent");

  const referenceSchema = JSON.parse(await readFile(referenceSchemaPath, "utf8"));
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const validate = ajv.compile(referenceSchema);
  const machineReference = JSON.parse(
    artifacts.get("packages/cli/reference/agent-context-lint-reference.v1.json"),
  );
  if (!validate(machineReference))
    throw new TypeError(
      `generated CLI reference failed its schema: ${ajv.errorsText(validate.errors)}`,
    );
  return artifacts;
}

export async function findStaleCliDocumentationArtifacts(artifacts, readText) {
  const stale = [];
  for (const [relativePath, expected] of artifacts) {
    const actual = await readText(relativePath);
    if (actual !== expected) stale.push(relativePath);
  }
  return Object.freeze(stale);
}

export async function generateCliDocumentation(mode = "check") {
  if (mode !== "check" && mode !== "write")
    throw new TypeError("usage: generate-cli-documentation.mjs [--check|--write]");
  const artifacts = await renderCliDocumentationArtifacts();
  if (mode === "write") {
    for (const [relativePath, expected] of artifacts) {
      const absolutePath = path.join(rootDirectory, relativePath);
      await mkdir(path.dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, expected, "utf8");
    }
  }
  const stale =
    mode === "write"
      ? []
      : await findStaleCliDocumentationArtifacts(artifacts, async (relativePath) =>
          readFile(path.join(rootDirectory, relativePath), "utf8").catch((error) => {
            if (error?.code === "ENOENT") return "";
            throw error;
          }),
        );
  if (stale.length > 0)
    throw new TypeError(
      `generated CLI documentation is stale (${stale.join(", ")}); run pnpm docs:artifacts`,
    );
  process.stdout.write(
    `${mode === "write" ? "Generated" : "Verified"} ${String(artifacts.size)} CLI documentation artifacts.\n`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 3)
    throw new TypeError("usage: generate-cli-documentation.mjs [--check|--write]");
  const argument = process.argv[2];
  if (argument !== undefined && argument !== "--check" && argument !== "--write")
    throw new TypeError("usage: generate-cli-documentation.mjs [--check|--write]");
  await generateCliDocumentation(argument === "--write" ? "write" : "check");
}
