# Developing ACL400–ACL406

Security rules are conservative data classifiers, not exploit detectors. Changes must preserve the
closed F11 input, inert F02 command lexer, B03/C10 import evidence, B04 diagnostic contract, B08
suppression ownership, and B05 output redaction boundary.

## Required change evidence

Every rule change needs:

1. a positive example whose evidence is mechanically sufficient;
2. hard negatives including prohibition/safety wording and near-boundary token shapes;
3. exact length, digest, URL-revision, command-state, and resource boundaries;
4. malformed, proxy, accessor, sparse-array, duplicate, and excessive input cases;
5. exact `disable-next-line` suppression through the real B08 parser/matcher;
6. stylish, JSON, and SARIF rendering with no raw corpus token;
7. a process/network canary proving evaluation remains inert;
8. repeated-result, immutability, and deterministic ordering assertions; and
9. focused coverage of at least 95% statements and 90% branches.

The committed corpus contains only synthetic provider-shaped canaries. Record recall as the number
of expected ACL400 findings divided by supported corpus cases; v1 requires 100% for those supported
shapes. Hard negatives are equally release-blocking. Never add generic entropy heuristics merely to
increase recall, and never copy a real leaked credential into a fixture, snapshot, issue, or commit.

## Adding a credential pattern

Document the issuer/version and why the syntax is distinctive. Prefer a current official provider or
maintainer reference. Add exact positive and one-character-short cases, a placeholder/documentation
negative, zero-raw-output assertions over the evaluator and all formatters, and a note explaining
why the pattern remains within the high-confidence v1 scope. Provider format drift requires review;
it is not silently widened at runtime.

## Command and import evidence

Only explicit dialect mappings may enter F02. Do not parse prose with shell regular expressions or
execute a command to discover its behavior. Dynamic, malformed, and unresolved `auto` results remain
uncertain. Integrity evidence must bind a digest or signature identity; a release name, branch,
version string, TLS URL, or checksum downloaded from the same mutable instruction is insufficient.

Remote imports are inspected only through existing B03 C10 reference records. F11 never fetches or
resolves the URL. Extend immutable-host recognition only with exact host/path/revision tests and an
explicit security review.

Run the focused suite and coverage before the serialized repository gate:

```sh
pnpm build
pnpm exec vitest run packages/rules/test/security.unit.test.ts tests/security-rules.integration.test.ts
pnpm exec vitest run packages/rules/test/security.unit.test.ts tests/security-rules.integration.test.ts --coverage
```
