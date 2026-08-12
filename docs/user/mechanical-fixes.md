# Previewing approved mechanical fixes

Agent Context Linter treats normal scans as offline, read-only operations. The only currently
approved automatic rule change is removal of an exact suppression comment naming one syntax rule
ACL100–ACL108 that the complete syntax evaluation proves no longer suppresses a finding (`ACL109`).
Cross-family or multi-rule suppressions remain review-only until the complete scheduler can prove
them unused. All other rule suggestions remain review guidance.

The command grammar reserves this preview-only form:

```sh
agent-context-lint scan . --fix-dry-run
```

The packaged scan runs the complete unfiltered syntax evaluation before asking I12 and I11 for
eligible plans. A preview shows a deterministic review patch and remains read-only. JSON and SARIF
cannot be combined with `--fix-dry-run`. Application authority is not exposed by this command;
library application rejects concurrent changes, symlink substitution, copied/stale previews,
cancellation, and unsupported transaction shapes. Re-running after an ACL109 removal produces no
second change.

The complete conservative decision record is in the
[mechanical-fix safety matrix](../rules/mechanical-fix-safety.md).
