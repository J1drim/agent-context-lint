# Migrating multi-agent instruction layouts

Agent Context Linter can inventory and compare instruction files during a migration, but it does not
translate prose, choose a precedence winner, or rewrite a vendor file automatically. Client behavior
that depends on a model, UI, user settings, launch state, or a hosted service remains conditional.
Preserve the original files until the destination layout has been reviewed.

## A safe migration sequence

1. Create a branch or backup outside the repository's generated and dependency directories.
2. Run a read-only inventory before changing files:

   ```sh
   npx --no-install agent-context-lint list . --format json >agent-context-before-list.json
   npx --no-install agent-context-lint scan . --format json --fail-on never >agent-context-before-scan.json
   ```

3. Read the [profile limitations](profiles.md) and choose the exact client surface being migrated.
   Do not merge files merely because their names look similar.
4. Move or copy one policy group at a time. Keep the source file until the destination has been
   reviewed and the old path is intentionally retired.
5. Re-run `list`, `scan`, and `explain` for representative targets. Compare JSON reports and inspect
   every changed diagnostic; an unchanged token count does not prove equivalent behavior.
6. Run `git diff --check`, review the patch, and keep a rollback copy until the agent client has
   been exercised by the repository owner.

The linter's only current automatic preview is the conservative `ACL109` suppression cleanup:

```sh
npx --no-install agent-context-lint scan . --fix-dry-run
```

The preview is read-only. It does not migrate files, apply patches, or decide how conflicting prose
should be rewritten. See [mechanical-fix previews](mechanical-fixes.md).

## Common layouts

| Client family  | Current repository-visible locations                                                                                                 | Migration guidance                                                                                                                                                          | What a repository-only scan cannot establish                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Codex CLI      | `AGENTS.md` and configured fallback/override names in the root-to-working-directory chain                                            | Keep the chain and directory ownership explicit. Compare the old and new target resolutions with `explain`.                                                                 | User/global `CODEX_HOME`, launch state, and settings not supplied to the scan.                                       |
| Claude Code    | `CLAUDE.md`, `.claude/CLAUDE.md`, `.claude/rules/`, and local variants                                                               | Preserve launch-loaded versus on-demand scope. Keep imports and `paths` metadata visible while moving one subtree at a time.                                                | Managed/user instructions, runtime approval, session events, and semantic precedence.                                |
| GitHub Copilot | Surface-specific `.github/copilot-instructions.md`, `.github/instructions/**/*.instructions.md`, and supported `AGENTS.md` locations | Select a surface first: CLI, VS Code Chat, coding agent, and code review do not share one precedence contract. Keep `excludeAgent` scoped to the documented hosted surface. | Hosted branch/session timing, model-selected relevance, organization policy, and undocumented order/import behavior. |
| Gemini CLI     | `GEMINI.md`, configured context filenames, imports, and ignore files                                                                 | Preserve the configured filename and distinguish eager hierarchy from just-in-time evidence. Validate imports and ignore behavior separately.                               | User settings, `/memory` events, and behavior not pinned by the profile evidence.                                    |
| Cursor         | `.cursor/rules/*.mdc` plus the supported legacy root `.cursorrules`                                                                  | Prefer one explicit MDC rule per activation mode. Treat `.cursorrules` as legacy; review the emitted migration diagnostic before creating a replacement.                    | IDE/Agent CLI selection, model-selected activation, and unsupported glob or nested-root behavior.                    |

The detailed, versioned evidence for each row is in the
[profile specifications](../profiles/README.md). Unknown or contradictory vendor behavior is
intentionally not converted into a migration promise.

## Shared policy without cross-client assumptions

If one policy must be available to several clients, start with a canonical human-reviewed source and
create separate vendor files only where the profile documents a supported representation. Use
`canonical-policy sync --dry-run` where its contract applies; it is preview-first and refuses
ambiguous or unsupported projections. Do not assume that a Markdown link, an `@` reference, a
frontmatter field, or a filename has the same meaning on every client.

For each generated or copied file, record:

- the selected profile and surface;
- the source and destination paths;
- the intended activation scope and any imports;
- diagnostics before and after the change; and
- the reviewer decision for every conditional or unknown result.

## Rollback

If an agent behaves differently after migration, restore the last reviewed files from the backup,
re-run the before-scan command, and compare the resulting JSON identities. Do not delete the old
policy until the destination is confirmed. A standards lockfile or cache update has separate
activation and rollback rules; follow
[the standards rollback runbook](../operations/standards-update-rollback.md) rather than treating it
as a text migration.
