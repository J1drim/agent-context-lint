import assert from "node:assert/strict";
import test from "node:test";

import { verifySemanticQuotaRelation } from "./native-live-verifier.mjs";

function quota(overrides = {}) {
  return {
    allocatedResourceCeilingBytes: 134_217_728,
    blockCount: 32_768,
    blockSize: 4096,
    contractVersion: "0.1.0",
    filesystemName: "apfs",
    filesystemType: "17",
    hdiutil: { path: "/usr/bin/hdiutil", sha256: "1".repeat(64), version: "fixture" },
    logicalBudgetBytes: 67_108_864,
    oversizeFastCopyRejected: true,
    recordKind: "agent-context-k03-native-quota-proof",
    reserveBytes: 67_108_864,
    sourcePolicy: { localPaths: false },
    ...overrides,
  };
}

test("live quota comparison permits only documented one-block geometry variance", () => {
  const expected = quota();
  assert.doesNotThrow(() => verifySemanticQuotaRelation(quota(), expected));
  assert.doesNotThrow(() =>
    verifySemanticQuotaRelation(quota({ blockCount: expected.blockCount + 1 }), expected),
  );
  assert.throws(
    () => verifySemanticQuotaRelation(quota({ blockCount: expected.blockCount + 2 }), expected),
    /one-block tolerance/u,
  );
  assert.throws(
    () =>
      verifySemanticQuotaRelation(
        quota({ blockCount: expected.blockCount / 2, blockSize: expected.blockSize * 2 }),
        expected,
      ),
    /semantic identity/u,
  );
  assert.throws(
    () => verifySemanticQuotaRelation(quota({ logicalBudgetBytes: 1 }), expected),
    /semantic identity/u,
  );
});
