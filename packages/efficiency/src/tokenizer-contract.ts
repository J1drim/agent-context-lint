import { Buffer } from "node:buffer";
import { types as nodeTypes } from "node:util";

export const TOKENIZER_PLUGIN_CONTRACT_VERSION = "1.0.0" as const;
export const TOKENIZER_MEASUREMENTS = ["exact", "estimate"] as const;
export const MAX_TOKENIZER_ID_BYTES = 128 as const;
export const MAX_TOKENIZER_VERSION_BYTES = 128 as const;
export const MAX_TOKENIZER_INPUT_BYTES = 16_777_216 as const;
export const BUILTIN_ESTIMATE_PROVIDER_ID = "builtin:deterministic-estimate" as const;
export const OPTIONAL_UTF8_BYTE_PROVIDER_ID = "optional:utf8-byte" as const;

export type TokenizerMeasurement = (typeof TOKENIZER_MEASUREMENTS)[number];

export interface TokenizerIdentity {
  readonly id: string;
  readonly measurement: TokenizerMeasurement;
  readonly version: string;
}

/**
 * Data-only metadata selected from the engine's closed provider registry. It deliberately contains
 * no module path, command, callback, environment, or capability-bearing field.
 */
export interface ResolvedTokenizerProvider {
  readonly contractVersion: typeof TOKENIZER_PLUGIN_CONTRACT_VERSION;
  readonly execution: "builtin" | "isolated";
  readonly identity: TokenizerIdentity;
  readonly providerId: string;
}

export type TokenizerContractIssueCode =
  | "incompatible-id"
  | "incompatible-measurement"
  | "incompatible-version"
  | "input-limit"
  | "invalid-identity"
  | "invalid-input"
  | "invalid-provider-id"
  | "unsupported-provider";

export interface TokenizerContractIssue {
  readonly code: TokenizerContractIssueCode;
  readonly message: string;
  readonly path: string;
}

export interface TokenCount {
  readonly contractVersion: typeof TOKENIZER_PLUGIN_CONTRACT_VERSION;
  readonly identity: TokenizerIdentity;
  readonly inputCodeUnits: number;
  readonly inputUtf8Bytes: number;
  readonly tokens: number;
}

export type TokenizerProviderResolution =
  | { readonly ok: true; readonly value: ResolvedTokenizerProvider }
  | { readonly issues: readonly TokenizerContractIssue[]; readonly ok: false };

export type TokenizerIdentityValidationResult =
  | { readonly ok: true; readonly value: TokenizerIdentity }
  | { readonly issues: readonly TokenizerContractIssue[]; readonly ok: false };

export type TokenizerComparisonCompatibility =
  | {
      readonly compatible: true;
      readonly identity: TokenizerIdentity;
      readonly key: string;
    }
  | {
      readonly compatible: false;
      readonly issues: readonly TokenizerContractIssue[];
    };

const IDENTIFIER = /^[A-Za-z0-9]+(?:[._:/-][A-Za-z0-9]+)*$/u;
const VERSION = /^[A-Za-z0-9]+(?:[._+:/-][A-Za-z0-9]+)*$/u;

function issue(
  code: TokenizerContractIssueCode,
  path: string,
  message: string,
): TokenizerContractIssue {
  return Object.freeze({ code, message, path });
}

function failure(
  code: TokenizerContractIssueCode,
  path: string,
  message: string,
): { readonly issues: readonly TokenizerContractIssue[]; readonly ok: false } {
  return Object.freeze({ issues: Object.freeze([issue(code, path, message)]), ok: false });
}

function ownData(
  value: unknown,
  allowedKeys: readonly string[],
): ReadonlyMap<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || nodeTypes.isProxy(value)) {
    return undefined;
  }
  let prototype: object | null;
  let keys: readonly PropertyKey[];
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
    keys = Reflect.ownKeys(value);
  } catch {
    return undefined;
  }
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    keys.length !== allowedKeys.length ||
    keys.some((key) => typeof key !== "string" || !allowedKeys.includes(key))
  ) {
    return undefined;
  }
  const fields = new Map<string, unknown>();
  for (const key of keys) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      return undefined;
    }
    if (descriptor === undefined || !("value" in descriptor)) return undefined;
    fields.set(key as string, descriptor.value as unknown);
  }
  return fields;
}

function boundedToken(value: unknown, maximumBytes: number, pattern: RegExp): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumBytes &&
    Buffer.byteLength(value, "utf8") <= maximumBytes &&
    pattern.test(value)
  );
}

/** Validate and defensively snapshot the identity embedded in every efficiency result. */
export function validateTokenizerIdentity(value: unknown): TokenizerIdentityValidationResult {
  const fields = ownData(value, ["id", "measurement", "version"]);
  if (fields === undefined) {
    return failure(
      "invalid-identity",
      "$identity",
      "tokenizer identity must be a closed, non-proxy plain data object",
    );
  }
  const id = fields.get("id");
  const measurement = fields.get("measurement");
  const version = fields.get("version");
  if (!boundedToken(id, MAX_TOKENIZER_ID_BYTES, IDENTIFIER)) {
    return failure(
      "invalid-identity",
      "$identity.id",
      "tokenizer id must be a bounded canonical identifier",
    );
  }
  if (!TOKENIZER_MEASUREMENTS.includes(measurement as TokenizerMeasurement)) {
    return failure(
      "invalid-identity",
      "$identity.measurement",
      "tokenizer measurement must be exact or estimate",
    );
  }
  if (!boundedToken(version, MAX_TOKENIZER_VERSION_BYTES, VERSION)) {
    return failure(
      "invalid-identity",
      "$identity.version",
      "tokenizer version must be a bounded canonical version identity",
    );
  }
  return Object.freeze({
    ok: true,
    value: Object.freeze({ id, measurement: measurement as TokenizerMeasurement, version }),
  });
}

