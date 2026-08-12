import { types as nodeTypes } from "node:util";

import type { CliCommandDefinition, CliOptionDefinition } from "./command-router.js";

export const CLI_DOCUMENTATION_REFERENCE_VERSION = "1.0.0" as const;
export const CLI_DOCUMENTATION_RELEASE_DATE = "2026-08-03" as const;
export const CLI_DOCUMENTATION_MAXIMUM_COMMANDS = 128 as const;
export const CLI_DOCUMENTATION_MAXIMUM_RULES = 128 as const;
export const CLI_DOCUMENTATION_MAXIMUM_TEXT_BYTES = 8_192 as const;

export interface CliDocumentationRule {
  readonly category: string;
  readonly defaultSeverity: string;
  readonly description: string;
  readonly docsUrl: string;
  readonly fixSafety: string;
  readonly id: string;
  readonly owner: string;
  readonly precisionStatus: string;
  readonly rationale: string;
}

export interface CliDocumentationReference {
  readonly commands: readonly CliCommandDefinition[];
  readonly configuration: Readonly<{
    fileName: string;
    schema: Readonly<Record<string, unknown>>;
    schemaId: string;
    schemaSha256: string;
  }>;
  readonly globalOptions: readonly CliOptionDefinition[];
  readonly product: Readonly<{
    cliName: string;
    cliVersion: string;
    commandRegistryVersion: string;
  }>;
  readonly rules: Readonly<{
    contractVersion: string;
    entries: readonly CliDocumentationRule[];
  }>;
  readonly schemaVersion: typeof CLI_DOCUMENTATION_REFERENCE_VERSION;
}

export interface CliDocumentationExample {
  readonly argv: readonly string[];
  readonly stdoutIncludes: string;
}

// eslint-disable-next-line no-control-regex -- untrusted generated metadata must reject controls.
const CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
const UNPAIRED_SURROGATE_PATTERN =
  /(?:[\ud800-\udbff](?![\udc00-\udfff])|(?:^|[^\ud800-\udbff])[\udc00-\udfff])/u;
const SAFE_COMMAND_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;
const SAFE_CONTRACT_VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u;
const SAFE_OPTION_PATTERN = /^(?:--[a-z][a-z0-9-]{0,63}|-[A-Za-z])$/u;
const SAFE_RULE_PATTERN = /^ACL[1-5][0-9]{2}$/u;
const SAFE_DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const SAFE_TICKET_PATTERN = /^[A-Z][0-9]{2}(?:[-/][A-Z]?[0-9]{2})*$/u;
const SAFE_USAGE_PATTERN = /^[a-z][A-Za-z0-9 .<>[\]|/-]{0,1023}$/u;
const SAFE_VALUE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u;

function invalidReference(): never {
  throw new TypeError("invalid CLI documentation reference");
}

function assertPlainRecord(value: unknown): asserts value is Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    nodeTypes.isProxy(value)
  )
    invalidReference();
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) invalidReference();
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") invalidReference();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable)
      invalidReference();
  }
}

function assertText(value: unknown, pattern?: RegExp): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    UNPAIRED_SURROGATE_PATTERN.test(value) ||
    CONTROL_PATTERN.test(value) ||
    Buffer.byteLength(value, "utf8") > CLI_DOCUMENTATION_MAXIMUM_TEXT_BYTES ||
    (pattern !== undefined && !pattern.test(value))
  )
    invalidReference();
}

function assertKeys(record: Record<string, unknown>, expected: readonly string[]): void {
  const keys = Object.keys(record).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index]))
    invalidReference();
}

function assertDenseArray(value: unknown, maximum: number): asserts value is unknown[] {
  if (!Array.isArray(value) || nodeTypes.isProxy(value) || value.length > maximum)
    invalidReference();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1) invalidReference();
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable)
      invalidReference();
  }
}

