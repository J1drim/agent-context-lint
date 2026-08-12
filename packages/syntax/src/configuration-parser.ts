import { isAlias, isMap, isPair, isScalar, isSeq, LineCounter, parseDocument } from "yaml";

import type {
  ConfigurationSourceLocation,
  ConfigurationSourcePosition,
  ConfigurationSourceRange,
  ConfigurationValidationIssue,
  ConfigurationValidationResult,
  RepositoryRelativePath,
} from "@agent-context/core";
import {
  CONFIGURATION_FILE_NAME,
  CONFIGURATION_SOURCE_LIMITS,
  appendConfigurationPathProperty,
  isRepositoryRelativePath,
  validateAgentContextConfiguration,
} from "@agent-context/core";

interface NodeFrame {
  readonly depth: number;
  readonly kind: "key" | "value";
  readonly node: unknown;
  readonly path: string;
}

export interface ParseAgentContextConfigurationOptions {
  readonly path?: RepositoryRelativePath;
}

function hasWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

function position(
  source: string,
  lineCounter: LineCounter,
  offset: number,
): ConfigurationSourcePosition {
  const bounded = Math.max(0, Math.min(offset, source.length));
  const linePosition = lineCounter.linePos(bounded);
  return {
    byteOffset: Buffer.byteLength(source.slice(0, bounded), "utf8"),
    line: Math.max(0, linePosition.line - 1),
    utf16Column: Math.max(0, linePosition.col - 1),
    utf16Offset: bounded,
  };
}

function sourceRange(
  source: string,
  lineCounter: LineCounter,
  range: readonly number[] | null | undefined,
): ConfigurationSourceRange {
  const start = range?.[0] ?? 0;
  const end = range?.[1] ?? start;
  return { end: position(source, lineCounter, end), start: position(source, lineCounter, start) };
}

function preflightPosition(source: string, offset: number): ConfigurationSourcePosition {
  const bounded = Math.max(0, Math.min(offset, source.length));
  let line = 0;
  let lineStart = 0;
  let index = 0;
  while (index < bounded) {
    const unit = source.charCodeAt(index);
    if (unit === 0x0d) {
      index += index + 1 < bounded && source.charCodeAt(index + 1) === 0x0a ? 2 : 1;
      line += 1;
      lineStart = index;
    } else if (unit === 0x0a) {
      index += 1;
      line += 1;
      lineStart = index;
    } else {
      index += 1;
    }
  }
  return {
    byteOffset: Buffer.byteLength(source.slice(0, bounded), "utf8"),
    line,
    utf16Column: bounded - lineStart,
    utf16Offset: bounded,
  };
}

function preflightRootRange(source: string): ConfigurationSourceRange {
  return {
    end: preflightPosition(source, source.length),
    start: preflightPosition(source, 0),
  };
}

function parentPath(path: string): string | undefined {
  let escaped = false;
  let inString = false;
  let lastSegment = -1;
  for (let index = 1; index < path.length; index += 1) {
    const character = path[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
    } else if (character === '"') {
      inString = true;
    } else if (character === "." || character === "[") {
      lastSegment = index;
    }
  }
  return lastSegment <= 0 ? undefined : path.slice(0, lastSegment);
}

function singleIssue(
  code: ConfigurationValidationIssue["code"],
  path: RepositoryRelativePath,
  range: ConfigurationSourceRange,
  message: string,
): ConfigurationValidationResult {
  return {
    issues: [{ code, location: { path, range }, message, path: "$" }],
    ok: false,
  };
}

