import { readFile } from "node:fs/promises";

import type { AnySchema } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import prettier from "prettier";
import { describe, expect, test } from "vitest";

import {
  MAX_RULE_METADATA_TEXT_BYTES,
  MAX_RULE_METADATA_TEXT_CODE_POINTS,
  MAX_RULE_REGISTRY_ISSUES,
  MAX_RULES_PER_REGISTRY,
  REQUIRED_RULE_IDS,
  RULE_CATEGORIES,
  RULE_DEFAULT_SEVERITIES,
  RULE_EXAMPLES,
  RULE_FIX_SAFETY_LEVELS,
  RULE_OWNER_ALIASES,
  RULE_PRECISION_STATUSES,
  RULE_REGISTRY,
  findRuleMetadata,
  findRuleExample,
  isRuleRegistry,
  renderRuleCatalogMarkdown,
  resolveRuleDocsUrl,
  validateRuleRegistry,
} from "../src/index.js";

const root = new URL("../../../", import.meta.url);
const schemaPath = new URL("../schemas/rule-registry.v0.schema.json", import.meta.url);
const catalogPath = new URL("../../../docs/rules/catalog.md", import.meta.url);

function cloneRegistry(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(RULE_REGISTRY)) as Record<string, unknown>;
}

function rulesOf(registry: Record<string, unknown>): Record<string, unknown>[] {
  return registry["rules"] as Record<string, unknown>[];
}

function firstRule(registry: Record<string, unknown>): Record<string, unknown> {
  const rule = rulesOf(registry)[0];
  if (rule === undefined) throw new TypeError("fixture registry has no first rule");
  return rule;
}

