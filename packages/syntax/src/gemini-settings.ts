import { types as nodeTypes } from "node:util";

import { isMap, parseDocument } from "yaml";

import { isRepositoryRelativePath, type RepositoryRelativePath } from "@agent-context/core";

export const GEMINI_SETTINGS_CONTRACT_VERSION = "0.1.0" as const;
export interface GeminiSettingsDefaults {
  readonly discoveryMaxDirs: 200;
  readonly fileNames: readonly ["GEMINI.md"];
  readonly importFormat: "tree";
  readonly includeDirectories: readonly RepositoryRelativePath[];
  readonly loadMemoryFromIncludeDirectories: false;
  readonly memoryBoundaryMarkers: readonly [".git"];
  readonly respectGeminiIgnore: true;
  readonly respectGitIgnore: true;
}

export const GEMINI_SETTINGS_DEFAULTS: GeminiSettingsDefaults = Object.freeze({
  discoveryMaxDirs: 200,
  fileNames: Object.freeze(["GEMINI.md"] as const),
  importFormat: "tree" as const,
  includeDirectories: Object.freeze([] as RepositoryRelativePath[]),
  loadMemoryFromIncludeDirectories: false,
  memoryBoundaryMarkers: Object.freeze([".git"] as const),
  respectGeminiIgnore: true,
  respectGitIgnore: true,
});

export interface GeminiSettingsLimits {
  readonly maximumBytes: number;
  readonly maximumFileNames: number;
  readonly maximumIncludeDirectories: number;
  readonly maximumIssues: number;
  readonly maximumLayers: number;
  readonly maximumMarkerCount: number;
  readonly maximumStringBytes: number;
}

export const GEMINI_SETTINGS_LIMITS: Readonly<GeminiSettingsLimits> = Object.freeze({
  maximumBytes: 1_048_576,
  maximumFileNames: 128,
  maximumIncludeDirectories: 128,
  maximumIssues: 128,
  maximumLayers: 8,
  maximumMarkerCount: 128,
  maximumStringBytes: 16_384,
});

export type GeminiImportFormat = "flat" | "tree";
export type GeminiSettingsLayerKind =
  "defaults" | "system-defaults" | "user" | "workspace" | "system-override";

export type GeminiSettingsIssueCode =
  | "duplicate-key"
  | "environment-placeholder"
  | "invalid-json"
  | "invalid-setting"
  | "resource-limit"
  | "unknown-context-setting"
  | "untrusted-workspace-layer"
  | "unsafe-path";

export interface GeminiSettingsIssue {
  readonly code: GeminiSettingsIssueCode;
  readonly layer: GeminiSettingsLayerKind | null;
  readonly message: string;
  readonly path: RepositoryRelativePath;
  readonly setting: string;
}

export interface GeminiSettingsValues {
  readonly discoveryMaxDirs?: number;
  readonly fileNames?: readonly string[];
  readonly importFormat?: GeminiImportFormat;
  readonly includeDirectories?: readonly RepositoryRelativePath[];
  readonly loadMemoryFromIncludeDirectories?: boolean;
  readonly memoryBoundaryMarkers?: readonly string[];
  readonly respectGeminiIgnore?: boolean;
  readonly respectGitIgnore?: boolean;
}

type MutableGeminiSettingsValues = {
  -readonly [Key in keyof GeminiSettingsValues]: GeminiSettingsValues[Key];
};

type MutableRequiredGeminiSettingsValues = {
  -readonly [Key in keyof Required<GeminiSettingsValues>]: Required<GeminiSettingsValues>[Key];
};

export interface GeminiSettingsParseResult {
  readonly contractVersion: typeof GEMINI_SETTINGS_CONTRACT_VERSION;
  readonly issues: readonly GeminiSettingsIssue[];
  readonly path: RepositoryRelativePath;
  readonly state: "complete" | "malformed" | "partial";
  readonly values: Readonly<GeminiSettingsValues>;
}

export interface ParseGeminiSettingsInput {
  readonly bytes: Uint8Array;
  readonly path: RepositoryRelativePath;
}

export interface GeminiSettingsLayerInput extends ParseGeminiSettingsInput {
  readonly kind: GeminiSettingsLayerKind;
  readonly trustState: "trusted" | "untrusted" | "not-applicable";
}

