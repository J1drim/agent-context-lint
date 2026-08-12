import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  QUOTA_FIXED_RESERVE_BYTES,
  attachQuotaVolumeWithRecovery,
  cleanupQuotaVolume,
  createDarwinQuotaVolumeProvider,
  detachIssuedDevices,
  parseDarwinDfGeometry,
  parseHdiutilAttachmentInventory,
  parseHdiutilDeviceIdentity,
  parseHdiutilDeviceIdentities,
  parseHdiutilMountedQuotaIdentity,
  provisionQuotaVolume,
  recoverNewAttachmentIdentities,
  validateQuotaFilesystemGeometry,
} from "./quota-volume.mjs";

test("mounted APFS identity comes from one exact hdiutil partition entity", () => {
  const mountRoot = "/private/tmp/k03-volume/repository-1";
  const plist = `<plist><array>
    <dict><key>dev-entry</key><string>/dev/disk12</string><key>content-hint</key><string>GUID_partition_scheme</string></dict>
    <dict><key>dev-entry</key><string>/dev/disk12s1</string><key>content-hint</key><string>Apple_APFS</string><key>mount-point</key><string>${mountRoot}</string></dict>
  </array></plist>`;
  assert.deepEqual(parseHdiutilMountedQuotaIdentity(plist, mountRoot), {
    baseDevice: "/dev/disk12",
    contentHint: "Apple_APFS",
    filesystemName: "apfs",
    partitionDevice: "/dev/disk12s1",
  });
  assert.deepEqual(
    parseHdiutilMountedQuotaIdentity(
      plist.replace("Apple_APFS", "7C3457EF-0000-11AA-AA11-00306543ECAC"),
      mountRoot,
    ),
    {
      baseDevice: "/dev/disk12",
      contentHint: "7C3457EF-0000-11AA-AA11-00306543ECAC",
      filesystemName: "apfs",
      partitionDevice: "/dev/disk12s1",
    },
  );
  assert.deepEqual(
    parseHdiutilMountedQuotaIdentity(
      plist.replace("Apple_APFS", "41504653-0000-11AA-AA11-00306543ECAC"),
      mountRoot,
    ),
    {
      baseDevice: "/dev/disk12",
      contentHint: "41504653-0000-11AA-AA11-00306543ECAC",
      filesystemName: "apfs",
      partitionDevice: "/dev/disk12s1",
    },
  );
  assert.deepEqual(
    parseDarwinDfGeometry(
      `Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk12s1 131072 65536 65536 50% ${mountRoot}\n`,
      {
        contentHint: "Apple_APFS",
        filesystemName: "apfs",
        mountRoot,
        partitionDevice: "/dev/disk12s1",
      },
    ),
    {
      blockCount: 131072,
      blockSize: 1024,
      filesystemName: "apfs",
      filesystemType: "Apple_APFS",
      freeBlocks: 65536,
    },
  );
  assert.throws(
    () =>
      parseDarwinDfGeometry(
        `Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk13s1 131072 65536 65536 50% ${mountRoot}\n`,
        {
          contentHint: "Apple_APFS",
          filesystemName: "apfs",
          mountRoot,
          partitionDevice: "/dev/disk12s1",
        },
      ),
    /exact mounted partition geometry/u,
  );
  assert.throws(
    () => parseHdiutilMountedQuotaIdentity(plist.replace("Apple_APFS", "Apple_HFS"), mountRoot),
    /not an exact Apple_APFS partition/u,
  );
  assert.throws(
    () => parseHdiutilMountedQuotaIdentity(`${plist}${plist}`, mountRoot),
    /one exact mounted filesystem identity/u,
  );
});

test("Darwin df geometry permits APFS metadata blocks outside Used and Available", () => {
  assert.deepEqual(
    parseDarwinDfGeometry(
      "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk12s1 262104 24 260600 1% /fixture/mount\n",
      {
        contentHint: "41504653-0000-11AA-AA11-00306543ECAC",
        filesystemName: "apfs",
        mountRoot: "/fixture/mount",
        partitionDevice: "/dev/disk12s1",
      },
    ),
    {
      blockCount: 262104,
      blockSize: 1024,
      filesystemName: "apfs",
      filesystemType: "41504653-0000-11AA-AA11-00306543ECAC",
      freeBlocks: 260600,
    },
  );
});

