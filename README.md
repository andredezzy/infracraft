<p align="center">
  <b>infracraft</b>
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

Current version: **1.12.0**

## Providers

| | Provider | Import | What it does |
|---|---|---|---|
| 🚂 | **Railway** | `@infracraft/pulumi/railway` | The only Pulumi provider for Railway. Projects, environments, services, variables, volumes, domains, deploys. |
| 🐘 | **Neon** | `@infracraft/pulumi/neon` | Adopt-or-create layer for Neon Postgres. Projects, branches, endpoints, roles, databases. |
| ▲ | **Vercel** | `@infracraft/pulumi/vercel` | Projects with adopt-or-create, deploy orchestration, marketplace resources, and sensitive env var drift detection. |
| 🎯 | **Fly.io** | `@infracraft/pulumi/fly` | App, Secret, Volume, Certificate, IP, and Deploy resources via the Machines REST API and Fly GraphQL API. |
| 🤖 | **Agents** | `@infracraft/pulumi/agents` | Emit operating hints for AI coding agents working on the stack. |
| #️⃣ | **Hash** | `@infracraft/pulumi/hash` | Deterministic directory/env-var hashing for deploy triggers. |
| 🔒 | **Git Guard** | `@infracraft/pulumi/git-guard` | Parallel-safe `.git` protection for concurrent CLI deploys. |

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

const sourceHash = hash("apps/api")

const deployToken = new RailwayProjectToken("api-token", {
  name: "api-deploy",
}, { provider, project, environment })

