# Resolution event trace API

Ticket E03 implements the deterministic event-trace mechanism in `@agent-context/resolver`. It
projects the target and event records already defined by the B03 instruction IR; it does not add a
second event vocabulary, match profile globs, load documents, read files, or assign vendor-specific
meaning to descriptive conditions.

The current trace contract version is `0.1.0`:

```ts
interface ResolutionEventTrace {
  readonly recordKind: "agent-context-resolution-event-trace";
  readonly contractVersion: "0.1.0";
  readonly rules: readonly TraceActivationRuleDescriptor[];
  readonly targets: readonly ResolutionTarget[];
  readonly events: readonly ResolutionEvent[];
}

interface TraceActivationRuleDescriptor {
  readonly id: ActivationRuleId;
  readonly documentId: InstructionDocumentId;
  readonly profileId: ClientProfileId;
  readonly surfaceId: SurfaceId;
  readonly specSnapshotId: SpecSnapshotId;
  readonly kind: ActivationKind;
  readonly conditions: readonly string[];
}
```

`rules` is the relationship and origin-identity boundary for manual mentions and rule selections. A
trace extracted from an `InstructionIr` projects each descriptor from its activation rule. E03 binds
an event decision to the rule ID, document, profile, surface, specification snapshot, activation
kind, and ordered B03 conditions. It does not copy selectors or interpret rule semantics.

## Extracting and constructing traces

Use `createResolutionEventTrace(ir)` to extract a trace from a complete B03 envelope. The function
first calls `validateInstructionIr`, so sources, documents, activation rules, targets, events, IDs,
and their cross-references must all be valid before E03 derives state.

```ts
import { createResolutionEventTrace } from "@agent-context/resolver";

const trace = createResolutionEventTrace(validatedInstructionIr);
```

`createSyntheticTargetTrace` implements the documented convenience projection for an `explain`
target: one launch event followed by one `reference-path`, `read-path`, or `write-path` event. The
default is `reference-path`.

```ts
import { createSyntheticTargetTrace } from "@agent-context/resolver";

const trace = createSyntheticTargetTrace({
  launchCwd: ".",
  workspaceRoots: ["."],
  targetPath: "src/main.ts",
  purpose: "explain-effective-context",
  settings: [{ key: "instructions.enabled", value: true }],
  targetEventKind: "reference-path",
});
```

Synthetic target and event IDs are SHA-256 hashes of UTF-8 length-prefixed canonical tuples. Event
IDs include sequence and normalized payload. Changing input array or object-key order without
changing its meaning therefore does not change the trace bytes or IDs. Length framing prevents
tuple-boundary collisions such as `("ab", "c")` and `("a", "bc")`.

The synthetic builder does not inspect a process CWD, filesystem, environment, clock, random source,
or client. Callers must supply canonical B01 repository paths and explicit settings.

## Validation and normalization

`normalizeResolutionEventTrace(input)` is the standalone untrusted-input boundary. It returns a
deeply frozen trace or throws `ResolutionEventTraceError` with one stable code:

| Code                               | Meaning                                                                         |
| ---------------------------------- | ------------------------------------------------------------------------------- |
| `EVENT_TRACE_INVALID_INPUT`        | The record is not closed regular JSON-like data or a field is malformed.        |
| `EVENT_TRACE_INVALID_EVENT`        | An event kind or its discriminated payload is invalid.                          |
| `EVENT_TRACE_INVALID_PATH`         | A path is not a canonical B01 repository-relative path.                         |
| `EVENT_TRACE_INVALID_RELATIONSHIP` | A target or activation-rule reference is unknown.                               |
| `EVENT_TRACE_INVALID_STATE`        | Sequence, uniqueness, launch, settings, or uncertainty state is inconsistent.   |
| `EVENT_TRACE_RESOURCE_LIMIT`       | A published item, text, JSON-node, depth, or cumulative-byte limit is exceeded. |

One session trace has exactly one `launch` event at sequence zero. Event sequences are zero-based
and gap-free. Event and target IDs are unique. A launch-only trace may have no target; every
non-null event target must resolve to a declared target. Launch CWD and workspace roots are
independent facts: E03 does not invent a containment relationship that the selected profile has not
declared.

The validator accepts the complete B03 event union:

- `launch` with CWD, workspace roots, and settings;
- `reference-path`, `read-path`, `write-path`, `list-directory`, and `directory-add`;
- `manual-rule-mention` and `rule-selection`;
- `settings-change`;
- memory show/list/reload, compact, review request/push, hosted-task start, and client restart.

Fields that do not belong to a variant are rejected. E03 does not add generic payload fields to
payloadless B03 events.

### Canonical order

Canonicalization uses exact JavaScript UTF-16 code-unit order and never locale/ICU comparison:

- target records sort by target ID;
- rule descriptors sort by ID; their condition arrays retain B03 order;
- workspace roots, rule-selection IDs, uncertainty conditions, and contradiction alternatives are
  treated as sets and sorted;
- settings sort by key;
- keys in nested JSON setting objects sort recursively;
- JSON arrays retain their declared order; and
- events retain sequence order because ordering is behavioral evidence.

