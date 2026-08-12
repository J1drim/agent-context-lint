# Optional exact tokenizer packages

Packages in this directory are deliberately outside the pnpm workspace. They are separately
packable data artifacts and are never installed by the default Agent Context Linter dependency
graph. A user must explicitly install a supported package before selecting its provider ID.

The host never imports provider JavaScript. Each reviewed package contains a closed JSON manifest
and a base64-encoded WebAssembly module whose decoded SHA-256 digest is pinned in the engine-owned
registry. The worker ABI exposes only bounded linear memory and cannot access Node.js, files,
processes, environment variables, credentials, clocks, or sockets.

`utf8-byte` is the reference package and conformance oracle. It implements the exact, deliberately
model-independent tokenizer in which every UTF-8 byte is one token. Model-specific packages can use
the same ABI only after their generated vocabulary and merge-table provenance are reviewed and the
engine registry pins their artifact digest.
