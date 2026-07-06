# Native Provider Graduation (Phase 0)

## Goal

Graduate `@infracraft/pulumi` from Pulumi **dynamic providers** (`pulumi.dynamic.Resource`, provider code serialized per-resource into stack state) to a **native Pulumi provider** (a versioned `pulumi-resource-infracraft` plugin with a `schema.json`), without replacing a single resource in the existing stacks (`the consumer program` staging + production) and without changing the public API of the npm package.

The battle-tested behavior is the spec: adopt-or-create on every `create()`, Railway `serviceInstanceDeployV2` semantics, idempotent/no-op deletes on top-level resources, `tokenVersion` rotation with mint-before-revoke, and `stables` declarations that keep dependents preview-clean. All of it carries over verbatim — the existing unit suite (197 tests across the platform `__tests__/` directories at time of writing) becomes the equivalence gate for each native twin.

This is a design document only. No code changes.

## Where we are

Every platform resource today is a `ComponentResource` wrapping an internal `pulumi.dynamic.Resource` whose `ResourceProvider` implements `check`/`create`/`read`/`update`/`delete`/`diff` against the platform's REST/GraphQL API:

| Platform | Dynamic resource leaves | Components (unaffected by graduation) |
|---|---|---|
| Railway | Project, Environment, Service, Variable, Domain, Volume, ProjectToken (7) | railway.Provider, railway.Deploy, deployment-monitor |
| Neon | Project, Branch, Endpoint, Role, Database (5) | neon.Provider |
| Vercel | Project, Variable, Domain, Integration, ResourceConnection, MarketplaceResource (6) | vercel.Provider, vercel.Deploy |
| Fly | App, Secret, Volume, Certificate, Ip (5) | fly.Provider, fly.Deploy, toml |

23 dynamic resource types total. The deploy components (`@pulumi/command`-based), providers-as-credential-holders, `agents`, `git-guard`, `hash`, and `sandbox` never were dynamic resources — they stay SDK-side and are out of scope.

## Authoring options

