# Instruction intermediate representation

`@agent-context/core` exposes the B03 instruction intermediate representation as the closed,
versioned `agent-context-instruction-ir` JSON contract. It separates repository source syntax from
profile-owned behavior and gives parsers, profiles, the resolver, diagnostics, and formatters one
portable graph to exchange.

The current contract version is `0.1.0`. Validate untrusted input with `validateInstructionIr` or
use `isInstructionIr` when only Boolean narrowing is needed:

```ts
import { validateInstructionIr } from "@agent-context/core";

const result = validateInstructionIr(JSON.parse(input));
if (!result.ok) {
  for (const issue of result.issues) {
    console.error(`${issue.path}: ${issue.message}`);
  }
  return;
}

const ir = result.value;
```

Validation first rejects any non-JSON runtime structure anywhere in the envelope, then applies the
closed versioned shape and semantic checks. It is synchronous, deterministic, offline, and
side-effect free. It performs no filesystem, network, environment, profile resolution, import
loading, glob matching, or command execution.

`validateInstructionIr` is the compatibility-stable B03 shape validator. A successful result retains
the caller's object identity; it does not clone or freeze the graph. Engine code that will retain
B03 across an asynchronous boundary must instead call `createInstructionIrSnapshot` before its first
callback, yield, or `await`:

```ts
import { createInstructionIrSnapshot, isIssuedInstructionIrSnapshot } from "@agent-context/core";

const admitted = createInstructionIrSnapshot(untrustedValue);
if (!admitted.ok) return admitted;

const ir = admitted.value; // detached, recursively frozen, and same-process issued
if (!isIssuedInstructionIrSnapshot(ir)) throw new Error("snapshot authority was lost");
```

Snapshot admission first inspects the root and the eight collection lengths through own data
descriptors. It then copies JSON data through descriptors before semantic validation. Proxies,
revoked proxies, accessors, symbols, inherited or exotic objects, non-enumerable fields,
sparse/extended arrays, malformed Unicode, non-JSON numbers and values, excessive nesting, and
cycles fail closed without invoking repository-controlled code. Repeated acyclic object references
are retained as one immutable detached object because they do not change JSON meaning.

The snapshot carries no enumerable brand, so it remains a valid B03 graph. Same-process authority is
held privately by object identity and can be tested with `isIssuedInstructionIrSnapshot`.
Serialization, spreading, structured cloning, or reconstructing the graph loses that authority; the
resulting data must be admitted again. `getInstructionIrSnapshotProvenance` returns frozen counts,
measured byte/value usage, and a `sha256-canonical-b03-v1` digest only for the exact issued object.
The digest is deterministic content evidence, not a substitute for object identity.

`INSTRUCTION_IR_SNAPSHOT_LIMITS` publishes the non-configurable engine ceilings:

| Resource                                           |                        Limit |
| -------------------------------------------------- | ---------------------------: |
| Sources / documents                                |                1,024 / 4,096 |
| AST nodes / child references                       |              50,000 / 50,000 |
| Imports / statements / statement-node references   | 50,000 / 100,000 / 1,000,000 |
| Activation rules / selectors / evidence references |      4,096 / 65,536 / 65,536 |
| Targets / events                                   |               4,096 / 16,384 |
| One source, UTF-8 bytes and UTF-16 code units      |                 524,288 each |
| All sources, UTF-8 bytes and UTF-16 code units     |                  16 MiB each |
| One JSON container / complete JSON values          |          100,000 / 4,000,000 |
| One key / one string / cumulative strings          |       1 KiB / 1 MiB / 64 MiB |
| Event setting JSON values                          |                       65,536 |

Per-rule selectors and evidence references are additionally capped at 4,096, conditions at 1,024,
and each event may contain at most 4,096 workspace roots, settings, or selected rules. Nesting and
retained validation issues remain capped at 256. These limits are simultaneous and cannot be widened
by a caller. Admission is intentionally synchronous: cancellation-aware orchestrators check before
and immediately after this bounded step, and snapshot completion occurs before any admitted yield
can expose caller mutation.

