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

Native Pulumi providers with adopt-or-create semantics, deploy orchestration, and full CRUD. No Terraform bridge.

## Providers

| | Provider | What it does |
|---|---|---|
| 🚂 | **Railway** | The only Pulumi provider for Railway. Projects, services, variables, volumes, domains, deploys. |
| 🐘 | **Neon** | Adopt-or-create layer for Neon Postgres. Branches, endpoints, roles, databases. |
| ▲ | **Vercel** | Deploy orchestration and sensitive env var drift detection. Fills gaps in `@pulumiverse/vercel`. |
| #️⃣ | **Hash** | Deterministic directory hashing for deploy triggers. |
| 🔒 | **Git Guard** | Parallel-safe `.git` protection for concurrent CLI deploys. |

## Install

```bash
npm install @infracraft/pulumi
# or
bun add @infracraft/pulumi
```

Peer dependencies: `@pulumi/pulumi` ^3, `@pulumi/command` ^1 (optional)

## Usage

```typescript
import {
  RailwayProvider,
  RailwayProject,
  RailwayEnvironment,
  RailwayService,
  RailwayVariable,
  RailwayDeploy,
} from "@infracraft/pulumi/railway"

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
```

Resources inherit context from their provider, project, and environment — no manual ID passing.

Every resource uses **adopt-or-create**: existing infrastructure is discovered by name and adopted into Pulumi state.

## Neon

```typescript
import { NeonProvider, NeonProject, NeonBranch, NeonRole } from "@infracraft/pulumi/neon"

const provider = new NeonProvider("neon", {
  apiKey: config.requireSecret("neonApiKey"),
})

const project = new NeonProject("db", { name: "my-app" }, { provider })
const branch = new NeonBranch("prod", { name: "production" }, { provider, project })
const role = new NeonRole("owner", { name: "neondb_owner" }, { provider, project, branch })

// role.password is a secret output
const connectionString = pulumi.interpolate`postgresql://neondb_owner:${role.password}@${endpoint.host}/neondb`
```

## Why

| Provider | Existing options | Gap |
|---|---|---|
| Railway | Nothing. Zero Pulumi providers exist. | **We are the Railway Pulumi provider.** |
| Neon | Bridged TF provider — fails on pre-existing resources | Adopt-or-create without manual `import` blocks |
| Vercel | `@pulumiverse/vercel` — no CLI deploys, no sensitive var drift detection | `[sourceHash, envHash]` deploy triggers + contentHash |

## License

MIT
