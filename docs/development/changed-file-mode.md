# Developing changed-file mode

I07 composes Git metadata admission, the E05/F15 selection plan, command routing, and the hermetic
Node executor behind the explicit paired `--changed --base <ref>` grammar.

## Composition order

1. Resolve the exact repository root. Only after an explicit changed-mode CLI option, mint one
   opaque scan scope and bind the Git capability around the fixed host executor to it. Default scans
   must not create either value.
2. Collect initial merge-base, exact-index, and raw-worktree evidence before reading configuration.
   Do not retry with a looser command or a Git worktree diff.
3. Resolve configuration, build exact tracked C05 evidence, and independently enumerate the bounded
   scanner-visible filesystem inventory. If relevant untracked paths exist, use the complete
   inventory for the analysis and retain index-derived discovery only for fallback proof.
4. Resolve E05 for every changed non-instruction target in addition to the deterministic scope
   sample. Uncertain C05 evidence must remain uncertain.
5. Run F15 with normal policy. Bind the issued B06/B07 configuration success, C05 index, E05
   resolutions, and F15 success into one evidence authority under the scan scope. The authority,
   rather than the caller, derives instruction and control paths.
6. Recollect Git metadata and scanner-visible inventory after F15, re-resolve configuration, and
   revalidate every file/directory byte identity actually consumed by discovery, imports, ignore
   evaluation, and scheduling. Then take a third Git-state identity snapshot as the final operation
   before evidence is minted. Rebind configuration plus every recorded inventory directory, entry,
   consumed file, and absence boundary after that Git snapshot. Any HEAD, ref input, index, raw
   content, input byte, incomplete inventory, or relevant path-set difference discards subset
   authority.
7. If the result is `full`, render the complete F15 output and an explicit fallback reason. If it is
   `changed`, filter diagnostics and suppression records together, recompute exit policy, and render
   only `includedDiagnosticIds` while retaining configuration/parser findings.
8. Restrict changed-mode fix previews to diagnostics whose primary path is directly changed.

The planner is deliberately post-scheduler. This preserves F15 dependency ordering, suppression,
severity policy, deduplication, and stable sorting. I02 may use `selectedPaths` to optimize future
work only after equivalence tests prove the pre-scan optimization produces the same plan.

The v1 executor intentionally recognizes a smaller repository-state surface than Git. It accepts an
unambiguous main `[core]` format 0/SHA-1 and format 1 with only the main
`[extensions] objectFormat = sha256`. It rejects relevant subsections (quoted or deprecated dotted
form), duplicate relevant keys, continuations/escapes, ambiguous encodings or syntax, unknown
extensions, format 1/SHA-1, shallow state, grafts, replacement refs (loose or packed),
`config.worktree`, and `include`/`includeIf` directives. It never follows configuration includes.
Normal `[remote "origin"]` and `[branch "main"]` subsections and repeated unrelated keys remain
admitted. For linked worktrees it additionally proves that the private metadata directory is a
member of `<common>/worktrees`, validates its backlink to the selected worktree, and binds both
private and common metadata. Expanding support requires new parsing, identity-binding, packaged-CLI,
and race tests; do not infer support from what an installed Git version happens to accept.

Reference resolution retains the exact packed-ref file or its absence, every loose `HEAD`, symbolic
and candidate ref file or its absence, and every traversed directory identity. A successful request
revalidates those inputs after Git/index/worktree postflight, resolves the reference again, and
requires the same object ID. Binding only the top `refs` directory is insufficient because an
in-place file rewrite or a new file under an existing `refs/heads` directory does not change it.

## Required integration tests

The ticket exercises the extracted npm tarball and source tests in real disposable Git histories:

- committed, staged, and unstaged changes against a unique merge base;
- changed root/nested/imported instructions and path-specific targets;
- configuration (including includes and unknown extensions), malformed parser input, deletion,
  rename, multiple/no merge bases, shallow, graft, loose/packed replacement, private worktree
  configuration, partial-clone lazy-fetch refusal, cancellation (including a stalled preflight), and
  time/output limits;
- repeated and concurrency-perturbed scans with byte-identical terminal, JSON, and SARIF results;
- socket denial, repository tree/status equality, no hooks/helpers/prompts/filter clean or process
  commands/textconv, and no reflected stderr;
- forged/cloned or cross-scope authority objects, custom standards lock paths, uncertain discovery,
  executable regular files, ignored generated trees, relevant and late untracked paths, linked
  worktree indexes and backlinks, and mutation after the final inventory/read-ledger validation.

Use one monotonic operation context for executor creation and one per request. Every filesystem
promise, Git preflight/postflight identity check, and subprocess must consume the same remaining
budget and cancellation signal. Pass the signal to abortable reads; race non-abortable operations;
explicitly close file and directory handles that resolve after a lost race. Once the context has
expired, no continuation may spawn Git or publish executor state. The final `HEAD` request must
recollect the exact index and every tracked worktree byte and compare them with the previously
returned snapshot before it returns success.

Never weaken a `full` fallback to improve timing. A future optimization needs new evidence that
makes the subset complete.
