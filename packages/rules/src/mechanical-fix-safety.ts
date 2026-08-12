import { types as nodeTypes } from "node:util";

import {
  MECHANICAL_FIX_SAFETY_DATA,
  renderMechanicalFixSafetyDataMarkdown,
} from "./mechanical-fix-safety-data.js";
import { REQUIRED_RULE_IDS, findRuleMetadata } from "./registry.js";

import type { RuleId } from "./registry.js";

export const MECHANICAL_FIX_SAFETY_CONTRACT_VERSION = "0.1.0" as const;
export const MECHANICAL_FIX_SAFETY_REASONS = [
  "approved-exact-unused-suppression",
  "ambiguous-or-subjective",
  "changes-policy-semantics",
  "multi-file-or-unsupported-operation",
  "profile-or-version-dependent",
  "security-sensitive",
  "standards-operation-required",
  "efficiency-recommendation-only",
  "source-token-not-proven",
] as const;

export type MechanicalFixSafetyReason = (typeof MECHANICAL_FIX_SAFETY_REASONS)[number];
export type MechanicalFixSafetyDecision = "approved" | "refused";

export interface MechanicalFixSafetyRule {
  readonly decision: MechanicalFixSafetyDecision;
  readonly proof: string;
  readonly reason: MechanicalFixSafetyReason;
  readonly ruleId: RuleId;
}

export interface MechanicalFixSafetyMatrix {
  readonly contractVersion: typeof MECHANICAL_FIX_SAFETY_CONTRACT_VERSION;
  readonly recordKind: "agent-context-mechanical-fix-safety";
  readonly rules: readonly MechanicalFixSafetyRule[];
}

export interface MechanicalFixSafetyValidationIssue {
  readonly code:
    "invalid-input" | "invalid-order" | "invalid-value" | "missing-field" | "unknown-field";
  readonly message: string;
  readonly path: string;
}

export interface MechanicalFixSafetyValidationResult {
  readonly issues: readonly MechanicalFixSafetyValidationIssue[];
  readonly valid: boolean;
}

const canonicalRules: readonly MechanicalFixSafetyRule[] = MECHANICAL_FIX_SAFETY_DATA.rules;

const ROOT_FIELDS = ["contractVersion", "recordKind", "rules"] as const;
const RULE_FIELDS = ["decision", "proof", "reason", "ruleId"] as const;
const MAX_VALIDATION_ISSUES = 128;

function ownData(
  value: unknown,
  allowed: readonly string[],
  path: string,
  report: (issue: MechanicalFixSafetyValidationIssue) => void,
): Readonly<Record<string, unknown>> | undefined {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    nodeTypes.isProxy(value)
  ) {
    report({ code: "invalid-input", message: "must be a plain data object", path });
    return undefined;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    report({ code: "invalid-input", message: "must be a plain data object", path });
    return undefined;
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const allowedSet = new Set(allowed);
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string" || !allowedSet.has(key)) {
      report({ code: "unknown-field", message: "is not part of the closed contract", path });
      continue;
    }
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
      report({
        code: "invalid-input",
        message: "must be an enumerable data field",
        path: `${path}.${key}`,
      });
      continue;
    }
    output[key] = descriptor.value;
  }
  for (const key of allowed)
    if (!Object.hasOwn(output, key))
      report({ code: "missing-field", message: "is required", path: `${path}.${key}` });
  return output;
}

function denseRules(
  value: unknown,
  report: (issue: MechanicalFixSafetyValidationIssue) => void,
): readonly unknown[] | undefined {
  if (
    !Array.isArray(value) ||
    nodeTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  ) {
    report({ code: "invalid-input", message: "must be a dense intrinsic array", path: "$.rules" });
    return undefined;
  }
  if (value.length !== REQUIRED_RULE_IDS.length)
    report({
      code: "invalid-value",
      message: `must contain exactly ${String(REQUIRED_RULE_IDS.length)} rules`,
      path: "$.rules",
    });
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1)
    report({
      code: "invalid-input",
      message: "must not contain holes or extra fields",
      path: "$.rules",
    });
  const output: unknown[] = [];
  for (let index = 0; index < Math.min(value.length, REQUIRED_RULE_IDS.length); index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
      report({
        code: "invalid-input",
        message: "must be an own data item",
        path: `$.rules[${String(index)}]`,
      });
      output.push(undefined);
    } else output.push(descriptor.value);
  }
  return output;
}

