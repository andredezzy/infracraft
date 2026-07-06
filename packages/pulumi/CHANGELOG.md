# @infracraft/pulumi

## 2.7.1

### Patch Changes

- Publish without build-only devDependencies (bundled workspace packages like @infracraft/sandbox are no longer declared in the published package, so they are not falsely counted as depended-upon).

## 2.7.0

### Minor Changes

- d63d326: Adopt the official-provider namespace pattern: every platform-prefixed export loses its prefix inside its own module, so consumers write `import * as railway from "@infracraft/pulumi/railway"` and `new railway.Project(...)` — matching how `@pulumiverse/*` and `@pulumi/*` providers read. Applies to all four modules (`railway`, `neon`, `vercel`, `fly`), including `*Args` types and enums (`railway.Builder`, `fly.IpType`, …). Pulumi type tokens are untouched, so existing stack state is unaffected.

  Migrate by switching each named import to a namespace import and dropping the prefix at use sites: `import { RailwayProject } from "@infracraft/pulumi/railway"` + `new RailwayProject(...)` → `import * as railway from "@infracraft/pulumi/railway"` + `new railway.Project(...)`. When `@pulumiverse/vercel` is imported as `vercel` in the same file, alias this package's module (e.g. `import * as infravercel from "@infracraft/pulumi/vercel"`).

## 2.6.0

### Minor Changes

- e7d3604: Remove the `@infracraft/pulumi/agents` module (`hint()` and `AgentHintChannel`).

  The agent-operating-hint block printed on every `pulumi` run to guide AI
  agents lacking repo context — but the operating rules belong in the
  consuming repo's `AGENTS.md`/`CLAUDE.md`, which every agent already loads,
  and the hint block otherwise diluted the raw Pulumi output it sat in
  (Pulumi even counted it as diagnostics). No replacement; move any stack
  reminders into your repo's agent instructions.

## 2.5.0

### Minor Changes

