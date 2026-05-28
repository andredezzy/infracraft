# Fly.io Provider (v1)

## Goal

Add a Fly.io provider to `@infracraft/pulumi` that provisions Fly apps, secrets, volumes, certificates, dedicated IPs, and deployments. It follows the same hand-rolled, context-based pattern as the Railway, Neon, and Vercel providers — no third-party Pulumi packages, one consistent mental model.

The design ports and modernizes the Fly code from `mlm-rby/infrastructure` (recovered from git history, deleted in `5d3020939`): the same toolkit (`pulumi.dynamic` providers + a `ComponentResource` deploy wrapping `@pulumi/command`), updated to use Fly's current REST surface.

## Why not `@ediri/pulumi-fly`

There is no official Pulumi Fly provider. `@ediri/pulumi-fly` bridges the Terraform provider Fly archived in March 2024, has no secrets support, and would introduce a second paradigm inside the package — violating the "one pattern, applied everywhere" rule. Hand-rolling keeps every provider in this package identical to read, test, and extend.

## Architecture

Each public resource is a `ComponentResource` wrapping an internal `dynamic.Resource`. The provider is a credential holder. Deployment is a `ComponentResource` that shells out to `fly deploy` via `@pulumi/command` — identical in shape to `RailwayDeploy` / `VercelDeploy`.

```
Public API (ComponentResource)        →  Internal
──────────────────────────────────       ─────────────────────────────────────
FlyProvider({ token, organization? })     (no internal resource — holds token)
FlyApp({ name })                           FlyAppResource (REST: /v1/apps)
FlySecret({ secrets })                     FlySecretResource (REST: app secrets)
FlyVolume({ name, region, sizeGb })        FlyVolumeResource (REST: /v1/apps/{app}/volumes)
FlyCertificate({ hostname })               FlyCertificateResource (REST: /v1/apps/{app}/certificates)
FlyIp({ type, region? })                   FlyIpResource (GraphQL: allocate/releaseIpAddress)
FlyDeploy({ config, triggers, ... })       command.local.Command → `fly deploy`
```

## APIs used

| Surface | Base URL | Used by |
|---|---|---|
| Machines REST | `https://api.machines.dev/v1` | `FlyApp`, `FlySecret`, `FlyVolume`, `FlyCertificate` |
| Platform GraphQL | `https://api.fly.io/graphql` | `FlyIp` only (no REST equivalent for IP allocation) |
| flyctl CLI | — | `FlyDeploy` (`fly deploy`) |

Auth is a single Fly token (`fly tokens create deploy`). The token is passed as `Authorization: Bearer` to REST/GraphQL, and as the `FLY_API_TOKEN` environment variable to the `fly deploy` command (never inlined into the command string).

## Options pattern

Auth and the parent app flow through `opts`, never `args` — same as the existing providers. Each resource defines its own options type:

```typescript
type FlyVolumeOptions = Omit<pulumi.ComponentResourceOptions, "provider"> & {
  provider: FlyProvider;
  app: FlyApp;
};
```

```typescript
constructor(name: string, args: FlyVolumeArgs, opts: FlyVolumeOptions) {
  const { provider, app, ...pulumiOpts } = opts;
  super("infracraft:fly:Volume", name, {}, pulumiOpts);

  const resource = new FlyVolumeResource(`${name}-resource`, {
    token: provider.token,
    appName: app.id,
    ...args,
  }, { parent: this });

  this.id = resource.volumeId;
  this.registerOutputs({ id: this.id });
}
```

## File structure

```
src/fly/
  client.ts        FlyClient — Machines REST wrapper (get/post/put/delete) + secret endpoints + graphql() for FlyIp
  provider.ts      FlyProvider (ComponentResource, holds token + optional organization)
  app.ts           FlyApp + FlyAppResource
  secret.ts        FlySecret + FlySecretResource
  volume.ts        FlyVolume + FlyVolumeResource
  certificate.ts   FlyCertificate + FlyCertificateResource
  ip.ts            FlyIp + FlyIpResource
  toml.ts          FlyTomlConfig (typed) + enums + generateFlyToml()
  deploy.ts        FlyDeploy (ComponentResource → fly deploy)
  index.ts         Public exports (provider + resources + toml types/enums, NOT internal resources)
  __tests__/
    client.test.ts
    toml.test.ts
```

