# Mechanical-fix security boundary

Repository text, filenames, Markdown AST data, diagnostics, suppressions, configuration, caches,
serialized plans, and plug-in output are untrusted data. None can mint fix authority. I12 accepts
only the exact in-memory finalization produced by F05 after the genuine B08 matcher has processed
genuine parser-owned directives.

## Threats and controls

| Threat | Control |
| --- | --- |
| Forge or copy a result that says a suppression is unused | Finalization ownership is held in a private `WeakMap`; clones, serialization, proxies, and lookalikes fail closed. |
| Copy a candidate to another diagnostic or change its replacement | I11 capability state binds the exact rule/version, diagnostic ID, plan ID, and canonical plan digest. |
| Shift a Unicode/CRLF range onto different text | B03 validates byte and UTF-16 coordinates; I12 incorporates the exact fragment SHA-256 into the plan ID, and I11 binds that ID plus the canonical plan digest while B04 retains its frozen v0 shape. |
| Change the file after scan or replace it with a link | I11 re-reads bytes/device/inode and I10 repeats root-jail, no-link, digest, metadata, and pre-rename checks. |
| Alter unrelated bytes or file permissions | I11 rebuilds only declared ranges and I10 preserves the existing mode. Property and filesystem tests compare all outside bytes and mode. |
| Omit another rule family's diagnostics and falsely call its suppression unused | I12 approves only one exact ACL100–ACL108 target from the authenticated complete unfiltered F05 result. Cross-family, multi-rule, ACL109-target, wildcard, and malformed directives remain refusal-only without dedicated complete unfiltered authority. |
| Turn a suggestion into broad policy rewriting | The exhaustive matrix approves only the proven ACL109 subset; subjective, semantic, security, standards, profile-dependent, and efficiency rules receive no capability. |
| Trigger writes, commands, or network during planning | The planner is synchronous and capability-free. Filesystem authority exists only in explicit I11 preview/apply; no process or network API is accepted. |
| Exhaust memory or create a huge transaction | B03/B04, suppression parsing, eligibility, operation, source, replacement, and patch bounds apply before publication. |

Eligible ACL109 removal is limited to the exact HTML comment range. The following physical line, preceding
text, line-ending bytes, BOM state, file mode, and every other source byte remain unchanged. The
newline adjacent to the comment is deliberately preserved, avoiding an inferred formatting edit.

Create, move, delete, multi-file, and sequential best-effort writes remain outside I12. Security
diagnostics ACL400–ACL406 never auto-redact or rewrite repository content because doing so could
destroy evidence, expose a secret through a preview, or choose policy on the user's behalf.