## Envelope and identity

An `InstructionIr` has flat `sources`, `documents`, `nodes`, `imports`, `statements`,
`activationRules`, `targets`, and `events` collections. Relationships use IDs rather than nested
objects, so the JSON graph cannot contain object cycles. Validation checks unique IDs, foreign keys,
bidirectional document ownership, AST reachability, single-parent structure, cycles, containment,
and sibling ordering. Canonical source paths are unique, and each source nominates its only
`root`-kind node.

Entity IDs are branded strings in TypeScript. The brands prevent accidentally mixing a source ID
with a node, statement, rule, target, or event ID. Brands do not survive JSON serialization and must
never be recreated with an unchecked cast at an untrusted boundary. The supported construction path
is:

1. Build an ordinary JSON-shaped value with deterministic stable identifier strings.
2. Validate the complete envelope with `validateInstructionIr`.
3. Use the branded IDs from the narrowed `result.value`.

Whole-envelope validation is intentional: validating one ID alone could not prove uniqueness or its
relationships. B04 fingerprints are a different identity with cross-edit stability requirements; B03
entity IDs only need to be deterministic for identical input and must not be reused as diagnostic
fingerprints.

## Sources and exact ranges

Public source paths are canonical branded repository-relative POSIX paths. Absolute paths remain
transient discovery data because serializing them would make results host-specific and could
disclose machine layout.

`SourceDocument` preserves the exact decoded UTF-8 text, UTF-8 BOM fact, UTF-8 byte length,
JavaScript UTF-16 length, SHA-256 digest, line-ending form, parse state, and root AST ID. Text is
not normalized. Malformed UTF-16, incorrect lengths, a digest mismatch, or a BOM/line-ending claim
that differs from the text is rejected.

Every `SourceRange` is zero-based and half-open: `[start, end)`. A position records all four facts:

- `byteOffset`: bytes in the UTF-8 encoding before the position;
- `utf16Offset`: JavaScript string code units before the position;
- `line`: line number, advanced after LF or a lone CR; CRLF advances it once, after LF;
- `utf16Column`: UTF-16 code units since the line start immediately after the preceding recognized
  line ending.

Ranges cannot split a surrogate pair. The validator recomputes all coordinates from the exact
source, not from other supplied coordinates. Line-ending facts distinguish `none`, `lf`, `cr`,
`crlf`, and `mixed`. In CRLF, CR remains a code unit and column on the current line; the line and
column reset only after LF. A lone CR resets them immediately after itself.

Validation builds one byte-offset and line-start index per source. Index construction is linear in
the source length; each range endpoint then uses constant-time byte lookup and logarithmic line
lookup rather than rescanning the source.

`validateSourceRange(source, value)` exposes the same semantic range validation for B04 diagnostics
and fixes. `sliceSourceRange(source, value)` returns a discriminated success/error result and only
slices after validation:

```ts
import { sliceSourceRange } from "@agent-context/core";

const result = sliceSourceRange(source, candidateRange);
if (result.ok) console.log(result.text);
```

Call these utilities with a `SourceDocument` obtained from a validated envelope. They apply the same
strict no-throw JSON preflight to both arguments and validate the source's exact text facts again,
so a forged range cannot rely on accessors, proxies, inconsistent bytes, or inconsistent digest
data.

## Flat AST and statements

The AST vocabulary is a closed discriminated union covering root, heading, paragraph, list, list
item, block quote, code block, inline code, link, HTML comment, frontmatter, text, and explicitly
unknown tolerant nodes. Kind-specific fields are required and other fields are rejected. `unknown`
retains the parser kind and a reason rather than silently discarding malformed or extension syntax.

