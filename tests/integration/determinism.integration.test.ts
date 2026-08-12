import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { renderDeterministicScenario } from "../support/deterministic-scenario.js";

const testsDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const goldenPath = path.join(testsDirectory, "goldens", "deterministic-scenario.json");
const hashPath = path.join(testsDirectory, "goldens", "deterministic-scenario.sha256");

describe("deterministic scenario golden", () => {
  test("matches the committed bytes and SHA-256 hash", async () => {
    const [actual, expected, expectedHash] = await Promise.all([
      renderDeterministicScenario(),
      readFile(goldenPath, "utf8"),
      readFile(hashPath, "utf8"),
    ]);

    expect(actual).toBe(expected);
    expect(createHash("sha256").update(actual).digest("hex")).toBe(expectedHash.trim());
  });

  test("parallel scenario runs produce byte-identical output", async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, async () => renderDeterministicScenario()),
    );

    expect(new Set(results)).toHaveLength(1);
  });
});
