export type BuiltInInstructionSourceKey = "claude" | "codex" | "copilot" | "cursor" | "gemini";

export type BuiltInInstructionPathMatcher =
  | Readonly<{ kind: "basename" | "exact-path" | "path-suffix"; value: string }>
  | Readonly<{ directory: string; kind: "under-directory-extension"; suffix: string }>;

export interface BuiltInInstructionPathDefinition {
  readonly formatId: string;
  readonly matcher: BuiltInInstructionPathMatcher;
  readonly recognizerId: string;
  readonly sourceKey: BuiltInInstructionSourceKey;
}

export interface BuiltInInstructionPathRecognition {
  readonly formatId: string;
  readonly recognizerId: string;
}

export const BUILT_IN_INSTRUCTION_PATH_DEFINITIONS: readonly BuiltInInstructionPathDefinition[];

export interface DiscoveryPathAdmissionLimits {
  readonly maximumPathDepth: number;
  readonly maximumPathLength: number;
}

export const DISCOVERY_PATH_ADMISSION_DEFAULTS: Readonly<DiscoveryPathAdmissionLimits>;

export function isSafeDiscoveryText(value: unknown): value is string;

export function isCanonicalRepositoryPathForDiscovery(
  pathValue: unknown,
  limits?: Readonly<DiscoveryPathAdmissionLimits>,
): pathValue is string;

export function matchesBuiltInDiscoveryPathMatcher(
  matcher: BuiltInInstructionPathMatcher,
  pathValue: string,
): boolean;

export function recognizeBuiltInInstructionPath(
  pathValue: string,
): readonly BuiltInInstructionPathRecognition[];
