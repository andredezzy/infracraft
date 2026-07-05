---
"@infracraft/pulumi": patch
---

Guard the deploymentUrl derivation against undefined command stdout (command errored before emitting output) — a real failure was being masked by a TypeError on trim.
