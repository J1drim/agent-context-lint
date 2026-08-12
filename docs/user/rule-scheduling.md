# Rule scheduling behavior

The product evaluates selected built-in rule families against one immutable repository snapshot.
Results do not depend on input registration order, worker count, or completion timing. Terminal,
JSON, and SARIF render the same canonical diagnostic bundle.

Per-rule severity can be changed to `error`, `warning`, `info`, or `off`. Disabled findings are
removed before suppression matching. The `error`, `warning`, or `never` failure threshold is
evaluated only after suppression.

Suppression directives are exact and parser-owned. The finding remains in the bundle for audit and
appears in the suppressed view, while visible counts and the exit decision exclude it. Scheduled
scans never authorize automatic deletion of suppression comments; that requires a separate complete
mechanical-fix analysis and explicit fix workflow.

Cancellation, deadlines, malformed inputs, inconsistent evidence, and resource limits produce a
typed failure instead of partial results. A normal scan performs no network access, executes no
repository command, and makes no model call.
