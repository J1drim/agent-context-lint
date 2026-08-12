import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { lstat, mkdtemp, readFile, realpath, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  MAX_UPSTREAM_SOURCE_BYTES,
  UpstreamSnapshotError,
  canonicalJson,
  captureUpstreamSnapshot,
  parseCatalogBytes,
  runMaintainerCli,
  sha256,
  upstreamCatalogPath,
  verifyUpstreamSnapshot,
  writeSnapshotArtifacts,
} from "./upstream-snapshotter.mjs";
import {
  createOfficialSourceTransport,
  selectPublicAddress,
  validateResponseHeaders,
} from "./upstream-transport.mjs";

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020.js").default;
const addFormats = require("ajv-formats").default;
const RETRIEVED_AT = "2026-08-02";

async function catalogFixture() {
  const bytes = await readFile(upstreamCatalogPath);
  return { bytes, value: parseCatalogBytes(bytes) };
}

function sourceBody(source, suffix = "") {
  if (source.format === "html") {
    return Buffer.from(
      `<html><head><style>ignored</style><script>ignored</script></head><body><main><h1>${source.id}</h1>${source.sections
        .map(
          (section, index) =>
            `<h${section.level}>${section.heading}</h${section.level}><p>Cafe\u0301 ${index}${suffix} &amp; provenance.   </p><!--ignored--><h${Math.min(section.level + 1, 6)}>Nested detail</h${Math.min(section.level + 1, 6)}><p>Bounded detail.</p>`,
        )
        .join("")}<h2>Unselected appendix</h2><p>Not captured.</p></main></body></html>`,
    );
  }
  return Buffer.from(
    `# ${source.id}\r\n\r\n${source.sections
      .map(
        (section, index) =>
          `${"#".repeat(section.level)} ${section.heading}\r\n\r\nCafe\u0301 ${index}${suffix} and provenance.   \r\n\r\n\r\n${"#".repeat(Math.min(section.level + 1, 6))} Nested detail\r\n\r\nBounded detail.\r\n\r\n`,
      )
      .join("")}## Unselected appendix\r\n\r\nNot captured.\r\n`,
  );
}

function fakeTransport(catalog, overrides = new Map()) {
  const requests = [];
  return {
    requests,
    transport: {
      async fetch(source, { signal }) {
        requests.push(source.url);
        if (signal.aborted) throw new UpstreamSnapshotError("cancelled", "fixture cancelled");
        const selected = overrides.get(source.id);
        if (selected instanceof Error) throw selected;
        return (
          selected ?? {
            bytes: sourceBody(source),
            mediaType: source.format === "html" ? "text/html" : "text/markdown",
          }
        );
      },
    },
  };
}

async function captureFixture(overrides) {
  const catalog = await catalogFixture();
  const fake = fakeTransport(catalog.value, overrides);
  const artifacts = await captureUpstreamSnapshot({
    catalogBytes: catalog.bytes,
    retrievedAt: RETRIEVED_AT,
    signal: new AbortController().signal,
    transport: fake.transport,
  });
  return { artifacts, catalog, fake };
}

function canonicalMutation(bytes, mutate) {
  const value = JSON.parse(bytes);
  mutate(value);
  return canonicalJson(value);
}

function expectCode(error, code) {
  assert.ok(error instanceof UpstreamSnapshotError);
  assert.equal(error.code, code);
  return true;
}