describe("committed rule registry", () => {
  test("is complete, unique, strictly sorted, immutable, and range-categorized", () => {
    expect(validateRuleRegistry(RULE_REGISTRY, { requireComplete: true })).toEqual({
      issues: [],
      valid: true,
    });
    expect(RULE_REGISTRY.rules.map((rule) => rule.id)).toEqual(REQUIRED_RULE_IDS);
    expect(new Set(REQUIRED_RULE_IDS).size).toBe(69);
    expect(Object.isFrozen(RULE_REGISTRY)).toBe(true);
    expect(Object.isFrozen(RULE_REGISTRY.rules)).toBe(true);
    expect(RULE_REGISTRY.rules.every(Object.isFrozen)).toBe(true);
    for (const vocabulary of [
      RULE_CATEGORIES,
      RULE_DEFAULT_SEVERITIES,
      RULE_FIX_SAFETY_LEVELS,
      RULE_OWNER_ALIASES,
      RULE_PRECISION_STATUSES,
    ]) {
      expect(Object.isFrozen(vocabulary)).toBe(true);
      expect(() => (vocabulary as unknown as unknown[]).pop()).toThrow();
    }
    expect(new Set(RULE_REGISTRY.rules.map((rule) => rule.category))).toEqual(
      new Set(RULE_CATEGORIES),
    );
    expect(Object.isFrozen(RULE_EXAMPLES)).toBe(true);
    expect(Object.keys(RULE_EXAMPLES).sort()).toEqual([...REQUIRED_RULE_IDS].sort());
    for (const rule of RULE_REGISTRY.rules) {
      const example = findRuleExample(rule.id);
      expect(example).toBeDefined();
      expect(example?.bad.length).toBeGreaterThan(0);
      expect(example?.good.length).toBeGreaterThan(0);
      expect(example?.syntax).toMatch(/^[a-z][a-z0-9+-]{0,15}$/u);
    }
  });

  test("matches the closed Draft 2020-12 JSON schema", async () => {
    const schema = JSON.parse(await readFile(schemaPath, "utf8")) as AnySchema;
    const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
    expect(validate(RULE_REGISTRY), JSON.stringify(validate.errors)).toBe(true);
  });

  test("matches the generated catalog exactly and every URL resolves to one heading", async () => {
    const rendered = renderRuleCatalogMarkdown();
    const prettierConfig = (await prettier.resolveConfig(catalogPath.pathname)) ?? {};
    expect(await readFile(catalogPath, "utf8")).toBe(
      await prettier.format(rendered, { ...prettierConfig, filepath: catalogPath.pathname }),
    );
    for (const rule of RULE_REGISTRY.rules) {
      const anchor = rule.docsUrl.split("#")[1];
      expect(anchor).toBe(rule.id.toLowerCase());
      expect(rendered.match(new RegExp(`^### ${rule.id}$`, "gmu"))).toHaveLength(1);
    }
    expect(rendered.match(/^\*\*Bad example \(illustrative\):\*\*$/gmu)).toHaveLength(69);
    expect(rendered.match(/^\*\*Good example \(illustrative\):\*\*$/gmu)).toHaveLength(69);
    expect(new URL("docs/rules/catalog.md", root).pathname.endsWith("/docs/rules/catalog.md")).toBe(
      true,
    );
  });

  test("looks up exact IDs without accepting loose or inherited keys", () => {
    expect(findRuleMetadata("ACL100")?.description).toBe("Invalid YAML/MDC frontmatter");
    expect(findRuleMetadata("ACL558")?.category).toBe("context-efficiency");
    expect(findRuleMetadata("acl100")).toBeUndefined();
    expect(findRuleMetadata("ACL149")).toBeUndefined();
    expect(findRuleMetadata("toString")).toBeUndefined();
    expect(findRuleMetadata("ACL100")?.precisionStatus).toBe("seeded");
    expect(findRuleMetadata("ACL109")?.precisionStatus).toBe("seeded");
    expect(findRuleMetadata("ACL150")?.precisionStatus).toBe("seeded");
    expect(findRuleMetadata("ACL156")?.precisionStatus).toBe("seeded");
    expect(findRuleMetadata("ACL350")?.precisionStatus).toBe("seeded");
    expect(findRuleMetadata("ACL355")?.precisionStatus).toBe("seeded");
    expect(findRuleMetadata("ACL200")?.precisionStatus).toBe("seeded");
    expect(findRuleMetadata("ACL206")?.precisionStatus).toBe("seeded");
    expect(findRuleMetadata("ACL250")?.precisionStatus).toBe("seeded");
    expect(findRuleMetadata("ACL255")?.precisionStatus).toBe("seeded");
    expect(findRuleMetadata("ACL400")?.precisionStatus).toBe("seeded");
    expect(findRuleMetadata("ACL406")?.precisionStatus).toBe("seeded");
    expect(findRuleMetadata("ACL500")?.precisionStatus).toBe("seeded");
    expect(findRuleMetadata("ACL506")?.precisionStatus).toBe("seeded");
    expect(findRuleMetadata("ACL550")?.precisionStatus).toBe("seeded");
    expect(findRuleMetadata("ACL558")?.precisionStatus).toBe("seeded");
  });

  test("resolves docs only against an explicit safe HTTPS deployment base", () => {
    expect(resolveRuleDocsUrl("ACL100", "https://docs.example.test/product/")?.href).toBe(
      "https://docs.example.test/product/docs/rules/catalog.md#acl100",
    );
    expect(resolveRuleDocsUrl("ACL149", "https://docs.example.test/product/")).toBeUndefined();
    for (const base of [
      "http://docs.example.test/product/",
      "https://user:secret@docs.example.test/product/",
      "https://docs.example.test/product",
      "https://docs.example.test/product/?version=1",
      "https://docs.example.test/product/#rules",
    ]) {
      expect(() => resolveRuleDocsUrl("ACL100", base)).toThrow(
        "documentation deployment base must be an absolute credential-free HTTPS directory URL",
      );
    }
    let proxyTraps = 0;
    const proxied = new Proxy(new URL("https://docs.example.test/product/"), {
      getPrototypeOf: (): never => {
        proxyTraps += 1;
        throw new Error("trap");
      },
    });
    expect(() => resolveRuleDocsUrl("ACL100", proxied)).toThrow(
      "documentation deployment base must be a string or non-proxied URL",
    );
    expect(proxyTraps).toBe(0);

    const hostileUrl = new URL("https://docs.example.test/product/");
    Object.defineProperty(hostileUrl, "href", {
      get: (): never => {
        throw new Error("href getter must not run");
      },
    });
    expect(resolveRuleDocsUrl("ACL100", hostileUrl)?.href).toBe(
      "https://docs.example.test/product/docs/rules/catalog.md#acl100",
    );
  });
});

