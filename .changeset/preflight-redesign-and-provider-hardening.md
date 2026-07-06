---
"@infracraft/pulumi": minor
---

Redesign the Cloudflare preflight, fix a class of silent-failure bugs across the Neon/Railway/Fly providers, and clean up dead code and documentation drift.

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
