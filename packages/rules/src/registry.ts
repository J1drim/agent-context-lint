import { types as nodeTypes } from "node:util";

import { findRuleExample } from "./rule-examples.js";

export const RULE_REGISTRY_VERSION = "0.1.0" as const;

export const RULE_CATEGORIES = [
  "syntax-structure",
  "references-imports",
  "scope-activation",
  "conflicts-duplication",
  "repository-drift",
  "context-quality-cost",
  "security",
  "portability",
  "standards-freshness",
  "context-efficiency",
] as const;

export const RULE_DEFAULT_SEVERITIES = ["error", "warning", "info"] as const;
export const RULE_PRECISION_STATUSES = ["planned", "seeded", "calibrating", "qualified"] as const;
export const RULE_FIX_SAFETY_LEVELS = ["none", "suggestion-only", "mechanical"] as const;
export const RULE_OWNER_ALIASES = [
  "@agent-context-lint/rules-reviewers",
  "@agent-context-lint/security-reviewers",
  "@agent-context-lint/standards-reviewers",
] as const;

Object.freeze(RULE_CATEGORIES);
Object.freeze(RULE_DEFAULT_SEVERITIES);
Object.freeze(RULE_PRECISION_STATUSES);
Object.freeze(RULE_FIX_SAFETY_LEVELS);
Object.freeze(RULE_OWNER_ALIASES);

export type RuleCategory = (typeof RULE_CATEGORIES)[number];
export type RuleDefaultSeverity = (typeof RULE_DEFAULT_SEVERITIES)[number];
export type RulePrecisionStatus = (typeof RULE_PRECISION_STATUSES)[number];
export type RuleFixSafety = (typeof RULE_FIX_SAFETY_LEVELS)[number];
export type RuleOwnerAlias = (typeof RULE_OWNER_ALIASES)[number];
export type RuleId = `ACL${number}`;

export interface RuleMetadata {
  readonly id: RuleId;
  readonly category: RuleCategory;
  readonly defaultSeverity: RuleDefaultSeverity;
  readonly description: string;
  readonly rationale: string;
  readonly owner: RuleOwnerAlias;
  readonly precisionStatus: RulePrecisionStatus;
  readonly fixSafety: RuleFixSafety;
  /** Repository-relative URL reference; I14 may map it to a hosted documentation base. */
  readonly docsUrl: string;
}

export interface RuleRegistry {
  readonly contractVersion: typeof RULE_REGISTRY_VERSION;
  readonly rules: readonly RuleMetadata[];
}

export type RuleRegistryValidationCode =
  | "duplicate-id"
  | "incomplete-registry"
  | "invalid-category"
  | "invalid-value"
  | "missing-field"
  | "resource-limit"
  | "unsorted"
  | "unknown-field";

export interface RuleRegistryValidationIssue {
  readonly code: RuleRegistryValidationCode;
  readonly path: string;
  readonly message: string;
}

export interface RuleRegistryValidationResult {
  readonly valid: boolean;
  readonly issues: readonly RuleRegistryValidationIssue[];
}

export const MAX_RULES_PER_REGISTRY = 128 as const;
export const MAX_RULE_METADATA_TEXT_CODE_POINTS = 1024 as const;
export const MAX_RULE_METADATA_TEXT_BYTES = 4096 as const;
export const MAX_RULE_REGISTRY_ISSUES = 256 as const;

type Definition = readonly [
  id: RuleId,
  severity: RuleDefaultSeverity,
  description: string,
  rationale: string,
];

