import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertForbiddenUnbundledOutputsAbsent,
  auditBundleContents,
  auditBundleMetafile,
  buildCliBundle,
  contributingThirdPartyInputs,
  createThirdPartyNotices,
  isAbsoluteOrEscaping,
  removeForbiddenUnbundledOutputs,
  resolveContainedPath,
} from "./build-cli-bundle.mjs";

const metafilePath = fileURLToPath(new URL("../packages/cli/dist/cli.meta.json", import.meta.url));
const bundlePath = fileURLToPath(new URL("../packages/cli/dist/cli.js", import.meta.url));

test("the checked-in CLI bundle is deterministic and current", async () => {
  await buildCliBundle({ check: true });
  const [metafile, bundle] = await Promise.all([
    readFile(metafilePath, "utf8"),
    readFile(bundlePath, "utf8"),
  ]);
  assert.doesNotMatch(metafile, /node:worker_threads/u);
  assert.doesNotMatch(bundle, /node:worker_threads/u);
  const parsedMetafile = JSON.parse(metafile);
  const processInputs = Object.entries(parsedMetafile.inputs).flatMap(([inputPath, input]) =>
    (input.imports ?? [])
      .filter((entry) => entry.path === "node:child_process")
      .map((entry) => ({ inputPath, kind: entry.kind })),
  );
  assert.deepEqual(processInputs, [
    {
      inputPath: "packages/cli/src/git-metadata-executor.ts",
      kind: "dynamic-import",
    },
  ]);
  const processOutputs = Object.values(parsedMetafile.outputs).flatMap((output) =>
    (output.imports ?? [])
      .filter((entry) => entry.path === "node:child_process")
      .map((entry) => entry.kind),
  );
  assert.deepEqual(processOutputs, ["dynamic-import"]);
  assert.doesNotThrow(() => auditBundleContents(bundle));
});

test("the bundle content audit rejects internal seams and missing production runtime", () => {
  const valid =
    "createNodeGitMetadataExecutor Git metadata output limit is invalid production-runtime";
  assert.doesNotThrow(() => auditBundleContents(valid));
  for (const forbidden of ["bindMetadataFileWithinForTest", "reference binding test"])
    assert.throws(() => auditBundleContents(`${valid} ${forbidden}`), /internal test seam/u);
  for (const required of ["createNodeGitMetadataExecutor", "Git metadata output limit is invalid"])
    assert.throws(
      () => auditBundleContents(valid.replace(required, "removed")),
      /omits the production Git executor/u,
    );
});