function assertOption(value: unknown): asserts value is CliOptionDefinition {
  assertPlainRecord(value);
  assertKeys(value, ["completion", "description", "names", "valueName", "values"]);
  if (
    value["completion"] !== "directory" &&
    value["completion"] !== "file" &&
    value["completion"] !== "none"
  )
    invalidReference();
  assertText(value["description"]);
  assertDenseArray(value["names"], 8);
  if (value["names"].length === 0) invalidReference();
  const names = new Set<string>();
  for (const name of value["names"]) {
    assertText(name, SAFE_OPTION_PATTERN);
    if (names.has(name)) invalidReference();
    names.add(name);
  }
  if (value["valueName"] !== null) assertText(value["valueName"], SAFE_COMMAND_PATTERN);
  assertDenseArray(value["values"], 128);
  const values = new Set<string>();
  for (const item of value["values"]) {
    assertText(item, SAFE_VALUE_PATTERN);
    if (values.has(item)) invalidReference();
    values.add(item);
  }
  if (
    value["valueName"] === null &&
    (value["values"].length !== 0 || value["completion"] !== "none")
  )
    invalidReference();
  if (value["values"].length > 0 && value["completion"] !== "none") invalidReference();
}

function assertCommand(value: unknown): asserts value is CliCommandDefinition {
  assertPlainRecord(value);
  assertKeys(value, [
    "completion",
    "description",
    "implementationTicket",
    "maximumOperands",
    "minimumOperands",
    "name",
    "options",
    "usage",
    "validFirstOperands",
  ]);
  assertText(value["name"], SAFE_COMMAND_PATTERN);
  assertText(value["description"]);
  assertText(value["implementationTicket"], SAFE_TICKET_PATTERN);
  assertText(value["usage"], SAFE_USAGE_PATTERN);
  if (
    value["completion"] !== "directory" &&
    value["completion"] !== "file" &&
    value["completion"] !== "none"
  )
    invalidReference();
  if (
    !Number.isSafeInteger(value["minimumOperands"]) ||
    !Number.isSafeInteger(value["maximumOperands"]) ||
    (value["minimumOperands"] as number) < 0 ||
    (value["maximumOperands"] as number) < (value["minimumOperands"] as number)
  )
    invalidReference();
  assertDenseArray(value["options"], 32);
  const optionNames = new Set<string>();
  for (const option of value["options"]) {
    assertOption(option);
    for (const name of option.names) {
      if (optionNames.has(name)) invalidReference();
      optionNames.add(name);
    }
  }
  assertDenseArray(value["validFirstOperands"], 128);
  const operands = new Set<string>();
  for (const operand of value["validFirstOperands"]) {
    assertText(operand, SAFE_VALUE_PATTERN);
    if (operands.has(operand)) invalidReference();
    operands.add(operand);
  }
}

function assertRule(value: unknown): asserts value is CliDocumentationRule {
  assertPlainRecord(value);
  assertKeys(value, [
    "category",
    "defaultSeverity",
    "description",
    "docsUrl",
    "fixSafety",
    "id",
    "owner",
    "precisionStatus",
    "rationale",
  ]);
  assertText(value["id"], SAFE_RULE_PATTERN);
  for (const key of [
    "category",
    "defaultSeverity",
    "description",
    "docsUrl",
    "fixSafety",
    "owner",
    "precisionStatus",
    "rationale",
  ])
    assertText(value[key]);
}

function assertJsonValue(value: unknown, ancestors: Set<object>, depth: number): void {
  if (depth > 64) invalidReference();
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    if (
      typeof value === "string" &&
      (UNPAIRED_SURROGATE_PATTERN.test(value) || CONTROL_PATTERN.test(value))
    )
      invalidReference();
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) invalidReference();
    return;
  }
  if (typeof value !== "object" || nodeTypes.isProxy(value)) invalidReference();
  if (ancestors.has(value)) invalidReference();
  ancestors.add(value);
  if (Array.isArray(value)) {
    assertDenseArray(value, 16_384);
    for (const item of value) assertJsonValue(item, ancestors, depth + 1);
  } else {
    assertPlainRecord(value);
    if (Object.keys(value).length > 16_384) invalidReference();
    for (const item of Object.values(value)) assertJsonValue(item, ancestors, depth + 1);
  }
  ancestors.delete(value);
}

