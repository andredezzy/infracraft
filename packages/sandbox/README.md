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

Zero runtime dependencies. The generated scripts need `git`, `rsync`, `awk`, and `mktemp` on the machine that runs them — all present on stock macOS and Linux, and asserted up front by `prepareSandboxWorkspace()` (see [Preflight](#preflight)).

## Usage

```typescript
import {
  buildSandboxScript,
  prepareSandboxWorkspace,
  SandboxMode,
} from "@infracraft/sandbox"

// Assert git/rsync/awk/mktemp, mkdir /tmp/infracraft, and sweep sandboxes
// older than 3 hours
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
| `ORIGINAL` | Isolated `/tmp/infracraft` copy of tracked files | The real one, CoW-copied into the sandbox (plain-copy fallback on non-CoW filesystems) |
| `STUB` | Isolated copy with `excludePaths` applied | A fresh `git init` + `git add -A` stub with an unborn HEAD |

## Preflight

`assertHostBinaries(binaries)` checks every listed binary against the host PATH (POSIX `command -v`) and throws a single error naming ALL missing ones, with a friendly install hint for each known binary (`git`, `rsync`, `awk`, `mktemp`, `node`, `railway`, `vercel`, `fly`) — so a deploy fails fast with actionable guidance instead of dying midway through a shell script with an opaque "command not found".

```typescript
import { assertHostBinaries } from "@infracraft/sandbox"

assertHostBinaries(["git", "rsync", "awk", "mktemp", "fly"])
```

`prepareSandboxWorkspace()` runs it for the core POSIX set (`git`, `rsync`, `awk`, `mktemp`) automatically before creating the workspace; add the platform CLIs your deploys use yourself.

## API surface

| Export | Kind | Notes |
|---|---|---|
| `buildSandboxScript(options)` | function | Builds the shell a deploy command runs; returns a single `sh -c` ready string |
| `SandboxScriptOptions` | interface | `mode`, `appName`, `cli`, plus optional `env`, `excludePaths`, `setup` |
| `SandboxMode` | enum | `NONE`, `ORIGINAL`, `STUB` |
| `buildSandboxFileFilter(excludePaths)` | function | Portable awk filter applied to the `git ls-files` list before the copy; keeps each excluded directory's own `package.json` so the workspace graph survives. Rejects entries containing a single quote or newline (they would break out of the single-quoted awk program) |
| `assertHostBinaries(binaries)` | function | Preflight doctor: throws one error naming ALL missing host binaries, with install hints |
| `prepareSandboxWorkspace()` | function | Asserts the core POSIX binaries, creates `/tmp/infracraft`, and garbage-collects sandboxes older than 3 hours |

## Hardening

- Every script runs under `set -e`; any failed step aborts instead of letting the CLI run against partial state.
- No pipes in the copy path. The scripts target plain `/bin/sh` (which may be dash), where `pipefail` does not exist, so the file list is staged through intermediate files and a failing `git ls-files` aborts the run.
- Sandbox directories are named `<project>-<env>-<app>.XXXXXX`, so leftovers and concurrent deploys are identifiable at a glance.
- Each script removes its own sandbox on exit; `prepareSandboxWorkspace()` sweeps anything a hard-killed run left behind.
- `excludePaths` entries are validated before they reach the awk program: a single quote or newline is rejected with a clear error instead of silently breaking the shell quoting.

## Release history

See [CHANGELOG.md](CHANGELOG.md) for release history.

## License

MIT
