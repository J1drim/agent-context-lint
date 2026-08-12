# Deterministic estimate tokenizer

Status: accepted implementation contract for G02

Algorithm identity: `agent-context-estimate@1.0.0` (`estimate`)

## Formula

The default tokenizer is deliberately approximate:

```text
estimated tokens = ceil(UTF-8 byte length / 4)
```

The empty string counts as zero. Every other input rounds up. The implementation measures the exact
JavaScript string it receives; it does not normalize Unicode, line endings, whitespace, Markdown,
or code. A lone UTF-16 surrogate follows Node's UTF-8 replacement behavior and occupies three
bytes. Inputs over 16 MiB of UTF-8 fail closed before a result is produced.

This baseline follows tiktoken's documented observation that a BPE token corresponds to roughly
four bytes on average, while intentionally avoiding any claim that it predicts a particular model
or language precisely. OpenAI's tokenizer documentation gives a similar four-character rule of
thumb for common English text. These are heuristics, not compatibility guarantees:

- [tiktoken: What is BPE?](https://github.com/openai/tiktoken#what-is-bpe-anyway)
- [OpenAI tokenizer overview](https://platform.openai.com/tokenizer)
- [Node.js `Buffer.byteLength`](https://nodejs.org/api/buffer.html#static-method-bufferbytelengthstring-encoding)

## Determinism and versioning

The computation uses only Node's UTF-8 byte length and integer arithmetic. It has no locale, ICU,
segmentation, regular-expression, model alias, network, clock, filesystem, or platform dependency.
The committed Unicode and Markdown fixture corpus must produce identical output on every supported
Node/OS CI lane.

Any change to the denominator, rounding, UTF-8 treatment, input ceiling, or preprocessing requires a
new identity version. Results from different versions fail G01 comparison rather than being silently
mixed. The formatter must always retain the `estimate` measurement label.

## Hand-worked examples

| Input | UTF-16 code units | UTF-8 bytes | Estimate |
|---|---:|---:|---:|
| `test` | 4 | 4 | 1 |
| `tests` | 5 | 5 | 2 |
| `e` + combining acute | 2 | 3 | 1 |
| `😀` | 2 | 4 | 1 |
| `漢字` | 2 | 6 | 2 |
| `# Plan\n\n- Test code.\n` | 21 | 21 | 6 |
| `## Café 😀\n\n- 漢字\n` | 17 | 24 | 6 |

The JSON fixture stores these inputs and expected measurements directly. It also proves that LF and
CRLF are distinct data. G10 exact providers may differ substantially; consumers must use the G01
identity compatibility check before comparing results.
