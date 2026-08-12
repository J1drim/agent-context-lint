# Developing diagnostic baselines

Baseline code belongs in `@agent-context/core` because it is a deterministic transformation over
public B04/B05 contracts. Keep filesystem parsing/writing, Git discovery, and CLI policy outside
this module. Never add ambient time, environment, repository access, network access, or
subprocesses.

When changing v1:

1. Update the TypeScript contract, runtime validator, dedicated schema, combined output schema,
   package export, positive fixture, and compatibility golden together.
2. Classify the change under B10. Matching precedence, expiry, identity fields, canonical bytes, or
   resource limits require a new major schema and explicit side-by-side migration.
3. Test exact, new, stale, expired, incompatible, ambiguous, parser/configuration, path-move,
   collision, malformed JSON, proxy/accessor, canonical order, timezone, determinism, and limits.
4. Validate the packaged schema export and packed package. A source-only unit result is insufficient
   for the release gate.

`generateDiagnosticBaseline` deliberately owns baseline entry sorting; do not sort or mutate the F15
diagnostic bundle. `compareDiagnosticBaseline` must retain current diagnostic order. Exact duplicate
baseline identities may be deduplicated during generation, but near matches must remain independent.

If a real repository exposes a mismatch, reproduce it as a minimal synthetic B03/B04 fixture here.
External validation repositories remain read-only; never prepare commits, patches, branches, or
upstream communications for them.