describe("rule registry validation", () => {
  test.each([
    ["wrong version", ["contractVersion"], "9.0.0", "invalid-value"],
    ["unknown root", ["extra"], true, "unknown-field"],
    ["unknown rule", ["rules", 0, "extra"], true, "unknown-field"],
    ["bad id", ["rules", 0, "id"], "ACL099", "invalid-value"],
    ["bad severity", ["rules", 0, "defaultSeverity"], "fatal", "invalid-value"],
    ["bad owner", ["rules", 0, "owner"], "nobody", "invalid-value"],
    ["bad precision", ["rules", 0, "precisionStatus"], "done", "invalid-value"],
    ["bad fix safety", ["rules", 0, "fixSafety"], "unsafe", "invalid-value"],
    ["bad docs URL", ["rules", 0, "docsUrl"], "https://example.test", "invalid-value"],
    ["bad category", ["rules", 0, "category"], "security", "invalid-category"],
    ["empty description", ["rules", 0, "description"], "", "invalid-value"],
    ["malformed Unicode", ["rules", 0, "rationale"], "\ud800", "invalid-value"],
  ])("rejects %s", (_name, path, replacement, code) => {
    const value = cloneRegistry();
    let cursor: unknown = value;
    for (const part of path.slice(0, -1)) cursor = (cursor as Record<PropertyKey, unknown>)[part];
    (cursor as Record<PropertyKey, unknown>)[path.at(-1) as PropertyKey] = replacement;
    expect(
      validateRuleRegistry(value, { requireComplete: true }).issues.some(
        (issue) => issue.code === code,
      ),
    ).toBe(true);
  });

  test("distinguishes partial registries from the required committed catalog", () => {
    const value = cloneRegistry();
    rulesOf(value).pop();
    expect(validateRuleRegistry(value).valid).toBe(true);
    expect(validateRuleRegistry(value, { requireComplete: true }).issues).toContainEqual(
      expect.objectContaining({ code: "incomplete-registry", path: "$.rules" }),
    );
  });

  test("rejects duplicates and nonascending IDs", () => {
    const duplicate = cloneRegistry();
    rulesOf(duplicate)[1] = structuredClone(firstRule(duplicate));
    const codes = validateRuleRegistry(duplicate, { requireComplete: true }).issues.map(
      (issue) => issue.code,
    );
    expect(codes).toContain("duplicate-id");
    expect(codes).toContain("unsorted");

    const reversed = cloneRegistry();
    rulesOf(reversed).reverse();
    expect(validateRuleRegistry(reversed).issues.some((issue) => issue.code === "unsorted")).toBe(
      true,
    );
  });

  test("fails closed for missing fields, wrong containers, and bounded text", () => {
    expect(validateRuleRegistry(null).valid).toBe(false);
    expect(validateRuleRegistry({ contractVersion: "0.1.0" }).issues[0]?.code).toBe(
      "missing-field",
    );
    expect(validateRuleRegistry({ contractVersion: "0.1.0", rules: {} }).valid).toBe(false);
    const value = cloneRegistry();
    delete firstRule(value)["description"];
    expect(validateRuleRegistry(value).issues.some((issue) => issue.code === "missing-field")).toBe(
      true,
    );
    const oversized = cloneRegistry();
    firstRule(oversized)["description"] = "x".repeat(MAX_RULE_METADATA_TEXT_BYTES + 1);
    expect(
      validateRuleRegistry(oversized).issues.some((issue) => issue.code === "invalid-value"),
    ).toBe(true);
    const tooManyCodePoints = cloneRegistry();
    firstRule(tooManyCodePoints)["description"] = "x".repeat(
      MAX_RULE_METADATA_TEXT_CODE_POINTS + 1,
    );
    expect(
      validateRuleRegistry(tooManyCodePoints).issues.some(
        (issue) => issue.code === "invalid-value",
      ),
    ).toBe(true);
  });

  test("rejects sparse and oversized arrays before walking entries", () => {
    const sparse = { contractVersion: "0.1.0", rules: new Array(MAX_RULES_PER_REGISTRY + 1) };
    expect(validateRuleRegistry(sparse).issues).toEqual([
      expect.objectContaining({ code: "resource-limit", path: "$.rules" }),
    ]);
  });

  test("rejects array accessors, sparse inheritance, symbols, and proxies without execution", () => {
    const rule = structuredClone(firstRule(cloneRegistry()));
    let getterCalls = 0;
    const accessorRules: unknown[] = [];
    Object.defineProperty(accessorRules, "0", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return rule;
      },
    });
    accessorRules.length = 1;
    expect(validateRuleRegistry({ contractVersion: "0.1.0", rules: accessorRules }).valid).toBe(
      false,
    );
    expect(getterCalls).toBe(0);

    const sparseRules: unknown[] = [];
    sparseRules.length = 1;
    const inheritedIndex = Object.create(Array.prototype) as Record<string, unknown>;
    inheritedIndex["0"] = rule;
    Object.setPrototypeOf(sparseRules, inheritedIndex);
    expect(validateRuleRegistry({ contractVersion: "0.1.0", rules: sparseRules }).valid).toBe(
      false,
    );

    const symbolRules = [rule];
    Object.defineProperty(symbolRules, Symbol("authority"), { value: true });
    expect(validateRuleRegistry({ contractVersion: "0.1.0", rules: symbolRules }).valid).toBe(
      false,
    );
    const proxiedRules = new Proxy([rule], {});
    expect(validateRuleRegistry({ contractVersion: "0.1.0", rules: proxiedRules }).valid).toBe(
      false,
    );
  });

  test("fails stably for accessors, proxies, and revoked proxies", () => {
    const accessor = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessor, "contractVersion", { enumerable: true, get: () => "0.1.0" });
    accessor["rules"] = [];
    expect(validateRuleRegistry(accessor).issues).toContainEqual(
      expect.objectContaining({ code: "invalid-value", path: "$.contractVersion" }),
    );

    const hostile = new Proxy(
      {},
      {
        ownKeys: (): never => {
          throw new Error("trap");
        },
      },
    );
    expect(validateRuleRegistry(hostile)).toEqual({
      issues: [{ code: "invalid-value", message: "proxy objects are not accepted", path: "$" }],
      valid: false,
    });
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    expect(validateRuleRegistry(revoked.proxy).valid).toBe(false);
  });

  test("rejects non-enumerable authority fields", () => {
    const hiddenRoot = cloneRegistry();
    Object.defineProperty(hiddenRoot, "contractVersion", {
      enumerable: false,
      value: "0.1.0",
    });
    expect(validateRuleRegistry(hiddenRoot).valid).toBe(false);

    const hiddenRule = cloneRegistry();
    Object.defineProperty(firstRule(hiddenRule), "description", {
      enumerable: false,
      value: firstRule(hiddenRule)["description"],
    });
    expect(validateRuleRegistry(hiddenRule).valid).toBe(false);
  });

  test("caps adversarial issue volume deterministically", () => {
    const value = cloneRegistry();
    value["rules"] = Array.from({ length: MAX_RULES_PER_REGISTRY }, () => ({ extra: true }));
    const result = validateRuleRegistry(value);
    expect(result.issues.length).toBeLessThanOrEqual(MAX_RULE_REGISTRY_ISSUES);
    expect(Object.isFrozen(result.issues)).toBe(true);
  });

  test("the type guard and renderer fail closed", () => {
    expect(isRuleRegistry(RULE_REGISTRY, { requireComplete: true })).toBe(true);
    expect(isRuleRegistry({})).toBe(false);
    expect(() => renderRuleCatalogMarkdown({ contractVersion: "0.1.0", rules: [] })).toThrow(
      "cannot render an invalid or incomplete rule registry",
    );
  });

  test("runtime-invalid mutations are also schema-invalid", async () => {
    const schema = JSON.parse(await readFile(schemaPath, "utf8")) as AnySchema;
    const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
    for (const mutate of [
      (value: Record<string, unknown>): void => {
        value["contractVersion"] = "1.0.0";
      },
      (value: Record<string, unknown>): void => {
        firstRule(value)["owner"] = "nobody";
      },
      (value: Record<string, unknown>): void => {
        firstRule(value)["docsUrl"] = "bad";
      },
      (value: Record<string, unknown>): void => {
        firstRule(value)["description"] = "";
      },
      (value: Record<string, unknown>): void => {
        firstRule(value)["extra"] = true;
      },
    ]) {
      const value = cloneRegistry();
      mutate(value);
      expect(validateRuleRegistry(value, { requireComplete: true }).valid).toBe(false);
      expect(validate(value)).toBe(false);
    }
  });
});
