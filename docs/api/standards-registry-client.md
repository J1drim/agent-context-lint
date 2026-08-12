# Explicit standards registry client

Ticket H07 adds a narrow transport boundary for acquiring inert standards bytes. The boundary is not
used by ordinary scan, import, or offline status paths. `StandardsRegistryClient.create()` is
default-deny and has no production origin in this release: it returns `registry-unconfigured` before
DNS or transport starts. This repository does not claim that a registry has been deployed. A future
release must add a reviewed, release-owned exact HTTPS origin in code and pass SR-04 before an H08
explicit standards command can acquire data.

Callers never provide an origin, URL, path, HTTP method, headers, credentials, or repository data.
They select one closed resource identifier:

```ts
const client = StandardsRegistryClient.create();
const result = await client.fetchObject(
  { kind: "metadata", role: "root", version: null },
  { signal: abortController.signal },
);
```

The internal path vocabulary is `/v1/metadata/<role>.json`, `/v1/metadata/<version>.<role>.json`, or
`/v1/packs/sha256-<lowercase-sha256>.json`. Versioned timestamp metadata is rejected, matching TUF
consistent-snapshot behavior. Only `GET` is emitted; requests have fixed `Accept`,
`Accept-Encoding: identity`, `Connection: close`, and `Host` fields. There is no ambient proxy,
cookie, authorization, user-agent, repository identifier, query, fragment, or caller header input.

## Connection and SSRF policy

Each connection performs fresh A and AAAA resolution through an abortable capability. Every returned
record must be a valid numeric address and globally routable; IPv4 additionally requires canonical
dotted-decimal notation, and one unsafe answer rejects the entire result. The client rejects
loopback, private, shared, link-local, unspecified, documentation, benchmarking,
protocol-assignment, multicast, reserved, IPv4-mapped IPv6, IPv4 alternate notation, and IPv6 zone
identifiers. IPv6 is conservative: only global `2000::/3` space is eligible, with IANA
special-purpose ranges removed.

The selected address is copied, revalidated immediately before every transport connection, and is
the only address returned by the HTTPS request's private lookup callback. TLS still uses the fixed
registry hostname for SNI, `Host`, CA-chain validation, and hostname verification. TLS 1.2 is the
minimum. A new agent-less connection is used for each request, avoiding connection reuse across a
DNS decision. Redirects are rejected, including same-host redirects; there is no redirect policy for
repository-controlled input to influence.

## Bounds and failure behavior

DNS, TCP connect, TLS, response headers, body idle time, and the overall request have independent
deadlines. Cancellation requires a native `AbortSignal`. Every failure and cancellation aborts the
active capability and waits for confirmed cleanup under a separate bounded cleanup deadline.
Nonsettling DNS, transport, and body iterators cannot retain a concurrency permit indefinitely.
There are at most four registry requests process-wide.

Responses require a 2xx status, one exact `Content-Length`, JSON content type, identity/no content
encoding, no transfer encoding, no duplicate header, no malformed control characters, at most 64
headers and 16 KiB of header bytes. Metadata is capped at 512 KiB and packs at 4 MiB. The body must
end at exactly its declared length; truncation and extra bytes fail closed. A maximum of 1,024
chunks prevents zero-byte/chunk floods. Redirect locations, remote bodies, certificate details, DNS
errors, and cancellation reasons are never reflected into issues.

A 404 remains a rejected response but is classified as the sanitized `not-found` issue. H08 uses
only that fixed classification to terminate sequential root-version discovery; every other non-2xx
response aborts the check.

A successful result contains a fresh `Uint8Array` and frozen sanitized provenance: contract version,
fixed origin/path/method/media type, exact length, and address family only. H07 does not parse,
authenticate, cache, or activate those bytes. H08 owns TUF freshness and replay verification; H09
owns activation. Callers must never infer trust from transport success.

## Test and deployment boundary

H07 tests use only injected fake DNS and TLS capabilities. The synthetic
`https://registry.example.invalid` origin cannot resolve by definition and is never used by the
production factory. Tests cover public IPv4/IPv6, IANA special ranges, mixed-answer rebinding,
redirects, malformed headers, compression, truncation/growth, bounds, phase timeout, slow body,
cancellation, TLS failure, cleanup failure, proxy variables, credential absence, and concurrency. No
test contacts a live registry or external repository.

## Sources and compatibility record

The following sources were reviewed on 2026-08-02 for the supported Node.js 24.18.1 runtime:

- [Node.js DNS](https://nodejs.org/docs/latest-v24.x/api/dns.html): independent resolver instances,
  explicit A/AAAA resolution, timeout/tries, and cancellation.
- [Node.js HTTP](https://nodejs.org/download/release/latest-v24.x/docs/api/http.html): custom
  lookup, `AbortSignal`, `maxHeaderSize`, strict parser defaults, request lifecycle, and headers.
- [Node.js HTTPS](https://nodejs.org/docs/latest-v24.x/api/https.html) and
  [TLS](https://nodejs.org/docs/latest-v24.x/api/tls.html): HTTPS options, SNI, CA/hostname
  verification, and minimum TLS version.
- [OWASP SSRF Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html):
  protocol/domain allowlists, validation of all DNS answers, DNS-pinning risk, local/private
  exclusion, and disabled redirects.
- [IANA IPv4 Special-Purpose Address Registry](https://www.iana.org/assignments/iana-ipv4-special-registry/iana-ipv4-special-registry.xhtml)
  and
  [IANA IPv6 Special-Purpose Address Registry](https://www.iana.org/assignments/iana-ipv6-special-registry/iana-ipv6-special-registry.xhtml):
  special-purpose prefix inventory.

Observed implementation detail: Node's native HTTPS client does not consume `HTTP_PROXY` or
`HTTPS_PROXY` automatically, but the contract does not rely on ambient behavior—the client passes a
numeric address through its own lookup and never reads proxy environment variables. The compiled
production allowlist is intentionally empty pending release infrastructure and review.
