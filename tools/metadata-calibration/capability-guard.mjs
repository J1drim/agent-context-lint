import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";

let attempted = false;
const denied = () => {
  attempted = true;
  throw new Error("calibration scan attempted a denied host capability");
};

for (const key of ["exec", "execFile", "execFileSync", "execSync", "fork", "spawn", "spawnSync"])
  childProcess[key] = denied;
net.Socket.prototype.connect = denied;
syncBuiltinESMExports();

process.on("exit", () => {
  if (!attempted) return;
  process.stderr.write("calibration scan attempted a denied host capability\n");
  process.exitCode = 2;
});
