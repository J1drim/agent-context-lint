import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import parseSpdxExpression from "spdx-expression-parse";

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const defaultPolicyPath = path.join(
  rootDirectory,
  "config",
  "allowed-dependency-licenses.json",
);
export const defaultVirtualStorePath = path.join(rootDirectory, "node_modules", ".pnpm");

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireSortedUniqueStrings(value, field, issues) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    issues.push(`${field} must be an array of strings`);
    return [];
  }
  const sorted = [...value].sort((left, right) => left.localeCompare(right, "en"));
  if (new Set(value).size !== value.length) {
    issues.push(`${field} must not contain duplicates`);
  }
  if (JSON.stringify(value) !== JSON.stringify(sorted)) {
    issues.push(`${field} must be sorted`);
  }
  return value;
}

export function validateLicensePolicy(policy) {
  const issues = [];
  if (!isRecord(policy)) {
    throw new Error("Dependency license policy must be an object");
  }
  const unknownKeys = Object.keys(policy).filter(
    (key) =>
      ![
        "allowedExceptions",
        "allowedLicenses",
        "reviewedMetadataOverrides",
        "schemaVersion",
      ].includes(key),
  );
  if (unknownKeys.length > 0) {
    issues.push(`unsupported policy keys: ${unknownKeys.join(", ")}`);
  }
  if (policy.schemaVersion !== 1) {
    issues.push("schemaVersion must be 1");
  }
  const licenses = requireSortedUniqueStrings(policy.allowedLicenses, "allowedLicenses", issues);
  requireSortedUniqueStrings(policy.allowedExceptions, "allowedExceptions", issues);
  if (!Array.isArray(policy.reviewedMetadataOverrides)) {
    issues.push("reviewedMetadataOverrides must be an array");
  } else {
    const ids = [];
    for (const [index, override] of policy.reviewedMetadataOverrides.entries()) {
      if (!isRecord(override)) {
        issues.push(`reviewedMetadataOverrides[${index}] must be an object`);
        continue;
      }
      const keys = Object.keys(override).sort();
      const expectedKeys = [
        "declaredLicense",
        "effectiveLicense",
        "id",
        "licenseFile",
        "licenseSha256",
      ];
      if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) {
        issues.push(`reviewedMetadataOverrides[${index}] has unsupported or missing fields`);
      }
      if (typeof override.id === "string") ids.push(override.id);
      if (
        typeof override.declaredLicense !== "string" ||
        typeof override.effectiveLicense !== "string" ||
        typeof override.licenseFile !== "string" ||
        !/^[a-f0-9]{64}$/u.test(override.licenseSha256 ?? "")
      ) {
        issues.push(`reviewedMetadataOverrides[${index}] has invalid values`);
      }
      if (override.licenseFile !== "LICENSE") {
        issues.push(`reviewedMetadataOverrides[${index}] must review LICENSE`);
      }
    }
    requireSortedUniqueStrings(ids, "reviewedMetadataOverrides ids", issues);
  }
  if (licenses.length === 0) {
    issues.push("allowedLicenses must not be empty");
  }
  for (const license of licenses) {
    try {
      const parsed = parseSpdxExpression(license);
      if (!("license" in parsed) || "left" in parsed || "exception" in parsed) {
        issues.push(`allowedLicenses entry ${license} must be one SPDX license identifier`);
      }
    } catch {
      issues.push(`allowedLicenses entry ${license} is not a valid SPDX identifier`);
    }
  }
  if (issues.length > 0) {
    throw new Error(`Dependency license policy violations:\n- ${issues.join("\n- ")}`);
  }
  return policy;
}

function expressionIsAllowed(node, allowedLicenses, allowedExceptions) {
  if ("license" in node) {
    return (
      allowedLicenses.has(node.license) &&
      (node.exception === undefined || allowedExceptions.has(node.exception))
    );
  }
  if (node.conjunction === "and") {
    return (
      expressionIsAllowed(node.left, allowedLicenses, allowedExceptions) &&
      expressionIsAllowed(node.right, allowedLicenses, allowedExceptions)
    );
  }
  if (node.conjunction === "or") {
    return (
      expressionIsAllowed(node.left, allowedLicenses, allowedExceptions) ||
      expressionIsAllowed(node.right, allowedLicenses, allowedExceptions)
    );
  }
  return false;
}

export function licenseExpressionIsAllowed(expression, policy) {
  validateLicensePolicy(policy);
  if (typeof expression !== "string" || expression.trim().length === 0) {
    return false;
  }
  try {
    return expressionIsAllowed(
      parseSpdxExpression(expression),
      new Set(policy.allowedLicenses),
      new Set(policy.allowedExceptions),
    );
  } catch {
    return false;
  }
}