export interface GeminiSettingsMergeResult {
  readonly contractVersion: typeof GEMINI_SETTINGS_CONTRACT_VERSION;
  readonly issues: readonly GeminiSettingsIssue[];
  readonly layersApplied: readonly GeminiSettingsLayerKind[];
  readonly state: "complete" | "partial";
  readonly values: Readonly<Required<GeminiSettingsValues>>;
}

export class GeminiSettingsError extends Error {
  override readonly name = "GeminiSettingsError" as const;
  readonly code: "GEMINI_SETTINGS_INVALID_INPUT" | "GEMINI_SETTINGS_RESOURCE_LIMIT";

  constructor(code: GeminiSettingsError["code"], message: string) {
    super(message);
    this.code = code;
    Object.freeze(this);
  }
}

const INPUT_KEYS = new Set(["bytes", "path"]);
const LAYER_KEYS = new Set(["bytes", "kind", "path", "trustState"]);
const LAYER_KINDS = new Set<GeminiSettingsLayerKind>([
  "defaults",
  "system-defaults",
  "user",
  "workspace",
  "system-override",
]);
const CONTEXT_KEYS = new Set([
  "discoveryMaxDirs",
  "fileFiltering",
  "fileName",
  "importFormat",
  "includeDirectories",
  "loadMemoryFromIncludeDirectories",
  "memoryBoundaryMarkers",
]);
const ENVIRONMENT_PLACEHOLDER = /\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[^}\r\n]+\})/u;

function fail(code: GeminiSettingsError["code"], message: string): never {
  throw new GeminiSettingsError(code, message);
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    nodeTypes.isProxy(value)
  )
    return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function closedRecord(value: unknown, keys: ReadonlySet<string>): Record<string, unknown> {
  if (!plainRecord(value))
    return fail("GEMINI_SETTINGS_INVALID_INPUT", "input must be a plain record");
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== keys.size ||
    ownKeys.some((key) => typeof key !== "string" || !keys.has(key))
  )
    return fail(
      "GEMINI_SETTINGS_INVALID_INPUT",
      "input must contain exactly the documented fields",
    );
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of ownKeys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable)
      return fail(
        "GEMINI_SETTINGS_INVALID_INPUT",
        "input fields must be enumerable data properties",
      );
    output[key] = descriptor.value;
  }
  return output;
}

function bytes(value: unknown): Uint8Array {
  if (
    typeof value !== "object" ||
    value === null ||
    nodeTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Uint8Array.prototype
  )
    return fail("GEMINI_SETTINGS_INVALID_INPUT", "settings bytes must be a plain Uint8Array");
  const copy = Uint8Array.prototype.slice.call(value) as Uint8Array;
  if (copy.byteLength > GEMINI_SETTINGS_LIMITS.maximumBytes)
    return fail("GEMINI_SETTINGS_RESOURCE_LIMIT", "settings input exceeds the byte limit");
  return copy;
}

function settingsPath(value: unknown): RepositoryRelativePath {
  if (typeof value !== "string" || value === "." || !isRepositoryRelativePath(value))
    return fail(
      "GEMINI_SETTINGS_INVALID_INPUT",
      "settings path must be a canonical repository file",
    );
  return value;
}

function issue(
  code: GeminiSettingsIssueCode,
  path: RepositoryRelativePath,
  setting: string,
  message: string,
  layer: GeminiSettingsLayerKind | null = null,
): GeminiSettingsIssue {
  return Object.freeze({ code, layer, message, path, setting });
}

function appendIssue(issues: GeminiSettingsIssue[], value: GeminiSettingsIssue): void {
  if (issues.length < GEMINI_SETTINGS_LIMITS.maximumIssues) issues.push(value);
}

function boundedString(
  value: unknown,
  path: RepositoryRelativePath,
  setting: string,
  issues: GeminiSettingsIssue[],
): string | null {
  if (typeof value !== "string" || value.trim() === "") {
    appendIssue(
      issues,
      issue("invalid-setting", path, setting, `${setting} must be a non-empty string`),
    );
    return null;
  }
  if (Buffer.byteLength(value, "utf8") > GEMINI_SETTINGS_LIMITS.maximumStringBytes) {
    appendIssue(
      issues,
      issue("resource-limit", path, setting, `${setting} exceeds its string limit`),
    );
    return null;
  }
  if (ENVIRONMENT_PLACEHOLDER.test(value)) {
    appendIssue(
      issues,
      issue(
        "environment-placeholder",
        path,
        setting,
        `${setting} contains an inert environment placeholder; ambient values were not read`,
      ),
    );
    return null;
  }
  return value;
}