const DEFINITIONS: readonly Definition[] = [
  [
    "ACL100",
    "error",
    "Invalid YAML/MDC frontmatter",
    "Malformed frontmatter prevents a client from interpreting declared instruction metadata reliably.",
  ],
  [
    "ACL101",
    "error",
    "Frontmatter field has the wrong type",
    "A type mismatch can silently change or disable client-specific behavior.",
  ],
  [
    "ACL102",
    "warning",
    "Unknown frontmatter field, with vendor-aware suggestions",
    "Misspelled or unsupported fields create a false expectation that policy is active.",
  ],
  [
    "ACL103",
    "error",
    "Invalid glob syntax",
    "An invalid pattern cannot define a trustworthy activation set.",
  ],
  [
    "ACL104",
    "warning",
    "Empty instruction document",
    "An empty discovered document adds ambiguity without contributing instructions.",
  ],
  [
    "ACL105",
    "warning",
    "Instruction file is stored in a location unsupported by the selected agent",
    "A recognized document in an unsupported location is unlikely to affect the intended client.",
  ],
  [
    "ACL106",
    "warning",
    "Deprecated or legacy instruction format",
    "Legacy formats can lose support or behave differently from current documented formats.",
  ],
  [
    "ACL107",
    "warning",
    "Duplicate frontmatter key",
    "Duplicate keys have parser-dependent winner semantics and can broaden or narrow scope unexpectedly.",
  ],
  [
    "ACL108",
    "warning",
    "Invalid suppression directive",
    "A malformed directive may fail to suppress the intended finding or conceal reviewer intent.",
  ],
  [
    "ACL109",
    "warning",
    "Unused suppression directive",
    "A stale directive adds policy debt and may unexpectedly match a future finding.",
  ],
  [
    "ACL150",
    "error",
    "Referenced repository file does not exist",
    "A missing local reference leaves required context unavailable.",
  ],
  [
    "ACL151",
    "error",
    "Import cycle",
    "Cycles make instruction loading incomplete or client-dependent.",
  ],
  [
    "ACL152",
    "error",
    "Reference escapes repository boundary",
    "Repository analysis must not claim or read context outside its authorized root.",
  ],
  [
    "ACL153",
    "warning",
    "Absolute local path reduces portability",
    "Machine-specific paths do not transfer reliably across contributors or CI runners.",
  ],
  [
    "ACL154",
    "warning",
    "Remote reference is used where the client does not load remote content",
    "A remote link can look like imported policy even when the selected client never loads it.",
  ],
  [
    "ACL155",
    "warning",
    "Reference syntax is unsupported by the target agent",
    "Unsupported reference syntax cannot supply the intended context.",
  ],
  [
    "ACL156",
    "warning",
    "Case mismatch in a path, which can fail on case-sensitive systems",
    "Case-only path mistakes can pass locally and fail on another supported platform.",
  ],
  [
    "ACL200",
    "error",
    "Scope pattern matches no repository files",
    "A provably empty scope makes the instruction unreachable.",
  ],
  [
    "ACL201",
    "warning",
    "Rule is unintentionally always-on because scope metadata is missing",
    "Missing scope metadata can add specialized context to every target.",
  ],
  [
    "ACL202",
    "warning",
    "Scope is broader than the directory containing the rule suggests",
    "An unexpectedly broad scope increases conflicts and irrelevant context.",
  ],
  [
    "ACL203",
    "warning",
    "Scope is completely shadowed or unreachable",
    "A fully shadowed rule cannot influence any resolved target.",
  ],
  [
    "ACL204",
    "warning",
    "Different agents resolve the same file to materially different scopes",
    "Cross-client scope divergence undermines a shared repository policy.",
  ],
  [
    "ACL205",
    "warning",
    "Nested instruction behavior is ambiguous for a selected client",
    "Unresolved nesting semantics prevent a definitive effective-context claim.",
  ],
  [
    "ACL206",
    "info",
    "Instruction affects generated, vendored, or dependency files",
    "Applying repository policy to derived content may waste context or encourage unsafe edits.",
  ],
  [
    "ACL250",
    "error",
    "Mutually exclusive package-manager commands apply to the same target",
    "Conflicting package-manager requirements cannot both be followed safely.",
  ],
  [
    "ACL251",
    "error",
    "Mutually exclusive required/prohibited action",
    "The same action cannot be both mandatory and forbidden for one target.",
  ],
  [
    "ACL252",
    "warning",
    "Conflicting test, build, formatting, or commit instructions",
    "Conflicting workflow requirements make successful task completion indeterminate.",
  ],
  [
    "ACL253",
    "warning",
    "Near-duplicate instruction appears in multiple effective files",
    "Repeated effective policy consumes context and increases drift risk.",
  ],
  [
    "ACL254",
    "warning",
    "Vendor-specific instruction diverges from canonical `AGENTS.md` policy",
    "Vendor divergence can produce materially different outcomes across supported agents.",
  ],
  [
    "ACL255",
    "info",
    "A more specific rule repeats an inherited instruction unchanged",
    "Redundant inherited content adds context without changing effective policy.",
  ],
  [
    "ACL300",
    "error",
    "Referenced script or task does not exist",
    "An instruction that invokes a missing task cannot be completed as written.",
  ],
  [
    "ACL301",
    "warning",
    "Command uses a package manager inconsistent with lockfiles/configuration",
    "A mismatched package manager can change dependency resolution or corrupt lock state.",
  ],
  [
    "ACL302",
    "warning",
    "Mentioned directory, config file, or executable does not exist",
    "A missing repository resource makes the instruction stale or incomplete.",
  ],
  [
    "ACL303",
    "warning",
    "Instruction names a tool absent from project configuration",
    "An undeclared tool may not exist in clean development or CI environments.",
  ],
  [
    "ACL304",
    "warning",
    "Documented runtime version conflicts with repository configuration",
    "Runtime drift can make documented commands fail or behave differently.",
  ],
  [
    "ACL305",
    "info",
    "Instruction duplicates a policy already enforced mechanically by a linter/formatter",
    "Mechanically enforced policy need not consume repeated agent context.",
  ],
  [
    "ACL350",
    "warning",
    "Always-on context exceeds configured token budget",
    "Oversized individual documents consume scarce context for every applicable request.",
  ],
  [
    "ACL351",
    "info",
    "Document contains a large code block better referenced from another file",
    "Duplicated code blocks are costly and can drift from their source.",
  ],
  [
    "ACL352",
    "info",
    "Instruction is vague or not actionable",
    "Non-actionable prose consumes context without giving an agent a verifiable requirement.",
  ],
  [
    "ACL353",
    "info",
    "Very long instruction combines multiple independent requirements",
    "Separating independent requirements improves reviewability and targeting.",
  ],
  [
    "ACL354",
    "info",
    "Repository description repeats readily discoverable metadata",
    "Repeated discoverable facts add context cost without durable policy value.",
  ],
  [
    "ACL355",
    "warning",
    "Imported content expands context unexpectedly",
    "Import amplification can exceed the author-visible size of an instruction document.",
  ],
  [
    "ACL400",
    "error",
    "High-confidence credential or private key appears in an instruction file",
    "Instruction files are broadly exposed context and must not contain credential material.",
  ],
  [
    "ACL401",
    "warning",
    "Instruction requests reading secrets or broad credential locations",
    "Routine secret access expands the impact of mistakes or prompt injection.",
  ],
  [
    "ACL402",
    "warning",
    "Download-and-execute command lacks integrity pinning",
    "Executing mutable remote bytes prevents reproducible trust decisions.",
  ],
  [
    "ACL403",
    "warning",
    "Destructive command is presented as routine or unconditional",
    "Destructive operations require explicit scope, confirmation, and recovery planning.",
  ],
  [
    "ACL404",
    "warning",
    "Instruction disables approvals, sandboxing, or security controls",
    "Disabling safety controls weakens the repository's intended execution boundary.",
  ],
  [
    "ACL405",
    "warning",
    "Instruction requests transmission of repository data to an external destination",
    "External transmission can disclose source or sensitive repository metadata.",
  ],
  [
    "ACL406",
    "warning",
    "Imported instruction source is mutable or unpinned",
    "Mutable policy can change without repository review or provenance.",
  ],
  [
    "ACL450",
    "warning",
    "Policy exists only in a vendor-specific file and has no shared equivalent",
    "Vendor-only policy leaves other supported agents without the same requirements.",
  ],
  [
    "ACL451",
    "warning",
    "Same repository policy differs across agent formats",
    "Divergent copies make cross-agent outcomes depend on the selected client.",
  ],
  [
    "ACL452",
    "info",
    "Agent does not support the selected import or nesting behavior",
    "Unsupported composition behavior must be visible rather than assumed effective.",
  ],
  [
    "ACL453",
    "info",
    "Instruction depends on an editor-only feature",
    "Editor-only behavior does not transfer to headless or hosted agent surfaces.",
  ],
  [
    "ACL500",
    "warning",
    "Locked knowledge pack is older than configured maximum age",
    "An over-age pack may omit reviewed changes in supported specifications.",
  ],
  [
    "ACL501",
    "warning",
    "A newer stable knowledge pack is available",
    "Explicit freshness checks should surface a verified stable update without changing scan state.",
  ],
  [
    "ACL502",
    "error",
    "Knowledge pack requires a newer CLI engine",
    "An incompatible engine cannot interpret the pack's contracts safely.",
  ],
  [
    "ACL503",
    "error",
    "Knowledge-pack digest or signature validation failed",
    "Unverified standards data must never influence diagnostics.",
  ],
  [
    "ACL504",
    "warning",
    "Repository uses syntax deprecated by the selected specification",
    "Deprecated syntax can stop working as clients advance.",
  ],
  [
    "ACL505",
    "warning",
    "Repository standards lockfile is missing in CI",
    "Without a lockfile, CI cannot reproduce the standards knowledge used for a scan.",
  ],
  [
    "ACL506",
    "info",
    "Preview upstream behavior exists but is not enabled",
    "Preview information should be visible without being mistaken for stable active semantics.",
  ],
  [
    "ACL550",
    "warning",
    "Always-on context exceeds configured token budget",
    "Resolved always-on context can exceed a client's usable budget across documents.",
  ],
  [
    "ACL551",
    "warning",
    "Effective p95 context exceeds configured token budget",
    "High-tail effective context can make common targets costly or truncated.",
  ],
  [
    "ACL552",
    "warning",
    "High-confidence duplicate context exceeds threshold",
    "Duplicate effective text spends tokens without adding distinct instruction value.",
  ],
  [
    "ACL553",
    "info",
    "Specialized content appears in an unnecessarily broad scope",
    "Narrowing specialized content can reduce context while preserving intended targets.",
  ],
  [
    "ACL554",
    "info",
    "Import graph materially amplifies effective context",
    "Import fan-out can make resolved context much larger than source documents suggest.",
  ],
  [
    "ACL555",
    "info",
    "Vendor-specific duplication can be consolidated safely",
    "Safe consolidation reduces drift and repeated tokens across agent formats.",
  ],
  [
    "ACL556",
    "info",
    "Instruction density is below configured threshold",
    "Low-density documents spend context on prose that carries little actionable policy.",
  ],
  [
    "ACL557",
    "warning",
    "Efficiency comparison uses incompatible tokenizer versions",
    "Counts from incompatible tokenizers cannot support a valid comparison.",
  ],
  [
    "ACL558",
    "info",
    "High-impact context reduction is available but not benchmarked",
    "A projected saving must remain distinct from empirically measured quality preservation.",
  ],
] as const;

