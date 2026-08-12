# SARIF formatter

I06 converts a validated B04 diagnostic bundle and its exact B03 source documents into deterministic
SARIF 2.1.0 for generic SARIF consumers and GitHub code scanning. The formatter is offline,
model-free, filesystem-free, and does not execute repository content.

## API

`formatSarifDiagnostics(bundle, sources, options)` returns a frozen result union. Success contains:

- `output`: the deeply frozen product-subset v2 model;
- `text`: canonical compact JSON ending in exactly one LF; and
- `byteLength`: the UTF-8 size of `text`.

The required closed options object contains:

| Field                      | Meaning                                                                          |
| -------------------------- | -------------------------------------------------------------------------------- |
| `toolVersion`              | Canonical semantic version emitted as `driver.semanticVersion`                   |
| `informationUri`           | Credential-free HTTPS product URI                                                |
| `ruleDocumentationBaseUri` | Credential-free HTTPS directory used to resolve registry documentation paths     |
| `profileVersions`          | Non-empty, sorted profile identity map with profile and observed client versions |

Unknown fields, accessors, symbols, proxies, exotic prototypes, malformed versions/URIs, undeclared
diagnostic profiles, invalid B04/source relationships, and unknown rule IDs fail without producing a
partial log. Errors are fixed, bounded data and do not echo repository-controlled values.

## Ordering and suppression

Active results preserve caller diagnostic-array order exactly. The upstream F15 pipeline owns
canonical diagnostic sorting, deduplication, severity policy, and suppression matching. The
formatter only omits diagnostics whose path fingerprints occur in B04 suppression records with state
`suppressed`.

Referenced rule descriptors are unique and sorted by rule ID so `ruleIndex` is stable. Object keys
are canonicalized by the B05 serializer; array order retains its contract meaning.

## GitHub-compatible mapping

- `error` and `warning` remain those levels; diagnostic `info` becomes SARIF `note`.
- The first and only primary location is a canonical percent-encoded repository-relative URI. No
  checkout root, absolute path, URI base, query, fragment, or host path is emitted.
- B03 zero-based, half-open UTF-16 ranges become SARIF one-based ranges. `endColumn` remains the
  character after the region, as GitHub expects.
- Source, repository-fact, and resolution evidence locations become deduplicated related locations
  in evidence order. IDs are consecutive from 1. Result messages contain GitHub's documented
  `[related location N](N)` links. Spec evidence contributes provenance but no invented source
  location.
- Every referenced rule includes ID/name, short and full descriptions, plain and Markdown help,
  HTTPS `helpUri`, default level, category/fix/owner/precision metadata, tags, and GitHub's
  `problem.severity` property.
- Each result carries rule version plus sorted profile, surface, and specification snapshot IDs.

GitHub currently uses only the exact unversioned `primaryLocationLineHash` key for this form of
third-party alert tracking. `computeGithubPrimaryLocationLineHashes` reproduces the CodeQL Action
algorithm: rolling unsigned 64-bit base-37 hashes over 100 non-space/tab UTF-16 code units,
normalized line endings, EOF padding, and an occurrence suffix for identical hashes. The product
also emits the validated B04 SHA-256 values as `agentContextPath/v1` and `agentContextSemantic/v1`.

## Safety and limits

The formatter validates before reading diagnostic fields and never mutates caller data. Repository
text and rule/profile strings pass through the common B05 sanitizer and bounds: known credential
forms are redacted, ANSI escapes are neutralized, and C0/C1 plus bidirectional formatting controls
become inert replacement characters. Related locations are capped at 128; B05 caps rules and results
at 10,000. A completed serialized log over 10,000,000 bytes is rejected, below GitHub's documented
10 MB compressed-upload ceiling rather than relying on compression ratio.

The final model is serialized, reparsed, validated again, and deeply frozen. The output is
guaranteed to satisfy the current runtime contract before success is returned.

## Verification fixtures

- `packages/formatters/test/fixtures/sarif.valid.json` is the canonical golden.
- `packages/formatters/test/fixtures/github-code-scanning.annotation.json` pins the
  annotation-facing URI, region, level, rule/help metadata, provenance, and partial fingerprints.
- Both the generated result and committed core fixtures validate against the exact vendored OASIS
  Draft-04 schema and the closed product schema.
- Fixed hash vectors cover LF/CRLF, whitespace, duplicate content, Unicode code-unit behavior, and
  EOF. Negative tests cover malformed contracts, hostile option objects, secrets/controls, bad URIs,
  unknown rules, missing profiles, and old/new schema negotiation.

External repositories are read-only validation targets. Testing must not create branches, commits,
patches, pull requests, uploads, issues, comments, or notifications in those repositories. Any
failure found there is reproduced in a minimal fixture owned by this repository.

## Reviewed primary sources

Reviewed 2026-08-02:

- [GitHub Enterprise Cloud SARIF support](https://docs.github.com/en/enterprise-cloud@latest/code-security/reference/code-scanning/sarif-files/sarif-support)
- [GitHub CodeQL Action fingerprint source](https://github.com/github/codeql-action/blob/main/src/fingerprints.ts)
- [OASIS SARIF 2.1.0 Plus Errata 01](https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/sarif-v2.1.0-errata01-os-complete.html)
- [OASIS Errata 01 schema](https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/schemas/sarif-schema-2.1.0.json)

See [ADR-0004](../architecture/decisions/0004-sarif-product-subset-v2.md) for compatibility
rationale.
