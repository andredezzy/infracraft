---
"@infracraft/pulumi": minor
---

Add an opt-in **live integration test tier** that exercises the resource providers against the real Railway and Neon APIs, creating and tearing down throwaway resources. It exists to catch the live-API-only truths that mocked unit tests cannot — mutations that report success while silently doing nothing, environment-scoped adoption, and password rotation that must not trigger a replace.

- New `test:live` script and `vitest.live.config.ts` (built on the `base` test config, includes only `**/*.live.test.ts`) run the tier serially with generous timeouts. The default `test` script and `vitest.config.ts` explicitly exclude `*.live.test.ts`, so the normal suite and CI are unchanged.
- **Inert without credentials.** Every `*.live.test.ts` gates on `INFRACRAFT_LIVE_TEST=1` plus its platform credentials via `describe.skipIf`, so absent credentials report as skipped (never failed) and `bun run test:live` exits `0` with everything skipped.
- Coverage: `railway/service.live.test.ts` (adopt-or-create idempotency, non-default-environment instance materialization via config-patch commit, image-service deploy via `serviceInstanceDeployV2`, and `environmentUnskipService` rejection in named environments); `railway/volume.live.test.ts` (environment-scoped volume adoption); `neon/role.live.test.ts` (adopt-or-create and in-place `reset_password` rotation on a `passwordVersion` bump — no replace); `neon/branch.live.test.ts` (copy-on-write fork from a parent branch).
- Each test creates uniquely-named resources and cleans them up in an idempotent `afterAll` that tolerates partial state and never fails the suite on a cleanup error. Documented in the new README "Live integration tests" section, including the required environment variables per platform.
