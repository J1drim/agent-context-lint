# Portability rules API

Ticket F12 implements deterministic ACL450–ACL453 evaluation in `@agent-context/rules`.
`evaluatePortabilityRules(input, options?)` accepts this closed version `0.1.0` record:

```ts
interface PortabilityRuleInput {
  recordKind: "agent-context-portability-rule-input";
  contractVersion: "0.1.0";
  ir: InstructionIr;
  comparisons: readonly CrossProfileComparison[];
  formatInventoryState: "complete" | "partial";
  formatObservations: readonly PortabilityFormatObservation[];
  behaviorObservations: readonly PortabilityBehaviorObservation[];
}
```

`ir` must satisfy B03. Every comparison must have been issued by E07 in this process. Every format
and behavior observation identifies an exact profile/surface summary in those comparisons and a real
B03 document or statement. Observations are explicit orchestrator facts: the evaluator does not
discover support, invoke clients, or turn a file extension into compatibility authority.

## Rule semantics

| Rule   | Emission condition                                                                                                                                                                                                                                     |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ACL450 | A high-confidence structured statement exists in a vendor format that one selected surface supports and another explicitly recognizes without support; E07 proves target divergence; a complete inventory contains no equivalent shared-format policy. |
| ACL451 | High-confidence statements for the same structured subject differ across two formats explicitly supported by different selected surfaces, and E07 proves target divergence involving those documents.                                                  |
| ACL452 | An import or nesting behavior is explicitly supported on one selected surface and explicitly unsupported on another, with matching E07 divergence.                                                                                                     |
| ACL453 | An editor feature is explicitly supported on a closed editor-surface identity and explicitly unsupported on a non-editor surface, with matching E07 divergence.                                                                                        |

`recognized` is sufficient only as explicit non-support evidence for ACL450. `conditional` and
`unknown` never become unsupported. Partial format inventory cannot prove absence of a shared
equivalent. Unclassified shared prose also prevents that absence claim. Format drift uses F03's
closed structured domains; it does not claim general semantic equivalence.

## Result and failure model

A successful result includes a validated B04 diagnostic bundle, original B03 sources, immutable
uncertainties and metrics, and the exact F03/E07 contract versions. Messages are fixed. Raw
instruction text and structured values enter neither messages nor evidence labels; fingerprint
policy components are SHA-256 digests. No portability rule supplies an automatic fix.

Malformed, proxy, accessor, symbol-keyed, sparse, duplicate, over-limit, forged-comparison,
mixed-profile-version, dependency, and generated-contract failures return `{ ok: false, issues }`.
Closed options bound statements, text, comparisons, observations, pair work, diagnostics, and
uncertainties beneath exported hard caps.

`finalizePortabilitySuppressions(result)` applies B08 directives only to the exact result issued by
the evaluator. A cloned or forged result is rejected. The unsuppressed evaluator output is safe to
send through the stylish, native JSON, and SARIF formatters.

## Precision status

ACL450–ACL453 are `seeded`. The versioned 16-case precision corpus covers positives, hard negatives,
partial inventories, recognized/conditional/unknown support, shared equivalence, structured drift,
and import/nesting uncertainty. Seeded status does not replace K02/K03 external calibration or prove
that two agents behave equivalently.
