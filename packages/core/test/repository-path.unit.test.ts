import { describe, expect, test } from "vitest";

import {
  canonicalizeRepositoryRelativePath,
  compareRepositoryRelativePaths,
  isRepositoryRelativePath,
  REPOSITORY_ROOT,
  RepositoryPathError,
  RepositoryPathErrorCode,
  repositoryRelativePathFromAbsolute,
  repositoryRelativePathsEqual,
  repositoryRelativePathToAbsolute,
  type RepositoryPathErrorCode as RepositoryPathErrorCodeType,
  type RepositoryRelativePath,
} from "../src/index.js";
import type { PathFlavor } from "../src/services.js";

interface CanonicalCase {
  readonly expected: string;
  readonly flavor: PathFlavor;
  readonly input: string;
}

const HIGH_FIRST = String.fromCharCode(0xd800);
const HIGH_MIDDLE = String.fromCharCode(0xda55);
const HIGH_LAST = String.fromCharCode(0xdbff);
const LOW_FIRST = String.fromCharCode(0xdc00);
const LOW_MIDDLE = String.fromCharCode(0xde55);
const LOW_LAST = String.fromCharCode(0xdfff);
const ASTRAL_FIRST = `${HIGH_FIRST}${LOW_FIRST}`;
const ASTRAL_LAST = `${HIGH_LAST}${LOW_LAST}`;

const canonicalCases: readonly CanonicalCase[] = [
  { input: "", flavor: "posix", expected: "." },
  { input: ".", flavor: "posix", expected: "." },
  { input: "././", flavor: "posix", expected: "." },
  { input: "src", flavor: "posix", expected: "src" },
  { input: "./src//rules/./index.ts/", flavor: "posix", expected: "src/rules/index.ts" },
  { input: "src\\rules/index.ts", flavor: "win32", expected: "src/rules/index.ts" },
  { input: ".\\src\\\\rules\\.\\index.ts\\", flavor: "win32", expected: "src/rules/index.ts" },
  { input: "café/naïve.ts", flavor: "posix", expected: "café/naïve.ts" },
  { input: "cafe\u0301/naïve.ts", flavor: "posix", expected: "cafe\u0301/naïve.ts" },
  { input: "emoji/🧭.ts", flavor: "posix", expected: "emoji/🧭.ts" },
  { input: `${ASTRAL_FIRST}/edge`, flavor: "posix", expected: `${ASTRAL_FIRST}/edge` },
  { input: `edge/${ASTRAL_LAST}`, flavor: "posix", expected: `edge/${ASTRAL_LAST}` },
  {
    input: `emoji\\${ASTRAL_FIRST}\\${ASTRAL_LAST}.ts`,
    flavor: "win32",
    expected: `emoji/${ASTRAL_FIRST}/${ASTRAL_LAST}.ts`,
  },
  { input: "SRC/Index.ts", flavor: "posix", expected: "SRC/Index.ts" },
];

interface InvalidCase {
  readonly code: RepositoryPathErrorCodeType;
  readonly flavor: PathFlavor;
  readonly input: string;
}

