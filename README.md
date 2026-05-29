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

## Providers

| | Provider | What it does |
|---|---|---|
| 🚂 | **Railway** | The only Pulumi provider for Railway. Projects, environments, services, variables, volumes, domains, deploys. |
| 🐘 | **Neon** | Adopt-or-create layer for Neon Postgres. Projects, branches, endpoints, roles, databases. |
| ▲ | **Vercel** | Projects with adopt-or-create, deploy orchestration, and sensitive env var drift detection. |
| 🎯 | **Fly.io** | App, Secret, Volume, Certificate, IP, and Deploy resources via the Machines REST API and Fly GraphQL API. |
| #️⃣ | **Hash** | Deterministic directory hashing for deploy triggers. |
| 🔒 | **Git Guard** | Parallel-safe `.git` protection for concurrent CLI deploys. |

## Install

```bash
npm install @infracraft/pulumi
# or
bun add @infracraft/pulumi
```

Peer dependencies: `@pulumi/pulumi` ^3, `@pulumi/command` ^1 (optional)

## Railway

```typescript
import {
  RailwayProvider, RailwayProject, RailwayEnvironment,
  RailwayService, RailwayVariable, RailwayDeploy,
} from "@infracraft/pulumi/railway"
import { hashDirectory } from "@infracraft/pulumi/hash"

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
  builder: "RAILPACK",
  startCommand: "node dist/index.js",
}, { provider, project, environment })

new RailwayVariable("api-vars", {
  variables: { DATABASE_URL: dbUrl },
}, { provider, project, environment, service })

const sourceHash = hashDirectory("apps/api")

new RailwayDeploy("api-deploy", {
  directory: monorepoRoot,
  triggers: [sourceHash, ...Object.values(env)],
}, { provider, project, environment, service })
```

## Neon

```typescript
import {
  NeonProvider, NeonProject, NeonBranch, NeonRole, NeonEndpoint,
} from "@infracraft/pulumi/neon"

const provider = new NeonProvider("neon", {
  apiKey: config.requireSecret("neonApiKey"),
})

const project = new NeonProject("db", { name: "my-app" }, { provider })
const branch = new NeonBranch("prod", { name: "production" }, { provider, project })
const role = new NeonRole("owner", { name: "neondb_owner" }, { provider, project, branch })
const endpoint = new NeonEndpoint("prod", { minCu: 0.25, maxCu: 1 }, { provider, project, branch })

const connectionString = pulumi.interpolate`postgresql://${role.name}:${role.password}@${endpoint.host}/neondb`
```

## Vercel

```typescript
import {
  VercelProvider, VercelProject, VercelVariable, VercelDeploy,
} from "@infracraft/pulumi/vercel"
import { hashDirectory } from "@infracraft/pulumi/hash"

const provider = new VercelProvider("vercel", {
  token: config.requireSecret("vercelToken"),
  teamId: "team_xxx",
})

const project = new VercelProject("web", {
  name: "my-web-app",
  framework: "nextjs",
  rootDirectory: "apps/web",
}, { provider })

new VercelVariable("web-vars", {
  variables: { NEXT_PUBLIC_API_URL: apiUrl },
}, { provider, project })

const sourceHash = hashDirectory("apps/web")

new VercelDeploy("web-deploy", {
  monorepoRoot,
  triggers: [sourceHash, ...Object.values(env)],
}, { provider, project })
```

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
} from "@infracraft/pulumi/fly";
import { hashDirectory } from "@infracraft/pulumi/hash";

// Provider — auth context (token + optional default org)
const provider = new FlyProvider("fly", {
  token: config.requireSecret("flyToken"),
  organization: "personal",
});

// App — adopt-or-create; `.id` is the app name
const app = new FlyApp("api", { name: "rby-api" }, { provider });

// Secrets — managed via the Machines REST secrets API.
// `.version` changes only when the secret set changes.
const secrets = new FlySecret("api-secrets", {
  secrets: { JWT_SECRET: jwt, DATABASE_URL: dbUrl },
}, { provider, app });

// Volume — persistent storage (grow-only)
new FlyVolume("api-data", {
  name: "data",
  region: "iad",
  sizeGb: 10,
}, { provider, app });

// Certificate — ACME cert for a custom hostname; exposes .configured + .dnsRequirements
new FlyCertificate("api-cert", {
  hostname: "api.example.com",
}, { provider, app });

// Dedicated/shared IP (Fly GraphQL API)
new FlyIp("api-ip", { type: FlyIpType.SHARED_V4 }, { provider, app });

// Deploy — `fly deploy` with consumer-controlled triggers.
// The generated fly.toml content is added to the triggers automatically.
new FlyDeploy("api-deploy", {
  monorepoRoot,
  config: {
    app: "rby-api",
    primaryRegion: "iad",
    build: { dockerfile: "apps/api/Dockerfile" },
    env: { PORT: "3333", NODE_ENV: "production" },
    httpService: {
      internalPort: 3333,
      forceHttps: true,
      minMachinesRunning: 1,
      checks: [{ method: "GET", path: "/health", interval: "30s", timeout: "10s" }],
    },
    vm: [{ size: "shared-cpu-1x", memory: "512mb", cpus: 1 }],
  },
  triggers: [hashDirectory("apps/api"), secrets.version],
}, { provider, app, dependsOn: [secrets] });
```

**Requirements:** `flyctl` must be installed on the machine running `pulumi up` (used by `FlyDeploy`). Generate a token with `fly tokens create deploy`. Dedicated IP allocation uses the Fly GraphQL API; everything else uses the Machines REST API.

| Resource | Key outputs |
|---|---|
| `FlyApp` | `.id` (app name) |
| `FlySecret` | `.version` |
| `FlyVolume` | `.id` (vol_…) |
| `FlyCertificate` | `.id` (hostname), `.configured`, `.dnsRequirements` |
| `FlyIp` | `.id` (IP address) |

## Design

**Context-based**: Resources inherit auth, project, and environment from their options — no manual ID passing.

**Adopt-or-create**: Existing infrastructure is discovered by name and adopted into Pulumi state. Run `pulumi up` against a pre-existing project and it just works.

**Consumer-controlled triggers**: Deploy resources accept a `triggers` array — you decide what causes a redeploy. Hash source directories, env values, or anything else.

## Why

| Provider | Existing options | Gap |
|---|---|---|
| Railway | Nothing. Zero Pulumi providers exist. | **We are the Railway Pulumi provider.** |
| Neon | Bridged TF provider — fails on pre-existing resources | Adopt-or-create without manual `import` blocks |
| Vercel | `@pulumiverse/vercel` — no adopt-or-create, no CLI deploys | Adopt-or-create projects + consumer-controlled deploy triggers |

## License

MIT
