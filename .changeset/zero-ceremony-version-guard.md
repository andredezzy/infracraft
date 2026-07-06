---
"@infracraft/pulumi": minor
"@infracraft/sandbox": patch
---

Zero-ceremony CLI/SDK version guard, and neutral example names throughout.

- Every provider constructor (Railway, Vercel, Fly, Neon) now runs the
  memoized `ensurePulumiVersionMatch()` — programs get the CLI/SDK skew
  guard automatically, with no explicit preflight call. The check is
  best-effort when the `pulumi` binary or the SDK cannot be resolved
  (warns and skips); a resolved major.minor mismatch still throws.
  `assertPulumiVersionMatch()` remains exported for earlier placement or
  `WARN` mode.
- Documentation and test fixtures now use neutral example names; dated
  internal design documents were removed from the repository.
