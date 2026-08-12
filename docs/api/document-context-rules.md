# Document-level context rules

Ticket F10 implements ACL350–ACL355 in `@agent-context/rules` as one deterministic evaluator. The
API operates on already parsed, inert B03 data and returns a B04 diagnostic bundle; it does not
discover files or resolve effective agent/profile context.

```ts
import { evaluateDocumentContextRules } from "@agent-context/rules";

const result = evaluateDocumentContextRules({
  recordKind: "agent-context-document-context-rule-input",
  contractVersion: "0.1.0",
  ir,
  importResolutions,
});
```

The evaluator validates the complete B03 IR, normalizes every C08 statement through F03, builds the
actual F04 exact/near duplication index, and uses G02's `builtin:deterministic-estimate` tokenizer.
A successful result contains `bundle`, `sources`, the F04 `duplicationIndex`, and metrics. Token
evidence always identifies its provider, version, and `measurement: estimate`; messages also say
“estimated.”

## Input contract

The top-level record is closed and versioned. `importResolutions` is a dense array of explicit links
from a B03 `ImportReference.id` to a `SourceDocument.id` already contained in the same IR. Each link
includes a stable `collectorId`, `factId`, and lowercase SHA-256 `valueDigest`. It cannot contain a
path to load, a URL, command, callback, module, or content supplied outside B03.

The evaluator rejects proxies, accessors, inherited array elements, sparse arrays, symbols, unknown
fields, duplicate import IDs, malformed provenance, unknown import/source relationships, invalid B03
graphs, and threshold values outside 1–1,000,000. It permits at most 60 resolved imports per
document so ACL355 can retain exact per-occurrence provenance within B04's related-evidence bound.
Failure is closed: no partial diagnostic bundle is returned.

Options override these defaults independently:

| Option                              |       Default | Comparison                           |
| ----------------------------------- | ------------: | ------------------------------------ |
| `maxAlwaysOnTokens`                 |         4,000 | ACL350 emits strictly above          |
| `largeCodeBlockTokens`              |           256 | ACL351 emits strictly above          |
| `longInstructionTokens`             |           128 | ACL353 emits strictly above          |
| `maximumImportExpansionBasisPoints` | 20,000 (2.0×) | ACL355 emits strictly above          |
| `minimumImportedTokens`             |           128 | ACL355 requires at least this amount |

## Detection contract

| Rule   | Deterministic predicate                                                                                                                  | Primary range          |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| ACL350 | A document has a known `always` activation and its complete raw source estimate exceeds `maxAlwaysOnTokens`.                             | Document root          |
| ACL351 | A B03 `code-block` source slice exceeds `largeCodeBlockTokens`.                                                                          | Code block             |
| ACL352 | An F03-unclassified statement exactly matches the conservative built-in vague-phrase vocabulary.                                         | Statement              |
| ACL353 | A statement exceeds `longInstructionTokens` and has at least two independently signaled requirement clauses.                             | Statement              |
| ACL354 | An F03-unclassified repository-description template belongs to an F04 exact-duplicate cluster.                                           | Repeated statement     |
| ACL355 | Explicit direct imports meet `minimumImportedTokens` and make total document-plus-import tokens exceed the configured basis-point ratio. | First import specifier |

Threshold equality does not emit for rules described as “exceeds.” Unknown or conditional activation
does not qualify for ACL350. ACL352 does not classify arbitrary prose semantically. ACL353 requires
both length and multiple conservative clause signals. ACL354 requires actual F04 exact duplication;
a single description is not enough. ACL355 counts target content once per direct import occurrence,
because that is the context cost being measured.

All suggestions have `fixPlan: null`. The evaluator does not claim that removing, moving, or
rewriting repository-controlled text is mechanically safe.

## Budget-scope boundary

ACL350's exported and reported budget scope is exactly `raw-always-on-document`. It measures one
source document, has no profile IDs, targets, occurrence accounting, percentile, or resolved
activation set, and never emits ACL550 or ACL551. ACL550/ACL551 belong to F14 and consume resolved,
agent-specific accounting. A future scheduler can therefore deduplicate by rule scope without
guessing from message text.

ACL355 similarly reports only explicit **direct document imports**. It is not the resolved import
DAG amplification rule ACL554 and does not infer transitive or profile-effective context.

## Diagnostics and ordering

Every finding is source-bound to the exact B03 SHA-256 digest and half-open range. Related evidence
records the G02 measurement, F03 classification state, F04 cluster, or explicit import-resolution
provenance that qualified the finding. Path fingerprints use the document/node/statement anchor;
semantic fingerprints contain only bounded stable IDs, counts, thresholds, and hashes—not raw
repository prose. ACL353 includes the B03 statement ID in its semantic basis: identical instruction
text at distinct source statements remains independently suppressible and cannot collide at the B04
diagnostic-ID boundary, while repeated clauses inside one statement still produce one finding.
Diagnostics are sorted by repository path, byte offset, rule ID, and semantic fingerprint before B04
validation.

F15 remains responsible for global scheduling, severity policy, cross-family deduplication, and
suppression matching. B08 directives already match these findings by exact rule and next-line source
range. Stylish, native JSON, and SARIF formatters consume the resulting B04 bundle without a
rule-specific adapter.
