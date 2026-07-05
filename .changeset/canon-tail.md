---
"@infracraft/pulumi": minor
---

Final canon-alignment wave — preview fidelity, plan-time validation, naming audit:

- **`stables` for preview fidelity.** `diff()` now declares identity outputs that provably never change on an in-place update (`RailwayService.serviceId`, `RailwayProject.projectId`, `NeonProject.projectId`, `NeonEndpoint.host`, `NeonRole`'s identity fields, `VercelProject.projectId`, `FlyVolume.volumeId`), so dependents keep known values during preview instead of showing phantom replaces — notably a `RailwayVolume` no longer phantom-replaces when its `RailwayService` gets an in-place update. `NeonRole.password` is deliberately not stable: a `passwordVersion` bump rotates it in place and consumers must cascade.
- **`check()` plan-time validation.** Locally decidable input mistakes now fail at plan time with the offending property named, instead of deep inside an API call with an opaque error: `RailwayVolume.mountPath` must be absolute, `RailwayService.source.image` non-empty, `NeonBranch.name` / `NeonRole.name` / `RailwayProjectToken.name` non-empty, `VercelProject.name` per Vercel's published rule (≤ 100 lowercase letters/digits/`.`/`_`/`-`, no `---`), and `FlyVolume.sizeGb` a positive integer. Preview-unknown inputs are skipped, never failed.
- **Naming audit doc-links.** Every arg whose name deviates from the platform API field it maps to now documents that field in its JSDoc (e.g. `RailwayEnvironment.source` → `sourceEnvironmentId`, `NeonBranch.parent` → `parent_id`, `NeonEndpoint.minCu` → `autoscaling_limit_min_cu`, `VercelMarketplaceResource.type` → `integrationProductIdOrSlug`, `FlyApp.name` → `app_name`, `FlySecret.secrets` → `values`).
