# @infracraft/pulumi

## 1.31.0

### Minor Changes

- 3bc4078: VercelDeploy gains `variables` — deploy-integrated env vars that replace the dynamic-resource path. `VercelVariable` hits a Pulumi engine-internal stateful bug on clean-slate first creates ("Unexpected struct type", strictly alternating pass/fail across identical from-zero runs, reproduced with plain-literal inputs — zero Outputs or secrets — on matched CLI/SDK versions; four structural theories falsified by bisection), so no input shape avoids it and the fix is architectural: `VercelDeploy.variables` upserts each var (production + preview + development, with the exact ENV_CONFLICT update-in-place semantics `VercelVariable` uses, now shared via `env-var-api`) through a standalone applier bin that the deploy command runs right before `vercel deploy` — the same pattern as the Railway deployment monitor owning imperative deploy steps — off the dynamic-provider marshal path entirely. The key→value payload rides the command environment as a masked secret (`IC_VC_ENV_JSON`), a non-secret digest of the variables joins the command triggers so any change redeploys, and the applier logs names only and fails the deploy loudly on the first failed key. `VercelVariable` stays exported for existing stacks but is deprecated in docs — prefer `VercelDeploy.variables`.

## 1.30.3

### Patch Changes

- 07ae910: Railway rejects any healthcheckPath containing a hyphen with a bare "Invalid input" (undocumented — isolated by a live probe matrix: "/" and every hyphen-free variant succeed, every hyphenated value fails, regardless of deploy state, auth path, or timeout pairing). RailwayService.check() now fails hyphenated paths at plan time with the full explanation instead of letting the API landmine fire mid-deploy.

## 1.30.2

### Patch Changes

- 9339f2a: NeonClient waits out the project-operations lock: Neon runs mutations as async operations and answers 423 while earlier ones settle (its docs prescribe waiting for completion) — a destroy immediately followed by an up hit this deterministically. Requests now probe every 5s for up to ~2 minutes before failing loudly, so a from-zero cycle one-shots instead of tripping on Neon's own cleanup.

## 1.30.1

### Patch Changes

- 3ff8dd9: Fix the deterministic "Unexpected struct type" on VercelVariable: its undefined output placeholders (envIds, contentHash) next to an Output-valued variables map failed engine serialization on every create/update. The placeholders are gone — both values are state-only bookkeeping nothing consumed as Outputs (the unused contentHash output was removed from the component).

## 1.30.0

### Minor Changes

- 495af2e: Zero-fails wave: kill the two failure classes standing between a from-zero `pulumi up` and zero errors / zero retries.

  **Env-var-first provider credentials.** Every provider (`RailwayProvider`, `NeonProvider`, `VercelProvider`, `FlyProvider`) now accepts `tokenEnvVar` (Neon: `apiKeyEnvVar`) — the NAME of an environment variable holding the credential — as a mutually exclusive alternative to `token` / `apiKey` (the constructor throws unless exactly one is set). Resources carry only the plain variable name; every dynamic-provider operation resolves the value from the environment at execution time and fails loudly, naming the variable, when it is unset. This removes the secret credential from dynamic-resource inputs and per-resource state entirely — the substrate for pulumi/pulumi#16041 ("Unexpected struct type": secret Outputs in dynamic-provider inputs intermittently fail engine serialization). Dynamic-provider operations run in the Pulumi CLI's plugin process, which inherits the program's environment, so ESC-provided `environmentVariables` reach them. `VercelDeploy` / `FlyDeploy` (command env) and `VercelProject.url` resolve the env var at program runtime into a secret Output instead. The `token` / `apiKey` path keeps working unchanged, including its `additionalSecretOutputs` state marking.

  **Healthcheck config is never silently dropped.** Railway rejects healthcheck fields on a fresh service instance with no deployment (`serviceInstanceUpdate`: "Invalid input"); previously the retry dropped them forever. `RailwayService` still applies them on the first attempt (steady state stays one call), reports a drop, and for image services re-applies ONLY the healthcheck fields after its own `serviceInstanceDeployV2` — throwing loudly if that also fails. For code services, `RailwayDeploy` gains `healthcheckPath` / `healthcheckTimeout` args wired to the deploy monitor via `IC_HC_PATH` / `IC_HC_TIMEOUT`; on reaching a live status the monitor applies them via `serviceInstanceUpdate` (with retries for transient blips) and fails the deploy loudly if the update keeps erroring.