Statements retain their exact source text, range, and contributing AST node IDs. Node IDs are unique
and name ordered, non-overlapping siblings whose ranges are contained by the statement range; this
supports statements assembled from multiple adjacent syntax nodes without ambiguous ordering.
Classification is explicitly either `unclassified` or `classified`; absence never implies a
classification. B03 defines the transport shape only. F03 owns normalization and deterministic
classification behavior.

## Imports

`ImportReference` describes recognized source syntax, not an import graph result. It preserves exact
token/specifier ranges, the raw specifier, syntax kind, target classification, parse state, and B02
uncertainty. The raw specifier must equal its source slice.

No B03 field claims that a candidate exists, is inside the repository, is allowed by a profile, was
loaded, or is cycle-free. C10 owns safe target resolution, root-boundary decisions, limits, cycles,
and the occurrence-aware import graph.

## Profile-owned activation

Every `ActivationRule` names its document, client profile, surface, and specification snapshot. This
prevents a syntax definition from acquiring universal vendor behavior. Rules retain one of `always`,
`directory-tree`, `glob`, `manual`, `conditional`, or `unknown`, plus include/exclude selectors,
scope root, descriptive conditions, explicit uncertainty, and evidence.

Glob selectors retain their raw pattern and a dialect ID or explicit unknown dialect. B03 does not
match paths or implement an activation algebra. E01 resolves an `ActivationRuleId` as one unit;
`conditions` are evidence-backed descriptions and are not independently addressable predicates. E02
owns profile-specific glob behavior.

Include and exclude selectors are generic restrictions on every activation kind. An `always` rule
may therefore retain path selectors (for example, an exclusion for a generated directory), but it
cannot declare `conditions`; the trigger remains unconditional before E01 applies those path
restrictions.

Evidence references pair a B02 specification source ID with an optional research fact anchor. A fact
such as `COP-GAP-001` is not misrepresented as a snapshot source ID.

## Targets and events

Events are a closed TypeScript discriminated union and closed at JSON ingress. Shared event facts
are ID, sequence, target ID or explicit `null`, and uncertainty. Kind-specific payloads exist only
where meaningful:

- `launch` carries CWD, workspace roots, and JSON-safe settings;
- path events carry one canonical repository path;
- `manual-rule-mention` carries one rule ID;
- `rule-selection` carries non-empty unique rule IDs and a `profile`, `model`, `user`, or `unknown`
  selection source;
- `settings-change` carries non-empty settings; and
- memory, review, hosted-task, compact, and restart events have no invented generic payload.

Targets are explicit entities, so event target references are validated. Events are ordered by a
zero-based, gap-free sequence. Settings accept only true JSON: finite numbers other than negative
zero, dense arrays, plain objects, string keys, and no cycles, symbols, exotic prototypes, bigint,
functions, accessors, proxies, non-enumerable properties, numeric non-index array properties, or
`undefined`. Arrays must have canonical enumerable indices with no gaps. Whole-envelope JSON
traversal uses a depth-sized traversal stack and inspects huge sparse arrays by their own keys
rather than declared length. At most 256 container levels, including the envelope itself, are
accepted.

Validation retains at most 255 ordinary issues. When another issue is discovered, it appends the
stable `resource-limit` sentinel at `$` and stops. The resulting 256 entries equal
`MAX_VALIDATION_ISSUES`; ordering is deterministic for identical input.

B03 validates event structure only. E03 owns trace builders, conservative selected-rule
interpretation, synthetic single-target traces, trace normalization, canonical serialization, and
bounded setting-state queries. See [`resolution-event-traces.md`](resolution-event-traces.md) for
the implemented contract and the boundary between generic trace evidence and profile semantics.

## Contract boundaries

The B03 package deliberately does not provide Markdown/YAML parsing, filesystem access, import
resolution, activation matching, event execution, diagnostic fingerprints, fixes, or suppression.
Those behaviors belong to their dependent tickets and consume the validated IR rather than weakening
its boundary.
