# Security rule API (F11)

`@agent-context/rules` exposes a deterministic, offline evaluator for ACL400–ACL406. It accepts only
validated B03 instruction IR and an explicit dialect mapping for statements that a caller has
already classified as command-shaped. It cannot read the repository, inspect environment variables,
start a process, resolve an import, load code, call a model, or use the network.

## Contract

Call `evaluateSecurityRules(input, options?)` with:

- `recordKind: "agent-context-security-rule-input"`;
- `contractVersion: "0.1.0"`;
- a closed B03 `ir`; and
- a dense `statementDialects` array containing at most one explicit F02 dialect per statement.

Statements omitted from `statementDialects` still receive credential, secret-location,
safety-control, natural-language transmission, and remote-import checks. They are not interpreted as
commands. `auto` is an explicit request for F02 inference; unresolved, malformed, or dynamic
commands produce a sanitized uncertainty record instead of a security finding.

The successful result contains a valid B04 bundle, the F02 contract version, immutable limits,
aggregate metrics, and uncertainty records. It deliberately does not return source bytes, matched
text, command arguments, URLs, secret excerpts, or credential categories. All diagnostic wording is
constant and describes risk rather than claiming exploitability.

## Rule semantics

| Rule   | Conservative v1 evidence                                                                                                                        |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| ACL400 | Distinct provider token prefixes or recognized private-key armor. No entropy or generic password guess.                                         |
| ACL401 | An affirmative read/collect verb and a recognized secret or broad credential location. Explicit prohibitions are excluded.                      |
| ACL402 | Literal F02 evidence contains both remote download and execution, with no committed SHA-256 check or identity/key-bound signature verification. |
| ACL403 | A literal destructive command is routine/imperative and lacks confirmation, approval, backup, dry-run, or recovery qualification.               |
| ACL404 | An affirmative flag or instruction disables approval, permission, sandbox, or security controls.                                                |
| ACL405 | Literal upload tooling or explicit prose transmits repository/source data externally. Negative policy is excluded.                              |
| ACL406 | A B03 URL import is not an HTTPS URL pinned to a 40–64 hexadecimal revision or explicit SHA-256 identity.                                       |

GitHub distinguishes high-precision provider/generic patterns from less structured AI-detected
passwords, and notes that provider token formats can change. F11 therefore keeps a smaller committed
prefix corpus and treats it as linter evidence, not a replacement for a mature secret scanner. See
[GitHub's supported secret scanning patterns](https://docs.github.com/en/code-security/reference/secret-security/supported-secret-scanning-patterns).

Artifact verification accepts only mechanically visible digest or signature identity evidence. The
policy follows the core requirement that the verified subject digest must match the artifact and
does not treat a versioned URL as integrity proof. See
[SLSA artifact verification](https://slsa.dev/spec/v1.2/verifying-artifacts) and
[Sigstore signature verification](https://docs.sigstore.dev/cosign/verifying/verify/).

## Suppression and redaction

Valid B08 `disable-next-line` directives are carried as applicable records. Pass the exact issued
evaluation to `finalizeSecuritySuppressions`; a forged clone fails closed. Matching remains exact by
source, physical target line, and ACL ID.

The evaluator hashes source identity, location, and a fixed discriminator before fingerprinting. Raw
matches never enter diagnostics, related evidence, suggestions, identifiers, fingerprints, metrics,
uncertainty, or failures. B04 retains the canonical source path required for source binding; all
user-visible sinks must still apply the centralized B05 redactor because a hostile filename may
itself contain credential-shaped text.

## Limits and stability

`SECURITY_RULE_DEFAULT_LIMITS` and `SECURITY_RULE_HARD_LIMITS` bound statements, imports, text,
diagnostics, and uncertainties. Inputs, options, arrays, and dialect mappings are closed plain data;
proxies, accessors, sparse arrays, duplicate mappings, unknown fields, and excessive values fail
without reflecting their content. Ordering uses bytewise UTF-8 comparisons and source offsets only.
