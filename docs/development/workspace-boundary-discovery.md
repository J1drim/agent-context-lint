# Workspace-boundary discovery design

## Pipeline and authority

    C03 tracked/fallback paths
              |
    C04 ignore partition
              |
    C05 built-in evidence candidates
              |
    C02 targeted, jailed reads
              |
    C11 inert parsing -> project/workspace/source boundaries

C11 does not enumerate directories or discover extra files. Read authority is the intersection of a
C05 candidate path, an allowlisted built-in evidence recognition, and its exact basename set.
Matcher-fact recognition cannot cross this boundary. Explicit folders and member globs remain
patterns; expansion belongs to a later bounded stage.

## Parser isolation

Production imports no process, shell, network, package-manager, build-system, plugin, Python, or
Starlark evaluator. Strict JSON is syntax-scanned before parsing to reject duplicate keys and
enforce node/depth limits. TOML, YAML, INI, and Go readers implement closed line-oriented subsets.
Unknown configuration is not interpreted.

- Syntax establishes only what inert bytes state.
- A source filename may establish a project or source marker.
- Ignored executable fields are named in the result.
- Unsupported syntax produces uncertainty without expanding a path.
- Malformed or unavailable evidence cannot be upgraded to complete.

Coordinates use zero-based lines and UTF-16 columns plus UTF-8 byte offsets. A bounded per-file
mapper computes them in linear time, including Unicode and mixed line endings. Output ordering does
not use host locale or filesystem enumeration order.

## Tests and fixtures

'conformance/fixtures/v0/workspace-boundaries.fixture.json' is synthetic and covers all 15 C05
evidence recognizers. Executable-looking canaries require zero reads for Bazel and setup.py markers
and verify that npm scripts, Nx plugins, Turbo tasks, Lerna commands, and Rush hooks are ignored
data. Additional tests cover malformed JSON/UTF-8, duplicate keys, invalid types, unsafe
TOML/YAML/Go members, vanished files, forged recognition/basename pairs, upstream uncertainty,
cancellation, deadlines, every resource limit, immutable output, and malformed capabilities.

Reproduce a hostile-input failure as the smallest project-owned synthetic fixture here. Do not
commit, patch, branch, comment on, or otherwise modify a repository selected for analysis.

## Extending C11

An additional format or field requires a C05 built-in recognizer with primary-source provenance, an
exact path authorization rule, a closed data grammar, explicit unsupported behavior, hostile and
resource tests, and corresponding API/security documentation. Never add a tool invocation as a
compatibility shortcut. Version-dependent or undocumented semantics remain conditional or unknown
profile facts.