Settings with duplicate keys, selections with duplicate rules, duplicate roots/IDs, sparse arrays,
array properties, proxies, accessors, exotic prototypes, symbols, cycles, non-finite numbers,
negative zero, malformed Unicode, and non-canonical paths are rejected. No user getter or proxy trap
is invoked during validation.

## Serialization, digest, and provenance

`serializeResolutionEventTrace(trace)` validates and normalizes again, then emits compact JSON with
fixed top-level and record keys. `digestResolutionEventTrace(trace)` returns the lowercase SHA-256
of those exact UTF-8 bytes.

```ts
import { digestResolutionEventTrace, serializeResolutionEventTrace } from "@agent-context/resolver";

const json = serializeResolutionEventTrace(trace);
const sha256 = digestResolutionEventTrace(trace);
```

Event IDs, sequence, uncertainty, target association, selection source, and setting assignments are
preserved as provenance. The trace digest identifies the complete normalized event record; it is not
a diagnostic fingerprint and must not replace B04's edit-stable identities.

## Selected rules and E01 activation

`resolveTraceRuleSelection(trace, query)` searches explicit positive evidence. The query is a closed
record containing the complete rule descriptor, canonical target path, and `manual` or `conditional`
mode:

```ts
const selection = resolveTraceRuleSelection(trace, {
  rule: {
    id: "activation:manual",
    documentId: "document:root",
    profileId: "profile:example",
    surfaceId: "profile:example/local",
    specSnapshotId: "profile:example/2026-08-02",
    kind: "manual",
    conditions: [],
  },
  targetPath: "src/main.ts",
  mode: "manual",
});
```

The complete descriptor must exactly match the trace descriptor for that ID. A same-ID rule from a
different document, profile, surface, snapshot, kind, or condition set is rejected instead of
receiving another rule's event decision. Once identity is established:

- `rule-selection` applies to manual and conditional queries;
- `manual-rule-mention` additionally applies in `manual` mode;
- a target-specific event applies only to a target with the queried path;
- a `null` target applies globally; and
- only evidence whose B02 uncertainty is `known` proves `active`.

Conditional, unknown, or contradictory selection evidence remains `indeterminate`. Missing evidence
also remains `indeterminate`: B03 has no deselection event, so absence cannot prove that a rule is
inactive. E03 intentionally does not parse a B03 condition description into a predicate or claim
that a model would select a rule.

`createTraceActivationCallbacks(trace)` supplies only E01's manual and conditional callbacks:

```ts
const callbacks = createTraceActivationCallbacks(trace);
const result = evaluateActivationRule(rule, { targetPath: "src/main.ts", callbacks });
```

E01 supplies the manual and conditional callback with the originating document, profile, surface,
snapshot, kind (through the callback selected), complete frozen B03 condition array, rule ID, and
target. E03 reconstructs that descriptor and requires an exact trace match before reading evidence.
A mismatch throws `EVENT_TRACE_INVALID_RELATIONSHIP`; E01 exposes it as `ACTIVATION_CALLBACK_FAILED`
and never emits false provenance. The returned provenance therefore binds the complete
activation-rule identity, target, conditions, state, and stable trace reason. Profile-owned glob
matching remains an E02 callback and is never invented by E03.

## Settings over sequence

`resolveTraceSetting(trace, { key, targetPath })` walks applicable launch/settings-change events in
sequence and returns the last recorded assignment:

- `known` includes the canonical JSON value and assigning event ID/sequence;
- `indeterminate` retains the final event and its uncertainty reason; and
- `unrecorded` means the trace contains no applicable assignment for that key.

A later known assignment supersedes an earlier uncertain assignment. A later uncertain assignment
makes the recorded result indeterminate. `unrecorded` does not mean the client has no built-in or
external default; it only describes trace evidence.

## Resource limits

`RESOLUTION_EVENT_TRACE_LIMITS` publishes the synchronous mechanism limits:

| Limit                      |  Value |
| -------------------------- | -----: |
| events                     | 16,384 |
| targets                    |  4,096 |
| rule descriptors           |  4,096 |
| conditions per rule        |  1,024 |
| workspace roots per launch |  4,096 |
| settings per event         |  4,096 |
| UTF-8 bytes per text field | 16,384 |
| cumulative text bytes      |  4 MiB |
| JSON value nodes           | 65,536 |
| JSON setting depth         |    256 |

Declared array length is checked before entries, so a huge sparse array fails without
length-proportional traversal. Limits are mechanism policy for E03 and may be lower than what an
individual vendor accepts. Profile-specific input limits remain owned by the applicable profile and
specification snapshot.

Selection and setting query boundaries apply the same closed-data policy as trace normalization.
They reject extra or symbol keys, proxies, accessors, exotic records, malformed Unicode, coercible
objects, invalid modes, invalid setting keys, non-canonical paths, and over-limit text before
formatting a diagnostic or comparing a path. Validation does not invoke user coercion, getters, or
proxy traps.

## Purity and downstream boundaries

All E03 operations are synchronous, deterministic, offline, and side-effect free. They do not read
or write files, execute commands, use process state, contact a network, or infer profile behavior.
E04 consumes the ordered trace to build occurrence-aware document/import DAGs. Profiles later map
events to their documented state transitions; unknown or model-selected behavior must remain
conditional rather than being promoted by this generic mechanism.