export function validateCliDocumentationReference(
  value: unknown,
): asserts value is CliDocumentationReference {
  assertPlainRecord(value);
  assertKeys(value, [
    "commands",
    "configuration",
    "globalOptions",
    "product",
    "rules",
    "schemaVersion",
  ]);
  if (value["schemaVersion"] !== CLI_DOCUMENTATION_REFERENCE_VERSION) invalidReference();

  assertPlainRecord(value["product"]);
  assertKeys(value["product"], ["cliName", "cliVersion", "commandRegistryVersion"]);
  assertText(value["product"]["cliName"], SAFE_COMMAND_PATTERN);
  assertText(value["product"]["cliVersion"], SAFE_CONTRACT_VERSION_PATTERN);
  assertText(value["product"]["commandRegistryVersion"], SAFE_CONTRACT_VERSION_PATTERN);

  assertDenseArray(value["globalOptions"], 32);
  if (value["globalOptions"].length === 0) invalidReference();
  const globalOptionNames = new Set<string>();
  for (const option of value["globalOptions"]) {
    assertOption(option);
    for (const name of option.names) {
      if (globalOptionNames.has(name)) invalidReference();
      globalOptionNames.add(name);
    }
  }

  assertDenseArray(value["commands"], CLI_DOCUMENTATION_MAXIMUM_COMMANDS);
  let previousCommand = "";
  const commandNames = new Set<string>();
  for (const command of value["commands"]) {
    assertCommand(command);
    if (commandNames.has(command.name) || command.name <= previousCommand) invalidReference();
    commandNames.add(command.name);
    previousCommand = command.name;
  }

  assertPlainRecord(value["configuration"]);
  assertKeys(value["configuration"], ["fileName", "schema", "schemaId", "schemaSha256"]);
  assertText(value["configuration"]["fileName"]);
  assertText(value["configuration"]["schemaId"]);
  assertText(value["configuration"]["schemaSha256"], SAFE_DIGEST_PATTERN);
  assertPlainRecord(value["configuration"]["schema"]);
  assertJsonValue(value["configuration"]["schema"], new Set(), 0);

  assertPlainRecord(value["rules"]);
  assertKeys(value["rules"], ["contractVersion", "entries"]);
  assertText(value["rules"]["contractVersion"]);
  assertDenseArray(value["rules"]["entries"], CLI_DOCUMENTATION_MAXIMUM_RULES);
  let previousRule = "";
  const ruleIds = new Set<string>();
  for (const rule of value["rules"]["entries"]) {
    assertRule(rule);
    if (ruleIds.has(rule.id) || rule.id <= previousRule) invalidReference();
    ruleIds.add(rule.id);
    previousRule = rule.id;
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

export function renderCliDocumentationReferenceJson(reference: CliDocumentationReference): string {
  validateCliDocumentationReference(reference);
  return `${JSON.stringify(canonicalize(reference), null, 2)}\n`;
}

function markdownText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\\", "&#92;")
    .replaceAll("`", "&#96;");
}

function shellDisplay(argument: string): string {
  return SAFE_VALUE_PATTERN.test(argument) || /^--[A-Za-z0-9-]+$/u.test(argument)
    ? argument
    : `'${argument.replaceAll("'", `'\\''`)}'`;
}

export function documentationExamples(
  reference: CliDocumentationReference,
): readonly CliDocumentationExample[] {
  validateCliDocumentationReference(reference);
  return Object.freeze([
    Object.freeze({ argv: Object.freeze(["--help"]), stdoutIncludes: "Usage:" }),
    Object.freeze({
      argv: Object.freeze(["--version"]),
      stdoutIncludes: reference.product.cliVersion,
    }),
    ...reference.commands.map((command) =>
      Object.freeze({
        argv: Object.freeze([command.name, "--help"]),
        stdoutIncludes: `Usage: ${reference.product.cliName} ${command.usage}`,
      }),
    ),
  ]);
}

export function renderCommandReferenceMarkdown(reference: CliDocumentationReference): string {
  validateCliDocumentationReference(reference);
  const lines = [
    "<!-- Generated by scripts/generate-cli-documentation.mjs. Do not edit manually. -->",
    "",
    "# Command reference",
    "",
    `Reference schema: \`${reference.schemaVersion}\`. Command registry: \`${reference.product.commandRegistryVersion}\`. CLI version: \`${reference.product.cliVersion}\`.`,
    "",
    "The command grammar below is generated from the same closed registry used by the argument router and shell completions. Generated examples are executed against the extracted npm tarball by the package gate. They perform no repository scan, write, model call, or network operation.",
    "",
    "## Executable examples",
    "",
  ];
  for (const example of documentationExamples(reference)) {
    const marker = JSON.stringify(example);
    const command = [reference.product.cliName, ...example.argv].map(shellDisplay).join(" ");
    lines.push(`<!-- agent-context-lint-example ${marker} -->`, "", "```sh", command, "```", "");
  }
  lines.push("## Global options", "");
  for (const option of reference.globalOptions)
    lines.push(`- \`${option.names.join(", ")}\` — ${markdownText(option.description)}`);
  lines.push("", "## Commands", "");
  for (const command of reference.commands) {
    lines.push(
      `### \`${command.name}\``,
      "",
      markdownText(command.description),
      "",
      "```text",
      `${reference.product.cliName} ${command.usage}`,
      "```",
      "",
      `Implementation owner: \`${markdownText(command.implementationTicket)}\`. Operand count: ${String(command.minimumOperands)}–${String(command.maximumOperands)}.`,
      "",
    );
    if (command.validFirstOperands.length > 0)
      lines.push(
        `First operand: ${command.validFirstOperands.map((item) => `\`${markdownText(item)}\``).join(", ")}.`,
        "",
      );
    if (command.options.length > 0) {
      lines.push("Options:", "");
      for (const option of command.options) {
        const value = option.valueName === null ? "" : ` <${option.valueName}>`;
        const choices = option.values.length === 0 ? "" : ` Values: ${option.values.join(", ")}.`;
        lines.push(
          `- \`${option.names.join(", ")}${value}\` — ${markdownText(option.description)}${choices}`,
        );
      }
      lines.push("");
    }
  }
  lines.push(
    "## Configuration and rules",
    "",
    `Configuration file: \`${markdownText(reference.configuration.fileName)}\`. Its complete generated reference is [Repository configuration](./configuration.md); the packaged machine reference embeds schema \`${markdownText(reference.configuration.schemaId)}\` with SHA-256 \`${reference.configuration.schemaSha256}\`.`,
    "",
    `The complete ${String(reference.rules.entries.length)}-entry registry contract \`${markdownText(reference.rules.contractVersion)}\` (independent of the stable product release \`1.0.0\`) is in the generated [Rule catalog](../rules/catalog.md).`,
    "",
    "## Output and platform policy",
    "",
    "Generated reference, completion, and manual artifacts contain UTF-8 text with LF line endings, no ANSI styling, timestamps, host paths, or terminal-width assumptions. Manual-page wrapping belongs to the selected pager. Native completion artifacts support Bash, Zsh, and Fish on their supported Unix-like hosts; Windows users can use the Bash artifact under WSL or Git Bash. Native PowerShell completion is outside the v1 contract and is reported as unsupported rather than emulated.",
    "",
  );
  return lines.join("\n");
}

