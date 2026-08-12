import { isRepositoryRelativePath } from "./repository-path.js";

import type { SarifArtifactUri } from "./output-contracts.js";
import type { RepositoryRelativePath } from "./repository-path.js";

export const OUTPUT_REDACTION_MARKER = "REDACTED" as const;

const SECRET_PATTERNS: readonly RegExp[] = [
  /(?:AGENT_CONTEXT_)?SECRET_CANARY(?:_[A-Za-z0-9-]+)*/giu,
  /github_pat_[A-Za-z0-9_]{20,}/gu,
  /gh[pousr]_[A-Za-z0-9]{20,}/gu,
  /glpat-[A-Za-z0-9_-]{20,}/gu,
  /AKIA[0-9A-Z]{16}/gu,
  /AIza[0-9A-Za-z_-]{35}/gu,
  /sk-[A-Za-z0-9_-]{20,}/gu,
  /sk_live_[A-Za-z0-9]{20,}/gu,
  /xox[baprs]-[A-Za-z0-9-]{20,}/gu,
  /((?:api[_-]?key|password|secret|token)[ \t]*[:=][ \t]*)[^ \t,;]+/giu,
  /(https:\/\/[^\s/:@]+:)[^\s/@]+@/giu,
];

function isBidiControl(unit: number): boolean {
  return (
    unit === 0x061c ||
    unit === 0x200e ||
    unit === 0x200f ||
    (unit >= 0x202a && unit <= 0x202e) ||
    (unit >= 0x2066 && unit <= 0x2069)
  );
}

function inertControls(value: string): string {
  let output = "";
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit === 0x1b) {
      // Caller-provided escape state is never trusted. Consume a complete CSI SGR sequence when
      // recognizable; every other escape byte becomes inert replacement text.
      if (value.charCodeAt(index + 1) === 0x5b) {
        let cursor = index + 2;
        while (cursor < value.length) {
          const candidate = value.charCodeAt(cursor);
          if (candidate === 0x6d) {
            index = cursor;
            break;
          }
          if (!((candidate >= 0x30 && candidate <= 0x39) || candidate === 0x3b)) break;
          cursor += 1;
        }
        if (index === cursor) continue;
      }
      output += "�";
      continue;
    }
    if (unit <= 0x1f || (unit >= 0x7f && unit <= 0x9f) || isBidiControl(unit)) {
      output += "�";
      continue;
    }
    output += value.charAt(index);
  }
  return output;
}

/** Convert repository-controlled text into inert, deterministic, secret-redacted output text. */
export function sanitizeOutputText(value: string): string {
  let output = inertControls(value);
  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern, (_match, prefix: unknown) =>
      typeof prefix === "string" && prefix.length > 0
        ? `${prefix}${OUTPUT_REDACTION_MARKER}`
        : OUTPUT_REDACTION_MARKER,
    );
  }
  return output;
}

function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(
    /[!'()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Encode a validated repository-relative path as a canonical relative SARIF URI. */
export function encodeSarifArtifactUri(path: string): SarifArtifactUri | undefined {
  if (!isRepositoryRelativePath(path)) return undefined;
  try {
    return path.split("/").map(encodeSegment).join("/") as SarifArtifactUri;
  } catch {
    return undefined;
  }
}

/** Decode only the exact canonical encoding produced by `encodeSarifArtifactUri`. */
export function decodeSarifArtifactUri(uri: string): RepositoryRelativePath | undefined {
  if (
    uri.length === 0 ||
    uri.includes("?") ||
    uri.includes("#") ||
    !/^(?:[A-Za-z0-9._~-]|%[0-9A-F]{2})+(?:\/(?:[A-Za-z0-9._~-]|%[0-9A-F]{2})+)*$/u.test(uri)
  ) {
    return undefined;
  }
  try {
    const decoded = decodeURIComponent(uri);
    const encoded = encodeSarifArtifactUri(decoded);
    return encoded === uri ? (decoded as RepositoryRelativePath) : undefined;
  } catch {
    return undefined;
  }
}

/** Sanitize every string value in an already validated plain JSON tree. */
export function sanitizeOutputJson(value: unknown): unknown {
  if (typeof value === "string") return sanitizeOutputText(value);
  if (Array.isArray(value)) return value.map(sanitizeOutputJson);
  if (value !== null && typeof value === "object") {
    const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value)) {
      const baseKey = sanitizeOutputText(key);
      let sanitizedKey = baseKey;
      let collision = 2;
      while (Object.hasOwn(output, sanitizedKey)) {
        sanitizedKey = `${baseKey}-${String(collision)}`;
        collision += 1;
      }
      output[sanitizedKey] = sanitizeOutputJson((value as Record<string, unknown>)[key]);
    }
    return output;
  }
  return value;
}