test("quota geometry is a hard logical-budget plus fixed-reserve ceiling", () => {
  const logicalBudgetBytes = 64 * 1024;
  const allocatedResourceCeilingBytes = logicalBudgetBytes + QUOTA_FIXED_RESERVE_BYTES;
  const blockSize = 4096;
  const blockCount = allocatedResourceCeilingBytes / blockSize;
  const geometry = validateQuotaFilesystemGeometry({
    allocatedResourceCeilingBytes,
    blockCount,
    blockSize,
    filesystemType: "fixture",
    filesystemName: "apfs",
    freeBlocks: logicalBudgetBytes / blockSize,
    logicalBudgetBytes,
  });
  assert.equal(geometry.initialAllocatedBytes, QUOTA_FIXED_RESERVE_BYTES);
  assert.throws(
    () =>
      validateQuotaFilesystemGeometry({
        allocatedResourceCeilingBytes,
        blockCount: blockCount + 1,
        blockSize,
        filesystemType: "fixture",
        filesystemName: "apfs",
        freeBlocks: logicalBudgetBytes / blockSize,
        logicalBudgetBytes,
      }),
    /geometry exceeds/,
  );
  assert.throws(
    () =>
      validateQuotaFilesystemGeometry({
        allocatedResourceCeilingBytes,
        blockCount,
        blockSize,
        filesystemType: "fixture",
        filesystemName: "hfs",
        freeBlocks: logicalBudgetBytes / blockSize,
        logicalBudgetBytes,
      }),
    /exact mounted APFS identity/,
  );
  assert.throws(
    () =>
      validateQuotaFilesystemGeometry({
        allocatedResourceCeilingBytes,
        blockCount,
        blockSize,
        filesystemType: "fixture",
        filesystemName: "apfs",
        freeBlocks: logicalBudgetBytes / blockSize + 2,
        logicalBudgetBytes,
      }),
    /logical budget/u,
  );
  assert.doesNotThrow(() =>
    validateQuotaFilesystemGeometry({
      allocatedResourceCeilingBytes,
      blockCount,
      blockSize,
      filesystemType: "fixture",
      filesystemName: "apfs",
      freeBlocks: logicalBudgetBytes / blockSize + 1,
      logicalBudgetBytes,
    }),
  );
  assert.doesNotThrow(() =>
    validateQuotaFilesystemGeometry({
      allocatedResourceCeilingBytes,
      blockCount,
      blockSize,
      filesystemType: "fixture",
      filesystemName: "apfs",
      freeBlocks: 1,
      logicalBudgetBytes,
      payloadMayConsumeBudget: true,
    }),
  );
});

test("attachment recovery identifies every device issued for the exact image", () => {
  const imagePath = "/fixture/fixture.sparseimage";
  const foreignPath = "/fixture/foreign.sparseimage";
  const before = new Map([["/dev/disk1", new Set([foreignPath])]]);
  const after = new Map([
    ...before,
    ["/dev/disk3", new Set([imagePath])],
    ["/dev/disk4", new Set([imagePath])],
    ["/dev/disk5", new Set([foreignPath])],
  ]);
  assert.deepEqual(recoverNewAttachmentIdentities(before, before, imagePath), {
    issued: [],
    unexpected: [],
  });
  assert.deepEqual(recoverNewAttachmentIdentities(before, after, imagePath), {
    issued: ["/dev/disk3", "/dev/disk4"],
    unexpected: ["/dev/disk5"],
  });
});

function devicePlist(images) {
  return `<plist>${images
    .map(
      ({ devices, imagePath }) =>
        `<dict><key>image-path</key><string>${imagePath.replaceAll("&", "&amp;")}</string>${devices
          .map((device) => `<key>dev-entry</key><string>${device}</string>`)
          .join("")}</dict>`,
    )
    .join("")}</plist>`;
}

function aggregateMessages(error) {
  return [
    error.message,
    ...(error instanceof AggregateError ? error.errors.flatMap(aggregateMessages) : []),
  ];
}