function bashWords(values: readonly string[]): string {
  return values.join(" ");
}

function allOptionNames(command: CliCommandDefinition): readonly string[] {
  return command.options.flatMap((option) => option.names);
}

export function renderBashCompletion(reference: CliDocumentationReference): string {
  validateCliDocumentationReference(reference);
  const commands = bashWords(reference.commands.map((command) => command.name));
  const previousCases: string[] = [];
  const commandCases: string[] = [];
  for (const command of reference.commands) {
    for (const option of command.options) {
      const longName = option.names.find((name) => name.startsWith("--")) ?? option.names[0];
      if (longName === undefined || option.valueName === null) continue;
      const result =
        option.values.length > 0
          ? `COMPREPLY=( $(compgen -W '${bashWords(option.values)}' -- "$current") )`
          : option.completion === "directory"
            ? `COMPREPLY=( $(compgen -d -- "$current") )`
            : option.completion === "file"
              ? `COMPREPLY=( $(compgen -f -- "$current") )`
              : "COMPREPLY=()";
      previousCases.push(`    ${command.name}:${longName}) ${result}; return ;;`);
    }
    const operandCompletion =
      command.validFirstOperands.length > 0
        ? `COMPREPLY=( $(compgen -W '${bashWords(command.validFirstOperands)}' -- "$current") )`
        : command.completion === "directory"
          ? `COMPREPLY=( $(compgen -d -- "$current") )`
          : command.completion === "file"
            ? `COMPREPLY=( $(compgen -f -- "$current") )`
            : "COMPREPLY=()";
    commandCases.push(
      `    ${command.name})\n      if [[ "$current" == -* ]]; then COMPREPLY=( $(compgen -W '${bashWords(allOptionNames(command))}' -- "$current") ); else ${operandCompletion}; fi ;;`,
    );
  }
  return `# Generated by scripts/generate-cli-documentation.mjs. Do not edit.\n_agent_context_lint() {\n  local current previous command\n  COMPREPLY=()\n  current="\${COMP_WORDS[COMP_CWORD]}"\n  previous="\${COMP_WORDS[COMP_CWORD-1]}"\n  command="\${COMP_WORDS[1]}"\n  case "$command:$previous" in\n${previousCases.join("\n")}\n  esac\n  if (( COMP_CWORD == 1 )); then\n    COMPREPLY=( $(compgen -W '${commands} ${bashWords(reference.globalOptions.flatMap((option) => option.names))}' -- "$current") )\n    return\n  fi\n  case "$command" in\n${commandCases.join("\n")}\n  esac\n}\ncomplete -F _agent_context_lint ${reference.product.cliName}\n`;
}

