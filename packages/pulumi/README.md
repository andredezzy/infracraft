<p align="center">
  <b>@infracraft/pulumi</b>
  <br />
  <i>Pulumi providers for platforms that don't have one.</i>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@infracraft/pulumi"><img src="https://img.shields.io/npm/v/@infracraft/pulumi?style=flat&colorA=18181b&colorB=18181b" alt="npm" /></a>
  <a href="https://www.npmjs.com/package/@infracraft/pulumi"><img src="https://img.shields.io/npm/dm/@infracraft/pulumi?style=flat&colorA=18181b&colorB=18181b" alt="downloads" /></a>
  <a href="https://github.com/andredezzy/infracraft/blob/main/LICENSE"><img src="https://img.shields.io/github/license/andredezzy/infracraft?style=flat&colorA=18181b&colorB=18181b" alt="license" /></a>
</p>

---

Native Pulumi providers with adopt-or-create semantics and deploy orchestration. No Terraform bridge.

## Providers

| | Provider | Import | What it does |
|---|---|---|---|
| 🚂 | **Railway** | `@infracraft/pulumi/railway` | The only Pulumi provider for Railway. Projects, environments, services, variables, volumes, domains, deploys. |
| 🐘 | **Neon** | `@infracraft/pulumi/neon` | Adopt-or-create layer for Neon Postgres. Projects, branches, endpoints, roles, databases. |
| ▲ | **Vercel** | `@infracraft/pulumi/vercel` | Projects with adopt-or-create, deploy orchestration, marketplace resources, and sensitive env var drift detection. |
| 🎯 | **Fly.io** | `@infracraft/pulumi/fly` | App, Secret, Volume, Certificate, IP, and Deploy resources via the Machines REST API and Fly GraphQL API. |
| 🤖 | **Agents** | `@infracraft/pulumi/agents` | Emit operating hints for AI coding agents working on the stack. |
| #️⃣ | **Hash** | `@infracraft/pulumi/hash` | Deterministic directory/env-var/app hashing for deploy triggers. |
| 📦 | **Sandbox** | `@infracraft/pulumi/sandbox` | Isolated `/tmp` working copies for CLI deploys. Opt in via `dependsOn`. |
| 🔒 | **Git Guard** | `@infracraft/pulumi/git-guard` | Swaps a sandboxed deploy's `.git` for a fresh stub. Opt in via `dependsOn`. |

## Install

```bash
npm i @infracraft/pulumi
# or
bun add @infracraft/pulumi
```

Peer dependencies: `@pulumi/pulumi` ^3, `@pulumi/command` ^1 (optional)

## Railway

```typescript
import {
  RailwayProvider,
  RailwayProject,
  RailwayEnvironment,
  RailwayService,
  RailwayBuilder,
  RailwayVariable,
  RailwayProjectToken,
  RailwayDeploy,
} from "@infracraft/pulumi/railway"
import { hash } from "@infracraft/pulumi/hash"

const provider = new RailwayProvider("railway", {
  token: config.requireSecret("railwayToken"),
})

const project = new RailwayProject("my-project", {
  name: "my-app",
}, { provider })

const environment = new RailwayEnvironment("production", {
  name: "production",
}, { provider, project })

const service = new RailwayService("api", {
  name: "api",
  builder: RailwayBuilder.RAILPACK,
  startCommand: "node dist/index.js",
}, { provider, project, environment })

const env = { DATABASE_URL: dbUrl }

new RailwayVariable("api-vars", {
  variables: env,
}, { provider, project, environment, service })

const deployToken = new RailwayProjectToken("api-token", {
  name: "api-deploy",
}, { provider, project, environment })

new RailwayDeploy("api-deploy", {
  triggers: [hash("apps/api"), hash(env)],   // hash(env): a non-secret digest, not raw secret values
}, { provider, project, environment, service, projectToken: deployToken.token })
```

### Railway API surface

