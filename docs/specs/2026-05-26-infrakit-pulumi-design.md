# @infrakit/pulumi — Design Spec

## Vision

`@infrakit` is an infrastructure toolkit brand. `@infrakit/pulumi` is the first package — Pulumi providers that fill gaps no existing library covers.

## Market Context

| Provider | Existing Options | Gap We Fill |
|----------|-----------------|-------------|
| **Railway** | Zero Pulumi providers exist anywhere. Only a Terraform community provider (40 stars) lacking volumes, deploys, discovery, adopt-or-create. | **We ARE the Railway Pulumi provider.** Full CRUD, adopt-or-create, GraphQL discovery, deploy orchestration. |
| **Neon** | Bridged TF provider (`@sst-provider/neon`, 110 stars upstream). Covers 11 resources but fails on pre-existing resources (Neon auto-creates branch + DB on every project). | **Adopt-or-create semantics.** Silent adoption of pre-existing resources without manual `import` blocks. |
| **Vercel** | `@pulumiverse/vercel` (bridged from Vercel's official TF provider). Covers projects, domains, firewall, edge config. | **Deployment orchestration** (`vercel deploy --prod` with sourceHash + envHash triggers) and **sensitive env var drift detection** via contentHash. |

## Package Structure

Single npm package with subpath exports:

```
npm install @infrakit/pulumi
```

```ts
import { RailwayProject, RailwayService } from '@infrakit/pulumi/railway'
import { NeonProject, NeonBranch, NeonRole } from '@infrakit/pulumi/neon'
import { VercelDeploy, VercelVariable } from '@infrakit/pulumi/vercel'
import { hashDirectory } from '@infrakit/pulumi/hash'
import { gitGuard } from '@infrakit/pulumi/git-guard'
```

## Repository Structure

Monorepo with room for future `@infrakit/*` packages:

```
infrakit/
  packages/
    pulumi/                              ← @infrakit/pulumi
      src/
        railway/
          client.ts                      GraphQL client
          project.ts                     dynamic.Resource — adopt-or-create project + discovery
          service.ts                     dynamic.Resource — adopt-or-create service
          variable.ts                    dynamic.Resource — batch env vars (skipDeploys)
          volume.ts                      dynamic.Resource — standalone persistent volume
          domain.ts                      dynamic.Resource — service/custom domain (FQDN as ID)
          deploy.ts                      ComponentResource — `railway up` with hash triggers
          index.ts                       Public API exports
        neon/
          client.ts                      REST client
          project.ts                     dynamic.Resource — adopt-or-create project
          branch.ts                      dynamic.Resource — adopt-or-create branch
          endpoint.ts                    dynamic.Resource — compute endpoint (exposes host)
          role.ts                        dynamic.Resource — role with password reveal
          database.ts                    dynamic.Resource — adopt-or-create database
          index.ts                       Public API exports
        vercel/
          variable.ts                    dynamic.Resource — batch env vars with contentHash
          deploy.ts                      ComponentResource — `vercel deploy --prod` with hash triggers
          index.ts                       Public API exports
        hash.ts                          Deterministic SHA-256 directory hasher
        git-guard.ts                     Parallel deploy .git race condition guard
      package.json
      tsconfig.json
      tsdown.config.ts
      vitest.config.ts
    config-tsdown/                       ← @infrakit/config-tsdown
      src/
        base.ts
        library.ts
        merge.ts
      package.json
      tsconfig.json
      tsdown.config.ts
    config-typescript/                    ← @infrakit/typescript-config
      base.json
      package.json
    config-test/                         ← @infrakit/config-test
      src/
        base.ts
        unit.ts
        setup.ts
      package.json
      tsconfig.json
      tsdown.config.ts
  turbo.json
  biome.json
  eslint.config.mjs
  bunfig.toml
  knip.json
  package.json
  .gitignore
```

## Tooling (Matching Existing Projects)

| Tool | Version | Config |
|------|---------|--------|
| Bun | 1.3.14 | `exact = true` |
| Turbo | 2.9.15 | concurrency 20, `^build` chain |
| TypeScript | 6.0.3 | ES2022, NodeNext, strict |
| Biome | 2.4.15 | tabs, double quotes, noUnusedImports, noExplicitAny |
| ESLint | 10.4.0 | `@stylistic/padding-line-between-statements` |
| tsdown | 0.22.0 | ESM + CJS, treeshake, minify, dts |
| Vitest | 4.1.7 | globals, node env, passWithNoTests |
| knip | 6.14.2 | dead code detection |

## Subpath Exports

### `@infrakit/pulumi/railway`

Full Railway Pulumi provider — 8 resources + discovery layer.

| Export | Type | Description |
|--------|------|-------------|
| `RailwayClient` | Class | GraphQL client for Railway API |
| `RailwayProject` | dynamic.Resource | Adopt-or-create project with discovery (exposes `projectId`, `environmentId`, `projectToken` outputs) |
| `RailwayService` | dynamic.Resource | Adopt-or-create service (exposes `serviceId` output) |
| `RailwayVariable` | dynamic.Resource | Batch env var upsert with `skipDeploys` |
| `RailwayVolume` | dynamic.Resource | Standalone persistent volume |
| `RailwayDomain` | dynamic.Resource | Service/custom domain (FQDN as resource ID) |
| `RailwayDeploy` | ComponentResource | `railway up --ci` with `[sourceHash, envHash]` triggers |
| `RailwayDeployConfig` | Type | Build/deploy settings |

### `@infrakit/pulumi/neon`

Adopt-or-create layer for Neon serverless Postgres.

| Export | Type | Description |
|--------|------|-------------|
| `NeonClient` | Class | REST client for Neon API |
| `NeonProject` | dynamic.Resource | Adopt-or-create project (shows in preview) |
| `NeonBranch` | dynamic.Resource | Adopt-or-create branch |
| `NeonEndpoint` | dynamic.Resource | Compute endpoint (exposes `host` output) |
| `NeonRole` | dynamic.Resource | Role with password reveal (exposes `password` output) |
| `NeonDatabase` | dynamic.Resource | Adopt-or-create database |

### `@infrakit/pulumi/vercel`

Deployment orchestration for Vercel — fills gaps in `@pulumiverse/vercel`.

| Export | Type | Description |
|--------|------|-------------|
| `VercelVariable` | dynamic.Resource | Batch env vars with `contentHash` drift detection |
| `VercelDeploy` | ComponentResource | `vercel deploy --prod` with `[sourceHash, envHash]` triggers |

### `@infrakit/pulumi/hash`

```ts
import { hashDirectory } from '@infrakit/pulumi/hash'

const sourceHash = hashDirectory('/app/apps/mesh')
const hash = hashDirectory('/app/apps/api', {
  ignore: new Set(['node_modules', 'dist', '__tests__']),
})
```

- Deterministic SHA-256 walk with sorted entries
- Default ignore: `node_modules`, `dist`, `.turbo`, `.next`, `.git`, `.vercel`
- Configurable `ignore` set via options

### `@infrakit/pulumi/git-guard`

```ts
import { gitGuard } from '@infrakit/pulumi/git-guard'

const guard = gitGuard(monorepoRoot)

new RailwayDeploy('deploy-mesh', { dependsOn: [guard.hide] })
new VercelDeploy('deploy-nexus', { dependsOn: [guard.hide] })
```

- Moves `.git` → `.git-infrakit-pulumi-guard`, creates stub with index
- Restores on `process.exit`, `SIGINT`, `SIGTERM`
- Auto-adds guard dir to `.gitignore` if not present
- Protects against crash leaving guard dir tracked

## Key Design Patterns

### Adopt-or-create (all providers)

Every provider's `create()` queries the cloud API to find the resource by name before creating. Makes `pulumi up` idempotent from zero — safe to run against an existing project.

### Silent error on delete

Every provider wraps delete in try/catch and warns instead of throwing. Prevents Pulumi state from getting stuck when resources are deleted externally.

### Full CRUD + diff

All `dynamic.Resource` providers implement: `create`, `read`, `update` (or replace), `delete`, `diff`. Enables `pulumi refresh` for drift detection.

### Dry-run safety (preview-safe)

All providers and pre-engine functions MUST be safe during `pulumi preview`. No cloud resources are created during preview — only reads/queries.

**Rule:** Any function that runs outside the Pulumi resource lifecycle (plain `await` at top level) must check `pulumi.runtime.isDryRun()` before any CREATE/POST/mutation call. `dynamic.Resource.create()` methods don't need this check — the Pulumi engine never calls them during preview.

**Fixes from current codebase:**

1. **`discoverRailwayProject`** — eliminated. Discovery and creation both move into `RailwayProject` (dynamic.Resource). The resource's `create()` does adopt-or-create, and exposes `projectId`, `environmentId`, `projectToken` as outputs. Preview shows `+ RailwayProject` when the project doesn't exist.

2. **`findOrCreateNeonProject`** — eliminated. Replaced by `NeonProject` (dynamic.Resource) with the same adopt-or-create pattern. Preview shows `+ NeonProject`.

3. **`RailwayService.ensureService`** — eliminated. `RailwayService` is now a `dynamic.Resource`. Adopt-or-create logic lives inside the provider's `create()` method — the Pulumi engine never calls it during preview, so no `isDryRun()` guard is needed.

**Principle:** All mutations go through Pulumi resources. No pre-engine imperative creation. Outputs are passed directly as inputs — Pulumi handles the dependency graph.

**Pattern:**

```ts
const project = new RailwayProject("my-project", {
  token: railwayToken,
  name: "nodex",
});

const service = new RailwayService("mesh", {
  token: project.token,
  projectId: project.projectId,
  environmentId: project.productionEnvironmentId,
  name: "@nodex/mesh",
});

new RailwayVariable("mesh-vars", {
  token: project.token,
  projectId: project.projectId,
  serviceId: service.serviceId,
  environmentId: project.productionEnvironmentId,
  variables: { DATABASE_URL: dbUrl },
});
```

### Outputs passed directly as inputs

No value extraction from `apply()` for use as resource inputs. All inter-resource dependencies flow through `Output<T>` — Pulumi builds the DAG automatically. Use `pulumi.interpolate` for string composition, never string concatenation.

### parent: this in ComponentResources

`RailwayDeploy`, `VercelDeploy`, and `gitGuard` wrap child resources (e.g. `command.local.Command`). All child resources pass `{ parent: this }` so they appear nested in the Pulumi console and are deleted together with the parent.

### Consistent type URNs

All resources use the pattern `infrakit:{provider}:{ResourceName}`:
- `infrakit:railway:Project`
- `infrakit:railway:Service`
- `infrakit:neon:Branch`
- `infrakit:vercel:Variable`

### ComponentResource conventions

`RailwayDeploy`, `VercelDeploy`, and `gitGuard` are ComponentResources. They follow:

- **`registerOutputs()`** — called as last line of constructor. Without it, the component appears stuck "creating" in the Pulumi console.
- **Child names derived from `${name}-suffix`** — prevents collisions when multiple instances exist. e.g. `new command.local.Command(\`${name}-deploy\`, {}, { parent: this })`.
- **Accept `ComponentResourceOptions`** as the third constructor parameter.
- **Expose only what consumers need** — `RailwayDeploy` exposes `deploy` (the command resource for dependency wiring), not internal implementation details.

### Args interface design

All resource args follow multi-language-safe conventions:

- **Wrap all properties in `pulumi.Input<T>`** — consumers can pass plain values or `Output<T>` from other resources.
- **Flat structures** — no deeply nested config objects.
- **No union types** — breaks Python, Go, C# SDK generation.
- **No functions or callbacks** — cannot serialize across language boundaries.
- **Sensible defaults** — optional properties use `??` in the constructor.

### Secrets propagation

Inputs that contain secrets (tokens, API keys, passwords) are accepted as `pulumi.Input<string>` and marked as secret outputs via `pulumi.secret()`. Secret status propagates through `pulumi.interpolate` — connection strings built from secret passwords remain secret.

### Hash-based deploy triggers

Both `RailwayDeploy` and `VercelDeploy` use `[sourceHash, envHash]` as `triggers` on `@pulumi/command`. Source hash is computed at plan time (synchronous). Env hash is computed at apply time via `pulumi.all()` (value transformation only — no resource creation inside apply).

## Dependencies

```json
{
  "peerDependencies": {
    "@pulumi/pulumi": "^3",
    "@pulumi/command": "^1"
  },
  "peerDependenciesMeta": {
    "@pulumi/command": {
      "optional": true
    }
  }
}
```

`@pulumi/command` is optional — only required if using `RailwayDeploy`, `VercelDeploy`, or `gitGuard`. The core providers (`RailwayService`, `NeonBranch`, etc.) only need `@pulumi/pulumi`.

No dependency on `@pulumiverse/vercel` or `@sst-provider/neon` — consumers bring their own.

## Generalization Changes

Extracting from nodex/mlm-rby requires these changes:

1. **Eliminate `discoverRailwayProject` and `findOrCreateNeonProject`** — replaced by `RailwayProject` and `NeonProject` dynamic resources. No pre-engine imperative code.

2. **Project token management** — `RailwayProject` exposes `projectToken` as a secret output. The consumer stores it however they want (Pulumi config, ESC, etc.). The library never calls `pulumi config set`.

3. **Export all types** — `RailwayDeployConfig`, input/output interfaces for all providers.

4. **Remove nodex-specific stack files** — Stacks (database.ts, redis.ts, mesh.ts, sentinel.ts) are application-specific wiring and do NOT ship with the library. They stay in the consumer's project.

## Testing Strategy

- Unit tests for `RailwayClient` and `NeonClient` (HTTP mocking)
- Unit tests for `hashDirectory` (deterministic hashing, ignore list)
- Unit tests for `gitGuard` `.gitignore` management (`ensureGitignore`)
- Integration tests for adopt-or-create patterns (mocked API responses)

## Publishing

- npm scope: `@infrakit`
- Package: `@infrakit/pulumi`
- License: MIT
- CI: GitHub Actions — lint, typecheck, test, build, publish on tag
- Versioning: semver, changesets or manual