test("capture requests only the exact sorted allowlist and replay is byte deterministic", async () => {
  const first = await captureFixture();
  const second = await captureFixture();
  assert.deepEqual(
    first.fake.requests,
    first.catalog.value.sources.map((source) => source.url),
  );
  assert.equal(new Set(first.fake.requests).size, 6);
  assert.deepEqual(first.artifacts.sourceBytes, second.artifacts.sourceBytes);
  assert.deepEqual(first.artifacts.provenanceBytes, second.artifacts.provenanceBytes);
  assert.equal(first.artifacts.sourceArtifact.sources.length, 6);
  assert.equal(first.artifacts.provenanceArtifact.retrievedAt, RETRIEVED_AT);
  assert.equal(
    first.artifacts.provenanceArtifact.sourceArtifactSha256,
    sha256(first.artifacts.sourceBytes),
  );
  assert.deepEqual(
    verifyUpstreamSnapshot({
      catalogBytes: first.catalog.bytes,
      provenanceBytes: first.artifacts.provenanceBytes,
      sourceBytes: first.artifacts.sourceBytes,
    }),
    {
      ok: true,
      retrievedAt: RETRIEVED_AT,
      sourceArtifactSha256: sha256(first.artifacts.sourceBytes),
      sources: 6,
    },
  );
});

test("normalization is section-bounded, NFC, LF-only, and strips HTML-only content", async () => {
  const { artifacts } = await captureFixture();
  for (const source of artifacts.sourceArtifact.sources) {
    assert.equal(source.sections.length, 3);
    for (const section of source.sections) {
      assert.match(section.normalized, /^Café \d/u);
      assert.ok(section.normalized.endsWith("\n"));
      assert.ok(!section.normalized.includes("\r"));
      assert.ok(!section.normalized.includes("Unselected appendix"));
      assert.ok(!section.normalized.includes("ignored"));
      assert.ok(!section.normalized.includes("\n\n\n"));
      assert.equal(section.sha256, sha256(Buffer.from(section.normalized)));
    }
  }
});

test("generated source and provenance artifacts satisfy their published schemas", async () => {
  const { artifacts } = await captureFixture();
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  for (const [schemaName, value] of [
    ["upstream-source.v1.schema.json", artifacts.sourceArtifact],
    ["upstream-provenance.v1.schema.json", artifacts.provenanceArtifact],
  ]) {
    const schema = JSON.parse(
      await readFile(path.join(process.cwd(), "tools/standards/schemas", schemaName), "utf8"),
    );
    assert.equal(ajv.validate(schema, value), true, JSON.stringify(ajv.errors));
  }
});

test("offline replay rejects raw, normalized, provenance, digest, and noncanonical tampering", async () => {
  const { artifacts, catalog } = await captureFixture();
  const cases = [
    {
      provenanceBytes: artifacts.provenanceBytes,
      sourceBytes: canonicalMutation(artifacts.sourceBytes, (value) => {
        value.sources[0].rawBase64 = Buffer.from("tampered").toString("base64");
      }),
    },
    {
      provenanceBytes: artifacts.provenanceBytes,
      sourceBytes: canonicalMutation(artifacts.sourceBytes, (value) => {
        value.sources[0].sections[0].normalized = "tampered\n";
      }),
    },
    {
      provenanceBytes: canonicalMutation(artifacts.provenanceBytes, (value) => {
        value.sources[0].sectionHashes[0].sha256 = "0".repeat(64);
      }),
      sourceBytes: artifacts.sourceBytes,
    },
    {
      provenanceBytes: canonicalMutation(artifacts.provenanceBytes, (value) => {
        value.sourceArtifactSha256 = "0".repeat(64);
      }),
      sourceBytes: artifacts.sourceBytes,
    },
    {
      provenanceBytes: Buffer.from(` ${artifacts.provenanceBytes.toString()}`),
      sourceBytes: artifacts.sourceBytes,
    },
  ];
  for (const selected of cases) {
    assert.throws(
      () =>
        verifyUpstreamSnapshot({
          catalogBytes: catalog.bytes,
          provenanceBytes: selected.provenanceBytes,
          sourceBytes: selected.sourceBytes,
        }),
      (error) => expectCode(error, "invalid-artifact"),
    );
  }
});