function categoryFor(id: RuleId): RuleCategory {
  const number = Number(id.slice(3));
  if (number < 150) return "syntax-structure";
  if (number < 200) return "references-imports";
  if (number < 250) return "scope-activation";
  if (number < 300) return "conflicts-duplication";
  if (number < 350) return "repository-drift";
  if (number < 400) return "context-quality-cost";
  if (number < 450) return "security";
  if (number < 500) return "portability";
  if (number < 550) return "standards-freshness";
  return "context-efficiency";
}

function ownerFor(category: RuleCategory): RuleOwnerAlias {
  if (category === "security") return "@agent-context-lint/security-reviewers";
  if (category === "standards-freshness") return "@agent-context-lint/standards-reviewers";
  return "@agent-context-lint/rules-reviewers";
}

const SEEDED_RULE_IDS: ReadonlySet<RuleId> = new Set([
  "ACL100",
  "ACL101",
  "ACL102",
  "ACL103",
  "ACL104",
  "ACL105",
  "ACL106",
  "ACL107",
  "ACL108",
  "ACL109",
  "ACL150",
  "ACL151",
  "ACL152",
  "ACL153",
  "ACL154",
  "ACL155",
  "ACL156",
  "ACL200",
  "ACL201",
  "ACL202",
  "ACL203",
  "ACL204",
  "ACL205",
  "ACL206",
  "ACL250",
  "ACL251",
  "ACL252",
  "ACL253",
  "ACL254",
  "ACL255",
  "ACL350",
  "ACL351",
  "ACL352",
  "ACL353",
  "ACL354",
  "ACL355",
  "ACL400",
  "ACL401",
  "ACL402",
  "ACL403",
  "ACL404",
  "ACL405",
  "ACL406",
  "ACL450",
  "ACL451",
  "ACL452",
  "ACL453",
  "ACL500",
  "ACL501",
  "ACL502",
  "ACL503",
  "ACL504",
  "ACL505",
  "ACL506",
  "ACL550",
  "ACL551",
  "ACL552",
  "ACL553",
  "ACL554",
  "ACL555",
  "ACL556",
  "ACL557",
  "ACL558",
]);

