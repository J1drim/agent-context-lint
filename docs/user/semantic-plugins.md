# Optional semantic plug-in

Semantic analysis is off by default. Ordinary scans do not load the reference module, inspect input
for it, contact a network, or change deterministic diagnostics and exit status.

Library consumers may explicitly select `reference-contradiction-candidate-v1` through the closed
F17 configuration record documented in the [API reference](../api/semantic-plugins.md). The
reference plug-in reports documents containing both `always` and `never` directives as candidates
for manual review. It deliberately does not decide that the directives actually conflict.

Treat every result as advisory:

- output is labeled `non-deterministic` even when repeated runs happen to match;
- `qualityClaim` is always `false`;
- findings are separate from normal ACL diagnostics, suppression, baselines, and failure policy;
- enabling does not authorize sending repository text anywhere; and
- the bundled reference module has no filesystem, network, process, environment, clock, random,
  model, or write capability.

There is no configuration for repository-provided JavaScript, WebAssembly, commands, packages, or
URLs. A project that needs a new plug-in must add audited release-owned code and contract tests to
the product; repository content cannot install or activate executable code.
