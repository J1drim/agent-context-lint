import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  generateReleaseArtifactBundle,
  verifyReleaseArtifactBundle,
} from "./release-artifacts.mjs";

const execFileAsync = promisify(execFile);

async function snapshot(directory, relative = "", result = new Map()) {
  for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
    const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
    if (entry.isDirectory()) await snapshot(directory, child, result);
    else result.set(child, await readFile(path.join(directory, child)));
  }
  return result;
}

async function fixture(t, { sbom = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-context-release-artifacts-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const input = path.join(root, "input");
  const output = path.join(root, "bundle");
  const notes = path.join(root, "notes.md");
  const rollback = path.join(root, "rollback.md");
  await mkdir(path.join(input, "packages"), { recursive: true });
  await writeFile(path.join(input, "packages/agent-context-lint-0.1.0.tgz"), "fixture tarball\n");
  await writeFile(path.join(input, "README.txt"), "Release payload fixture\n");
  await writeFile(notes, "# Agent Context Linter 0.1.0\n\n- Added: fixture.\n");
  await writeFile(rollback, "# Upgrade and rollback\n\nRestore the previous verified bundle.\n");
  let sbomPath;
  if (sbom) {
    sbomPath = path.join(root, "source-sbom.json");
    await writeFile(
      sbomPath,
      `${JSON.stringify(
        {
          SPDXID: "SPDXRef-DOCUMENT",
          creationInfo: {
            created: "2026-08-11T00:00:00Z",
            creators: ["Tool: fixture"],
          },
          dataLicense: "CC0-1.0",
          documentNamespace: "https://example.invalid/sbom/fixture",
          name: "fixture-dependencies",
          packages: [
            {
              SPDXID: "SPDXRef-Package-fixture",
              downloadLocation: "NOASSERTION",
              licenseConcluded: "NOASSERTION",
              licenseDeclared: "Apache-2.0",
              name: "fixture-package",
              versionInfo: "1.0.0",
            },
          ],
          spdxVersion: "SPDX-2.3",
        },
        null,
        2,
      )}\n`,
    );
  }
  return { input, notes, output, rollback, sbomPath };
}

test("generates and verifies a deterministic offline bundle with inventory SBOM", async (t) => {
  const first = await fixture(t);
  const firstOutput = await generateReleaseArtifactBundle({
    inputDirectory: first.input,
    outputDirectory: first.output,
    releaseNotesPath: first.notes,
    releaseVersion: "0.1.0",
    rollbackGuidePath: first.rollback,
  });
  const firstVerification = await verifyReleaseArtifactBundle(first.output, {
    expectedVersion: "0.1.0",
  });
  assert.equal(firstVerification.verified, true);
  assert.equal(firstVerification.provenance, "not-published");
  assert.equal(firstVerification.signature, "not-produced");
  assert.equal(firstOutput.fileCount, 5);
  const manifest = JSON.parse(
    await readFile(path.join(first.output, "release-manifest.json"), "utf8"),
  );
  assert.equal(manifest.claims.networkAccess, false);
  assert.equal(manifest.claims.secretsRead, false);
  const sbom = JSON.parse(await readFile(path.join(first.output, "sbom.spdx.json"), "utf8"));
  assert.equal(sbom.spdxVersion, "SPDX-2.3");
  assert.equal(sbom.files.length, 2);

  const secondOutput = path.join(path.dirname(first.output), "bundle-2");
  await generateReleaseArtifactBundle({
    inputDirectory: first.input,
    outputDirectory: secondOutput,
    releaseNotesPath: first.notes,
    releaseVersion: "0.1.0",
    rollbackGuidePath: first.rollback,
  });
  const firstSnapshot = await snapshot(first.output);
  const secondSnapshot = await snapshot(secondOutput);
  assert.deepEqual([...firstSnapshot.keys()], [...secondSnapshot.keys()]);
  for (const name of firstSnapshot.keys())
    assert.deepEqual(firstSnapshot.get(name), secondSnapshot.get(name), `deterministic ${name}`);
});

test("canonicalizes a supplied dependency SBOM without claiming publication", async (t) => {
  const values = await fixture(t, { sbom: true });
  await generateReleaseArtifactBundle({
    inputDirectory: values.input,
    outputDirectory: values.output,
    releaseNotesPath: values.notes,
    releaseVersion: "1.2.3-rc.1",
    rollbackGuidePath: values.rollback,
    sbomPath: values.sbomPath,
  });
  const result = await verifyReleaseArtifactBundle(values.output);
  assert.equal(result.releaseVersion, "1.2.3-rc.1");
  const sbom = JSON.parse(await readFile(path.join(values.output, "sbom.spdx.json"), "utf8"));
  assert.equal(sbom.packages[0].name, "fixture-package");
  assert.equal(sbom.creationInfo.created, "2026-08-11T00:00:00Z");
});

test("stages verified source bytes and preserves executable mode", async (t) => {
  const values = await fixture(t);
  const source = path.join(values.input, "README.txt");
  await chmod(source, 0o755);
  await generateReleaseArtifactBundle({
    inputDirectory: values.input,
    outputDirectory: values.output,
    releaseNotesPath: values.notes,
    releaseVersion: "0.1.0",
    rollbackGuidePath: values.rollback,
  });
  const output = await stat(path.join(values.output, "README.txt"));
  assert.equal(output.mode & 0o777, 0o755);
  assert.equal(
    (await readFile(path.join(values.output, "README.txt"))).toString(),
    "Release payload fixture\n",
  );
  assert.equal((await verifyReleaseArtifactBundle(values.output)).verified, true);
});

test("refuses overwrite and unsafe source entries", async (t) => {
  const values = await fixture(t);
  await generateReleaseArtifactBundle({
    inputDirectory: values.input,
    outputDirectory: values.output,
    releaseNotesPath: values.notes,
    releaseVersion: "0.1.0",
    rollbackGuidePath: values.rollback,
  });
  await assert.rejects(
    generateReleaseArtifactBundle({
      inputDirectory: values.input,
      outputDirectory: values.output,
      releaseNotesPath: values.notes,
      releaseVersion: "0.1.0",
      rollbackGuidePath: values.rollback,
    }),
    /output already exists/u,
  );
  const unsafe = await mkdtemp(path.join(os.tmpdir(), "agent-context-release-unsafe-"));
  t.after(() => rm(unsafe, { force: true, recursive: true }));
  await symlink(values.notes, path.join(unsafe, "notes.md"));
  await assert.rejects(
    generateReleaseArtifactBundle({
      inputDirectory: unsafe,
      outputDirectory: path.join(unsafe, "bundle"),
      releaseNotesPath: values.notes,
      releaseVersion: "0.1.0",
      rollbackGuidePath: values.rollback,
    }),
    /symbolic link/u,
  );
});

test("verification fails closed for tampered payload, checksum, and unsafe claims", async (t) => {
  const values = await fixture(t);
  await generateReleaseArtifactBundle({
    inputDirectory: values.input,
    outputDirectory: values.output,
    releaseNotesPath: values.notes,
    releaseVersion: "0.1.0",
    rollbackGuidePath: values.rollback,
  });
  const payload = path.join(values.output, "README.txt");
  await writeFile(payload, "tampered\n");
  await assert.rejects(verifyReleaseArtifactBundle(values.output), /manifest digest mismatch/u);
  await writeFile(payload, "Release payload fixture\n");
  const checksums = path.join(values.output, "checksums.sha256");
  const originalChecksums = await readFile(checksums, "utf8");
  await writeFile(checksums, originalChecksums.replace(/^./u, "f"));
  await assert.rejects(verifyReleaseArtifactBundle(values.output), /checksum mismatch/u);
  await writeFile(checksums, originalChecksums);
  const manifestPath = path.join(values.output, "release-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.provenance.state = "published";
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await assert.rejects(
    verifyReleaseArtifactBundle(values.output),
    /checksum mismatch|unverified signature or provenance/u,
  );
});

test("CLI has no publish, token, or key capability and verifies bundles", async (t) => {
  const values = await fixture(t);
  const script = path.join(
    path.dirname(new URL(import.meta.url).pathname),
    "release-artifacts.mjs",
  );
  const generated = await execFileAsync(process.execPath, [
    script,
    "generate",
    "--input",
    values.input,
    "--output",
    values.output,
    "--version",
    "0.1.0",
    "--release-notes",
    values.notes,
    "--rollback-guide",
    values.rollback,
  ]);
  assert.match(generated.stdout, /bundleDirectory/u);
  const verified = await execFileAsync(process.execPath, [
    script,
    "verify",
    "--bundle",
    values.output,
  ]);
  assert.match(verified.stdout, /"verified":true/u);
  await assert.rejects(
    execFileAsync(process.execPath, [
      script,
      "generate",
      "--input",
      values.input,
      "--publish",
      "true",
    ]),
    /unknown option: --publish/u,
  );
  await assert.rejects(
    execFileAsync(process.execPath, [
      script,
      "verify",
      "--bundle",
      values.output,
      "--key",
      "private.key",
    ]),
    /unknown option: --key/u,
  );
});

test("rejects malformed release metadata and unsafe Markdown", async (t) => {
  const values = await fixture(t);
  await writeFile(values.notes, "release notes without a heading\n");
  await assert.rejects(
    generateReleaseArtifactBundle({
      inputDirectory: values.input,
      outputDirectory: values.output,
      releaseNotesPath: values.notes,
      releaseVersion: "not-a-version",
      rollbackGuidePath: values.rollback,
    }),
    /SemVer/u,
  );
  await assert.rejects(
    generateReleaseArtifactBundle({
      inputDirectory: values.input,
      outputDirectory: path.join(path.dirname(values.output), "bundle-2"),
      releaseNotesPath: values.notes,
      releaseVersion: "0.1.0",
      rollbackGuidePath: values.rollback,
    }),
    /must contain a Markdown heading/u,
  );
});

test("rejects malformed supplied SPDX documents", async (t) => {
  const values = await fixture(t);
  const malformed = path.join(path.dirname(values.output), "malformed-sbom.json");
  await writeFile(
    malformed,
    `${JSON.stringify(
      {
        SPDXID: "SPDXRef-DOCUMENT",
        creationInfo: { created: "2026-08-11T00:00:00Z", creators: ["Tool: fixture"] },
        dataLicense: "CC0-1.0",
        documentNamespace: "https://example.invalid/sbom/malformed",
        name: "malformed",
        spdxVersion: "SPDX-2.2",
      },
      null,
      2,
    )}\n`,
  );
  await assert.rejects(
    generateReleaseArtifactBundle({
      inputDirectory: values.input,
      outputDirectory: values.output,
      releaseNotesPath: values.notes,
      releaseVersion: "0.1.0",
      rollbackGuidePath: values.rollback,
      sbomPath: malformed,
    }),
    /SPDX-2.3/u,
  );
});
