import { copyFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const allowedDirectories = new Set([
  path.join(rootDirectory, "packages/core"),
  path.join(rootDirectory, "packages/standards"),
]);

export async function preparePackageLicense(packageDirectory, { clean = false } = {}) {
  const resolved = path.resolve(packageDirectory);
  if (!allowedDirectories.has(resolved)) throw new Error("unapproved package license destination");
  for (const name of ["LICENSE", "NOTICE"]) {
    const target = path.join(resolved, name);
    if (clean) {
      const [sourceBytes, targetBytes] = await Promise.all([
        readFile(path.join(rootDirectory, name)),
        readFile(target).catch(() => undefined),
      ]);
      if (targetBytes !== undefined && !sourceBytes.equals(targetBytes)) {
        throw new Error(`refusing to remove non-canonical ${name}`);
      }
      await rm(target, { force: true });
    } else {
      await copyFile(path.join(rootDirectory, name), target);
    }
  }
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const packageDirectory = process.argv[2];
  if (packageDirectory === undefined) throw new Error("package directory is required");
  await preparePackageLicense(packageDirectory, { clean: process.argv[3] === "--clean" });
}
