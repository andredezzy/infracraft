# Context-Based Provider API (v1.0)

## Goal

Replace explicit ID passing with context-based options. Resources inherit auth/project/environment/service from their options parameter instead of passing `token`, `projectId`, `environmentId`, `serviceId` everywhere.

## Architecture

Each public resource is a `ComponentResource` wrapping an internal `dynamic.Resource`. The internal dynamic resources keep all existing CRUD logic unchanged — the ComponentResource layer adds DX.

```
Public API (ComponentResource)     →  Internal (dynamic.Resource)
─────────────────────────────────     ────────────────────────────
RailwayProvider                       (no internal resource — holds token)
RailwayProject({ name })              RailwayProjectResource({ token, name })
RailwayEnvironment({ name })          (queries project environments by name)
RailwayService({ name, builder })     RailwayServiceResource({ token, projectId, environmentId, name, builder })
RailwayVariable({ variables })        RailwayVariableResource({ token, projectId, environmentId, serviceId, variables })
```

## Options Pattern

Each resource defines its own options type. Uses `Omit<ComponentResourceOptions, 'provider'>` to replace Pulumi's native `provider` field:

```typescript
type RailwayServiceOptions = Omit<pulumi.ComponentResourceOptions, "provider"> & {
  provider: RailwayProvider;
  project: RailwayProject;
  environment: RailwayEnvironment;
};
```

Constructor destructures context, passes Pulumi options to `super()`:

```typescript
constructor(name: string, args: RailwayServiceArgs, opts: RailwayServiceOptions) {
  const { provider, project, environment, ...pulumiOpts } = opts;
  super("infracraft:railway:Service", name, {}, pulumiOpts);

  const resource = new RailwayServiceResource(`${name}-resource`, {
    token: provider.token,
    projectId: project.projectId,
    environmentId: environment.environmentId,
    ...args,
  }, { parent: this });

  this.serviceId = resource.serviceId;
  this.registerOutputs({ serviceId: this.serviceId });
}
```

## File Structure

Internal dynamic resources get renamed with `Resource` suffix, kept in same file:

```
railway/
  provider.ts         RailwayProvider (ComponentResource, holds token)
  project.ts          RailwayProject (ComponentResource) + RailwayProjectResource (dynamic)
  environment.ts      RailwayEnvironment (ComponentResource, queries environments)
  service.ts          RailwayService (ComponentResource) + RailwayServiceResource (dynamic)
  variable.ts         RailwayVariable + RailwayVariableResource
  volume.ts           RailwayVolume + RailwayVolumeResource
  domain.ts           RailwayDomain + RailwayDomainResource
  deploy.ts           RailwayDeploy (already ComponentResource, update options)
  client.ts           RailwayClient (unchanged)
  index.ts            Public exports (providers + resources, NOT internal resources)

neon/
  provider.ts         NeonProvider (ComponentResource, holds apiKey)
  project.ts          NeonProject + NeonProjectResource
  branch.ts           NeonBranch + NeonBranchResource
  endpoint.ts         NeonEndpoint + NeonEndpointResource
  role.ts             NeonRole + NeonRoleResource
  database.ts         NeonDatabase + NeonDatabaseResource
  client.ts           NeonClient (unchanged)
  index.ts            Public exports

vercel/
  provider.ts         VercelProvider (ComponentResource, holds token + teamId)
  variable.ts         VercelVariable + VercelVariableResource
  deploy.ts           VercelDeploy (already ComponentResource, update options)
  index.ts            Public exports

hash.ts               unchanged
git-guard.ts          unchanged
```

## Railway API

```typescript
// Provider — auth context
const provider = new RailwayProvider("railway", {
  token: config.requireSecret("railwayToken"),
})

// Project — adopt-or-create, exposes projectId + projectToken
const project = new RailwayProject("my-project", {
  name: "my-app",
  description: "My application",
}, { provider })

// Environment — resolves by name from project
const environment = new RailwayEnvironment("production", {
  name: "production",
}, { provider, project })

// Service — adopt-or-create
const service = new RailwayService("api", {
  name: "api",
  builder: "RAILPACK",
  startCommand: "node dist/index.js",
  healthcheckPath: "/health",
}, { provider, project, environment })

// Variable — batch env vars
new RailwayVariable("api-vars", {
  variables: { DATABASE_URL: dbUrl },
}, { provider, project, environment, service })

// Volume — persistent storage
new RailwayVolume("api-data", {
  mountPath: "/data",
}, { provider, project, environment, service })

// Domain — service/custom domain
const domain = new RailwayDomain("api-domain", {}, {
  provider, project, environment, service,
})

// Deploy — railway up with hash triggers
new RailwayDeploy("api-deploy", {
  directory: monorepoRoot,
  sourceHash,
  env: { DATABASE_URL: dbUrl },
}, { provider, project, environment, service })
```

## Neon API

```typescript
const provider = new NeonProvider("neon", {
  apiKey: config.requireSecret("neonApiKey"),
  orgId: "org-xxx",  // optional
})

const project = new NeonProject("db", {
  name: "my-app",
}, { provider })

const branch = new NeonBranch("production", {
  name: "production",
}, { provider, project })

const role = new NeonRole("owner", {
  name: "neondb_owner",
}, { provider, project, branch })

const database = new NeonDatabase("main", {
  name: "neondb",
  ownerName: "neondb_owner",
}, { provider, project, branch })

const endpoint = new NeonEndpoint("production", {
  minCu: 0.25,
  maxCu: 1,
  suspendTimeout: 0,
}, { provider, project, branch })
```

## Vercel API

```typescript
const provider = new VercelProvider("vercel", {
  token: config.requireSecret("vercelToken"),
  teamId: "team_xxx",
})

// VercelVariable needs projectId (from @pulumiverse/vercel project)
new VercelVariable("nexus-vars", {
  projectId: vercelProject.id,
  variables: { NEXT_PUBLIC_API_URL: meshUrl },
}, { provider })

// VercelDeploy needs projectId + env for hash triggers
new VercelDeploy("nexus-deploy", {
  projectId: vercelProject.id,
  rootDirectory: "apps/nexus",
  monorepoRoot,
  env: { NEXT_PUBLIC_API_URL: meshUrl },
}, { provider })
```

## Provider Outputs

| Resource | Outputs |
|----------|---------|
| RailwayProvider | `token` |
| RailwayProject | `projectId`, `projectToken` |
| RailwayEnvironment | `environmentId` |
| RailwayService | `serviceId` |
| RailwayDomain | `fqdn` |
| NeonProvider | `apiKey` |
| NeonProject | `projectId` |
| NeonBranch | `branchId` |
| NeonRole | `password` (secret) |
| NeonEndpoint | `host` |
| VercelProvider | `token`, `teamId` |
| VercelVariable | `contentHash` |

## Breaking Changes from v0.2.x

- All resources now require context via options instead of explicit IDs
- `RailwayEnvironment` is new (was part of RailwayProject outputs)
- Resources are ComponentResources wrapping dynamic.Resources (state URNs change)
- Consumers must migrate: state surgery same pattern as the v0.2.x migration
