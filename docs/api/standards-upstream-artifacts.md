# Upstream standards snapshot artifacts

H10 defines two maintainer-review artifacts. They are not runtime configuration, a knowledge pack,
TUF metadata, or evidence that a production standards registry exists. Ordinary scans and every
packaged end-user command ignore them and remain offline.

## Source artifact v1

`upstream-source.v1.json` uses
[`upstream-source.v1.schema.json`](../../tools/standards/schemas/upstream-source.v1.schema.json). It
contains the exact bounded response bytes for each reviewed official document as canonical base64,
the response byte count and SHA-256, and only the configured normalized sections. Every section
records its stable identifier, exact heading and heading level, normalized UTF-8 text, and SHA-256.

The artifact identifies the canonical catalog digest and `heading-v1` extractor. The extractor:

- decodes UTF-8 fatally and rejects BOM and NUL;
- normalizes CRLF/CR to LF and Unicode to NFC;
- removes HTML scripts, styles, templates, SVG, comments, and tags before text normalization;
- trims trailing horizontal whitespace, collapses repeated blank lines, and adds one final LF;
- starts at one exact heading text and level and ends at the next heading of equal or higher rank;
- fails if a selector is absent, duplicated, empty, or over its byte bound.

Raw response bytes are retained so an offline reviewer can rerun the exact extractor. They are
untrusted documentation bytes and must never be executed, rendered as trusted HTML, interpreted as
maintainer instructions, or copied automatically into a knowledge pack.

## Provenance artifact v1

`upstream-provenance.v1.json` uses
[`upstream-provenance.v1.schema.json`](../../tools/standards/schemas/upstream-provenance.v1.schema.json).
It records the explicit retrieval date, exact URL, source identifier, method, sanitized media type,
status, raw byte count and hash, normalized section hashes, catalog hash, contract version, and the
SHA-256 of the complete canonical source artifact. It contains no cookies, response bodies, DNS
addresses, certificate details, environment values, authentication data, or remote error text.

Both files are canonical JSON with sorted object keys and one final LF. Numbers are safe integers.
The schemas are closed; unknown fields are rejected.

## Offline replay

Replay accepts the committed catalog and both artifact byte streams. It verifies canonical JSON,
closed versions and identities, exact catalog membership/order/URLs, base64 canonicality, raw byte
counts and hashes, retrieval dates, source-artifact binding, and every normalized section by
rerunning `heading-v1` from the retained raw bytes. It succeeds only when regenerated source and
provenance bytes equal both inputs byte for byte.

```sh
pnpm standards:snapshot:verify -- \
  --source artifacts/upstream-2026-08-02/upstream-source.v1.json \
  --provenance artifacts/upstream-2026-08-02/upstream-provenance.v1.json
```

Verification is offline and performs no DNS or HTTP. Success does not make any extracted statement
authoritative. H11's [semantic-review draft](standards-upstream-review.md) makes no automatic
semantic claim; human review and the separate threshold-protected standards publication process
remain mandatory.
