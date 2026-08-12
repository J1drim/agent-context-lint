# Bounded resolution security

E10 is an internal TB-03 orchestration boundary. It adds scheduling, not filesystem, network,
process, environment, model, persistence, or write authority. Repository and configuration data can
describe a target but cannot become executable task code.

## Threats and controls

| Threat | Control |
| --- | --- |
| Eager promise creation defeats backpressure | Workers claim one task at a time; only the configured number of executors can be active |
| Completion timing changes output | Canonical UTF-8 sort occurs before scheduling; output excludes worker/timing/concurrency state |
| Duplicate target work creates ambiguous results | Duplicate task IDs and duplicate full profile/version/surface/specification/target relationships fail before execution |
| Serialized or forged task invokes a capability | Same-process issued-task `WeakSet` plus private executor `WeakMap`; callbacks never enter data output |
| Callback returns a forged or cross-target result | Same-process E05 issuance and exact profile/version/surface/specification/target relationship check |
| Repository content injects executable work | Task executors are explicit trusted application functions; docs prohibit construction from repository/configuration/standards/plug-in data |
| Task throw leaks source, path, or secret detail | Fixed scheduler errors discard callback exceptions and cancellation reasons |
| Cancellation leaves queued work running | Private native signal is aborted and no further queue item is admitted |
| Nonsettling task holds the scheduler forever | Whole-batch deadline settles E10 and signals active executors; E11 owns end-to-end handle cleanup |
| Task/result flood exhausts memory or descriptors | Hard concurrency, duration, task, identifier, per-result, and aggregate-result ceilings |
| Hostile JavaScript containers invoke getters/traps | Closed descriptor reads, proxy/accessor/sparse/extended-array rejection, native signal-brand check |
| Concurrent cache access changes authority | E09 remains exact-key optimization only; E10 independently validates every returned E05 object |
| Parallel read crosses repository jail | Executors must use C02; each active task needs an independent facade because one facade is sequential |

Result byte accounting happens immediately after an executor returns and before E10 retains its
resolution. Crossing a per-result or aggregate ceiling aborts the private signal, stops admission,
and returns only a fixed resource-limit error. An executor can still allocate memory within its own
trusted capability before returning; its owner must apply upstream C02/profile/import limits.

The scheduler does not assert that two profile results are equivalent and does not reinterpret E05
ordering. Byte identity across concurrency settings means only that scheduling did not alter the
same deterministic inputs and resolver semantics.
