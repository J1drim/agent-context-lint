# Cursor local metadata observation — 2026-08-02

Purpose: refresh locally available Cursor surfaces for D11 using inert version output only. The
observation did not authenticate, start a model session, read user configuration, spend quota,
inspect repository content, execute a repository command, or write outside this documentation
worktree.

Environment: macOS arm64, Europe/Warsaw. User/account identifiers and absolute binary locations are
omitted because they are irrelevant to the compatibility claim.

## Normalized transcript

```text
$ cursor --version
[timestamp]:ERROR:electron/shell/common/mac/codesign_util.cc:79 task_name_for_pid: (os/kern) failure (5)
3.12.30
63a2996a10d9e476b6c28e951dd7691d9c0cf480
arm64

$ agent --version
2026.05.24-dda726e

$ cursor-agent --version
2026.05.24-dda726e
```

All three metadata commands exited with status zero. The `cursor` launcher also emitted the shown
macOS code-signing diagnostic on standard error. It did not prevent version output, but it is
retained as an observation warning rather than silently treated as success-only evidence. The
timestamp was normalized; the diagnostic text and numeric failure code were preserved.

## Supported claims

- The IDE launcher reported version `3.12.30`, revision `63a2996a10d9e476b6c28e951dd7691d9c0cf480`,
  and `arm64`.
- `agent` and `cursor-agent` both reported `2026.05.24-dda726e`.
- Metadata-only invocations returned without a model request.

## Unsupported claims

This transcript establishes no rule discovery, parsing, activation, ordering, glob, nested-root,
reference, legacy, or adherence behavior. It also does not prove that mutable current documentation
exactly describes either installed binary. Those conclusions remain documented-current,
versioned-historical, model-selected, unknown, or blocked for later observation as labeled in the
[compatibility contract](../compatibility.md).
