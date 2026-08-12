# Understanding an explanation

The executable workflow is documented in
[Listing, explaining, rules, and initialization](commands.md). `agent-context-lint explain <target>`
now invokes the E05/E06 pipeline; this page describes the underlying explanation model.

An explanation answers why each instruction document or import is included, excluded, or conditional
for a specific target. It retains uncertainty instead of guessing how a client behaves.

For every target, check `accounting` first. Its document and occurrence totals account for every
item considered by the effective-context resolver. Then inspect each item's `disposition` and
machine-stable reason codes:

- `included` means the known profile state selects the document or loaded occurrence;
- `excluded` means it is inactive, shadowed, rejected, unavailable, cyclic, or resource-limited;
- `conditional` means missing or client-dependent evidence prevents a definite answer.

Selected documents can still be empty, unavailable, or truncated, so disposition and content state
are separate. A document can also carry an ambiguity reason when its activation or precedence is not
fully established. Conflicts are opportunities between possibly active documents, not proof that
their prose contradicts.

Without a trace, the result is a static target projection. With a validated event trace, the result
includes matching target events plus launch/session events and a digest of the canonical trace. This
same trace is applied to supported Claude, Gemini, or Cursor state before effective context is
resolved, so known reads, references, compaction, reload, manual mentions, and selections can change
the reported activation where the selected profile has a matching event contract. Unsupported and
uncertain events remain non-authoritative.

Recognized profile imports are represented by occurrence rows from bounded root-jailed C10 graphs
and same-process E04 DAGs. Repeated imports, cycles, missing targets, root-boundary rejection, and
limits remain explicit. For Cursor, use `--agent cursor-agent --surface cursor-agent/cli` or
`--surface cursor-agent/ide` when the surface distinction matters; omission keeps the IDE default.
Copilot explanations remain target-driven: a trace is validated and shown as bound evidence, but
Copilot events do not change activation because the supported Copilot profile contract has no
event-aware runtime input. Only Copilot CLI uses its documented reference/import graph behavior.

The installed `explain` command performs repository discovery, JSON trace reading, profile
resolution, import-DAG construction, projection, and output. It never executes repository commands,
writes repository files, contacts a model, or uses the network.
