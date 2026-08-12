# Standards freshness rule API

F13 exposes `evaluateStandardsFreshnessRules` and `finalizeStandardsFreshnessSuppressions` from
`@agent-context/rules`. The evaluator implements ACL500–ACL506 and accepts the closed in-memory
record `agent-context-standards-freshness-rule-input` at contract version `0.1.0`.

The input combines a validated B03 IR, one repository source used as the anchor for repository-wide
findings, an H06 `OfflineStandardsStatusRequest`, explicit H09 results, execution policy, and
bounded deprecation observations. Evaluation calls `createOfflineStandardsStatus`; callers do not
provide a precomputed status report. That keeps lock parsing, fixed-time age calculations, bundled
authority, and cached observation semantics owned by H06.

## Observation authority

| Input state                               | Meaning                                                          | Findings it may support                                         |
| ----------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------- |
| H06 bundled artifact                      | authenticated data shipped with this installation                | selected-spec binding and offline status                        |
| H06 locked artifact                       | lock visible to H06; active only when H06 authenticates it       | ACL500, ACL502, ACL503, ACL504, ACL505                          |
| H06 `untrusted-offline-cache` observation | historical observation only as of `checkedAt`                    | cached, explicitly labeled ACL501; ACL502 compatibility warning |
| successful H09 stable result              | explicit signed update check completed by trusted orchestration  | verified-live ACL501 and ACL502                                 |
| successful H09 preview result             | explicit signed preview check completed by trusted orchestration | ACL502 and ACL506                                               |
| failed H09 result                         | bounded update failure evidence                                  | ACL503 only for the enumerated trust/integrity failures         |

`liveUpdates` is an orchestration boundary, not repository configuration. The CLI must populate it
only from the result of the explicit H09 check/update operation in the same trusted control flow.
Repository files, cache files, environment variables, and deserialized lint configuration must never
be permitted to construct this field. The evaluator validates the complete portable H09 plan shape
and signer/channel binding, but a plain data plan has no process-local authenticity brand.

A newer cached stable version can produce ACL501 because the registry was observed previously, but
the message, related-evidence collector, and semantic fingerprint all retain the `cached-offline`
origin and check time. It never says that the registry is currently fresh. When a successful live
stable observation is present, it is the sole ACL501 source; cached state remains available in the
returned H06 status and metrics.

## Rule decisions

- ACL500 requires a parsed locked artifact whose H06 age is `stale`; bundled age alone does not
  satisfy the rule.
- ACL501 requires either a newer successful stable H09 candidate or H06 `update-available` cached
  metadata. Network/check failures do not imply an update.
- ACL502 reports H06 locked/cached incompatibility and successful H09 candidates whose minimum
  engine exceeds the request engine under exact SemVer ordering.
- ACL503 reports invalid or unauthenticated locks and enumerated H09 digest, signature, replay,
  rollback, root-continuity, and binding failures. DNS, timeout, cancellation, and other acquisition
  failures are not trust failures.
- ACL504 requires source-exact syntax evidence bound to the digest, version, and origin of the H06
  selected artifact. The deprecation must be effective by the fixed H06 `asOf` date.
- ACL505 requires `environment: "ci"` and an absent lockfile (`null`). An invalid present lock is
  ACL503, not “missing.”
- ACL506 requires a successful preview H09 plan with changes and `previewEnabled: false`. Cache data
  cannot establish preview availability.

All diagnostics use the B09 registry severity, deterministic B04 fingerprints and related evidence,
and no fix plan. Results are sorted by UTF-8 path, source offset, rule ID, and diagnostic ID. The
evaluator never reads the filesystem, environment, network, or ambient clock and never executes
repository content.

## Suppressions and failures

Call `finalizeStandardsFreshnessSuppressions` only with the exact successful evaluation object. It
combines optional already-valid B04 diagnostics, applies B08 disable-next-line directives over the
complete set, and returns visible and suppressed arrays. Forged evaluation objects, sparse or
oversized arrays, accessors, proxies, unknown fields, malformed H06/H09 data, source-invalid ranges,
and selected-pack binding mismatches fail closed with a bounded rule issue.

Limits are exported as `STANDARDS_FRESHNESS_DEFAULT_LIMITS`: at most two channel-unique live
observations and 1,024 deprecation observations. B04's aggregate diagnostic limit remains the final
output ceiling.
