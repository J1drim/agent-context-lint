import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  CLI_DOCUMENTATION_MAXIMUM_COMMANDS,
  CLI_DOCUMENTATION_MAXIMUM_RULES,
  CLI_DOCUMENTATION_REFERENCE_VERSION,
  documentationExamples,
  renderBashCompletion,
  renderCliDocumentationReferenceJson,
  renderCommandReferenceMarkdown,
  renderFishCompletion,
  renderManPage,
  renderZshCompletion,
  validateCliDocumentationReference,
  type CliDocumentationReference,
} from "../src/documentation-artifacts.js";

const root = path.resolve(import.meta.dirname, "../../..");
const generatedPath = path.join(
  root,
  "packages/cli/reference/agent-context-lint-reference.v1.json",
);

async function reference(): Promise<CliDocumentationReference> {
  return JSON.parse(await readFile(generatedPath, "utf8")) as CliDocumentationReference;
}

function mutableReference(value: CliDocumentationReference): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function commandAt(value: Record<string, unknown>, index = 0): Record<string, unknown> {
  const command = (value["commands"] as Record<string, unknown>[])[index];
  if (command === undefined) throw new Error("invalid test fixture command index");
  return command;
}

function optionAt(
  value: Record<string, unknown>,
  commandIndex = 0,
  optionIndex = 0,
): Record<string, unknown> {
  const option = (commandAt(value, commandIndex)["options"] as Record<string, unknown>[])[
    optionIndex
  ];
  if (option === undefined) throw new Error("invalid test fixture option index");
  return option;
}

function ruleAt(value: Record<string, unknown>, index = 0): Record<string, unknown> {
  const rule = (
    (value["rules"] as Record<string, unknown>)["entries"] as Record<string, unknown>[]
  )[index];
  if (rule === undefined) throw new Error("invalid test fixture rule index");
  return rule;
}