async function cleanupFixture(t, issuedMount) {
  const workRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "k03-quota-cleanup-")));
  t.after(() => rm(workRoot, { force: true, recursive: true }));
  const mountPath = path.join(workRoot, "mount");
  const imagePath = path.join(workRoot, "fixture.sparseimage");
  await mkdir(mountPath);
  await writeFile(imagePath, "fixture image\n", { mode: 0o600 });
  const [mountMetadata, imageMetadata] = await Promise.all([stat(mountPath), stat(imagePath)]);
  const hostMount = {
    device: String(mountMetadata.dev),
    inode: String(mountMetadata.ino),
  };
  return {
    imagePath,
    state: {
      devices: ["/dev/disk7"],
      hostMount,
      image: { device: String(imageMetadata.dev), inode: String(imageMetadata.ino) },
      imagePath,
      mount: {
        device: issuedMount ? hostMount.device : `${hostMount.device}-issued`,
        inode: issuedMount ? hostMount.inode : `${hostMount.inode}-issued`,
        path: mountPath,
      },
      workRoot,
    },
  };
}

test("hdiutil inventory associates normalized devices with exact decoded image paths", () => {
  assert.deepEqual(
    [
      ...parseHdiutilAttachmentInventory(
        devicePlist([
          {
            devices: ["/dev/disk3", "/dev/disk3s1"],
            imagePath: "/fixture/a&b.sparseimage",
          },
        ]),
      ),
    ],
    [["/dev/disk3", new Set(["/fixture/a&b.sparseimage"])]],
  );
  assert.throws(
    () =>
      parseHdiutilAttachmentInventory(
        "<plist><key>dev-entry</key><string>/dev/disk9</string></plist>",
      ),
    /without an exact image association/u,
  );
});

test("initial and read-only attach wrapper failures recover all exact issued devices", async () => {
  const imagePath = "/fixture/fixture.sparseimage";
  for (const readonly of [false, true]) {
    for (const after of [[], ["/dev/disk3"], ["/dev/disk3", "/dev/disk4"]]) {
      const calls = [];
      let inventoryReads = 0;
      const wrapperFailure = new Error(`fixture ${readonly ? "readonly" : "initial"} failure`);
      const execute = async (_provider, arguments_) => {
        calls.push(arguments_);
        if (arguments_[0] === "attach") throw wrapperFailure;
        if (arguments_[0] === "info") {
          inventoryReads += 1;
          return {
            signal: null,
            status: 0,
            stderr: "",
            stdout: devicePlist(inventoryReads === 1 ? [{ devices: after, imagePath }] : []),
          };
        }
        return { signal: null, status: 0, stderr: "", stdout: "" };
      };
      await assert.rejects(
        attachQuotaVolumeWithRecovery(
          {},
          ["attach", ...(readonly ? ["-readonly"] : []), "fixture.sparseimage"],
          "/fixture",
          new Map(),
          imagePath,
          execute,
        ),
        /fixture .* failure/u,
      );
      const detachCalls = calls.filter(([operation]) => operation === "detach");
      assert.deepEqual(
        detachCalls,
        after.map((device) => ["detach", device]),
      );
    }
  }
});

test("malformed successful attach output uses the same exact recovery matrix", async () => {
  const imagePath = "/fixture/fixture.sparseimage";
  for (const after of [[], ["/dev/disk5"], ["/dev/disk5", "/dev/disk6"]]) {
    const calls = [];
    let inventoryReads = 0;
    const execute = async (_provider, arguments_) => {
      calls.push(arguments_);
      if (arguments_[0] === "attach")
        return { signal: null, status: 0, stderr: "", stdout: "<plist/>" };
      if (arguments_[0] === "info") {
        inventoryReads += 1;
        return {
          signal: null,
          status: 0,
          stderr: "",
          stdout: devicePlist(inventoryReads === 1 ? [{ devices: after, imagePath }] : []),
        };
      }
      return { signal: null, status: 0, stderr: "", stdout: "" };
    };
    await assert.rejects(
      attachQuotaVolumeWithRecovery(
        {},
        ["attach", "fixture.sparseimage"],
        "/fixture",
        new Map(),
        imagePath,
        execute,
      ),
      /device identity|no recoverable device/u,
    );
    assert.deepEqual(
      calls.filter(([operation]) => operation === "detach"),
      after.map((device) => ["detach", device]),
    );
  }
});

