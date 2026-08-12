# GA profile observation review — 2026-08-02

Status: D16 reviewed evidence. No behavioral compatibility claim was promoted.

This review covers every `ga-required` surface in the canonical D01 inventory. It uses the D15
closed plan/transcript contract and project-owned synthetic fixtures only. No model request,
credential read, repository command, repository write, user-configuration read, or external
repository mutation occurred. Network access was used separately by the maintainer to retrieve
current first-party release metadata; it was never available to an observation process.

The machine-readable source of truth is
[`conformance/observations/v0/d16/review.json`](../../conformance/observations/v0/d16/review.json).
The D16 validator recomputes every plan, transcript, fixture, inventory, and supporting-evidence
digest; validates all three JSON contracts; checks D01 fixture/profile parity; and requires exactly
one record for each GA surface.

## Reviewed matrix

| Profile surface | Current pin and provenance | D15 result | Fixture disposition |
| --- | --- | --- | --- |
| Codex CLI | `0.146.0`; official `rust-v0.146.0` release; local executable SHA-256 `ae1d3ffe…` | `observed` metadata only: exact version match, exit zero, unchanged workspace | Existing 0.146.0 root-order fixture remains matched by the earlier no-model prompt-input observation; D15 itself adds no behavioral authority |
| Claude Code | `2.1.220`; official release published 2026-07-25; darwin-arm64 asset SHA-256 `1c895d3d…` | `blocked`: no guaranteed no-model instruction-list signal | Existing `2.1.217` fixture remains the compatible minimum-version branch; simultaneous-source order and other client-only behavior remain unknown |
| Copilot CLI | `1.0.77`; official release published 2026-07-30; darwin-arm64 asset SHA-256 `3ab9366c…` | `blocked`: no installed safe local signal | New explicit-unknown fixture records documented discovery and unknown cross-family order |
| Copilot VS Code | `0.43.0`; latest official GitHub release record retrieved 2026-08-02; VSIX SHA-256 `797dc877…` | `blocked`: IDE surface requires reviewed manual observation | Existing description-only fixture stays unpinned and contradictory; the release record does not prove the deployed Marketplace build or behavior |
| Gemini CLI | stable `0.53.1`; official release published 2026-07-31; bundle SHA-256 `aba03c7a…` | `blocked`: `/memory` is interactive and no guaranteed no-model signal exists | Three current-version fixtures retain JIT, import-depth, and ignore contradictions; source-equivalence evidence remains valid |
| Cursor IDE | locally observed `3.12.30`, revision `63a2996a…`; launcher SHA-256 `de63d726…` | `blocked`: IDE surface requires reviewed manual observation | New explicit model-selection fixture preserves selected/not-selected alternatives |
| Cursor Agent CLI | locally observed `2026.05.24-dda726e`; launcher SHA-256 `b7babf47…` | `blocked`: the installed launcher resides under user state and requires child execution denied by D15 | New explicit-unknown fixture preserves AGENTS/MDC ordering alternatives |

Official release asset digests in this table came from the first-party GitHub release API response;
those assets were not downloaded or executed. Cursor launcher digests bind the inert local metadata
record without storing a personal path. The committed Codex transcript binds both the selected
binary and `/usr/bin/sandbox-exec` by digest and before/after identity.

## Version and fixture mismatch review

- Claude `2.1.220` is newer than the fixture's `2.1.217` safety boundary. The implemented resolver
  already treats `2.1.217` and later as that bounded branch. Without behavioral evidence, D16 does
  not rewrite ordering or activation expectations.
- The Copilot VS Code fixture intentionally has no client version. Pinning the latest official
  GitHub release artifact does not establish which extension/editor build a user runs, so the
  description-only contradiction remains explicit.
- Codex, Copilot CLI, Gemini, and both Cursor surfaces have exact fixture/pin versions. Exact version
  parity is metadata, not proof of instruction discovery unless the fixture already cites a reviewed
  behavioral observation.

No observed output contradicted a fixture because the only runnable D15 operation was `--version`.
Blocked results are retained as evidence and were not rewritten as successful observations.

## Remaining unknowns

- Claude instruction inventory/order, compaction, descendant activation, approvals, and malformed
  recovery require a safe local inspection facility or explicit authorization for a controlled
  client session.
- Copilot CLI ordering and VS Code applicability require a version-pinned local diagnostic/manual
  observation. No chat request was sent.
- Gemini `/memory`, JIT placement, ignore interaction, and import contradictions remain documented,
  source-derived, conditional, or unknown.
- Cursor model selection, mixed MDC fields, glob encoding, nested interaction, reference bases,
  legacy coexistence, and cross-format order remain conditional/unknown on both surfaces.

These states satisfy D16's explicit-unknown branch without weakening G2: false certainty remains
non-waivable. Future evidence must create a new dated review rather than overwrite these records.

## Reproduction

```sh
pnpm conformance:observations:validate
pnpm test:conformance
```

Normal `scan`, `list`, and `explain` paths do not load or execute this maintainer evidence tooling.
The randomly selected external GitHub repositories are unrelated read-only release-validation
targets and were not accessed for D16.
