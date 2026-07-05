---
"@infracraft/pulumi": minor
---

RailwayService now guarantees a service instance exists in its target environment before configuring or deploying. `serviceCreate` materializes an instance only in the environment passed at create time — everywhere else the service is "skipped": `serviceInstanceUpdate` returns true as a silent no-op and `railway up` fails with UPLOAD_FAILED 404 (live incident: first-ever mesh deploy to production). The provider now probes `serviceInstance` and calls `environmentUnskipService` when missing, re-verifying afterward (loud error instead of a fourth silent no-op). Also: `ApiNotFoundError` is exported from the neon/vercel/fly subpaths for instanceof catching, README/API docs fully synced, and stale JSDoc corrected (VercelProject deletion really deletes — protect precious projects).
