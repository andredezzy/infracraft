---
"@infracraft/pulumi": minor
---

Close out a round of adjudicated review findings across the deploy seam, every dynamic provider's `create()`/`read()`/`diff()` correctness, and documentation drift.

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
