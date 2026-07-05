# @infracraft/sandbox

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
