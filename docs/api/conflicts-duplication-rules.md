# Conflicts and duplication rules API

Ticket F08 implements deterministic ACL250–ACL255 evaluation in `@agent-context/rules`.
`evaluateConflictsDuplicationRules(input, options?)` accepts a closed version `0.1.0` record:

```ts
interface ConflictsDuplicationInput {
  recordKind: "agent-context-conflicts-duplication-rule-input";
  contractVersion: "0.1.0";
  ir: InstructionIr;
  contexts: readonly EffectiveContextResolution[];
}
```

`ir` must satisfy B03. Each context must be an object issued by E05's `resolveEffectiveContext` in
the same process; serialized or caller-forged activation and precedence claims are rejected. Inputs
are not callbacks and grant no filesystem, process, environment, clock, model, network,
dynamic-module, or fix capability.

## Rule semantics

| Rule   | Emission condition                                                                                                                                                                                         |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ACL250 | Two mandatory, different package-manager selections are visible for the same target in one E05 context.                                                                                                    |
| ACL251 | F03 proves the same structured action/object is both mandatory and prohibited in one E05 context. Package-manager command evidence is compared as a command, not misread as a package-manager prohibition. |
| ACL252 | Two explicit formatter selections, or two different `run only` selections for the same test/build/format/commit workflow, are effective together.                                                          |
| ACL253 | An F04 near-duplicate edge at the documented similarity threshold joins statements from different effective documents.                                                                                     |
| ACL254 | Effective vendor-specific policy differs from effective canonical `AGENTS.md` policy for the same target in a high-confidence package-manager, formatter, ownership, or polarity coordinate.               |
| ACL255 | An exact F04 cluster repeats a parent-directory instruction in a more-specific document that E05 orders after it.                                                                                          |

Inactive, shadowed, conditional, unavailable, unmapped, and truncated-out content cannot produce a
definitive finding. Relevant incompleteness is retained in `uncertainties`; a partial context does
not erase a contradiction already proved between two known active statements.

F03 can expose overlapping list-item and paragraph candidates for one Markdown source span. F08
collapses only overlapping candidates with identical canonical F03 text, choosing the narrowest
range. Separate repeated statements remain distinct F04 entries.

## Result and failures

A successful result includes a B04 `bundle`, original B03 `sources`, immutable uncertainties,
resource metrics, and the exact F03, F04, and E05 contract versions used. Diagnostics contain fixed
messages and source-related locations; source prose is not copied into messages or evidence labels.
No F08 finding has an automatic fix.

Malformed, accessor, proxy, sparse, cyclic, over-limit, forged-context, dependency, and generated
contract failures return `{ ok: false, issues }`. Limits cover contexts, statements, JSON snapshot
nodes/string bytes, comparisons, diagnostics, text length, and uncertainties. Options are closed and
cannot exceed exported hard caps.

Call `finalizeConflictsDuplicationSuppressions(result)` to apply only B08 directives parsed during
that exact evaluation. A cloned or forged result is rejected. The returned bundle preserves
suppressed diagnostics for audit while formatters hide them according to the B04 suppression state.

## Precision status

ACL250 and ACL251 are enabled as default errors only for mandatory, structured conclusions. The
committed labeled corpus has at least eight positive labels per error rule and requires precision of
at least 95%; every committed case currently agrees exactly. This seeded ticket evidence does not
replace the independent K02/K03 50-repository calibration and Wilson-interval release gate.
