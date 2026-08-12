# Rule scheduler security boundary

Normal scheduling is offline, model-free, read-only, and command-free. The graph contains only ten
compiled evaluator branches. Repository data cannot register code, callbacks, modules, network
operations, filesystem operations, or shell commands.

Raw B03 data is admitted through the bounded descriptor-owned core snapshot operation. Existing
same-process snapshots are reused exactly. Sources, filenames, Markdown, evidence, options, and
diagnostics are untrusted: proxies, accessors, executable values, sparse arrays, unknown fields,
inconsistent sources, unregistered diagnostics, ID reuse, fingerprint collisions, evidence
conflicts, and limit overflow fail closed with non-reflective typed issues.

Every current evaluator output is admitted before the first asynchronous completion perturbation,
closing caller-mutation races without cloning opaque same-process authority. Abort reasons and
caught exception text are never copied to output.

B08 runs after policy filtering and before deduplication. Scheduler finalizations carry
`scheduled-reporting` issuance, which `planApprovedMechanicalFixes` rejects. The public result is
recursively frozen and contains no repository handle, signal, evaluator input, or capability.