test("successful attach binds every exact image device and rejects partial output identity", async () => {
  const imagePath = "/fixture/fixture.sparseimage";
  const devices = ["/dev/disk5", "/dev/disk6"];
  const execute = async (_provider, arguments_) => {
    if (arguments_[0] === "attach")
      return {
        signal: null,
        status: 0,
        stderr: "",
        stdout: devicePlist([
          { devices: ["/dev/disk5", "/dev/disk5s1", "/dev/disk6s1"], imagePath },
        ]),
      };
    if (arguments_[0] === "info")
      return {
        signal: null,
        status: 0,
        stderr: "",
        stdout: devicePlist([{ devices, imagePath }]),
      };
    return { signal: null, status: 0, stderr: "", stdout: "" };
  };
  assert.deepEqual(
    await attachQuotaVolumeWithRecovery(
      {},
      ["attach", imagePath],
      "/fixture",
      new Map(),
      imagePath,
      execute,
    ),
    devices,
  );
  assert.deepEqual(
    parseHdiutilDeviceIdentities(
      "<key>dev-entry</key><string>/dev/disk5</string><key>dev-entry</key><string>/dev/disk5s1</string><key>dev-entry</key><string>/dev/disk6s2</string>",
    ),
    devices,
  );
});

test("multi-device detach attempts every issued device before reporting quarantine", async () => {
  const calls = [];
  await assert.rejects(
    detachIssuedDevices(
      {},
      {
        devices: ["/dev/disk41", "/dev/disk42"],
        imagePath: "/tmp/fixture/quota.sparseimage",
        workRoot: "/tmp/fixture",
      },
      async (_provider, arguments_) => {
        calls.push(arguments_);
        if (arguments_[0] === "info")
          return {
            signal: null,
            status: 0,
            stderr: "",
            stdout: devicePlist([
              {
                devices: ["/dev/disk41", "/dev/disk42"],
                imagePath: "/tmp/fixture/quota.sparseimage",
              },
            ]),
          };
        if (arguments_[1] === "/dev/disk41") throw new Error("first detach failed");
        return { signal: null, status: 0, stderr: "", stdout: "" };
      },
    ),
    /one or more exact issued quota devices/u,
  );
  assert.deepEqual(calls.slice(1), [
    ["detach", "/dev/disk41"],
    ["detach", "/dev/disk42"],
  ]);
});

test("detach accepts a disappeared issued device only after detached postflight", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "quota-disappeared-device-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const mountRoot = path.join(root, "mount");
  await mkdir(mountRoot);
  const metadata = await stat(mountRoot);
  const calls = [];
  await detachIssuedDevices(
    {},
    {
      devices: ["/dev/disk41"],
      hostMount: { device: String(metadata.dev), inode: String(metadata.ino) },
      imagePath: path.join(root, "quota.sparseimage"),
      mount: { path: mountRoot },
      workRoot: root,
    },
    async (_provider, arguments_) => {
      calls.push(arguments_);
      return { signal: null, status: 0, stderr: "", stdout: "<plist><array/></plist>" };
    },
  );
  assert.deepEqual(calls, [
    ["info", "-plist"],
    ["info", "-plist"],
  ]);
});

test("detach accepts a raced disappearance only after detached postflight", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "quota-raced-device-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const mountRoot = path.join(root, "mount");
  await mkdir(mountRoot);
  const metadata = await stat(mountRoot);
  let inventoryReads = 0;
  const calls = [];
  await detachIssuedDevices(
    {},
    {
      devices: ["/dev/disk41"],
      hostMount: { device: String(metadata.dev), inode: String(metadata.ino) },
      imagePath: path.join(root, "quota.sparseimage"),
      mount: { path: mountRoot },
      workRoot: root,
    },
    async (_provider, arguments_) => {
      calls.push(arguments_);
      if (arguments_[0] === "detach") throw new Error("device disappeared before detach");
      inventoryReads += 1;
      return {
        signal: null,
        status: 0,
        stderr: "",
        stdout: devicePlist(
          inventoryReads === 1
            ? [{ devices: ["/dev/disk41"], imagePath: path.join(root, "quota.sparseimage") }]
            : [],
        ),
      };
    },
  );
  assert.deepEqual(calls, [
    ["info", "-plist"],
    ["detach", "/dev/disk41"],
    ["info", "-plist"],
  ]);
});

