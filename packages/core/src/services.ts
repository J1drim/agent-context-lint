/** Milliseconds from the Unix epoch supplied by an injected time source. */
export interface Clock {
  now(): number;
}

/** Random values supplied by an injected source. Security-sensitive callers require a cryptographic implementation. */
export interface RandomSource {
  nextFloat(): number;
  nextUint32(): number;
}

/** Path grammar used for deterministic path operations. */
export type PathFlavor = "posix" | "win32";

/**
 * Lexical path operations that do not consult the process working directory.
 *
 * This contract does not perform filesystem or symlink checks. Production root jails must combine it with the
 * read-only filesystem facade planned in C02.
 */
export interface PathService {
  readonly flavor: PathFlavor;
  readonly separator: "/" | "\\";
  isAbsolute(input: string): boolean;
  join(...segments: readonly string[]): string;
  normalize(input: string): string;
  relative(from: string, to: string): string;
  resolveWithinRoot(root: string, relativePath: string): string;
}