/** A length-prefixed comparison key; it is serialization-safe and cannot have delimiter collisions. */
function tokenizerIdentityKey(value: TokenizerIdentity): string {
  return `${String(value.measurement.length)}:${value.measurement}${String(value.id.length)}:${value.id}${String(value.version.length)}:${value.version}`;
}

export const BUILTIN_ESTIMATE_IDENTITY: TokenizerIdentity = Object.freeze({
  id: "agent-context-estimate",
  measurement: "estimate",
  version: "1.0.0",
});

export const OPTIONAL_UTF8_BYTE_IDENTITY: TokenizerIdentity = Object.freeze({
  id: "utf8.byte",
  measurement: "exact",
  version: "1.0.0",
});

const BUILTIN_ESTIMATE_PROVIDER: ResolvedTokenizerProvider = Object.freeze({
  contractVersion: TOKENIZER_PLUGIN_CONTRACT_VERSION,
  execution: "builtin",
  identity: BUILTIN_ESTIMATE_IDENTITY,
  providerId: BUILTIN_ESTIMATE_PROVIDER_ID,
});

const OPTIONAL_UTF8_BYTE_PROVIDER: ResolvedTokenizerProvider = Object.freeze({
  contractVersion: TOKENIZER_PLUGIN_CONTRACT_VERSION,
  execution: "isolated",
  identity: OPTIONAL_UTF8_BYTE_IDENTITY,
  providerId: OPTIONAL_UTF8_BYTE_PROVIDER_ID,
});

/**
 * Resolve a provider only through the engine-owned closed registry. Repository/configuration data
 * cannot register callbacks or self-assert an exact identity. G10 may extend this registry only
 * with release-owned isolated providers after its isolation and conformance gates pass.
 */
export function resolveTokenizerProvider(providerId: unknown): TokenizerProviderResolution {
  if (!boundedToken(providerId, MAX_TOKENIZER_ID_BYTES, IDENTIFIER)) {
    return failure(
      "invalid-provider-id",
      "$providerId",
      "tokenizer provider id must be a bounded canonical identifier",
    );
  }
  if (providerId === BUILTIN_ESTIMATE_PROVIDER_ID) {
    return Object.freeze({ ok: true, value: BUILTIN_ESTIMATE_PROVIDER });
  }
  if (providerId === OPTIONAL_UTF8_BYTE_PROVIDER_ID) {
    return Object.freeze({ ok: true, value: OPTIONAL_UTF8_BYTE_PROVIDER });
  }
  return failure(
    "unsupported-provider",
    "$providerId",
    "tokenizer provider is not present in the engine-owned registry",
  );
}

/**
 * Token counts may be compared only when measurement kind, algorithm id, and version all match.
 * A mismatch is data, not an exception, so report generation can explain why comparison stopped.
 */
export function compareTokenizerIdentities(
  leftInput: unknown,
  rightInput: unknown,
): TokenizerComparisonCompatibility {
  const left = validateTokenizerIdentity(leftInput);
  if (!left.ok) {
    return Object.freeze({
      compatible: false,
      issues: Object.freeze(
        left.issues.map((entry) =>
          Object.freeze({ ...entry, path: `$left${entry.path.slice(9)}` }),
        ),
      ),
    });
  }
  const right = validateTokenizerIdentity(rightInput);
  if (!right.ok) {
    return Object.freeze({
      compatible: false,
      issues: Object.freeze(
        right.issues.map((entry) =>
          Object.freeze({ ...entry, path: `$right${entry.path.slice(9)}` }),
        ),
      ),
    });
  }
  if (left.value.measurement !== right.value.measurement) {
    return Object.freeze({
      compatible: false,
      issues: Object.freeze([
        issue(
          "incompatible-measurement",
          "$comparison.measurement",
          "exact and estimate token counts are not comparable",
        ),
      ]),
    });
  }
  if (left.value.id !== right.value.id) {
    return Object.freeze({
      compatible: false,
      issues: Object.freeze([
        issue(
          "incompatible-id",
          "$comparison.id",
          "token counts from different tokenizer algorithms are not comparable",
        ),
      ]),
    });
  }
  if (left.value.version !== right.value.version) {
    return Object.freeze({
      compatible: false,
      issues: Object.freeze([
        issue(
          "incompatible-version",
          "$comparison.version",
          "token counts from different tokenizer versions are not comparable",
        ),
      ]),
    });
  }
  return Object.freeze({
    compatible: true,
    identity: left.value,
    key: tokenizerIdentityKey(left.value),
  });
}
