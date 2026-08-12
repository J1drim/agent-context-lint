# Canonical-policy synchronization security boundary

I13 handles repository text, filenames, base records, and preview objects as
untrusted input. Its authority is deliberately asymmetric: it can calculate
review text broadly, but it can mutate only one existing regular file after
I11 and I10 prove all preconditions again.

Security invariants:

- canonical and target paths are canonical repository-relative paths;
- destinations are selected from a closed table, and policy identifiers cannot
  contain separators or traversal;
- inputs must be plain own-data records and dense arrays; proxies, accessors,
  symbols, sparse containers, invalid UTF-16-derived digests, and excess
  resources fail closed;
- source, target, aggregate patch, target count, cancellation, and monotonic
  deadline limits apply before authority is issued;
- real syntax parsing and resolver target-set probes run before patch creation;
- conditional/unknown scope and target-recognized imports are non-applicable;
- prior-base metadata is closed, versioned, digest-bound, path/format/target
  bound, and re-parsed before use;
- local content that differs from the prior base is never auto-merged;
- preview patches are I11's terminal-safe review artifact, not write authority;
- the internal `ACL254` composition diagnostic grants no I12 rule-registry or generic `--fix`
  eligibility; only the synchronizer's private one-use authority can call I11 application;
- serialized/cloned/foreign/reused preview objects cannot be applied;
- creation remains preview-only because I11 has no portable atomic no-clobber
  creation transaction; and
- existing-file application inherits C02/I10 rejection of changed identity,
  symlinks, hard links, directories/special files, external parents, root
  replacement, read-only files, and time-of-check/time-of-use mutation.

Git's official
[three-way file merge description](https://git-scm.com/docs/git-merge-file)
(retrieved 2026-08-03) defines current, base, and other and permits merging
independent changes. I13 uses those three inputs only for conflict detection and
adopts a stricter rule: `current` must equal `base`. It never emits conflict
markers, invokes Git, or chooses ours/theirs/union.

Node documents that promise-based filesystem operations are not synchronized
against concurrent modification. I10 therefore performs repeated identity and
digest checks around its same-directory atomic rename; see the official
[Node.js 24 filesystem documentation](https://nodejs.org/docs/latest-v24.x/api/fs.html),
retrieved 2026-08-03.

The module imports no child-process, socket, HTTP, DNS, model, credential, or
plug-in facility. Normal scan behavior remains offline, deterministic,
model-free, command-free, and read-only.
