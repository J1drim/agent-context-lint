# Understanding efficiency recommendations

An efficiency recommendation is a measured static counterfactual, not generic advice. The linter
shows the profiles and sampled paths affected, baseline and projected tokens, the estimated saving,
the evidence used, retention status, confidence, and compatibility caveats.

`recommended` means the proposed in-memory layout passed the linter's mechanical checks:

- it came from measured broad-scope or exact-duplicate evidence;
- all affected sampled profile/target pairs were checked;
- the ordinary effective-context resolver was run before and after;
- intended scope targets kept a byte-identical context, or duplicate consolidation retained every
  unique effective content identity; and
- the projected saving was positive and used the same tokenizer/configuration identities.

`indeterminate` means required text, token, import, resolution, or baseline evidence was
unavailable. `not-recommended` means a proof failed, the candidate did not save context, its
evidence did not match, or it omitted an affected target.

These results do **not** prove equivalent task quality, semantic equivalence, agent compliance, or
that removed content was unnecessary. Saving-target usefulness needs human review, and this release
makes no task-quality claim. Only exact duplicate removal and unambiguous scope fixes may later
become v1 automatic fixes, and those still use previewed atomic fix controls.

Use the profile, surface, client/spec snapshot, tokenizer, score version, configuration digest, and
before/after hashes when comparing reports. Different identities are not silently normalized.
