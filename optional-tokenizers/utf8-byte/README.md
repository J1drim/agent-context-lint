# `@agent-context/tokenizer-utf8-byte`

This optional data-only package implements `utf8.byte@1.0.0`: each byte in the UTF-8 encoding of the
input is exactly one token. It is a conformance/reference tokenizer, not a model tokenizer.

Install it explicitly alongside Agent Context Linter, then select provider
`optional:utf8-byte`. If it is absent, corrupt, incompatible, slow, or fails validation, the host
returns the labeled built-in estimate with explicit fallback provenance.

The package contains no JavaScript and executes no install script. Its WebAssembly artifact imports
only `env.memory` and exports only `count(offset, byteLength) -> tokenCount`.