test("attachment recovery cleans exact devices but never detaches a concurrent foreign image", async () => {
  const imagePath = "/fixture/fixture.sparseimage";
  const calls = [];
  const execute = async (_provider, arguments_) => {
    calls.push(arguments_);
    if (arguments_[0] === "attach") throw new Error("wrapper failed");
    if (arguments_[0] === "info")
      return {
        signal: null,
        status: 0,
        stderr: "",
        stdout: devicePlist([
          { devices: ["/dev/disk7"], imagePath },
          { devices: ["/dev/disk8"], imagePath: "/fixture/foreign.sparseimage" },
        ]),
      };
    return { signal: null, status: 0, stderr: "", stdout: "" };
  };
  await assert.rejects(
    attachQuotaVolumeWithRecovery(
      {},
      ["attach", imagePath],
      "/fixture",
      new Map(),
      imagePath,
      execute,
    ),
    (error) => {
      const messages = [];
      const collect = (value) => {
        messages.push(value.message);
        if (value instanceof AggregateError) value.errors.forEach(collect);
      };
      collect(error);
      return (
        error instanceof AggregateError &&
        error.issuedDevices?.includes("/dev/disk7") === true &&
        error.cause?.message === "wrapper failed" &&
        messages.some((message) => message.includes("concurrent unbound devices"))
      );
    },
  );
  assert.deepEqual(
    calls.filter(([operation]) => operation === "detach"),
    [["detach", "/dev/disk7"]],
  );
});

test("attachment recovery preserves wrapper, inventory, and detach failures", async () => {
  for (const failedOperation of ["info", "detach"]) {
    const execute = async (_provider, arguments_) => {
      if (arguments_[0] === "attach") throw new Error("wrapper failed");
      if (arguments_[0] === failedOperation) throw new Error(`${failedOperation} failed`);
      return {
        signal: null,
        status: 0,
        stderr: "",
        stdout: devicePlist([
          { devices: ["/dev/disk7", "/dev/disk7s1"], imagePath: "/fixture/fixture.sparseimage" },
        ]),
      };
    };
    await assert.rejects(
      attachQuotaVolumeWithRecovery(
        {},
        ["attach", "fixture.sparseimage"],
        "/fixture",
        new Map(),
        "/fixture/fixture.sparseimage",
        execute,
      ),
      (error) => {
        const messages = [];
        const collect = (value) => {
          messages.push(value.message);
          if (value instanceof AggregateError) value.errors.forEach(collect);
        };
        collect(error);
        return (
          messages.includes("wrapper failed") &&
          messages.includes(`${failedOperation} failed`) &&
          (failedOperation !== "detach" ||
            (error.safeToRemoveImage === false &&
              error.retainedDevices?.includes("/dev/disk7") === true))
        );
      },
    );
  }
});

test("detach postflight quarantines an image when inventory still binds a device", async () => {
  const imagePath = "/fixture/fixture.sparseimage";
  await assert.rejects(
    attachQuotaVolumeWithRecovery(
      {},
      ["attach", "fixture.sparseimage"],
      "/fixture",
      new Map(),
      imagePath,
      async (_provider, arguments_) => {
        if (arguments_[0] === "attach") throw new Error("wrapper failed");
        if (arguments_[0] === "info")
          return {
            signal: null,
            status: 0,
            stderr: "",
            stdout: devicePlist([{ devices: ["/dev/disk7"], imagePath }]),
          };
        return { signal: null, status: 0, stderr: "", stdout: "" };
      },
    ),
    (error) =>
      error.safeToRemoveImage === false &&
      error.retainedDevices?.includes("/dev/disk7") === true &&
      aggregateMessages(error).some((message) => message.includes("detach postflight")),
  );
});

test("detach postflight treats an unreadable inventory as quarantine uncertainty", async () => {
  const imagePath = "/fixture/fixture.sparseimage";
  let inventoryReads = 0;
  await assert.rejects(
    attachQuotaVolumeWithRecovery(
      {},
      ["attach", "fixture.sparseimage"],
      "/fixture",
      new Map(),
      imagePath,
      async (_provider, arguments_) => {
        if (arguments_[0] === "attach") throw new Error("wrapper failed");
        if (arguments_[0] === "info") {
          inventoryReads += 1;
          if (inventoryReads > 1) throw new Error("postflight inventory failed");
          return {
            signal: null,
            status: 0,
            stderr: "",
            stdout: devicePlist([{ devices: ["/dev/disk7"], imagePath }]),
          };
        }
        return { signal: null, status: 0, stderr: "", stdout: "" };
      },
    ),
    (error) =>
      error.safeToRemoveImage === false &&
      aggregateMessages(error).some((message) => message.includes("could not prove")),
  );
});

