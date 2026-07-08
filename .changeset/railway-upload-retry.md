---
"@infracraft/pulumi": minor
---

railway.Deploy: retry `railway up` on a transient upload failure ("error sending request for url …/up" — the CLI's request to Railway fails at the transport level, so no deployment is created and the deploy would otherwise fail). Bounded (3 attempts, 5s backoff), and only that error is retried — a flaky post-upload CLI exit is left to the API-authoritative monitor so a deploy that actually started is never re-triggered.
