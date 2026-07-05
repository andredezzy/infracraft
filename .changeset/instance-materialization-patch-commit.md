---
"@infracraft/pulumi": patch
---

Instance materialization for NAMED environments: `environmentUnskipService` is rejected outside PR environments ("Can only unskip services in PR environments", proven live), so ensureServiceInstance now commits a staged config patch keying the service in `services` — the documented path — and still re-verifies the instance exists afterward.
