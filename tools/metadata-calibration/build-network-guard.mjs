import dgram from "node:dgram";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import tls from "node:tls";

const denied = () => {
  throw new Error("K03 source replay attempted a denied network capability");
};
const DeniedNetworkConstructor = class DeniedNetworkConstructor {
  constructor() {
    denied();
  }
};

const rejectDetached = (original) =>
  function reviewedChildProcess(...arguments_) {
    if (
      arguments_.some(
        (value) => value !== null && !Array.isArray(value) && value?.detached === true,
      )
    )
      throw new Error("K03 source replay attempted to detach a child process");
    return Reflect.apply(original, this, arguments_);
  };

for (const key of ["execFile", "execFileSync", "fork", "spawn", "spawnSync"])
  childProcess[key] = rejectDetached(childProcess[key]);

for (const [target, keys] of [
  [dgram, ["createSocket"]],
  [dns, ["lookup", "lookupService", "resolve", "resolve4", "resolve6", "resolveAny"]],
  [http, ["get", "request"]],
  [https, ["get", "request"]],
  [net, ["connect", "createConnection", "createServer"]],
  [tls, ["connect", "createServer"]],
]) {
  for (const key of keys) target[key] = denied;
}
net.Socket.prototype.connect = denied;

for (const [key, replacement] of [
  ["fetch", denied],
  ["WebSocket", DeniedNetworkConstructor],
  ["EventSource", DeniedNetworkConstructor],
]) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
  if (descriptor === undefined) continue;
  if (
    !Reflect.defineProperty(globalThis, key, {
      configurable: descriptor.configurable,
      enumerable: descriptor.enumerable,
      value: replacement,
      writable: false,
    })
  )
    throw new Error(`unable to deny K03 source replay global: ${key}`);
}

syncBuiltinESMExports();