| Class | Key outputs | Notes |
|---|---|---|
| `RailwayProvider` | — | Pass as `provider` option to every Railway resource |
| `RailwayProject` | `.id` (project UUID) | Adopt-or-create by name |
| `RailwayEnvironment` | `.id` | Optional `source` env to fork from |
| `RailwayService` | `.id` | Full instance config: builder, healthcheck, restart policy |
| `RailwayDomain` | `.fqdn` | Omit `customDomain` for an auto-generated domain |
| `RailwayVariable` | — | Batch upsert; uses `skipDeploys` to avoid snapshot errors |
| `RailwayVolume` | `.id` | Persistent volume; `mountPath` must be absolute |
| `RailwayProjectToken` | `.token` (secret) | Environment-scoped deploy token; feed into `RailwayDeploy` |
| `RailwayDeploy` | — | Runs `railway up --detach`, then monitors the deployment via the Railway API |

**Enums:** `RailwayBuilder` (`RAILPACK`, `NIXPACKS`, `DOCKERFILE`, `HEROKU`, `PAKETO`), `RailwayRestartPolicy` (`ON_FAILURE`, `ALWAYS`, `NEVER`)

## Neon

```typescript
import {
  NeonProvider,
  NeonProject,
  NeonBranch,
  NeonRole,
  NeonEndpoint,
  NeonDatabase,
} from "@infracraft/pulumi/neon"

const provider = new NeonProvider("neon", {
  apiKey: config.requireSecret("neonApiKey"),
})

const project = new NeonProject("db", { name: "my-app" }, { provider })

// Copy-on-write branch from "main"
const branch = new NeonBranch("prod", {
  name: "production",
  parent: "main",
}, { provider, project })

const role = new NeonRole("owner", {
  name: "neondb_owner",
  resetPassword: true,   // isolate COW branch from parent's password
}, { provider, project, branch })

const endpoint = new NeonEndpoint("prod", {
  minCu: 0.25,
  maxCu: 1,
  suspendTimeout: 300,
}, { provider, project, branch })

const db = new NeonDatabase("app-db", {
  name: "app",
  ownerName: "neondb_owner",
}, { provider, project, branch })

const roleName = "neondb_owner"
const dbName = "app"
const connectionString = pulumi.interpolate`postgresql://${roleName}:${role.password}@${endpoint.host}/${dbName}`
```

### Neon API surface

| Class | Key outputs | Notes |
|---|---|---|
| `NeonProvider` | — | `apiKey` + optional `orgId` |
| `NeonProject` | `.id` | Adopt-or-create by name |
| `NeonBranch` | `.id` | Optional `parent` for copy-on-write branching |
| `NeonEndpoint` | `.host` | Read-write compute endpoint; use `.host` in connection strings |
| `NeonRole` | `.password` (secret) | `resetPassword: true` isolates COW branch passwords from parent |
| `NeonDatabase` | — | `name` + `ownerName` |

## Vercel

```typescript
import {
  VercelProvider,
  VercelProject,
  VercelVariable,
  VercelDeploy,
  VercelIntegration,
  VercelMarketplaceResource,
  VercelResourceConnection,
} from "@infracraft/pulumi/vercel"
import { hash } from "@infracraft/pulumi/hash"

const provider = new VercelProvider("vercel", {
  token: config.requireSecret("vercelToken"),
  teamId: "team_xxx",
})

const project = new VercelProject("web", {
  name: "my-web-app",
  framework: "nextjs",
  rootDirectory: "apps/web",
}, { provider })

// project.url resolves to the custom domain or <name>.vercel.app
export const url = project.url

const vars = new VercelVariable("web-vars", {
  variables: { NEXT_PUBLIC_API_URL: apiUrl },
}, { provider, project })

new VercelDeploy("web-deploy", {
  triggers: [hash("apps/web"), vars.contentHash],
}, { provider, project })

// Marketplace example: provision an Upstash KV store
const integration = new VercelIntegration("upstash", {
  slug: "upstash",
}, { provider })

