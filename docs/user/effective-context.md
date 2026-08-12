# Understanding effective context

Effective context is the set of instruction documents that a specific agent surface may use for a
specific repository target. It is not simply every instruction file concatenated together.

The linter reports five separate questions:

1. Was a document active, inactive, or dependent on information the client did not expose?
2. Was it selected, shadowed by another filename, empty, truncated, or unavailable?
3. Does the client establish a load order or only part of one?
4. Could two possibly active documents contain competing instructions?
5. Which imports were loaded, repeated, rejected, unavailable, cyclic, or resource-limited?

An ambiguity is an honest result, not a scan failure. For example, “semantic precedence unknown”
means the linter knows the documents and their loading order but the pinned evidence does not prove
which instruction wins when their prose conflicts. Likewise, an indeterminate activation means the
client depends on UI, model selection, unknown glob behavior, external state, or a different target
trace. The linter does not guess.

`assembly.state: exact` means the reported text is byte-for-byte the context exposed by the profile
resolver and all contributing external context was supplied. `partial` means some known context
cannot be assembled exactly; the result may still retain the known portion of the text. `unknown`
means no reliable combined text is available. A deterministic `sequence` under `ordering: unknown`
or `unordered` is only stable presentation; it is not a claim that the client applies documents in
that order.

Normal scans remain offline and read-only. Imported files are represented from the already bounded,
root-jailed import graph. E05 never follows a new path, runs repository commands, or asks a model to
interpret which instruction is more important.
