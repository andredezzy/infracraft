<p align="center">
  <b>infracraft</b>
  <br />
  <i>Infrastructure and deploy tooling for Vercel, Railway, Fly.io, and Neon.</i>
</p>

<p align="center">
  <a href="https://github.com/andredezzy/infracraft/blob/main/LICENSE"><img src="https://img.shields.io/github/license/andredezzy/infracraft?style=flat&colorA=18181b&colorB=18181b" alt="license" /></a>
</p>

---

infracraft is a small family of packages for crafting infrastructure on app platforms: native Pulumi providers, a multi-account CLI switcher, and the deploy sandbox both of them share. Everything is hand-rolled against each platform's own API; nothing bridges Terraform.

## Packages

| Package | Version | What it does |
|---|---|---|
| [`@infracraft/pulumi`](packages/pulumi) | [![npm](https://img.shields.io/npm/v/@infracraft/pulumi?style=flat&colorA=18181b&colorB=18181b)](https://www.npmjs.com/package/@infracraft/pulumi) | Native Pulumi providers for Railway, Neon, Vercel, and Fly.io with adopt-or-create semantics and deploy orchestration. |
| [`@infracraft/gate`](packages/gate) | [![npm](https://img.shields.io/npm/v/@infracraft/gate?style=flat&colorA=18181b&colorB=18181b)](https://www.npmjs.com/package/@infracraft/gate) | Multi-account switcher for Vercel, Railway, and Fly.io. Really switches the native CLI session and sandboxes deploys by default. |
| [`@infracraft/sandbox`](packages/sandbox) | [![npm](https://img.shields.io/npm/v/@infracraft/sandbox?style=flat&colorA=18181b&colorB=18181b)](https://www.npmjs.com/package/@infracraft/sandbox) | Isolated `/tmp` working copies for CLI deploys. The shell-script builders behind the sandboxed deploys in both packages above. |

Each package's README is its full documentation; the sections below are orientation only.

## @infracraft/pulumi

Pulumi providers for platforms that don't have one. Railway (the only Pulumi provider for it), Neon, Vercel, and Fly.io, plus deterministic hashing for deploy triggers, operating hints for AI coding agents, and sandbox/git-guard deploy isolation.

```bash
npm i @infracraft/pulumi
```

```typescript
import { RailwayProject } from "@infracraft/pulumi/railway"

const project = new RailwayProject("my-project", { name: "my-app" }, { provider })
```

[Read the full docs](packages/pulumi)

## @infracraft/gate

Native CLIs (`vercel`, `railway`, `fly`) hold one account at a time. gate stores as many accounts as you need per provider, really switches the native CLI session, and runs deploys from an isolated sandbox copy of the repo's tracked files by default.

```bash
bun add -g @infracraft/gate

gate vercel switch work
gate railway up --detach
gate fly auth list
```

[Read the full docs](packages/gate)

## @infracraft/sandbox

The shared deploy-isolation primitives: POSIX shell-script builders that copy a repo's tracked files into `/tmp` and run the platform CLI from there. Consumed by the two packages above; use it directly to give any CLI the same treatment.

[Read the full docs](packages/sandbox)

## Design

- **Native APIs, no bridges.** Every provider integration talks to the platform's own REST or GraphQL API. No Terraform providers underneath.
- **Adopt-or-create.** Existing infrastructure is discovered by name and adopted into state instead of fought over.
- **Sandboxed deploys.** Deploys run from an isolated `/tmp` copy of the repo's tracked files, so the platform CLI never reads the live working tree. Shared between pulumi and gate via the sandbox package.
- **Real switching.** gate writes sessions into the native CLI auth files; there is no wrapper state to drift out of sync.

## Development

A [Bun](https://bun.sh) monorepo orchestrated by turbo. The private `packages/config-*` workspaces hold the shared tsdown, TypeScript, and vitest presets.

```bash
bun install        # also builds all packages (postinstall)
bun run build
bun run test
bun run lint
bun run knip
```

Releases go through [changesets](https://github.com/changesets/changesets): every change lands with a changeset, a "Version packages" PR accumulates them on `main`, and merging that PR publishes to npm with provenance.

## License

MIT
