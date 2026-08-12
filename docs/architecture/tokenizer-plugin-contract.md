# Tokenizer provider contract

Status: accepted implementation contract for G01

Contract version: `1.0.0`

## Purpose

Context-efficiency results must say whether a token count is exact for a named tokenizer or a
documented estimate. They must never compare counts produced by different algorithms under one
unqualified trend or score.

The public boundary is therefore data-only. A caller selects a bounded provider identifier; the
engine resolves it through a closed, release-owned registry and returns immutable metadata:

```ts
interface ResolvedTokenizerProvider {
  readonly contractVersion: "1.0.0";
  readonly providerId: string;
  readonly execution: "builtin" | "isolated";
  readonly identity: {
    readonly id: string;
    readonly measurement: "exact" | "estimate";
    readonly version: string;
  };
}
```

No public object accepts a callback, module path, command, environment, or other executable field.
Repository content, configuration, organization packs, and ordinary callers cannot register a
provider or self-assert an exact identity. G01 initially registers only the built-in deterministic
estimate reserved for G02. Unknown identifiers fail closed.

G10 adds release-owned exact providers only through changes to the static registry in reviewed
product code. Exact implementations run through the
[G10 data-only WebAssembly boundary](exact-tokenizer-providers.md) and pass its conformance fixtures;
a manifest returned by a package is negotiation data, not authority. Missing optional providers
degrade explicitly to the labeled built-in estimate.

## Identity and comparison

The identity triple is semantic:

- `id` identifies the complete algorithm or encoding, not a marketing model alias.
- `version` identifies every vocabulary, merge table, normalizer, pre-tokenizer, special-token
  policy, and implementation change that can alter a count. Calendar versions and SemVer are both
  allowed as bounded opaque identities.
- `measurement` is `exact` only for a release-owned provider proven to implement the selected
  tokenizer exactly; deterministic approximations use `estimate`.

Two results are comparable only when all three fields are byte-for-byte equal. The compatibility
API returns a stable reason for measurement, algorithm, version, or malformed-identity mismatch;
it never silently converts an exact count to an estimate. The comparison key is length-prefixed so
delimiter-containing identifiers cannot collide.

This explicit encoding identity follows the practical distinction in
[tiktoken's encoding API](https://github.com/openai/tiktoken#readme), which selects named encodings
and requires a different name when special-token behavior changes. A tokenizer version must cover
the full pipeline because normalizers, pre-tokenizers, models, and post-processors can all affect
the output, as documented by the
[Hugging Face Tokenizers component model](https://huggingface.co/docs/tokenizers/main/components).

## Text and count semantics

- Input is the exact JavaScript string supplied by the caller. Implementations perform no implicit
  Unicode normalization, case conversion, trimming, Markdown rewriting, or newline conversion.
- Counts are non-negative safe integers. Fractional, negative, infinite, asynchronous, or otherwise
  malformed isolated-provider results fail closed at the G10 protocol boundary.
- Input is capped at 16 MiB of UTF-8. Results record UTF-16 code units and UTF-8 bytes so later
  accounting can explain the measured boundary.
- Returned identities, measurements, issues, and wrappers are immutable snapshots.

## Trust boundary

Identity syntax validation proves only that serialized data is well formed. It does not authorize a
provider or prove an `exact` claim. Only `resolveTokenizerProvider` can select a runtime provider,
and it consults the engine-owned static registry. The API never invokes caller-supplied JavaScript.

The serialized identity has a matching published JSON Schema at
`@agent-context/efficiency/schemas/tokenizer-identity.v1.schema.json`. Runtime validation rejects
proxies, accessors, inherited members, symbols, unknown fields, malformed identifiers, and oversized
identities without coercion.

Compatibility failures are expected data:

| Difference | Result code |
|---|---|
| exact versus estimate | `incompatible-measurement` |
| algorithm/encoding id | `incompatible-id` |
| tokenizer version | `incompatible-version` |
| malformed left or right identity | `invalid-identity` with side-specific path |

G02 implements the [built-in deterministic estimate](estimate-tokenizer.md). G10 owns
[optional exact execution](exact-tokenizer-providers.md), isolation, timeouts, result validation,
and fallback; none of those capabilities are implied by this data-only G01 contract.
