/**
 * Data-only built-in instruction-path catalog shared by product discovery and offline maintainer
 * calibration tooling. Paths are repository-relative POSIX paths and matching is case-sensitive.
 */
export const BUILT_IN_INSTRUCTION_PATH_DEFINITIONS = Object.freeze([
  Object.freeze({
    formatId: "agents-markdown",
    matcher: Object.freeze({ kind: "basename", value: "AGENTS.md" }),
    recognizerId: "instruction.agents-base",
    sourceKey: "codex",
  }),
  Object.freeze({
    formatId: "agents-markdown",
    matcher: Object.freeze({ kind: "basename", value: "AGENTS.override.md" }),
    recognizerId: "instruction.agents-override",
    sourceKey: "codex",
  }),
  Object.freeze({
    formatId: "claude-memory-markdown",
    matcher: Object.freeze({ kind: "basename", value: "CLAUDE.local.md" }),
    recognizerId: "instruction.claude-local",
    sourceKey: "claude",
  }),
  Object.freeze({
    formatId: "claude-memory-markdown",
    matcher: Object.freeze({ kind: "basename", value: "CLAUDE.md" }),
    recognizerId: "instruction.claude-memory",
    sourceKey: "claude",
  }),
  Object.freeze({
    formatId: "claude-rule-markdown",
    matcher: Object.freeze({
      directory: ".claude/rules",
      kind: "under-directory-extension",
      suffix: ".md",
    }),
    recognizerId: "instruction.claude-rules",
    sourceKey: "claude",
  }),
  Object.freeze({
    formatId: "copilot-path-instructions",
    matcher: Object.freeze({
      directory: ".github/instructions",
      kind: "under-directory-extension",
      suffix: ".instructions.md",
    }),
    recognizerId: "instruction.copilot-path",
    sourceKey: "copilot",
  }),
  Object.freeze({
    formatId: "copilot-repository-markdown",
    matcher: Object.freeze({ kind: "path-suffix", value: ".github/copilot-instructions.md" }),
    recognizerId: "instruction.copilot-repository",
    sourceKey: "copilot",
  }),
  Object.freeze({
    formatId: "cursor-legacy-rules",
    matcher: Object.freeze({ kind: "exact-path", value: ".cursorrules" }),
    recognizerId: "instruction.cursor-legacy",
    sourceKey: "cursor",
  }),
  Object.freeze({
    formatId: "cursor-mdc",
    matcher: Object.freeze({
      directory: ".cursor/rules",
      kind: "under-directory-extension",
      suffix: ".mdc",
    }),
    recognizerId: "instruction.cursor-mdc",
    sourceKey: "cursor",
  }),
  Object.freeze({
    formatId: "gemini-context-markdown",
    matcher: Object.freeze({ kind: "basename", value: "GEMINI.md" }),
    recognizerId: "instruction.gemini-context",
    sourceKey: "gemini",
  }),
]);

export const DISCOVERY_PATH_ADMISSION_DEFAULTS = Object.freeze({
  maximumPathDepth: 128,
  maximumPathLength: 16_384,
});

export function isSafeDiscoveryText(value) {
  if (typeof value !== "string") return false;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
      continue;
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) return false;
    if (
      unit <= 0x1f ||
      (unit >= 0x7f && unit <= 0x9f) ||
      unit === 0x061c ||
      unit === 0x200e ||
      unit === 0x200f ||
      (unit >= 0x202a && unit <= 0x202e) ||
      (unit >= 0x2066 && unit <= 0x2069)
    )
      return false;
  }
  return true;
}

export function isCanonicalRepositoryPathForDiscovery(
  value,
  limits = DISCOVERY_PATH_ADMISSION_DEFAULTS,
) {
  let maximumPathDepth;
  let maximumPathLength;
  try {
    maximumPathDepth = limits?.maximumPathDepth;
    maximumPathLength = limits?.maximumPathLength;
  } catch {
    return false;
  }
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    !Number.isSafeInteger(maximumPathDepth) ||
    maximumPathDepth < 1 ||
    !Number.isSafeInteger(maximumPathLength) ||
    maximumPathLength < 1 ||
    value.length > maximumPathLength ||
    !isSafeDiscoveryText(value) ||
    value.includes("\\") ||
    /^[\\/]{2}[?.][\\/]/.test(value) ||
    /^[A-Za-z]:(?![\\/])/.test(value) ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    /^[\\/]{2}[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/.test(value) ||
    value.startsWith("/") ||
    value.startsWith("\\")
  )
    return false;
  const segments = value.split(/\/+/);
  if (segments.length > maximumPathDepth || segments.some((segment) => segment === ".."))
    return false;
  const canonical =
    segments.filter((segment) => segment !== "" && segment !== ".").join("/") || ".";
  return canonical === value;
}

export function matchesBuiltInDiscoveryPathMatcher(matcher, pathValue) {
  if (matcher.kind === "exact-path") return pathValue === matcher.value;
  if (matcher.kind === "path-suffix")
    return pathValue === matcher.value || pathValue.endsWith(`/${matcher.value}`);
  const slash = pathValue.lastIndexOf("/");
  const name = slash === -1 ? pathValue : pathValue.slice(slash + 1);
  if (matcher.kind === "basename") return name === matcher.value;
  if (!name.endsWith(matcher.suffix)) return false;
  const directoryPrefix = slash === -1 ? "" : pathValue.slice(0, slash);
  return (
    directoryPrefix === matcher.directory ||
    directoryPrefix.startsWith(`${matcher.directory}/`) ||
    directoryPrefix.includes(`/${matcher.directory}/`) ||
    directoryPrefix.endsWith(`/${matcher.directory}`)
  );
}

export function recognizeBuiltInInstructionPath(pathValue) {
  if (!isCanonicalRepositoryPathForDiscovery(pathValue)) return Object.freeze([]);
  return Object.freeze(
    BUILT_IN_INSTRUCTION_PATH_DEFINITIONS.filter((definition) =>
      matchesBuiltInDiscoveryPathMatcher(definition.matcher, pathValue),
    ).map((definition) =>
      Object.freeze({ formatId: definition.formatId, recognizerId: definition.recognizerId }),
    ),
  );
}
