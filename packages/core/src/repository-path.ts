import path from "node:path";

import type { PathFlavor } from "./services.js";

declare const repositoryRelativePathBrand: unique symbol;

/** Canonical, repository-relative logical path using `/` separators, or `.` for the repository root. */
export type RepositoryRelativePath = string & {
  readonly [repositoryRelativePathBrand]: "RepositoryRelativePath";
};

/** Stable machine-readable failure codes for repository path conversion. */
export const RepositoryPathErrorCode = {
  controlCharacter: "REPOSITORY_PATH_CONTROL_CHARACTER",
  malformedUnicode: "REPOSITORY_PATH_MALFORMED_UNICODE",
  nonCanonical: "REPOSITORY_PATH_NON_CANONICAL",
  notRelative: "REPOSITORY_PATH_NOT_RELATIVE",
  outsideRepository: "REPOSITORY_PATH_OUTSIDE_REPOSITORY",
  parentTraversal: "REPOSITORY_PATH_PARENT_TRAVERSAL",
  rootNotAbsolute: "REPOSITORY_PATH_ROOT_NOT_ABSOLUTE",
  targetNotAbsolute: "REPOSITORY_PATH_TARGET_NOT_ABSOLUTE",
  unsupportedDevicePath: "REPOSITORY_PATH_UNSUPPORTED_DEVICE_PATH",
  windowsDriveRelative: "REPOSITORY_PATH_WINDOWS_DRIVE_RELATIVE",
  windowsSeparator: "REPOSITORY_PATH_WINDOWS_SEPARATOR",
} as const;

export type RepositoryPathErrorCode =
  (typeof RepositoryPathErrorCode)[keyof typeof RepositoryPathErrorCode];

/** Typed conversion error suitable for exhaustive handling at API boundaries. */
export class RepositoryPathError extends Error {
  override readonly name = "RepositoryPathError" as const;
  readonly code: RepositoryPathErrorCode;
  readonly input: string;
  readonly root: string | undefined;

  constructor(code: RepositoryPathErrorCode, message: string, input: string, root?: string) {
    super(message);
    this.code = code;
    this.input = input;
    this.root = root;
  }
}

/** Canonical value representing the repository root itself. */
export const REPOSITORY_ROOT: RepositoryRelativePath = "." as RepositoryRelativePath;

function fail(code: RepositoryPathErrorCode, message: string, input: string, root?: string): never {
  throw new RepositoryPathError(code, message, input, root);
}

function validateText(input: string): void {
  for (let index = 0; index < input.length; index += 1) {
    const codeUnit = input.charCodeAt(index);
    if (codeUnit <= 0x1f || codeUnit === 0x7f) {
      fail(
        RepositoryPathErrorCode.controlCharacter,
        "repository paths must not contain C0 or DEL control characters",
        input,
      );
    }
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = input.charCodeAt(index + 1);
      if (Number.isNaN(nextCodeUnit) || nextCodeUnit < 0xdc00 || nextCodeUnit > 0xdfff) {
        fail(
          RepositoryPathErrorCode.malformedUnicode,
          "repository paths must contain well-formed Unicode",
          input,
        );
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      fail(
        RepositoryPathErrorCode.malformedUnicode,
        "repository paths must contain well-formed Unicode",
        input,
      );
    }
  }
}

function isWindowsDevicePath(input: string): boolean {
  return /^[\\/]{2}[?.][\\/]/.test(input);
}

function isWindowsDriveRelative(input: string): boolean {
  return /^[A-Za-z]:(?![\\/])/.test(input);
}

