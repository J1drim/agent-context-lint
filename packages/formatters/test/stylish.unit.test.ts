import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

import {
  canonicalizeRepositoryRelativePath,
  computePathFingerprint,
  computeSemanticFingerprint,
  serializeTerminalOutput,
  validateInstructionIr,
  validateTerminalOutput,
} from "@agent-context/core";

import {
  STYLISH_DEFAULT_WIDTH,
  STYLISH_CELL_WIDTH_VERSION,
  STYLISH_MAX_WIDTH,
  STYLISH_MIN_WIDTH,
  formatStylishDiagnostics,
  measureStylishTextWidth,
} from "../src/index.js";
import { wrapStylishText } from "../src/stylish.js";

import type { SourceDocument } from "@agent-context/core";
import type { StylishFormatterOptions } from "../src/index.js";

const DIAGNOSTICS = new URL("../../core/test/fixtures/diagnostics.valid.json", import.meta.url);
const IR = new URL("../../core/test/fixtures/instruction-ir.valid.json", import.meta.url);
const ESCAPE = String.fromCharCode(0x1b);
const BIDI_OVERRIDE = String.fromCodePoint(0x202e);
const ANSI_PATTERN = new RegExp(`${ESCAPE}\\[[0-9;]*m`, "gu");

class NonPlainOptions {
  readonly width = 80;
}

function json(url: URL): unknown {
  return JSON.parse(readFileSync(url, "utf8")) as unknown;
}

function sources(): readonly SourceDocument[] {
  const result = validateInstructionIr(json(IR));
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.value.sources;
}

function bundle(): Record<string, unknown> {
  return structuredClone(json(DIAGNOSTICS)) as Record<string, unknown>;
}

function firstRecord(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = record[key];
  if (!Array.isArray(value) || value[0] === null || typeof value[0] !== "object")
    throw new TypeError(`expected ${key} to contain an object`);
  return value[0] as Record<string, unknown>;
}

function diagnosticVariant(
  template: Record<string, unknown>,
  suffix: string,
  message: string,
): Record<string, unknown> {
  const diagnostic = structuredClone(template);
  const profileIds = ["codex-cli"];
  const pathBasis = { anchor: `statement:${suffix}`, profileIds };
  const semanticBasis = {
    components: [{ key: "case", value: suffix }],
    profileIds,
  };
  diagnostic["id"] = `diagnostic:${suffix}`;
  diagnostic["message"] = message;
  diagnostic["related"] = [];
  diagnostic["suggestion"] = null;
  diagnostic["fingerprintBasis"] = { path: pathBasis, semantic: semanticBasis };
  diagnostic["fingerprints"] = {
    path: {
      method: "agent-context-lint/path/v1",
      value: computePathFingerprint({
        ruleId: "ACL250",
        ruleVersion: "1.0.0",
        path: canonicalizeRepositoryRelativePath("AGENTS.md"),
        basis: pathBasis,
      }),
    },
    semantic: {
      method: "agent-context-lint/semantic/v1",
      value: computeSemanticFingerprint({
        ruleId: "ACL250",
        ruleVersion: "1.0.0",
        basis: semanticBasis,
      }),
    },
  };
  return diagnostic;
}

function visibleWidth(value: string): number {
  return measureStylishTextWidth(value.replace(ANSI_PATTERN, ""));
}

function expectBoundedLines(lines: readonly string[], width: number): void {
  expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
  expect(lines.every((line) => Buffer.byteLength(line, "utf8") <= 16_384)).toBe(true);
  expect(lines.every((line) => Array.from(line).length <= 4_096)).toBe(true);
}