## Resource semantics

| Resource | Adopt-or-create key | `delete()` | Outputs |
|---|---|---|---|
| `FlyApp` | app name (`GET /v1/apps/{name}`) | **no-op + `pulumi.log.warn`** (top-level, like Railway/Neon projects) | `.id` (= app name) |
| `FlySecret` | n/a (batch upsert) | real (unset all keys) | `.version` (Fly release id) |
| `FlyVolume` | volume name | real (`DELETE` volume) | `.id` |
| `FlyCertificate` | hostname | real (`DELETE` cert) | `.id`, `.dnsValidationTarget`, `.configured` |
| `FlyIp` | type + region | real (`releaseIpAddress`) | `.id` (= allocated address) |
| `FlyDeploy` | — | — (Command lifecycle) | — |

`FlyApp.delete()` is a no-op because deleting a Fly app destroys everything in it — the same protection Railway/Neon apply to projects. All child resources perform real deletes.

## Public API

```typescript
import {
  FlyProvider, FlyApp, FlySecret, FlyVolume, FlyCertificate, FlyIp, FlyDeploy,
  FlyRegion, FlyDeployStrategy,
} from "@infracraft/pulumi/fly";
import { hashDirectory } from "@infracraft/pulumi/hash";

const provider = new FlyProvider("fly", {
  token: config.requireSecret("flyToken"),
  organization: "personal",            // optional default org; FlyApp can override
});

// App — adopt-or-create; .id is the app name
const app = new FlyApp("api", { name: "rby-api" }, { provider });

// Secrets — REST; .version changes only when the secret set changes
const secrets = new FlySecret("api-secrets", {
  secrets: { JWT_SECRET: jwt, DATABASE_URL: dbUrl },
}, { provider, app });

// Volume — persistent storage
const volume = new FlyVolume("api-data", {
  name: "data",
  region: FlyRegion.IAD,
  sizeGb: 10,
}, { provider, app });

// Certificate — custom domain TLS; exposes DNS validation target
const cert = new FlyCertificate("api-cert", {
  hostname: "api.example.com",
}, { provider, app });

// Dedicated IP (GraphQL)
const ip = new FlyIp("api-ip", { type: "shared_v4" }, { provider, app });

// Deploy — `fly deploy` with consumer-controlled triggers
new FlyDeploy("api-deploy", {
  monorepoRoot,
  sourceDirectory: "apps/api",
  config: {
    app: "rby-api",
    primaryRegion: FlyRegion.IAD,
    build: { dockerfile: "apps/api/Dockerfile" },
    env: { PORT: "3333", NODE_ENV: "production" },
    httpService: {
      internalPort: 3333,
      forceHttps: true,
      autoStopMachines: "off",
      minMachinesRunning: 1,
      checks: [{ method: "GET", path: "/health", interval: "30s", timeout: "10s", gracePeriod: "120s" }],
    },
    vm: [{ size: "shared-cpu-1x", memory: "512mb", cpus: 1 }],
    deploy: { strategy: FlyDeployStrategy.BLUEGREEN },
  },
  // consumer decides what forces a redeploy
  triggers: [hashDirectory("apps/api"), secrets.version],
}, { provider, app, dependsOn: [secrets] });
```

`config.app` is the plain app-name string (the same name passed to `FlyApp`), not `app.id`. `generateFlyToml()` runs synchronously to write the toml file, so it needs a resolved string rather than an `Output<string>`; `opts.app` still carries the dependency (via `dependsOn`) that orders the deploy after the app exists.

## Secrets → deploy flow

Fly secrets only take effect on the next deploy. `FlySecret` exposes a `.version` output (the Fly release id) that changes **only when its `diff()` detects a changed secret set**. The consumer feeds `secrets.version` into `FlyDeploy.triggers`, so a redeploy fires exactly when secrets change — declarative, no separate hashing utility.

`FlySecretResource.diff()` compares key sets and per-value equality (ported from the mlm-rby GraphQL implementation), and `update()` unsets removed keys before setting the new set. Detecting value changes requires holding secret values in state; that state is wrapped with `pulumi.secret()` so it is encrypted at rest.