test("catalog validation rejects URL broadening, omissions, reordering, and unknown fields", async () => {
  const { value } = await catalogFixture();
  const mutations = [
    (catalog) => {
      catalog.sources[0].url = "https://127.0.0.1/private";
    },
    (catalog) => {
      catalog.sources[0].url = `${catalog.sources[0].url}?query=1`;
    },
    (catalog) => {
      catalog.sources.pop();
    },
    (catalog) => {
      [catalog.sources[0], catalog.sources[1]] = [catalog.sources[1], catalog.sources[0]];
    },
    (catalog) => {
      catalog.sources[0].extra = true;
    },
    (catalog) => {
      catalog.sources[0].sections[1].id = catalog.sources[0].sections[0].id;
    },
  ];
  for (const mutate of mutations) {
    const candidate = structuredClone(value);
    mutate(candidate);
    assert.throws(
      () => parseCatalogBytes(canonicalJson(candidate)),
      (error) => {
        assert.ok(error instanceof UpstreamSnapshotError);
        assert.ok(["invalid-artifact", "invalid-catalog"].includes(error.code));
        return true;
      },
    );
  }
});

test("capture rejects invalid dates, signals, media, bytes, headings, and transport failures", async () => {
  const catalog = await catalogFixture();
  const source = catalog.value.sources[0];
  for (const date of ["2026-02-30", "2026-8-2", "", 1]) {
    const fake = fakeTransport(catalog.value);
    await assert.rejects(
      captureUpstreamSnapshot({
        catalogBytes: catalog.bytes,
        retrievedAt: date,
        signal: new AbortController().signal,
        transport: fake.transport,
      }),
      (error) => expectCode(error, "invalid-date"),
    );
    assert.equal(fake.requests.length, 0);
  }
  await assert.rejects(
    captureUpstreamSnapshot({
      catalogBytes: catalog.bytes,
      retrievedAt: RETRIEVED_AT,
      signal: {},
      transport: fakeTransport(catalog.value).transport,
    }),
    (error) => expectCode(error, "invalid-input"),
  );
  const hostile = [
    {
      bytes: sourceBody(source),
      mediaType:
        "text/html" === (source.format === "html" ? "text/html" : "text/markdown")
          ? "text/plain"
          : "text/html",
    },
    { bytes: Buffer.alloc(0), mediaType: source.format === "html" ? "text/html" : "text/markdown" },
    {
      bytes: Buffer.from([0xff]),
      mediaType: source.format === "html" ? "text/html" : "text/markdown",
    },
    {
      bytes: Buffer.from([0xef, 0xbb, 0xbf, 0x61]),
      mediaType: source.format === "html" ? "text/html" : "text/markdown",
    },
    {
      bytes: Buffer.from("a\0b"),
      mediaType: source.format === "html" ? "text/html" : "text/markdown",
    },
    {
      bytes: Buffer.alloc(MAX_UPSTREAM_SOURCE_BYTES + 1, 0x61),
      mediaType: source.format === "html" ? "text/html" : "text/markdown",
    },
    { bytes: Buffer.from("<h2>different</h2><p>body</p>"), mediaType: "text/html" },
  ];
  for (const response of hostile) {
    const overrides = new Map([[source.id, response]]);
    await assert.rejects(
      captureUpstreamSnapshot({
        catalogBytes: catalog.bytes,
        retrievedAt: RETRIEVED_AT,
        signal: new AbortController().signal,
        transport: fakeTransport(catalog.value, overrides).transport,
      }),
      UpstreamSnapshotError,
    );
  }
  const duplicate = sourceBody(source)
    .toString()
    .replace(
      source.format === "html" ? "</body>" : "## Unselected appendix",
      source.format === "html"
        ? `<h2>${source.sections[0].heading}</h2><p>duplicate</p></body>`
        : `## ${source.sections[0].heading}\nDuplicate\n## Unselected appendix`,
    );
  await assert.rejects(
    captureUpstreamSnapshot({
      catalogBytes: catalog.bytes,
      retrievedAt: RETRIEVED_AT,
      signal: new AbortController().signal,
      transport: fakeTransport(
        catalog.value,
        new Map([[source.id, { bytes: Buffer.from(duplicate), mediaType: "text/html" }]]),
      ).transport,
    }),
    (error) => expectCode(error, "section-mismatch"),
  );
  const failure = fakeTransport(
    catalog.value,
    new Map([[source.id, new Error("secret remote failure")]]),
  );
  await assert.rejects(
    captureUpstreamSnapshot({
      catalogBytes: catalog.bytes,
      retrievedAt: RETRIEVED_AT,
      signal: new AbortController().signal,
      transport: failure.transport,
    }),
    (error) => {
      assert.equal(error.code, "network-failure");
      assert.ok(!error.message.includes("secret"));
      return true;
    },
  );
});

