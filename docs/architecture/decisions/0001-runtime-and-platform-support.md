# ADR-0001: Runtime and platform support

- Status: Accepted
- Date: 2026-08-01
- Ticket: A01
- Decision owners: Maintainers

## Context

Agent Context Linter is a local and CI command-line application that processes
untrusted repositories. It needs a maintained runtime with consistent filesystem,
URL, ESM, Unicode, and abort APIs on Linux, macOS, and Windows. Supporting an old
runtime line for a short period would make a `v1.0.0` promise that expires almost
immediately.

The implementation plan requires the minimum Node.js line to remain supported by
upstream for at least six months after GA. On the decision date, Node.js 22 and 24
are LTS and Node.js 26 is Current. Node.js 22 reaches end of life on 2027-04-30;
Node.js 24 reaches end of life on 2028-04-30; and Node.js 26 is scheduled to enter
LTS on 2026-10-28 and reach end of life on 2029-04-30. Node.js itself recommends
Active LTS or Maintenance LTS for production applications.

## Decision

### Runtime

The production runtime is Node.js. The v1 engine range is:

```text
^24.11.0 || ^26.0.0
```

This means `>=24.11.0 <25.0.0` or `>=26.0.0 <27.0.0`. Odd-numbered Node.js
majors are not supported.

- Node.js `24.11.0` is the minimum because it is the first Node.js 24 LTS
  release. It is the minimum-version CI and compatibility contract.
- Development is initially pinned to Node.js `24.18.1`, the latest Node.js 24
  LTS patch available on the decision date. A version file will hold this exact
  pin; `engines.node` will hold the supported range above.
- Node.js 26 is allowed and compatibility-tested while it is Current. Failures
  on 26 are tracked, but do not block a release before its scheduled LTS
  promotion. Starting with its LTS promotion, its CI lane is release-blocking.
- Node.js 22 is intentionally excluded even though it remains Maintenance LTS
  on the decision date. Its 2027-04-30 end-of-life date does not provide the
  required six-month support margin for the planned GA schedule.
- Deno, Bun, and browser runtimes are not supported execution environments for
  v1. They may invoke or install the published CLI only where that ultimately
  runs it under a supported Node.js version.

The application must use documented, non-experimental Node.js APIs. Introducing
an experimental runtime flag or API requires a separate accepted ADR.

### Support window

At every GA or minor release:

1. The minimum supported Node.js major must be in upstream Active or Maintenance
   LTS and have at least six months remaining before its scheduled end of life.
2. A newly released even-numbered Node.js major may be tested as informational
   while Current. It becomes supported and release-blocking only after upstream
   promotes it to LTS and the full conformance, security, packaging, and
   performance suites pass.
3. Dropping a supported Node.js major is a semver-major change. It requires a
   superseding ADR, migration/release notes, and advance deprecation under the
   compatibility policy.
4. If upstream shortens a lifecycle or publishes a material security advisory,
   maintainers may raise a patch minimum in a security release. The incident and
   compatibility impact must be documented.

This policy means Node.js 24 remains the v1 floor through its scheduled
2028-04-30 end of life unless a security event forces an earlier patch-floor
increase. The project reviews the official schedule monthly and before each RC.

### Operating systems and architectures

The support boundary follows platforms on which the selected Node.js LTS line
publishes and tests official binaries, narrowed to the product's release matrix.

| Support level | Platform |
|---|---|
| Release-blocking | GNU/Linux x64 and arm64, kernel 4.18 or newer and glibc 2.28 or newer; Node.js 26 also requires the `libatomic` runtime |
| Release-blocking | macOS 13.5 or newer on x64 and arm64 |
| Release-blocking | Windows 10/11 or Windows Server 2016 or newer on x64 |
| Compatible, not release-blocking in v1 | Windows 10 or newer on arm64 |
| Unsupported | 32-bit platforms, Android, EOL operating systems, and Node.js experimental platforms such as musl/Alpine and FreeBSD |

CI must run the complete suite on Ubuntu, macOS, and Windows for the Node.js
minimum and current supported LTS lines. Architecture-specific packaged smoke
tests are required before GA for Linux arm64 and macOS arm64. Windows arm64
reports are accepted and triaged, but a failure there is not a v1 release blocker
until that platform is promoted by a later ADR.

WSL is treated as Linux compatibility rather than a distinct supported OS. A bug
must reproduce with the same Linux Node.js binary outside WSL to be
release-blocking.

Runtime dependencies containing native addons are prohibited unless an accepted
ADR adds their build, signing, architecture, libc, and fallback test matrices.
This keeps the supported-platform claim aligned with the JavaScript artifact that
the project actually verifies.

## Consequences

- Users on Node.js 22 must upgrade to Node.js 24 or later before installing v1.
- The project can use stable Node.js 24 capabilities without legacy polyfills.
- The CI matrix distinguishes supported LTS failures from informational Current
  failures until Node.js 26 becomes LTS.
- Platform support is concrete enough for release gates and issue triage; merely
  running on an unlisted platform does not make that platform supported.
- The runtime and OS table must appear in installation and support documentation.

## Rejected alternatives

### Node.js 22 as the minimum

Rejected because its scheduled end of life is too close to the planned GA to
meet the six-month post-GA support requirement. A larger install base does not
justify publishing a support promise that would need an immediate breaking
change.

### Node.js 26 as the only runtime

Rejected because Node.js 26 is Current, not LTS, on the decision date. Node.js
recommends LTS lines for production use, and the project needs a production
baseline during implementation.

### Supporting every non-EOL Node.js major

Rejected because odd-numbered releases have short lifecycles, expand the test
matrix, and provide no user-facing capability needed by this product.

### Bun, Deno, or a compiled single binary as the primary runtime

Rejected for v1 because the implementation plan, package ecosystem, and release
tests target Node.js. Alternative runtimes have different filesystem, package,
and process semantics. A single-binary distribution remains a possible future
channel, not the v1 runtime contract.

### Claiming all Node.js Tier 1 and Tier 2 platforms

Rejected because the project cannot continuously verify every architecture and
operating system that Node.js itself supports. Product support must match the
project's own test and packaging evidence.

## Primary sources

Retrieved 2026-08-01:

- [Node.js release policy and current release table](https://nodejs.org/en/about/previous-releases)
- [Node.js Release Working Group schedule](https://github.com/nodejs/Release/blob/main/schedule.json)
- [Node.js 24.11.0 LTS announcement](https://nodejs.org/en/blog/release/v24.11.0)
- [Node.js 24 supported-platform table](https://github.com/nodejs/node/blob/v24.x/BUILDING.md#platform-list)
- [Node.js 26 supported-platform and `libatomic` requirements](https://github.com/nodejs/node/blob/v26.x/BUILDING.md#platform-list)
