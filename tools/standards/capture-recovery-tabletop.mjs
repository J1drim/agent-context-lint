import { open, rename, rm } from "node:fs/promises";
import path from "node:path";

import {
  canonicalJson,
  captureExecutionReceipt,
  executionReceiptPath,
  validateExecutionReceipt,
} from "./recovery-tabletop-receipt.mjs";

if (process.argv.length !== 3 || process.argv[2] !== "--acknowledge-execution") {
  throw new Error(
    "usage: node tools/standards/capture-recovery-tabletop.mjs --acknowledge-execution",
  );
}

const receipt = await captureExecutionReceipt();
const validation = validateExecutionReceipt(receipt);
if (!validation.schemaValid || validation.issues.length !== 0)
  throw new Error(`generated H13 receipt failed validation: ${validation.issues.join("; ")}`);

const temporaryPath = path.join(
  path.dirname(executionReceiptPath),
  `.recovery-tabletop-execution.${String(process.pid)}.tmp`,
);
let committed = false;
try {
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    const canonicalReceipt = JSON.parse(canonicalJson(receipt));
    await handle.writeFile(`${JSON.stringify(canonicalReceipt, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporaryPath, executionReceiptPath);
  committed = true;
} finally {
  if (!committed) await rm(temporaryPath, { force: true });
}
process.stdout.write(
  `Generated ${path.basename(executionReceiptPath)} from actual command outcomes.\n`,
);
