# Cursor D11 no-paid observation plan — 2026-08-02

Status: metadata phase executed; behavioral cases intentionally not executed.

This plan separates evidence obtainable without credentials or a model request from D16 behavior
that may consume subscription quota. It is a research plan, not an executable harness, and it grants
no authority to run Cursor against a repository.

## D11 authorization boundary

Allowed in D11:

- review current official Cursor documentation and versioned Cursor changelogs;
- record retrieval date, URL, documented scope, and absence of a revision hash;
- invoke locally installed clients only for inert version/help metadata;
- use synthetic path and metadata strings as unexecuted truth-table data;
- validate repository-owned JSON and Markdown with offline project tools.

Forbidden in D11:

- model, chat, print-mode, or background-agent requests;
- authentication, account inspection, credential reads, or quota use;
- asking Cursor to read, write, index, or execute anything in a repository;
- shell/MCP/hook/plugin/tool approval through Cursor;
- external writes, telemetry experiments, or GitHub/upstream mutation;
- treating a model-selected result from any single run as deterministic.

If a behavior cannot be learned inside the allowed set, its recorded outcome is
`blocked-paid-observation`, `model-selected`, `conditional`, or `unknown`—never a guessed pass/fail
result.

## Metadata transcript result

The [2026-08-02 local transcript](2026-08-02-local-metadata.md) pins IDE launcher `3.12.30` and
Agent CLI `2026.05.24-dda726e`. It records a non-fatal launcher warning. No help invocation was
needed for this refresh, and no behavior case was run.

## Synthetic D16 fixture matrix

The later D16 harness should construct a disposable, project-owned fixture for each row. Until
explicit paid-observation authorization exists, every row below has status
`blocked-paid-observation`.

| Group              | Minimum fixture dimensions                                                                                                  | Required evidence                                                                                            |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Canonical modes    | Always, Auto Attached, Agent Requested, Manual                                                                              | Client/surface version, generated MDC bytes, event trace, attached-rule evidence, state label                |
| Mixed metadata     | Every `alwaysApply` × empty/non-empty `globs` × empty/non-empty `description` combination, plus missing/type-invalid fields | Raw metadata, parsed fields, alternative outcomes, no inferred precedence                                    |
| Glob behavior      | single and multiple encodings; `*`, `**`, braces, leading `/` and `./`, separators, case, malformed pattern                 | Generated editor form, target spelling, platform, match observation, bounded failure                         |
| Nested roots       | root and nested rules; inside/outside target; each activation type; duplicate names; multi-root workspace                   | Workspace identity, rule-root identity, location eligibility, metadata eligibility, observed source sequence |
| File references    | active/inactive parent; candidate bases; missing/outside target; code spans; punctuation; chain/cycle                       | Raw token/span, candidate bases, root-boundary decision, expansion sequence, depth/cycle result              |
| Legacy coexistence | root and nested `.cursorrules`, MDC-only, legacy-only, both                                                                 | Discovery set, activation evidence, ordering/dedup alternatives, no automatic rewrite                        |
| Surface/root       | IDE and CLI separately; repository-root and subdirectory launch                                                             | Exact surface/version, supplied root, discovered root, external-context assumptions                          |

## D16 containment requirements

Before any behavioral run, an authorized operator must review a harness that:

1. creates a disposable synthetic workspace and isolated client-state directory with no user/team
   state;
2. supplies no repository, Git, SSH, cloud, package-manager, or model credential beyond the
   explicitly approved Cursor identity;
3. denies shell execution, writes outside the fixture, external reads, MCP, hooks, plugins, and
   nonessential network access;
4. hashes fixture bytes before and after each case and treats mutation outside the declared
   disposable output as an incident;
5. captures versions, invocation mode, exact event sequence, fixture digest, expected alternatives,
   observed attachment sequence, redacted raw evidence, and exit/failure state;
6. repeats deterministic candidates enough to expose instability while keeping every
   relevance-selected result conditional;
7. uses only synthetic marker text and stores no prompt, source, user, account, machine path, or
   suspected secret in artifacts;
8. stops on unexpected execution, external read/write, egress, credential access, warning,
   nondeterminism, or budget consumption.

Observation on one surface cannot settle the other. Observation on one client version cannot
silently become a version-independent promise. A generated MDC form can establish what that editor
version writes; it does not establish every form that the client accepts.

## Evidence promotion gate

A D16 result may change a D11 unknown only when it has a project-owned fixture, pinned
surface/client, reproducible event trace, raw redacted evidence, explicit observed-versus-documented
comparison, and reviewer approval. Otherwise the
[schema-neutral data record](../../data/cursor-rule-facts.v0.json) remains unchanged and the unknown
is preserved.
