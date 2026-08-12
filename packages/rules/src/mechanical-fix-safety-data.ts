/** Canonical, data-only I12 review artifact. Keep dependency-free for clean-checkout docs checks. */
export const MECHANICAL_FIX_SAFETY_DATA = {
  contractVersion: "0.1.0",
  recordKind: "agent-context-mechanical-fix-safety",
  rules: [
    {
      decision: "refused",
      proof: "Invalid frontmatter has multiple possible repairs.",
      reason: "ambiguous-or-subjective",
      ruleId: "ACL100",
    },
    {
      decision: "refused",
      proof: "Choosing a value changes policy semantics.",
      reason: "ambiguous-or-subjective",
      ruleId: "ACL101",
    },
    {
      decision: "refused",
      proof: "Vendor-aware typo suggestions still require specification review.",
      reason: "ambiguous-or-subjective",
      ruleId: "ACL102",
    },
    {
      decision: "refused",
      proof: "Repairing a glob chooses an activation scope.",
      reason: "ambiguous-or-subjective",
      ruleId: "ACL103",
    },
    {
      decision: "refused",
      proof:
        "Removing a document is an unsupported delete operation; adding content is subjective.",
      reason: "multi-file-or-unsupported-operation",
      ruleId: "ACL104",
    },
    {
      decision: "refused",
      proof: "Moving policy requires a profile-dependent multi-file decision.",
      reason: "multi-file-or-unsupported-operation",
      ruleId: "ACL105",
    },
    {
      decision: "refused",
      proof: "Format migration is profile-dependent and can require multiple files.",
      reason: "multi-file-or-unsupported-operation",
      ruleId: "ACL106",
    },
    {
      decision: "refused",
      proof: "Duplicate-key winner intent is ambiguous.",
      reason: "ambiguous-or-subjective",
      ruleId: "ACL107",
    },
    {
      decision: "refused",
      proof: "A malformed suppression is security-sensitive policy, not disposable syntax.",
      reason: "security-sensitive",
      ruleId: "ACL108",
    },
    {
      decision: "approved",
      proof:
        "For exactly one ACL100-ACL108 target, genuine complete unfiltered F05/B08 evidence proves the parser-owned comment unused. Cross-family, multi-rule, wildcard/malformed, and ACL109 targets remain refused because this authority does not prove the complete enabled scheduled rule set; expansion requires a new reviewed contract version.",
      reason: "approved-exact-unused-suppression",
      ruleId: "ACL109",
    },
    {
      decision: "refused",
      proof: "Selecting or removing a missing reference changes policy semantics.",
      reason: "changes-policy-semantics",
      ruleId: "ACL150",
    },
    {
      decision: "refused",
      proof: "Breaking an import cycle requires choosing which policy edge to remove.",
      reason: "changes-policy-semantics",
      ruleId: "ACL151",
    },
    {
      decision: "refused",
      proof: "Boundary-escaping references are security-sensitive.",
      reason: "security-sensitive",
      ruleId: "ACL152",
    },
    {
      decision: "refused",
      proof: "No repository-relative replacement is proven by the diagnostic.",
      reason: "changes-policy-semantics",
      ruleId: "ACL153",
    },
    {
      decision: "refused",
      proof: "Remote loading behavior is profile/version-dependent.",
      reason: "profile-or-version-dependent",
      ruleId: "ACL154",
    },
    {
      decision: "refused",
      proof: "Supported reference syntax is profile/version-dependent.",
      reason: "profile-or-version-dependent",
      ruleId: "ACL155",
    },
    {
      decision: "refused",
      proof:
        "A unique case match does not bind the replaceable source token to canonical path bytes.",
      reason: "source-token-not-proven",
      ruleId: "ACL156",
    },
    {
      decision: "refused",
      proof: "Replacing an empty scope chooses intended targets.",
      reason: "changes-policy-semantics",
      ruleId: "ACL200",
    },
    {
      decision: "refused",
      proof: "Adding scope chooses intended targets.",
      reason: "changes-policy-semantics",
      ruleId: "ACL201",
    },
    {
      decision: "refused",
      proof: "Narrowing scope changes activation semantics.",
      reason: "changes-policy-semantics",
      ruleId: "ACL202",
    },
    {
      decision: "refused",
      proof: "Removing or relocating shadowed policy can affect other targets.",
      reason: "changes-policy-semantics",
      ruleId: "ACL203",
    },
    {
      decision: "refused",
      proof: "Cross-agent scope reconciliation is a policy choice.",
      reason: "changes-policy-semantics",
      ruleId: "ACL204",
    },
    {
      decision: "refused",
      proof: "Ambiguous nesting cannot support an automatic transformation.",
      reason: "changes-policy-semantics",
      ruleId: "ACL205",
    },
    {
      decision: "refused",
      proof: "Excluding generated/vendor files changes activation policy.",
      reason: "changes-policy-semantics",
      ruleId: "ACL206",
    },
    {
      decision: "refused",
      proof: "Conflicting package-manager policy requires an owner decision.",
      reason: "ambiguous-or-subjective",
      ruleId: "ACL250",
    },
    {
      decision: "refused",
      proof: "Required/prohibited conflicts require an owner decision.",
      reason: "ambiguous-or-subjective",
      ruleId: "ACL251",
    },
    {
      decision: "refused",
      proof: "Workflow conflicts require an owner decision.",
      reason: "ambiguous-or-subjective",
      ruleId: "ACL252",
    },
    {
      decision: "refused",
      proof: "Near-duplicate similarity does not prove removable equivalence.",
      reason: "ambiguous-or-subjective",
      ruleId: "ACL253",
    },
    {
      decision: "refused",
      proof:
        "Generic vendor divergence is semantic; I13 synchronization remains separate authority.",
      reason: "ambiguous-or-subjective",
      ruleId: "ACL254",
    },
    {
      decision: "refused",
      proof: "One observed inherited repeat does not prove removal preserves every target/profile.",
      reason: "changes-policy-semantics",
      ruleId: "ACL255",
    },
    {
      decision: "refused",
      proof: "Repairing a missing task requires choosing repository behavior.",
      reason: "ambiguous-or-subjective",
      ruleId: "ACL300",
    },
    {
      decision: "refused",
      proof: "Rewriting a package-manager command can change command semantics.",
      reason: "ambiguous-or-subjective",
      ruleId: "ACL301",
    },
    {
      decision: "refused",
      proof: "Repairing a missing resource requires owner intent.",
      reason: "ambiguous-or-subjective",
      ruleId: "ACL302",
    },
    {
      decision: "refused",
      proof: "Adding/removing a tool changes project policy or dependencies.",
      reason: "ambiguous-or-subjective",
      ruleId: "ACL303",
    },
    {
      decision: "refused",
      proof: "Runtime version reconciliation requires owner intent.",
      reason: "ambiguous-or-subjective",
      ruleId: "ACL304",
    },
    {
      decision: "refused",
      proof: "Removing prose because tooling overlaps it can discard rationale or agent policy.",
      reason: "ambiguous-or-subjective",
      ruleId: "ACL305",
    },
    {
      decision: "refused",
      proof: "Splitting/narrowing context changes policy organization and activation.",
      reason: "ambiguous-or-subjective",
      ruleId: "ACL350",
    },
    {
      decision: "refused",
      proof: "Extracting a code block requires create/import/multi-file decisions.",
      reason: "ambiguous-or-subjective",
      ruleId: "ACL351",
    },
    {
      decision: "refused",
      proof: "Rewriting vague prose is subjective.",
      reason: "ambiguous-or-subjective",
      ruleId: "ACL352",
    },
    {
      decision: "refused",
      proof: "Splitting requirements is semantic and subjective.",
      reason: "ambiguous-or-subjective",
      ruleId: "ACL353",
    },
    {
      decision: "refused",
      proof: "Removing repository description may discard intentional context.",
      reason: "ambiguous-or-subjective",
      ruleId: "ACL354",
    },
    {
      decision: "refused",
      proof: "Reducing import amplification changes composition semantics.",
      reason: "ambiguous-or-subjective",
      ruleId: "ACL355",
    },
    {
      decision: "refused",
      proof: "Credential evidence must not be automatically exposed, redacted, or destroyed.",
      reason: "security-sensitive",
      ruleId: "ACL400",
    },
    {
      decision: "refused",
      proof: "Secret-access policy is security-sensitive.",
      reason: "security-sensitive",
      ruleId: "ACL401",
    },
    {
      decision: "refused",
      proof: "Selecting an integrity pin requires trusted external provenance.",
      reason: "security-sensitive",
      ruleId: "ACL402",
    },
    {
      decision: "refused",
      proof: "Rewriting destructive-command policy is security-sensitive.",
      reason: "security-sensitive",
      ruleId: "ACL403",
    },
    {
      decision: "refused",
      proof: "Safety-control policy is security-sensitive.",
      reason: "security-sensitive",
      ruleId: "ACL404",
    },
    {
      decision: "refused",
      proof: "External transmission policy is security-sensitive.",
      reason: "security-sensitive",
      ruleId: "ACL405",
    },
    {
      decision: "refused",
      proof: "Pinning mutable imports requires trusted content and provenance.",
      reason: "security-sensitive",
      ruleId: "ACL406",
    },
    {
      decision: "refused",
      proof: "Creating shared policy changes cross-agent semantics and files.",
      reason: "changes-policy-semantics",
      ruleId: "ACL450",
    },
    {
      decision: "refused",
      proof: "Choosing a canonical divergent policy requires owner intent.",
      reason: "changes-policy-semantics",
      ruleId: "ACL451",
    },
    {
      decision: "refused",
      proof: "Import/nesting support is profile/version-dependent.",
      reason: "profile-or-version-dependent",
      ruleId: "ACL452",
    },
    {
      decision: "refused",
      proof: "Editor-only behavior is surface/version-dependent.",
      reason: "profile-or-version-dependent",
      ruleId: "ACL453",
    },
    {
      decision: "refused",
      proof: "Updating standards is an explicit signed network/lockfile operation.",
      reason: "standards-operation-required",
      ruleId: "ACL500",
    },
    {
      decision: "refused",
      proof: "Installing a newer pack is an explicit signed standards operation.",
      reason: "standards-operation-required",
      ruleId: "ACL501",
    },
    {
      decision: "refused",
      proof: "Engine upgrade is outside repository text fixing.",
      reason: "standards-operation-required",
      ruleId: "ACL502",
    },
    {
      decision: "refused",
      proof: "Invalid trust material must be quarantined, never rewritten from a diagnostic.",
      reason: "standards-operation-required",
      ruleId: "ACL503",
    },
    {
      decision: "refused",
      proof: "Deprecation migration depends on the selected specification version.",
      reason: "profile-or-version-dependent",
      ruleId: "ACL504",
    },
    {
      decision: "refused",
      proof:
        "Lockfile creation is unsupported create-file authority and needs verified standards state.",
      reason: "multi-file-or-unsupported-operation",
      ruleId: "ACL505",
    },
    {
      decision: "refused",
      proof: "Preview behavior is intentionally inactive information.",
      reason: "standards-operation-required",
      ruleId: "ACL506",
    },
    {
      decision: "refused",
      proof: "Budget reduction requires semantic/context-quality judgment.",
      reason: "efficiency-recommendation-only",
      ruleId: "ACL550",
    },
    {
      decision: "refused",
      proof: "Tail-context reduction requires semantic/context-quality judgment.",
      reason: "efficiency-recommendation-only",
      ruleId: "ACL551",
    },
    {
      decision: "refused",
      proof: "Duplicate metrics do not prove safe source deletion.",
      reason: "efficiency-recommendation-only",
      ruleId: "ACL552",
    },
    {
      decision: "refused",
      proof: "Scope projection is a recommendation, not equivalence proof.",
      reason: "efficiency-recommendation-only",
      ruleId: "ACL553",
    },
    {
      decision: "refused",
      proof: "Import amplification reduction changes composition.",
      reason: "efficiency-recommendation-only",
      ruleId: "ACL554",
    },
    {
      decision: "refused",
      proof: "A safe consolidation recommendation does not grant generic multi-file authority.",
      reason: "efficiency-recommendation-only",
      ruleId: "ACL555",
    },
    {
      decision: "refused",
      proof: "Density is a metric, not proof that prose is removable.",
      reason: "efficiency-recommendation-only",
      ruleId: "ACL556",
    },
    {
      decision: "refused",
      proof: "Tokenizer incompatibility requires recomputation, not source edits.",
      reason: "efficiency-recommendation-only",
      ruleId: "ACL557",
    },
    {
      decision: "refused",
      proof: "Unbenchmarked projected savings cannot justify a source mutation.",
      reason: "efficiency-recommendation-only",
      ruleId: "ACL558",
    },
  ],
} as const;