const store = new VercelMarketplaceResource("kv", {
  integrationConfigurationId: integration.configurationId,
  name: "my-kv",
  type: "kv",
  externalId: "my-kv",
}, { provider })

new VercelResourceConnection("kv-conn", {
  storeId: store.id,
  projectId: project.id,
  targets: ["production", "preview"],
}, { provider })
```

### Vercel API surface

| Class | Key outputs | Notes |
|---|---|---|
| `VercelProvider` | — | `token` + `teamId` |
| `VercelProject` | `.id`, `.url` | `.url` prefers custom domain over `*.vercel.app` |
| `VercelVariable` | `.contentHash` | Use as a deploy trigger to redeploy on env var changes |
| `VercelDeploy` | — | Runs `vercel deploy --prod --yes` |
| `VercelIntegration` | `.configurationId` (`icfg_…`) | Resolves an installed marketplace integration by slug |
| `VercelMarketplaceResource` | `.id`, `.externalResourceId`, `.status` | Provisions a marketplace store |
| `VercelResourceConnection` | — | Wires a store to a project; injects env vars into target environments |

**Helpers:** `VERCEL_FRAMEWORKS` (const array), `VercelFramework` (derived union type)

## Fly.io

```typescript
import {
  FlyProvider,
  FlyApp,
  FlySecret,
  FlyVolume,
  FlyCertificate,
  FlyIp,
  FlyIpType,
  FlyDeploy,
  FlyDeployStrategy,
} from "@infracraft/pulumi/fly"
import { hash } from "@infracraft/pulumi/hash"

// Provider: auth context (token + optional default org)
const provider = new FlyProvider("fly", {
  token: config.requireSecret("flyToken"),
  organization: "personal",
})

// App: adopt-or-create; `.id` is the app name
const app = new FlyApp("api", { name: "rby-api" }, { provider })

// Secrets: managed via the Machines REST secrets API.
// `.version` changes only when the secret set changes.
const secrets = new FlySecret("api-secrets", {
  secrets: { JWT_SECRET: jwt, DATABASE_URL: dbUrl },
}, { provider, app })

// Volume: persistent storage (grow-only)
new FlyVolume("api-data", {
  name: "data",
  region: "iad",
  sizeGb: 10,
}, { provider, app })

// Certificate: ACME cert for a custom hostname
new FlyCertificate("api-cert", {
  hostname: "api.example.com",
}, { provider, app })

// Dedicated/shared IP (Fly GraphQL API)
new FlyIp("api-ip", { type: FlyIpType.SHARED_V4 }, { provider, app })