describe("I04 stylish formatter", () => {
  test("renders the stable no-color golden with one-based source locations and related evidence", () => {
    const result = formatStylishDiagnostics(bundle(), sources());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.text).toBe(
      [
        "AGENTS.md:3:3",
        "  error ACL250",
        "  Conflicting package-manager instruction.",
        "  related Conflicting instruction source: AGENTS.md:3:3",
        "  suggestion: Use the workspace package manager consistently.",
        "",
        "1 problem (1 error, 0 warnings, 0 infos, 0 suppressed)",
        "",
      ].join("\n"),
    );
    expect(result.output).toMatchObject({
      recordKind: "agent-context-terminal-output",
      schemaVersion: "1.0.0",
      colorMode: "never",
      width: STYLISH_DEFAULT_WIDTH,
      summary: { errors: 1, warnings: 0, infos: 0, suppressed: 0, exitCode: 1 },
    });
    expect(validateTerminalOutput(result.output).ok).toBe(true);
    expect(result.text).toBe(`${result.output.lines.join("\n")}\n`);
  });

  test("preserves validated input order and reflects diagnostic-array permutations", () => {
    const candidate = bundle();
    const template = firstRecord(candidate, "diagnostics");
    const alpha = diagnosticVariant(template, "alpha", "alpha-order-marker");
    const omega = diagnosticVariant(template, "omega", "omega-order-marker");
    candidate["suppressions"] = [];
    candidate["diagnostics"] = [omega, alpha];

    const omegaFirst = formatStylishDiagnostics(candidate, sources());
    const omegaFirstAgain = formatStylishDiagnostics(candidate, sources());
    expect(omegaFirst.ok).toBe(true);
    expect(omegaFirstAgain.ok).toBe(true);
    if (!omegaFirst.ok || !omegaFirstAgain.ok) throw new Error("expected valid diagnostics");
    expect(omegaFirst.text.indexOf("omega-order-marker")).toBeLessThan(
      omegaFirst.text.indexOf("alpha-order-marker"),
    );
    expect(omegaFirstAgain.text).toBe(omegaFirst.text);

    candidate["diagnostics"] = [alpha, omega];
    const alphaFirst = formatStylishDiagnostics(candidate, sources());
    expect(alphaFirst.ok).toBe(true);
    if (!alphaFirst.ok) throw new Error("expected valid diagnostics");
    expect(alphaFirst.text.indexOf("alpha-order-marker")).toBeLessThan(
      alphaFirst.text.indexOf("omega-order-marker"),
    );
    expect(alphaFirst.text).not.toBe(omegaFirst.text);
  });

  test("resolves always, never, and capability-driven auto color without ambient process state", () => {
    const never = formatStylishDiagnostics(bundle(), sources(), {
      color: "never",
      terminalSupportsAnsi: true,
    });
    const unsupported = formatStylishDiagnostics(bundle(), sources(), {
      color: "auto",
      terminalSupportsAnsi: false,
    });
    const automatic = formatStylishDiagnostics(bundle(), sources(), {
      color: "auto",
      terminalSupportsAnsi: true,
    });
    const always = formatStylishDiagnostics(bundle(), sources(), {
      color: "always",
      terminalSupportsAnsi: false,
    });
    expect(never.ok && never.output.colorMode).toBe("never");
    expect(unsupported.ok && unsupported.output.colorMode).toBe("never");
    expect(automatic.ok && automatic.output.colorMode).toBe("ansi");
    expect(always.ok && always.output.colorMode).toBe("ansi");
    expect(never.ok && never.text).not.toContain("\u001b");
    expect(automatic.ok && automatic.text).toContain("\u001b[31m");
  });

  test("makes repository ANSI, controls, bidi text, and credential canaries inert before coloring", () => {
    const candidate = bundle();
    const diagnostic = firstRecord(candidate, "diagnostics");
    diagnostic["message"] =
      "password=top-secret-value \u001b[31mforged\u001b[0m\nnext \u202etext SECRET_CANARY_I04";
    const result = formatStylishDiagnostics(candidate, sources(), { color: "always" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.text).not.toContain("top-secret-value");
    expect(result.text).not.toContain("SECRET_CANARY_I04");
    expect(result.text).not.toContain("\u202e");
    expect(result.text).toContain("password=REDACTED");
    expect(result.text).toContain("�next �text REDACTED");
    const remaining = result.text.replace(ANSI_PATTERN, "");
    expect(remaining).not.toContain("\u001b");
    expect(
      result.text
        .match(ANSI_PATTERN)
        ?.every((sequence) =>
          [
            "\u001b[0m",
            "\u001b[1m",
            "\u001b[2m",
            "\u001b[31m",
            "\u001b[32m",
            "\u001b[36m",
          ].includes(sequence),
        ),
    ).toBe(true);
    expect(
      result.output.lines
        .filter((outputLine) => outputLine.includes("\u001b"))
        .every((outputLine) => outputLine.endsWith("\u001b[0m")),
    ).toBe(true);
    const generic = serializeTerminalOutput(result.output);
    expect(generic.ok).toBe(true);
    if (!generic.ok) throw new Error(JSON.stringify(generic.issues));
    expect(generic.text).not.toContain("\u001b");
    expect(generic.text).toBe(result.text.replace(ANSI_PATTERN, ""));
  });

  test("pins terminal-cell-v1 widths for combining, ZWJ, flag, keycap, Hangul, and East Asian boundaries", () => {
    expect(STYLISH_CELL_WIDTH_VERSION).toBe("terminal-cell-v1");
    expect([
      measureStylishTextWidth("e\u0301"),
      measureStylishTextWidth("👩‍💻"),
      measureStylishTextWidth("🇵🇱"),
      measureStylishTextWidth("1️⃣"),
      measureStylishTextWidth("\u1100\u1161\u11a8"),
      measureStylishTextWidth("漢"),
      measureStylishTextWidth("Ａ"),
      measureStylishTextWidth("A"),
      measureStylishTextWidth("·"),
    ]).toEqual([1, 2, 2, 2, 2, 2, 2, 1, 1]);
  });

  test("keeps Unicode 17 extended clusters intact across Indic, Thai, Arabic, Prepend, and combining scripts", () => {
    const clusters = ["क्‍ष", "กำ", "نَّ", "\u0600A", "a̐", "ö̲"];
    expect(clusters.map(measureStylishTextWidth)).toEqual([1, 2, 1, 1, 1, 1]);

    const candidate = bundle();
    firstRecord(candidate, "diagnostics")["message"] = clusters.join(" ").repeat(4);
    const result = formatStylishDiagnostics(candidate, sources(), {
      color: "always",
      width: STYLISH_MIN_WIDTH,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expectBoundedLines(result.output.lines, STYLISH_MIN_WIDTH);
    for (const cluster of clusters) {
      expect(result.text).toContain(cluster);
      const pieces = Array.from(cluster);
      for (const [index, piece] of pieces.entries()) {
        if (index < pieces.length - 1) expect(result.text).not.toContain(`${piece}\n`);
      }
    }
  });

  test("wraps CJK, combining marks, emoji graphemes, paths, and summaries within a narrow width", () => {
    const candidate = bundle();
    const diagnostic = firstRecord(candidate, "diagnostics");
    diagnostic["message"] = "漢字 e\u0301 👩‍💻 a-very-long-unbroken-diagnostic-token";
    const result = formatStylishDiagnostics(candidate, sources(), { width: STYLISH_MIN_WIDTH });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expectBoundedLines(result.output.lines, STYLISH_MIN_WIDTH);
    expect(result.text).toContain("e\u0301");
    expect(result.text).toContain("👩‍💻");
    expect(result.text).not.toContain("👩\n");
    expect(result.text).toMatchSnapshot();
  });

  test("derives suppression counts and threshold-specific exit status from the validated bundle", () => {
    const candidate = bundle();
    const diagnostic = firstRecord(candidate, "diagnostics");
    const suppression = firstRecord(candidate, "suppressions");
    const fingerprints = diagnostic["fingerprints"] as Record<string, unknown>;
    const pathFingerprint = fingerprints["path"] as Record<string, unknown>;
    suppression["state"] = "suppressed";
    suppression["matchedPathFingerprints"] = [pathFingerprint["value"]];
    const suppressed = formatStylishDiagnostics(candidate, sources(), {
      failureThreshold: "warning",
    });
    expect(suppressed.ok).toBe(true);
    if (!suppressed.ok) throw new Error(JSON.stringify(suppressed.issues));
    expect(suppressed.output.summary).toEqual({
      errors: 0,
      warnings: 0,
      infos: 0,
      suppressed: 1,
      exitCode: 0,
    });
    expect(suppressed.text).toBe("0 problems (0 errors, 0 warnings, 0 infos, 1 suppressed)\n");

    diagnostic["severity"] = "warning";
    suppression["state"] = "unused";
    suppression["matchedPathFingerprints"] = [];
    const warning = formatStylishDiagnostics(candidate, sources(), {
      failureThreshold: "warning",
    });
    const never = formatStylishDiagnostics(candidate, sources(), { failureThreshold: "never" });
    expect(warning.ok && warning.output.summary.exitCode).toBe(1);
    expect(never.ok && never.output.summary.exitCode).toBe(0);
  });

  test("emits no bytes for an empty bundle while retaining a valid zero summary", () => {
    const result = formatStylishDiagnostics(
      {
        recordKind: "agent-context-diagnostics",
        contractVersion: "0.1.0",
        diagnostics: [],
        suppressions: [],
      },
      sources(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.text).toBe("");
    expect(result.output.lines).toEqual([]);
    expect(result.output.summary).toEqual({
      errors: 0,
      warnings: 0,
      infos: 0,
      suppressed: 0,
      exitCode: 0,
    });
  });

  test.each([
    ["small width", { width: STYLISH_MIN_WIDTH - 1 }, "$options.width"],
    ["large width", { width: STYLISH_MAX_WIDTH + 1 }, "$options.width"],
    ["fractional width", { width: 80.5 }, "$options.width"],
    ["null width", { width: null }, "$options.width"],
    ["undefined width", { width: undefined }, "$options.width"],
    ["unknown color", { color: "rainbow" }, "$options.color"],
    ["null color", { color: null }, "$options.color"],
    ["undefined color", { color: undefined }, "$options.color"],
    ["non-boolean capability", { terminalSupportsAnsi: 1 }, "$options.terminalSupportsAnsi"],
    ["null capability", { terminalSupportsAnsi: null }, "$options.terminalSupportsAnsi"],
    ["undefined capability", { terminalSupportsAnsi: undefined }, "$options.terminalSupportsAnsi"],
    ["unknown threshold", { failureThreshold: "info" }, "$options.failureThreshold"],
    ["null threshold", { failureThreshold: null }, "$options.failureThreshold"],
    ["undefined threshold", { failureThreshold: undefined }, "$options.failureThreshold"],
    ["unknown field", { theme: "dark" }, "$options"],
    ["array", [], "$options"],
    ["class instance", new NonPlainOptions(), "$options"],
  ])("rejects %s options without coercion", (_name, options, path) => {
    const result = formatStylishDiagnostics(
      bundle(),
      sources(),
      options as StylishFormatterOptions,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid options");
    expect(result.issues[0]?.path).toBe(path);
  });

  test("rejects option accessors, symbols, and revoked proxies without invoking user code", () => {
    let calls = 0;
    const accessor = Object.defineProperty({}, "width", {
      enumerable: true,
      get() {
        calls += 1;
        return 80;
      },
    });
    const symbolic = { [Symbol("color")]: "always" };
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();
    for (const options of [accessor, symbolic, revocable.proxy]) {
      const result = formatStylishDiagnostics(bundle(), sources(), options);
      expect(result.ok).toBe(false);
    }
    expect(calls).toBe(0);
  });

  test("does not consult inherited option accessors for absent fields", () => {
    let calls = 0;
    const inheritedKeys = ["color", "failureThreshold", "terminalSupportsAnsi", "width"] as const;
    try {
      for (const key of inheritedKeys) {
        Object.defineProperty(Object.prototype, key, {
          configurable: true,
          get() {
            calls += 1;
            throw new Error("inherited option accessor must remain inert");
          },
        });
      }
      const result = formatStylishDiagnostics(bundle(), sources(), {});
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected inherited accessors to be ignored");
      expect(result.output.width).toBe(STYLISH_DEFAULT_WIDTH);
      expect(result.output.colorMode).toBe("never");
    } finally {
      for (const key of inheritedKeys) Reflect.deleteProperty(Object.prototype, key);
    }
    expect(calls).toBe(0);
  });

  test("rejects oversized option records before materializing their descriptors", () => {
    let calls = 0;
    const options: Record<string, unknown> = {};
    Object.defineProperty(options, "width", {
      enumerable: true,
      get() {
        calls += 1;
        return 80;
      },
    });
    for (let index = 0; index < 10_000; index += 1) options[`unknown-${String(index)}`] = index;
    const result = formatStylishDiagnostics(bundle(), sources(), options);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected oversized option rejection");
    expect(result.issues).toEqual([
      { code: "invalid-options", path: "$options", message: "contains too many fields" },
    ]);
    expect(calls).toBe(0);
  });

  test("returns bounded sanitized diagnostic-validation failures and never throws on hostile input", () => {
    const malformed = bundle();
    firstRecord(malformed, "diagnostics")["message"] = "\ud800";
    const result = formatStylishDiagnostics(malformed, sources());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid diagnostics");
    expect(result.issues.length).toBeLessThanOrEqual(256);
    expect(
      result.issues.every(
        (issue) =>
          !issue.path.includes(ESCAPE) &&
          !issue.message.includes(ESCAPE) &&
          !issue.path.includes(BIDI_OVERRIDE) &&
          !issue.message.includes(BIDI_OVERRIDE),
      ),
    ).toBe(true);

    const revocable = Proxy.revocable({}, {});
    revocable.revoke();
    expect(() => formatStylishDiagnostics(revocable.proxy, sources())).not.toThrow();
    expect(formatStylishDiagnostics(revocable.proxy, sources()).ok).toBe(false);
  });

  test("does not mutate input and freezes successful and failed results", () => {
    const candidate = bundle();
    const before = JSON.stringify(candidate);
    const success = formatStylishDiagnostics(candidate, sources());
    const failed = formatStylishDiagnostics(candidate, sources(), { width: 0 });
    expect(JSON.stringify(candidate)).toBe(before);
    expect(success.ok).toBe(true);
    expect(Object.isFrozen(success)).toBe(true);
    if (success.ok) {
      expect(Object.isFrozen(success.output)).toBe(true);
      expect(Object.isFrozen(success.output.lines)).toBe(true);
      expect(Object.isFrozen(success.output.summary)).toBe(true);
    }
    expect(Object.isFrozen(failed)).toBe(true);
    if (!failed.ok) {
      expect(Object.isFrozen(failed.issues)).toBe(true);
      expect(Object.isFrozen(failed.issues[0])).toBe(true);
    }
  });

  test("replaces over-budget clusters without splitting and honors exact cell boundaries", () => {
    expect(wrapStylishText("漢", 1)).toEqual(["�"]);
    expect(wrapStylishText("漢".repeat(10), 20)).toEqual(["漢".repeat(10)]);
    expect(wrapStylishText("漢".repeat(11), 20)).toEqual(["漢".repeat(10), "漢"]);

    for (const message of [`A${"ा".repeat(4_000)}`, "́".repeat(4_096)]) {
      const candidate = bundle();
      firstRecord(candidate, "diagnostics")["message"] = message;
      const result = formatStylishDiagnostics(candidate, sources(), {
        color: "always",
        width: STYLISH_MIN_WIDTH,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(JSON.stringify(result.issues));
      expect(result.text).toContain("�");
      expect(result.text).not.toContain(message);
      expectBoundedLines(result.output.lines, STYLISH_MIN_WIDTH);
      expect(validateTerminalOutput(result.output).ok).toBe(true);
      expect(
        result.output.lines
          .filter((outputLine) => outputLine.includes(ESCAPE))
          .every((outputLine) => outputLine.endsWith("\u001b[0m")),
      ).toBe(true);
    }
  });

  test("caps related locations with an explicit omission count", () => {
    const candidate = bundle();
    const diagnostic = firstRecord(candidate, "diagnostics");
    const primary = diagnostic["primary"];
    const related = diagnostic["related"];
    if (!Array.isArray(related)) throw new TypeError("expected related evidence");
    const repositoryFact: unknown = (related as readonly unknown[])[1];
    if (repositoryFact === null || typeof repositoryFact !== "object")
      throw new TypeError("expected repository evidence");
    (repositoryFact as Record<string, unknown>)["locations"] = Array(20).fill(primary);
    const result = formatStylishDiagnostics(candidate, sources());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.text).toContain("5 related locations omitted");
    expect(result.text.match(/Workspace package manager:/gu)).toHaveLength(15);
  });

  test("bounds very large valid diagnostic sets and retains complete summary counts", () => {
    const candidate = bundle();
    const template = firstRecord(candidate, "diagnostics");
    const diagnostics = Array.from({ length: 6_000 }, (_value, index) => {
      const suffix = String(index).padStart(5, "0");
      return diagnosticVariant(template, suffix, "bounded diagnostic message ".repeat(15));
    });
    candidate["diagnostics"] = diagnostics;
    candidate["suppressions"] = [];
    const result = formatStylishDiagnostics(candidate, sources(), { width: STYLISH_MIN_WIDTH });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.output.lines.length).toBeLessThanOrEqual(100_000);
    expect(result.text).toMatch(/diagnostics\s+omitted by output\s+limit/u);
    expect(result.output.summary).toEqual({
      errors: 6_000,
      warnings: 0,
      infos: 0,
      suppressed: 0,
      exitCode: 1,
    });
    expectBoundedLines(result.output.lines, STYLISH_MIN_WIDTH);
  });
});