function markdownCell(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("|", "\\|").replaceAll("\n", " ");
}

export function renderMechanicalFixSafetyDataMarkdown(): string {
  const lines = [
    "# Mechanical-fix safety matrix",
    "",
    "This generated review artifact is the human companion to the frozen I12",
    "`MECHANICAL_FIX_SAFETY_MATRIX`. `Approved` means same-process rule evidence can mint I11",
    "authority only under the stated proof; `Refused` means guidance can never grant writes. The",
    "closed schema is packaged as",
    "`@agent-context/rules/schemas/mechanical-fix-safety.v0.schema.json`.",
    "The schema enforces exact one-to-one `REQUIRED_RULE_IDS` coverage, canonical ordering, and",
    "well-formed Unicode. The packaged runtime validator additionally enforces canonical decision,",
    "reason, and proof equality plus a 4 KiB UTF-8 proof ceiling; duplicate, omitted, substituted,",
    "reordered, policy-drifted, or proof-drifted rows are invalid.",
    "",
    "| Rule | Decision | Reviewed proof |",
    "| --- | --- | --- |",
  ];
  for (const rule of MECHANICAL_FIX_SAFETY_DATA.rules) {
    lines.push(
      `| ${rule.ruleId} | ${rule.decision === "approved" ? "**Approved, conditional**" : "Refused"} | ${markdownCell(rule.proof)} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}