const invalidCases: readonly InvalidCase[] = [
  { input: "/etc/passwd", flavor: "posix", code: RepositoryPathErrorCode.notRelative },
  { input: "//server/share", flavor: "posix", code: RepositoryPathErrorCode.notRelative },
  { input: "C:\\repo\\file", flavor: "win32", code: RepositoryPathErrorCode.notRelative },
  { input: "C:/repo/file", flavor: "win32", code: RepositoryPathErrorCode.notRelative },
  { input: "\\repo\\file", flavor: "win32", code: RepositoryPathErrorCode.notRelative },
  { input: "\\\\server\\share\\file", flavor: "win32", code: RepositoryPathErrorCode.notRelative },
  {
    input: "C:repo\\file",
    flavor: "win32",
    code: RepositoryPathErrorCode.windowsDriveRelative,
  },
  { input: "D:", flavor: "win32", code: RepositoryPathErrorCode.windowsDriveRelative },
  {
    input: "\\\\?\\C:\\repo\\file",
    flavor: "win32",
    code: RepositoryPathErrorCode.unsupportedDevicePath,
  },
  {
    input: "\\\\.\\pipe\\name",
    flavor: "win32",
    code: RepositoryPathErrorCode.unsupportedDevicePath,
  },
  {
    input: "//?/UNC/server/share/file",
    flavor: "win32",
    code: RepositoryPathErrorCode.unsupportedDevicePath,
  },
  { input: "../outside", flavor: "posix", code: RepositoryPathErrorCode.parentTraversal },
  { input: "src/../outside", flavor: "posix", code: RepositoryPathErrorCode.parentTraversal },
  { input: "..\\outside", flavor: "win32", code: RepositoryPathErrorCode.parentTraversal },
  {
    input: "src\\..\\outside",
    flavor: "win32",
    code: RepositoryPathErrorCode.parentTraversal,
  },
  { input: "src\\file.ts", flavor: "posix", code: RepositoryPathErrorCode.windowsSeparator },
  { input: "bad\0path", flavor: "posix", code: RepositoryPathErrorCode.controlCharacter },
  { input: "bad\npath", flavor: "posix", code: RepositoryPathErrorCode.controlCharacter },
  { input: "bad\tpath", flavor: "posix", code: RepositoryPathErrorCode.controlCharacter },
  { input: "bad\u007fpath", flavor: "posix", code: RepositoryPathErrorCode.controlCharacter },
  { input: "bad\ud800path", flavor: "posix", code: RepositoryPathErrorCode.malformedUnicode },
  { input: "bad\udcffpath", flavor: "posix", code: RepositoryPathErrorCode.malformedUnicode },
  { input: HIGH_FIRST, flavor: "posix", code: RepositoryPathErrorCode.malformedUnicode },
  { input: HIGH_LAST, flavor: "win32", code: RepositoryPathErrorCode.malformedUnicode },
  { input: LOW_FIRST, flavor: "posix", code: RepositoryPathErrorCode.malformedUnicode },
  { input: LOW_LAST, flavor: "win32", code: RepositoryPathErrorCode.malformedUnicode },
  {
    input: `leading/${LOW_MIDDLE}`,
    flavor: "posix",
    code: RepositoryPathErrorCode.malformedUnicode,
  },
  {
    input: `trailing/${HIGH_MIDDLE}`,
    flavor: "posix",
    code: RepositoryPathErrorCode.malformedUnicode,
  },
  {
    input: `${HIGH_FIRST}/boundary`,
    flavor: "posix",
    code: RepositoryPathErrorCode.malformedUnicode,
  },
  {
    input: `boundary/${LOW_LAST}`,
    flavor: "posix",
    code: RepositoryPathErrorCode.malformedUnicode,
  },
  {
    input: `${LOW_FIRST}${HIGH_FIRST}`,
    flavor: "posix",
    code: RepositoryPathErrorCode.malformedUnicode,
  },
  {
    input: `${HIGH_FIRST}${HIGH_LAST}`,
    flavor: "posix",
    code: RepositoryPathErrorCode.malformedUnicode,
  },
  {
    input: `${LOW_FIRST}${LOW_LAST}`,
    flavor: "posix",
    code: RepositoryPathErrorCode.malformedUnicode,
  },
  {
    input: `segment\\${HIGH_LAST}\\boundary`,
    flavor: "win32",
    code: RepositoryPathErrorCode.malformedUnicode,
  },
  {
    input: `segment\\${LOW_FIRST}tail`,
    flavor: "win32",
    code: RepositoryPathErrorCode.malformedUnicode,
  },
];

function expectPathError(
  operation: () => unknown,
  code: RepositoryPathErrorCodeType,
  input: string,
  root?: string,
): void {
  try {
    operation();
    throw new Error("expected repository path conversion to fail");
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(RepositoryPathError);
    expect(error).toMatchObject({ name: "RepositoryPathError", code, input, root });
  }
}

