# @infracraft/sandbox

## 0.1.2

### Patch Changes

- 93b6d30: Docs: reword the sandbox and Git Guard READMEs around deploy isolation — a clean copy of the repo's tracked files instead of the live working tree. The gate deploy log line now reads "stub .git" to match.

## 0.1.1

### Patch Changes

- b2fc0a3: Every published package now ships its own README: sandbox gains one, pulumi's gets its own package identity, and the root README becomes a general overview that points into each package. npm descriptions added/tightened.

## 0.1.0

### Minor Changes

- 00b9131: Initial release: sandbox shell-script builders (`SandboxMode`, `buildSandboxScript`, `buildSandboxFileFilter`) and `prepareSandboxWorkspace`, extracted from `@infracraft/pulumi`.
