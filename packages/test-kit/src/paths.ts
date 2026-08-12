import path from "node:path";

export type TestPathFlavor = "posix" | "win32";

type PathImplementation = Pick<
  typeof path.posix,
  "isAbsolute" | "join" | "normalize" | "relative" | "resolve" | "sep"
>;

function requirePathText(value: string, label: string): void {
  if (value.includes("\0")) {
    throw new TypeError(`${label} must not contain a null byte`);
  }
}

/** Deterministic lexical path operations for an explicitly selected platform grammar. */
export class DeterministicPathService {
  readonly flavor: TestPathFlavor;
  readonly separator: "/" | "\\";
  readonly #implementation: PathImplementation;

  constructor(flavor: TestPathFlavor) {
    this.flavor = flavor;
    this.#implementation = flavor === "posix" ? path.posix : path.win32;
    this.separator = this.#implementation.sep;
  }

  isAbsolute(input: string): boolean {
    requirePathText(input, "input");
    return this.#implementation.isAbsolute(input);
  }

  join(...segments: readonly string[]): string {
    for (const segment of segments) {
      requirePathText(segment, "path segment");
    }
    return this.#implementation.join(...segments);
  }

  normalize(input: string): string {
    requirePathText(input, "input");
    return this.#implementation.normalize(input);
  }

  relative(from: string, to: string): string {
    requirePathText(from, "from");
    requirePathText(to, "to");
    return this.#implementation.relative(from, to);
  }

  resolveWithinRoot(root: string, relativePath: string): string {
    requirePathText(root, "root");
    requirePathText(relativePath, "relativePath");
    if (!this.#implementation.isAbsolute(root)) {
      throw new TypeError("root must be absolute in the selected path grammar");
    }
    if (this.#implementation.isAbsolute(relativePath)) {
      throw new RangeError("fixture path must be relative");
    }

    const resolved = this.#implementation.resolve(root, relativePath);
    const relative = this.#implementation.relative(root, resolved);
    if (
      relative === ".." ||
      relative.startsWith(`..${this.#implementation.sep}`) ||
      this.#implementation.isAbsolute(relative)
    ) {
      throw new RangeError("fixture path escapes its root");
    }
    return resolved;
  }
}

export function createPathService(flavor: TestPathFlavor): DeterministicPathService {
  return new DeterministicPathService(flavor);
}