describe("canonical repository-relative paths", () => {
  test.each(canonicalCases)("canonicalizes $flavor '$input' to '$expected'", (scenario) => {
    const actual = canonicalizeRepositoryRelativePath(scenario.input, scenario.flavor);
    expect(actual).toBe(scenario.expected);
    expect(isRepositoryRelativePath(actual)).toBe(true);
  });

  test.each(invalidCases)("rejects $flavor '$input' with $code", (scenario) => {
    expectPathError(
      () => canonicalizeRepositoryRelativePath(scenario.input, scenario.flavor),
      scenario.code,
      scenario.input,
    );
    expect(isRepositoryRelativePath(scenario.input)).toBe(false);
  });

  test("recognizes canonical syntax rather than merely canonicalizable syntax", () => {
    expect(isRepositoryRelativePath(REPOSITORY_ROOT)).toBe(true);
    expect(isRepositoryRelativePath("src/index.ts")).toBe(true);
    expect(isRepositoryRelativePath("")).toBe(false);
    expect(isRepositoryRelativePath("./src/index.ts")).toBe(false);
    expect(isRepositoryRelativePath("src//index.ts")).toBe(false);
  });

  test("does not disguise non-string programmer errors as path validation failures", () => {
    expect(() => isRepositoryRelativePath(42 as unknown as string)).toThrow(TypeError);
  });

  test("accepts every sampled valid high/low surrogate pairing at path boundaries", () => {
    const highUnits = [0xd800, 0xda55, 0xdbff];
    const lowUnits = [0xdc00, 0xde55, 0xdfff];
    for (const high of highUnits) {
      for (const low of lowUnits) {
        const pair = String.fromCharCode(high, low);
        for (const input of [pair, `${pair}/file`, `dir/${pair}`, `dir/${pair}/file`]) {
          expect(canonicalizeRepositoryRelativePath(input)).toBe(input);
          expect(isRepositoryRelativePath(input)).toBe(true);
        }
        const windowsInput = `dir\\${pair}\\file`;
        expect(canonicalizeRepositoryRelativePath(windowsInput, "win32")).toBe(`dir/${pair}/file`);
      }
    }
  });

  test("returns false without throwing for hostile malformed-Unicode strings", () => {
    const malformed = invalidCases
      .filter(({ code }) => code === RepositoryPathErrorCode.malformedUnicode)
      .map(({ input }) => input);
    for (const input of malformed) {
      expect(() => isRepositoryRelativePath(input)).not.toThrow();
      expect(isRepositoryRelativePath(input)).toBe(false);
    }
  });

  test("preserves normalization forms and compares them as distinct code-unit sequences", () => {
    const composed = canonicalizeRepositoryRelativePath("café.ts");
    const decomposed = canonicalizeRepositoryRelativePath("cafe\u0301.ts");

    expect(composed.normalize("NFD")).toBe(decomposed);
    expect(repositoryRelativePathsEqual(composed, decomposed)).toBe(false);
    expect(compareRepositoryRelativePaths(composed, decomposed)).not.toBe(0);
  });

  test("compares paths case-sensitively without locale folding", () => {
    const upper = canonicalizeRepositoryRelativePath("A/index.ts");
    const lower = canonicalizeRepositoryRelativePath("a/index.ts");

    expect(compareRepositoryRelativePaths(upper, upper)).toBe(0);
    expect(compareRepositoryRelativePaths(upper, lower)).toBe(-1);
    expect(compareRepositoryRelativePaths(lower, upper)).toBe(1);
    expect(repositoryRelativePathsEqual(upper, lower)).toBe(false);
    expect(repositoryRelativePathsEqual(lower, lower)).toBe(true);
  });
});