test("the bundle check rejects and the writer removes every stale production-facade output", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-context-cli-forbidden-output-"));
  const facadeOutputs = ["d.ts", "d.ts.map", "js", "js.map"].map((extension) =>
    path.join(root, `git-metadata-executor-production.${extension}`),
  );
  try {
    for (const staleOutput of facadeOutputs) {
      await writeFile(staleOutput, "stale private output\n", "utf8");
      await assert.rejects(
        assertForbiddenUnbundledOutputsAbsent(facadeOutputs),
        new RegExp(
          `unbundled private executable module remains in dist: ${path.basename(staleOutput).replaceAll(".", "\\.")}$`,
          "u",
        ),
      );
      await rm(staleOutput, { force: true });
    }
    await Promise.all(
      facadeOutputs.map((staleOutput) => writeFile(staleOutput, "stale\n", "utf8")),
    );
    await removeForbiddenUnbundledOutputs(facadeOutputs);
    await assert.doesNotReject(assertForbiddenUnbundledOutputsAbsent(facadeOutputs));
    for (const staleOutput of facadeOutputs)
      await assert.rejects(readFile(staleOutput), { code: "ENOENT" });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("the generated ESM bundle executes bundled CommonJS dependencies", () => {
  const result = spawnSync(process.execPath, [bundlePath, "--help"], {
    encoding: "utf8",
    shell: false,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Agent Context Linter /u);
});

test("the bundle audit accepts only core and Node built-ins as externals", () => {
  assert.doesNotThrow(() =>
    auditBundleMetafile({
      inputs: {
        "packages/cli/src/fixture.ts": {
          imports: [
            { external: true, path: "@agent-context/core" },
            { external: true, path: "node:path" },
          ],
        },
      },
      outputs: {
        "packages/cli/dist/fixture.js": {
          imports: [
            { external: true, path: "@agent-context/core" },
            { external: true, path: "node:path" },
          ],
        },
      },
    }),
  );
});

test("the bundle audit rejects private, undeclared, residual, and absolute edges", () => {
  for (const fixture of [
    {
      inputs: {
        "packages/cli/src/fixture.ts": {
          imports: [{ external: true, path: "@agent-context/rules" }],
        },
      },
      outputs: {},
    },
    {
      inputs: {},
      outputs: {
        "packages/cli/dist/fixture.js": {
          imports: [{ external: false, path: "./unbundled.js" }],
        },
      },
    },
    {
      inputs: { "/private/build/fixture.ts": { imports: [] } },
      outputs: {},
    },
    {
      inputs: {},
      outputs: {
        "packages/cli/dist/fixture.js": {
          imports: [{ external: true, path: "node:https" }],
        },
      },
    },
  ])
    assert.throws(() => auditBundleMetafile(fixture), /CLI bundle is not closed/u);
});

test("the bundle audit rejects network builtins from dependency inputs and require calls", () => {
  for (const [pathValue, kind] of [
    ["net", "require-call"],
    ["node:tls", "require-call"],
    ["node:dns/promises", "import-statement"],
  ])
    assert.throws(
      () =>
        auditBundleMetafile({
          inputs: {
            "node_modules/dependency/index.js": {
              imports: [{ external: true, kind, path: pathValue }],
            },
          },
          outputs: { "packages/cli/dist/fixture.js": { imports: [] } },
        }),
      /network-capable builtin outside standards operation/u,
    );
});

test("the bundle audit permits network builtins only in standards sources and the CLI output", () => {
  assert.doesNotThrow(() =>
    auditBundleMetafile({
      inputs: {
        "packages/standards/src/registry-client.ts": {
          imports: [{ external: true, kind: "import-statement", path: "node:https" }],
        },
        "packages/standards/dist/standards-cache.js": {
          imports: [{ external: true, kind: "import-statement", path: "node:net" }],
        },
      },
      outputs: {
        "packages/cli/dist/cli.js": {
          inputs: {
            "packages/standards/src/registry-client.ts": { bytesInOutput: 1 },
            "packages/standards/dist/standards-cache.js": { bytesInOutput: 1 },
          },
          imports: [
            { external: true, kind: "import-statement", path: "node:https" },
            { external: true, kind: "import-statement", path: "node:net" },
          ],
        },
      },
    }),
  );
  assert.throws(
    () =>
      auditBundleMetafile({
        inputs: {
          "packages/standards/src/registry-client.ts": {
            imports: [{ external: true, kind: "import-statement", path: "node:https" }],
          },
        },
        outputs: {
          "packages/cli/dist/fixture.js": {
            imports: [{ external: true, kind: "import-statement", path: "node:https" }],
          },
        },
      }),
    /network-capable builtin outside standards operation/u,
  );
});

test("the bundle audit confines child processes to the explicit changed-mode dynamic import", () => {
  for (const fixture of [
    {
      inputs: {
        "packages/cli/src/git-metadata-executor.ts": {
          imports: [{ external: true, kind: "import-statement", path: "node:child_process" }],
        },
      },
      outputs: {},
    },
    {
      inputs: {
        "packages/cli/src/scan-command.ts": {
          imports: [{ external: true, kind: "dynamic-import", path: "node:child_process" }],
        },
      },
      outputs: {},
    },
    {
      inputs: {},
      outputs: {
        "packages/cli/dist/cli.js": {
          imports: [{ external: true, kind: "import-statement", path: "node:child_process" }],
        },
      },
    },
  ])
    assert.throws(() => auditBundleMetafile(fixture), /process capability/u);
});

test("third-party notices cover the exact bundled package inventory", async () => {
  const metafile = JSON.parse(await readFile(metafilePath, "utf8"));
  const notices = await createThirdPartyNotices(metafile);
  const packages = [...notices.matchAll(/^Package: (.+)$/gmu)].map((match) => match[1]);
  assert.ok(packages.length > 20);
  assert.equal(new Set(packages).size, packages.length);
  assert.ok(packages.includes("yaml@2.9.0"));
  assert.ok(packages.includes("@tufjs/models@4.0.0"));
  assert.ok(!packages.some((entry) => entry.startsWith("esbuild@")));
  assert.match(notices, /^----- LICEN[CS]E(?:\..*)? -----$/mu);
});

test("notice ownership ignores tree-shaken inputs without output bytes", () => {
  const metafile = {
    inputs: {
      "node_modules/.pnpm/kept@1.0.0/node_modules/kept/index.js": {},
      "node_modules/.pnpm/shaken@1.0.0/node_modules/shaken/index.js": {},
    },
    outputs: {
      "packages/cli/dist/cli.js": {
        inputs: {
          "node_modules/.pnpm/kept@1.0.0/node_modules/kept/index.js": { bytesInOutput: 1 },
          "node_modules/.pnpm/shaken@1.0.0/node_modules/shaken/index.js": { bytesInOutput: 0 },
        },
      },
    },
  };
  assert.deepEqual(contributingThirdPartyInputs(metafile), [
    "node_modules/.pnpm/kept@1.0.0/node_modules/kept/index.js",
  ]);
  assert.throws(
    () =>
      contributingThirdPartyInputs({
        inputs: {},
        outputs: {
          "packages/cli/dist/cli.js": {
            inputs: {
              "node_modules/.pnpm/missing@1.0.0/node_modules/missing/index.js": {
                bytesInOutput: 1,
              },
            },
          },
        },
      }),
    /output contribution has no input metadata/u,
  );
});

test("build path containment rejects cross-platform traversal without prefix confusion", () => {
  for (const unsafe of [
    "../outside",
    "safe/..",
    "safe/../outside",
    "safe\\..\\outside",
    "C:\\outside",
    "\\\\server\\share",
  ]) {
    assert.equal(isAbsoluteOrEscaping(unsafe), true, unsafe);
    assert.throws(() => resolveContainedPath("/workspace/project", unsafe), /unsafe build path/u);
  }
  assert.equal(isAbsoluteOrEscaping("safe..name/output.js"), false);
  assert.equal(
    resolveContainedPath("/workspace/project", "safe..name/output.js"),
    "/workspace/project/safe..name/output.js",
  );
  assert.equal(isAbsoluteOrEscaping("project-other/output.js"), false);
});
