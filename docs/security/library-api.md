# Library API security boundary

E11 is the public trust boundary between an embedded host and the private scan engine.

| Threat                                      | Control                                                                    |
| ------------------------------------------- | -------------------------------------------------------------------------- |
| Repository data forges execution authority  | same-process `WeakSet`/`WeakMap` capability; copies and proxies rejected   |
| Proxy/accessor code executes during parsing | proxies rejected first; closed own-data records and dense arrays required  |
| Completion timing changes observable output | count-only monotonic progress; no task IDs, timestamps, or worker metadata |
| Observer creates unbounded async backlog     | observer is synchronous; returned promises fail closed                     |
| Abort reason or engine error leaks content   | fixed error table; no reflected value or `cause`                           |
| Cancellation leaves work or listeners alive | derived signal; await engine settlement; unconditional listener removal    |
| Engine mutates a returned result later       | validate, canonicalize, parse to detached data, recursively freeze         |
| Import changes host lifecycle                | no I/O, timers, environment access, global handlers, or process exit       |

The scan capability is authority-bearing even though its public record is inert. Keep it in trusted
application composition. Never serialize it, expose it to repository-controlled code, place it in a
knowledge pack, or mint it from a dynamically imported path chosen by configuration. Capability
creation is not the F17 semantic plug-in API.

The facade deliberately accepts only a canonical `file:` root identity. It does not itself open the
path. The engine must enforce C02 root jailing, symlink refusal, resource limits, read-only operation,
and the normal-scan ban on network, models, telemetry, and repository command execution.

Cancellation cannot safely force an arbitrary in-process promise to stop. Therefore the public
promise waits until its trusted executor settles. Engines must close descriptors, terminate owned
workers, clear timers, and remove listeners before rejecting. E10 provides bounded built-in resolver
deadlines; native process isolation is outside this release's API surface.

Tests cover forged and cloned capabilities, callback and record proxies, accessors, hostile URLs and
paths, invalid native-signal lookalikes, observer failures, progress resource attacks, invalid result
graphs, secret-bearing thrown values/reasons, process handler and exit-state changes, listener
balance, and a ref-counted-handle cancellation probe in an embedded child process.