test("cancellation stops the bounded sequential acquisition", async () => {
  const catalog = await catalogFixture();
  const controller = new AbortController();
  let requests = 0;
  await assert.rejects(
    captureUpstreamSnapshot({
      catalogBytes: catalog.bytes,
      retrievedAt: RETRIEVED_AT,
      signal: controller.signal,
      transport: {
        async fetch(source) {
          requests += 1;
          controller.abort();
          return {
            bytes: sourceBody(source),
            mediaType: source.format === "html" ? "text/html" : "text/markdown",
          };
        },
      },
    }),
    (error) => expectCode(error, "cancelled"),
  );
  assert.equal(requests, 1);
});

test("public-address and response-header policies reject SSRF and protocol ambiguity", () => {
  assert.deepEqual(
    selectPublicAddress([
      { address: "2606:4700:4700::1111", family: 6 },
      { address: "8.8.8.8", family: 4 },
    ]),
    { address: "8.8.8.8", family: 4 },
  );
  for (const address of [
    { address: "127.0.0.1", family: 4 },
    { address: "10.0.0.1", family: 4 },
    { address: "169.254.1.1", family: 4 },
    { address: "192.168.1.1", family: 4 },
    { address: "::1", family: 6 },
    { address: "fc00::1", family: 6 },
    { address: "2001:db8::1", family: 6 },
  ]) {
    assert.throws(() => selectPublicAddress([address]), UpstreamSnapshotError);
  }
  const htmlSource = { format: "html" };
  assert.deepEqual(
    validateResponseHeaders(
      ["Content-Type", "text/html; charset=utf-8", "Content-Length", "10"],
      200,
      htmlSource,
    ),
    { declaredLength: 10, mediaType: "text/html" },
  );
  const rejected = [
    [["Content-Type", "text/html"], 302],
    [["Content-Type", "application/json"], 200],
    [["Content-Type", "text/html", "Content-Encoding", "gzip"], 200],
    [["Content-Type", "text/html", "Content-Type", "text/html"], 200],
    [["Content-Type", "text/html", "Transfer-Encoding", "gzip"], 200],
    [["Content-Type", "text/html", "Content-Length", String(MAX_UPSTREAM_SOURCE_BYTES + 1)], 200],
    [["Bad Header", "x"], 200],
  ];
  for (const [headers, status] of rejected)
    assert.throws(
      () => validateResponseHeaders(headers, status, htmlSource),
      UpstreamSnapshotError,
    );
});

test("production transport independently rejects requests outside its compiled allowlist", async () => {
  const transport = createOfficialSourceTransport();
  for (const source of [
    { format: "html", url: "https://127.0.0.1/private" },
    { format: "markdown", url: "https://agents.md/" },
    { format: "html", url: "https://agents.md/?query=1" },
  ]) {
    await assert.rejects(
      transport.fetch(source, { signal: new AbortController().signal }),
      (error) => expectCode(error, "invalid-catalog"),
    );
  }
});

