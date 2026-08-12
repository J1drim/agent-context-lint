# Effective-context cache security

The E09 cache is a pure, bounded, process-local optimization inside TB-03. Repository content,
configuration, profile outputs, import DAGs, paths, identities, and E08 proofs are untrusted data even
when the surrounding operation is authorized.

## Threats and controls

| Threat | Control |
|---|---|
| Stale result after configuration/profile/spec/file/target change | Complete independently hashed key components plus exact final address |
| Same-byte file replacement or identity race | Configuration, target, and document `{device,inode}` identities participate separately from content |
| Omitted or surplus dependency hides a change | Cold E05 result and E04 DAGs derive an exact path closure; publication requires equality |
| Unknown state collapses to a hit on known state | Complete issued profile, DAG, and target-sampling records are hashed including uncertainty |
| Caller supplies a fake digest | Cache computes every digest from validated records and copied bytes |
| Forged serialized profile/DAG/sampling result | Same-process issuance checks for D03/D05/D08/D10/D13, E04, E05, and E08 |
| Accessor/proxy/prototype/sparse/cyclic input executes or amplifies work | Descriptor-only closed snapshots, intrinsic byte copying, canonical graph limits, fixed errors |
| Collision or ambiguous concatenation | SHA-256 with typed, byte-length-framed canonical components and final composition digest |
| Memory exhaustion | File/byte/node/text/path/identity/entry/weight hard ceilings and deterministic FIFO eviction |
| Cancellation publishes partial state | Native signal checked before work, after hashing, after cold E05, and before publication |
| Cache creates an ambient capability | No filesystem, network, process, environment, model, clock, callback, or write input exists |
| Persistent cache is mistaken for issued authority | E09 is memory-only; serialization/persistence is explicitly outside this contract |

Cache key metadata exposes only identities, versions, target path, and hashes. It does not expose
document content. Error messages are fixed and do not reflect hostile path, identity, or source text.

The cache does not make E05 more certain. Cached partial results stay partial. It does not grant a
missing file authority, execute content, resolve an unknown client choice, or assume that content
equality implies behavioral equivalence.
