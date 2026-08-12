# Reference and import rule security

ACL150–ACL156 analyze inert data only. The evaluator cannot read a path, follow a link, resolve DNS,
open a socket, execute a repository command, inspect environment variables, invoke a model, or apply
a fix. Repository content and graph/profile/path containers are treated as hostile.

Inputs are closed plain data records and dense intrinsic arrays. Proxies, accessors, extended or
sparse arrays, unknown fields, invalid profile tuples, inconsistent B03/C10 identities, invalid
ranges, duplicate targets, unsorted paths, and values outside hard limits fail before evaluation.
C10 graphs are revalidated through the bounded E04 contract and must point to byte-identical B03
documents. Diagnostic messages never echo raw specifiers; fingerprints contain a SHA-256 digest.

The evaluator distinguishes safety containment from client behavior. ACL152 reports the linter's
repository boundary without claiming how a client handles an external source. Absolute paths are
reported for portability, while uncertain approval, remote loading, reference bases, case rules,
and hosted/model-selected behavior remain explicit uncertainty. No finding authorizes reading the
target or broadens the selected repository root.
