---
"@infracraft/pulumi": minor
---

Remove the Vercel resources now superseded by the official `@pulumiverse/vercel` provider:

- `VercelProject` — use `vercel.Project`.
- `VercelDomain` — use `vercel.ProjectDomain`.
- The deploy-integrated env-var mechanism (`VercelDeploy`'s `variables` argument, plus the internal `env-applier` / `env-var-api` modules and the `apply-env` bin) — use `vercel.ProjectEnvironmentVariables`.
- `VERCEL_FRAMEWORKS` / `VercelFramework` (lived on the removed `VercelProject`).

`VercelDeploy` is now lean: it takes a required `projectId` (source it from `vercel.Project.id`), `triggers`, and `excludePaths`, and only runs `vercel deploy --prod --yes` with optional `DeploySandbox` / `GitGuard` isolation. `VercelProvider`, `VercelClient`, and the marketplace resources (`VercelIntegration`, `VercelMarketplaceResource`, `VercelResourceConnection`) are unchanged.

Also fix the `deploymentUrl` derivation in the shared deploy command: it now extracts the last http(s) URL token from the CLI's stdout instead of grabbing the final line, which returned the Vercel CLI's pretty-printed JSON closing brace instead of the URL.