function stringArray(
  value: unknown,
  path: RepositoryRelativePath,
  setting: string,
  maximum: number,
  issues: GeminiSettingsIssue[],
): readonly string[] | null {
  if (!Array.isArray(value) || nodeTypes.isProxy(value) || value.length > maximum) {
    appendIssue(
      issues,
      issue("invalid-setting", path, setting, `${setting} must be a bounded string array`),
    );
    return null;
  }
  const result: string[] = [];
  for (const [index, entry] of value.entries()) {
    const parsed = boundedString(entry, path, `${setting}[${String(index)}]`, issues);
    if (parsed !== null) result.push(parsed);
  }
  return Object.freeze(result);
}

function safeFileName(name: string): boolean {
  return (
    name !== "." &&
    name !== ".." &&
    !name.includes("/") &&
    !name.includes("\\") &&
    !name.includes("\0")
  );
}

function safeMarker(name: string): boolean {
  return (
    !name.startsWith("/") &&
    !name.includes("\\") &&
    !name.includes("\0") &&
    name.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

function parseValues(root: unknown, path: RepositoryRelativePath): GeminiSettingsParseResult {
  const issues: GeminiSettingsIssue[] = [];
  const values: MutableGeminiSettingsValues = {};
  if (!plainRecord(root)) {
    return Object.freeze({
      contractVersion: GEMINI_SETTINGS_CONTRACT_VERSION,
      issues: Object.freeze([
        issue("invalid-setting", path, "$", "settings root must be an object"),
      ]),
      path,
      state: "malformed" as const,
      values: Object.freeze(values),
    });
  }
  const context = root["context"];
  if (context === undefined) {
    return Object.freeze({
      contractVersion: GEMINI_SETTINGS_CONTRACT_VERSION,
      issues: Object.freeze([]),
      path,
      state: "complete" as const,
      values: Object.freeze(values),
    });
  }
  if (!plainRecord(context)) {
    appendIssue(issues, issue("invalid-setting", path, "context", "context must be an object"));
  } else {
    for (const key of Object.keys(context)) {
      if (!CONTEXT_KEYS.has(key))
        appendIssue(
          issues,
          issue("unknown-context-setting", path, `context.${key}`, "setting is not modeled by D10"),
        );
    }
    const rawFileName = context["fileName"];
    if (rawFileName !== undefined) {
      const names =
        typeof rawFileName === "string"
          ? [boundedString(rawFileName, path, "context.fileName", issues)].filter(
              (entry): entry is string => entry !== null,
            )
          : stringArray(
              rawFileName,
              path,
              "context.fileName",
              GEMINI_SETTINGS_LIMITS.maximumFileNames,
              issues,
            );
      if (names !== null) {
        const safe = names.filter((name) => {
          if (safeFileName(name)) return true;
          appendIssue(
            issues,
            issue("unsafe-path", path, "context.fileName", `unsafe context filename ${name}`),
          );
          return false;
        });
        values.fileNames = Object.freeze(
          [...new Set(safe), "GEMINI.md"].filter((name, index, all) => all.indexOf(name) === index),
        );
      }
    }
    const includes = context["includeDirectories"];
    if (includes !== undefined) {
      const parsed = stringArray(
        includes,
        path,
        "context.includeDirectories",
        GEMINI_SETTINGS_LIMITS.maximumIncludeDirectories,
        issues,
      );
      if (parsed !== null) {
        values.includeDirectories = Object.freeze(
          parsed.flatMap((directory) => {
            if (directory !== "." && isRepositoryRelativePath(directory)) return [directory];
            appendIssue(
              issues,
              issue(
                "unsafe-path",
                path,
                "context.includeDirectories",
                `include root ${directory} is outside the repository-only model`,
              ),
            );
            return [];
          }),
        );
      }
    }
    const markers = context["memoryBoundaryMarkers"];
    if (markers !== undefined) {
      const parsed = stringArray(
        markers,
        path,
        "context.memoryBoundaryMarkers",
        GEMINI_SETTINGS_LIMITS.maximumMarkerCount,
        issues,
      );
      if (parsed !== null) {
        values.memoryBoundaryMarkers = Object.freeze(
          parsed.filter((marker) => {
            if (safeMarker(marker)) return true;
            appendIssue(
              issues,
              issue(
                "unsafe-path",
                path,
                "context.memoryBoundaryMarkers",
                `unsafe boundary marker ${marker}`,
              ),
            );
            return false;
          }),
        );
      }
    }
    for (const key of ["loadMemoryFromIncludeDirectories"] as const) {
      if (context[key] === undefined) continue;
      if (typeof context[key] === "boolean") values[key] = context[key];
      else
        appendIssue(
          issues,
          issue("invalid-setting", path, `context.${key}`, `context.${key} must be boolean`),
        );
    }
    if (context["discoveryMaxDirs"] !== undefined) {
      const value = context["discoveryMaxDirs"];
      if (Number.isSafeInteger(value) && (value as number) >= 0)
        values.discoveryMaxDirs = value as number;
      else
        appendIssue(
          issues,
          issue(
            "invalid-setting",
            path,
            "context.discoveryMaxDirs",
            "context.discoveryMaxDirs must be a non-negative integer",
          ),
        );
    }
    if (context["importFormat"] !== undefined) {
      if (context["importFormat"] === "tree" || context["importFormat"] === "flat")
        values.importFormat = context["importFormat"];
      else
        appendIssue(
          issues,
          issue(
            "invalid-setting",
            path,
            "context.importFormat",
            "context.importFormat must be tree or flat",
          ),
        );
    }
    const filtering = context["fileFiltering"];
    if (filtering !== undefined) {
      if (!plainRecord(filtering)) {
        appendIssue(
          issues,
          issue(
            "invalid-setting",
            path,
            "context.fileFiltering",
            "context.fileFiltering must be an object",
          ),
        );
      } else {
        for (const [key, target] of [
          ["respectGitIgnore", "respectGitIgnore"],
          ["respectGeminiIgnore", "respectGeminiIgnore"],
        ] as const) {
          if (filtering[key] === undefined) continue;
          if (typeof filtering[key] === "boolean") values[target] = filtering[key];
          else
            appendIssue(
              issues,
              issue(
                "invalid-setting",
                path,
                `context.fileFiltering.${key}`,
                `context.fileFiltering.${key} must be boolean`,
              ),
            );
        }
      }
    }
  }
  return Object.freeze({
    contractVersion: GEMINI_SETTINGS_CONTRACT_VERSION,
    issues: Object.freeze(issues.slice(0, GEMINI_SETTINGS_LIMITS.maximumIssues)),
    path,
    state: issues.length === 0 ? "complete" : "partial",
    values: Object.freeze(values),
  });
}

/** Parse one explicit settings.json byte snapshot without reading environment or filesystem state. */
export function parseGeminiSettings(
  inputValue: ParseGeminiSettingsInput,
): GeminiSettingsParseResult {
  const input = closedRecord(inputValue, INPUT_KEYS);
  const path = settingsPath(input["path"]);
  const content = bytes(input["bytes"]);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    return Object.freeze({
      contractVersion: GEMINI_SETTINGS_CONTRACT_VERSION,
      issues: Object.freeze([
        issue("invalid-json", path, "$", "settings must be valid UTF-8 JSON"),
      ]),
      path,
      state: "malformed" as const,
      values: Object.freeze({}),
    });
  }
  const syntax = parseDocument(text, {
    prettyErrors: false,
    schema: "json",
    strict: true,
    uniqueKeys: true,
  });
  if (syntax.errors.length > 0 || !isMap(syntax.contents)) {
    const duplicate = syntax.errors.some((error) => error.code === "DUPLICATE_KEY");
    return Object.freeze({
      contractVersion: GEMINI_SETTINGS_CONTRACT_VERSION,
      issues: Object.freeze([
        issue(
          duplicate ? "duplicate-key" : "invalid-json",
          path,
          "$",
          duplicate
            ? "settings contain a duplicate key"
            : "settings are not valid JSON object syntax",
        ),
      ]),
      path,
      state: "malformed" as const,
      values: Object.freeze({}),
    });
  }
  let root: unknown;
  try {
    root = JSON.parse(text) as unknown;
  } catch {
    return Object.freeze({
      contractVersion: GEMINI_SETTINGS_CONTRACT_VERSION,
      issues: Object.freeze([issue("invalid-json", path, "$", "settings are not valid JSON")]),
      path,
      state: "malformed" as const,
      values: Object.freeze({}),
    });
  }
  return parseValues(root, path);
}

/** Apply explicit settings snapshots in Gemini's persistent-layer order; no ambient layer is read. */
export function mergeGeminiSettingsLayers(
  layersValue: readonly GeminiSettingsLayerInput[],
): GeminiSettingsMergeResult {
  if (
    !Array.isArray(layersValue) ||
    nodeTypes.isProxy(layersValue) ||
    layersValue.length > GEMINI_SETTINGS_LIMITS.maximumLayers
  )
    return fail("GEMINI_SETTINGS_RESOURCE_LIMIT", "settings layers must be a bounded array");
  const order = new Map<GeminiSettingsLayerKind, number>([
    ["defaults", 0],
    ["system-defaults", 1],
    ["user", 2],
    ["workspace", 3],
    ["system-override", 4],
  ]);
  let previous = -1;
  const issues: GeminiSettingsIssue[] = [];
  const applied: GeminiSettingsLayerKind[] = [];
  const values: MutableRequiredGeminiSettingsValues = {
    ...GEMINI_SETTINGS_DEFAULTS,
    fileNames: [...GEMINI_SETTINGS_DEFAULTS.fileNames],
    includeDirectories: [],
    memoryBoundaryMarkers: [...GEMINI_SETTINGS_DEFAULTS.memoryBoundaryMarkers],
  };
  for (const rawLayer of layersValue) {
    const layer = closedRecord(rawLayer, LAYER_KEYS);
    const kind = layer["kind"];
    const trustState = layer["trustState"];
    if (typeof kind !== "string" || !LAYER_KINDS.has(kind as GeminiSettingsLayerKind))
      return fail("GEMINI_SETTINGS_INVALID_INPUT", "settings layer kind is invalid");
    const layerKind = kind as GeminiSettingsLayerKind;
    const position = order.get(layerKind) ?? -1;
    if (position < previous)
      return fail("GEMINI_SETTINGS_INVALID_INPUT", "settings layers are out of order");
    previous = position;
    if (!(["trusted", "untrusted", "not-applicable"] as const).includes(trustState as never))
      return fail("GEMINI_SETTINGS_INVALID_INPUT", "settings layer trustState is invalid");
    const parsed = parseGeminiSettings({
      bytes: layer["bytes"] as Uint8Array,
      path: layer["path"] as RepositoryRelativePath,
    });
    if (layerKind === "workspace" && trustState !== "trusted") {
      appendIssue(
        issues,
        issue(
          "untrusted-workspace-layer",
          parsed.path,
          "$",
          "untrusted workspace settings were not applied",
          layerKind,
        ),
      );
      continue;
    }
    for (const entry of parsed.issues)
      appendIssue(issues, Object.freeze({ ...entry, layer: layerKind }));
    if (parsed.state === "malformed") continue;
    applied.push(layerKind);
    const candidate = parsed.values;
    if (candidate.fileNames !== undefined) values.fileNames = [...candidate.fileNames];
    if (candidate.includeDirectories !== undefined)
      values.includeDirectories = [...values.includeDirectories, ...candidate.includeDirectories];
    for (const key of [
      "discoveryMaxDirs",
      "importFormat",
      "loadMemoryFromIncludeDirectories",
      "memoryBoundaryMarkers",
      "respectGeminiIgnore",
      "respectGitIgnore",
    ] as const) {
      if (candidate[key] !== undefined) (values as Record<string, unknown>)[key] = candidate[key];
    }
  }
  return Object.freeze({
    contractVersion: GEMINI_SETTINGS_CONTRACT_VERSION,
    issues: Object.freeze(issues.slice(0, GEMINI_SETTINGS_LIMITS.maximumIssues)),
    layersApplied: Object.freeze(applied),
    state: issues.length === 0 ? "complete" : "partial",
    values: Object.freeze({
      ...values,
      fileNames: Object.freeze(values.fileNames),
      includeDirectories: Object.freeze([...new Set(values.includeDirectories)]),
      memoryBoundaryMarkers: Object.freeze(values.memoryBoundaryMarkers),
    }),
  });
}