function createMetadata(definition: Definition): RuleMetadata {
  const [id, defaultSeverity, description, rationale] = definition;
  const category = categoryFor(id);
  return Object.freeze({
    category,
    defaultSeverity,
    description,
    docsUrl: `docs/rules/catalog.md#${id.toLowerCase()}`,
    fixSafety: id === "ACL109" ? "mechanical" : "none",
    id,
    owner: ownerFor(category),
    precisionStatus: SEEDED_RULE_IDS.has(id) ? "seeded" : "planned",
    rationale,
  });
}

export const REQUIRED_RULE_IDS: readonly RuleId[] = Object.freeze(DEFINITIONS.map(([id]) => id));

export const RULE_REGISTRY: RuleRegistry = Object.freeze({
  contractVersion: RULE_REGISTRY_VERSION,
  rules: Object.freeze(DEFINITIONS.map(createMetadata)),
});

const REQUIRED_RULE_ID_SET: ReadonlySet<string> = new Set(REQUIRED_RULE_IDS);
const CATEGORY_SET: ReadonlySet<string> = new Set(RULE_CATEGORIES);
const SEVERITY_SET: ReadonlySet<string> = new Set(RULE_DEFAULT_SEVERITIES);
const PRECISION_SET: ReadonlySet<string> = new Set(RULE_PRECISION_STATUSES);
const FIX_SAFETY_SET: ReadonlySet<string> = new Set(RULE_FIX_SAFETY_LEVELS);
const OWNER_SET: ReadonlySet<string> = new Set(RULE_OWNER_ALIASES);
const RULE_KEYS = [
  "category",
  "defaultSeverity",
  "description",
  "docsUrl",
  "fixSafety",
  "id",
  "owner",
  "precisionStatus",
  "rationale",
] as const;

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function codePointLength(value: string): number {
  let count = 0;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) index += 1;
    count += 1;
  }
  return count;
}

function isWellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function safeRecord(
  value: unknown,
  path: string,
  allowed: readonly string[],
  report: (issue: RuleRegistryValidationIssue) => void,
): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    report({ code: "invalid-value", path, message: "must be a plain object" });
    return undefined;
  }
  if (nodeTypes.isProxy(value)) {
    report({ code: "invalid-value", path, message: "proxy objects are not accepted" });
    return undefined;
  }
  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    report({ code: "invalid-value", path, message: "must be a plain object" });
    return undefined;
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length > allowed.length) {
    report({
      code: "resource-limit",
      path,
      message: `must contain at most ${String(allowed.length)} fields`,
    });
  }
  const allowedSet = new Set(allowed);
  const record: Record<string, unknown> = {};
  for (const key of ownKeys.slice(0, allowed.length + 1)) {
    if (typeof key !== "string") {
      report({
        code: "unknown-field",
        path,
        message: "symbol fields are not part of the contract",
      });
      continue;
    }
    if (!allowedSet.has(key)) {
      report({
        code: "unknown-field",
        path: `${path}.${key}`,
        message: "is not part of the contract",
      });
      continue;
    }
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
      report({
        code: "invalid-value",
        path: `${path}.${key}`,
        message: "must be an own enumerable data property",
      });
      continue;
    }
    record[key] = descriptor.value;
  }
  return record;
}

