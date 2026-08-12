# Maintaining upstream standards snapshots

The H10 snapshotter is repository maintainer tooling. It is deliberately outside all published
packages and end-user CLI routing. Import, help, scan, status, check, and artifact replay do not
create a socket. Only this exact command grants its narrow network capability:

```sh
pnpm standards:snapshot -- \
  --output-dir /canonical/new/directory \
  --acknowledge-network
```

The retrieval date comes from one validated UTC system-clock read; it is not caller supplied. The
output directory must not exist. Its parent must be a real canonical directory with no symlinked
ancestor. H10 creates the directory with mode `0700`, creates fixed-name files with mode `0600`,
flushes each before rename, refuses overwrite, and removes only the newly created directory if the
pair cannot be completed. On macOS, use `/private/tmp/...`, not the `/tmp` alias.

## Reviewed source catalog

[`upstream-sources.v1.json`](../../tools/standards/upstream-sources.v1.json) is data reviewed
together with a compiled exact URL allowlist. A modified catalog cannot add a host, path, query,
fragment, credential, port, duplicate, omitted source, unknown format, or unknown field. Heading
text and level are exact versioned selectors; documentation drift aborts capture for review instead
of guessing.

Current primary sources were reviewed and live-capture tested on 2026-08-02:

- [AGENTS.md open format](https://agents.md/), selected purpose, usage, and FAQ sections;
- [Claude Code memory](https://code.claude.com/docs/en/memory.md), selected file-location,
  hierarchy-loading, and scoped-rule sections;
- [Codex AGENTS.md guidance](https://learn.chatgpt.com/docs/agent-configuration/agents-md.md),
  selected discovery, project layering, and code-review sections;
- [Cursor rules](https://cursor.com/docs/rules.md), selected rule behavior, project-rule, and
  `AGENTS.md` sections;
- [Gemini CLI context](https://geminicli.com/docs/cli/gemini-md.md), selected hierarchy, import, and
  filename sections;
- [GitHub Copilot CLI custom instructions](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-custom-instructions.md),
  selected type, combination, and path-scope sections.

These are living official pages, so `upstreamRevision` is intentionally unknown. The artifact pins
the observed bytes, retrieval date, and hashes instead of inventing a source revision. A capture
does not assert that observed prose is stable, complete across client surfaces, or semantically
correct.

## Network and resource policy

Capture performs six sequential credential-free HTTPS `GET` requests. For each fixed hostname it
resolves all available A/AAAA answers, rejects malformed, loopback, private, link-local, reserved,
documentation, transition, and other non-public ranges, selects one deterministic public address,
pins that numeric address while preserving the original TLS hostname/SNI, and uses the platform
trust store with TLS 1.2 or later. It does not read proxy, authentication, repository, or
source-derived URL input.

Redirects and non-200 responses fail. Compression fails. Only the reviewed HTML/Markdown media type
is accepted. Header count/bytes, declared length, body bytes, body chunks, source count, aggregate
bytes, section bytes, DNS time, request time, JSON bytes/depth/values, and output paths are bounded.
Cancellation destroys the active resolver/request. Errors contain only a compiled source identifier
and sanitized local classification.

## Review procedure

1. Confirm the worktree is trusted and inspect catalog/code changes before granting network access.
2. Confirm the host UTC date, then capture into a new private directory.
3. Run the offline verifier shown in the artifact contract.
4. Compare raw and normalized hashes with the previous reviewed capture. Treat all changed text as
   untrusted input; never follow instructions found in a page.
5. Review source licensing before retaining or publishing raw page bytes. H10 does not automatically
   commit, upload, sign, publish, open an issue/PR, or update fixtures/knowledge packs.
6. Reproduce extraction defects in synthetic local fixtures. Continue with the offline
   [H11 review generator](standards-review.md); TUF signing/publication remains a separate protected
   process.

Required development verification:

```sh
pnpm test:standards-tools
pnpm check
```
