import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { verifyBaseDescriptors, verifyInputDirectory } from "./runtime-inputs.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const lock = JSON.parse(await readFile(path.join(directory, "build-lock.v1.json"), "utf8"));
await verifyBaseDescriptors(directory, lock.baseImage);
if (process.argv[2] === "--build-inputs") {
  if (process.argv.length !== 4 || !path.isAbsolute(process.argv[3]))
    throw new Error("invalid H13 build input path");
  await verifyInputDirectory(
    process.argv[3],
    lock.buildInputs.manifestSha256,
    await readFile(path.join(directory, "pnpm-lock.yaml")),
    lock.packageManager,
  );
} else if (process.argv.length !== 2)
  throw new Error("usage: verify-runtime-provenance.mjs [--build-inputs <absolute-path>]");
process.stdout.write("H13 runtime provenance verified.\n");