function unicodeScalarLength(value: string): number | undefined {
  let scalarCount = 0;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return undefined;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return undefined;
    scalarCount += 1;
  }
  return scalarCount;
}

export function validateMechanicalFixSafetyMatrix(
  value: unknown,
): MechanicalFixSafetyValidationResult {
  const issues: MechanicalFixSafetyValidationIssue[] = [];
  const report = (issue: MechanicalFixSafetyValidationIssue): void => {
    if (issues.length < MAX_VALIDATION_ISSUES) issues.push(Object.freeze(issue));
  };
  try {
    const root = ownData(value, ROOT_FIELDS, "$", report);
    if (root !== undefined) {
      if (root["recordKind"] !== "agent-context-mechanical-fix-safety")
        report({
          code: "invalid-value",
          message: "has the wrong record kind",
          path: "$.recordKind",
        });
      if (root["contractVersion"] !== MECHANICAL_FIX_SAFETY_CONTRACT_VERSION)
        report({
          code: "invalid-value",
          message: "has the wrong contract version",
          path: "$.contractVersion",
        });
      const values = denseRules(root["rules"], report) ?? [];
      for (const [index, expectedRuleId] of REQUIRED_RULE_IDS.entries()) {
        const path = `$.rules[${String(index)}]`;
        const rule = ownData(values[index], RULE_FIELDS, path, report);
        if (rule === undefined) continue;
        if (rule["ruleId"] !== expectedRuleId)
          report({
            code: "invalid-order",
            message: `must be the exact required rule ${expectedRuleId}`,
            path: `${path}.ruleId`,
          });
        const canonical = canonicalRules[index];
        if (canonical === undefined) {
          report({
            code: "invalid-value",
            message: "canonical reviewed data is incomplete",
            path,
          });
          continue;
        }
        if (rule["decision"] !== canonical.decision)
          report({
            code: "invalid-value",
            message: "does not match the reviewed decision",
            path: `${path}.decision`,
          });
        if (rule["reason"] !== canonical.reason)
          report({
            code: "invalid-value",
            message: "does not match the reviewed reason",
            path: `${path}.reason`,
          });
        const proof = rule["proof"];
        const scalarLength = typeof proof === "string" ? unicodeScalarLength(proof) : undefined;
        if (proof !== canonical.proof)
          report({
            code: "invalid-value",
            message: "does not match the reviewed per-rule proof",
            path: `${path}.proof`,
          });
        if (
          typeof proof !== "string" ||
          scalarLength === undefined ||
          scalarLength === 0 ||
          scalarLength > 1_024 ||
          Buffer.byteLength(proof, "utf8") > 4_096
        )
          report({
            code: "invalid-value",
            message: "must be bounded well-formed Unicode",
            path: `${path}.proof`,
          });
      }
    }
  } catch {
    report({ code: "invalid-input", message: "could not be inspected safely", path: "$" });
  }
  return Object.freeze({ issues: Object.freeze(issues), valid: issues.length === 0 });
}

export function isMechanicalFixSafetyMatrix(value: unknown): value is MechanicalFixSafetyMatrix {
  return validateMechanicalFixSafetyMatrix(value).valid;
}

export function renderMechanicalFixSafetyMarkdown(): string {
  return renderMechanicalFixSafetyDataMarkdown();
}

const rules = canonicalRules.map((rule) => Object.freeze({ ...rule }));
for (const rule of rules) {
  const metadata = findRuleMetadata(rule.ruleId);
  if (
    metadata === undefined ||
    (rule.decision === "approved") !== (metadata.fixSafety === "mechanical")
  )
    throw new TypeError(`I12 safety matrix and registry disagree for ${rule.ruleId}`);
}

export const MECHANICAL_FIX_SAFETY_MATRIX: MechanicalFixSafetyMatrix = Object.freeze({
  contractVersion: MECHANICAL_FIX_SAFETY_DATA.contractVersion,
  recordKind: MECHANICAL_FIX_SAFETY_DATA.recordKind,
  rules: Object.freeze(rules),
});

if (!validateMechanicalFixSafetyMatrix(MECHANICAL_FIX_SAFETY_MATRIX).valid)
  throw new TypeError("the committed I12 safety matrix is invalid");