Researched against current official sources, 2026-07-05. Full citations in [Sources](#sources).

### (a) pulumi-go-provider

[`github.com/pulumi/pulumi-go-provider`](https://github.com/pulumi/pulumi-go-provider) is at **v1.3.2 (released 2026-04-27)** — post-1.0, actively maintained (32 releases), and the framework Pulumi's own docs recommend: "The Pulumi Go Provider SDK — the most streamlined approach for Go."

Its `infer` API generates full providers from Go types: resources implement `CustomResource[I, O]` with optional `Create`/`Read`/`Update`/`Delete`/`Check`/`Diff` methods, `pulumi:"...,optional|secret"` struct tags drive schema generation with zero hand-authored `schema.json`, `infer.Config[T]` gives first-class provider configuration retrievable via `infer.GetConfig[T](ctx)`, `Read` enables `pulumi import`/refresh, and `StateMigrations` handles state schema evolution. Middleware, a testing framework, and `pulumi package gen-sdk` for multi-language SDKs come with it.

**Cost for this repo:** everything is Go. The four platform clients (`railway/client.ts`, `neon/client.ts`, `vercel/client.ts`, `fly/client.ts`), all 23 resource providers, and every live-debugged edge case (e.g. the `serviceInstanceDeployV2` quirk proven live 2026-07-06, the `serviceInstanceUpdate` healthcheck-retry fallback, marketplace-resource flows) would be rewritten. The 197 vitest tests cannot run against Go — the "tests are the spec" property degrades to "tests are a document someone translates," which is exactly where regressions creep in.

### (b) TypeScript on `@pulumi/pulumi/provider`

Verified against the **installed SDK, `@pulumi/pulumi` 3.243.0** (`node_modules/@pulumi/pulumi/provider/`):

- `provider/provider.d.ts` exports a stable `Provider` interface with the **full custom-resource lifecycle** — `check(urn, olds, news)`, `diff(id, urn, olds, news)`, `create(urn, inputs)`, `read(id, urn, props)`, `update(id, urn, olds, news)`, `delete(id, urn, props)` — plus `construct`, `call`, `invoke`, `getSchema`, `parameterize`, `cancel`. This is **not** components-only.
- `provider/server.d.ts` exports `main(provider, args)`, which serves that interface over gRPC (`@grpc/grpc-js` + Pulumi's `provider_grpc_pb`) — the plugin process entry point. No hand-rolled gRPC needed.
- The **experimental** namespace (`provider/experimental/`) *is* components-only (`ComponentProvider` implements just `getSchema` + `construct`, with schema inference from TS types) — irrelevant here except as evidence that TS schema inference for custom resources does not exist yet.
- **Verified gap:** in `provider/server.js`, `checkConfig`/`diffConfig` return gRPC `UNIMPLEMENTED` and `configure()` acknowledges the request without forwarding config to the `Provider` implementation — the interface has no `configure` member. Provider-level config (`pulumi:providers:*` inputs) is **not surfaced to a TS provider today**. Consequence handled in [What graduation buys, (c)](#c-credentials-in-provider-config).

The official [Build a provider](https://www.pulumi.com/docs/iac/extending-pulumi/build-a-provider/) docs acknowledge this layer — "implement the gRPC interface directly in Python, Go, TypeScript, or any language with gRPC support" — but offer no TS framework; schema is hand-authored on this path.

The method shapes are near-identical to `pulumi.dynamic.ResourceProvider` (the dynamic host is itself a Node provider built on this exact interface): the dynamic signatures just lack the `urn` parameter. Adapting `railway.ServiceResourceProvider` & co. is mechanical — the method bodies, the clients, and the tests survive unchanged.

### (c) pulumi-provider-boilerplate

[`github.com/pulumi/pulumi-provider-boilerplate`](https://github.com/pulumi/pulumi-provider-boilerplate) is the officially maintained template (v0.0.175, 2026-02-12, actively released) — but it is a **Go** scaffold built on pulumi-go-provider: Makefile-driven `pulumi-resource-{NAME}` binary, SDK codegen for dotnet/go/nodejs/python. It is the packaging reference for option (a), not an independent path. Its release layout (GitHub Releases + per-OS/arch tarballs) is worth copying regardless of language.

### Recommendation: TypeScript on `@pulumi/pulumi/provider`

Grounded in this repo's reality:

1. **The behavioral spec is executable only in TypeScript.** The 197 unit tests exercise the exact `ResourceProvider` classes that graduate. On the TS path they keep running against the same classes, unmodified, and *are* the equivalence gate. On the Go path they become prose.
2. **~90% of the code carries over.** Clients, provider classes, error taxonomy, `resilient-fetch`, drift tests — all reused. The delta is a dispatch layer (URN type token → handler), a `schema.json`, and packaging. A Go rewrite's delta is everything.
3. **The team is TypeScript-first**, and the consumers (the consumer program `infrastructure/`, TS Pulumi programs) are Node programs — dynamic providers were already same-language-only, so a TS-only plugin loses nothing that exists today.
4. **The trade-off is honest:** we give up `infer`'s schema generation (hand-author `schema.json`, guarded by a drift test) and, until upstream support lands, first-class provider config (see below). We keep every battle-tested behavior at zero translation risk. Simplicity and DX win: one language, one mental model, one test suite.

Go remains the documented escape hatch if the TS substrate hits a wall (e.g. config plumbing never lands upstream and env-based credentials prove insufficient); the schema, state shapes, and type tokens designed here are language-neutral, so a later Go port would be a reimplementation behind the same contract, not a second migration for consumers.

## What graduation buys

Each substrate gap, mapped to its native-provider resolution:

### (a) Per-resource serialized closures → versioned plugin process

Today "provider methods are serialized to run in a separate process" ([dynamic providers docs](https://www.pulumi.com/docs/iac/concepts/resources/dynamic-providers/)) — the closure is stored per-resource in state as `__provider`. Two consequences: **fossilization** ([pulumi/pulumi#6238](https://github.com/pulumi/pulumi/issues/6238) class: a buggy `delete` serialized into state keeps executing the *old* code even after the source is fixed, making the resource undeletable without state surgery), and **preview noise** (any change to the package or its dependency graph reserializes the closure, diffing `__provider` on every dynamic resource in every stack).

Native resolution: the engine launches the `pulumi-resource-infracraft` plugin binary/dir from `~/.pulumi/plugins` at the version the SDK requests — deletes and updates always run the **installed** provider version. `__provider` ceases to exist; package upgrades stop diffing untouched resources.

### (b) `pulumi import` + `.get()` via proper read

Dynamic docs, verbatim: "The `read` method is not currently functional, so `pulumi import` and the static `get` method are not supported." (Our `read()` implementations serve `pulumi refresh` only.)

Native resolution: resources declared in `schema.json` + `read` implemented in the provider get `pulumi import infracraft:railway:ServiceResource <name> <id>` and static getters for free — the same engine machinery every schema'd provider uses. In pulumi-go-provider this is the `CustomRead` interface ("supports `pulumi import` and refresh operations"); on the TS path it is the same `read(id, urn, props)` we already implement, now reachable by the engine's import path because the type token exists in a schema.

### (c) Credentials in provider config

Today every leaf carries `token` in its inputs *and* outputs (state), mitigated with `additionalSecretOutputs: ["token"]`. Rotating a platform token rewrites the state of every resource.

Native resolution — split by framework:

- **pulumi-go-provider:** fully solved: `infer.Config[T]` with `pulumi:"apiKey,secret"` fields makes credentials first-class provider-resource config (`pulumi:providers:infracraft`), encrypted once on the provider resource, never on leaves.
- **TS path (recommended), as of `@pulumi/pulumi` 3.243.0:** provider config is **not plumbed through** to the TS `Provider` implementation (verified: `configure()` in `provider/server.js` discards the request's variables; `checkConfig`/`diffConfig` are `UNIMPLEMENTED`). Interim design: credentials stay **secret resource inputs** (exact status quo — already encrypted in state, zero regression), with **environment-variable fallback** (`RAILWAY_TOKEN`, `NEON_API_KEY`, `VERCEL_TOKEN`, `FLY_API_TOKEN`) read by the plugin process, which the consumer program can feed from Pulumi ESC `environmentVariables` — that path removes credentials from resource state entirely without waiting on upstream. Contributing `Provider.configure` support upstream is the tracked follow-up; when it lands, the SDK's `railway.Provider` et al. flip from injecting token inputs to configuring a first-class provider instance, with no public API change (the options pattern already funnels `provider:` through `opts`).

### (d) Schema-driven previews/diffs

Today previews show opaque `pulumi-nodejs:dynamic:Resource` entries with raw property bags (including the `__provider` blob). Native resolution: `schema.json` gives the engine typed, per-property diffs, schema-declared secrets masked in CLI/Service UIs, documented properties in `pulumi preview --diff`, and Registry-grade docs generated from the same schema. Our `diff()` implementations (including `stables` and `deleteBeforeReplace`) keep working exactly as they do now — the `DiffResult` shape is identical in the native `Provider` interface (verified in `provider/provider.d.ts`).

## Native provider architecture

One Pulumi package, `infracraft`, one plugin, four modules — mirroring the source layout that already exists:

```
packages/pulumi/src/
  provider/
    main.ts          #!/usr/bin/env node — provider.main(new InfracraftProvider(), args)
    infracraft-provider.ts   Provider impl: URN type token → handler registry dispatch
    schema.ts        loads/serves schema.json (getSchema)
    schema.json      hand-authored package schema (drift-tested)
  railway/…          existing handler classes, adapted signatures (urn param)
  neon/…             unchanged clients, same tests
  vercel/…
  fly/…
```

- **Type tokens:** custom resources take their existing internal class names — `infracraft:railway:ServiceResource`, `infracraft:neon:BranchResource`, … The `infracraft:railway:Service` tokens stay owned by the ComponentResource wrappers (they are recorded in existing state; renaming them would force a second alias surface for zero benefit). Flattening wrapper + leaf into a single schema'd resource is explicitly deferred to a future major.
- **Dispatch:** `InfracraftProvider` holds a registry `Record<typeToken, ResourceHandler>` where `ResourceHandler` is the existing per-resource provider class shape plus `urn`. Adding a platform = adding registrations, open/closed.
- **Public API unchanged:** `@infracraft/pulumi` remains the only thing consumers install. Wrapper components swap their internal `pulumi.dynamic.Resource` leaf for a hand-written `pulumi.CustomResource` subclass (which is all `pulumi package gen-sdk` would emit for Node anyway; codegen for other languages stays available later from the same schema). Consumers change **nothing** — not even for the migration (next section).

## Migration path

The critical constraint: the consumer program staging and production have 18 dynamic resource types in state (Railway 7, Neon 5, Vercel 6; Fly unused there), every one typed `pulumi-nodejs:dynamic:Resource`. The migration must produce **zero replacements** — several of these resources guard live infrastructure (databases, domains, deployed services).

### Aliases do the whole job

Per the [aliases docs](https://www.pulumi.com/docs/iac/concepts/options/aliases/): an alias makes Pulumi "treat the old URN as equivalent to the new one," and a **type-only alias** is the documented tool for "migrating to a different provider resource type" — no deletion, no replacement.

The graduation changes exactly one URN component per leaf: the type. Name (`${name}-resource`) and parent (the wrapper component, whose own URN is untouched) stay identical. So the new native leaf reconstructs its old URN with a single field:

```typescript
new railway.ServiceResource(`${name}-resource`, args, {
  parent: this,
  aliases: [{ type: "pulumi-nodejs:dynamic:Resource" }],
});
```

**The SDK injects this alias itself** — inside the wrapper components. Migration for a consumer is: bump `@infracraft/pulumi`, run `pulumi up`, watch every resource resolve as *update* (or *same*), not *replace*. No consumer code changes. Once all stacks have run one successful `up`, the alias is dead weight — the docs' removal rule applies ("Once a resource has been migrated on all stacks, the alias can be removed") and it ships out in the next major.

### Legacy-state tolerance

The first native `diff`/`check`/`update` calls receive `olds` produced by the dynamic era, containing fields the native inputs no longer carry: `__provider` (the serialized closure) and — once env-based credentials land — `token`. Each handler's `diff` must **ignore this legacy field set** (a shared `LEGACY_DYNAMIC_FIELDS` constant, one place) so their disappearance neither reports changes nor triggers updates on its own. The first real update naturally rewrites state without them. This rule is part of the equivalence suite: every handler gets a "diff against dynamic-era state is clean" test case fed with a captured state fixture.

Provider reference: the old leaves reference the ambient dynamic provider, the new ones the `infracraft` plugin. With the URN aliased, the engine adopts the resource and records the new provider on the same state entry as part of the step — this is the aliased-type migration path the docs describe, and it is exactly what the rehearsal below exists to prove per stack before any real stack runs it.

### Do we need `pulumi state repair` or export/transform/import? No.

- [`pulumi state repair`](https://www.pulumi.com/docs/iac/cli/commands/pulumi_state_repair/) fixes *invalid* state (out-of-order resources, dangling references). Our state is valid; the command "leaves valid state files untouched." Not part of this migration.
- Export/transform/import (hand-rewriting types in the JSON) would achieve the same rename as aliases but bypasses every engine safety check and invites hand-editing errors into production state. Aliases are the supported, reversible mechanism. **Export is used for backup and rehearsal only.**

### Procedure per stack

For each stack, staging before production, one platform phase at a time:

1. **Backup:** `pulumi stack export --file pre-native-<stack>-<date>.json` (checked into the ops vault, not git).
2. **Rehearsal:** create a scratch stack, `pulumi stack import` a copy of the exported state, point it at the new SDK version, run `pulumi preview --diff`. Gate: every graduating resource shows *update* or *same*; **zero** `replace`/`delete`. Previews call the native provider's `check`/`diff` without mutating the platform, so this rehearses the exact engine path against the real state shape, credential-free.
3. **Staging up:** `pulumi up` on staging; verify resolve types in the summary; run the app-level smoke checks.
4. **Soak:** one normal deploy cycle on staging (the main app's deploy path exercises Railway deploys, variables, domains end to end).
5. **Production up:** same, with the backup from step 1 fresh.

### Rollback

Two levels, both proven by the rehearsal step:

- **Before/at first `up`:** pin the previous `@infracraft/pulumi` version and run `pulumi up` — the dynamic leaves alias back trivially because nothing changed yet.
- **After a successful native `up`:** state now holds native-typed entries. Roll back by pinning the previous SDK **plus** adding the reverse alias (`aliases: [{ type: "infracraft:railway:ServiceResource" }]` on the dynamic leaves — the SDK ships a `INFRACRAFT_DYNAMIC_FALLBACK=1` escape hatch that constructs dynamic leaves with exactly that alias during each phase's soak window). Nuclear option: `pulumi stack import` the step-1 backup — safe because native updates PATCH only changed fields, so platform-side reality never diverged from the backup during a clean migration.

## Packaging & release

### schema.json

Hand-authored (the TS path has no inference), one file, drift-tested: a unit test walks the handler registry and asserts every registered type token exists in the schema with property sets matching the handler's input/output types (same spirit as the existing `*.drift.test.ts` files that pin external API surfaces). Required metadata per the [publishing docs](https://www.pulumi.com/docs/iac/guides/building-extending/packages/publishing-packages/): `name: infracraft`, `displayName`, `description`, `publisher`, `pluginDownloadURL`, per-resource `inputProperties`/`properties` with `secret: true` on credentials.

### Plugin distribution

Per the [executable-plugin guide](https://www.pulumi.com/docs/iac/guides/building-extending/packages/executable-plugin/) and [developer docs on plugins](https://pulumi-developer-docs.readthedocs.io/latest/docs/architecture/plugins.html):

- **Layout:** a "shimless" plugin — a directory containing `PulumiPlugin.yaml` (`runtime: nodejs`) plus the tsdown-bundled provider JS. The engine spawns it through the Node language host; no per-OS compilation, no shim scripts. Consumers already run Node (the SDK is TS-only), so this adds no requirement dynamic providers didn't have.
- **Archives:** `pulumi-resource-infracraft-v<version>-<os>-<arch>.tar.gz` for the six standard targets (`linux|darwin|windows` × `amd64|arm64`) — identical JS contents in each, since nothing is compiled.
- **Resolution:** `pluginDownloadURL: "github://api.github.com/andredezzy/infracraft"` in the schema (repo must be named explicitly — the default would look for `pulumi-infracraft`). The CLI auto-installs from GitHub Releases on first `pulumi up`, cached in `~/.pulumi/plugins` ([plugins docs](https://www.pulumi.com/docs/iac/concepts/plugins/)); air-gapped/CI images can `pulumi plugin install resource infracraft <version> --server github://api.github.com/andredezzy/infracraft`.

### npm SDK

Same package name — `@infracraft/pulumi`. Publishing a parallel package would fork the consumer base and break the "bump and up" migration; the whole point is that the SDK's public surface is unchanged. The package.json gains the standard native-SDK linkage block (verified in the installed `@pulumi/command` 1.2.1):

```json
"pulumi": { "resource": true, "name": "infracraft", "version": "<version>" }
```

which lets the engine discover the plugin requirement from `node_modules`, with the npm version and plugin version permanently identical.

### Changesets CI extension

`release.yml` today: changesets action → `bunx changeset publish` → npm. Extension, same workflow:

1. After `changeset publish`, detect whether `@infracraft/pulumi` published a new version (the action outputs published packages).
2. If so: build the plugin bundle (`tsdown` provider entry), assemble the six tarballs (one build, six names), and create GitHub Release `v<version>` with the tarballs as assets — the tag the `github://` resolver looks up.
3. Version source stays singular: changesets bumps `package.json`, and schema `version`, `pulumi.version`, and the release tag are all derived from it in the workflow. A CI assertion fails the release if any of the three diverge.

## Phased plan

Each phase ends behind the same gate, and each platform's **dynamic implementation stays in the package as fallback** (selected by `INFRACRAFT_DYNAMIC_FALLBACK`) until its native twin passes the gate and survives the soak. Dynamic code for a platform is deleted only in the post-migration major.

**Per-phase equivalence gate:**
1. The platform's existing unit tests pass against the native handler classes unmodified (signature adaptation only).
2. New dynamic-era state fixtures: `diff` is clean against captured pre-migration state (legacy-field tolerance).
3. Provider boot smoke test: `provider.main()` serves `GetSchema` + one full CRUD cycle over gRPC in CI.
4. **Live-integration tier** (the DX plan's live tier slots in here): env-gated vitest project (`test:live`, sibling of the existing `test:drift`) that runs adopt-or-create, update, rotation, and delete against a scratch project on the real platform API. Required once per phase exit, then scheduled like `drift.yml`.
5. Migration rehearsal green on exported the consumer program state (phases 2+).

**Phase 1 — substrate + Fly.** Provider skeleton (dispatch, schema, `main`), packaging, release pipeline, and Fly's 5 resources as the first native module. *Why Fly first:* it is the only platform with **no production stacks to migrate** (the consumer program uses Railway/Neon/Vercel only), so the entire pipeline — schema, plugin install from a GitHub Release, `pulumi import`, SDK linkage — gets proven end to end at zero migration risk, while still being a real, complete platform. Cut line: plugin installable from a public release; Fly gate green; no migration machinery yet.

**Phase 2 — Neon + first production migration.** Smallest migrated surface (5 resources), pure REST, protective no-op delete on Project already in place. This phase builds the migration machinery once — alias injection, legacy-field tolerance, rehearsal script, fallback flag — and proves it on the smallest blast radius: rehearsal → staging → soak → production. Cut line: both consumer stacks on native Neon.

**Phase 3 — Vercel.** 6 resources; the trickiest REST semantics outside Railway (integration/marketplace-resource flows, resource connections). Reuses the Phase-2 machinery unchanged. Cut line: both stacks on native Vercel.

**Phase 4 — Railway.** Last deliberately: largest surface (7 resources) and the densest battle-tested behavior — `serviceInstanceDeployV2` triggering, per-environment source application, ProjectToken mint-before-revoke rotation, `stables` for preview-clean dependents, project/service no-op deletes. By now the substrate and migration path have three platforms of mileage. Cut line: both stacks fully native.

**Post-phase (next major):** delete the dynamic implementations, the fallback flag, and the aliases; contribute/adopt upstream TS provider `configure` support and move credentials onto the provider resource proper.

## Key risks

| Risk | Mitigation |
|---|---|
| TS provider-config plumbing missing upstream (`configure` discarded, verified in 3.243.0) | Interim: secret inputs (status quo) + env-var credentials via ESC; upstream contribution tracked; Go escape hatch behind the same schema contract |
| TS custom-resource authoring is documented but not framework-supported ("Go is the practical choice for executable plugins") | We ride the stable `Provider`/`main()` surface the dynamic host itself uses; `@pulumi/pulumi` pinned; CI boot smoke test catches breakage on every bump |
| First aliased `up` produces replace instead of update (provider-reference edge) | Mandatory rehearsal on exported real state before any live stack; `--diff` gate of zero replaces; reverse-alias fallback + state backup |
| npm/plugin version skew breaks plugin resolution | Single version source (changesets) with a CI assertion across package.json / schema / release tag |
| Preview noise or drift between schema and handlers | Schema drift test wired into the existing drift suite |

## Sources

All fetched 2026-07-05.

- pulumi-go-provider repository (v1.3.2, 2026-04-27) — https://github.com/pulumi/pulumi-go-provider
- `infer` package reference (v1.3.2) — https://pkg.go.dev/github.com/pulumi/pulumi-go-provider/infer
- Build a provider — https://www.pulumi.com/docs/iac/extending-pulumi/build-a-provider/
- pulumi-provider-boilerplate (v0.0.175, 2026-02-12) — https://github.com/pulumi/pulumi-provider-boilerplate
- Dynamic providers (limitations: serialization, no import/`.get()`, same-language) — https://www.pulumi.com/docs/iac/concepts/resources/dynamic-providers/
- Dynamic provider fossilized in state for delete — https://github.com/pulumi/pulumi/issues/6238
- Resource aliases (type aliases, removal timing, parent-alias inheritance) — https://www.pulumi.com/docs/iac/concepts/options/aliases/
- `pulumi state repair` — https://www.pulumi.com/docs/iac/cli/commands/pulumi_state_repair/
- Publishing packages (SDK registries, Registry submission, schema metadata) — https://www.pulumi.com/docs/iac/guides/building-extending/packages/publishing-packages/
- Executable plugin packaging (archive naming, `github://` forms, six targets) — https://www.pulumi.com/docs/iac/guides/building-extending/packages/executable-plugin/
- Plugins concept (auto-install, `~/.pulumi/plugins`, `pulumi plugin install`) — https://www.pulumi.com/docs/iac/concepts/plugins/
- Plugin architecture, shimless `PulumiPlugin.yaml` plugins — https://pulumi-developer-docs.readthedocs.io/latest/docs/architecture/plugins.html
- Local verification: installed `@pulumi/pulumi` 3.243.0 (`provider/provider.d.ts`, `provider/server.js`, `provider/experimental/provider.d.ts`) and `@pulumi/command` 1.2.1 `package.json` `pulumi` block, both in this repo's `node_modules`.