function isFullyQualifiedWindowsPath(input: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(input) || /^[\\/]{2}[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/.test(input);
}

function implementationFor(flavor: PathFlavor): typeof path.posix {
  return flavor === "posix" ? path.posix : path.win32;
}

function validateNoDevicePath(input: string): void {
  if (isWindowsDevicePath(input)) {
    fail(
      RepositoryPathErrorCode.unsupportedDevicePath,
      "Windows device namespace paths are not repository filesystem paths",
      input,
    );
  }
}

function validateFullyQualified(input: string, flavor: PathFlavor, role: "root" | "target"): void {
  validateText(input);
  validateNoDevicePath(input);
  const isAbsolute =
    flavor === "posix" ? path.posix.isAbsolute(input) : isFullyQualifiedWindowsPath(input);
  if (!isAbsolute) {
    fail(
      role === "root"
        ? RepositoryPathErrorCode.rootNotAbsolute
        : RepositoryPathErrorCode.targetNotAbsolute,
      `${role} must be a fully qualified ${flavor} path`,
      input,
    );
  }
}

/**
 * Canonicalizes a relative path from an explicitly selected grammar.
 *
 * Empty input and any sequence of `.` segments represent the repository root. Parent traversal is
 * rejected rather than collapsed. POSIX input rejects `\\` because it is a filename character on
 * POSIX but a separator on Windows and therefore cannot round-trip as a portable logical path.
 */
export function canonicalizeRepositoryRelativePath(
  input: string,
  sourceFlavor: PathFlavor = "posix",
): RepositoryRelativePath {
  validateText(input);
  validateNoDevicePath(input);
  if (isWindowsDriveRelative(input)) {
    fail(
      RepositoryPathErrorCode.windowsDriveRelative,
      "drive-relative Windows paths depend on per-drive current-directory state",
      input,
    );
  }
  const implementation = implementationFor(sourceFlavor);
  if (
    implementation.isAbsolute(input) ||
    isFullyQualifiedWindowsPath(input) ||
    input.startsWith("\\")
  ) {
    fail(
      RepositoryPathErrorCode.notRelative,
      "repository-relative paths must not be absolute or drive-rooted",
      input,
    );
  }
  if (sourceFlavor === "posix" && input.includes("\\")) {
    fail(
      RepositoryPathErrorCode.windowsSeparator,
      "POSIX input containing a backslash cannot be represented portably",
      input,
    );
  }

  const segments = input.split(sourceFlavor === "win32" ? /[\\/]+/ : /\/+/);
  const canonicalSegments: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      fail(
        RepositoryPathErrorCode.parentTraversal,
        "repository-relative paths must not contain parent traversal",
        input,
      );
    }
    canonicalSegments.push(segment);
  }
  return canonicalSegments.length === 0
    ? REPOSITORY_ROOT
    : (canonicalSegments.join("/") as RepositoryRelativePath);
}

/** Returns true only for strings already in canonical repository-relative form. */
export function isRepositoryRelativePath(input: string): input is RepositoryRelativePath {
  try {
    return canonicalizeRepositoryRelativePath(input) === input;
  } catch (error: unknown) {
    if (error instanceof RepositoryPathError) {
      return false;
    }
    throw error;
  }
}

/**
 * Converts a fully qualified filesystem target to a logical repository path using lexical rules.
 * The operation never reads the host working directory and does not resolve symlinks.
 */
export function repositoryRelativePathFromAbsolute(
  root: string,
  target: string,
  flavor: PathFlavor,
): RepositoryRelativePath {
  validateFullyQualified(root, flavor, "root");
  validateFullyQualified(target, flavor, "target");
  const implementation = implementationFor(flavor);
  const normalizedRoot = implementation.normalize(root);
  const normalizedTarget = implementation.normalize(target);
  const relative = implementation.relative(normalizedRoot, normalizedTarget);
  if (
    implementation.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith(`..${implementation.sep}`)
  ) {
    fail(
      RepositoryPathErrorCode.outsideRepository,
      "target is lexically outside the repository root",
      target,
      root,
    );
  }
  return canonicalizeRepositoryRelativePath(relative, flavor);
}

/**
 * Converts a branded logical path beneath an explicit fully qualified root to the selected grammar.
 * The operation is lexical and must be followed by C02 real-path/symlink containment checks before
 * accessing untrusted filesystem content.
 */
export function repositoryRelativePathToAbsolute(
  root: string,
  relativePath: RepositoryRelativePath,
  flavor: PathFlavor,
): string {
  validateFullyQualified(root, flavor, "root");
  const canonical = canonicalizeRepositoryRelativePath(relativePath);
  if (canonical !== relativePath) {
    fail(
      RepositoryPathErrorCode.nonCanonical,
      "branded repository path is not canonical",
      relativePath,
      root,
    );
  }
  const implementation = implementationFor(flavor);
  const normalizedRoot = implementation.normalize(root);
  return relativePath === REPOSITORY_ROOT
    ? normalizedRoot
    : implementation.join(normalizedRoot, ...relativePath.split("/"));
}

/** Case-sensitive, locale-independent comparison of canonical logical paths. */
export function compareRepositoryRelativePaths(
  left: RepositoryRelativePath,
  right: RepositoryRelativePath,
): -1 | 0 | 1 {
  return left === right ? 0 : left < right ? -1 : 1;
}

/** Case-sensitive identity comparison without Unicode or filesystem case folding. */
export function repositoryRelativePathsEqual(
  left: RepositoryRelativePath,
  right: RepositoryRelativePath,
): boolean {
  return left === right;
}
