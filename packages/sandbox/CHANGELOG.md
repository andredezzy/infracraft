# @infracraft/sandbox

## 0.2.0

### Minor Changes

- 50edf13: DX-hardening wave — preflight doctor, awk filter input validation, provider test coverage:

  - **Preflight doctor.** New `assertHostBinaries(binaries)` (exported from `@infracraft/sandbox` and re-exported via `@infracraft/pulumi/sandbox`) checks every listed binary against the host PATH via POSIX `command -v` and throws a single error naming ALL missing binaries with a friendly install hint for each known one (git, rsync, awk, mktemp, node, railway, vercel, fly). `prepareSandboxWorkspace()` now asserts the core POSIX set (git, rsync, awk, mktemp) before creating the workspace, so a broken host fails fast instead of midway through a deploy script; `FlyDeploy`/`VercelDeploy` document it as the recommended preflight for their CLIs.
  - **awk filter input validation.** `buildSandboxFileFilter` now rejects an `excludePaths` entry containing a single quote or a newline with a clear error — such an entry would break out of the single-quoted awk program (`escapeAwkRegex` escapes ERE metacharacters only), and paths like that are pathological, not a real use case.
  - **Test-coverage wave.** Unit tests for the Fly provider lifecycle (`FlyApp`, `FlySecret`, `FlyCertificate`, `FlyIp`, plus `FlyVolume` create paths) and for batch variable upserts on both platforms (`RailwayVariable`, `VercelVariable`): adopt-vs-create, read/refresh drift behavior as implemented, delete idempotence, and diff replace keys.

## 0.1.3

### Patch Changes

- ba9e44e: Fix: the deploy-sandbox file filter now keeps the `package.json` of EVERY excluded directory, not just `apps/*` ones. A blanket exclusion of a directory that is also a workspace member (e.g. `infrastructure/`) starved the sandboxed `bun install` of that member's manifest and failed the whole build with `Workspace not found`. A kept manifest for a non-member directory is inert, so the rule is now uniform.

## 0.1.2

### Patch Changes

- 93b6d30: Docs: reword the sandbox and Git Guard READMEs around deploy isolation — a clean copy of the repo's tracked files instead of the live working tree. The gate deploy log line now reads "stub .git" to match.

## 0.1.1

### Patch Changes

- b2fc0a3: Every published package now ships its own README: sandbox gains one, pulumi's gets its own package identity, and the root README becomes a general overview that points into each package. npm descriptions added/tightened.

## 0.1.0

### Minor Changes

- 00b9131: Initial release: sandbox shell-script builders (`SandboxMode`, `buildSandboxScript`, `buildSandboxFileFilter`) and `prepareSandboxWorkspace`, extracted from `@infracraft/pulumi`.
