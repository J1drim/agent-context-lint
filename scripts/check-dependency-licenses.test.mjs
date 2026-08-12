import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  auditInstalledDependencyLicenses,
  collectInstalledDependencyLicenses,
  defaultPolicyPath,
  defaultVirtualStorePath,
  licenseExpressionIsAllowed,
  validateLicensePolicy,
} from "./check-dependency-licenses.mjs";

const policy = {
  schemaVersion: 1,
  allowedLicenses: ["Apache-2.0", "MIT"],
  allowedExceptions: [],
  reviewedMetadataOverrides: [],
};

async function withDirectory(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-context-license-test-"));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function addPackage(store, slot, name, version, license, licenseText) {
  const parts = name.startsWith("@") ? name.split("/") : [name];
  const packageDirectory = path.join(store, slot, "node_modules", ...parts);
  await mkdir(packageDirectory, { recursive: true });
  const manifest = { name, version };
  if (license !== undefined) {
    manifest.license = license;
  }
  await writeFile(path.join(packageDirectory, "package.json"), JSON.stringify(manifest));
  if (licenseText !== undefined)
    await writeFile(path.join(packageDirectory, "LICENSE"), licenseText);
}

test("committed policy and installed dependency graph pass", async () => {
  const result = await auditInstalledDependencyLicenses({
    policyPath: defaultPolicyPath,
    virtualStorePath: defaultVirtualStorePath,
  });
  assert.ok(result.dependencies.length >= 100);
});

test("policy rejects unknown fields, unsorted values, and invalid identifiers", () => {
  assert.throws(
    () => validateLicensePolicy({ ...policy, allowedLicenses: ["MIT", "Apache-2.0"] }),
    /must be sorted/u,
  );
  assert.throws(
    () => validateLicensePolicy({ ...policy, allowedLicenses: ["not-a-license"] }),
    /not a valid SPDX/u,
  );
  assert.throws(() => validateLicensePolicy({ ...policy, bypass: true }), /unsupported policy/u);
});

test("AND requires every license while OR requires one permitted choice", () => {
  assert.equal(licenseExpressionIsAllowed("MIT AND Apache-2.0", policy), true);
  assert.equal(licenseExpressionIsAllowed("MIT AND GPL-3.0-only", policy), false);
  assert.equal(licenseExpressionIsAllowed("MIT OR GPL-3.0-only", policy), true);
  assert.equal(licenseExpressionIsAllowed("GPL-2.0-only OR GPL-3.0-only", policy), false);
});

test("SPDX exceptions require an explicit exception allowlist", () => {
  assert.equal(licenseExpressionIsAllowed("MIT WITH LLVM-exception", policy), false);
  assert.equal(
    licenseExpressionIsAllowed("MIT WITH LLVM-exception", {
      ...policy,
      allowedExceptions: ["LLVM-exception"],
    }),
    true,
  );
});

test("missing, legacy, and malformed license metadata fail closed", () => {
  assert.equal(licenseExpressionIsAllowed(null, policy), false);
  assert.equal(licenseExpressionIsAllowed("SEE LICENSE IN LICENSE", policy), false);
  assert.equal(licenseExpressionIsAllowed("MIT AND", policy), false);
});

test("an exact reviewed license-file digest can correct legacy manifest metadata", async () => {
  await withDirectory(async (directory) => {
    const store = path.join(directory, "store");
    const policyPath = path.join(directory, "policy.json");
    await addPackage(store, "one", "legacy", "1.0.0", "SEE LICENSE IN LICENSE", "MIT text\n");
    const { createHash } = await import("node:crypto");
    const digest = createHash("sha256").update("MIT text\n").digest("hex");
    const overridePolicy = {
      ...policy,
      reviewedMetadataOverrides: [
        {
          id: "legacy@1.0.0",
          declaredLicense: "SEE LICENSE IN LICENSE",
          effectiveLicense: "MIT",
          licenseFile: "LICENSE",
          licenseSha256: digest,
        },
      ],
    };
    await writeFile(policyPath, JSON.stringify(overridePolicy));
    await assert.doesNotReject(
      auditInstalledDependencyLicenses({ policyPath, virtualStorePath: store }),
    );
    overridePolicy.reviewedMetadataOverrides[0].licenseSha256 = "0".repeat(64);
    await writeFile(policyPath, JSON.stringify(overridePolicy));
    await assert.rejects(
      auditInstalledDependencyLicenses({ policyPath, virtualStorePath: store }),
      /reviewed file digest mismatch/u,
    );
  });
});

test("virtual-store scan handles scoped packages and returns stable order", async () => {
  await withDirectory(async (store) => {
    await addPackage(store, "z-slot", "zeta", "1.0.0", "MIT");
    await addPackage(store, "a-slot", "@scope/alpha", "2.0.0", "Apache-2.0");
    const packages = await collectInstalledDependencyLicenses(store);
    assert.deepEqual(
      packages.map(({ id, license }) => ({ id, license })),
      [
        { id: "@scope/alpha@2.0.0", license: "Apache-2.0" },
        { id: "zeta@1.0.0", license: "MIT" },
      ],
    );
  });
});

test("audit names every rejected or missing dependency", async () => {
  await withDirectory(async (directory) => {
    const store = path.join(directory, "store");
    const policyPath = path.join(directory, "policy.json");
    await addPackage(store, "one", "copyleft", "1.0.0", "GPL-3.0-only");
    await addPackage(store, "two", "unknown", "2.0.0", undefined);
    await writeFile(policyPath, JSON.stringify(policy));
    await assert.rejects(
      auditInstalledDependencyLicenses({ policyPath, virtualStorePath: store }),
      (error) => {
        assert.match(error.message, /copyleft@1\.0\.0: GPL-3\.0-only/u);
        assert.match(error.message, /unknown@2\.0\.0: missing/u);
        return true;
      },
    );
  });
});

test("conflicting metadata for one dependency identity is rejected", async () => {
  await withDirectory(async (store) => {
    await addPackage(store, "one", "same", "1.0.0", "MIT");
    await addPackage(store, "two", "same", "1.0.0", "Apache-2.0");
    await assert.rejects(
      collectInstalledDependencyLicenses(store),
      /Conflicting license metadata/u,
    );
  });
});

test("a missing or empty virtual store fails with an actionable error", async () => {
  await withDirectory(async (directory) => {
    await assert.rejects(
      collectInstalledDependencyLicenses(path.join(directory, "missing")),
      /virtual store is missing/u,
    );
    await assert.rejects(
      collectInstalledDependencyLicenses(directory),
      /No installed dependencies/u,
    );
  });
});
