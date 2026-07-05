---
"@infracraft/pulumi": minor
---

Provider-canon alignment across Railway, Neon, Vercel, and Fly:

- **Idempotent deletes.** `delete()` now tolerates an already-gone resource everywhere. Notably, `RailwayProjectToken.delete()` no longer throws when the token was already revoked — during a `tokenVersion` rotation, `create()`'s stale-name cleanup revokes the engine-tracked old token first, and the old behavior stranded a pending-delete tombstone in state that failed every subsequent `up`. The next `up` now self-heals.
- **One resilient transport.** All provider HTTP goes through `resilientFetch`: per-attempt 15s timeout, bounded retries (3 attempts) on network errors/5xx/429, numeric `Retry-After` support (capped at 30s), exponential backoff otherwise.
- **`VercelClient`.** New REST client (mirroring `NeonClient`) replaces the 18 raw fetch call sites in the Vercel resources; it appends `teamId` to every request and rides the resilient transport.
- **Typed 404s.** Neon, Fly, and Vercel clients throw `ApiNotFoundError` on 404, and catch sites test `instanceof` instead of matching messages.
- **Reads reconcile drift.** Every dynamic-provider `read()` returns a blank `ReadResult` when the remote resource is gone, so `pulumi refresh` reconciles out-of-band deletions instead of failing (write-once secrets and env-var batches stay deliberate pass-throughs).
- **Credentials marked secret in state.** Every resource wrapper adds its provider credential (`token`/`apiKey`) to `additionalSecretOutputs`, alongside existing entries like `password` and the minted project-token `value`.
- **README** gains a "Design principles" section documenting the above canon.
