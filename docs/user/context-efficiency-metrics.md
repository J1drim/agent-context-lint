# Understanding context-efficiency metrics

Context-efficiency metrics explain where instruction tokens come from and how they are observed
across files, targets, and supported client profiles. They are evidence for finding review targets;
they are not automatic judgments about whether an instruction is good or necessary.

## Reading the report

- **Exact duplicate tokens** identify repeated normalized statement text. Every cluster links to the
  original files and source ranges. Near-duplicate clusters are similarity candidates for human
  review, not semantic matches.
- **Dead scope** identifies a document that was never included in an exhaustive, complete observed
  target set. A sampled or incomplete run reports `unknown` instead of guessing.
- **Broad scope** shows the share of complete observed targets that include a document. High
  coverage can be intentional for repository-wide policy.
- **Import amplification** compares effective loaded tokens with unique source tokens for a target.
  `20,000` basis points means the effective context is twice the unique source total. Imports and
  repeated occurrences can produce amplification without indicating an error.
- **Instruction density** reports F03-classified actionable statements per 1,000 raw tokens. It does
  not measure clarity, correctness, or compliance.
- **Cross-profile divergence** shows path and token differences observed between profiles for the
  same target. Even an `observational-match` does not prove that two clients interpret or obey the
  instructions equivalently.

Values ending in `BasisPoints` use 10,000 as one whole ratio. `null`, `partial`, `unknown`, a
missing comparison, or `not-applicable` is meaningful: the available evidence does not support a
numeric claim. Do not convert those states to zero.

For review, start with the cited file paths, statement ranges, and target contributions. Confirm
that the document is eligible for the profile and that the observed target set represents your
intended usage before moving, consolidating, or deleting instructions. See the full
[API definitions and formulas](../api/context-efficiency-metrics.md) for exact interpretation. The
separate [context-efficiency score guide](context-efficiency-scoring.md) explains how these neutral
measurements feed the versioned heuristic and when no score is available.