// Deploy: `fly deploy --remote-only` with consumer-controlled triggers.
// The generated fly.toml content is included in the triggers automatically.
new FlyDeploy("api-deploy", {
  config: {
    app: "rby-api",
    primaryRegion: "iad",
    build: { dockerfile: "apps/api/Dockerfile" },
    httpService: {
      internalPort: 3333,
      forceHttps: true,
      minMachinesRunning: 1,
      checks: [{ method: "GET", path: "/health", interval: "30s", timeout: "10s" }],
    },
    deploy: { strategy: FlyDeployStrategy.ROLLING },
    vm: [{ size: "shared-cpu-1x", memory: "512mb", cpus: 1 }],
  },
  triggers: [hash("apps/api"), secrets.version],
}, { provider, app, dependsOn: [secrets] })
```

**Requirements:** `flyctl` must be installed on the machine running `pulumi up` (used by `FlyDeploy`). Generate a token with `fly tokens create deploy`. Dedicated IP allocation uses the Fly GraphQL API; everything else uses the Machines REST API.

### Fly.io API surface

| Class | Key outputs | Notes |
|---|---|---|
| `FlyApp` | `.id` (app name) | Adopt-or-create |
| `FlySecret` | `.version` | Feed into `FlyDeploy` triggers to redeploy on secret changes |
| `FlyVolume` | `.id` (`vol_…`) | `sizeGb` can only grow |
| `FlyCertificate` | `.id` (hostname), `.configured`, `.dnsRequirements` | `.dnsRequirements` contains ACME validation records |
| `FlyIp` | `.id` (IP address) | `type`: `FlyIpType.V4`, `V6`, `SHARED_V4`, `PRIVATE_V6` |
| `FlyDeploy` | — | Writes fly.toml at deploy time; triggers on config + source hash |

**Enums:** `FlyIpType`, `FlyDeployStrategy` (`ROLLING`, `IMMEDIATE`, `CANARY`, `BLUEGREEN`), `FlyRestartPolicy` (`ALWAYS`, `ON_FAILURE`, `NEVER`), `FlyAutoStopMachines` (`OFF`, `STOP`, `SUSPEND`), `FlyConcurrencyType` (`CONNECTIONS`, `REQUESTS`), `FlyServiceProtocol` (`TCP`, `UDP`), `FlyPortHandler` (`HTTP`, `TLS`, `PG_TLS`, `PROXY_PROTO`, `EDGE_HTTP`), `FlyCpuKind` (`SHARED`, `PERFORMANCE`), `FlyCheckType` (`HTTP`, `TCP`)

**Constants:** `FLY_REGIONS` (IATA codes array), `FlyRegion` (derived type), `FLY_VM_SIZES` (size preset array), `FlyVmSize` (derived type)

**fly.toml types:** `FlyTomlConfig`, `FlyBuildConfig`, `FlyHttpService`, `FlyService`, `FlyServicePort`, `FlyMount`, `FlyVm`, `FlyDeployConfig`, `FlyRestartConfig`, `FlyCheck`, `FlyConcurrency`

**Helper:** `generateFlyToml(config)` serializes a `FlyTomlConfig` to fly.toml text (camelCase to snake_case, deterministic output).

## Agents

Emit operating reminders for AI coding agents (Claude Code, Copilot, etc.) working on the stack. Auto-detects an agent via `CLAUDECODE` / `AI_AGENT` env vars; a no-op for humans unless `enabled` is forced.

```typescript
import * as agents from "@infracraft/pulumi/agents"

agents.hint({
  project: [
    "Production branch is `main`; never destroy it.",
    "All Railway services share one project; only environments are per-feature.",
  ],
  // channel: "stderr" (default) | "pulumi-log"
})
```

Hints are emitted inside a `<infracraft-hint>` block with infracraft defaults (adopt-or-create, no-op deletes for shared resources, protect-for-shared) plus caller-supplied `project` reminders.

### Agents API surface

| Export | Kind | Notes |
|---|---|---|
| `hint(options?)` | function | Emits the hint block; no-op outside agent context |
| `AgentHintOptions` | type | `project?` (string[]), `enabled?` (boolean), `channel?` (`"stderr"` or `"pulumi-log"`) |

## Hash

Produce a stable digest to use as a deploy trigger element. Accepts a source directory path (synchronous, returns `string`), a key-value env var map (returns `Output<string>`), or, via `hashApp`, an app directory plus its transitive workspace dependencies.

```typescript
import { hash, hashApp } from "@infracraft/pulumi/hash"

// Hash a source directory
const sourceHash = hash("apps/api")

// Hash an app + every workspace package it depends on (transitively);
// a change to a shared packages/* the app uses retriggers its deploy
const appHash = hashApp(monorepoRoot, "apps/api")

// Hash an env var map into a single non-secret digest (Output<string>)
const envHash = hash({ DATABASE_URL: dbUrl, JWT_SECRET: jwt })

