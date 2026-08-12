import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";

import {
  DIAGNOSTIC_CONTRACT_VERSION,
  PATH_FINGERPRINT_METHOD,
  SEMANTIC_FINGERPRINT_METHOD,
  computePathFingerprint,
  computeSemanticFingerprint,
  validateDiagnosticBundle,
  validateInstructionIr,
} from "@agent-context/core";
import {
  COMMAND_LEXER_CONTRACT_VERSION,
  CommandLexerError,
  CommandLexerErrorCode,
  lexCommandEvidence,
} from "@agent-context/evidence";
import { matchSuppressionDirectives, parseSuppressionDirectives } from "@agent-context/syntax";

import type {
  Diagnostic,
  DiagnosticBundle,
  DiagnosticFingerprintBasis,
  DiagnosticId,
  DiagnosticSeverity,
  DiagnosticSourceLocation,
  ImportReference,
  InstructionIr,
  InstructionStatement,
  SourceDocument,
} from "@agent-context/core";
import type {
  CommandDialect,
  CommandInvocationEvidence,
  CommandLexerResult,
} from "@agent-context/evidence";
import type { ParsedSuppressionDirective } from "@agent-context/syntax";

export const SECURITY_RULE_CONTRACT_VERSION = "0.1.0" as const;
export const SECURITY_RULE_VERSION = "1.0.0" as const;
export const SECURITY_RULE_IDS = [
  "ACL400",
  "ACL401",
  "ACL402",
  "ACL403",
  "ACL404",
  "ACL405",
  "ACL406",
] as const;

export type SecurityRuleId = (typeof SECURITY_RULE_IDS)[number];

export interface SecurityStatementDialect {
  readonly dialect: CommandDialect;
  readonly statementId: string;
}

export interface SecurityRuleInput {
  readonly contractVersion: typeof SECURITY_RULE_CONTRACT_VERSION;
  readonly ir: InstructionIr;
  readonly recordKind: "agent-context-security-rule-input";
  /**
   * Only mapped statements are interpreted as commands. Natural-language and credential rules
   * still run for every statement. Callers must use `auto` explicitly when the dialect is unknown.
   */
  readonly statementDialects: readonly SecurityStatementDialect[];
}

export interface SecurityRuleLimits {
  readonly maximumDiagnostics: number;
  readonly maximumImports: number;
  readonly maximumStatements: number;
  readonly maximumTextLength: number;
  readonly maximumUncertainties: number;
}

export type SecurityRuleOptions = Partial<SecurityRuleLimits>;

export const SECURITY_RULE_DEFAULT_LIMITS: Readonly<SecurityRuleLimits> = Object.freeze({
  maximumDiagnostics: 10_000,
  maximumImports: 10_000,
  maximumStatements: 10_000,
  maximumTextLength: 65_536,
  maximumUncertainties: 10_000,
});

export const SECURITY_RULE_HARD_LIMITS: Readonly<SecurityRuleLimits> = Object.freeze({
  maximumDiagnostics: 50_000,
  maximumImports: 50_000,
  maximumStatements: 100_000,
  maximumTextLength: 1_048_576,
  maximumUncertainties: 50_000,
});

export type SecurityRuleUncertaintyReason =
  "ambiguous-command-dialect" | "dynamic-command" | "malformed-command";

/** No repository-controlled string is retained in uncertainty output. */
export interface SecurityRuleUncertainty {
  readonly reason: SecurityRuleUncertaintyReason;
  readonly ruleIds: readonly ("ACL402" | "ACL403" | "ACL405")[];
  readonly sourceDigest: string;
  readonly startUtf16Offset: number;
}

export interface SecurityRuleMetrics {
  readonly commandInvocationCount: number;
  readonly diagnosticCount: number;
  readonly importCount: number;
  readonly statementCount: number;
  readonly suppressionDirectiveCount: number;
  readonly uncertaintyCount: number;
}

export type SecurityRuleIssueCode =
  "dependency-failure" | "invalid-input" | "invalid-options" | "resource-limit";

export interface SecurityRuleIssue {
  readonly code: SecurityRuleIssueCode;
  readonly message: string;
  readonly path: string;
}

export type SecurityRuleResult =
  | {
      readonly bundle: DiagnosticBundle;
      readonly commandLexerContractVersion: typeof COMMAND_LEXER_CONTRACT_VERSION;
      readonly contractVersion: typeof SECURITY_RULE_CONTRACT_VERSION;
      readonly limits: SecurityRuleLimits;
      readonly metrics: SecurityRuleMetrics;
      readonly ok: true;
      readonly uncertainties: readonly SecurityRuleUncertainty[];
    }
  | { readonly issues: readonly SecurityRuleIssue[]; readonly ok: false };

