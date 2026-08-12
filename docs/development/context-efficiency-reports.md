# Developing context-efficiency reports

G09 is a presentation boundary, not another analyzer. New report fields must be derived from
already-issued G05/G07/G08 evidence or remain `null`. Do not reconstruct scores, accept claimed
savings, read report JSON back into issuance authority, or infer semantic/task-quality preservation.

The report constructor joins a G04 distribution to its G05 profile key, sorts profiles by UTF-8
bytes, checks recommendation profile keys against the metrics set, and then retains the immutable
source records. Comparison first authenticates both report objects and checks all compatibility
identities before calculating any delta. Configuration differences are deliberately incompatible:
two equal numbers under different budgets or weights are not the same measurement.

The JSON encoder traverses only issued immutable report graphs. It sorts every object key, counts
UTF-8 bytes before the first sink write, then repeats the traversal into bounded chunks. Do not
replace it with locale sorting, a single unbounded `JSON.stringify`, concurrent sink writes, or a
partial-write-before-validation implementation. Terminal output treats every non-ASCII scalar as two
columns. That conservative rule avoids overflowing narrow terminals even when an environment's font
renders a scalar wide.

The CLI module `efficiency-command.ts` intentionally accepts an injected source capability. I02 and
F15 own repository scanning and rule scheduling; G09 does not duplicate or bypass them. The source
must return either one genuine report or, for `--compare`, a genuine baseline/candidate pair. The
handler is informational and always returns success after valid output, regardless of score or
grade. Operational, output, and cancellation failures retain the router's 2/130 behavior.

Required changes include positive, unavailable, incompatible, hostile-object, narrow-width,
no-color, schema, deterministic golden, streaming/backpressure, cancellation, CLI grammar, built
artifact, and packed-inventory tests. Update both schemas and this document for any report contract
change.
