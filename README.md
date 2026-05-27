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