new RailwayDeploy("api-deploy", {
  triggers: [appHash, envHash],
}, { provider, project, environment, service, projectToken: deployToken.token })
```

### Hash API surface

| Export | Kind | Notes |
|---|---|---|
| `hash(directory, options?)` | function | Recursive file name + content digest; skips build/VCS directories |
| `hash(env)` | function | Sorted-key digest of resolved values; returned `Output<string>` is non-secret |
| `hashApp(monorepoRoot, appDirectory, options?)` | function | Hashes the app and its transitive `apps/*`/`packages/*` workspace dependencies |

## Sandbox & Git Guard

Deploy isolation as `dependsOn` markers. Listing a `DeploySandbox` in a deploy's `dependsOn` runs that deploy's CLI from an isolated copy of the repo's tracked files under `/tmp/infracraft` (stale sandboxes are garbage-collected automatically). Adding a `GitGuard` swaps the copy's `.git` for a fresh stub (`git init` + `git add -A`, unborn HEAD).

```typescript
import { DeploySandbox } from "@infracraft/pulumi/sandbox"
import { GitGuard } from "@infracraft/pulumi/git-guard"
import { hash } from "@infracraft/pulumi/hash"

const sandbox = new DeploySandbox("sandbox")
const guard = new GitGuard("git-guard")

// Runs `vercel deploy` from an isolated copy with a stub `.git`
new VercelDeploy("web-deploy", {
  triggers: [hash("apps/web")],
  excludePaths: ["apps/docs"],   // drop other apps from the upload (stub mode only)
}, { provider, project, dependsOn: [sandbox, guard] })
```

| `dependsOn` markers | Working copy | `.git` sent to the platform |
|---|---|---|
| none | Live repo tree | The real one; whatever the platform CLI picks up |
| `DeploySandbox` | Isolated `/tmp/infracraft` copy | Real `.git` (copy-on-write copy) |
| `DeploySandbox` + `GitGuard` | Isolated copy, `excludePaths` applied | A fresh stub (`git init` + `git add -A`, unborn HEAD) |
| `GitGuard` alone | — | Throws: the guard needs a sandbox to act on |

### Sandbox & Git Guard API surface

| Export | Kind | Notes |
|---|---|---|
| `DeploySandbox` | ComponentResource | Isolation marker + workspace lifecycle; GCs sandboxes older than 3h |
| `GitGuard` | ComponentResource | Stub-`.git` marker; requires a `DeploySandbox` alongside it |
| `SandboxMode` | enum | `NONE`, `ORIGINAL`, `STUB`; derived from the markers by the deploy seam |
| `buildSandboxScript(options)` | function | Builds the sandboxed shell a deploy command runs (used by the deploy resources) |
| `buildSandboxFileFilter(excludePaths)` | function | Portable awk filter applied to `git ls-files` before the copy |
| `isDeploySandbox(value)` / `isGitGuard(value)` | functions | Bundle-safe marker checks |

## Design

**Context-based**: Resources inherit auth, project, and environment from their options; no manual ID passing.

**Adopt-or-create**: Existing infrastructure is discovered by name and adopted into Pulumi state. Run `pulumi up` against a pre-existing project and it just works.

**Consumer-controlled protection**: Use `protect: true` on shared/production resources to prevent accidental deletion. Deploy resources accept a `triggers` array; you decide what causes a redeploy.

**Consumer-controlled triggers**: Hash source directories, env values, or anything else. Pass results into `triggers` arrays.

## Why

| Provider | Existing options | Gap |
|---|---|---|
| Railway | Nothing. Zero Pulumi providers exist. | **We are the Railway Pulumi provider.** |
| Neon | Bridged TF provider; fails on pre-existing resources | Adopt-or-create without manual `import` blocks |
| Vercel | `@pulumiverse/vercel`; no adopt-or-create, no CLI deploys | Adopt-or-create projects + consumer-controlled deploy triggers |
| Fly.io | `@ediri/pulumi-fly`; bridges a Terraform provider Fly archived March 2024, no secrets support | Hand-rolled `dynamic` resources matching every other provider: secrets, adopt-or-create, consumer-controlled deploys; no unmaintained upstream |

## License

MIT