function safeDenseArray(
  value: unknown,
  path: string,
  maximumItems: number,
  report: (issue: RuleRegistryValidationIssue) => void,
): readonly unknown[] | undefined {
  if (!Array.isArray(value)) {
    report({ code: "invalid-value", path, message: "must be an array" });
    return undefined;
  }
  if (nodeTypes.isProxy(value)) {
    report({ code: "invalid-value", path, message: "proxy arrays are not accepted" });
    return undefined;
  }
  if (Reflect.getPrototypeOf(value) !== Array.prototype) {
    report({ code: "invalid-value", path, message: "must use the intrinsic Array prototype" });
    return undefined;
  }
  const lengthDescriptor = Reflect.getOwnPropertyDescriptor(value, "length");
  if (
    lengthDescriptor === undefined ||
    !("value" in lengthDescriptor) ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0
  ) {
    report({ code: "invalid-value", path, message: "has an invalid array length" });
    return undefined;
  }
  const length = lengthDescriptor.value;
  if (length > maximumItems) {
    report({
      code: "resource-limit",
      path,
      message: `must contain at most ${String(maximumItems)} entries`,
    });
    return undefined;
  }
  const keys = Reflect.ownKeys(value);
  const expectedKeys = new Set(["length", ...Array.from({ length }, (_, index) => String(index))]);
  for (const key of keys) {
    if (typeof key !== "string" || !expectedKeys.has(key)) {
      report({
        code: "unknown-field",
        path: typeof key === "string" ? `${path}.${key}` : path,
        message: "array contains an unsupported own field",
      });
    }
  }
  const items: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
      report({
        code: "invalid-value",
        path: `${path}[${String(index)}]`,
        message: "must be a dense own enumerable data element",
      });
      items.push(undefined);
    } else {
      items.push(descriptor.value);
    }
  }
  return items;
}

function requiredText(
  record: Record<string, unknown>,
  key: string,
  path: string,
  report: (issue: RuleRegistryValidationIssue) => void,
): string | undefined {
  if (!(key in record)) {
    report({ code: "missing-field", path: `${path}.${key}`, message: "is required" });
    return undefined;
  }
  const value = record[key];
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    !isWellFormed(value) ||
    codePointLength(value) > MAX_RULE_METADATA_TEXT_CODE_POINTS ||
    byteLength(value) > MAX_RULE_METADATA_TEXT_BYTES
  ) {
    report({
      code: "invalid-value",
      path: `${path}.${key}`,
      message: `must be non-empty well-formed Unicode within ${String(MAX_RULE_METADATA_TEXT_BYTES)} UTF-8 bytes`,
    });
    return undefined;
  }
  return value;
}

