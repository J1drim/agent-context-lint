# Reference and import rules API

Ticket F06 implements `evaluateReferencesImports` in `@agent-context/rules` for ACL150–ACL156. The
evaluator accepts one closed, versioned input containing validated B03 instruction IR, zero or more
C10 import graphs, profile targets, and a sorted repository-path snapshot. It returns a B04
diagnostic bundle, the source documents needed by formatters, metrics, and explicit uncertainties.

The input contract is `agent-context-references-imports-rule-input@0.1.0`. Every B03 import must
have at least one target tuple (`profileId`, `surfaceId`, `formatId`, and the VS Code
referenced-link setting when applicable). Tuples are checked against the actual D03, D05, D08, D10,
and D13 profile descriptors. C10 graph documents and references must be byte/range-identical members
of the B03 IR; graphs are revalidated through the E04 import-DAG contract before rule evaluation.

```ts
import { evaluateReferencesImports } from "@agent-context/rules";

const result = evaluateReferencesImports({
  contractVersion: "0.1.0",
  graphs,
  ir,
  pathSnapshot: { completeness: "complete", paths: repositoryFiles },
  recordKind: "agent-context-references-imports-rule-input",
  targets,
});
```

Absence and case claims require `pathSnapshot.completeness: "complete"`. A partial snapshot, an
unreadable path known to exist, ambiguous case matches, resource-limited graphs, malformed syntax,
and unknown profile behavior produce `uncertainties`, not findings. ASCII case comparison is
intentional; non-ASCII case behavior remains platform-dependent and is not guessed.

The function is synchronous after its inputs exist and has no filesystem, process, environment,
clock, model, or network capability. Callers create C10 graphs and repository-path evidence through
the normal jailed discovery pipeline before evaluation.
