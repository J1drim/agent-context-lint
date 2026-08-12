import { describe, expect, test } from "vitest";

import {
  formatJsonDiagnostics,
  formatSarifDiagnostics,
  formatStylishDiagnostics,
} from "../packages/formatters/dist/index.js";
import { scheduleRuleFamilies } from "../packages/rules/dist/index.js";
import { fullRuleSchedulerInput } from "../packages/rules/test/helpers/rule-scheduler-full-families.js";

describe("F15 compiled scheduler and formatter integration", () => {
  test("runs F05-F14 and preserves byte-stable terminal, JSON, and SARIF output", async () => {
    const input = await fullRuleSchedulerInput();
    const first = await scheduleRuleFamilies(input, { maximumConcurrency: 1 });
    expect(first.ok, JSON.stringify(first)).toBe(true);
    if (!first.ok) return;
    expect(first.visibleDiagnostics.length).toBeGreaterThan(0);
    expect(first.suppressedDiagnostics.length).toBeGreaterThan(0);
    const profileVersions = {
      "codex-cli": { clientVersion: null, profileVersion: "1.0.0" },
    };
    const render = (result: typeof first): string => {
      const stylish = formatStylishDiagnostics(result.bundle, result.sources, { color: "never" });
      const json = formatJsonDiagnostics(result.bundle, result.sources, {
        failureThreshold: "never",
        profileVersions,
      });
      const sarif = formatSarifDiagnostics(result.bundle, result.sources, {
        informationUri: "https://agent-context-lint.dev/",
        profileVersions,
        ruleDocumentationBaseUri: "https://agent-context-lint.dev/rules/",
        toolVersion: "0.0.0",
      });
      expect(stylish.ok, JSON.stringify(stylish)).toBe(true);
      expect(json.ok, JSON.stringify(json)).toBe(true);
      expect(sarif.ok, JSON.stringify(sarif)).toBe(true);
      if (!stylish.ok || !json.ok || !sarif.ok) throw new Error("formatter fixture failed");
      return [
        `families=${result.families.map((entry) => `${entry.ticketId}:${entry.familyId}`).join(",")}`,
        "--- stylish ---",
        stylish.text,
        "--- json ---",
        json.text,
        "--- sarif ---",
        sarif.text,
      ].join("\n");
    };
    const output = render(first);
    for (let iteration = 0; iteration < 32; iteration += 1) {
      let state = (iteration + 1) * 0x9e37_79b1;
      const families = [...input.families];
      for (let index = families.length - 1; index > 0; index -= 1) {
        state = (Math.imul(state ^ index, 1_664_525) + 1_013_904_223) >>> 0;
        const selected = state % (index + 1);
        const current = families[index];
        const replacement = families[selected];
        if (current === undefined || replacement === undefined)
          throw new Error("shuffle index escaped the family array");
        families[index] = replacement;
        families[selected] = current;
      }
      const candidate = await scheduleRuleFamilies(
        { ...input, families },
        {
          maximumConcurrency: (iteration % 10) + 1,
          scheduleSeed: (state ^ 0x5a17_2026) >>> 0,
        },
      );
      expect(candidate.ok, JSON.stringify(candidate)).toBe(true);
      if (!candidate.ok) return;
      expect(candidate.bundle).toEqual(first.bundle);
      expect(candidate.executionOrder).toEqual(first.executionOrder);
      expect(render(candidate)).toBe(output);
    }
    await expect(output).toMatchFileSnapshot("goldens/rule-scheduler/full-families.txt");
  });
});
