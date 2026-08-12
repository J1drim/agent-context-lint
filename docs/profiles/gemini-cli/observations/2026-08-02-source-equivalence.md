# Gemini CLI source-equivalence observation — 2026-08-02

Purpose: recheck the D09 source/package pins and prove that the reviewed Gemini context behavior
files did not drift between the stable release and current upstream snapshot. This is a
deterministic metadata/source observation, not a Gemini behavioral session.

## Inputs and method

- Official repository: `google-gemini/gemini-cli`.
- Stable ref: `v0.53.1` → `19a68016bdc9cd4177a155846dd51f282c3c1c59`.
- Current `main`: `f47d6c6f7a1308d81f9f57acf7d279f0928c5249`.
- Registry client: `pnpm 11.18.0`, `pnpm view` against the official npm registry.
- Source method: HTTPS GET of each raw file at both immutable revisions, byte-for-byte comparison in
  memory, and SHA-256 over the response bytes.

`git ls-remote` resolved both refs. Registry metadata reported stable `0.53.1`, preview
`0.54.0-preview.1`, nightly `0.55.0-nightly.20260802.gf47d6c6f7`, and stable integrity
`sha512-xBGdD/tl05gsTpD2oV1Bq0NCb4BBeTnjSbKxHtwOB7nt1QMaqWYJ9WsOEsQQhQ2P1v0UJth1F17SAXvdZ5mASw==`.

No source file was executed or persisted. No repository under test was read or modified. No
credential, Gemini home, prompt, model endpoint, interactive session, or paid quota was used.

## Byte-equivalent files

Every row matched exactly at the stable and current revisions. The digest is the SHA-256 of either
identical byte sequence.

| Repository path                                      | SHA-256                                                            |
| ---------------------------------------------------- | ------------------------------------------------------------------ |
| `docs/cli/gemini-md.md`                              | `d00eeaef22453de4756a9862d8467750f772e239c4ee9b6f755709429b47c2cf` |
| `docs/reference/configuration.md`                    | `e96c6ebd5870b733c65e0624bce50064e7c75456fdfc4d6bb702a76f26244d15` |
| `docs/reference/memport.md`                          | `eb2737b49776e97e5b967114c50150d42d7c45606c0fbccc24b9bc8d8ab6da11` |
| `docs/cli/gemini-ignore.md`                          | `21cf247e9066355a3ec1130097e3aaa6ec7065a95d1b52c623e7e46d975253cc` |
| `packages/core/src/utils/memoryDiscovery.ts`         | `f7c1123381d9326a7ce04ce54f3e0980140e791ba2fe5c2f22602a8f67ef23a5` |
| `packages/core/src/tools/memoryTool.ts`              | `af2a33a1b846ac491d159d17682083192aff31137973b7ed5fc9d999f4e645ef` |
| `packages/core/src/context/memoryContextManager.ts`  | `3c35df1ce05149179abc7f25e38449666cf37365544ffdd137da64103d4dd2c7` |
| `packages/core/src/tools/jit-context.ts`             | `28c2f714855350bf52e6d067b7e5c4e971a611b853406f43baf95b46f1c02493` |
| `packages/core/src/utils/memoryImportProcessor.ts`   | `27d10c72f71f22beff20c6886fcc75943f01ac5808920095488f3a6d5247f525` |
| `packages/cli/src/config/config.ts`                  | `5100bcd48f798d04b9463bd72680af7202f331de566321b1c29f5f8710c2c44c` |
| `packages/cli/src/config/settings.ts`                | `31b771bc8b7960f0cb6f9aa347378af6973a1054665caa0fabf7b3836940bba3` |
| `packages/cli/src/config/settingsSchema.ts`          | `df5e1939dd6313ffbe0e1e182af83efbf9e55bca99482e0223faf9b5bbe93e6d` |
| `packages/core/src/services/fileDiscoveryService.ts` | `86703523ed91f076eedb3e42f5be39dad599eb251b71ec65d4c8576a13d6486a` |
| `packages/core/src/utils/ignoreFileParser.ts`        | `6eef334ec294a673bc16a7e046b35c20bdb0af6287fc43b70e25377b42c4d26b` |
| `packages/core/src/commands/memory.ts`               | `bdb664ab7224e830fb85f3586cec4b1f4bbf7dc1ed454301deb087e738b7d729` |

## Supported conclusions and limits

This observation supports the package/ref provenance, the listed file digests, and the claim that
the D09-reviewed behavior source is unchanged across the two pins. It does not prove interactive
`/memory` output, authentication behavior, model-message placement, user-setting activation, or any
behavior not present in the reviewed files. Those remain documented, source-derived, conditional,
contradicted, unknown, or blocked exactly as classified in the compatibility record.