test("cleanup quarantines a host-restored image that remains attached", async (t) => {
  const { imagePath, state } = await cleanupFixture(t, false);
  const calls = [];
  await assert.rejects(
    cleanupQuotaVolume({}, state, async (_provider, arguments_) => {
      calls.push(arguments_);
      return {
        signal: null,
        status: 0,
        stderr: "",
        stdout: devicePlist([{ devices: ["/dev/disk7"], imagePath }]),
      };
    }),
    (error) =>
      error.safeToRemoveImage === false && error.retainedDevices?.includes("/dev/disk7") === true,
  );
  assert.deepEqual(calls, [["info", "-plist"]]);
  assert.equal((await stat(imagePath)).isFile(), true);
});

test("cleanup final inventory catches reattachment after successful detach postflight", async (t) => {
  const { imagePath, state } = await cleanupFixture(t, true);
  const calls = [];
  let inventoryReads = 0;
  await assert.rejects(
    cleanupQuotaVolume({}, state, async (_provider, arguments_) => {
      calls.push(arguments_);
      if (arguments_[0] === "detach") return { signal: null, status: 0, stderr: "", stdout: "" };
      inventoryReads += 1;
      return {
        signal: null,
        status: 0,
        stderr: "",
        stdout: devicePlist(inventoryReads === 2 ? [] : [{ devices: ["/dev/disk7"], imagePath }]),
      };
    }),
    (error) =>
      error.safeToRemoveImage === false && error.retainedDevices?.includes("/dev/disk7") === true,
  );
  assert.deepEqual(calls, [
    ["info", "-plist"],
    ["detach", "/dev/disk7"],
    ["info", "-plist"],
    ["info", "-plist"],
  ]);
  assert.equal((await stat(imagePath)).isFile(), true);
});

test("provisioning wrapper failure routes devices-empty image unlink through final inventory", async (t) => {
  if (process.platform !== "darwin") return;
  const hdiutilBytes = await readFile("/usr/bin/hdiutil");
  for (const finalInventoryFails of [false, true]) {
    const workRoot = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "k03-quota-provision-failure-")),
    );
    t.after(() => rm(workRoot, { force: true, recursive: true }));
    const imagePath = path.join(workRoot, "quota-1.sparseimage");
    let inventoryReads = 0;
    const provider = {
      command: async (_executable, arguments_) => {
        if (arguments_[0] === "create") {
          assert.equal(arguments_[arguments_.indexOf("-size") + 1], "393344b");
          await writeFile(imagePath, "fixture image\n", { mode: 0o600 });
          return { signal: null, status: 0, stderr: "", stdout: "" };
        }
        if (arguments_[0] === "attach") throw new Error("attach wrapper failed");
        if (arguments_[0] === "info") {
          inventoryReads += 1;
          assert.equal((await stat(imagePath)).isFile(), true);
          if (finalInventoryFails && inventoryReads === 4)
            throw new Error("mandatory final inventory failed");
          return { signal: null, status: 0, stderr: "", stdout: devicePlist([]) };
        }
        throw new Error(`unexpected hdiutil operation: ${arguments_[0]}`);
      },
      environment: { HOME: workRoot, LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
      hdiutil: {
        path: "/usr/bin/hdiutil",
        sha256: createHash("sha256").update(hdiutilBytes).digest("hex"),
        version: "fixture",
      },
    };
    await assert.rejects(
      provisionQuotaVolume(provider, {
        logicalBudgetBytes: 64 * 1024,
        repositoryId: "1",
        workRoot,
      }),
      finalInventoryFails ? /final image-unlink proof was uncertain/u : /feature-unavailable/u,
    );
    assert.equal(inventoryReads, 4);
    if (finalInventoryFails) assert.equal((await stat(imagePath)).isFile(), true);
    else await assert.rejects(stat(imagePath), /ENOENT/u);
  }
});

test("quota provider requires exact hdiutil and unambiguous attached device identity", () => {
  assert.throws(
    () =>
      createDarwinQuotaVolumeProvider({
        command: async () => {},
        environment: {},
        hdiutil: { path: "/tmp/hdiutil", sha256: "1".repeat(64), version: "fixture" },
      }),
    /feature-unavailable outside Darwin|exact reviewed \/usr\/bin\/hdiutil/,
  );
  assert.equal(
    parseHdiutilDeviceIdentity(
      "<plist><dict><key>dev-entry</key><string>/dev/disk12s1</string></dict></plist>",
    ),
    "/dev/disk12",
  );
  assert.throws(() => parseHdiutilDeviceIdentity("<plist/>"), /device identity/);
});