async function readPackageManifest(manifestPath) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (
    !isRecord(manifest) ||
    typeof manifest.name !== "string" ||
    typeof manifest.version !== "string"
  ) {
    throw new Error(`Invalid dependency package manifest: ${manifestPath}`);
  }
  return {
    id: `${manifest.name}@${manifest.version}`,
    license: typeof manifest.license === "string" ? manifest.license : null,
    manifestPath,
    packageDirectory: path.dirname(manifestPath),
  };
}

async function packageManifestsInStoreEntry(storeEntryPath) {
  const modulesPath = path.join(storeEntryPath, "node_modules");
  let entries;
  try {
    entries = await readdir(modulesPath, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const paths = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === ".bin") {
      continue;
    }
    if (entry.name.startsWith("@")) {
      const scopePath = path.join(modulesPath, entry.name);
      const scopedEntries = await readdir(scopePath, { withFileTypes: true });
      for (const scopedEntry of scopedEntries) {
        if (scopedEntry.isDirectory()) {
          paths.push(path.join(scopePath, scopedEntry.name, "package.json"));
        }
      }
    } else {
      paths.push(path.join(modulesPath, entry.name, "package.json"));
    }
  }
  return paths;
}

export async function collectInstalledDependencyLicenses(virtualStorePath) {
  let storeEntries;
  try {
    storeEntries = await readdir(virtualStorePath, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`pnpm virtual store is missing: ${virtualStorePath}`, { cause: error });
    }
    throw error;
  }
  const manifests = [];
  for (const entry of storeEntries) {
    if (!entry.isDirectory()) {
      continue;
    }
    manifests.push(
      ...(await packageManifestsInStoreEntry(path.join(virtualStorePath, entry.name))),
    );
  }
  const packagesById = new Map();
  for (const manifestPath of manifests.sort((left, right) => left.localeCompare(right, "en"))) {
    const dependency = await readPackageManifest(manifestPath);
    const existing = packagesById.get(dependency.id);
    if (existing !== undefined && existing.license !== dependency.license) {
      throw new Error(`Conflicting license metadata for ${dependency.id}`);
    }
    packagesById.set(dependency.id, dependency);
  }
  if (packagesById.size === 0) {
    throw new Error(`No installed dependencies found in ${virtualStorePath}`);
  }
  return [...packagesById.values()].sort((left, right) => left.id.localeCompare(right.id, "en"));
}

export async function auditInstalledDependencyLicenses(options = {}) {
  const policyPath = options.policyPath ?? defaultPolicyPath;
  const virtualStorePath = options.virtualStorePath ?? defaultVirtualStorePath;
  const policy = validateLicensePolicy(JSON.parse(await readFile(policyPath, "utf8")));
  const dependencies = await collectInstalledDependencyLicenses(virtualStorePath);
  const overrides = new Map(
    policy.reviewedMetadataOverrides.map((override) => [override.id, override]),
  );
  const usedOverrides = new Set();
  const rejected = [];
  for (const dependency of dependencies) {
    if (licenseExpressionIsAllowed(dependency.license, policy)) continue;
    const override = overrides.get(dependency.id);
    if (
      override === undefined ||
      dependency.license !== override.declaredLicense ||
      !licenseExpressionIsAllowed(override.effectiveLicense, policy)
    ) {
      rejected.push(dependency);
      continue;
    }
    const licenseBytes = await readFile(
      path.join(dependency.packageDirectory, override.licenseFile),
    );
    const digest = createHash("sha256").update(licenseBytes).digest("hex");
    if (digest !== override.licenseSha256) {
      rejected.push({
        ...dependency,
        license: `${dependency.license} (reviewed file digest mismatch)`,
      });
      continue;
    }
    usedOverrides.add(dependency.id);
  }
  if (rejected.length > 0) {
    throw new Error(
      `Disallowed or unknown dependency licenses:\n${rejected
        .map((dependency) => `- ${dependency.id}: ${dependency.license ?? "missing"}`)
        .join("\n")}`,
    );
  }
  const staleOverrides = [...overrides.keys()].filter((id) => !usedOverrides.has(id));
  if (staleOverrides.length > 0) {
    throw new Error(
      `Unused dependency license metadata overrides:\n- ${staleOverrides.join("\n- ")}`,
    );
  }
  return { dependencies, policy };
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const result = await auditInstalledDependencyLicenses();
  console.log(
    `Validated ${result.dependencies.length} installed dependencies against ${result.policy.allowedLicenses.length} allowed SPDX licenses.`,
  );
}