/** Parse one explicit B06 YAML source without reading the filesystem. */
export function parseAgentContextConfiguration(
  source: string,
  options: ParseAgentContextConfigurationOptions = {},
): ConfigurationValidationResult {
  const configPath = options.path ?? (CONFIGURATION_FILE_NAME as RepositoryRelativePath);
  if (configPath === "." || !isRepositoryRelativePath(configPath)) {
    throw new TypeError("configuration path must be a canonical non-root B01 repository path");
  }
  const rootRange = preflightRootRange(source);
  if (!hasWellFormedUnicode(source)) {
    return singleIssue(
      "invalid-value",
      configPath,
      rootRange,
      "configuration must be well-formed Unicode",
    );
  }
  if (rootRange.end.byteOffset > CONFIGURATION_SOURCE_LIMITS.maximumBytes) {
    return singleIssue(
      "resource-limit",
      configPath,
      rootRange,
      `configuration must not exceed ${String(CONFIGURATION_SOURCE_LIMITS.maximumBytes)} UTF-8 bytes`,
    );
  }

  const lineCounter = new LineCounter();
  let document: ReturnType<typeof parseDocument>;
  try {
    document = parseDocument(source, {
      lineCounter,
      merge: false,
      prettyErrors: false,
      schema: "core",
      strict: true,
      uniqueKeys: true,
    });
  } catch {
    return singleIssue("invalid-yaml", configPath, rootRange, "configuration is not valid YAML");
  }
  if (document.errors.length > 0) {
    const error = document.errors[0];
    const code = error?.code === "DUPLICATE_KEY" ? "duplicate-key" : "invalid-yaml";
    const range = sourceRange(source, lineCounter, error?.pos);
    return singleIssue(
      code,
      configPath,
      range,
      `configuration YAML error: ${error?.code ?? "PARSE_ERROR"}`,
    );
  }
  if (document.warnings.length > 0) {
    const warning = document.warnings[0];
    return singleIssue(
      "invalid-yaml",
      configPath,
      sourceRange(source, lineCounter, warning?.pos),
      `configuration YAML warning is rejected: ${warning?.code ?? "WARNING"}`,
    );
  }

  const locations = new Map<string, ConfigurationSourceLocation>();
  const keyLocations = new Map<string, ConfigurationSourceLocation>();
  const structuralIssues: ConfigurationValidationIssue[] = [];
  const addStructuralIssue = (issue: ConfigurationValidationIssue): void => {
    if (structuralIssues.length < CONFIGURATION_SOURCE_LIMITS.maximumIssues - 1) {
      structuralIssues.push(issue);
    } else if (structuralIssues.length === CONFIGURATION_SOURCE_LIMITS.maximumIssues - 1) {
      structuralIssues.push({
        code: "resource-limit",
        location: { path: configPath, range: rootRange },
        message: `validation stopped after ${String(CONFIGURATION_SOURCE_LIMITS.maximumIssues - 1)} issues`,
        path: "$",
      });
    }
  };
  const stack: NodeFrame[] = [{ depth: 0, kind: "value", node: document.contents, path: "$" }];
  let collectionEntries = 0;
  let nodes = 0;
  while (stack.length > 0) {
    if (structuralIssues.length >= CONFIGURATION_SOURCE_LIMITS.maximumIssues) break;
    const frame = stack.pop();
    if (frame === undefined || frame.node === null) continue;
    nodes += 1;
    const nodeRange = sourceRange(
      source,
      lineCounter,
      typeof frame.node === "object" && "range" in frame.node
        ? ((frame.node as { readonly range?: readonly number[] }).range ?? undefined)
        : undefined,
    );
    (frame.kind === "key" ? keyLocations : locations).set(frame.path, {
      path: configPath,
      range: nodeRange,
    });
    if (nodes > CONFIGURATION_SOURCE_LIMITS.maximumNodes) {
      addStructuralIssue({
        code: "resource-limit",
        location: { path: configPath, range: nodeRange },
        message: `configuration must not contain more than ${String(CONFIGURATION_SOURCE_LIMITS.maximumNodes)} YAML nodes`,
        path: frame.path,
      });
      break;
    }
    if (frame.depth > CONFIGURATION_SOURCE_LIMITS.maximumDepth) {
      addStructuralIssue({
        code: "resource-limit",
        location: { path: configPath, range: nodeRange },
        message: `configuration must not exceed ${String(CONFIGURATION_SOURCE_LIMITS.maximumDepth)} nested collections`,
        path: frame.path,
      });
      break;
    }
    if (isAlias(frame.node)) {
      addStructuralIssue({
        code: "alias-forbidden",
        location: { path: configPath, range: nodeRange },
        message: "YAML aliases are disabled for configuration",
        path: frame.path,
      });
      continue;
    }
    const metadata = frame.node as { readonly anchor?: string; readonly tag?: string };
    if (metadata.anchor !== undefined || metadata.tag !== undefined) {
      addStructuralIssue({
        code: "alias-forbidden",
        location: { path: configPath, range: nodeRange },
        message: "YAML anchors and explicit tags are disabled for configuration",
        path: frame.path,
      });
    }
    if (isScalar(frame.node)) {
      if (
        typeof frame.node.value === "string" &&
        Buffer.byteLength(frame.node.value, "utf8") > CONFIGURATION_SOURCE_LIMITS.maximumScalarBytes
      ) {
        addStructuralIssue({
          code: "resource-limit",
          location: { path: configPath, range: nodeRange },
          message: `scalar must not exceed ${String(CONFIGURATION_SOURCE_LIMITS.maximumScalarBytes)} UTF-8 bytes`,
          path: frame.path,
        });
      }
      continue;
    }
    if (isSeq(frame.node)) {
      collectionEntries += frame.node.items.length;
      for (let index = frame.node.items.length - 1; index >= 0; index -= 1) {
        stack.push({
          depth: frame.depth + 1,
          kind: "value",
          node: frame.node.items[index],
          path: `${frame.path}[${String(index)}]`,
        });
      }
    } else if (isMap(frame.node)) {
      collectionEntries += frame.node.items.length;
      for (let index = frame.node.items.length - 1; index >= 0; index -= 1) {
        const pair = frame.node.items[index];
        if (!isPair(pair)) {
          addStructuralIssue({
            code: "invalid-yaml",
            location: { path: configPath, range: nodeRange },
            message: "configuration maps must contain YAML key/value pairs",
            path: frame.path,
          });
          continue;
        }
        const keyValue =
          isScalar(pair.key) && typeof pair.key.value === "string" ? pair.key.value : undefined;
        const childPath =
          keyValue !== undefined
            ? appendConfigurationPathProperty(frame.path, keyValue)
            : `${frame.path}[key:${String(index)}]`;
        if (pair.value !== null) {
          stack.push({
            depth: frame.depth + 1,
            kind: "value",
            node: pair.value,
            path: childPath,
          });
        }
        if (pair.key !== null) {
          stack.push({
            depth: frame.depth + 1,
            kind: "key",
            node: pair.key,
            path: childPath,
          });
        }
        if (keyValue === undefined) {
          const keyRange =
            typeof pair.key === "object" && pair.key !== null && "range" in pair.key
              ? ((pair.key as { readonly range?: readonly number[] }).range ?? undefined)
              : undefined;
          addStructuralIssue({
            code: "invalid-yaml",
            location: {
              path: configPath,
              range: sourceRange(source, lineCounter, keyRange),
            },
            message: "configuration map keys must be strings",
            path: childPath,
          });
        }
      }
    } else {
      addStructuralIssue({
        code: "invalid-yaml",
        location: { path: configPath, range: nodeRange },
        message: "configuration contains an unsupported YAML node",
        path: frame.path,
      });
    }
    if (collectionEntries > CONFIGURATION_SOURCE_LIMITS.maximumCollectionEntries) {
      addStructuralIssue({
        code: "resource-limit",
        location: { path: configPath, range: nodeRange },
        message: `configuration must not contain more than ${String(CONFIGURATION_SOURCE_LIMITS.maximumCollectionEntries)} collection entries`,
        path: frame.path,
      });
      break;
    }
  }
  if (structuralIssues.length > 0) return { issues: structuralIssues, ok: false };

  let value: unknown;
  try {
    value = document.toJS({ maxAliasCount: CONFIGURATION_SOURCE_LIMITS.maximumAliases });
  } catch {
    return singleIssue(
      "alias-forbidden",
      configPath,
      rootRange,
      "YAML alias expansion is disabled",
    );
  }
  return validateAgentContextConfiguration(value, {
    locateKey: (issuePath) => keyLocations.get(issuePath) ?? null,
    locate: (issuePath) => {
      let candidate: string | undefined = issuePath;
      while (candidate !== undefined) {
        const location = locations.get(candidate);
        if (location !== undefined) return location;
        candidate = parentPath(candidate);
      }
      return {
        path: configPath,
        range: sourceRange(source, lineCounter, document.contents?.range),
      };
    },
  });
}
