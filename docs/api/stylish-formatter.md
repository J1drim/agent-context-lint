# Stylish terminal formatter

Ticket I04 implements the terminal formatter in the private `@agent-context/formatters` workspace
package. It consumes the B04 diagnostic bundle plus the exact B03 source registry and produces the
B05 `TerminalOutput` model together with the exact stdout bytes. The package remains below the CLI
boundary and is not exported from the public `@agent-context/core` library.

## API

```ts
const result = formatStylishDiagnostics(diagnosticBundle, sources, {
  width: 80,
  color: "auto",
  terminalSupportsAnsi: process.stdout.isTTY === true,
  failureThreshold: "error",
});

if (!result.ok) {
  // Treat result.issues as an operational formatter failure.
} else {
  process.stdout.write(result.text);
  process.exitCode = result.output.summary.exitCode;
}
```

The formatter does not inspect `process`, environment variables, terminal state, the filesystem, or
the network. The CLI owns terminal capability detection and maps its future `--color` policy and
`NO_COLOR` handling to explicit options. Defaults are deliberately reproducible: width 80, no color,
and failure on active errors.

`color` has three values:

- `never` emits no ANSI regardless of terminal capability;
- `always` emits the formatter's fixed SGR palette regardless of capability; and
- `auto` emits that palette only when `terminalSupportsAnsi` is explicitly `true`.

Width is an integer from 20 through 1,000 columns. `terminal-cell-v1` is a frozen,
runtime-independent profile built from exact `unicode-segmenter@0.17.1` Unicode 17.0.0 UAX #29
Revision 47 tables and exact `get-east-asian-width@1.6.0` static tables. It preserves extended
grapheme clusters, including Indic conjuncts, combining sequences, keycaps, regional-indicator
pairs, emoji ZWJ sequences, and Hangul Jamo syllables. The tailored width rule counts emoji
presentation/qualified emoji and East Asian Wide/Fullwidth values as two cells, treats ambiguous
width as narrow, and hard-wraps an unbroken token only between extended clusters. It does not use
host ICU, so supported Node and operating-system versions produce the same wrapping bytes.

Terminal fonts and emulators can render ambiguous, private-use, or newly assigned characters
differently; this profile is a deterministic layout contract, not a universal claim about glyph
width. A Unicode table or tailoring change requires a new cell-profile version and reviewed golden
migration. Coordinates render as one-based `path:line:column` values while B03/B04 remain zero-based
internally.

One extended cluster is never split. If a standalone cluster is non-printing, wider than the
remaining line, or cannot fit within the B05 4,096-code-point/16,384-byte line envelope after the
trusted ANSI reserve, the formatter replaces that complete cluster with one inert visible `�` cell.
This deterministic degradation covers adversarial thousands-of-mark clusters and a double-width
cluster in a one-cell remainder without failing the whole report. Every emitted line is then checked
again by the B05 validator.

`measureStylishTextWidth` exposes that pinned profile to formatter tests and internal layout
consumers. It accepts already-sanitized, ANSI-free text; it is not a general terminal escape parser.

## Output and safety

Active diagnostics render in their validated B04 array order. The formatter deliberately does not
sort, deduplicate, or otherwise schedule diagnostics: F15 owns canonical scheduling, deduplication,
severity policy, suppression, and stable sorting before formatter invocation. Permuting a valid
input array therefore permutes its diagnostic blocks, while repeated formatting of the same ordered
input produces identical bytes. Each diagnostic includes its primary location, severity, rule ID,
message, up to 16 repository source-related locations, and an available suggestion. More related
locations receive an explicit omission count. Diagnostics matched by `suppressed` records are not
printed; the summary counts unique suppressed path fingerprints. The selected failure threshold
deterministically derives exit code 0 or 1.

All repository-controlled paths, labels, messages, and suggestions pass through the shared B05
inert-output boundary before layout or color is applied. It removes caller-provided ANSI SGR,
replaces C0/C1 and bidirectional controls, and redacts high-confidence credentials and test
canaries. Only fixed formatter-owned SGR sequences are added afterward. An empty active and
unsuppressed result renders zero bytes; every non-empty result ends in exactly one LF.

Input bundles are fully validated against their source documents before rendering. Options accept
only a closed, plain-data object: proxies, accessors, symbols, exotic prototypes, coercible values,
unknown fields, and out-of-range widths fail without invoking user code. Results and issue arrays
are frozen. Rendering is bounded by the B05 100,000-line ceiling; if diagnostics exceed the display
budget, the output remains finite and reports how many were omitted while summary counts continue to
describe the complete validated bundle.

The returned `text` is exactly `output.lines` joined with LF and is the terminal sink value because
its ANSI is formatter-owned, fixed, and closed by a reset on the same line. Passing the model to the
general B05 `serializeTerminalOutput` intentionally strips all SGR as untrusted input and therefore
produces the safe no-color projection. The constructed model is revalidated with the B05 terminal
validator before success.

## Unicode source record

Reviewed 2026-08-02:

- [Unicode UAX #29 Revision 47](https://www.unicode.org/reports/tr29/tr29-47.html) defines the
  Unicode 17.0.0 extended grapheme boundary rules;
- [`unicode-segmenter`](https://github.com/cometkim/unicode-segmenter) 0.17.1 embeds those tables,
  includes GB9c, and is tested upstream against the official Unicode suite;
- [Unicode UAX #11](https://www.unicode.org/reports/tr11/tr11-44.html) defines East Asian Width and
  cautions that terminal implementations require tailoring; and
- [`get-east-asian-width`](https://github.com/sindresorhus/get-east-asian-width) 1.6.0 provides the
  pinned static width lookup used with `ambiguousAsWide: false`.

Both runtime packages are MIT licensed, have no transitive runtime dependencies, and are exact in
the workspace lockfile. The registry integrity values are
`sha512-imwm2Aty0hfnY/3LqBWiyhuxxGso7qwhLXDp0BjOpmtYdjYgWJvT9JXthbu3MmEITwgjbYWaRJ0b2yRfgYnD5Q==`
and
`sha512-QRbvDIbx6YklUe6RxeTeleMR0yv3cYH6PsPZHcnVn7xv7zO1BHN8r0XETu8n6Ye3Q+ahtSarc3WgtNWmehIBfA==`,
respectively. Newer `unicode-segmenter` versions were not admitted because the repository's
minimum-release-age control selected the mature release.
