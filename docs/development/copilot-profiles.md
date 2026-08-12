# Developing Copilot surface profiles

D08 is split between a data-only catalog in `packages/profiles/src/copilot.ts` and a pure resolver
in `packages/resolver/src/copilot-profile.ts`. Keep surface behavior separate even when current
documentation happens to overlap.

## Change procedure

1. Recheck the primary documentation and update the dated research record before changing a claim.
2. Identify the exact surface, runtime event, setting, repository root, and file family involved.
3. Update only that surface descriptor and resolver branch. Do not add a cross-surface default.
4. Add a focused positive, negative, unknown, and hostile-input case. Use a versioned conformance
   fixture for contradictions or externally observable behavior.
5. Run profile/resolver type checks, lint, unit tests, coverage, package-boundary checks, the packed
   artifact policy, and then the serialized repository-wide gate.

Unknown documentation stays explicit. A new observation may narrow an unknown only when it records
the client/service identity, version or observation time, invocation, settings, repository fixture,
and expected evidence. A hosted service observation must not silently promote an evidence-only
profile to GA-required.

## Invariants

- Profile and surface identifiers are closed, stable, and one-to-one.
- Runtime state is passed as inert data. The resolver owns no discovery I/O and invokes no client.
- D07 owns Copilot syntax; E02 owns profile glob matching; D08 composes them without changing their
  contracts.
- Missing or malformed scope metadata cannot become an always-on instruction.
- Only the named hosted surface consumes its `excludeAgent` value.
- Outputs are deterministic, immutable, repository-relative, and bounded.
- Test fixtures may contain hostile prose, but tests never execute it or access external services.

Focused coverage must remain at least 95% statements/functions/lines and 90% branches for the new
resolver. Coverage-only exclusions are not a substitute for testing reachable validation and
uncertainty branches.
