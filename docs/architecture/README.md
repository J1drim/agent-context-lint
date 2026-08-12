# Architecture decisions

This directory records decisions that constrain the implementation of Agent
Context Linter. An accepted architecture decision record (ADR) is normative:
implementation and release work must follow it until another accepted ADR
supersedes it.

## Decision index

| ADR | Status | Decision |
|---|---|---|
| [ADR-0001](decisions/0001-runtime-and-platform-support.md) | Accepted | Node.js runtime and operating-system support |
| [ADR-0002](decisions/0002-package-manager-and-version-policy.md) | Accepted | pnpm and version pin/update policy |
| [ADR-0003](decisions/0003-esm-packaging-and-public-api.md) | Accepted | ESM packaging and public API boundaries |
| [ADR-0004](decisions/0004-sarif-product-subset-v2.md) | Accepted | SARIF product subset v2 and GitHub fingerprints |
| [ADR-0005](decisions/0005-closed-cli-scan-bundle.md) | Accepted | Closed audited ESM bundle for the production scan runtime |

## Implementation contracts

- [Tokenizer provider contract](tokenizer-plugin-contract.md) — data-only exact/estimate identity,
  static provider authority, and comparison compatibility rules.
- [Deterministic estimate tokenizer](estimate-tokenizer.md) — versioned four-byte estimate,
  Unicode/Markdown fixtures, and platform-stability contract.
- [Optional exact tokenizer providers](exact-tokenizer-providers.md) — data-only package format,
  WebAssembly capability boundary, deadlines, integrity, and explicit estimate fallback.
- [Occurrence-aware token accounting](../api/occurrence-token-accounting.md) — exact definitions
  and reconciliation of raw, imported, unique, always-on, effective, and truncated contributions.
- [Deterministic target sampling](../api/target-sampling.md) — exhaustive small-repository and
  coverage-proven workspace/scope/language/critical-path sampling for larger repositories.
- [Parser property and fuzz suite](../development/parser-fuzzing.md) — bounded deterministic seeds,
  persisted regressions, containment properties, and complexity guards across parser surfaces.
- [Per-profile target token distributions](../api/profile-target-distributions.md) — exact
  nearest-rank effective-token distributions over complete sampled target accountings.
- [Copilot instruction syntax](../api/copilot-instruction-syntax.md) — fail-closed path metadata and
  profile-dependent repository reference candidates without universal Copilot semantics.
- [Profile-owned glob dialects](../api/profile-glob-dialects.md) — closed profile/surface ownership,
  intentional cross-profile differences, explicit unknowns, and bounded matching mechanisms.
- [Codex CLI AGENTS resolver](../api/codex-cli-profile.md) — profile-owned root-to-CWD discovery,
  filename selection, aggregate byte budgeting, explicit external context, and safe uncertainty.
- [AGENTS Markdown syntax adapter](../api/agents-markdown.md) — bounded syntax-only conversion from
  authorized bytes into source/AST/instruction records without invented activation semantics.
- [Copilot surface profiles](../api/copilot-profiles.md) — separate local and hosted surface
  descriptors plus pure, three-state discovery and activation resolution.
- [Claude Code syntax and resolver](../api/claude-code-profile.md) — bounded memory/rule syntax,
  data-only profile identity, and pure event/version/settings-aware resolution with explicit
  uncertainty.

## Status meanings

- **Proposed:** open for review and not yet binding.
- **Accepted:** approved and binding.
- **Superseded:** replaced by another accepted ADR.
- **Rejected:** considered but not adopted.

Every ADR states its consequences and rejected alternatives. Changes to an
accepted decision require a new ADR that identifies what it supersedes; do not
silently rewrite the earlier decision's history.
