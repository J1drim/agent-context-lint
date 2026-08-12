import { expect, test } from "vitest";

import {
  canonicalizeRepositoryRelativePath,
  compareRepositoryRelativePaths,
  repositoryRelativePathFromAbsolute,
  repositoryRelativePathToAbsolute,
  type RepositoryRelativePath,
} from "../../packages/core/src/index.js";
import { SeededRandom } from "../../packages/test-kit/src/index.js";

const SEGMENTS = ["src", "Rules", "index.ts", "café", "cafe\u0301", "日本語", "🧭", "x-1"] as const;

function generatedPaths(seed: number, count: number): readonly RepositoryRelativePath[] {
  const random = new SeededRandom(seed);
  return Array.from({ length: count }, () => {
    const segmentCount = random.nextInteger(6);
    const segments = Array.from(
      { length: segmentCount },
      () => SEGMENTS[random.nextInteger(SEGMENTS.length)],
    );
    return canonicalizeRepositoryRelativePath(segments.join("/"));
  });
}

function pathAt(paths: readonly RepositoryRelativePath[], index: number): RepositoryRelativePath {
  const value = paths[index];
  if (value === undefined) {
    throw new RangeError(`missing generated path at index ${String(index)}`);
  }
  return value;
}

test("deterministic generated paths round-trip through explicit POSIX and Windows roots", () => {
  for (const relative of generatedPaths(0xb01, 256)) {
    const posixAbsolute = repositoryRelativePathToAbsolute(
      "/workspace/repository",
      relative,
      "posix",
    );
    const windowsAbsolute = repositoryRelativePathToAbsolute(
      "C:\\workspace\\repository",
      relative,
      "win32",
    );

    expect(
      repositoryRelativePathFromAbsolute("/workspace/repository", posixAbsolute, "posix"),
    ).toBe(relative);
    expect(
      repositoryRelativePathFromAbsolute("C:\\workspace\\repository", windowsAbsolute, "win32"),
    ).toBe(relative);
    expect(canonicalizeRepositoryRelativePath(relative)).toBe(relative);
  }
});

test("comparison is antisymmetric and transitive for deterministic generated paths", () => {
  const paths = generatedPaths(0xc0ffee, 96);
  const sorted = [...paths].sort(compareRepositoryRelativePaths);

  for (let index = 0; index < sorted.length; index += 1) {
    const left = pathAt(sorted, index);
    for (let rightIndex = index; rightIndex < sorted.length; rightIndex += 1) {
      const right = pathAt(sorted, rightIndex);
      const forward = compareRepositoryRelativePaths(left, right);
      const reverse = compareRepositoryRelativePaths(right, left);
      expect(forward).toBeLessThanOrEqual(0);
      expect(reverse).toBe(forward === 0 ? 0 : -forward);
    }
  }

  for (let index = 0; index + 2 < sorted.length; index += 1) {
    const left = pathAt(sorted, index);
    const middle = pathAt(sorted, index + 1);
    const right = pathAt(sorted, index + 2);
    expect(compareRepositoryRelativePaths(left, right)).toBeLessThanOrEqual(0);
    expect(compareRepositoryRelativePaths(left, middle)).toBeLessThanOrEqual(0);
    expect(compareRepositoryRelativePaths(middle, right)).toBeLessThanOrEqual(0);
  }
});