export type SecuritySuppressionFinalizationResult =
  | {
      readonly bundle: DiagnosticBundle;
      readonly ok: true;
      readonly suppressedDiagnostics: readonly Diagnostic[];
      readonly visibleDiagnostics: readonly Diagnostic[];
    }
  | { readonly issues: readonly SecurityRuleIssue[]; readonly ok: false };

interface EvaluationContext {
  readonly diagnostics: Diagnostic[];
  readonly diagnosticKeys: Set<string>;
  readonly limits: SecurityRuleLimits;
  readonly sourceById: ReadonlyMap<string, SourceDocument>;
  readonly uncertainties: SecurityRuleUncertainty[];
  readonly uncertaintyKeys: Set<string>;
  commandInvocationCount: number;
}

interface SecretDescriptor {
  readonly category: string;
  readonly pattern: RegExp;
}

const INPUT_KEYS = new Set(["contractVersion", "ir", "recordKind", "statementDialects"]);
const DIALECT_KEYS = new Set(["dialect", "statementId"]);
const LIMIT_KEYS = new Set(Object.keys(SECURITY_RULE_DEFAULT_LIMITS));
const DIALECTS = new Set<CommandDialect>([
  "auto",
  "posix-shell",
  "windows-cmd",
  "windows-powershell",
]);
const COMMAND_RULE_IDS = Object.freeze(["ACL402", "ACL403", "ACL405"] as const);
const RULE_SEVERITY: Readonly<Record<SecurityRuleId, DiagnosticSeverity>> = Object.freeze({
  ACL400: "error",
  ACL401: "warning",
  ACL402: "warning",
  ACL403: "warning",
  ACL404: "warning",
  ACL405: "warning",
  ACL406: "warning",
});
const RULE_MESSAGES: Readonly<Record<SecurityRuleId, string>> = Object.freeze({
  ACL400: "Instruction contains a high-confidence credential or private-key pattern.",
  ACL401: "Instruction requests access to a secret or broad credential location.",
  ACL402:
    "Instruction downloads and executes remote content without explicit integrity verification.",
  ACL403: "Instruction presents a destructive command as routine or unconditional.",
  ACL404: "Instruction disables or bypasses an approval, sandbox, or security control.",
  ACL405: "Instruction requests transmission of repository data to an external destination.",
  ACL406: "Instruction imports policy from a remote source that is not immutably pinned.",
});
const RULE_SUGGESTIONS: Readonly<Record<SecurityRuleId, string>> = Object.freeze({
  ACL400: "Remove and rotate the credential; keep only a secret-manager reference in instructions.",
  ACL401: "Narrow secret access to an explicit, approved operation and minimum required location.",
  ACL402: "Verify a committed digest or trusted signature before executing downloaded bytes.",
  ACL403: "Require explicit scope, confirmation, and a documented recovery path.",
  ACL404: "Retain safety controls and document a narrowly scoped approved exception if required.",
  ACL405: "Remove the transmission or require an explicit approved destination and data boundary.",
  ACL406: "Pin the imported policy to an immutable revision and verify its provenance.",
});

/*
 * V1 intentionally recognizes only distinctive provider prefixes and private-key armor. It does
 * not use entropy guesses or generic `password=...` matching. Matches are never returned.
 */
