# Neon Bridged Provider Evaluation (kislerdm/neon)

## Verdict

**KEEP infracraft's custom Neon dynamic providers. Do not switch to the bridged `neon` (kislerdm) provider.**

The bridge cleanly covers exactly one of the four behavioral gates (copy-on-write branching) and is bare parity on a second (endpoint/role ordering). It **hard-fails** the two that guard production data: it has **no adopt-or-create** (import-only, and a naive create silently makes a *duplicate* `shared-db` project rather than erroring), and it has **no in-place role password rotation** (the role resource is replace-only and the replace is *impossible* for the protected `neondb_owner` default role). Maturity is pre-1.0 community with open data-loss-on-replace bugs, which is not acceptable for the production Postgres of a production app.

This is a research spike only. No code changes, no commits.

## What infracraft's Neon does today (the behavior to match)

Source: `packages/pulumi/src/neon/{project,branch,role,endpoint,database}.ts`. Each is a `ComponentResource` wrapping an internal `pulumi.dynamic.Resource` whose provider implements `check`/`create`/`read`/`update`/`delete`/`diff` against the Neon REST API. The consumer is `infrastructure/stacks/database.ts` (called from `infrastructure/index.ts` with `neonProjectName: "shared-db"`, `branchName: stackName`, `passwordVersion: config.getNumber("neonPasswordVersion")`).

- **Adopt-or-create on every `create()`.** `neon.Project` queries `GET /projects` and exact-name-matches `shared-db`; if found it adopts (records the existing `projectId`), else `POST /projects`. `neon.Branch`, `neon.Role`, `neon.Endpoint`, `neon.Database` all do the by-name/by-branch equivalent. Both consumer stacks (production + staging) point at the **same** `shared-db` project and adopt it.
- **Protective no-op project delete.** `neon.Project.delete()` is a deliberate no-op (`"Neon project deletion skipped"`) — a `pulumi destroy` on either stack can never drop the shared `shared-db` project.
- **Copy-on-write branching.** On non-production stacks, `neon.Branch` forks `production` by resolving the parent branch *name* → `parent_id` and passing it to the Neon branch-create call.
- **In-place password rotation.** `neon.Role` carries `passwordVersion`; bumping it triggers an `update()` that calls Neon's `reset_password` endpoint — an UPDATE, never a replace. Replace is explicitly avoided because it would try to `DELETE` the role, which Neon refuses for default roles like `neondb_owner` and which would drop real grants. `password` is exposed as a Sensitive output for connection-string composition; adopted copy-on-write roles get `resetPassword: true` to isolate their credential from production.
- **Endpoint-before-role ordering.** The consumer wires `dependsOn: [endpoint]` on the role and `dependsOn: [endpoint, role]` on the database, because a fresh copy-on-write branch has no compute and Neon returns a **412** (`"create a read-write endpoint to manage roles on this branch"`) otherwise, plus a **422** (`"database owner not found"`) if the database races the role.

## Gate-by-gate