function validateRule(
  value: unknown,
  index: number,
  report: (issue: RuleRegistryValidationIssue) => void,
): string | undefined {
  const path = `$.rules[${String(index)}]`;
  const rule = safeRecord(value, path, RULE_KEYS, report);
  if (rule === undefined) return undefined;
  const id = requiredText(rule, "id", path, report);
  const category = requiredText(rule, "category", path, report);
  const severity = requiredText(rule, "defaultSeverity", path, report);
  const description = requiredText(rule, "description", path, report);
  const rationale = requiredText(rule, "rationale", path, report);
  const owner = requiredText(rule, "owner", path, report);
  const precision = requiredText(rule, "precisionStatus", path, report);
  const fixSafety = requiredText(rule, "fixSafety", path, report);
  const docsUrl = requiredText(rule, "docsUrl", path, report);
  if (id !== undefined && !/^ACL[1-5][0-9]{2}$/u.test(id))
    report({
      code: "invalid-value",
      path: `${path}.id`,
      message: "must be an ACL100-ACL599 identifier",
    });
  if (category !== undefined && !CATEGORY_SET.has(category))
    report({
      code: "invalid-value",
      path: `${path}.category`,
      message: "must be a known rule category",
    });
  if (severity !== undefined && !SEVERITY_SET.has(severity))
    report({
      code: "invalid-value",
      path: `${path}.defaultSeverity`,
      message: "must be error, warning, or info",
    });
  if (owner !== undefined && !OWNER_SET.has(owner))
    report({
      code: "invalid-value",
      path: `${path}.owner`,
      message: "must be an accountable governance alias",
    });
  if (precision !== undefined && !PRECISION_SET.has(precision))
    report({
      code: "invalid-value",
      path: `${path}.precisionStatus`,
      message: "must be a known precision lifecycle state",
    });
  if (fixSafety !== undefined && !FIX_SAFETY_SET.has(fixSafety))
    report({
      code: "invalid-value",
      path: `${path}.fixSafety`,
      message: "must be a known fix-safety level",
    });
  if (
    docsUrl !== undefined &&
    id !== undefined &&
    docsUrl !== `docs/rules/catalog.md#${id.toLowerCase()}`
  )
    report({
      code: "invalid-value",
      path: `${path}.docsUrl`,
      message: "must link to the canonical rule-catalog anchor",
    });
  if (
    id !== undefined &&
    category !== undefined &&
    /^ACL[1-5][0-9]{2}$/u.test(id) &&
    category !== categoryFor(id as RuleId)
  )
    report({
      code: "invalid-category",
      path: `${path}.category`,
      message: `does not match ${id}'s reserved numeric range`,
    });
  void description;
  void rationale;
  return id;
}

export function validateRuleRegistry(
  value: unknown,
  options: { readonly requireComplete?: boolean } = {},
): RuleRegistryValidationResult {
  const issues: RuleRegistryValidationIssue[] = [];
  const report = (issue: RuleRegistryValidationIssue): void => {
    if (issues.length < MAX_RULE_REGISTRY_ISSUES) issues.push(issue);
  };
  try {
    const registry = safeRecord(value, "$", ["contractVersion", "rules"], report);
    if (registry === undefined) return { issues: Object.freeze(issues), valid: false };
    const version = requiredText(registry, "contractVersion", "$", report);
    if (version !== undefined && version !== RULE_REGISTRY_VERSION)
      report({
        code: "invalid-value",
        path: "$.contractVersion",
        message: `must equal ${RULE_REGISTRY_VERSION}`,
      });
    if (!("rules" in registry)) {
      report({ code: "missing-field", path: "$.rules", message: "is required" });
      return { issues: Object.freeze(issues), valid: false };
    }
    const rulesValue = safeDenseArray(registry["rules"], "$.rules", MAX_RULES_PER_REGISTRY, report);
    if (rulesValue === undefined) {
      return { issues: Object.freeze(issues), valid: false };
    }
    const ids = new Set<string>();
    let previous = "";
    for (let index = 0; index < rulesValue.length; index += 1) {
      const id = validateRule(rulesValue[index], index, report);
      if (id === undefined) continue;
      if (ids.has(id))
        report({
          code: "duplicate-id",
          path: `$.rules[${String(index)}].id`,
          message: `duplicates ${id}`,
        });
      ids.add(id);
      if (previous !== "" && id <= previous)
        report({
          code: "unsorted",
          path: `$.rules[${String(index)}].id`,
          message: "rule identifiers must be strictly ascending",
        });
      previous = id;
    }
    if (options.requireComplete === true) {
      const missing = REQUIRED_RULE_IDS.filter((id) => !ids.has(id));
      const extra = [...ids].filter((id) => !REQUIRED_RULE_ID_SET.has(id));
      if (missing.length > 0 || extra.length > 0)
        report({
          code: "incomplete-registry",
          path: "$.rules",
          message: `must contain exactly the committed catalog; missing=[${missing.join(",")}], extra=[${extra.join(",")}]`,
        });
    }
  } catch {
    report({ code: "invalid-value", path: "$", message: "could not be inspected safely" });
  }
  return { issues: Object.freeze(issues), valid: issues.length === 0 };
}

export function isRuleRegistry(
  value: unknown,
  options: { readonly requireComplete?: boolean } = {},
): value is RuleRegistry {
  return validateRuleRegistry(value, options).valid;
}

