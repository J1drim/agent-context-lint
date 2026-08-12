# Local standards review procedure

There is no repository-owned standards maintenance workflow. Use the local H10/H11 commands in the
[standards maintenance contract](../api/standards-maintainer-workflow.md), keep network capture
explicit, and verify all generated artifacts offline before review.

The procedure is intentionally review-only: it cannot publish a pack, activate a lockfile, modify a
rule automatically, open a pull request, or change an external repository. Accepted changes require
synthetic regression fixtures, affected tests, documentation, and a passing local-gate report.
