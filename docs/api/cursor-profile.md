# Stateful Cursor profile

Status: D13 resolver contract, wire version `0.1.0`; product release `1.0.0`

`resolveCursorProfile` evaluates caller-authorized D12 Cursor rule snapshots against an explicit,
bounded runtime snapshot. It supports the separate `cursor-agent/ide` and `cursor-agent/cli`
surfaces. The resolver is deterministic, offline, read-only, and model-free: it never discovers
files, reads reference targets, starts Cursor, evaluates repository commands, calls a model, or
consults ambient IDE/account state.

## Profile evidence

The immutable D13 catalog publishes both Cursor surfaces under profile `cursor-agent`, spec snapshot
`cursor/2026-08-01`, and the Cursor-owned E02 dialect `cursor-agent/mdc-globs/2026-08-01`.

- IDE metadata is pinned to `3.12.30`. MDC support starts at documented Cursor `0.45`; Agent
  read/write Auto events start at documented Cursor `0.49`. Root legacy `.cursorrules` is supported.
- Agent CLI metadata is pinned to `2026.05.24-dda726e`. Current documentation establishes MDC rule
  support, but does not independently establish legacy support or version-bind read/write behavior.

The local version observations establish identity only. Mixed modes, model selections, reference
bases, legacy/MDC precedence, and Cursor's glob grammar remain conditional where D11 lacks
first-party authority or D16 observation evidence.

## Input

The resolver accepts exactly `candidates` and `runtime`.

Each candidate contains exactly:

- `bytes`: intrinsic `Uint8Array`, copied before parsing and capped at 262,144 bytes;
- `format`: `mdc` or `legacy`;
- `path`: canonical repository-relative path.

The runtime contains exactly:

- `surfaceId`: `cursor-agent/ide` or `cursor-agent/cli`;
- `clientVersion`: bounded stable text or `null`;
- `workspaceRoots`: non-empty, unique repository-relative roots;
- `projectRules`: `enabled`, `disabled`, or `unknown`;
- `externalContext`: `absent`, `present`, or `unknown` for unseen user/team state;
- `eventState`: `present`, `absent`, or `unknown`;
- `events`: uniquely sequenced path, manual-mention, and Agent-selection events.

Path events are `reference-path`, `read-path`, or `write-path`. A Manual event supplies rule name,
optional exact candidate path, and target path. An Agent selection supplies exact candidate path,
target path, and `selected`, `not-selected`, or `unknown`. Events are sorted by sequence; the latest
applicable Agent selection is used. `present` requires at least one event, while `absent` forbids
events.

Inputs are closed data records. Proxies, inherited records, accessors, unknown fields, duplicate
candidate paths, duplicate event sequences, invalid relationships, and excessive candidate/event/
root/path/byte work fail with `CursorProfileError`. Error messages are fixed and do not reflect
hostile values.

## Separate activation dimensions

Each candidate exposes four channels:

- `always`: mechanical event and nested-location state;
- `autoAttached`: mechanical event, version, location, and E02 glob state;
- `manual`: explicit mention state with duplicate-name ambiguity;
- `agentRequested`: `selected`, `not-selected`, `indeterminate`, or `not-applicable`.

`mechanicalActivation` combines only Always, Auto, and Manual. Agent Requested selection never
enters that value. A description makes a rule eligible for model selection, but the resolver returns
`indeterminate` until the caller supplies an `agent-rule-selection` event. Thus repository text
cannot cause a model call or be promoted to deterministic relevance.

Canonical root Always and exact Manual events can resolve active/inactive. Auto delegates only to
the Cursor-owned E02 dialect. Because D11 records its base and wildcard behavior as unknown, normal
wildcard candidates remain indeterminate rather than inheriting another product's matcher.

## Unknown and contradictory states

The following remain explicit rather than receiving guessed precedence:

- missing, mixed, or conditional MDC mode syntax;
- nested Always/Auto metadata interaction when an in-scope event exists;
- overlapping workspace-root discovery;
- CLI legacy support;
- legacy and MDC coexistence;
- unknown project-rule settings or versions;
- unseen user/team context;
- undocumented reference bases and token interpretation.

A definitely out-of-scope target may still make a nested canonical channel inactive. Malformed D12
syntax, an unsupported pre-`0.45` IDE version, a disabled MDC setting, or a candidate outside all
workspace roots cannot establish activation.

## Targets and references

Every path event receives a target decision containing location eligibility, glob eligibility,
event-version support, and Auto state. No target file is opened. D12 reference candidates remain
attached to their parent decision. An inactive parent produces an inactive reference; otherwise the
reference stays indeterminate with both `rule-directory` and `workspace-root` candidate bases.

## Output and limits

Results include the profile descriptor, normalized runtime snapshot, sorted candidate decisions,
syntax evidence, channel states, targets, references, version state, fixed decision reason, and
`complete` or `partial` analysis status. External context or any indeterminate candidate makes the
analysis partial. Every result, nested record, and collection is frozen.

The canonical state fixture is `conformance/fixtures/v0/cursor-stateful-profile.fixture.json`.
Focused tests cover all four modes, nested roots, version boundaries, legacy/coexistence, model
selection, settings, references, hostile inputs, limits, determinism, and immutability.
