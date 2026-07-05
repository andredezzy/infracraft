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

## Design principles

- **Resources model single API objects.** Each resource wraps exactly one platform API object, and argument names mirror the platform API's field names (where a name deviates, its JSDoc documents the mapped field).
- **Context-based.** Resources inherit auth, project, and environment from their options (`{ provider, project, environment }`); no manual ID passing.
- **Adopt-or-create IS the import principle.** `pulumi import` is unimplemented for dynamic providers, so `create()` looks the object up by name and adopts it before creating a new one. Run `pulumi up` against a pre-existing project and it just works.
- **Reads reconcile drift.** A resource deleted out of band returns blank on `pulumi refresh` and gets recreated on the next `up`. Write-once secrets and env-var batches are deliberate pass-throughs — their stored state is the source of truth.
- **Deletes are conservative — and idempotent.** Shared containers (Railway/Neon projects, Railway services, Fly apps) and data stores (Vercel marketplace resources) are never deleted by Pulumi; deleting an already-gone resource succeeds instead of stranding state. Guard everything else that is shared or production-grade with `protect: true`; volumes honor `retainOnDelete`.
- **Inputs fail at plan time.** `check()` rejects locally decidable mistakes during preview with the offending property named: `RailwayVolume.mountPath` (must be absolute), `RailwayService.source.image` / `RailwayProjectToken.name` / `NeonBranch.name` / `NeonRole.name` (non-empty), `VercelProject.name` (Vercel's published naming rule), `FlyVolume.sizeGb` (positive integer). Preview-unknown inputs are skipped, never failed.
- **Previews stay faithful.** Identity outputs that provably survive an in-place update are declared stable (`RailwayProject.id`, `RailwayService.id`, `NeonProject.id`, `NeonEndpoint.host`, `NeonRole`'s identity, `VercelProject.id`, `FlyVolume.id`), so dependents keep known values during preview instead of showing phantom replaces. `NeonRole.password` is deliberately not stable — a rotation must cascade.
- **One resilient transport.** All HTTP goes through a single fetch wrapper with a per-attempt timeout, bounded retries on transient failures (network errors, 5xx, 429), and `Retry-After` support. See [Transport & errors](#transport--errors).
- **Secrets stay secret.** Provider credentials and minted values are marked secret in Pulumi state, and deploy tokens travel via stdin — never in command text. Better yet, credentials can stay out of state entirely: every provider accepts the credential as an env var *name* instead of a value — see [Provider credentials](#provider-credentials).
- **Consumer-controlled triggers and protection.** Deploy resources accept a `triggers` array — hash source directories, env values, or anything else; you decide what causes a redeploy. Use `protect: true` on shared/production resources to prevent accidental deletion.

## Providers

| | Provider | Import | What it does |
|---|---|---|---|
| 🚂 | **Railway** | `@infracraft/pulumi/railway` | The only Pulumi provider for Railway. Projects, environments, services, variables, volumes, domains, deploy tokens, deploys. |
| 🐘 | **Neon** | `@infracraft/pulumi/neon` | Adopt-or-create layer for Neon Postgres. Projects, branches, endpoints, roles, databases. |
| ▲ | **Vercel** | `@infracraft/pulumi/vercel` | Projects with adopt-or-create, deploy orchestration, custom domains, marketplace resources, and sensitive env var drift detection. |
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

## Provider credentials

Every provider takes its API credential in one of two mutually exclusive forms — the constructor throws unless exactly one is set:

- **Env-var-first (recommended)** — `tokenEnvVar` (Neon: `apiKeyEnvVar`): the *name* of an environment variable holding the credential. Resources carry only the plain name; each dynamic-provider operation reads the value from the environment at execution time and fails loudly — naming the variable — when it is unset.
- **Direct** — `token` (Neon: `apiKey`): a secret `Input<string>`, marked secret in per-resource state via `additionalSecretOutputs`.

```typescript
const railway = new RailwayProvider("railway", { tokenEnvVar: "RAILWAY_TOKEN" })
const neon = new NeonProvider("neon", { apiKeyEnvVar: "NEON_API_KEY" })
const vercel = new VercelProvider("vercel", { tokenEnvVar: "VERCEL_TOKEN", teamId: "team_xxx" })
const fly = new FlyProvider("fly", { tokenEnvVar: "FLY_API_TOKEN" })
```

Prefer the env-var form. It keeps the credential out of dynamic-resource inputs and per-resource state entirely, which removes the substrate for [pulumi/pulumi#16041](https://github.com/pulumi/pulumi/issues/16041) ("Unexpected struct type": secret Outputs in dynamic-provider inputs intermittently fail engine serialization — closed not-planned upstream) and matches how first-class provider configuration handles credentials. Dynamic-provider operations execute in the Pulumi CLI's plugin process, which inherits the program's environment — so variables provided by the shell or by an ESC environment's `environmentVariables` block reach them.

The deploy components that feed the credential to a CLI (`VercelDeploy`, `FlyDeploy`) and program-runtime lookups (`VercelProject.url`) resolve the env var at program runtime into a secret Output, so the command env still receives the actual value without it ever becoming a dynamic-resource input.

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
  tokenEnvVar: "RAILWAY_TOKEN",   // or token: config.requireSecret("railwayToken")
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

// Image-sourced service: the provider applies `source` to the target
// environment's instance and owns its deploys (`serviceInstanceDeployV2`) —
// on create and on config changes. No RailwayDeploy needed; code services
// (like `api` above) deploy via RailwayDeploy instead. Secret-bearing start
// commands (e.g. `redis-server --requirepass …`) belong in `startCommand`.
new RailwayService("redis", {
  name: "redis",
  source: { image: "redis:8-alpine" },
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
  healthcheckPath: "/health",                // applied post-deploy by the monitor (see Healthcheck config)
}, { provider, project, environment, service, projectToken: deployToken.token })
```

### Railway API surface

| Class | Key outputs | Notes |
|---|---|---|
| `RailwayProvider` | — | Pass as `provider` option to every Railway resource. `token` or `tokenEnvVar` — see [Provider credentials](#provider-credentials) |
| `RailwayProject` | `.id` (project UUID) | Adopt-or-create by name |
| `RailwayEnvironment` | `.id` | Optional `source` env to fork from |
| `RailwayService` | `.id` | Instance config (builder, commands, healthcheck, restart policy) applied per target environment; image services (`source.image`) are deployed by the provider itself. Healthcheck fields a fresh instance rejects are re-applied post-deploy — see [Healthcheck config](#railway-api-surface) below |
| `RailwayDomain` | `.fqdn`, `.cnameTarget`, `.verificationTxtName` / `.verificationTxtValue` | Omit `customDomain` for an auto-generated domain; custom domains expose the CNAME target and ownership-verification TXT record to write into DNS |
| `RailwayVariable` | — | Batch upsert; uses `skipDeploys` to avoid snapshot errors |
| `RailwayVolume` | — | Persistent volume; `mountPath` must be absolute. Adoption matches BOTH service and environment (never a sibling environment's volume); a newly attached volume redeploys its service so the mount lands |
| `RailwayProjectToken` | `.token` (secret) | Environment-scoped deploy token; feed into `RailwayDeploy`. Bump `tokenVersion` to rotate — see [Rotating credentials](#rotating-credentials) |
| `RailwayDeploy` | `.deploymentUrl` | Runs `railway up --detach`, then monitors the deployment via the Railway API (the API, not the CLI exit code, decides pass/fail). Also accepts `excludePaths`, `railpackConfig`, and `healthcheckPath` / `healthcheckTimeout` (applied by the monitor post-deploy) |

**Enums:** `RailwayBuilder` (`RAILPACK`, `NIXPACKS`, `DOCKERFILE`, `HEROKU`, `PAKETO`), `RailwayRestartPolicy` (`ON_FAILURE`, `ALWAYS`, `NEVER`)

**Deploy token security:** `RailwayDeploy` pipes the project token to `railway up` via the command's stdin — never in the script text. pulumi-command embeds the executed command verbatim in its failure error and Pulumi does not scrub secrets from provider diagnostics, so an inlined token would print in plaintext exactly when a deploy fails.

**Healthcheck config:** Railway rejects healthcheck fields on a fresh service instance with no deployment (`serviceInstanceUpdate` fails with "Invalid input"), so a from-zero `up` cannot set them at configure time. `RailwayService` still sends them on the first attempt — an instance with existing deployments accepts them in one call — and when the API rejects, drops them for the retry and guarantees they land later instead of silently losing them: for image services the provider re-applies them right after its own `serviceInstanceDeployV2`; for code services pass `healthcheckPath` / `healthcheckTimeout` to `RailwayDeploy` too, and its monitor applies them once the deployment reaches a live status. Either re-apply failing fails the resource loudly — healthcheck config is never dropped silently.

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
  apiKeyEnvVar: "NEON_API_KEY",   // or apiKey: config.requireSecret("neonApiKey")
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
| `NeonProvider` | — | `apiKey` or `apiKeyEnvVar` (see [Provider credentials](#provider-credentials)) + optional `orgId` |
| `NeonProject` | `.id` | Adopt-or-create by name |
| `NeonBranch` | `.id` | Optional `parent` for copy-on-write branching |
| `NeonEndpoint` | `.host` | Read-write compute endpoint; use `.host` in connection strings |
| `NeonRole` | `.password` (secret) | `resetPassword: true` isolates COW branch passwords from parent. Bump `passwordVersion` to rotate — see [Rotating credentials](#rotating-credentials) |
| `NeonDatabase` | — | `name` + `ownerName` |

## Rotating credentials

Minted credentials rotate through a version-bump input — no target-replace URN archaeology, no manual revoke-then-recreate. Bump the number, run `up`, and everything consuming the credential (connection strings, env vars, dependent redeploys) cascades automatically:

```typescript
// Mints a fresh token BEFORE revoking the old one (create-before-delete),
// so there is never a tokenless window.
const deployToken = new RailwayProjectToken("api-token", {
  name: "api-deploy",
  tokenVersion: 2,   // bump to rotate
}, { provider, project, environment })

// Resets the password IN PLACE via Neon's reset_password endpoint — an
// update, never a replace (a replace would try to delete the role, which
// Neon refuses for default roles and which would drop grants for others).
const role = new NeonRole("owner", {
  name: "neondb_owner",
  passwordVersion: 2,   // bump to rotate
}, { provider, project, branch })
```

Leave the version unset until the first rotation is needed. Identity changes (name, project, environment) still replace normally.

## Vercel

```typescript
import {
  VercelProvider,
  VercelProject,
  VercelVariable,
  VercelDeploy,
  VercelDomain,
  VercelIntegration,
  VercelMarketplaceResource,
  VercelResourceConnection,
} from "@infracraft/pulumi/vercel"
import { hash } from "@infracraft/pulumi/hash"

const provider = new VercelProvider("vercel", {
  tokenEnvVar: "VERCEL_TOKEN",   // or token: config.requireSecret("vercelToken")
  teamId: "team_xxx",
})

const project = new VercelProject("web", {
  name: "my-web-app",
  framework: "nextjs",
  rootDirectory: "apps/web",
}, { provider })

// project.url is a full https:// URL — custom domain or <name>.vercel.app
export const url = project.url

const vars = new VercelVariable("web-vars", {
  variables: { NEXT_PUBLIC_API_URL: apiUrl },
}, { provider, project })

new VercelDeploy("web-deploy", {
  triggers: [hash("apps/web"), vars.contentHash],
}, { provider, project })

// Custom domain: point the domain's DNS CNAME at `cnameTarget`
const domain = new VercelDomain("web-domain", {
  name: "app.example.com",
}, { provider, project })

export const cnameTarget = domain.cnameTarget

// Marketplace example: provision an Upstash KV store
const integration = new VercelIntegration("upstash", {
  slug: "upstash",
}, { provider })

const store = new VercelMarketplaceResource("kv", {
  integrationConfigurationId: integration.configurationId,
  name: "my-kv",
  type: "upstash-kv",   // the integration's product ID or slug
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
| `VercelProvider` | — | `token` or `tokenEnvVar` (see [Provider credentials](#provider-credentials)) + `teamId` |
| `VercelProject` | `.id`, `.url` | `.url` is a full `https://` URL; prefers the custom production domain over `<name>.vercel.app`. Deletes the project on destroy — `protect: true` production projects |
| `VercelVariable` | `.contentHash` | Use as a deploy trigger to redeploy on env var changes. Takes `opts.project` or `args.projectId` |
| `VercelDeploy` | `.deploymentUrl` | Runs `vercel deploy --prod --yes` |
| `VercelDomain` | `.name`, `.verified`, `.cnameTarget` | Attaches a custom domain to a project (adopt-or-create); `.cnameTarget` is Vercel's own DNS recommendation for that specific domain |
| `VercelIntegration` | `.configurationId` (`icfg_…`) | Resolves an installed marketplace integration by slug (install it once via the dashboard first) |
| `VercelMarketplaceResource` | `.id`, `.externalResourceId`, `.status` | Provisions a marketplace store; `type` is the integration product ID or slug |
| `VercelResourceConnection` | — | Wires a store to a project; injects env vars into target environments (`makeEnvVarsSensitive` defaults to `true` — then `targets` must not include `development`) |
| `VercelClient` | — | Typed REST client behind every Vercel resource (`get` / `tryGet` / `post` / `patch` / `delete`); appends `teamId` to every request and rides the resilient transport |

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
  tokenEnvVar: "FLY_API_TOKEN",   // or token: config.requireSecret("flyToken")
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

**Requirements:** `flyctl` must be installed on the machine running `pulumi up` (used by `FlyDeploy`) — call `assertHostBinaries(["fly"])` from `@infracraft/pulumi/sandbox` at program start to fail fast with an install hint instead of mid-deploy. Generate a token with `fly tokens create deploy`. Dedicated IP allocation uses the Fly GraphQL API; everything else uses the Machines REST API.

### Fly.io API surface

| Class | Key outputs | Notes |
|---|---|---|
| `FlyProvider` | — | Pass as `provider` option to every Fly resource. `token` or `tokenEnvVar` — see [Provider credentials](#provider-credentials) |
| `FlyApp` | `.id` (app name) | Adopt-or-create |
| `FlySecret` | `.version` | Feed into `FlyDeploy` triggers to redeploy on secret changes |
| `FlyVolume` | `.id` (`vol_…`) | `sizeGb` can only grow |
| `FlyCertificate` | `.id` (hostname), `.configured`, `.dnsRequirements` | `.dnsRequirements` contains ACME validation records |
| `FlyIp` | `.id` (IP address) | `type`: `FlyIpType.V4`, `V6`, `SHARED_V4`, `PRIVATE_V6` |
| `FlyDeploy` | `.deploymentUrl` | Writes fly.toml at deploy time; triggers on config + source hash. Optional `waitTimeout`, `releaseCommandTimeout`, `highAvailability` |

**Enums:** `FlyIpType`, `FlyDeployStrategy` (`ROLLING`, `IMMEDIATE`, `CANARY`, `BLUEGREEN`), `FlyRestartPolicy` (`ALWAYS`, `ON_FAILURE`, `NEVER`), `FlyAutoStopMachines` (`OFF`, `STOP`, `SUSPEND`), `FlyConcurrencyType` (`CONNECTIONS`, `REQUESTS`), `FlyServiceProtocol` (`TCP`, `UDP`), `FlyPortHandler` (`HTTP`, `TLS`, `PG_TLS`, `PROXY_PROTO`, `EDGE_HTTP`), `FlyCpuKind` (`SHARED`, `PERFORMANCE`), `FlyCheckType` (`HTTP`, `TCP`)

**Constants:** `FLY_REGIONS` (IATA codes array), `FlyRegion` (derived type), `FLY_VM_SIZES` (size preset array), `FlyVmSize` (derived type)

**fly.toml types:** `FlyTomlConfig`, `FlyBuildConfig`, `FlyHttpService`, `FlyService`, `FlyServicePort`, `FlyMount`, `FlyVm`, `FlyCpuCount`, `FlyDeployConfig`, `FlyRestartConfig`, `FlyCheck`, `FlyConcurrency`, `FlyDnsRequirements`

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
| `buildSandboxFileFilter(excludePaths)` | function | Portable awk filter applied to `git ls-files` before the copy; keeps each excluded directory's `package.json` so the workspace graph survives |
| `assertHostBinaries(binaries)` | function | Preflight doctor: throws one error naming ALL missing host binaries, with install hints. Re-exported from [`@infracraft/sandbox`](https://www.npmjs.com/package/@infracraft/sandbox) |
| `isDeploySandbox(value)` / `isGitGuard(value)` | functions | Bundle-safe marker checks |

`DeploySandbox` runs the preflight for the core POSIX set (`git`, `rsync`, `awk`, `mktemp`) automatically, so a broken host fails fast instead of midway through a deploy script. Call `assertHostBinaries(["railway"])` / `["vercel"]` / `["fly"]` at program start to preflight the platform CLIs your deploys use — see [`@infracraft/sandbox`](../sandbox) for the full doctor.

## Transport & errors

Every provider client (`RailwayClient`, `NeonClient`, `VercelClient`, `FlyClient`) routes its HTTP through one resilient fetch wrapper: a 15s per-attempt timeout, up to 3 attempts on transient failures (network errors, 5xx, 429), a numeric `Retry-After` honored on 429 (capped at 30s), and exponential backoff otherwise (1s/2s/4s, capped at 20s) — everything else, including non-429 4xx, returns to the caller untouched. The REST clients turn a 404 into a typed `ApiNotFoundError` (carrying the provider and path), and catch sites test `instanceof` rather than matching message strings: adopt-or-create lookups turn it into "create", `read()` turns it into a blank result so `pulumi refresh` reconciles out-of-band deletions, and `delete()` turns it into an idempotent no-op.

## Why

| Provider | Existing options | Gap |
|---|---|---|
| Railway | Nothing. Zero Pulumi providers exist. | **We are the Railway Pulumi provider.** |
| Neon | Bridged TF provider; fails on pre-existing resources | Adopt-or-create without manual `import` blocks |
| Vercel | `@pulumiverse/vercel`; no adopt-or-create, no CLI deploys | Adopt-or-create projects + consumer-controlled deploy triggers |
| Fly.io | `@ediri/pulumi-fly`; bridges a Terraform provider Fly archived March 2024, no secrets support | Hand-rolled `dynamic` resources matching every other provider: secrets, adopt-or-create, consumer-controlled deploys; no unmaintained upstream |

## Release history

See [CHANGELOG.md](CHANGELOG.md) for release history.

## License

MIT
