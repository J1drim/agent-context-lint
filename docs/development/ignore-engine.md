# C04 ordered ignore-engine design

C04 is implemented by `packages/evidence/src/ignore-engine.ts`. It consumes C03's canonical path set
and C02's root-jailed read capability. C05 and later discovery stages must retain the result's
certainty and rule provenance rather than accepting only its filtered `paths` array.

## Trust and ordering model

The C03 source distinction is semantic, not informational decoration. A verified index contains only
tracked identities, and Git documents that tracked files are not affected by ignore rules. C04 does
not even read repository ignore files on that path. Filesystem fallback contains both tracked and
untracked candidates, so repository-ignore decisions are explicitly tracking-uncertain.

Git's documented external sources are deliberately not replicated. `$GIT_COMMON_DIR/info/exclude` is
inside administrative metadata that C03 excludes, and `core.excludesFile` is global ambient state
outside the selected root. Reading either would violate the normal-scan authority boundary. The
linter's validated repository configuration is an explicit, portable source instead.

Safety built-ins are the highest positive layer and cannot be negated. Configuration is the highest
configurable layer, followed by known-active profile facts and repository `.gitignore`. Within the
repository layer, rules are loaded root-to-leaf and retain line order, giving a deeper file the
documented precedence. Before reading a nested ignore file, the engine evaluates its containing
directory using rules already available. An excluded directory stops that read and all descendant
re-inclusion.

Profile facts are closed plain-data records with applicability, client version, evidence class,
stable fact/profile identifiers, reason, retrieval date, and an HTTPS source. Only `known-active`
facts enter the matcher. Known inactive and uncertain states remain in the result, and uncertain
states are separately enumerated for downstream reporting.

## Finite matcher

Patterns compile into immutable component tokens. Ordinary components use dynamic programming for
literal, `?`, `*`, and bracket-class matching. Full paths use a second dynamic program in which a
standalone `**` component consumes zero or more pathname components. No user text becomes a regular
expression, so adversarial wildcard repetition cannot trigger regex backtracking.

Every rule check, path/component comparison, and dynamic-programming cell consumes deterministic
`maximumMatchWork`. Path count/depth, rule count/bytes/length, ignore-file count/size, retained
problems, and monotonic elapsed time have independent bounds. The matcher checks a native
`AbortSignal` and time while consuming work. `applyIgnoreRulesWithClock` is the trusted
test/internal form used to verify deadlines without a real-time race.

Ignore files are discovered only from C03 fallback paths. They are inspected before reading, must be
ordinary non-link files, and are then compared by device/inode across the C02 read. Individual safe
unavailability becomes bounded provenance; path changes, cancellation, concurrent C02 use,
deadlines, and aggregate C02 limits propagate. Decoding is fatal UTF-8 with CRLF handling and
rejects BOM, C0/C1 controls, bidi controls, and malformed Unicode.

## Verification and sources

The committed `conformance/fixtures/v0/gitignore-2.55.0.fixture.json` corpus contains byte-exact
patterns and expected outcomes derived from official examples and grammar. It covers basename and
anchored rules, middle/trailing separators, directory-only behavior, order/negation, excluded
parents, all documented `**` positions, escaping, trailing spaces, comments, question marks,
classes/ranges, and case sensitivity. Tests add nested precedence, unreadable/link/race behavior,
tracked-versus-fallback uncertainty, source precedence, profile deferral, malformed input, hostile
objects, cancellation/deadline, and every resource boundary. Product and tests invoke no Git
command.

Primary source, retrieved 2026-08-02 with the documentation version selector pinned to 2.55.0:

- Git `gitignore` 2.55.0: <https://git-scm.com/docs/gitignore/2.55.0> (source precedence, relative
  nested files, last-match ordering, comments, spaces, negation and excluded parents, slash and
  directory behavior, wildcard/classes, `**`, symlink behavior, and tracked-file limitation).

Observed-versus-documented boundary: conformance is against the published pathname grammar, not
ambient `fnmatch(3)` locale behavior, global excludes, repository-local administrative excludes, or
undocumented client rules. Matching is deterministic Unicode-scalar and case-sensitive on every
host. Profile behavior remains conditional or unknown unless supplied as a provenance-complete
known-active fact.
