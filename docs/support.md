# Runtime and platform support

Agent Context Linter v1 targets maintained Node.js LTS releases and the three
major desktop/server operating-system families.

## Node.js

The supported engine range is `^24.11.0 || ^26.0.0`:

| Line | State on 2026-08-01 | Product policy |
|---|---|---|
| Node.js 24 | Active LTS | Supported; `24.11.0` is the minimum and minimum-version CI target |
| Node.js 26 | Current | Allowed and tested informationally; release-blocking after upstream LTS promotion |
| Node.js 22 and earlier | Maintenance LTS or EOL | Unsupported because the release support horizon is too short |
| Odd-numbered releases | Current or EOL | Unsupported |

The exact developer baseline is Node.js `24.18.1`. That pin makes local and CI
tool output repeatable; it does not narrow the public engine range.

## Operating systems

Release-blocking support covers:

- GNU/Linux x64 and arm64 with kernel 4.18+ and glibc 2.28+ (Node.js 26
  additionally requires the `libatomic` runtime);
- macOS 13.5+ on Intel or Apple Silicon; and
- Windows 10/11 and Windows Server 2016+ on x64.

Windows arm64 is compatible but not release-blocking in v1. Node.js experimental
platforms, including musl/Alpine and FreeBSD, are not supported. WSL is treated as
Linux compatibility; WSL-only failures are not release blockers.

The authoritative rationale and lifecycle rules are in
[ADR-0001](architecture/decisions/0001-runtime-and-platform-support.md).

## Package managers

Contributors use exactly pnpm `11.18.0`. Consumers may install the packed public
artifact with npm, pnpm, Yarn, or Bun, but execution still requires a supported
Node.js runtime. See
[ADR-0002](architecture/decisions/0002-package-manager-and-version-policy.md)
for the repository and lockfile policy.

## Reporting a platform problem

Include the output of `node --version`, the operating system version, architecture,
libc family/version on Linux, install package manager/version, and the smallest
repository fixture that reproduces the problem. Do not attach secrets or a private
repository. Routing, response expectations, and the contact address are in the
root [support policy](../SUPPORT.md); vulnerabilities use the root
[security policy](../SECURITY.md).
