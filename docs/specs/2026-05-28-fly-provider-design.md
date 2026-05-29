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
| `FlyCertificate` | hostname (no `id` field; hostname is the key) | real (`DELETE /certificates/{hostname}`) | `.id` (= hostname), `.configured`, `.dnsRequirements` (ACME challenge + ownership records) |
| `FlyIp` | type + region | real (`releaseIpAddress`) | `.id` (= allocated address) |
| `FlyDeploy` | — | — (Command lifecycle) | — |

`FlyApp.delete()` is a no-op because deleting a Fly app destroys everything in it — the same protection Railway/Neon apply to projects. All child resources perform real deletes.

## Public API

```typescript
import {
  FlyProvider, FlyApp, FlySecret, FlyVolume, FlyCertificate, FlyIp, FlyDeploy,
  FlyAutoStopMachines, FlyDeployStrategy, FlyIpType,
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
  region: "iad",
  sizeGb: 10,
}, { provider, app });

// Certificate — custom domain TLS; exposes DNS validation target
const cert = new FlyCertificate("api-cert", {
  hostname: "api.example.com",
}, { provider, app });

// Dedicated IP (GraphQL)
const ip = new FlyIp("api-ip", { type: FlyIpType.SHARED_V4 }, { provider, app });

// Deploy — `fly deploy` with consumer-controlled triggers
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
      autoStopMachines: FlyAutoStopMachines.OFF,
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

2. **Enum value casing + complete closed unions.** The global rule "enum values are UPPERCASE" cannot apply to fly.toml literals, which Fly requires verbatim in lowercase. Additionally, `FlyRegion` and `FlyVmSize` are now **complete closed string-literal unions** — every documented region code and machine size is enumerated with no `| (string & {})` escape hatch, so invalid values are a compile error. Therefore:
   - **Closed small sets use enums with UPPERCASE keys + Fly's literal lowercase values**, e.g. `enum FlyDeployStrategy { BLUEGREEN = "bluegreen", ROLLING = "rolling", IMMEDIATE = "immediate", CANARY = "canary" }`. Applies to: deploy strategy, restart policy, auto-stop, concurrency type, cpu kind, port handlers, service protocol, check type.
   - **`FlyRegion` and `FlyVmSize` are complete closed string-literal union types** (not enums, so consumers write the raw string like `"iad"` or `"shared-cpu-1x"`). This gives full compile-time safety. **Tradeoff:** when Fly adds a new region or machine size, the package must be updated and a new version released. This is an explicit, visible contract rather than silent acceptance of any string.

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
| `FlyCertificate` | `id` (= hostname), `configured`, `dnsRequirements` (ACME challenge + ownership DNS records) |
| `FlyIp` | `id` (allocated address) |

## Registration, tests, README

- **Registration (two lines):** add `'src/fly/index.ts'` to `entry` in `tsdown.config.ts`; add `"./fly": { types, default }` to `exports` in `package.json`. `@pulumi/command` is already an optional peer dep.
- **Tests:** `client.test.ts` exercises the REST client (incl. secrets) and GraphQL path through fetch mocks; `toml.test.ts` asserts `generateFlyToml()` output for representative configs. Same client-seam approach as the other providers.
- **README:** the implementation ends by bringing `README.md` fully up to date — a Fly section matching how Vercel is documented (context-based API, the full resource set, consumer-controlled triggers, `@infracraft/pulumi/fly` import), verified against the shipped API.

## Verified API contracts (research, 2026-05-28)

- **Apps:** `POST /v1/apps {app_name, org_slug}` → `{id, created_at}` (name not echoed); `GET /v1/apps/{name}` → `{id, name, status, organization{slug}}`; `DELETE /v1/apps/{name}` → 202. All child paths key off the **name**, so `FlyApp.id` = name.
- **Secrets (REST, the Oct 2025 default in flyctl/fly-go):** bulk `POST /v1/apps/{app}/secrets {values:{KEY:"v", KEY_TO_DELETE:null}}` → `{secrets, version}` (uint64). `version` drives `FlySecret.version`. Set takes effect on next machine restart/deploy (hence the deploy trigger). Source of truth is `superfly/fly-go` (not in the public OpenAPI spec).
- **Volumes:** `POST /v1/apps/{app}/volumes {name, region, size_gb}` → 200 `{id: "vol_…", …}`; adopt by listing `GET .../volumes` and matching `name`.
- **Certificates:** `POST /v1/apps/{app}/certificates/acme {hostname}` → 201 with `dns_requirements{acme_challenge{name,target}, ownership{name,app_value}}` + `configured`; **no `id`** — hostname is the key; `DELETE /v1/apps/{app}/certificates/{hostname}` → 204.
- **IP (GraphQL):** `allocateIpAddress(input:{appId,type,region?})`; `IPAddressType` ∈ `v4|v6|private_v6|shared_v4`. `shared_v4` returns a null `ipAddress` in the payload — read `app.sharedIpAddress` instead. `releaseIpAddress(input:{ip|ipAddressId})`.
- **fly.toml / flyctl:** `[[vm]].count` is not a real field (drop it; scale is separate); `auto_stop_machines` is a string enum (`off|stop|suspend`), `auto_start_machines` is bool; deploy strategy ∈ `rolling|immediate|canary|bluegreen`; restart policy ∈ `always|on-failure|never`. `fly deploy` flags: `--config`, `--remote-only`, `--ha[=false]`, `--wait-timeout`, `--release-command-timeout`, `--strategy`; `FLY_API_TOKEN` authenticates flyctl.

## Railway provider closed-set decisions (2026-05-29)

Mirroring the Fly enum-vs-union audit, the following Railway fields were converted to fully type-safe closed sets:

| Field | Type | Values | Notes |
|---|---|---|---|
| `RailwayServiceArgs.builder` / `RailwayServiceInputs.builder` | `enum RailwayBuilder` | `RAILPACK`, `NIXPACKS`, `DOCKERFILE`, `HEROKU`, `PAKETO` | Source: `railway.schema.json`. `HEROKU` and `PAKETO` are deprecated (Feb 21 2025, auto-migrated to NIXPACKS) but remain in the schema and are accepted by the API. |
| `RailwayServiceArgs.restartPolicyType` / `RailwayServiceInputs.restartPolicyType` | `enum RailwayRestartPolicy` | `ON_FAILURE`, `ALWAYS`, `NEVER` | Source: `railway.schema.json` + docs. Exactly three values; ON_FAILURE is the default. |
| `RailwayDeployConfig.builder` | `RailwayBuilder` (reuse same enum) | same as above | Imported from `service.ts`; no new enum defined. |

Both enums follow the pattern: **UPPERCASE keys + UPPERCASE wire values** (Railway's API requires the literal uppercase strings, matching the enum values exactly — no casing mismatch unlike Fly's lowercase toml literals).

Fields kept as `string`: `name`, `buildCommand`, `startCommand`, `healthcheckPath`, `preDeployCommand`, `icon`, `image` — all genuinely open free-form values.

## Residual uncertainties (handle defensively in code)

- HTTP status for duplicate `POST /v1/apps` is undocumented — treat any non-2xx on create-after-404 as "already exists" and re-read.
- `releaseIpAddress` input SDL isn't in the published GraphQL schema (sourced from `fly-go`); prefer `ipAddressId` from a prior `app.ipAddresses` query, fall back to `ip`.
- GraphQL is Fly's "old" API and may migrate IP allocation to REST (`POST /apps/:name/ip_assignments`) later — isolate it behind `FlyClient.graphql()` so a future swap touches one file.
