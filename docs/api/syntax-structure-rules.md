# Syntax and structure rules API

Ticket F05 implements ACL100–ACL109 in the private `@agent-context/rules` package. The evaluator is
a synchronous, deterministic data transform over a validated B03 graph. It composes the C07
frontmatter parser and B08 suppression processor; it performs no filesystem, network, environment,
model, command, or fix operation.

## Input contract

`evaluateSyntaxStructureRules` accepts the closed
`agent-context-syntax-structure-rule-input`/`0.1.0` record. `ir` is a complete B03 graph and
`documents` contains at most one policy for each source. A policy declares:

- `dialect`: `yaml`, `mdc`, or `null` for a format without frontmatter;
- a vendor ID and closed field schema with accepted JSON value types;
- whether a string/string-array field uses the bounded `path-glob-v1` structural grammar; and
- source-attributed profile observations for location and format support.

The profile observations keep document syntax separate from client behavior. Only an explicit
`unsupported` location emits ACL105 and only an explicit `deprecated` format emits ACL106. `unknown`
never becomes a finding. Each observation carries an HTTPS source URL, retrieval date, revision,
evidence reference, profile, surface, and snapshot. Profile adapters or standards data own those
facts; the evaluator does not infer them from a filename.

Field schemas are likewise vendor-scoped. ACL102 computes a deterministic edit-distance suggestion
only among that vendor's declared fields, and omits the suggestion when the nearest result is tied
or too distant. `path-glob-v1` rejects only its documented structural failures: non-canonical
repository-relative forms, controls, overlong input, unbalanced/nested delimiters, malformed brace
alternatives, and embedded globstars. A profile must not select this grammar when its syntax treats
those forms differently or remains undocumented.

## Two-phase suppression API

```ts
const evaluated = evaluateSyntaxStructureRules(input);
if (!evaluated.ok) throw new Error(evaluated.issues[0]?.code);

// F15 supplies diagnostics from every other scheduled family here.
const finalized = finalizeSyntaxSuppressions(evaluated, otherDiagnostics);
```

The first phase emits ACL100–ACL108 plus B08 `applicable` records. The returned object carries
process-private ownership of B08's parsed directive attachments. The finalizer accepts only that
issued object, validates additional diagnostics as B04 data, invokes B08 matching over the complete
set, and then emits ACL109 for records that are still `unused`. This prevents an ACL350 directive,
for example, from being called unused merely because F05 cannot produce ACL350 itself. Forged or
serialized evaluation objects cannot obtain suppression authority.

The final bundle retains all diagnostics and resolved suppression records. `visibleDiagnostics` and
`suppressedDiagnostics` are projections; B04 transport intentionally retains suppressed findings.
F15 remains responsible for global family scheduling, severity policy, deduplication, and final
presentation order. It calls `finalizeScheduledSyntaxSuppressions`, whose private issuance is
`scheduled-reporting`; `planApprovedMechanicalFixes` rejects both that result and the scheduler
bundle. Only `finalizeSyntaxSuppressions` issues the complete authority required by I12.

## Rule mapping

| Rule   | Authoritative input                                        |
| ------ | ---------------------------------------------------------- |
| ACL100 | C07 issue other than `duplicate-key`                       |
| ACL101 | C07 value compared with the vendor field schema            |
| ACL102 | C07 field absent from the vendor field schema              |
| ACL103 | Vendor field that opts into `path-glob-v1`                 |
| ACL104 | Empty plain document or empty C07 body                     |
| ACL105 | Explicit profile `unsupported` location observation        |
| ACL106 | Explicit profile `deprecated` format observation           |
| ACL107 | C07 `duplicate-key` issue                                  |
| ACL108 | B08 suppression parse issue                                |
| ACL109 | B08 record still unused after complete diagnostic matching |

Every diagnostic uses rule version `1.0.0`, fixed non-reflective messages, source-exact B04
locations, stable path/semantic fingerprints, no automatic fix, and the B09 default severity.
