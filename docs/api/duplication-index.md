# Exact and bounded near-duplication index

Ticket F04 exports `buildDuplicationIndex` from the internal `@agent-context/evidence` package. It
consumes sorted, source-backed F03 normalized statements and returns deterministic exact and bounded
near-duplicate clusters. It performs no repository reads, network access, model calls, embeddings,
locale lookup, command execution, or dynamic evaluation.

```ts
const index = buildDuplicationIndex(
  classifiedStatements
    .map(({ statement, normalizedText }) => ({
      documentId: statement.documentId,
      nodeIds: statement.nodeIds,
      normalizedText,
      range: statement.range,
      statementId: statement.id,
    }))
    .sort((left, right) => (left.statementId < right.statementId ? -1 : 1)),
);
```

The immutable `0.1.0` result contains exact clusters, near clusters, explicit short/empty
exclusions, the fixed similarity contract, effective limits, and work metrics. Every cluster member
retains its B03 statement/document/node/source-range evidence pointer. Stable cluster IDs are
SHA-256-derived from the sorted member statement IDs. Exact clusters also expose the normalized-text
SHA-256 digest, not a second copy of the statement.

## Exact duplicates

Exact identity means JavaScript string equality over canonical F03 `normalizedText`. Empty text is
not an exact cluster. All identical entries are grouped before near matching; the unique text is
shingled once, which bounds repeated-policy workloads. Exact duplicates remain a separate cluster
even when their unique representative also joins a near cluster.

The input validator requires well-formed NFC, lowercase F03 text with single ASCII spaces and no
line breaks or leading/trailing whitespace. This prevents callers from bypassing F03 normalization
by presenting alternate Unicode or whitespace encodings as distinct statements.

## Near-duplicate similarity

The fixed algorithm ID is `unicode-code-point-trigram-jaccard-v1`:

1. Add start/end sentinels and form a set of consecutive three-Unicode-code-point shingles.
2. Count each shingle's support over unique texts eligible for near matching.
3. For each text, select at most 16 globally rarest shingles whose posting list is between 2 and
   1,024 entries under default limits.
4. Compare only earlier unique texts that selected a shared anchor.
5. Compute exact set Jaccard similarity: `intersection / union`.
6. Retain an edge when `floor(intersection * 10_000 / union)` is at least 8,000 basis points.
7. Form deterministic connected components from retained edges, then expand exact members.

Every edge records representative statement IDs, intersection/union counts, and the integer score.
Integer basis points avoid platform-dependent threshold rounding. A connected cluster is transitive:
every member is connected by qualifying evidence, but every possible member pair need not meet the
threshold. Consumers must use recorded edges when explaining a cluster.

Candidate generation is intentionally bounded and can produce false negatives. Texts that share only
very common shingles, have no mutually selected rare anchor, or exhaust a configured bound are not
silently compared with every other text. Resource exhaustion throws; it never converts an incomplete
search into a complete result.

## Multilingual behavior

Shingles use ECMAScript Unicode code points, not whitespace-delimited words, so text in Chinese,
Japanese, Arabic, Cyrillic, emoji-bearing prose, and other scripts follows the same deterministic
procedure. The index does not stem, transliterate, translate, strip diacritics, segment grapheme
clusters, or assert semantic equivalence. F03 NFC normalization occurs first. Short texts are more
sensitive to a single changed code point and, by default, texts below 12 code points are excluded
from near matching while remaining eligible for exact matching.

## Resource and input safety

| Resource                                  |    Default | Hard maximum |
| ----------------------------------------- | ---------: | -----------: |
| Entries                                   |    100,000 |    1,000,000 |
| Node IDs per entry                        |      4,096 |       65,536 |
| UTF-16 units per normalized text          |     65,536 |    1,048,576 |
| Aggregate normalized UTF-16 units         | 67,108,864 |  536,870,912 |
| Unique shingles per text                  |      4,096 |       65,536 |
| Aggregate unique-text shingle occurrences |  2,000,000 |   20,000,000 |
| Candidate comparisons                     |  2,000,000 |   20,000,000 |
| Anchor shingles per text                  |         16 |          128 |
| Posting-list support                      |      1,024 |       65,536 |
| Expanded cluster members                  |    100,000 |    1,000,000 |

Entries must be a closed, dense, non-proxy array sorted by unique statement ID. Entry, range,
position, and option objects must be closed plain records with own data properties. Node arrays are
dense, sorted, unique, bounded, and contain no extra keys. Proxies, accessors, symbols, sparse
arrays, unknown fields, invalid IDs, reversed ranges, malformed Unicode, noncanonical normalized
text, and invalid limits fail closed with `DuplicationIndexError`.

The scale suite demonstrates 20,000 identical statements collapsing to one unique shingle record and
zero candidate comparisons. Separate tests force every resource limit, high-support-anchor cutoff,
exact threshold boundary, transitive clustering, and multilingual behavior.