- b296af7: Zero-ceremony CLI/SDK version guard (release carrier).

  The 2.4.0 changelog entry for this content never reached npm — a history
  rewrite raced the version commit and the publish was skipped against the
  already-published 2.4.0. This release actually ships it: every provider
  constructor runs the memoized `ensurePulumiVersionMatch()` (active only
  under a real Pulumi run via the engine env marker; best-effort when the
  CLI/SDK can't be resolved; a resolved major.minor mismatch throws), and
  all example names in docs, comments, and fixtures are neutral.

## 2.4.0

### Minor Changes

- f083c51: Close out a round of adjudicated review findings across the deploy seam, every dynamic provider's `create()`/`read()`/`diff()` correctness, and documentation drift.

  **Deploy safety**

  - `createDeployCommand` now REQUIRES a `DeploySandbox` in `dependsOn` (or an explicit `allowUnsandboxed: true` opt-in) — without it, a deploy would silently run against the LIVE working tree (uncommitted changes included) instead of a clean, git-tracked copy. `dependsOnList` is exported so this brand-detection is independently testable.
  - The `deploymentUrl` extractor now strips wrapping quotes/brackets/punctuation from stdout tokens before the `^https?://` match, so a URL that only ever appears quoted inside pretty-printed JSON (proven live: Vercel's trailing JSON summary) is still found — previously this returned `""`. `RailwayDeploy`/`FlyDeploy`'s stale "final stdout line" JSDoc now describes the actual last-URL-token semantics.
  - `railway/deployment-monitor.ts`'s bare-UUID id-extraction fallback (any UUID-shaped substring in `railway up`'s output, with no structural signal tying it to an actual deployment) is now sanity-probed once via `deploymentStatus` before entering the ~20-minute poll loop — a wrong guess now fails fast instead of polling a nonexistent deployment to a timeout. `parseDeploymentId` returns `{ id, isBareUuidFallback }` so callers can tell which extraction path resolved the id.

  **Read/drift correctness**

  - `railway/variable.ts`'s `read()` claimed "Railway has no single-call variable read API" — false per current docs. It now reads live values via the `variables(projectId, environmentId, serviceId)` query (values stay secret-marked).
  - `railway/project-token.ts`'s `read()` now re-lists tokens and returns blank state when the stored `tokenId` is no longer present (revoked via the dashboard) instead of blindly trusting stale state.
  - `railway/volume.ts`'s `read()` now distinguishes a lookup ERROR (transient network/API failure — keep existing state) from a lookup that SUCCEEDS with no match (confirmed deleted — return blank state so refresh reconciles it); previously both cases fell back to the stored id, permanently masking a genuinely-deleted volume.
  - `vercel/resource-connection.ts`'s `read()` now actually calls `findConnection` and blanks the id when the connection is gone, instead of a pure pass-through.
  - Adopt paths now record LIVE values instead of assuming the desired config was already applied: `neon/database.ts` records the adopted database's real `owner_name`, and `fly/volume.ts` records the adopted volume's real `region`/`size_gb`. Neither path calls an update on adopt, so writing the desired values there was silently masking real drift on the very next diff.
  - `neon/project.ts`'s adopt lookup now follows Neon's cursor pagination across `GET /projects?search=<name>` instead of only ever seeing the first page (default page size 10).
  - `neon/role.ts`'s `delete()` now checks `protected`/rethrows real GET errors before attempting the DELETE, matching `neon/branch.ts`'s existing default-branch carve-out pattern.
  - `railway/service.ts`'s `read()` now distinguishes not-found from a real error instead of always returning blank state; its `diff()` now compares `source.image` so an image bump applies in place instead of forcing a phantom no-op replace.
  - All 19 component wrappers that were passing bare `{ parent: this }` to their inner dynamic resource now use `pulumi.mergeOptions(pulumiOpts, { parent: this })` — only `RailwayVolume` did this correctly before, so `retainOnDelete` and other consumer resource options were silently dropped everywhere else.

  **Validation and safety**

  - `vercel/resource-connection.ts`'s sensitive-env-vars-on-`development` validation moved from `create()` (a mid-apply throw) into `check()` (a plan-time failure).
  - Added missing `check()` plan-time validation: `neon/endpoint.ts` (`maxCu >= minCu`), `railway/project.ts` and `railway/environment.ts` (non-empty name).
  - `dynamic/resolve-credential.ts` now throws a loud, named error when a resolved env-var credential has leading/trailing whitespace — encodes a live incident where a Pulumi ESC secret set via piped stdin baked in a trailing newline.
  - `fly/app.ts`'s `organization` field no longer forces a replace on change — it's create-time only (adopting never re-applies it, and moving an app between orgs isn't supported via this provider's REST API surface), so forcing a replace was destroying and recreating the entire app for a field that was never being applied to it anyway. Mirrors `railway/environment.ts`'s existing ignore-and-document pattern for `source`.
  - `railway/service.ts`'s `icon`/`startCommand`/`healthcheckPath` are now documented as set-only: Railway's `serviceInstanceUpdate`/`serviceUpdate` mutations have no documented null-clearing semantics, so a key present in `olds` but absent from `news` is never re-sent to clear it.
  - `vercel/marketplace-resource.ts` now diffs and updates `metadata` in place via Vercel's Update Resource endpoint (`PATCH /v1/installations/{id}/resources/{id}`, added as `VercelClient.patch`); `billingPlanId` stays create-time-only and is now documented as such — that endpoint requires a full `billingPlan` object, a materially different shape than the plain string ID this provider exposes at creation.
  - Every provider's `*ProviderArgs` now documents once that its credential fields (`token`/`apiKey`, `tokenEnvVar`/`apiKeyEnvVar`) are never compared in any `diff()` — rotating a credential never triggers a replace or update on its own.

  **Cleanup**

  - `neon/branch.ts`: deleted a phantom `branchId` output that was declared but never populated (`create()`'s `outs` never included that key).
  - `neon/database.ts`: renamed `findDatabaseByName` → `databaseExists` to match what it actually returns.
  - `agents/hint.ts`: fixed a stale `{@link agentHint}` JSDoc reference — the exported function is `hint`.
  - `railway/service.ts`: fixed `healthcheckPath` JSDoc examples using a hyphenated `"/health-check"` — the same file's own `check()` rejects hyphens in this field.

- 0f3d40b: Zero-ceremony CLI/SDK version guard, and neutral example names throughout.

  - Every provider constructor (Railway, Vercel, Fly, Neon) now runs the
    memoized `ensurePulumiVersionMatch()` — programs get the CLI/SDK skew
    guard automatically, with no explicit preflight call. The check is
    best-effort when the `pulumi` binary or the SDK cannot be resolved
    (warns and skips); a resolved major.minor mismatch still throws.
    `assertPulumiVersionMatch()` remains exported for earlier placement or
    `WARN` mode.
  - Documentation and test fixtures now use neutral example names; dated
    internal design documents were removed from the repository.

## 2.3.0

### Minor Changes

- b21711d: Add an opt-in **live integration test tier** that exercises the resource providers against the real Railway and Neon APIs, creating and tearing down throwaway resources. It exists to catch the live-API-only truths that mocked unit tests cannot — mutations that report success while silently doing nothing, environment-scoped adoption, and password rotation that must not trigger a replace.

  - New `test:live` script and `vitest.live.config.ts` (built on the `base` test config, includes only `**/*.live.test.ts`) run the tier serially with generous timeouts. The default `test` script and `vitest.config.ts` explicitly exclude `*.live.test.ts`, so the normal suite and CI are unchanged.
  - **Inert without credentials.** Every `*.live.test.ts` gates on `INFRACRAFT_LIVE_TEST=1` plus its platform credentials via `describe.skipIf`, so absent credentials report as skipped (never failed) and `bun run test:live` exits `0` with everything skipped.
  - Coverage: `railway/service.live.test.ts` (adopt-or-create idempotency, non-default-environment instance materialization via config-patch commit, image-service deploy via `serviceInstanceDeployV2`, and `environmentUnskipService` rejection in named environments); `railway/volume.live.test.ts` (environment-scoped volume adoption); `neon/role.live.test.ts` (adopt-or-create and in-place `reset_password` rotation on a `passwordVersion` bump — no replace); `neon/branch.live.test.ts` (copy-on-write fork from a parent branch).
  - Each test creates uniquely-named resources and cleans them up in an idempotent `afterAll` that tolerates partial state and never fails the suite on a cleanup error. Documented in the new README "Live integration tests" section, including the required environment variables per platform.

- 28c823a: Redesign the Cloudflare preflight, fix a class of silent-failure bugs across the Neon/Railway/Fly providers, and clean up dead code and documentation drift.

  **Preflight**

  - Replace `assertCloudflareTokenScopes` (`GET /user/tokens/verify`) with `assertCloudflareZoneAccess({ token, zoneId })` (`GET /zones/{zone_id}`). The verify endpoint only accepts USER-owned tokens and 401s on a perfectly valid ACCOUNT-owned token (proven live 2026-07-06); a zone read also proves the specific capability a Pulumi program needs. Documented limitation: a successful read proves `Zone:Read`, not `Zone Settings:Edit`/`DNS:Edit`.
  - Rename `assert-cli-sdk-version-match.ts` → `assert-pulumi-version-match.ts` (file now matches its export); its thrown-message prefix now matches the `"<Domain> preflight: ..."` convention.
  - `PulumiVersionMismatchMode` and `AgentHintChannel` (was an inline string union on `AgentHintOptions.channel`) are now UPPERCASE enums, matching the `SandboxMode` precedent.

  **Bug fixes**

  - `FlySecret` was missing `"secrets"` from `additionalSecretOutputs` — the actual secret values (not just the API token) were persisted in Pulumi state unencrypted. Fixed, with a regression test.
  - diff()/update() agreement: `neon/branch.ts` and `neon/database.ts` allowed an in-place `diff()` (name / ownerName change) with no `update()` implemented — an in-place apply would have crashed with a TypeError. Both now implement `update()` via Neon's PATCH APIs. Conversely, `railway/environment.ts`, `fly/app.ts`, and `fly/certificate.ts` had `update()` methods that could never run (their `diff()` always sets `replaces` alongside `changes`) — removed as dead code.
  - `delete()` error discipline: Neon (branch/database/endpoint/role) and Railway (domain/environment/volume/variable) providers swallowed ANY delete failure, including real errors (permissions, rate limits), behind a bare `catch`. Backported the not-found-vs-real-error distinction already used by `railway/project-token.ts` — not-found is tolerated (idempotent delete), everything else rethrows. A new shared `isGraphqlNotFoundError` helper (`http/is-graphql-not-found-error.ts`) replaces the three previously-duplicated regexes (`fly/ip.ts`, `railway/project-token.ts`, `railway/service.ts`).
  - `fly/ip.ts`'s `read()` was a pure pass-through with no drift detection; it now queries current state like its REST siblings and reconciles out-of-band deletions.
  - Neon's `ResetPasswordResponse` carried an unused top-level `password` fallback alongside the real `role.password` shape — verified against current Neon docs and collapsed to the one real shape.
  - `neon/branch.ts`'s stricter `delete()` needed one carve-out restored: Neon refuses to delete a project's default branch. Rather than match that refusal's error message (brittle), `delete()` now GETs the branch first and skips (with a warning) when `branch.default === true`; a GET-404 is tolerated the same as before.
  - `RailwayDeployArgs.healthcheckPath` now rejects a hyphenated path at preview time, mirroring `RailwayServiceArgs.healthcheckPath`'s existing `check()` validation — the deploy monitor applies this value to the exact same Railway `serviceInstanceUpdate` field, so a hyphen would 403 mid-deploy just as it would at initial creation.

  **Cleanup**

  - Unified the `check()` input-validation and export-for-testing conventions across all 5 Neon provider files (branch/database/endpoint/project/role).
  - `railway/project.ts`: exported `RailwayProjectResourceProvider` (+ added its missing test file) and deleted a dead `replaces: string[] = []` in `diff()`. `railway/volume.ts` no longer exports `RailwayVolumeInputs` (unused externally).
  - `vercel/`: fixed a broken `@example` in `provider.ts` (referenced a removed `variables` field and omitted the required `triggers`), aligned the three divergent validation-error message conventions to the `"<ClassName> ..."` form already used by every provider's constructor, removed `VercelClient`'s unreferenced `patch()`/`delete()`, renamed the stuttering `VercelMarketplaceResourceResource` internal class to `VercelMarketplaceStoreResource`, and made "Replaces on change" JSDoc annotations consistent across every replace-triggering field.
  - Merged several stacked double-JSDoc blocks (a floating description comment immediately followed by a separate `/** @internal */` comment, which hid the first from doc tooling) into single blocks.
  - Minor doc/comment fixes: `railway/deploy.ts` now carries the same "Recommended preflight: `assertHostBinaries`" note as its Fly/Vercel siblings; a scaffold `// src/commands/deploy.ts` header comment, a missing "error" in `fly/index.ts`'s top comment, and a "list a" → "e.g. a" typo in `fly/deploy.ts` are fixed.

## 2.2.0

### Minor Changes

- 310e68e: Add two opt-in preflight guards under the new `@infracraft/pulumi/preflight` subpath, each catching a class of failure this session hit at apply time:

  - `assertPulumiVersionMatch(options?)` — compares the running Pulumi CLI version against the installed `@pulumi/pulumi` Node SDK version and throws (default) or warns on a major.minor skew. The Go engine (CLI) and the Node serializer (SDK) must agree on the wire format; a skew caused intermittent "Unexpected struct type" marshal failures on dynamic resources. Best-effort: warns and skips when the SDK cannot be resolved from the program's working directory. Accepts `mode: "throw" | "warn"` and injectable `readCliVersion` / `readSdkVersion` readers for testing.
  - `assertCloudflareTokenScopes(options)` — verifies a Cloudflare API token is valid and active via `GET /user/tokens/verify` (through the shared resilient transport) before a run relies on it, turning a mid-`up` 403 (a DNS-only token that silently lacked `Zone Settings:Edit`) into a plan-time error. Limitation: the verify endpoint returns only `{ id, status }`, not per-permission-group grants — so the check enforces active-status only, and `requiredPermissionGroups` is echoed as a manual-confirmation reminder rather than enforced (documented in JSDoc; it never claims to verify a scope it cannot).

  Both are opt-in top-of-program guards — neither is invoked automatically by any deploy path. Documented alongside `assertHostBinaries` in the new README "Preflight checks" section.

## 2.1.0

### Minor Changes

- 69238ae: Remove the Vercel resources now superseded by the official `@pulumiverse/vercel` provider:

  - `VercelProject` — use `vercel.Project`.
  - `VercelDomain` — use `vercel.ProjectDomain`.
  - The deploy-integrated env-var mechanism (`VercelDeploy`'s `variables` argument, plus the internal `env-applier` / `env-var-api` modules and the `apply-env` bin) — use `vercel.ProjectEnvironmentVariables`.
  - `VERCEL_FRAMEWORKS` / `VercelFramework` (lived on the removed `VercelProject`).

  `VercelDeploy` is now lean: it takes a required `projectId` (source it from `vercel.Project.id`), `triggers`, and `excludePaths`, and only runs `vercel deploy --prod --yes` with optional `DeploySandbox` / `GitGuard` isolation. `VercelProvider`, `VercelClient`, and the marketplace resources (`VercelIntegration`, `VercelMarketplaceResource`, `VercelResourceConnection`) are unchanged.

  Also fix the `deploymentUrl` derivation in the shared deploy command: it now extracts the last http(s) URL token from the CLI's stdout instead of grabbing the final line, which returned the Vercel CLI's pretty-printed JSON closing brace instead of the URL.

## 2.0.0

### Major Changes

- 5b0f3ec: BREAKING: `VercelVariable` is removed. As a dynamic resource it hit a Pulumi engine-internal stateful bug on clean-slate first creates ("Unexpected struct type", strictly alternating pass/fail across identical from-zero runs, reproduced with plain-literal inputs on matched CLI/SDK versions — four structural theories falsified by bisection). Its replacement is `VercelDeploy.variables` (deploy-integrated application via the shared env-var REST logic). The official resource-shaped modeling — like the bridged Vercel provider's `ProjectEnvironmentVariable(s)` — returns with the native-provider graduation, on a substrate that can carry it.

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

- 313452b: RailwayService now guarantees a service instance exists in its target environment before configuring or deploying. `serviceCreate` materializes an instance only in the environment passed at create time — everywhere else the service is "skipped": `serviceInstanceUpdate` returns true as a silent no-op and `railway up` fails with UPLOAD_FAILED 404 (live incident: a service's first-ever deploy to production). The provider now probes `serviceInstance` and calls `environmentUnskipService` when missing, re-verifying afterward (loud error instead of a fourth silent no-op). Also: `ApiNotFoundError` is exported from the neon/vercel/fly subpaths for instanceof catching, README/API docs fully synced, and stale JSDoc corrected (VercelProject deletion really deletes — protect precious projects).

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