export function findRuleMetadata(id: string): RuleMetadata | undefined {
  if (!/^ACL[1-5][0-9]{2}$/u.test(id)) return undefined;
  let low = 0;
  let high = RULE_REGISTRY.rules.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const rule = RULE_REGISTRY.rules[middle];
    if (rule === undefined) return undefined;
    if (rule.id === id) return rule;
    if (rule.id < id) low = middle + 1;
    else high = middle - 1;
  }
  return undefined;
}

/** Resolve a rule's repository-relative docs URL against an explicit trusted deployment base. */
export function resolveRuleDocsUrl(id: string, deploymentBase: string | URL): URL | undefined {
  const metadata = findRuleMetadata(id);
  if (metadata === undefined) return undefined;
  const candidate: unknown = deploymentBase;
  if (typeof candidate === "object" && candidate !== null && nodeTypes.isProxy(candidate)) {
    throw new TypeError("documentation deployment base must be a string or non-proxied URL");
  }
  if (typeof deploymentBase !== "string" && !(deploymentBase instanceof URL)) {
    throw new TypeError("documentation deployment base must be a string or non-proxied URL");
  }
  const base = new URL(
    typeof deploymentBase === "string"
      ? deploymentBase
      : URL.prototype.toString.call(deploymentBase),
  );
  if (
    base.protocol !== "https:" ||
    base.username !== "" ||
    base.password !== "" ||
    base.search !== "" ||
    base.hash !== "" ||
    !base.pathname.endsWith("/")
  ) {
    throw new TypeError(
      "documentation deployment base must be an absolute credential-free HTTPS directory URL",
    );
  }
  return new URL(metadata.docsUrl, base);
}

const CATEGORY_TITLES: Readonly<Record<RuleCategory, string>> = {
  "syntax-structure": "Syntax and structure",
  "references-imports": "References and imports",
  "scope-activation": "Scope and activation",
  "conflicts-duplication": "Conflicts and duplication",
  "repository-drift": "Repository drift",
  "context-quality-cost": "Context quality and cost",
  security: "Security",
  portability: "Portability",
  "standards-freshness": "Standards freshness",
  "context-efficiency": "Context efficiency",
};

export function renderRuleCatalogMarkdown(registry: RuleRegistry = RULE_REGISTRY): string {
  const validation = validateRuleRegistry(registry, { requireComplete: true });
  if (!validation.valid)
    throw new TypeError("cannot render an invalid or incomplete rule registry");
  const lines = [
    "# Rule catalog",
    "",
    "Product release: `1.0.0`.",
    `Rule registry contract version: \`${registry.contractVersion}\` (an independent wire-contract identity).`,
    "",
    "This file is generated deterministically from `@agent-context/rules`. Rule IDs and default severities are stable public behavior. Precision status records each rule's evidence lifecycle; no rule advertises an automatic fix until its fix-safety ticket is complete.",
    "",
    "The bad/good pairs below are concise illustrative examples, not executable conformance fixtures. Exact findings depend on the selected profile, repository evidence, configuration, and standards snapshot.",
    "",
  ];
  for (const category of RULE_CATEGORIES) {
    lines.push(`## ${CATEGORY_TITLES[category]}`, "");
    for (const rule of registry.rules.filter((entry) => entry.category === category)) {
      const ruleExample = findRuleExample(rule.id);
      if (ruleExample === undefined)
        throw new TypeError(`missing illustrative documentation example for ${rule.id}`);
      lines.push(
        `### ${rule.id}`,
        "",
        rule.description,
        "",
        `- Default severity: \`${rule.defaultSeverity}\``,
        `- Owner: \`${rule.owner}\``,
        `- Precision status: \`${rule.precisionStatus}\``,
        `- Fix safety: \`${rule.fixSafety}\``,
        `- Rationale: ${rule.rationale}`,
        "",
        "**Bad example (illustrative):**",
        "",
        "```" + ruleExample.syntax,
        ruleExample.bad,
        "```",
        "",
        "**Good example (illustrative):**",
        "",
        "```" + ruleExample.syntax,
        ruleExample.good,
        "```",
        "",
      );
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