## Confirmed decisions

1. **`FlyIp` uses GraphQL.** Dedicated-IP allocation has no Machines REST equivalent — only GraphQL (`allocateIpAddress`/`releaseIpAddress`) or flyctl. A GraphQL dynamic provider is chosen over a flyctl command so `FlyIp` keeps the same adopt / `.id` / `diff` / release semantics as every other resource. Consistency of pattern outweighs minimizing API surfaces. `FlyClient` gains one `graphql()` method to support it.

2. **Enum value casing — documented exception.** The global rule "enum values are UPPERCASE" cannot apply to fly.toml literals, which Fly requires verbatim in lowercase. Therefore:
   - **Closed small sets use enums with UPPERCASE keys + Fly's literal lowercase values**, e.g. `enum FlyDeployStrategy { BLUEGREEN = "bluegreen", ROLLING = "rolling", IMMEDIATE = "immediate", CANARY = "canary" }`. Applies to: deploy strategy, restart policy, auto-stop, concurrency type, cpu kind, port handlers, service protocol, check type.
   - **Large or semi-open sets use string-literal union types**, e.g. `FlyRegion`, `FlyVmSize` — Fly adds new regions and machine sizes over time, so a closed enum would be wrong and require edits to stay correct.

3. **fly.toml temp file.** mlm-rby wrote `.fly-{app}.toml` into the repo root at program-eval time (it ran even on `pulumi preview` and left litter). The improvement: write the generated toml to a gitignored `.fly/` directory (or OS temp) under a deterministic per-app filename, and include the toml content string in `FlyDeploy.triggers` so config changes drive redeploys.

## Ported / modernized from mlm-rby

| Asset | Disposition |
|---|---|
| `FlyClient` (Machines REST fetch wrapper) | Port; add `graphql()` and secret endpoints |
| `FlyApp` adopt-or-create dynamic provider | Port as-is into the three-layer shell |
| `FlyTomlConfig` + `generateFlyToml()` (~400 lines) | Port; closed-set fields become enums (decision 2); field names camelCased on the TS side, emitted as snake_case toml |
| `FlySecret` (was GraphQL) | Reimplement against the new (Oct 2025) Machines REST secrets API; keep the unset-then-set update logic |
| `FlyMachine` ComponentResource → `fly deploy` | Becomes `FlyDeploy`; token via `FLY_API_TOKEN` env; consumer-controlled `triggers` |
| `hashSecrets()` | Dropped — replaced by `FlySecret.version` output wiring |
| Hardcoded `org_slug: "personal"`, getDeployName(), Redis URL patterns | Dropped — app-specific to mlm-rby |

## Provider outputs

| Resource | Outputs |
|---|---|
| `FlyProvider` | `token` (secret), `organization` |
| `FlyApp` | `id` (app name) |
| `FlySecret` | `version` |
| `FlyVolume` | `id` |
| `FlyCertificate` | `id`, `dnsValidationTarget`, `configured` |
| `FlyIp` | `id` (allocated address) |

## Registration, tests, README

- **Registration (two lines):** add `'src/fly/index.ts'` to `entry` in `tsdown.config.ts`; add `"./fly": { types, default }` to `exports` in `package.json`. `@pulumi/command` is already an optional peer dep.
- **Tests:** `client.test.ts` exercises the REST client (incl. secrets) and GraphQL path through fetch mocks; `toml.test.ts` asserts `generateFlyToml()` output for representative configs. Same client-seam approach as the other providers.
- **README:** the implementation ends by bringing `README.md` fully up to date — a Fly section matching how Vercel is documented (context-based API, the full resource set, consumer-controlled triggers, `@infracraft/pulumi/fly` import), verified against the shipped API.

## To verify during implementation

- Exact paths/payloads of the new Machines REST secrets endpoints (announced Oct 2025) against current Fly docs.
- Machines REST certificate endpoints and the DNS-validation fields returned.
- `allocateIpAddress` / `releaseIpAddress` GraphQL input shapes and the `shared_v4` vs dedicated `v4`/`v6` type values.
- Fly Machines API rate limits (≈1 req/s per action) — confirm adopt-or-create reads stay within budget.