function zshDescription(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll(":", "\\:")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]");
}

function singleQuoted(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function renderZshCompletion(reference: CliDocumentationReference): string {
  validateCliDocumentationReference(reference);
  const commandEntries = reference.commands
    .map((command) => singleQuoted(`${command.name}:${zshDescription(command.description)}`))
    .join("\n    ");
  const cases = reference.commands.map((command) => {
    const specifications = command.options.map((option) => {
      const firstName = option.names[0];
      if (firstName === undefined) invalidReference();
      const names = option.names.length === 1 ? firstName : `{${option.names.join(",")}}`;
      const description = `[${zshDescription(option.description)}]`;
      if (option.valueName === null) return singleQuoted(`${names}${description}`);
      const action =
        option.values.length > 0
          ? `:value:(${option.values.join(" ")})`
          : option.completion === "directory"
            ? ":directory:_directories"
            : option.completion === "file"
              ? ":file:_files"
              : `:${option.valueName}:`;
      return singleQuoted(`${names}${description}${action}`);
    });
    const operand =
      command.validFirstOperands.length > 0
        ? `'*:operation:(${command.validFirstOperands.join(" ")})'`
        : command.completion === "directory"
          ? "'*:repository:_directories'"
          : command.completion === "file"
            ? "'*:path:_files'"
            : "'*:argument:'";
    return `    ${command.name}) _arguments ${[...specifications, operand].join(" ")} ;;`;
  });
  return `#compdef ${reference.product.cliName}\n# Generated by scripts/generate-cli-documentation.mjs. Do not edit.\n_agent_context_lint() {\n  local context state line\n  local -a commands\n  typeset -A opt_args\n  commands=(\n    ${commandEntries}\n  )\n  _arguments -C '1:command:->command' '*::argument:->arguments'\n  case "$state" in\n    command) _describe 'command' commands ;;\n    arguments)\n      case "$words[2]" in\n${cases.join("\n")}\n      esac ;;\n  esac\n}\n_agent_context_lint "$@"\n`;
}

function fishCondition(command: string): string {
  return `__fish_seen_subcommand_from ${command}`;
}

export function renderFishCompletion(reference: CliDocumentationReference): string {
  validateCliDocumentationReference(reference);
  const lines = [
    "# Generated by scripts/generate-cli-documentation.mjs. Do not edit.",
    `complete -c ${reference.product.cliName} -f`,
  ];
  for (const command of reference.commands)
    lines.push(
      `complete -c ${reference.product.cliName} -n '__fish_use_subcommand' -a ${singleQuoted(command.name)} -d ${singleQuoted(command.description)}`,
    );
  for (const command of reference.commands) {
    for (const option of command.options) {
      const switches = option.names
        .map((name) => (name.startsWith("--") ? `-l ${name.slice(2)}` : `-s ${name.slice(1)}`))
        .join(" ");
      const value =
        option.valueName === null
          ? ""
          : option.values.length > 0
            ? ` -r -a ${singleQuoted(option.values.join(" "))}`
            : option.completion === "directory"
              ? " -r -a '(__fish_complete_directories)'"
              : " -r";
      lines.push(
        `complete -c ${reference.product.cliName} -n '${fishCondition(command.name)}' ${switches}${value} -d ${singleQuoted(option.description)}`,
      );
    }
    if (command.validFirstOperands.length > 0)
      lines.push(
        `complete -c ${reference.product.cliName} -n '${fishCondition(command.name)}' -a ${singleQuoted(command.validFirstOperands.join(" "))}`,
      );
    else if (command.completion === "directory")
      lines.push(
        `complete -c ${reference.product.cliName} -n '${fishCondition(command.name)}' -a '(__fish_complete_directories)'`,
      );
    else if (command.completion === "file")
      lines.push(`complete -c ${reference.product.cliName} -n '${fishCondition(command.name)}' -F`);
  }
  return `${lines.join("\n")}\n`;
}

function roffText(value: string): string {
  const escaped = value.replaceAll("\\", "\\e").replaceAll('"', "\\(dq").replaceAll("-", "\\-");
  return escaped.startsWith(".") || escaped.startsWith("'") ? `\\&${escaped}` : escaped;
}

function wrapRoffText(value: string, maximum = 76): readonly string[] {
  const words = value
    .replaceAll("\\", "\\e")
    .replaceAll('"', "\\(dq")
    .replaceAll("-", "\\-")
    .split(" ");
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line === "" || line.length + word.length + 1 <= maximum)
      line = line === "" ? word : `${line} ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line !== "") lines.push(line);
  return Object.freeze(
    lines.map((item) => (item.startsWith(".") || item.startsWith("'") ? `\\&${item}` : item)),
  );
}

export function renderManPage(reference: CliDocumentationReference): string {
  validateCliDocumentationReference(reference);
  const lines = [
    `.TH AGENT-CONTEXT-LINT 1 "${CLI_DOCUMENTATION_RELEASE_DATE}" "${roffText(reference.product.cliName)} ${roffText(reference.product.cliVersion)}" "Agent Context Linter"`,
    ".SH NAME",
    `${roffText(reference.product.cliName)} \\- lint agent instruction files`,
    ".SH SYNOPSIS",
    `.B ${roffText(reference.product.cliName)}`,
    `[\\fIoptions\\fR] \\fIcommand\\fR [\\fIarguments\\fR]`,
    ".SH DESCRIPTION",
    ...wrapRoffText(
      "A deterministic, offline-by-default command-line interface for inspecting agent instruction files.",
    ),
    ".SH COMMANDS",
  ];
  for (const command of reference.commands) {
    lines.push(".TP");
    const usageLines = wrapRoffText(command.usage, 68);
    for (const [index, usageLine] of usageLines.entries()) {
      if (index > 0) lines.push(".br");
      lines.push(`.B ${usageLine}`);
    }
    lines.push(...wrapRoffText(command.description));
  }
  lines.push(".SH OPTIONS");
  const options = new Map<string, CliOptionDefinition>();
  for (const option of reference.globalOptions) options.set(option.names.join(", "), option);
  for (const command of reference.commands)
    for (const option of command.options) options.set(option.names.join(", "), option);
  for (const [names, option] of options) {
    const value = option.valueName === null ? "" : ` ${option.valueName}`;
    lines.push(".TP", `.B ${roffText(names + value)}`, ...wrapRoffText(option.description));
  }
  lines.push(
    ".SH FILES",
    ".TP",
    `.B ${roffText(reference.configuration.fileName)}`,
    ...wrapRoffText(
      "Versioned repository configuration. The machine reference embeds its complete schema and digest.",
    ),
    ".SH EXIT STATUS",
    ...wrapRoffText(
      "0 for success, 1 for lint policy failure, 2 for usage or operational failure, and 130 for SIGINT.",
    ),
    ".SH COMPLETION",
    ...wrapRoffText(
      "Version-matched Bash, Zsh, and Fish completion files are installed in the package completions directory. PowerShell completion is not part of the version 1 contract.",
    ),
    ".SH SEE ALSO",
    ...wrapRoffText(
      "The packaged reference/agent-context-lint-reference.v1.json file is the complete machine-readable command, configuration, and rule reference.",
    ),
  );
  return `${lines.join("\n")}\n`;
}
