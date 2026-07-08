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
- **Reads reconcile drift.** A resource deleted out of band returns blank on `pulumi refresh` and gets recreated on the next `up`. The one deliberate pass-through left is `railway.ProjectToken.value` — Railway never re-exposes a minted token via its API, so the stored secret is the only source of truth (the token's continued *existence*, though, is re-checked via a live list, and a revoked-via-dashboard token is reconciled like any other out-of-band deletion).
- **Deletes are conservative — and idempotent.** Shared containers (Railway/Neon projects, Railway services, Fly apps) and data stores (Vercel marketplace resources) are never deleted by Pulumi; deleting an already-gone resource succeeds instead of stranding state. Guard everything else that is shared or production-grade with `protect: true`; volumes honor `retainOnDelete`.
- **Inputs fail at plan time.** `check()` rejects locally decidable mistakes during preview with the offending property named: `railway.Volume.mountPath` (must be absolute), `railway.Service.source.image` / `railway.ProjectToken.name` / `railway.Project.name` / `railway.Environment.name` / `neon.Branch.name` / `neon.Role.name` (non-empty), `neon.Endpoint` (`maxCu >= minCu`), `fly.Volume.sizeGb` (positive integer). Preview-unknown inputs are skipped, never failed.
- **Previews stay faithful.** Identity outputs that provably survive an in-place update are declared stable (`railway.Project.id`, `railway.Service.id`, `neon.Project.id`, `neon.Endpoint.host`, `neon.Role`'s identity, `fly.Volume.id`), so dependents keep known values during preview instead of showing phantom replaces. `neon.Role.password` is deliberately not stable — a rotation must cascade.
- **One resilient transport.** All HTTP goes through a single fetch wrapper with a per-attempt timeout, bounded retries on transient failures (network errors, 5xx, 429), and `Retry-After` support. See [Transport & errors](#transport--errors).
- **Secrets stay secret.** Provider credentials and minted values are marked secret in Pulumi state, and deploy tokens travel via stdin — never in command text. Better yet, credentials can stay out of state entirely: every provider accepts the credential as an env var *name* instead of a value — see [Provider credentials](#provider-credentials).
- **Consumer-controlled triggers and protection.** Deploy resources accept a `triggers` array — hash source directories, env values, or anything else; you decide what causes a redeploy. Use `protect: true` on shared/production resources to prevent accidental deletion.

## Providers

| | Provider | Import | What it does |
|---|---|---|---|
| 🚂 | **Railway** | `@infracraft/pulumi/railway` | The only Pulumi provider for Railway. Projects, environments, services, variables, volumes, domains, deploy tokens, deploys. |
| 🐘 | **Neon** | `@infracraft/pulumi/neon` | Adopt-or-create layer for Neon Postgres. Projects, branches, endpoints, roles, databases. |
| ▲ | **Vercel** | `@infracraft/pulumi/vercel` | CLI deploy orchestration and marketplace resources. Projects, domains, and env vars belong to the official `@pulumiverse/vercel` provider. |
| 🎯 | **Fly.io** | `@infracraft/pulumi/fly` | App, Secret, Volume, Certificate, IP, and Deploy resources via the Machines REST API and Fly GraphQL API. |
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

- **Env-var-first (recommended)** — `tokenEnvVar` (Neon: `apiKeyEnvVar`): the *name* of an environment variable holding the credential. Resources carry only the plain name; each dynamic-provider operation reads the value from the environment at execution time and fails loudly — naming the variable — when it is unset or has leading/trailing whitespace (a common symptom of a secret piped into `pulumi env set -f -` via a shell here-string, which bakes in a trailing newline).
- **Direct** — `token` (Neon: `apiKey`): a secret `Input<string>`, marked secret in per-resource state via `additionalSecretOutputs`.

```typescript
const railwayProvider = new railway.Provider("railway", { tokenEnvVar: "RAILWAY_TOKEN" })
const neonProvider = new neon.Provider("neon", { apiKeyEnvVar: "NEON_API_KEY" })
const vercelProvider = new vercel.Provider("vercel", { tokenEnvVar: "VERCEL_TOKEN", teamId: "team_xxx" })
const flyProvider = new fly.Provider("fly", { tokenEnvVar: "FLY_API_TOKEN" })
```

Prefer the env-var form. It keeps the credential out of dynamic-resource inputs and per-resource state entirely, which removes the substrate for [pulumi/pulumi#16041](https://github.com/pulumi/pulumi/issues/16041) ("Unexpected struct type": secret Outputs in dynamic-provider inputs intermittently fail engine serialization — closed not-planned upstream) and matches how first-class provider configuration handles credentials. Dynamic-provider operations execute in the Pulumi CLI's plugin process, which inherits the program's environment — so variables provided by the shell or by an ESC environment's `environmentVariables` block reach them.

The deploy components that feed the credential to a CLI (`vercel.Deploy`, `fly.Deploy`) resolve the env var at program runtime into a secret Output, so the command env still receives the actual value without it ever becoming a dynamic-resource input.

Neither form of a provider's credential is ever compared in any resource's `diff()` — rotating a credential (or switching between `token`/`tokenEnvVar`) never triggers a replace or an in-place update on its own; it only changes which credential the next operation authenticates with.

## Railway

```typescript
import * as railway from "@infracraft/pulumi/railway"
import { hash } from "@infracraft/pulumi/hash"

const provider = new railway.Provider("railway", {
  tokenEnvVar: "RAILWAY_TOKEN",   // or token: config.requireSecret("railwayToken")
})

const project = new railway.Project("my-project", {
  name: "my-app",
}, { provider })

const environment = new railway.Environment("production", {
  name: "production",
}, { provider, project })

const service = new railway.Service("api", {
  name: "api",
  builder: railway.Builder.RAILPACK,
  startCommand: "node dist/index.js",
}, { provider, project, environment })

// Image-sourced service: the provider applies `source` to the target
// environment's instance and owns its deploys (`serviceInstanceDeployV2`) —
// on create and on config changes. No railway.Deploy needed; code services
// (like `api` above) deploy via railway.Deploy instead. Secret-bearing start
// commands (e.g. `redis-server --requirepass …`) belong in `startCommand`.
new railway.Service("redis", {
  name: "redis",
  source: { image: "redis:8-alpine" },
}, { provider, project, environment })

const env = { DATABASE_URL: dbUrl }

new railway.Variable("api-vars", {
  variables: env,
}, { provider, project, environment, service })

const deployToken = new railway.ProjectToken("api-token", {
  name: "api-deploy",
}, { provider, project, environment })

new railway.Deploy("api-deploy", {
  triggers: [hash("apps/api"), hash(env)],   // hash(env): a non-secret digest, not raw secret values
  healthcheckPath: "/health",                // applied post-deploy by the monitor (see Healthcheck config)
}, { provider, project, environment, service, projectToken: deployToken.token })
```

### Railway API surface

| Class | Key outputs | Notes |
|---|---|---|
| `railway.Provider` | — | Pass as `provider` option to every Railway resource. `token` or `tokenEnvVar` — see [Provider credentials](#provider-credentials) |
| `railway.Project` | `.id` (project UUID) | Adopt-or-create by name |
| `railway.Environment` | `.id` | Optional `source` env to fork from |
| `railway.Service` | `.id` | Instance config (builder, commands, healthcheck, restart policy) applied per target environment; image services (`source.image`) are deployed by the provider itself. Healthcheck fields a fresh instance rejects are re-applied post-deploy — see [Healthcheck config](#railway-api-surface) below |
| `railway.Domain` | `.fqdn`, `.cnameTarget`, `.verificationTxtName` / `.verificationTxtValue` | Omit `customDomain` for an auto-generated domain; custom domains expose the CNAME target and ownership-verification TXT record to write into DNS |
| `railway.Variable` | — | Batch upsert; uses `skipDeploys` to avoid snapshot errors |
| `railway.Volume` | — | Persistent volume; `mountPath` must be absolute. Adoption matches BOTH service and environment (never a sibling environment's volume); a newly attached volume redeploys its service so the mount lands |
| `railway.ProjectToken` | `.token` (secret) | Environment-scoped deploy token; feed into `railway.Deploy`. Bump `tokenVersion` to rotate — see [Rotating credentials](#rotating-credentials) |
| `railway.Deploy` | `.deploymentUrl` | Runs `railway up --detach` (retrying a transient upload failure), then monitors the deployment via the Railway API (the API, not the CLI exit code, decides pass/fail). Recovers deployments Railway wedges in `INITIALIZING` (see [Stuck-deploy recovery](#railway-api-surface)). Also accepts `excludePaths`, `railpackConfig`, and `healthcheckPath` / `healthcheckTimeout` (applied by the monitor post-deploy) |

**Enums:** `railway.Builder` (`RAILPACK`, `NIXPACKS`, `DOCKERFILE`, `HEROKU`, `PAKETO`), `railway.RestartPolicy` (`ON_FAILURE`, `ALWAYS`, `NEVER`)

**Deploy token security:** `railway.Deploy` pipes the project token to `railway up` via the command's stdin — never in the script text. pulumi-command embeds the executed command verbatim in its failure error and Pulumi does not scrub secrets from provider diagnostics, so an inlined token would print in plaintext exactly when a deploy fails.

**Healthcheck config:** Railway rejects healthcheck fields on a fresh service instance with no deployment (`serviceInstanceUpdate` fails with "Invalid input"), so a from-zero `up` cannot set them at configure time. `railway.Service` still sends them on the first attempt — an instance with existing deployments accepts them in one call — and when the API rejects, drops them for the retry and guarantees they land later instead of silently losing them: for image services the provider re-applies them right after its own `serviceInstanceDeployV2`; for code services pass `healthcheckPath` / `healthcheckTimeout` to `railway.Deploy` too, and its monitor applies them once the deployment reaches a live status. Either re-apply failing fails the resource loudly — healthcheck config is never dropped silently.

**Stuck-deploy recovery:** Railway occasionally wedges a deployment in `INITIALIZING` — it never advances to `BUILDING`. Rather than burn the whole poll timeout on a deployment that will never move, the monitor detects a continuous `INITIALIZING` stretch (default 5 minutes) and redeploys from the same source onto a fresh build slot, cancels the wedged deployment, and watches the new one — the recovery an operator would otherwise do by hand. Bounded (default one attempt) so a genuinely broken deploy still fails fast rather than looping.

## Neon

```typescript
import * as neon from "@infracraft/pulumi/neon"

const provider = new neon.Provider("neon", {
  apiKeyEnvVar: "NEON_API_KEY",   // or apiKey: config.requireSecret("neonApiKey")
})

const project = new neon.Project("db", { name: "my-app" }, { provider })

// Copy-on-write branch from "main"
const branch = new neon.Branch("prod", {
  name: "production",
  parent: "main",
}, { provider, project })

const role = new neon.Role("owner", {
  name: "neondb_owner",
  resetPassword: true,   // isolate COW branch from parent's password
}, { provider, project, branch })

const endpoint = new neon.Endpoint("prod", {
  minCu: 0.25,
  maxCu: 1,
  suspendTimeout: 300,
}, { provider, project, branch })

const db = new neon.Database("app-db", {
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
| `neon.Provider` | — | `apiKey` or `apiKeyEnvVar` (see [Provider credentials](#provider-credentials)) + optional `orgId` |
| `neon.Project` | `.id` | Adopt-or-create by name |
| `neon.Branch` | `.id` | Optional `parent` for copy-on-write branching |
| `neon.Endpoint` | `.host` | Read-write compute endpoint; use `.host` in connection strings |
| `neon.Role` | `.password` (secret) | `resetPassword: true` isolates COW branch passwords from parent. Bump `passwordVersion` to rotate — see [Rotating credentials](#rotating-credentials) |
| `neon.Database` | — | `name` + `ownerName` |

## Rotating credentials

Minted credentials rotate through a version-bump input — no target-replace URN archaeology, no manual revoke-then-recreate. Bump the number, run `up`, and everything consuming the credential (connection strings, env vars, dependent redeploys) cascades automatically:

```typescript
// Mints a fresh token BEFORE revoking the old one (create-before-delete),
// so there is never a tokenless window.
const deployToken = new railway.ProjectToken("api-token", {
  name: "api-deploy",
  tokenVersion: 2,   // bump to rotate
}, { provider, project, environment })

// Resets the password IN PLACE via Neon's reset_password endpoint — an
// update, never a replace (a replace would try to delete the role, which
// Neon refuses for default roles and which would drop grants for others).
const role = new neon.Role("owner", {
  name: "neondb_owner",
  passwordVersion: 2,   // bump to rotate
}, { provider, project, branch })
```

Leave the version unset until the first rotation is needed. Identity changes (name, project, environment) still replace normally.

## Vercel

Use the official [`@pulumiverse/vercel`](https://www.pulumi.com/registry/packages/vercel/) provider for the project itself (`vercel.Project`), its custom domains (`vercel.ProjectDomain`), and its environment variables (`vercel.ProjectEnvironmentVariables`). infracraft adds only what that provider does not cover: CLI-based production deploys with consumer-controlled triggers and sandbox isolation (`infravercel.Deploy`), and marketplace resource provisioning.

```typescript
// The official provider keeps the `vercel` alias (its ecosystem convention);
// infracraft's module takes `infravercel` when both are in scope.
import * as vercel from "@pulumiverse/vercel"
import * as infravercel from "@infracraft/pulumi/vercel"
import { hash } from "@infracraft/pulumi/hash"

// Project, custom domain, and env vars: the official provider.
const project = new vercel.Project("web", {
  name: "my-web-app",
  framework: "nextjs",
  rootDirectory: "apps/web",
})

new vercel.ProjectDomain("web-domain", {
  projectId: project.id,
  domain: "app.example.com",
})

new vercel.ProjectEnvironmentVariables("web-env", {
  projectId: project.id,
  variables: [
    { key: "NEXT_PUBLIC_API_URL", value: apiUrl, target: ["production", "preview"] },
  ],
})

// CLI deploy + marketplace resources: infracraft.
const provider = new infravercel.Provider("vercel", {
  tokenEnvVar: "VERCEL_TOKEN",   // or token: config.requireSecret("vercelToken")
  teamId: "team_xxx",
})

// project.id sources the deploy target; hash the source so edits redeploy.
new infravercel.Deploy("web-deploy", {
  projectId: project.id,
  triggers: [hash("apps/web")],
}, { provider })

// Marketplace example: provision an Upstash KV store
const integration = new infravercel.Integration("upstash", {
  slug: "upstash",
}, { provider })

const store = new infravercel.MarketplaceResource("kv", {
  integrationConfigurationId: integration.configurationId,
  name: "my-kv",
  type: "upstash-kv",   // the integration's product ID or slug
  externalId: "my-kv",
}, { provider })

new infravercel.ResourceConnection("kv-conn", {
  storeId: store.id,
  projectId: project.id,
  targets: ["production", "preview"],
}, { provider })
```

### Vercel API surface

| Class | Key outputs | Notes |
|---|---|---|
| `infravercel.Provider` | — | `token` or `tokenEnvVar` (see [Provider credentials](#provider-credentials)) + `teamId` |
| `infravercel.Deploy` | `.deploymentUrl` | Runs `vercel deploy --prod --yes` from an optional [sandbox](#sandbox--git-guard); `projectId` sources the deploy target (e.g. `@pulumiverse/vercel`'s `vercel.Project.id`). `.deploymentUrl` is the last http(s) URL token found in the CLI's stdout, after stripping any wrapping quotes/brackets/punctuation — so a URL that only ever appears quoted inside pretty-printed JSON is still found |
| `infravercel.Integration` | `.configurationId` (`icfg_…`) | Resolves an installed marketplace integration by slug (install it once via the dashboard first) |
| `infravercel.MarketplaceResource` | `.id`, `.externalResourceId`, `.status` | Provisions a marketplace store; `type` is the integration product ID or slug. `metadata` is updatable in place; `billingPlanId` is create-time-only |
| `infravercel.ResourceConnection` | — | Wires a store to a project; injects env vars into target environments (`makeEnvVarsSensitive` defaults to `true` — then `targets` must not include `development`) |
| `infravercel.Client` | — | Typed REST client behind the marketplace resources (`get` / `tryGet` / `post`); appends `teamId` to every request and rides the resilient transport |

## Fly.io

```typescript
import * as fly from "@infracraft/pulumi/fly"
import { hash } from "@infracraft/pulumi/hash"

// Provider: auth context (token + optional default org)
const provider = new fly.Provider("fly", {
  tokenEnvVar: "FLY_API_TOKEN",   // or token: config.requireSecret("flyToken")
  organization: "personal",
})

// App: adopt-or-create; `.id` is the app name
const app = new fly.App("api", { name: "acme-api" }, { provider })

// Secrets: managed via the Machines REST secrets API.
// `.version` changes only when the secret set changes.
const secrets = new fly.Secret("api-secrets", {
  secrets: { JWT_SECRET: jwt, DATABASE_URL: dbUrl },
}, { provider, app })

// Volume: persistent storage (grow-only)
new fly.Volume("api-data", {
  name: "data",
  region: "iad",
  sizeGb: 10,
}, { provider, app })

// Certificate: ACME cert for a custom hostname
new fly.Certificate("api-cert", {
  hostname: "api.example.com",
}, { provider, app })

// Dedicated/shared IP (Fly GraphQL API)
new fly.Ip("api-ip", { type: fly.IpType.SHARED_V4 }, { provider, app })

// Deploy: `fly deploy --remote-only` with consumer-controlled triggers.
// The generated fly.toml content is included in the triggers automatically.
new fly.Deploy("api-deploy", {
  config: {
    app: "acme-api",
    primaryRegion: "iad",
    build: { dockerfile: "apps/api/Dockerfile" },
    httpService: {
      internalPort: 3333,
      forceHttps: true,
      minMachinesRunning: 1,
      checks: [{ method: "GET", path: "/health", interval: "30s", timeout: "10s" }],
    },
    deploy: { strategy: fly.DeployStrategy.ROLLING },
    vm: [{ size: "shared-cpu-1x", memory: "512mb", cpus: 1 }],
  },
  triggers: [hash("apps/api"), secrets.version],
}, { provider, app, dependsOn: [secrets] })
```

**Requirements:** `flyctl` must be installed on the machine running `pulumi up` (used by `fly.Deploy`) — call `assertHostBinaries(["fly"])` from `@infracraft/pulumi/sandbox` at program start to fail fast with an install hint instead of mid-deploy. Generate a token with `fly tokens create deploy`. Dedicated IP allocation uses the Fly GraphQL API; everything else uses the Machines REST API.

### Fly.io API surface

| Class | Key outputs | Notes |
|---|---|---|
| `fly.Provider` | — | Pass as `provider` option to every Fly resource. `token` or `tokenEnvVar` — see [Provider credentials](#provider-credentials) |
| `fly.App` | `.id` (app name) | Adopt-or-create; `organization` is create-time only — changing it after the app exists has no effect (Fly only supports moving an app between orgs via `fly apps move`/the dashboard, not this provider's REST API surface) |
| `fly.Secret` | `.version` | Feed into `fly.Deploy` triggers to redeploy on secret changes |
| `fly.Volume` | `.id` (`vol_…`) | `sizeGb` can only grow |
| `fly.Certificate` | `.id` (hostname), `.configured`, `.dnsRequirements` | `.dnsRequirements` contains ACME validation records |
| `fly.Ip` | `.id` (IP address) | `type`: `fly.IpType.V4`, `V6`, `SHARED_V4`, `PRIVATE_V6` |
| `fly.Deploy` | `.deploymentUrl` | Writes fly.toml at deploy time; triggers on config + source hash. Optional `waitTimeout`, `releaseCommandTimeout`, `highAvailability` |

**Enums:** `fly.IpType`, `fly.DeployStrategy` (`ROLLING`, `IMMEDIATE`, `CANARY`, `BLUEGREEN`), `fly.RestartPolicy` (`ALWAYS`, `ON_FAILURE`, `NEVER`), `fly.AutoStopMachines` (`OFF`, `STOP`, `SUSPEND`), `fly.ConcurrencyType` (`CONNECTIONS`, `REQUESTS`), `fly.ServiceProtocol` (`TCP`, `UDP`), `fly.PortHandler` (`HTTP`, `TLS`, `PG_TLS`, `PROXY_PROTO`, `EDGE_HTTP`), `fly.CpuKind` (`SHARED`, `PERFORMANCE`), `fly.CheckType` (`HTTP`, `TCP`)

**Constants:** `FLY_REGIONS` (IATA codes array), `fly.Region` (derived type), `FLY_VM_SIZES` (size preset array), `fly.VmSize` (derived type)

**fly.toml types:** `fly.TomlConfig`, `fly.BuildConfig`, `fly.HttpService`, `fly.Service`, `fly.ServicePort`, `fly.Mount`, `fly.Vm`, `fly.CpuCount`, `fly.DeployConfig`, `fly.RestartConfig`, `fly.Check`, `fly.Concurrency`, `fly.DnsRequirements`

**Helper:** `generateFlyToml(config)` serializes a `fly.TomlConfig` to fly.toml text (camelCase to snake_case, deterministic output).


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

new railway.Deploy("api-deploy", {
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

Every deploy resource (`railway.Deploy`, `fly.Deploy`, `infravercel.Deploy`) REQUIRES a `DeploySandbox` in its own `dependsOn` — without one, a deploy would silently run against the LIVE working tree (uncommitted changes included) instead of a clean, git-tracked copy. Pass `allowUnsandboxed: true` in the deploy's args to opt into the live tree deliberately.

```typescript
import { DeploySandbox } from "@infracraft/pulumi/sandbox"
import { GitGuard } from "@infracraft/pulumi/git-guard"
import { hash } from "@infracraft/pulumi/hash"
import * as infravercel from "@infracraft/pulumi/vercel"

const sandbox = new DeploySandbox("sandbox")
const guard = new GitGuard("git-guard")

// Runs `vercel deploy` from an isolated copy with a stub `.git`
new infravercel.Deploy("web-deploy", {
  projectId: project.id,
  triggers: [hash("apps/web")],
  excludePaths: ["apps/docs"],   // drop other apps from the upload (stub mode only)
}, { provider, dependsOn: [sandbox, guard] })
```

| `dependsOn` markers | Working copy | `.git` sent to the platform |
|---|---|---|
| none | — | Throws: no `DeploySandbox` and `allowUnsandboxed` is not set |
| none + `allowUnsandboxed: true` | Live repo tree | The real one; whatever the platform CLI picks up |
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

## Preflight checks

Guards that turn a failure that would otherwise surface mid-`up` into a clear, actionable message at program start. Two run themselves — zero ceremony:

- **Host binaries** — `DeploySandbox` checks its own POSIX toolchain; `assertHostBinaries(["fly", "vercel"])` remains available for platform CLIs your program shells out to.
- **Pulumi CLI/SDK version match** — every infracraft provider constructor runs the memoized `ensurePulumiVersionMatch()`, so any program constructing a provider gets the skew guard automatically. Call `assertPulumiVersionMatch()` directly only to check earlier than the first provider or to opt into `WARN` mode.

The Cloudflare guard stays explicit, for a structural reason: infracraft owns no Cloudflare resources (DNS goes through the official `@pulumi/cloudflare` provider), so no infracraft component can run it for you.

```typescript
import { assertCloudflareZoneAccess } from "@infracraft/pulumi/preflight"

// The Cloudflare token can read the target zone before any DNS/zone change.
await assertCloudflareZoneAccess({
  token: process.env.CLOUDFLARE_API_TOKEN ?? "",
  zoneId: process.env.CLOUDFLARE_ZONE_ID ?? "",
})
```

| Guard | Import | Catches | On failure |
|---|---|---|---|
| `assertHostBinaries(binaries)` | `@infracraft/pulumi/sandbox` | A platform CLI (`fly` / `vercel` / `railway` …) missing from `PATH` | Throws one error naming ALL missing binaries, with an install hint for each known one |
| `ensurePulumiVersionMatch()` / `assertPulumiVersionMatch(options?)` | `@infracraft/pulumi/preflight` (`ensure` runs automatically in every provider constructor) | A skew between the running Pulumi CLI (Go engine) and the installed `@pulumi/pulumi` SDK (Node serializer) — the cause of intermittent "Unexpected struct type" marshal failures on dynamic resources | Throws (or warns, with `mode: PulumiVersionMismatchMode.WARN`) naming both versions and the pin-the-CLI fix. Best-effort: warns and skips when the SDK can't be resolved from the program's working directory, or (`ensure` only) when the `pulumi` binary itself can't run |
| `assertCloudflareZoneAccess(options)` | `@infracraft/pulumi/preflight` | A Cloudflare API token that cannot read the target zone (invalid, revoked, or not scoped to it) — so a mid-`up` 403/404 becomes a plan-time error | Throws naming the status (401/403/404/other) and the fix, when the zone read is not 2xx |

**`assertPulumiVersionMatch` options:** `mode: PulumiVersionMismatchMode.THROW` (default) or `.WARN`, plus injectable `readCliVersion` / `readSdkVersion` readers for testing. It compares major.minor (patch and pre-release suffixes are ignored).

**`assertCloudflareZoneAccess` — a zone read, not the token verify endpoint.** This guard calls `GET /zones/{zone_id}`, deliberately NOT `GET /user/tokens/verify`: the verify endpoint only accepts USER-owned tokens and 401s on an ACCOUNT-owned token (the kind minted for scoped automation) even when that token is perfectly valid — proven live 2026-07-06 against a token that returned 200 on the zone read and 401 on verify. A zone read also proves the more relevant capability: that the token can reach the SPECIFIC zone this program mutates, not merely that it's valid somewhere on the account. LIMITATION: a successful read proves `Zone:Read`, not `Zone Settings:Edit` or `DNS:Edit` — Cloudflare has no read-only endpoint that exercises those without a real mutation, so a read-only token can still 403 mid-`up` on an actual write.

## Transport & errors

Every provider client (`railway.Client`, `neon.Client`, `vercel.Client`, `fly.Client`) routes its HTTP through one resilient fetch wrapper: a 15s per-attempt timeout, up to 3 attempts on transient failures (network errors, 5xx, 429), a numeric `Retry-After` honored on 429 (capped at 30s), and exponential backoff otherwise (1s/2s/4s, capped at 20s) — everything else, including non-429 4xx, returns to the caller untouched. The REST clients turn a 404 into a typed `ApiNotFoundError` (carrying the provider and path), and catch sites test `instanceof` rather than matching message strings: adopt-or-create lookups turn it into "create", `read()` turns it into a blank result so `pulumi refresh` reconciles out-of-band deletions, and `delete()` turns it into an idempotent no-op.

## Live integration tests

The mocked unit tests (`bun run test`) prove the providers' logic in isolation, but they cannot catch the truths that only the real platform APIs reveal — a mutation that returns success while silently doing nothing, adoption that is or isn't scoped to an environment, a password rotation that must not trigger a resource replace. Those are the exact bug class that has cost real incidents. The **live tier** runs the resource providers against the real Railway and Neon APIs, creating and then **tearing down** throwaway resources.

It is **opt-in and inert by default.** Every `*.live.test.ts` file self-skips unless `INFRACRAFT_LIVE_TEST=1` **and** its platform credentials are present, using `describe.skipIf` so a missing credential reports as **skipped, never failed**. The tier is excluded from the default `test` script (via `vitest.config.ts`) and from CI, so it never runs — and costs nothing — unless you explicitly provide credentials.

Run it with the platform(s) you have credentials for:

```bash
# Railway coverage (service + volume)
INFRACRAFT_LIVE_TEST=1 \
  RAILWAY_TOKEN=… \
  RAILWAY_TEST_PROJECT_ID=… \
  RAILWAY_TEST_ENV_ID=… \
  bun run test:live

# Neon coverage (role + branch)
INFRACRAFT_LIVE_TEST=1 \
  NEON_API_KEY=… \
  NEON_TEST_PROJECT_ID=… \
  bun run test:live
```

With no credentials, `bun run test:live` exits `0` with every file skipped.

### Required environment variables

| Variable | Required by | Purpose |
|---|---|---|
| `INFRACRAFT_LIVE_TEST` | all live tests | Master opt-in switch; must equal `1`. |
| `RAILWAY_TOKEN` | `railway/*.live.test.ts` | Railway account/team API token (not a project token). |
| `RAILWAY_TEST_PROJECT_ID` | `railway/*.live.test.ts` | A throwaway Railway project the tests may freely mutate. |
| `RAILWAY_TEST_ENV_ID` | `railway/*.live.test.ts` | A non-default environment UUID in that project. |
| `NEON_API_KEY` | `neon/*.live.test.ts` | Neon account- or project-scoped API key. |
| `NEON_TEST_PROJECT_ID` | `neon/*.live.test.ts` | A throwaway Neon project the tests may freely mutate. |

### Coverage

| File | Asserts against the live API |
|---|---|
| `railway/service.live.test.ts` | Adopt-or-create is idempotent (second create by name adopts the same service, no duplicate); `ensureServiceInstance` materializes an instance in a non-default environment via the config-patch commit; an image service deploys via `serviceInstanceDeployV2`; `environmentUnskipService` is rejected in a named environment — documenting **why** the patch-commit path exists. |
| `railway/volume.live.test.ts` | Adoption is environment-scoped — a volume attached to a service in environment A is **not** adopted for the same service in environment B (each gets its own), while re-creating within the same environment adopts the existing one. |
| `neon/role.live.test.ts` | Adopt-or-create is idempotent; a `passwordVersion` bump rotates the password in place via `reset_password` — an update that returns a fresh secret with **no** replace. Runs on a throwaway branch. |
| `neon/branch.live.test.ts` | A `parent`-supplied branch is a copy-on-write fork: the created branch's `parent_id` is exactly the resolved parent branch. |

### Throwaway-resource and teardown model

Each test creates uniquely-named resources and registers them for cleanup in an `afterAll` hook. Cleanup is **idempotent and tolerant of partial state**: it deletes what it created, and a cleanup failure is logged loudly (`[live cleanup] …`, naming the resource id to remove manually) but never fails the suite — a botched teardown must not mask the assertion result. Because a Railway service is project-level (its provider `delete()` is intentionally a no-op), the tests tear services down with a raw `serviceDelete`; Neon roles are removed by deleting their throwaway branch, which cascades. Point the `*_TEST_PROJECT_ID` variables at disposable projects only.

## Why

| Provider | Existing options | Gap |
|---|---|---|
| Railway | Nothing. Zero Pulumi providers exist. | **We are the Railway Pulumi provider.** |
| Neon | Bridged TF provider; fails on pre-existing resources | Adopt-or-create without manual `import` blocks |
| Vercel | `@pulumiverse/vercel` covers projects, domains, and env vars — but has no CLI deploy or marketplace provisioning | CLI deploys with consumer-controlled triggers and sandbox isolation, plus marketplace resource provisioning |
| Fly.io | `@ediri/pulumi-fly`; bridges a Terraform provider Fly archived March 2024, no secrets support | Hand-rolled `dynamic` resources matching every other provider: secrets, adopt-or-create, consumer-controlled deploys; no unmaintained upstream |

## Release history

See [CHANGELOG.md](CHANGELOG.md) for release history.

## License

MIT