describe("I14 documentation artifacts", () => {
  it("validates and canonically serializes the generated registry", async () => {
    const value = await reference();
    expect(() => {
      validateCliDocumentationReference(value);
    }).not.toThrow();
    const first = renderCliDocumentationReferenceJson(value);
    const reordered = {
      schemaVersion: value.schemaVersion,
      rules: value.rules,
      product: value.product,
      globalOptions: value.globalOptions,
      configuration: value.configuration,
      commands: value.commands,
    } as CliDocumentationReference;
    expect(renderCliDocumentationReferenceJson(reordered)).toBe(first);
    expect(first.endsWith("\n")).toBe(true);
    expect(createHash("sha256").update(first).digest("hex")).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("renders deterministic references, completions, manual text, and examples", async () => {
    const value = await reference();
    const markdown = renderCommandReferenceMarkdown(value);
    const bash = renderBashCompletion(value);
    const zsh = renderZshCompletion(value);
    const fish = renderFishCompletion(value);
    const man = renderManPage(value);

    expect(markdown).toContain("# Command reference");
    expect(markdown).toContain("The complete 69-entry registry");
    expect(markdown).not.toContain("\u001b");
    expect(bash).toContain("explain:--agent)");
    expect(bash).toContain("claude-code codex-cli");
    expect(zsh).toContain("command) _describe 'command' commands");
    expect(zsh).toContain("--trace");
    expect(fish).toContain("__fish_complete_directories");
    expect(fish).toContain("__fish_seen_subcommand_from standards");
    expect(man).toContain(".TH AGENT-CONTEXT-LINT 1");
    expect(man).toContain("PowerShell completion is not part");
    expect(documentationExamples(value)).toHaveLength(value.commands.length + 2);
    expect(documentationExamples(value)[0]?.argv).toEqual(["--help"]);
  });

  it("escapes hostile descriptions in every text-bearing renderer", async () => {
    const value = mutableReference(await reference());
    const hostile = "$(touch PWNED); 'quote' \\path : [x] <script>alert(1)</script> .SH";
    commandAt(value)["description"] = hostile;
    optionAt(value)["description"] = hostile;
    ruleAt(value)["description"] = hostile;

    const typed = value as unknown as CliDocumentationReference;
    const bash = renderBashCompletion(typed);
    const zsh = renderZshCompletion(typed);
    const fish = renderFishCompletion(typed);
    const markdown = renderCommandReferenceMarkdown(typed);
    const man = renderManPage(typed);

    expect(bash).not.toContain("touch PWNED");
    expect(zsh).toContain("'\\''quote'\\''");
    expect(zsh).toContain("\\:");
    expect(fish).toContain("'\\''quote'\\''");
    expect(markdown).toContain("&lt;script&gt;");
    expect(markdown).not.toContain("<script>");
    expect(man).toContain("\\epath");
    expect(man).not.toContain("\n.SH\n");
  });

  it("rejects malformed root, product, command ordering, configuration, and rule ordering", async () => {
    const original = await reference();
    const cases: unknown[] = [
      null,
      [],
      new Proxy({}, {}),
      Object.create(null, {
        schemaVersion: { enumerable: true, get: (): string => CLI_DOCUMENTATION_REFERENCE_VERSION },
      }),
      { ...mutableReference(original), extra: true },
      { ...mutableReference(original), schemaVersion: "2.0.0" },
    ];

    const badProduct = mutableReference(original);
    (badProduct["product"] as Record<string, unknown>)["cliName"] = "bad name";
    cases.push(badProduct);
    const badVersion = mutableReference(original);
    (badVersion["product"] as Record<string, unknown>)["cliVersion"] = "";
    cases.push(badVersion);
    const duplicateCommands = mutableReference(original);
    const commands = duplicateCommands["commands"] as Record<string, unknown>[];
    commands[1] = JSON.parse(JSON.stringify(commands[0])) as Record<string, unknown>;
    cases.push(duplicateCommands);
    const badDigest = mutableReference(original);
    (badDigest["configuration"] as Record<string, unknown>)["schemaSha256"] = "bad";
    cases.push(badDigest);
    const duplicateRules = mutableReference(original);
    ruleAt(duplicateRules, 1)["id"] = ruleAt(duplicateRules, 0)["id"];
    cases.push(duplicateRules);

    for (const value of cases)
      expect(() => {
        validateCliDocumentationReference(value);
      }).toThrow("invalid CLI documentation reference");
  });

  it("rejects malformed command and option fields at their boundaries", async () => {
    const original = await reference();
    /* eslint-disable @typescript-eslint/explicit-function-return-type -- compact mutation fixtures are contextually void. */
    const mutations: readonly ((value: Record<string, unknown>) => void)[] = [
      (value) => {
        commandAt(value)["name"] = "BAD";
      },
      (value) => {
        commandAt(value)["description"] = "line\nbreak";
      },
      (value) => {
        commandAt(value)["completion"] = "socket";
      },
      (value) => {
        commandAt(value)["usage"] = "scan ```sh $(touch PWNED)";
      },
      (value) => {
        commandAt(value)["implementationTicket"] = "../../ticket";
      },
      (value) => {
        commandAt(value)["minimumOperands"] = -1;
      },
      (value) => {
        commandAt(value)["maximumOperands"] = -1;
      },
      (value) => {
        commandAt(value)["options"] = Array.from({ length: 33 }, () => ({}));
      },
      (value) => {
        optionAt(value)["names"] = [];
      },
      (value) => {
        optionAt(value)["names"] = ["--bad=value"];
      },
      (value) => {
        optionAt(value)["names"] = ["--help", "--help"];
      },
      (value) => {
        optionAt(value)["completion"] = "network";
      },
      (value) => {
        optionAt(value)["valueName"] = "BAD";
      },
      (value) => {
        optionAt(value)["values"] = ["bad value"];
      },
      (value) => {
        optionAt(value)["values"] = ["same", "same"];
      },
      (value) => {
        optionAt(value)["completion"] = "file";
        optionAt(value)["values"] = ["value"];
      },
      (value) => {
        optionAt(value)["completion"] = "file";
        optionAt(value)["valueName"] = null;
      },
      (value) => {
        optionAt(value)["unexpected"] = true;
      },
      (value) => {
        commandAt(value)["validFirstOperands"] = ["bad value"];
      },
      (value) => {
        commandAt(value)["validFirstOperands"] = ["same", "same"];
      },
      (value) => {
        const options = commandAt(value)["options"] as Record<string, unknown>[];
        options.push(JSON.parse(JSON.stringify(options[0])) as Record<string, unknown>);
      },
    ];
    /* eslint-enable @typescript-eslint/explicit-function-return-type */
    for (const mutate of mutations) {
      const value = mutableReference(original);
      mutate(value);
      expect(() => {
        validateCliDocumentationReference(value);
      }).toThrow(TypeError);
    }
  });

  it("rejects malformed and hostile rule and embedded schema values", async () => {
    const original = await reference();
    /* eslint-disable @typescript-eslint/explicit-function-return-type -- compact mutation fixtures are contextually void. */
    const mutations: readonly ((value: Record<string, unknown>) => void)[] = [
      (value) => {
        ruleAt(value)["id"] = "ACL999";
      },
      (value) => {
        ruleAt(value)["rationale"] = "";
      },
      (value) => {
        ruleAt(value)["extra"] = "value";
      },
      (value) => {
        (value["configuration"] as Record<string, unknown>)["schema"] = [];
      },
      (value) => {
        ((value["configuration"] as Record<string, unknown>)["schema"] as Record<string, unknown>)[
          "bad"
        ] = Number.POSITIVE_INFINITY;
      },
      (value) => {
        ((value["configuration"] as Record<string, unknown>)["schema"] as Record<string, unknown>)[
          "bad"
        ] = -0;
      },
      (value) => {
        ((value["configuration"] as Record<string, unknown>)["schema"] as Record<string, unknown>)[
          "bad"
        ] = (): void => undefined;
      },
      (value) => {
        const schema = (value["configuration"] as Record<string, unknown>)["schema"] as Record<
          string,
          unknown
        >;
        schema["cycle"] = schema;
      },
      (value) => {
        ((value["configuration"] as Record<string, unknown>)["schema"] as Record<string, unknown>)[
          "bad"
        ] = "\u001b[31m";
      },
    ];
    /* eslint-enable @typescript-eslint/explicit-function-return-type */
    for (const mutate of mutations) {
      const value = mutableReference(original);
      mutate(value);
      expect(() => {
        validateCliDocumentationReference(value);
      }).toThrow(TypeError);
    }
  });

  it("enforces command, rule, and schema container resource limits", async () => {
    const original = await reference();
    const tooManyCommands = mutableReference(original);
    tooManyCommands["commands"] = Array.from(
      { length: CLI_DOCUMENTATION_MAXIMUM_COMMANDS + 1 },
      () => ({}),
    );
    expect(() => {
      validateCliDocumentationReference(tooManyCommands);
    }).toThrow(TypeError);

    const tooManyRules = mutableReference(original);
    (tooManyRules["rules"] as Record<string, unknown>)["entries"] = Array.from(
      { length: CLI_DOCUMENTATION_MAXIMUM_RULES + 1 },
      () => ({}),
    );
    expect(() => {
      validateCliDocumentationReference(tooManyRules);
    }).toThrow(TypeError);

    const sparse = mutableReference(original);
    const values = new Array<string>(2);
    values[1] = "two";
    optionAt(sparse)["values"] = values;
    expect(() => {
      validateCliDocumentationReference(sparse);
    }).toThrow(TypeError);

    const deep = mutableReference(original);
    let cursor = (deep["configuration"] as Record<string, unknown>)["schema"] as Record<
      string,
      unknown
    >;
    for (let index = 0; index < 66; index += 1) {
      cursor["next"] = {};
      cursor = cursor["next"] as Record<string, unknown>;
    }
    expect(() => {
      validateCliDocumentationReference(deep);
    }).toThrow(TypeError);
  });
});
