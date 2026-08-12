import { createHash } from "node:crypto";

import { PATH_FINGERPRINT_METHOD, SEMANTIC_FINGERPRINT_METHOD } from "./diagnostic-contracts.js";
import { isRepositoryRelativePath } from "./repository-path.js";

import type {
  DiagnosticFingerprint,
  FingerprintComponent,
  PathFingerprintBasis,
  SemanticFingerprintBasis,
} from "./diagnostic-contracts.js";
import type { RepositoryRelativePath } from "./repository-path.js";

const WELL_FORMED_IDENTIFIER = /^[A-Za-z0-9]+(?:[._:/-][A-Za-z0-9]+)*$/;

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

function assertText(value: string, name: string): void {
  if (value.length === 0 || !hasWellFormedUnicode(value))
    throw new TypeError(`${name} must be non-empty well-formed Unicode`);
}

function frame(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  return Buffer.concat([length, bytes]);
}

function hashDomain(
  method: string,
  fields: readonly (readonly [string, string])[],
): DiagnosticFingerprint {
  const hash = createHash("sha256");
  hash.update(frame("agent-context-lint:diagnostic-fingerprint"));
  hash.update(frame(method));
  for (const [name, value] of fields) {
    hash.update(frame(name));
    hash.update(frame(value));
  }
  return hash.digest("hex") as DiagnosticFingerprint;
}

function canonicalProfiles(profileIds: readonly string[]): readonly string[] {
  for (const profileId of profileIds) {
    assertText(profileId, "profile ID");
    if (!WELL_FORMED_IDENTIFIER.test(profileId)) throw new TypeError("profile ID must be stable");
  }
  return [...new Set(profileIds)].sort((left, right) =>
    Buffer.compare(Buffer.from(left), Buffer.from(right)),
  );
}

function canonicalComponents(
  components: readonly FingerprintComponent[],
): readonly FingerprintComponent[] {
  const byKey = new Map<string, string>();
  for (const component of components) {
    assertText(component.key, "fingerprint component key");
    assertText(component.value, "fingerprint component value");
    if (!WELL_FORMED_IDENTIFIER.test(component.key))
      throw new TypeError("fingerprint component key must be stable");
    if (byKey.has(component.key))
      throw new TypeError(`duplicate fingerprint component '${component.key}'`);
    byKey.set(component.key, component.value);
  }
  return [...byKey]
    .map(([key, value]) => ({ key, value }))
    .sort((left, right) => Buffer.compare(Buffer.from(left.key), Buffer.from(right.key)));
}

function assertRule(ruleId: string, ruleVersion: string): void {
  assertText(ruleId, "rule ID");
  assertText(ruleVersion, "rule version");
  if (!WELL_FORMED_IDENTIFIER.test(ruleId) || !WELL_FORMED_IDENTIFIER.test(ruleVersion)) {
    throw new TypeError("rule ID and version must be stable identifiers");
  }
}

/** Path-sensitive stable identity. Absolute roots and source coordinates are intentionally absent. */
export function computePathFingerprint(input: {
  readonly ruleId: string;
  readonly ruleVersion: string;
  readonly path: RepositoryRelativePath;
  readonly basis: PathFingerprintBasis;
}): DiagnosticFingerprint {
  assertRule(input.ruleId, input.ruleVersion);
  if (!isRepositoryRelativePath(input.path))
    throw new TypeError("path must be canonical repository-relative");
  assertText(input.basis.anchor, "path fingerprint anchor");
  const fields: [string, string][] = [
    ["rule-id", input.ruleId],
    ["rule-version", input.ruleVersion],
    ["repository-path", input.path],
    ["anchor", input.basis.anchor],
  ];
  for (const profileId of canonicalProfiles(input.basis.profileIds))
    fields.push(["profile-id", profileId]);
  return hashDomain(PATH_FINGERPRINT_METHOD, fields);
}

/** Path-independent logical identity suitable for correlating a diagnostic after a document move. */
export function computeSemanticFingerprint(input: {
  readonly ruleId: string;
  readonly ruleVersion: string;
  readonly basis: SemanticFingerprintBasis;
}): DiagnosticFingerprint {
  assertRule(input.ruleId, input.ruleVersion);
  const fields: [string, string][] = [
    ["rule-id", input.ruleId],
    ["rule-version", input.ruleVersion],
  ];
  for (const profileId of canonicalProfiles(input.basis.profileIds))
    fields.push(["profile-id", profileId]);
  for (const component of canonicalComponents(input.basis.components)) {
    fields.push([`component:${component.key}`, component.value]);
  }
  return hashDomain(SEMANTIC_FINGERPRINT_METHOD, fields);
}