## 1.29.2

### Patch Changes

- e053e03: Guard the deploymentUrl derivation against undefined command stdout (command errored before emitting output) — a real failure was being masked by a TypeError on trim.

## 1.29.1

### Patch Changes

- a88abe6: Instance materialization for NAMED environments: `environmentUnskipService` is rejected outside PR environments ("Can only unskip services in PR environments", proven live), so ensureServiceInstance now commits a staged config patch keying the service in `services` — the documented path — and still re-verifies the instance exists afterward.

## 1.29.0

### Minor Changes

- 313452b: RailwayService now guarantees a service instance exists in its target environment before configuring or deploying. `serviceCreate` materializes an instance only in the environment passed at create time — everywhere else the service is "skipped": `serviceInstanceUpdate` returns true as a silent no-op and `railway up` fails with UPLOAD_FAILED 404 (live incident: first-ever mesh deploy to production). The provider now probes `serviceInstance` and calls `environmentUnskipService` when missing, re-verifying afterward (loud error instead of a fourth silent no-op). Also: `ApiNotFoundError` is exported from the neon/vercel/fly subpaths for instanceof catching, README/API docs fully synced, and stale JSDoc corrected (VercelProject deletion really deletes — protect precious projects).

## 1.28.1

### Patch Changes

- 9cb95ff: Fix: a failed `railway up` no longer dies silently. The deploy script runs under `set -e`, and the bare `IC_UP_OUT=$(railway up …); IC_UP_EXIT=$?` capture died AT THE ASSIGNMENT on a non-zero exit — before the exit code was saved and before the output was re-emitted, leaving zero diagnostics (live production incident). The capture is now if/else-guarded so the CLI's real output always surfaces and the monitor still owns pass/fail.

## 1.28.0

### Minor Changes

- 50edf13: CRITICAL: RailwayVolume adoption is now environment-scoped. Volume lookup matched by serviceId alone, and services are project-level — so a new stack adopted a SIBLING environment's volume (production adopted staging's, risking data mixing or running without persistence). A volume instance must now match BOTH serviceId and environmentId; a stack whose environment has no instance creates its own volume and triggers the attach deploy.

### Patch Changes

- 50edf13: DX-hardening wave — preflight doctor, awk filter input validation, provider test coverage:

  - **Preflight doctor.** New `assertHostBinaries(binaries)` (exported from `@infracraft/sandbox` and re-exported via `@infracraft/pulumi/sandbox`) checks every listed binary against the host PATH via POSIX `command -v` and throws a single error naming ALL missing binaries with a friendly install hint for each known one (git, rsync, awk, mktemp, node, railway, vercel, fly). `prepareSandboxWorkspace()` now asserts the core POSIX set (git, rsync, awk, mktemp) before creating the workspace, so a broken host fails fast instead of midway through a deploy script; `FlyDeploy`/`VercelDeploy` document it as the recommended preflight for their CLIs.
  - **awk filter input validation.** `buildSandboxFileFilter` now rejects an `excludePaths` entry containing a single quote or a newline with a clear error — such an entry would break out of the single-quoted awk program (`escapeAwkRegex` escapes ERE metacharacters only), and paths like that are pathological, not a real use case.
  - **Test-coverage wave.** Unit tests for the Fly provider lifecycle (`FlyApp`, `FlySecret`, `FlyCertificate`, `FlyIp`, plus `FlyVolume` create paths) and for batch variable upserts on both platforms (`RailwayVariable`, `VercelVariable`): adopt-vs-create, read/refresh drift behavior as implemented, delete idempotence, and diff replace keys.

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
