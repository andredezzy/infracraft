<p align="center">
  <b>@infracraft/sandbox</b>
  <br />
  <i>Isolated /tmp working copies for CLI deploys.</i>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@infracraft/sandbox"><img src="https://img.shields.io/npm/v/@infracraft/sandbox?style=flat&colorA=18181b&colorB=18181b" alt="npm" /></a>
  <a href="https://www.npmjs.com/package/@infracraft/sandbox"><img src="https://img.shields.io/npm/dm/@infracraft/sandbox?style=flat&colorA=18181b&colorB=18181b" alt="downloads" /></a>
  <a href="https://github.com/andredezzy/infracraft/blob/main/LICENSE"><img src="https://img.shields.io/github/license/andredezzy/infracraft?style=flat&colorA=18181b&colorB=18181b" alt="license" /></a>
</p>

---

Platform CLIs (`vercel`, `railway`, `fly`) read whatever sits in your working tree — untracked files, local config, and half-finished changes included. This package builds the POSIX shell scripts that run those CLIs from an isolated copy of the repo's tracked files under `/tmp/infracraft` instead, so a deploy sees a clean checkout of exactly what git tracks.

It is the deploy-isolation engine behind [`@infracraft/pulumi`](https://www.npmjs.com/package/@infracraft/pulumi) (the `DeploySandbox` and `GitGuard` resources) and [`@infracraft/gate`](https://www.npmjs.com/package/@infracraft/gate) (sandboxed deploys by default). Use it directly to give any other CLI the same treatment.

## Install

```bash
npm i @infracraft/sandbox
# or
bun add @infracraft/sandbox
```

Zero runtime dependencies. The generated scripts need `git`, `rsync`, and `awk` on the machine that runs them, all present on stock macOS and Linux.

## Usage

```typescript
import {
  buildSandboxScript,
  prepareSandboxWorkspace,
  SandboxMode,
} from "@infracraft/sandbox"

// mkdir /tmp/infracraft and sweep sandboxes older than 3 hours
prepareSandboxWorkspace()

const script = buildSandboxScript({
  mode: SandboxMode.STUB,
  appName: "web",
  env: "production",
  excludePaths: ["apps/docs"],   // drop other apps from the upload (STUB mode only)
  cli: "vercel deploy --prod --yes",
})

// Run with /bin/sh -c; the platform CLI's exit code becomes the script's.
// Keep tokens in the spawn env, never inside the script string.
```

The script copies the repo's tracked files (`git ls-files`) into a fresh `mktemp -d` directory under `/tmp/infracraft`, prepares `.git` according to the mode, runs the optional `setup` shell and then `cli` from inside the copy, and removes the sandbox on exit via `trap`.

## Modes

`SandboxMode` is the closed set of isolation levels:

| Mode | Working copy | `.git` the platform sees |
|---|---|---|
| `NONE` | Live repo tree (no isolation) | The real one |
| `ORIGINAL` | Isolated `/tmp/infracraft` copy of tracked files | The real one, copy-on-write copied into the sandbox |
| `STUB` | Isolated copy with `excludePaths` applied | A fresh `git init` + `git add -A` stub with an unborn HEAD |

## API surface

| Export | Kind | Notes |
|---|---|---|
| `buildSandboxScript(options)` | function | Builds the shell a deploy command runs; returns a single `sh -c` ready string |
| `SandboxScriptOptions` | interface | `mode`, `appName`, `cli`, plus optional `env`, `excludePaths`, `setup` |
| `SandboxMode` | enum | `NONE`, `ORIGINAL`, `STUB` |
| `buildSandboxFileFilter(excludePaths)` | function | Portable awk filter applied to the `git ls-files` list before the copy; keeps `apps/<x>/package.json` so the workspace graph survives |
| `prepareSandboxWorkspace()` | function | Creates `/tmp/infracraft` and garbage-collects sandboxes older than 3 hours |

## Hardening

- Every script runs under `set -e`; any failed step aborts instead of letting the CLI run against partial state.
- No pipes in the copy path. The scripts target plain `/bin/sh` (which may be dash), where `pipefail` does not exist, so the file list is staged through intermediate files and a failing `git ls-files` aborts the run.
- Sandbox directories are named `<project>-<env>-<app>.XXXXXX`, so leftovers and concurrent deploys are identifiable at a glance.
- Each script removes its own sandbox on exit; `prepareSandboxWorkspace()` sweeps anything a hard-killed run left behind.

## License

MIT
