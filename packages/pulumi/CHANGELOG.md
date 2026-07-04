# @infracraft/pulumi

## 1.18.0

### Minor Changes

- dcb7e4b: Add VercelDomain — attach a custom domain to a Vercel project (adopt-or-create)

### Patch Changes

- dcb7e4b: RailwayService: scope serviceCreate to the target environment (environmentId was omitted, first deploy landed in the default environment)

## 1.17.4

### Patch Changes

- 93b6d30: Docs: reword the sandbox and Git Guard READMEs around deploy isolation — a clean copy of the repo's tracked files instead of the live working tree. The gate deploy log line now reads "stub .git" to match.

## 1.17.3

### Patch Changes

- b2fc0a3: Every published package now ships its own README: sandbox gains one, pulumi's gets its own package identity, and the root README becomes a general overview that points into each package. npm descriptions added/tightened.

## 1.17.2

### Patch Changes

- 00b9131: Sandbox internals moved to `@infracraft/sandbox` and re-exported unchanged from `@infracraft/pulumi/sandbox` — no API change.