| # | Gate | Bridged `neon` (kislerdm v0.13.0) | Result |
|---|---|---|---|
| 1 | Adopt-or-create for the existing `shared-db` project | `Project` create = `client.CreateProject` (create-only). Neon project **names are not unique**, so a naive `up` creates a *second, empty* `shared-db` — no 409. Adoption only via one-time `pulumi import`. Project `delete` is a **real** `DeleteProject`, not a no-op — a shared-project footgun across the two stacks. | **FAIL** |
| 2 | Copy-on-write branching (`parent_id`) | `Branch` create passes `ParentID` to `CreateProjectBranch` — correct Neon copy-on-write fork. Parent by ID (`branch.id`), which is cleaner than infracraft's name resolution. | **PASS** |
| 3 | In-place role password rotation | `Role` is Create/Read/Delete-only: `project_id`/`branch_id`/`name` are all `ForceNew`, there is **no `UpdateContext`** and **no `reset_password`/`passwordVersion`**. Any change → replace = delete+create. For the `protected` `neondb_owner`, Neon refuses the delete, so a rotation attempt **fails outright**. | **FAIL** |
| 4 | Endpoint-before-role (avoid the 412) | Naive Terraform graph, no built-in sequencing. The 412 is avoided the same way infracraft's consumer already does it — explicit `dependsOn: [endpoint]`. No help beyond what you wire yourself; and adopting the branch-inherited `neondb_owner` role would itself need an import (create would 409). | **PARITY** |
| 5 | Maturity for a production financial-app DB | v0.13.0 (2026-01-02), pre-1.0, community (kislerdm), MPL-2.0, 112★, 20 open issues. Neon: *"not officially supported by Neon… at your own discretion."* Open issues include destructive-replace data loss (#218) and hard-error-on-404 drift (#209). | **NOT ACCEPTABLE** |

## Gate detail

### 1. Adopt-or-create — FAIL (import-only, with a shared-project delete footgun)

The bridged `Project` resource has no find-by-name path. `resourceProjectCreate` calls `client.CreateProject(...)` unconditionally ([`provider/resource_project.go`](https://github.com/kislerdm/terraform-provider-neon/blob/master/provider/resource_project.go)). Because Neon lets multiple projects share a display name, running `pulumi up` with `name = "shared-db"` against the live `shared-db` project does not 409 — it **silently provisions a second, empty `shared-db` project** and points the stack's connection strings at an empty database. That is a worse failure mode than a conflict.

The only correct adoption path is a one-time `pulumi import` per stack (the Pulumi Registry and Neon's guide both document import by project ID, e.g. `shiny-cell-31746257`). Two additional problems specific to the consumer program:

- **Both stacks share `shared-db`.** production and staging are separate Pulumi stacks with separate state, both declaring the same project. Each would independently hold the `shared-db` project in its state after import.
- **Delete is destructive.** `resourceProjectDelete` calls the real `DeleteProject(d.Id())`. Infracraft's `neon.Project.delete()` is a protective no-op. With the bridge, a `pulumi destroy` (or a replace triggered by a `ForceNew` field — see #218 below) on **either** stack would delete production's database unless every project/branch/role is manually guarded with `protect`/`retainOnDelete`. Infracraft removes this entire class of footgun by design.

### 2. Copy-on-write branching — PASS

`resourceBranchCreate` builds `CreateProjectBranchReqObj` with `ParentID: pointer(d.Get("parent_id"))` and calls `CreateProjectBranch` — Neon's native copy-on-write fork ([`resource_branch.go`](https://github.com/kislerdm/terraform-provider-neon/blob/master/provider/resource_branch.go), [branch docs](https://registry.terraform.io/providers/kislerdm/neon/latest/docs/resources/branch)). Semantics are correct and the API (`parentId = productionBranch.id`) is cleaner than infracraft's name→ID resolution. Caveats that do not change the PASS but matter for a migration: `parent_id` is `Optional + Computed` (not `ForceNew`), and adopting the existing `production` branch still requires an import. the consumer program forks `production` once and never re-parents, so neither caveat bites.

### 3. Role password rotation — FAIL (hard; impossible for `neondb_owner`)

From [`provider/resource_role.go`](https://github.com/kislerdm/terraform-provider-neon/blob/master/provider/resource_role.go), the schema is:

- `project_id`, `branch_id`, `name` — all `Required, ForceNew: true`.
- `password` — `Computed, Sensitive` (readable secret output — the one thing that carries over). Populated on create/read via `GetProjectBranchRolePassword`.
- `protected` — `Computed` boolean.
- Lifecycle: `CreateContext` / `ReadContext` / `DeleteContext` only. **No `UpdateContext`. No `reset_password`. No rotation handle.**

Consequences for the actively-used `neonPasswordVersion` config rotation:

1. There is no in-place rotation at all — the resource cannot be updated, period.
2. The only way to change a role is to replace it (delete+create). `resourceRoleDelete` calls `DeleteProjectBranchRole`, which Neon **refuses for the protected `neondb_owner`** default role — so the rotation would fail at the delete step.
3. You cannot even *manage* `neondb_owner` freshly: `CreateProjectBranchRole` on a name that already exists errors, so `neondb_owner` must be imported, after which it is frozen (no rotate).

The password *can* be read (there is a `data_source_branch_role_password`), but rotating it requires calling Neon's `reset_password` API out-of-band — which is exactly the internal mechanism infracraft already encapsulates as a first-class `passwordVersion` UPDATE. The bridge cannot express it.

### 4. Endpoint/role ordering — PARITY (no automation)

The bridge is a plain Terraform dependency graph; it does not sequence endpoint-before-role. The 412 is avoided identically to today — the consumer writes `dependsOn: [endpoint]`. So this is neither a win nor a loss versus infracraft, whose consumer already carries those explicit edges. One extra friction: because there is no adopt-or-create, the copy-on-write branch's *inherited* `neondb_owner` role can't be declared as a create (it would 409); infracraft adopts it and resets its password to isolate it in one step.

### 5. Maturity — NOT ACCEPTABLE for a production financial-app DB

- **Pre-1.0, community.** v0.13.0, released 2026-01-02; 34 releases total; repo last pushed 2026-04-29; 112 stars; 20 open issues; MPL-2.0; author/maintainer kislerdm. Cadence was ~monthly in late 2025 (v0.10 Oct → v0.13 Jan) then quiet for the first half of 2026.
- **Not Neon-official.** Neon's own guide states plainly: *"This provider is based on a community-maintained Terraform provider and is not officially supported by Neon,"* to be used *"at your own discretion,"* with issues directed to the maintainer, not Neon ([Manage Neon with Pulumi](https://neon.com/guides/neon-pulumi)). The Pulumi listing is a Terraform-bridge package added via `pulumi package add terraform-provider kislerdm/neon` ([Pulumi Registry](https://www.pulumi.com/registry/packages/neon/)).
- **Open issues are severity-relevant, not cosmetic:**
  - [#218](https://github.com/kislerdm/terraform-provider-neon/issues/218) — changing `enable_logical_replication` on an existing `neon_project` forces a **destroy + recreate of the entire project** ("can lead to data loss," reproduced even after import). This is the destructive-replace class that a production DB cannot tolerate.
  - [#209](https://github.com/kislerdm/terraform-provider-neon/issues/209) — an out-of-band project deletion (404) is treated as a **hard error** instead of removing the resource from state, unlike infracraft's `read()` which returns `{}` on `ApiNotFoundError` and reconciles gracefully.
  - [#136](https://github.com/kislerdm/terraform-provider-neon/issues/136) — "Provider is lacking state upgraders," open since 2025-01 despite the role schema already being at `SchemaVersion: 7` — state-migration debt in a pre-1.0 line.

For the production Postgres of a production app, adopting a pre-1.0 community provider whose known-open defects include silent data loss on attribute change is not an acceptable trade against infracraft's battle-tested, purpose-built behavior.

## Decision and revisit trigger

**KEEP.** Failing gates: **1** (adopt-or-create — import-only, duplicate-project-on-create, destructive shared-project delete) and **3** (in-place rotation — impossible for `neondb_owner`), plus **maturity (5)**. The bridge only wins on **2** and is parity on **4** — not enough to move the production database onto it.

**Revisit when all of the following hold:**

1. The provider reaches **1.0** (or Neon adopts/officially supports it), and
2. it gains **safe adoption** — adopt-by-name or an idempotent create that cannot silently duplicate a same-named project — plus a documented, rehearsed import path, and
3. it gains **in-place password reset** for default/protected roles (a `reset_password`-style update that does not force a replace), and
4. the destructive-replace class (#218) and drift-on-404 (#209) are resolved.

Independently, the better path to the benefits one might chase from the bridge (real `pulumi import`, no per-resource serialized closures, schema-typed diffs) is infracraft's own **native provider graduation** (see [`native-provider-graduation.md`](./native-provider-graduation.md)), which delivers those while keeping every behavior above at zero translation risk. Prefer that over the bridge.

## If we ever switch (migration sketch — not planned)

For completeness only, the shape a switch would take, so the deferral is a decision and not a blank:

1. Adopt official bridged resources (`neon.Project/Branch/Endpoint/Role/Database`) in `infrastructure/stacks/database.ts`.
2. **Import, never recreate** — `pulumi import` the live `shared-db` project, `production` branch, its read-write endpoint, `neondb_owner`, and `neondb` into **each** stack's state by their Neon IDs before the first `up`; gate on a `pulumi preview --diff` showing **zero** replace/delete on every one.
3. Re-implement the missing behaviors *around* the bridge: guard the project/branch/role with `retainOnDelete`/`protect` to replace infracraft's no-op delete; drive password rotation out-of-band via Neon's `reset_password` API (the bridge cannot), or keep `neon.Role` custom even if the rest switches.
4. Keep infracraft's dynamic Neon providers as the fallback until a full drill (rehearsal on exported the consumer program state → staging → soak → production) passes with no data movement.

The volume of behavior that must be rebuilt *around* the bridge (adoption safety, protective delete, rotation) is itself evidence that the bridge is the wrong substrate here.

## Sources

All fetched 2026-07-05.

- Pulumi Registry — Neon package (community, bridged; `pulumi package add terraform-provider kislerdm/neon`) — https://www.pulumi.com/registry/packages/neon/
- Pulumi Registry — `neon.Role` api-docs (password is a Computed output; no rotation input; v0.13.0) — https://www.pulumi.com/registry/packages/neon/api-docs/role/
- Neon — "Manage Neon with Pulumi" guide (disclaimer "not officially supported by Neon… at your own discretion"; import section) — https://neon.com/guides/neon-pulumi
- Neon — "Manage Neon with Terraform" — https://neon.com/docs/reference/terraform
- terraform-provider-neon repository (v0.13.0 released 2026-01-02, last push 2026-04-29, 112★, 20 open issues, MPL-2.0, community) — https://github.com/kislerdm/terraform-provider-neon
- `provider/resource_role.go` — Role is Create/Read/Delete only; `project_id`/`branch_id`/`name` `ForceNew`; `password` Computed+Sensitive; no `UpdateContext`/`reset_password` — https://github.com/kislerdm/terraform-provider-neon/blob/master/provider/resource_role.go
- `provider/resource_project.go` — `CreateProject` (create-only, no find-by-name); real `DeleteProject` — https://github.com/kislerdm/terraform-provider-neon/blob/master/provider/resource_project.go
- `provider/resource_branch.go` — `CreateProjectBranch` with `ParentID` (copy-on-write); `parent_id` Optional+Computed — https://github.com/kislerdm/terraform-provider-neon/blob/master/provider/resource_branch.go
- Resource schema docs (role/project/branch/endpoint/database — import IDs, ForceNew, sensitive password) — https://registry.terraform.io/providers/kislerdm/neon/latest/docs
- Issue #218 — `enable_logical_replication` forces project destroy+recreate (data loss) — https://github.com/kislerdm/terraform-provider-neon/issues/218
- Issue #209 — 404 on out-of-band project deletion is a hard error, not graceful state removal — https://github.com/kislerdm/terraform-provider-neon/issues/209
- Issue #136 — provider lacking state upgraders (open since 2025-01) — https://github.com/kislerdm/terraform-provider-neon/issues/136
- Local verification: infracraft `packages/pulumi/src/neon/{project,branch,role,endpoint,database,provider}.ts`; consumer `infrastructure/stacks/database.ts` + `infrastructure/index.ts` (`neonProjectName: "shared-db"`, `passwordVersion` rotation handle).
