---
"@infracraft/pulumi": minor
---

Zero-ceremony CLI/SDK version guard (release carrier).

The 2.4.0 changelog entry for this content never reached npm — a history
rewrite raced the version commit and the publish was skipped against the
already-published 2.4.0. This release actually ships it: every provider
constructor runs the memoized `ensurePulumiVersionMatch()` (active only
under a real Pulumi run via the engine env marker; best-effort when the
CLI/SDK can't be resolved; a resolved major.minor mismatch throws), and
all example names in docs, comments, and fixtures are neutral.