describe("explicit absolute conversion", () => {
  test.each([
    { root: "/work/repo", target: "/work/repo", expected: ".", absolute: "/work/repo" },
    {
      root: "/work/repo/",
      target: "/work/repo/src/index.ts",
      expected: "src/index.ts",
      absolute: "/work/repo/src/index.ts",
    },
    {
      root: "/work/./repo",
      target: "/work/repo/src//rules/../index.ts",
      expected: "src/index.ts",
      absolute: "/work/repo/src/index.ts",
    },
    {
      root: "/répo",
      target: "/répo/🧭/cafe\u0301.ts",
      expected: "🧭/cafe\u0301.ts",
      absolute: "/répo/🧭/cafe\u0301.ts",
    },
    {
      root: `/repo-${ASTRAL_FIRST}`,
      target: `/repo-${ASTRAL_FIRST}/src/${ASTRAL_LAST}.ts`,
      expected: `src/${ASTRAL_LAST}.ts`,
      absolute: `/repo-${ASTRAL_FIRST}/src/${ASTRAL_LAST}.ts`,
    },
  ] as const)("converts POSIX $target beneath $root", ({ root, target, expected, absolute }) => {
    const relative = repositoryRelativePathFromAbsolute(root, target, "posix");
    expect(relative).toBe(expected);
    expect(repositoryRelativePathToAbsolute(root, relative, "posix")).toBe(absolute);
  });

  test.each([
    { root: "C:\\repo", target: "C:\\repo", expected: "." },
    { root: "C:\\repo", target: "C:/repo/src\\index.ts", expected: "src/index.ts" },
    { root: "C:\\REPO", target: "c:\\repo\\Src\\Index.ts", expected: "Src/Index.ts" },
    {
      root: "\\\\server\\share\\repo",
      target: "\\\\SERVER\\SHARE\\repo\\src\\index.ts",
      expected: "src/index.ts",
    },
    {
      root: `C:\\repo-${ASTRAL_FIRST}`,
      target: `C:\\repo-${ASTRAL_FIRST}\\src\\${ASTRAL_LAST}.ts`,
      expected: `src/${ASTRAL_LAST}.ts`,
    },
  ] as const)("converts Windows $target beneath $root", ({ root, target, expected }) => {
    const relative = repositoryRelativePathFromAbsolute(root, target, "win32");
    expect(relative).toBe(expected);
    const absolute = repositoryRelativePathToAbsolute(root, relative, "win32");
    expect(repositoryRelativePathFromAbsolute(root, absolute, "win32")).toBe(relative);
  });

  test.each([
    { root: "/work/repo", target: "/work/other", flavor: "posix" as const },
    { root: "/work/repo", target: "/work/repository", flavor: "posix" as const },
    { root: "C:\\repo", target: "D:\\repo\\file", flavor: "win32" as const },
    { root: "C:\\repo", target: "C:\\other\\file", flavor: "win32" as const },
    {
      root: "\\\\server\\share\\repo",
      target: "\\\\server\\other\\repo\\file",
      flavor: "win32" as const,
    },
  ])("rejects $target outside $root", ({ root, target, flavor }) => {
    expectPathError(
      () => repositoryRelativePathFromAbsolute(root, target, flavor),
      RepositoryPathErrorCode.outsideRepository,
      target,
      root,
    );
  });

  test.each([
    {
      operation: (): RepositoryRelativePath =>
        repositoryRelativePathFromAbsolute("relative", "/repo/file", "posix"),
      code: RepositoryPathErrorCode.rootNotAbsolute,
      input: "relative",
    },
    {
      operation: (): RepositoryRelativePath =>
        repositoryRelativePathFromAbsolute("/repo", "relative", "posix"),
      code: RepositoryPathErrorCode.targetNotAbsolute,
      input: "relative",
    },
    {
      operation: (): RepositoryRelativePath =>
        repositoryRelativePathFromAbsolute("C:repo", "C:\\repo\\file", "win32"),
      code: RepositoryPathErrorCode.rootNotAbsolute,
      input: "C:repo",
    },
    {
      operation: (): RepositoryRelativePath =>
        repositoryRelativePathFromAbsolute("C:\\repo", "\\file", "win32"),
      code: RepositoryPathErrorCode.targetNotAbsolute,
      input: "\\file",
    },
    {
      operation: (): RepositoryRelativePath =>
        repositoryRelativePathFromAbsolute("\\\\?\\C:\\repo", "C:\\repo\\file", "win32"),
      code: RepositoryPathErrorCode.unsupportedDevicePath,
      input: "\\\\?\\C:\\repo",
    },
    {
      operation: (): RepositoryRelativePath =>
        repositoryRelativePathFromAbsolute("C:\\repo", "\\\\.\\pipe\\name", "win32"),
      code: RepositoryPathErrorCode.unsupportedDevicePath,
      input: "\\\\.\\pipe\\name",
    },
  ])("rejects an invalid absolute input with $code", ({ operation, code, input }) => {
    expectPathError(operation, code, input);
  });

  test("rejects a forged brand containing canonicalizable syntax", () => {
    const forged = "./src//index.ts" as RepositoryRelativePath;
    expectPathError(
      () => repositoryRelativePathToAbsolute("/repo", forged, "posix"),
      RepositoryPathErrorCode.nonCanonical,
      forged,
      "/repo",
    );
  });

  test("rejects a forged brand containing traversal before joining it to the root", () => {
    const forged = "../outside" as RepositoryRelativePath;
    expectPathError(
      () => repositoryRelativePathToAbsolute("/repo", forged, "posix"),
      RepositoryPathErrorCode.parentTraversal,
      forged,
    );
  });

  test.each([
    {
      flavor: "posix" as const,
      root: `/repo/${HIGH_LAST}`,
      target: "/repo/file",
      input: `/repo/${HIGH_LAST}`,
    },
    {
      flavor: "posix" as const,
      root: "/repo",
      target: `/repo/file-${HIGH_FIRST}`,
      input: `/repo/file-${HIGH_FIRST}`,
    },
    {
      flavor: "win32" as const,
      root: `C:\\repo\\${HIGH_FIRST}`,
      target: "C:\\repo\\file",
      input: `C:\\repo\\${HIGH_FIRST}`,
    },
    {
      flavor: "win32" as const,
      root: "C:\\repo",
      target: `C:\\repo\\${LOW_LAST}file`,
      input: `C:\\repo\\${LOW_LAST}file`,
    },
  ])(
    "rejects malformed Unicode in $flavor absolute root or target",
    ({ flavor, root, target, input }) => {
      expectPathError(
        () => repositoryRelativePathFromAbsolute(root, target, flavor),
        RepositoryPathErrorCode.malformedUnicode,
        input,
      );
    },
  );

  test.each([
    { flavor: "posix" as const, root: "/repo", forged: `src/${HIGH_FIRST}` },
    { flavor: "posix" as const, root: "/repo", forged: `${LOW_FIRST}/src` },
    { flavor: "win32" as const, root: "C:\\repo", forged: `src/${HIGH_LAST}` },
    { flavor: "win32" as const, root: "C:\\repo", forged: `${LOW_LAST}/src` },
  ])("rejects a forged $flavor brand with malformed Unicode", ({ flavor, root, forged }) => {
    expectPathError(
      () => repositoryRelativePathToAbsolute(root, forged as RepositoryRelativePath, flavor),
      RepositoryPathErrorCode.malformedUnicode,
      forged,
    );
  });
});
