# Release checks for generated documentation

Before packaging a public release such as `1.0.0`:

1. run `pnpm release:dry-run` and review the package versions and generated changelogs;
2. run `pnpm docs:artifacts:check` from a clean checkout;
3. run the documentation unit tests and syntax checks for every locally available supported shell;
4. render the manual page with a standards-conforming `man`, `mandoc`, or `groff` implementation;
5. run `pnpm pack:check` and confirm every public tarball contains byte-exact `LICENSE` and
   `NOTICE`; confirm the CLI separately contains `THIRD_PARTY_NOTICES`, `completions/`, `man/`,
   `reference/`, and `schemas/`;
6. confirm the pack gate executed every tagged generated documentation example;
7. compare the packaged machine reference's CLI version with the tarball manifest;
8. verify the embedded configuration-schema digest against the packaged core schema used for the
   same release.

Never repair a stale artifact directly. Change its authoritative registry or contract and rerun the
explicit writer. Release archives preserve generated artifacts and their schema beside other G7
evidence.

The complete Changesets lifecycle, review boundary, and rollback policy is in
[releasing.md](releasing.md).
