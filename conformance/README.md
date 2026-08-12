# Profile conformance data

This directory contains offline, synthetic compatibility inputs.

- `contracts/profile-surface-map.v0.json` is the canonical D01 mapping of document formats, client
  profiles, runtime surfaces, scopes, default names, root models, and evidence states.
- `fixtures/v0/*.fixture.json` are canonical profile-resolution examples.
- `fixtures/v0/gemini-*.fixture.json` preserve Gemini hierarchy/JIT, import, and ignore
  contradictions against the dated D09 research record and anchor D10 executable scenarios.
- `fixtures/v0/copilot-cli-order-unknown.fixture.json` and the two `cursor-*-unknown` fixtures make
  the D16 blocked outcomes executable as explicit ambiguity rather than guessed ordering or model
  selection.
- `observations/v0/d16/review.json` binds one reviewed D15 plan/transcript and at least one matching
  fixture to every GA-required surface, with exact file and client-artifact digests.
- `fixtures/v0/portability-rules.golden.json` pins the F12 packaged evaluator/registry projection;
  the paired 16-case labeled corpus lives beside the rules unit suite.
- `official-examples/v0/corpus.json` is the K01 digest-bound inventory of positive and negative
  official-example fixtures for every GA surface/format capability. Its closed validator also
  enforces monthly profile/QA review ownership and all seven adapter-conformance dimensions.
- `profiles/` retains ticket-specific schema-neutral research catalogs that have not all been
  migrated to canonical fixtures.

The normative fixture requirements and version policy are documented in
[`docs/contracts/profile-conformance-fixture-v0.md`](../docs/contracts/profile-conformance-fixture-v0.md).

Validate the current contract and examples with:

```bash
node tools/conformance/validate-profile-contract.mjs \
  conformance/contracts/profile-surface-map.v0.json \
  conformance/fixtures/v0/codex-root-order.fixture.json \
  conformance/fixtures/v0/claude-launch-read-rules.fixture.json \
  conformance/fixtures/v0/copilot-vscode-description-ambiguity.fixture.json \
  conformance/fixtures/v0/gemini-hierarchy-jit.fixture.json \
  conformance/fixtures/v0/gemini-import-modes.fixture.json \
  conformance/fixtures/v0/gemini-ignore-memory-ambiguity.fixture.json

node tools/conformance/validate-cursor-rule-facts.mjs \
  docs/profiles/data/cursor-rule-facts.v0.json
node tools/conformance/validate-ga-profile-observations.mjs \
  conformance/observations/v0/d16/review.json
pnpm conformance:gemini:validate
pnpm conformance:official:validate
node --test tools/conformance/validate-profile-contract.test.mjs \
  tools/conformance/validate-cursor-rule-facts.test.mjs \
  tools/conformance/validate-gemini-research.test.mjs
```

Validation is local-only. It must never invoke a client, execute repository commands, inspect user
configuration, or access the network. The D16 validator uses the project's pinned JSON Schema
dependencies and verifies only committed artifacts.

The K01 generator is check-only by default. A maintainer update requires the explicit
`--write --acknowledge-reviewed-update` capability exposed through
`pnpm conformance:official:generate`; the monthly procedure is documented in
[`docs/profiles/official-example-conformance.md`](../docs/profiles/official-example-conformance.md).

`claude-launch-read-rules.fixture.json` proves that repository-root memory loads at launch while
descendant memory and a path-scoped rule activate only after a matching read event.

`effective-context-cache.golden.json` is E09's built-distribution proof. It pins every independently
reviewable invalidation component, the final content address, and the byte digest of the cold/warm
E05 resolution for a real E04 imported-document graph. Dependency array order must not change it.