const SECRET_DESCRIPTORS: readonly SecretDescriptor[] = Object.freeze([
  Object.freeze({
    category: "private-key",
    pattern: /-----BEGIN (?:ENCRYPTED |RSA |DSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/gu,
  }),
  Object.freeze({ category: "github-token", pattern: /github_pat_[A-Za-z0-9_]{20,}/gu }),
  Object.freeze({ category: "github-token", pattern: /gh[pousr]_[A-Za-z0-9]{20,}/gu }),
  Object.freeze({ category: "gitlab-token", pattern: /glpat-[A-Za-z0-9_-]{20,}/gu }),
  Object.freeze({ category: "google-api-key", pattern: /AIza[0-9A-Za-z_-]{35}/gu }),
  Object.freeze({ category: "npm-token", pattern: /npm_[A-Za-z0-9]{36}/gu }),
  Object.freeze({ category: "openai-token", pattern: /sk-(?:proj|svcacct)-[A-Za-z0-9_-]{20,}/gu }),
  Object.freeze({ category: "slack-token", pattern: /xox[baprs]-[A-Za-z0-9-]{20,}/gu }),
  Object.freeze({ category: "stripe-live-key", pattern: /sk_live_[A-Za-z0-9]{20,}/gu }),
]);

const SECRET_LOCATION =
  /(?:\.aws[\\/]credentials|\.config[\\/]gcloud|\.docker[\\/]config\.json|\.env(?:\.[A-Za-z0-9_-]+)?|\.npmrc|\.pypirc|\.ssh(?:[\\/](?:id_(?:rsa|dsa|ecdsa|ed25519)|config))?|\/etc\/shadow|keychain|credential manager|windows credential manager)/iu;
const SECRET_READ =
  /\b(?:cat|collect|copy|display|dump|find|gather|get-content|inspect|list|load|open|print|read|show|type)\b/iu;
const NEGATED_SECRET_ACCESS =
  /\b(?:avoid|do not|don't|must not|never|prohibit(?:ed)?|should not)\b[^\n]{0,96}(?:credential|keychain|password|secret|token|\.aws|\.env|\.npmrc|\.ssh)/iu;
const SAFETY_QUALIFIER =
  /\b(?:after|if|only)\b[^\n]{0,80}\b(?:approval|approved|confirm(?:ation|ed)?|explicitly requested|permission)\b|\b(?:backup|back up|dry[- ]run|recovery|restore)\b/iu;
const ROUTINE_OR_IMPERATIVE =
  /^(?:\s|`)*(?:always|before every|after every|must|on each|on every|run|execute|use|rm\b|git\s+(?:clean|reset)\b|remove-item\b|(?:del|erase|rmdir|rd)\b)/iu;
const CONTROL_DISABLE =
  /--dangerously-skip-permissions\b|--(?:disable|no)-sandbox\b|--skip-approvals?\b|\b(?:bypass|disable|skip|turn off)\b[^\n]{0,80}\b(?:approval|confirmation|permission checks?|sandbox|security controls?)\b|\b(?:do not|don't|never) ask (?:for )?(?:approval|confirmation|permission)\b/iu;
const NEGATED_CONTROL_DISABLE =
  /\b(?:avoid|do not|don't|must not|never|prohibit(?:ed)?|should not)\b[^\n]{0,96}\b(?:bypass|disable|skip|turn off)\b[^\n]{0,80}\b(?:approval|confirmation|permission checks?|sandbox|security controls?)\b/iu;
const NEGATED_TRANSMISSION =
  /\b(?:avoid|do not|don't|must not|never|prohibit(?:ed)?|should not)\b[^\n]{0,120}\b(?:send|share|transmit|upload)\b/iu;
const NATURAL_TRANSMISSION =
  /\b(?:post|send|share|transmit|upload)\b[^\n]{0,120}\b(?:codebase|git diff|project files?|repository|source code)\b[^\n]{0,120}(?:https?:\/\/|external|third[- ]party)|\b(?:codebase|git diff|project files?|repository|source code)\b[^\n]{0,120}\b(?:post|send|share|transmit|upload)\b[^\n]{0,120}(?:https?:\/\/|external|third[- ]party)/iu;
const SHA256_LITERAL = /\b[0-9a-fA-F]{64}\b/u;
const issuedEvaluations = new WeakMap<
  object,
  { readonly directives: readonly ParsedSuppressionDirective[]; readonly ir: InstructionIr }
>();

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function issue(code: SecurityRuleIssueCode, path: string, message: string): SecurityRuleIssue {
  return Object.freeze({ code, message, path });
}

function failure(value: SecurityRuleIssue): SecurityRuleResult {
  return Object.freeze({ issues: Object.freeze([value]), ok: false });
}

function plainDataRecord(
  value: unknown,
  allowed: ReadonlySet<string>,
): ReadonlyMap<string, unknown> | undefined {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    nodeTypes.isProxy(value)
  )
    return undefined;
  try {
    const prototype = Reflect.getPrototypeOf(value);
    const keys = Reflect.ownKeys(value);
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      keys.length !== allowed.size ||
      keys.some((key) => typeof key !== "string" || !allowed.has(key))
    )
      return undefined;
    const output = new Map<string, unknown>();
    for (const key of keys) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true)
        return undefined;
      output.set(key as string, descriptor.value as unknown);
    }
    return output;
  } catch {
    return undefined;
  }
}

function denseDataArray(value: unknown): readonly unknown[] | undefined {
  if (!Array.isArray(value) || nodeTypes.isProxy(value)) return undefined;
  try {
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== value.length + 1 ||
      !keys.includes("length") ||
      value.length > SECURITY_RULE_HARD_LIMITS.maximumStatements
    )
      return undefined;
    const output: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true)
        return undefined;
      output.push(descriptor.value as unknown);
    }
    return output;
  } catch {
    return undefined;
  }
}

function partialDataRecord(
  value: unknown,
  allowed: ReadonlySet<string>,
): ReadonlyMap<string, unknown> | undefined {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    nodeTypes.isProxy(value)
  )
    return undefined;
  try {
    const prototype = Reflect.getPrototypeOf(value);
    const keys = Reflect.ownKeys(value);
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      keys.some((key) => typeof key !== "string" || !allowed.has(key))
    )
      return undefined;
    const output = new Map<string, unknown>();
    for (const key of keys) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true)
        return undefined;
      output.set(key as string, descriptor.value as unknown);
    }
    return output;
  } catch {
    return undefined;
  }
}

function validateLimits(raw: unknown): SecurityRuleLimits | SecurityRuleIssue {
  if (raw === undefined) return SECURITY_RULE_DEFAULT_LIMITS;
  const record = partialDataRecord(raw, LIMIT_KEYS);
  if (record === undefined)
    return issue("invalid-options", "$options", "options must be a closed plain data object");
  const output: Record<keyof SecurityRuleLimits, number> = {
    ...SECURITY_RULE_DEFAULT_LIMITS,
  };
  for (const key of LIMIT_KEYS) {
    if (!record.has(key)) continue;
    const value = record.get(key);
    const hard = SECURITY_RULE_HARD_LIMITS[key as keyof SecurityRuleLimits];
    if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > hard)
      return issue("invalid-options", `$options.${key}`, "limit is outside the supported range");
    output[key as keyof SecurityRuleLimits] = value as number;
  }
  return Object.freeze(output);
}

function validateDialects(
  raw: unknown,
  ir: InstructionIr,
): ReadonlyMap<string, CommandDialect> | SecurityRuleIssue {
  const values = denseDataArray(raw);
  if (values === undefined)
    return issue("invalid-input", "$.statementDialects", "must be a dense data array");
  const statementIds = new Set(ir.statements.map((statement) => statement.id));
  const output = new Map<string, CommandDialect>();
  for (let index = 0; index < values.length; index += 1) {
    const record = plainDataRecord(values[index], DIALECT_KEYS);
    if (record === undefined)
      return issue(
        "invalid-input",
        `$.statementDialects[${String(index)}]`,
        "must be a closed dialect mapping",
      );
    const statementId = record.get("statementId");
    const dialect = record.get("dialect");
    if (
      typeof statementId !== "string" ||
      !statementIds.has(statementId as InstructionStatement["id"]) ||
      typeof dialect !== "string" ||
      !DIALECTS.has(dialect as CommandDialect) ||
      output.has(statementId)
    )
      return issue(
        "invalid-input",
        `$.statementDialects[${String(index)}]`,
        "contains an invalid, unknown, or duplicate mapping",
      );
    output.set(statementId, dialect as CommandDialect);
  }
  return output;
}

function sha256(...values: readonly string[]): string {
  const hash = createHash("sha256");
  for (const value of values) {
    const bytes = Buffer.from(value, "utf8");
    const length = Buffer.allocUnsafe(8);
    length.writeBigUInt64BE(BigInt(bytes.length));
    hash.update(length);
    hash.update(bytes);
  }
  return hash.digest("hex");
}

function location(
  source: SourceDocument,
  range: DiagnosticSourceLocation["range"],
): DiagnosticSourceLocation {
  return Object.freeze({
    path: source.path,
    range,
    sourceDigest: source.sha256,
    sourceId: source.id,
  });
}

function validatedMapValue<T>(values: ReadonlyMap<string, T>, id: string): T {
  const value = values.get(id);
  if (value === undefined) throw new TypeError("validated relationship is unavailable");
  return value;
}

function statementLocation(
  context: EvaluationContext,
  statement: InstructionStatement,
): DiagnosticSourceLocation {
  const source = validatedMapValue(context.sourceById, statement.range.sourceId);
  return location(source, statement.range);
}

function diagnosticSubject(
  source: SourceDocument,
  startUtf16Offset: number,
  discriminator: string,
): string {
  return sha256(source.sha256, String(startUtf16Offset), discriminator);
}

function addDiagnostic(
  context: EvaluationContext,
  ruleId: SecurityRuleId,
  primary: DiagnosticSourceLocation,
  discriminator: string,
): void {
  const subject = diagnosticSubject(
    validatedMapValue(context.sourceById, primary.sourceId),
    primary.range.start.utf16Offset,
    discriminator,
  );
  const key = `${ruleId}\u0000${subject}`;
  if (context.diagnosticKeys.has(key)) return;
  if (context.diagnostics.length >= context.limits.maximumDiagnostics)
    throw new RangeError("maximum diagnostics exceeded");
  context.diagnosticKeys.add(key);
  const pathBasis: DiagnosticFingerprintBasis["path"] = Object.freeze({
    anchor: `source-location:${primary.sourceDigest}:${String(primary.range.start.utf16Offset)}`,
    profileIds: Object.freeze([]),
  });
  const semanticBasis: DiagnosticFingerprintBasis["semantic"] = Object.freeze({
    components: Object.freeze([
      Object.freeze({ key: "finding-category", value: ruleId }),
      Object.freeze({ key: "subject-digest", value: subject }),
    ]),
    profileIds: Object.freeze([]),
  });
  const pathFingerprint = computePathFingerprint({
    basis: pathBasis,
    path: primary.path,
    ruleId,
    ruleVersion: SECURITY_RULE_VERSION,
  });
  const semanticFingerprint = computeSemanticFingerprint({
    basis: semanticBasis,
    ruleId,
    ruleVersion: SECURITY_RULE_VERSION,
  });
  context.diagnostics.push(
    Object.freeze({
      fingerprintBasis: Object.freeze({ path: pathBasis, semantic: semanticBasis }),
      fingerprints: Object.freeze({
        path: Object.freeze({ method: PATH_FINGERPRINT_METHOD, value: pathFingerprint }),
        semantic: Object.freeze({
          method: SEMANTIC_FINGERPRINT_METHOD,
          value: semanticFingerprint,
        }),
      }),
      id: `diagnostic:${ruleId.toLowerCase()}:${semanticFingerprint.slice(0, 32)}` as DiagnosticId,
      message: RULE_MESSAGES[ruleId],
      primary,
      related: Object.freeze([]),
      ruleId,
      ruleVersion: SECURITY_RULE_VERSION,
      severity: RULE_SEVERITY[ruleId],
      suggestion: Object.freeze({ fixPlan: null, message: RULE_SUGGESTIONS[ruleId] }),
    }),
  );
}

function secretCategories(text: string): readonly string[] {
  const categories = new Set<string>();
  for (const descriptor of SECRET_DESCRIPTORS) {
    descriptor.pattern.lastIndex = 0;
    if (descriptor.pattern.test(text)) categories.add(descriptor.category);
    descriptor.pattern.lastIndex = 0;
  }
  return Object.freeze([...categories].sort(compareUtf8));
}

function requestsSecretAccess(text: string): boolean {
  return !NEGATED_SECRET_ACCESS.test(text) && SECRET_LOCATION.test(text) && SECRET_READ.test(text);
}

function executableName(invocation: CommandInvocationEvidence): string | null {
  if (invocation.state !== "literal" || invocation.executable === null) return null;
  return invocation.executable
    .replace(/^.*[\\/]/u, "")
    .replace(/\.(?:cmd|exe|ps1)$/iu, "")
    .toLowerCase();
}

function literalArguments(invocation: CommandInvocationEvidence): readonly string[] | null {
  if (invocation.state !== "literal") return null;
  return invocation.arguments as readonly string[];
}

function isCurlUploadArgument(argument: string): boolean {
  return (
    /^-(?:T|F|d)$/u.test(argument) ||
    /^--(?:data(?:-ascii|-binary|-raw|-urlencode)?|form|upload-file)(?:=|$)/u.test(argument)
  );
}

function isDownloadInvocation(invocation: CommandInvocationEvidence): boolean {
  const executable = executableName(invocation);
  const args = literalArguments(invocation);
  if (executable === null || args === null) return false;
  if (executable === "curl")
    return (
      !args.some(isCurlUploadArgument) && args.some((argument) => /^https?:\/\//iu.test(argument))
    );
  if (["wget", "fetch", "aria2c"].includes(executable))
    return args.some((argument) => /^https?:\/\//iu.test(argument));
  if (["invoke-webrequest", "iwr"].includes(executable))
    return args.some((argument) => /^https?:\/\//iu.test(argument));
  return false;
}

function isExecutionInvocation(invocation: CommandInvocationEvidence): boolean {
  const executable = executableName(invocation);
  return (
    executable !== null &&
    [
      "bash",
      "cmd",
      "dash",
      "ksh",
      "node",
      "powershell",
      "pwsh",
      "python",
      "python3",
      "sh",
      "zsh",
    ].includes(executable)
  );
}

function hasIntegrityVerification(
  text: string,
  invocations: readonly CommandInvocationEvidence[],
): boolean {
  const digest = SHA256_LITERAL.test(text);
  for (const invocation of invocations) {
    const executable = executableName(invocation);
    const args = literalArguments(invocation);
    if (executable === null || args === null) continue;
    if (
      digest &&
      ((["sha256sum", "shasum"].includes(executable) && args.includes("-c")) ||
        (executable === "openssl" && args.includes("dgst") && args.includes("-sha256")))
    )
      return true;
    if (
      executable === "gpg" &&
      args.includes("--verify") &&
      args.some((argument) => argument === "--keyring" || argument.startsWith("--keyring="))
    )
      return true;
    if (
      executable === "cosign" &&
      args.includes("verify-blob") &&
      args.some(
        (argument) =>
          argument === "--key" ||
          argument.startsWith("--key=") ||
          argument.startsWith("--certificate-identity="),
      )
    )
      return true;
    if (executable === "minisign" && args.includes("-V") && args.includes("-P")) return true;
  }
  return false;
}

function isDestructiveInvocation(invocation: CommandInvocationEvidence): boolean {
  const executable = executableName(invocation);
  const args = literalArguments(invocation);
  if (executable === null || args === null) return false;
  const flags = args.filter((argument) => argument.startsWith("-")).join("");
  if (executable === "rm") return flags.includes("r") && flags.includes("f");
  if (executable === "git" && args[0] === "reset") return args.includes("--hard");
  if (executable === "git" && args[0] === "clean")
    return flags.includes("f") && (flags.includes("d") || flags.includes("x"));
  if (executable === "remove-item")
    return (
      args.some((arg) => /^-(?:recurse|r)$/iu.test(arg)) &&
      args.some((arg) => /^-(?:force|fo)$/iu.test(arg))
    );
  if (["del", "erase", "rmdir", "rd"].includes(executable)) {
    const normalized = args.map((argument) => argument.toLowerCase());
    return normalized.includes("/s") && normalized.includes("/q");
  }
  return false;
}

function isExternalDestination(value: string): boolean {
  return /^https?:\/\//iu.test(value) || /^[A-Za-z0-9._-]+@?[A-Za-z0-9.-]+:.+/u.test(value);
}

function isTransmissionInvocation(invocation: CommandInvocationEvidence): boolean {
  const executable = executableName(invocation);
  const args = literalArguments(invocation);
  if (executable === null || args === null) return false;
  if (executable === "curl") {
    const hasUpload = args.some(isCurlUploadArgument);
    return hasUpload && args.some(isExternalDestination);
  }
  if (["scp", "rsync"].includes(executable))
    return args.length >= 2 && isExternalDestination(args.at(-1) ?? "");
  if (executable === "gh" && args[0] === "gist" && args[1] === "create") return args.length > 2;
  if (["nc", "netcat", "ncat"].includes(executable))
    return (
      args.length >= 2 &&
      invocation.redirections.some(
        (redirection) => redirection.operator.includes("<") && redirection.target !== null,
      )
    );
  return false;
}

function commandUncertainty(result: CommandLexerResult): SecurityRuleUncertaintyReason | null {
  if (result.resolvedDialect === null) return "ambiguous-command-dialect";
  if (result.issues.some((entry) => entry.code === "malformed-syntax")) return "malformed-command";
  if (result.invocations.some((entry) => entry.state === "dynamic")) return "dynamic-command";
  return null;
}

function addUncertainty(
  context: EvaluationContext,
  statement: InstructionStatement,
  reason: SecurityRuleUncertaintyReason,
): void {
  const source = validatedMapValue(context.sourceById, statement.range.sourceId);
  const key = `${source.sha256}\u0000${String(statement.range.start.utf16Offset)}\u0000${reason}`;
  if (context.uncertaintyKeys.has(key)) return;
  if (context.uncertainties.length >= context.limits.maximumUncertainties)
    throw new RangeError("maximum uncertainties exceeded");
  context.uncertaintyKeys.add(key);
  context.uncertainties.push(
    Object.freeze({
      reason,
      ruleIds: COMMAND_RULE_IDS,
      sourceDigest: source.sha256,
      startUtf16Offset: statement.range.start.utf16Offset,
    }),
  );
}

function evaluateCommandRules(
  context: EvaluationContext,
  statement: InstructionStatement,
  dialect: CommandDialect,
): void {
  const primary = statementLocation(context, statement);
  const result = lexCommandEvidence({
    dialect,
    provenance: {
      collectorId: "rules.security",
      factId: null,
      source: {
        path: primary.path,
        range: { end: primary.range.end, start: primary.range.start },
      },
      sourceKind: "caller",
    },
    text: statement.text,
  });
  context.commandInvocationCount += result.invocations.length;
  const uncertainty = commandUncertainty(result);
  if (uncertainty !== null) {
    addUncertainty(context, statement, uncertainty);
    return;
  }
  if (
    result.invocations.some(isDownloadInvocation) &&
    result.invocations.some(isExecutionInvocation) &&
    !hasIntegrityVerification(statement.text, result.invocations)
  )
    addDiagnostic(context, "ACL402", primary, "download-execute-without-integrity");
  if (
    result.invocations.some(isDestructiveInvocation) &&
    ROUTINE_OR_IMPERATIVE.test(statement.text) &&
    !SAFETY_QUALIFIER.test(statement.text)
  )
    addDiagnostic(context, "ACL403", primary, "routine-destructive-command");
  if (
    !NEGATED_TRANSMISSION.test(statement.text) &&
    result.invocations.some(isTransmissionInvocation)
  )
    addDiagnostic(context, "ACL405", primary, "external-repository-transmission");
}

function immutableRemoteImport(rawSpecifier: string): boolean {
  let url: URL;
  try {
    url = new URL(rawSpecifier);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return false;
  const path = url.pathname;
  if (
    url.hostname === "raw.githubusercontent.com" &&
    /^\/[^/]+\/[^/]+\/[0-9a-f]{40,64}\/.+/iu.test(path)
  )
    return true;
  if (
    url.hostname === "github.com" &&
    /^\/[^/]+\/[^/]+\/(?:blob|raw)\/[0-9a-f]{40,64}\/.+/iu.test(path)
  )
    return true;
  if (url.hostname === "gitlab.com" && /^\/.+\/-\/(?:blob|raw)\/[0-9a-f]{40,64}\/.+/iu.test(path))
    return true;
  return /(?:^|[?#&])sha256=[0-9a-f]{64}(?:$|[&#])/iu.test(rawSpecifier);
}

function evaluateImport(context: EvaluationContext, reference: ImportReference): void {
  if (
    reference.targetKind !== "url" ||
    reference.state === "malformed" ||
    immutableRemoteImport(reference.rawSpecifier)
  )
    return;
  // B03 validation has already established the source relationship before evaluation is entered.
  const source = validatedMapValue(context.sourceById, reference.range.sourceId);
  addDiagnostic(
    context,
    "ACL406",
    location(source, reference.specifierRange),
    "mutable-remote-import",
  );
}

function compareDiagnostics(left: Diagnostic, right: Diagnostic): number {
  return (
    compareUtf8(left.primary.path, right.primary.path) ||
    left.primary.range.start.utf16Offset - right.primary.range.start.utf16Offset ||
    compareUtf8(left.ruleId, right.ruleId)
  );
}

function compareUncertainties(
  left: SecurityRuleUncertainty,
  right: SecurityRuleUncertainty,
): number {
  return (
    compareUtf8(left.sourceDigest, right.sourceDigest) ||
    left.startUtf16Offset - right.startUtf16Offset ||
    compareUtf8(left.reason, right.reason)
  );
}

/**
 * Evaluate ACL400-ACL406 over validated inert evidence. This function has no filesystem, process,
 * environment, model, callback, dynamic-loading, or network capability and never returns a match.
 */
export function evaluateSecurityRules(rawInput: unknown, rawOptions?: unknown): SecurityRuleResult {
  const limits = validateLimits(rawOptions);
  if ("code" in limits) return failure(limits);
  const input = plainDataRecord(rawInput, INPUT_KEYS);
  if (input === undefined)
    return failure(issue("invalid-input", "$", "input must be a closed plain data object"));
  if (
    input.get("recordKind") !== "agent-context-security-rule-input" ||
    input.get("contractVersion") !== SECURITY_RULE_CONTRACT_VERSION
  )
    return failure(issue("invalid-input", "$", "input kind or contract version is invalid"));
  const irValidation = validateInstructionIr(input.get("ir"));
  if (!irValidation.ok)
    return failure(issue("invalid-input", "$.ir", "must satisfy the closed B03 IR contract"));
  const ir = irValidation.value;
  if (ir.statements.length > limits.maximumStatements)
    return failure(issue("resource-limit", "$.ir.statements", "contains too many statements"));
  if (ir.imports.length > limits.maximumImports)
    return failure(issue("resource-limit", "$.ir.imports", "contains too many imports"));
  if (ir.statements.some((statement) => statement.text.length > limits.maximumTextLength))
    return failure(issue("resource-limit", "$.ir.statements", "statement text limit was exceeded"));
  const dialects = validateDialects(input.get("statementDialects"), ir);
  if ("code" in dialects) return failure(dialects);
  const context: EvaluationContext = {
    commandInvocationCount: 0,
    diagnostics: [],
    diagnosticKeys: new Set(),
    limits,
    sourceById: new Map(ir.sources.map((source) => [source.id, source])),
    uncertainties: [],
    uncertaintyKeys: new Set(),
  };
  try {
    for (const statement of ir.statements) {
      const primary = statementLocation(context, statement);
      for (const category of secretCategories(statement.text))
        addDiagnostic(context, "ACL400", primary, `credential-category:${category}`);
      if (requestsSecretAccess(statement.text))
        addDiagnostic(context, "ACL401", primary, "requested-secret-access");
      if (!NEGATED_CONTROL_DISABLE.test(statement.text) && CONTROL_DISABLE.test(statement.text))
        addDiagnostic(context, "ACL404", primary, "disabled-security-control");
      if (!NEGATED_TRANSMISSION.test(statement.text) && NATURAL_TRANSMISSION.test(statement.text))
        addDiagnostic(context, "ACL405", primary, "external-repository-transmission");
      const dialect = dialects.get(statement.id);
      if (dialect !== undefined) evaluateCommandRules(context, statement, dialect);
    }
    for (const reference of ir.imports) evaluateImport(context, reference);
    const suppression = parseSuppressionDirectives(ir);
    const bundle: DiagnosticBundle = Object.freeze({
      contractVersion: DIAGNOSTIC_CONTRACT_VERSION,
      diagnostics: Object.freeze(context.diagnostics.sort(compareDiagnostics)),
      recordKind: "agent-context-diagnostics",
      suppressions: Object.freeze(suppression.directives.map((entry) => entry.record)),
    });
    const validated = validateDiagnosticBundle(bundle, ir.sources);
    if (!validated.ok)
      return failure(
        issue("dependency-failure", "$output", "generated diagnostics failed the B04 contract"),
      );
    const uncertainties = Object.freeze(context.uncertainties.sort(compareUncertainties));
    const result = Object.freeze({
      bundle: validated.value,
      commandLexerContractVersion: COMMAND_LEXER_CONTRACT_VERSION,
      contractVersion: SECURITY_RULE_CONTRACT_VERSION,
      limits,
      metrics: Object.freeze({
        commandInvocationCount: context.commandInvocationCount,
        diagnosticCount: validated.value.diagnostics.length,
        importCount: ir.imports.length,
        statementCount: ir.statements.length,
        suppressionDirectiveCount: suppression.directives.length,
        uncertaintyCount: uncertainties.length,
      }),
      ok: true,
      uncertainties,
    });
    issuedEvaluations.set(result, { directives: suppression.directives, ir });
    return result;
  } catch (error) {
    const resourceLimit =
      error instanceof RangeError ||
      (error instanceof CommandLexerError && error.code === CommandLexerErrorCode.limitExceeded);
    return failure(
      issue(
        resourceLimit ? "resource-limit" : "dependency-failure",
        resourceLimit ? "$input" : "$evaluation",
        resourceLimit ? "security rule resource limit was exceeded" : "security evaluation failed",
      ),
    );
  }
}

/** Apply only parser-issued B08 directives; forged evaluations or directives fail closed. */
export function finalizeSecuritySuppressions(
  evaluation: unknown,
): SecuritySuppressionFinalizationResult {
  if (evaluation === null || typeof evaluation !== "object" || nodeTypes.isProxy(evaluation))
    return Object.freeze({
      issues: Object.freeze([
        issue("invalid-input", "$.evaluation", "must be an issued security evaluation"),
      ]),
      ok: false,
    });
  const issued = issuedEvaluations.get(evaluation);
  if (issued === undefined)
    return Object.freeze({
      issues: Object.freeze([
        issue("invalid-input", "$.evaluation", "must be an issued security evaluation"),
      ]),
      ok: false,
    });
  const result = evaluation as Extract<SecurityRuleResult, { readonly ok: true }>;
  try {
    const matched = matchSuppressionDirectives(result.bundle, issued.directives, issued.ir.sources);
    const suppressedIds = new Set(
      matched.suppressedDiagnostics.map((entry) => entry.diagnostic.id),
    );
    return Object.freeze({
      bundle: matched.bundle,
      ok: true,
      suppressedDiagnostics: Object.freeze(
        matched.bundle.diagnostics.filter((entry) => suppressedIds.has(entry.id)),
      ),
      visibleDiagnostics: Object.freeze(
        matched.bundle.diagnostics.filter((entry) => !suppressedIds.has(entry.id)),
      ),
    });
  } catch {
    return Object.freeze({
      issues: Object.freeze([
        issue("dependency-failure", "$evaluation", "suppression processing failed"),
      ]),
      ok: false,
    });
  }
}
