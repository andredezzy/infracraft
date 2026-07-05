---
"@infracraft/pulumi": patch
---

NeonClient waits out the project-operations lock: Neon runs mutations as async operations and answers 423 while earlier ones settle (its docs prescribe waiting for completion) — a destroy immediately followed by an up hit this deterministically. Requests now probe every 5s for up to ~2 minutes before failing loudly, so a from-zero cycle one-shots instead of tripping on Neon's own cleanup.