new RailwayDeploy("api-deploy", {
  directory: monorepoRoot,
  triggers: [sourceHash, hash(env)],   // hash(env): a non-secret digest, not raw secret values
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
| `RailwayDeploy` | — | Runs `railway up --ci`; serializes uploads via a lock |

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

const sourceHash = hash("apps/web")

new VercelDeploy("web-deploy", {
  monorepoRoot,
  triggers: [sourceHash, vars.contentHash],
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

**Helpers:** `VERCEL_FRAMEWORKS` (const array), `VercelFramework` (derived union type), `pickProductionDomain` (internal utility, not exported from the public subpath)

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

// Provider — auth context (token + optional default org)
const provider = new FlyProvider("fly", {
  token: config.requireSecret("flyToken"),
  organization: "personal",
})

// App — adopt-or-create; `.id` is the app name
const app = new FlyApp("api", { name: "rby-api" }, { provider })

// Secrets — managed via the Machines REST secrets API.
// `.version` changes only when the secret set changes.
const secrets = new FlySecret("api-secrets", {
  secrets: { JWT_SECRET: jwt, DATABASE_URL: dbUrl },
}, { provider, app })

// Volume — persistent storage (grow-only)
new FlyVolume("api-data", {
  name: "data",
  region: "iad",
  sizeGb: 10,
}, { provider, app })

// Certificate — ACME cert for a custom hostname
new FlyCertificate("api-cert", {
  hostname: "api.example.com",
}, { provider, app })

// Dedicated/shared IP (Fly GraphQL API)
new FlyIp("api-ip", { type: FlyIpType.SHARED_V4 }, { provider, app })

// Deploy — `fly deploy --remote-only` with consumer-controlled triggers.
// The generated fly.toml content is included in the triggers automatically.
new FlyDeploy("api-deploy", {
  monorepoRoot,
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

Emit operating reminders for AI coding agents (Claude Code, Copilot, etc.) working on the stack. Auto-detects an agent via `CLAUDECODE` / `AI_AGENT` env vars — a no-op for humans unless `enabled` is forced.

```typescript
import * as agents from "@infracraft/pulumi/agents"

agents.hint({
  project: [
    "Production branch is `main` — never destroy it.",
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

Produce a stable digest to use as a deploy trigger element. Accepts a source directory path (synchronous, returns `string`) or a key-value env var map (returns `Output<string>`).

```typescript
import { hash } from "@infracraft/pulumi/hash"

// Hash a source directory
const sourceHash = hash("apps/api")

// Hash an env var map (Output<string>)
const envHash = hash({ DATABASE_URL: dbUrl, JWT_SECRET: jwt })

new RailwayDeploy("api-deploy", {
  directory: monorepoRoot,
  triggers: [sourceHash, envHash],
}, { provider, project, environment, service })
```

## Git Guard

Hides the monorepo's `.git` directory before any deploy command runs — preventing tools like `vercel deploy` from ingesting full git history — and restores it on process exit. Self-healing: recovers guard directories left by killed runs.

```typescript
import { gitGuard, GUARD_DIR } from "@infracraft/pulumi/git-guard"

// Call once at the top of your Pulumi program, before any deploy resources
const guard = gitGuard("/path/to/repo")

// All VercelDeploy / FlyDeploy / RailwayDeploy resources run with .git hidden
```

### Git Guard API surface

| Export | Kind | Notes |
|---|---|---|
| `gitGuard(monorepoRoot)` | function | Hides `.git` before deploys; restores on exit; returns `{ hide }` |
| `recoverStaleGuard(root)` | function | Restores a guard directory left by a killed run; called automatically by `gitGuard` |
| `hideGit(root)` | function | Moves `.git` to the guard directory; idempotent |
| `restoreGit(root)` | function | Moves `.git` back from the guard directory; no-op if nothing is hidden |
| `ensureGitignore(gitignorePath)` | function | Appends the guard directory name to `.gitignore` if absent |
| `GUARD_DIR` | const | `".git-infracraft-pulumi-guard"` |
| `LEGACY_GUARD_DIRS` | const | Guard names from older releases; auto-recovered on startup |

## Design

**Context-based**: Resources inherit auth, project, and environment from their options — no manual ID passing.

**Adopt-or-create**: Existing infrastructure is discovered by name and adopted into Pulumi state. Run `pulumi up` against a pre-existing project and it just works.

**Consumer-controlled protection**: Use `protect: true` on shared/production resources to prevent accidental deletion. Deploy resources accept a `triggers` array — you decide what causes a redeploy.

**Consumer-controlled triggers**: Hash source directories, env values, or anything else. Pass results into `triggers` arrays.

## Why

| Provider | Existing options | Gap |
|---|---|---|
| Railway | Nothing. Zero Pulumi providers exist. | **We are the Railway Pulumi provider.** |
| Neon | Bridged TF provider — fails on pre-existing resources | Adopt-or-create without manual `import` blocks |
| Vercel | `@pulumiverse/vercel` — no adopt-or-create, no CLI deploys | Adopt-or-create projects + consumer-controlled deploy triggers |
| Fly.io | `@ediri/pulumi-fly` — bridges a Terraform provider Fly archived March 2024; no secrets support | Hand-rolled `dynamic` resources matching every other provider — secrets, adopt-or-create, consumer-controlled deploys; no unmaintained upstream |

## Recent releases

### v1.12.0 (current) — Unified `hash()`
- Merges `hashDirectory` and the env-fingerprint helper into one overloaded `hash()`: a directory path hashes file contents (synchronous `string`), an env map hashes to a single non-secret `Output<string>` digest
- Building a deploy trigger from `hash(env)` instead of spreading raw secret values keeps secret `Output`s out of dynamic-resource state, avoiding the Pulumi #16041 serialization race — deploys are safe to create at full parallelism (no `--parallel 1`)

### v1.11.0 — agents.hint namespace
- Refines the v1.10.0 agent-hint API into an `agents` namespace: call `agents.hint(...)` via `import * as agents from "@infracraft/pulumi/agents"`
- Replaces the flat `agentHint` function (previously accessible only as an internal export) with the `agents.hint(...)` namespace API
- Opens the `agents/` namespace for future agent utilities

### v1.10.0 — agentHint: reminders for AI coding agents
- Adds `@infracraft/pulumi/agents` — surfaces a stack's operating rules to AI coding agents, modeled on Vercel's AGENTS.md guidance
- Emits a delimited `<infracraft-hint>` block with infracraft defaults plus caller-supplied reminders
- Auto-detects an AI agent via `CLAUDECODE` / `AI_AGENT` env vars; no-op for humans
- Defaults to `channel: "stderr"` so hints appear before Pulumi output; `"pulumi-log"` routes through Diagnostics

### v1.9.0 — Protection belongs to the consumer
- Removes the `wasAdopted` gate from v1.8.0 — provider logic no longer reimplements Pulumi's native `protect` option
- `RailwayEnvironment`, `VercelProject`, and `NeonBranch` now delete unconditionally; use `protect: true` to guard shared/production resources
- `RailwayService` retains its unconditional no-op delete because it is project-level and shared across all environments

### v1.8.0 — Safe destroy: delete only what Pulumi created
- `RailwayEnvironment`, `VercelProject`, and `NeonBranch` record `wasAdopted` at create time and only delete resources they created
- `RailwayService.delete` is now an unconditional no-op

### v1.7.1 — Fix VercelProject.url resolution
- `VercelProject.url` is now resolved via `Output.apply` (fetched from Vercel's API each run) instead of persisted dynamic-resource state

### v1.7.0 — Expose VercelProject.url
- Adds a `url` output on `VercelProject`; prefers custom production domain over `<name>.vercel.app`

### v1.6.6 — Isolate copy-on-write role passwords
- Isolates copy-on-write Neon role passwords reset on non-parent branches
- Hardens dynamic secret outputs via `additionalSecretOutputs`

### v1.6.0 — Multi-environment building blocks
- Adds `NeonBranch.parent` for copy-on-write branching
- Adds `RailwayEnvironment` with optional fork from a source environment
- Adds Vercel marketplace primitives: `VercelIntegration`, `VercelMarketplaceResource`, `VercelResourceConnection`

## License

MIT
