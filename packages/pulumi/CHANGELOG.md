# @infracraft/pulumi

## 1.27.0

### Minor Changes

- c5c09df: Final canon-alignment wave — preview fidelity, plan-time validation, naming audit:

  - **`stables` for preview fidelity.** `diff()` now declares identity outputs that provably never change on an in-place update (`RailwayService.serviceId`, `RailwayProject.projectId`, `NeonProject.projectId`, `NeonEndpoint.host`, `NeonRole`'s identity fields, `VercelProject.projectId`, `FlyVolume.volumeId`), so dependents keep known values during preview instead of showing phantom replaces — notably a `RailwayVolume` no longer phantom-replaces when its `RailwayService` gets an in-place update. `NeonRole.password` is deliberately not stable: a `passwordVersion` bump rotates it in place and consumers must cascade.
  - **`check()` plan-time validation.** Locally decidable input mistakes now fail at plan time with the offending property named, instead of deep inside an API call with an opaque error: `RailwayVolume.mountPath` must be absolute, `RailwayService.source.image` non-empty, `NeonBranch.name` / `NeonRole.name` / `RailwayProjectToken.name` non-empty, `VercelProject.name` per Vercel's published rule (≤ 100 lowercase letters/digits/`.`/`_`/`-`, no `---`), and `FlyVolume.sizeGb` a positive integer. Preview-unknown inputs are skipped, never failed.
  - **Naming audit doc-links.** Every arg whose name deviates from the platform API field it maps to now documents that field in its JSDoc (e.g. `RailwayEnvironment.source` → `sourceEnvironmentId`, `NeonBranch.parent` → `parent_id`, `NeonEndpoint.minCu` → `autoscaling_limit_min_cu`, `VercelMarketplaceResource.type` → `integrationProductIdOrSlug`, `FlyApp.name` → `app_name`, `FlySecret.secrets` → `values`).

## 1.26.0

### Minor Changes

- cf3734e: Provider-canon alignment across Railway, Neon, Vercel, and Fly:

  - **Idempotent deletes.** `delete()` now tolerates an already-gone resource everywhere. Notably, `RailwayProjectToken.delete()` no longer throws when the token was already revoked — during a `tokenVersion` rotation, `create()`'s stale-name cleanup revokes the engine-tracked old token first, and the old behavior stranded a pending-delete tombstone in state that failed every subsequent `up`. The next `up` now self-heals.
  - **One resilient transport.** All provider HTTP goes through `resilientFetch`: per-attempt 15s timeout, bounded retries (3 attempts) on network errors/5xx/429, numeric `Retry-After` support (capped at 30s), exponential backoff otherwise.
  - **`VercelClient`.** New REST client (mirroring `NeonClient`) replaces the 18 raw fetch call sites in the Vercel resources; it appends `teamId` to every request and rides the resilient transport.
  - **Typed 404s.** Neon, Fly, and Vercel clients throw `ApiNotFoundError` on 404, and catch sites test `instanceof` instead of matching messages.
  - **Reads reconcile drift.** Every dynamic-provider `read()` returns a blank `ReadResult` when the remote resource is gone, so `pulumi refresh` reconciles out-of-band deletions instead of failing (write-once secrets and env-var batches stay deliberate pass-throughs).
  - **Credentials marked secret in state.** Every resource wrapper adds its provider credential (`token`/`apiKey`) to `additionalSecretOutputs`, alongside existing entries like `password` and the minted project-token `value`.
  - **README** gains a "Design principles" section documenting the above canon.

## 1.25.0

### Minor Changes

- e9aebb2: RailwayProjectToken gains a `tokenVersion` rotation handle: bump it and the next `up` mints a fresh token BEFORE revoking the old one (create-before-delete for rotations; identity changes keep delete-first). No more target-replace URN archaeology — the parent ComponentResource has no diffable state of its own, so targeting it was a silent no-op.

## 1.24.0

### Minor Changes

- 3011cbc: NeonRole gains in-place password rotation: bump the new `passwordVersion` input and the next `up` resets the role's password via Neon's reset_password endpoint as an UPDATE — never a replace, which would try to delete the role (Neon refuses for default roles, and it would drop grants for others). Everything consuming `password` (connection strings, env vars, dependent redeploys) cascades automatically.

## 1.23.0

### Minor Changes

- ff9c2e2: RailwayService and RailwayVolume now converge image-sourced services in ANY environment, and a newly attached volume redeploys its service so the mount actually lands (best-effort: skipped with a warning for services with no deployable source yet). Railway configures `ServiceCreateInput.source` only on the default environment's instance; instances in other environments were born with `source: null`, deploy triggers no-op'd silently (`environmentTriggersDeploy` returns success without creating anything for a never-deployed service), and the service's private DNS never registered. The provider now applies `source` per target-environment instance via `serviceInstanceUpdate` and owns the deploy for image services (`serviceInstanceDeployV2`) on both create and update — code-sourced services are untouched (RailwayDeploy remains their deploy path). `startCommand` remains a regular `Input<string>`, so secret-bearing commands (e.g. `redis-server --requirepass …`) belong here rather than in raw command wrappers.

## 1.22.1

### Patch Changes

- ba9e44e: Fix: the deploy-sandbox file filter now keeps the `package.json` of EVERY excluded directory, not just `apps/*` ones. A blanket exclusion of a directory that is also a workspace member (e.g. `infrastructure/`) starved the sandboxed `bun install` of that member's manifest and failed the whole build with `Workspace not found`. A kept manifest for a non-member directory is inert, so the rule is now uniform.

## 1.22.0

### Minor Changes

- d910e03: Security: RailwayDeploy no longer embeds the project token in the deploy command script. pulumi-command includes the executed command verbatim in its failure error, and Pulumi does not scrub secrets from provider diagnostics — so an inlined token printed in plaintext whenever a deploy failed. The token now travels via the command's stdin (`createDeployCommand` gained an optional `stdin` input), which stays out of the script text and remains secret-masked in diffs. Tokens minted before this fix that ever hit a failed deploy should be treated as compromised and rotated.

## 1.21.0

### Minor Changes

- 4b0fa67: RailwayDomain: expose ownership-verification TXT record (verificationTxtName/verificationTxtValue)

## 1.20.0

### Minor Changes

- 0c1e4ba: VercelDomain: dynamic cnameTarget from Vercel domain config (replaces static VERCEL_CNAME_TARGET export)

## 1.19.0

### Minor Changes

- 6809748: RailwayDomain: expose `cnameTarget` (the DNS record to point a custom domain's CNAME at, extracted from Railway's traffic-routing DNS record) — verified multi-domain-safe, since adoption/deletion already scope by exact domain name and domainId respectively.

## 1.18.0

### Minor Changes

- dcb7e4b: Add VercelDomain — attach a custom domain to a Vercel project (adopt-or-create)

### Patch Changes

- dcb7e4b: RailwayService: scope serviceCreate to the target environment (environmentId was omitted, first deploy landed in the default environment)

## 1.17.4

### Patch Changes

- 93b6d30: Docs: reword the sandbox and Git Guard READMEs around deploy isolation — a clean copy of the repo's tracked files instead of the live working tree. The gate deploy log line now reads "stub .git" to match.

## 1.17.3

### Patch Changes

- b2fc0a3: Every published package now ships its own README: sandbox gains one, pulumi's gets its own package identity, and the root README becomes a general overview that points into each package. npm descriptions added/tightened.

## 1.17.2

### Patch Changes

- 00b9131: Sandbox internals moved to `@infracraft/sandbox` and re-exported unchanged from `@infracraft/pulumi/sandbox` — no API change.
