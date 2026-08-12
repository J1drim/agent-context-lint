# Explain projection development

E06 is a presentation projection over E05 and optional E03 evidence. It must not rediscover files,
rerun profiles, reinterpret prose, invent client precedence, or convert an unknown into a definite
answer.

## Invariants

- Accept only same-process E05 outputs. The issuance guard is a capability check, not a persistence
  format.
- Validate the closed raw envelope before traversing it. Do not invoke accessors or proxy traps.
- Require one profile/client/surface/specification identity for a multi-target projection.
- Account for every E05 document and E04 occurrence exactly once as included, excluded, or
  conditional. Reasons explain the disposition without changing upstream facts.
- Treat a supplied E03 trace as target-matched evidence. It is not authority to recompute an E05
  result and must not be described as causal unless the caller also used it upstream.
- Preserve E05 arrays and records as immutable facts. Freeze every new E06 record and array.
- Use locale-independent UTF-8 ordering and canonical E03 digests so permutations and host locale do
  not alter output.
- Fail before aggregate output exceeds a public resource limit.

## Extending the projection

When E05 adds a document, occurrence, ambiguity, or content state, add an explicit E06 mapping and
positive, negative, boundary, malformed-input, resource, and determinism coverage. A new reason code
must be stable, non-reflective, documented, and linked to its upstream source code where applicable.
Do not make reason prose part of the machine contract; consumers should use `code` and `kind`.

I03 owns CLI file reading and the `explain <target> --trace <file>` grammar. That adapter parses
JSON as data and normalizes it once at the untrusted boundary. It must feed the normalized trace
into the selected stateful D-series profile before E05, bind every C10 graph through E04 with the
same trace, pass the supplied trace to E06, and format the returned projection. The adapter maps
only known, profile-supported events; a profile with a narrower event vocabulary must not
reinterpret an uncertain or unsupported event as activation. E06 remains usable without the CLI and
receives no path or I/O capability.

Cursor is one profile with two independent surfaces. The CLI's closed grammar accepts
`--surface cursor-agent/cli` and `--surface cursor-agent/ide` only together with
`--agent cursor-agent`; an omitted surface retains the documented IDE default. Profile enablement is
checked after exact selection, so a disabled surface cannot silently fall back.

Copilot resolution remains target-driven because D08 exposes no event-aware runtime contract. The
exact CLI target operand is therefore its activation input; a supplied E03 trace is still validated,
target-bound, and retained by E06, but its events do not manufacture Copilot activation or import
semantics. Only the `copilot-cli` surface receives C10/E04 reference DAGs because that is the
surface with a documented reference contract.

I03 renders each complete output document before calling the shared bounded-output writer. That
writer validates the 64 MiB aggregate ceiling and Unicode scalar structure before the first write,
computes at most 1 MiB UTF-8 chunk boundaries, and awaits chunks serially. The router remains the
single authority for stream accounting, abort races, and sink failures.

## Verification

Run the focused unit, coverage, and built-package integration checks:

```sh
pnpm exec vitest run packages/resolver/test/explain-projection.unit.test.ts
pnpm exec vitest run packages/resolver/test/explain-projection.unit.test.ts \
  --coverage.enabled --coverage.include=packages/resolver/src/explain-projection.ts
pnpm build
pnpm exec vitest run tests/explain-projection.integration.test.ts
```

The golden integration reconstructs a real D03 → E05 result, normalizes a real E03 trace, and checks
`conformance/fixtures/v0/explain-projection.golden.json`. Unit tests cover one/many targets, all
dispositions and content states, import occurrences, hostile input, invalid relationships, limits,
freezing, and permutation/repeated-run stability.