test("artifact writer creates a private new directory and refuses overwrite or symlink parents", async () => {
  const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), "svetovid-upstream-")));
  try {
    const { artifacts } = await captureFixture();
    const output = path.join(temporary, "capture");
    const paths = await writeSnapshotArtifacts(output, artifacts);
    assert.deepEqual(await readFile(paths.sourcePath), artifacts.sourceBytes);
    assert.deepEqual(await readFile(paths.provenancePath), artifacts.provenanceBytes);
    assert.equal((await lstat(output)).mode & 0o777, 0o700);
    assert.equal((await lstat(paths.sourcePath)).mode & 0o777, 0o600);
    await assert.rejects(writeSnapshotArtifacts(output, artifacts), (error) =>
      expectCode(error, "unsafe-output"),
    );
    const link = path.join(temporary, "linked");
    await symlink(temporary, link);
    await assert.rejects(
      writeSnapshotArtifacts(path.join(link, "capture-two"), artifacts),
      (error) => expectCode(error, "unsafe-output"),
    );
    const interrupted = path.join(temporary, "interrupted");
    await assert.rejects(
      writeSnapshotArtifacts(interrupted, {
        provenanceBytes: undefined,
        sourceBytes: artifacts.sourceBytes,
      }),
      TypeError,
    );
    await assert.rejects(lstat(interrupted), (error) => error.code === "ENOENT");
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
});

test("maintainer CLI capture requires acknowledgement and verify is network-free", async () => {
  const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), "svetovid-upstream-cli-")));
  try {
    let calls = 0;
    await assert.rejects(runMaintainerCli(["capture"]), (error) => expectCode(error, "usage"));
    assert.equal(calls, 0);
    const catalog = await catalogFixture();
    const output = path.join(temporary, "capture");
    for (const now of [
      () => {
        throw new Error("secret clock failure");
      },
      () => Number.NaN,
      () => 1.5,
      () => Date.UTC(1969, 11, 31),
    ]) {
      await assert.rejects(
        runMaintainerCli(["capture", "--output-dir", output, "--acknowledge-network"], {
          now,
          transport: { fetch: () => assert.fail("network must not start") },
        }),
        (error) => {
          assert.equal(error.code, "invalid-date");
          assert.ok(!error.message.includes("secret"));
          return true;
        },
      );
    }
    const text = await runMaintainerCli(
      ["capture", "--output-dir", output, "--acknowledge-network"],
      {
        now: () => Date.UTC(2026, 7, 2, 12),
        transport: {
          async fetch(source) {
            calls += 1;
            return {
              bytes: sourceBody(source),
              mediaType: source.format === "html" ? "text/html" : "text/markdown",
            };
          },
        },
      },
    );
    assert.equal(calls, catalog.value.sources.length);
    assert.match(text, /Captured 6 official sources/u);
    const sourcePath = path.join(output, "upstream-source.v1.json");
    const provenancePath = path.join(output, "upstream-provenance.v1.json");
    assert.match(
      await runMaintainerCli(["verify", "--source", sourcePath, "--provenance", provenancePath]),
      /Verified 6 official sources/u,
    );
    assert.match(
      execFileSync(
        process.execPath,
        [
          "tools/standards/upstream-snapshotter.mjs",
          "verify",
          "--source",
          sourcePath,
          "--provenance",
          provenancePath,
        ],
        { cwd: process.cwd(), encoding: "utf8" },
      ),
      /Verified 6 official sources/u,
    );
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
});

test("artifact parser fails closed on malformed, deep, huge, and incomplete JSON", async () => {
  const catalog = await catalogFixture();
  const malformed = [
    Buffer.from("{"),
    Buffer.from([0xff]),
    Buffer.from("\ufeff{}"),
    Buffer.from(`${"[".repeat(33)}${"]".repeat(33)}`),
    Buffer.alloc(10 * 1024 * 1024 + 1, 0x20),
  ];
  for (const sourceBytes of malformed) {
    assert.throws(
      () =>
        verifyUpstreamSnapshot({
          catalogBytes: catalog.bytes,
          provenanceBytes: Buffer.from("{}\n"),
          sourceBytes,
        }),
      UpstreamSnapshotError,
    );
  }
});
