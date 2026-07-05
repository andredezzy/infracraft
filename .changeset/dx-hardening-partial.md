---
"@infracraft/sandbox": minor
"@infracraft/pulumi": patch
---

DX-hardening wave — preflight doctor, awk filter input validation, provider test coverage:

- **Preflight doctor.** New `assertHostBinaries(binaries)` (exported from `@infracraft/sandbox` and re-exported via `@infracraft/pulumi/sandbox`) checks every listed binary against the host PATH via POSIX `command -v` and throws a single error naming ALL missing binaries with a friendly install hint for each known one (git, rsync, awk, mktemp, node, railway, vercel, fly). `prepareSandboxWorkspace()` now asserts the core POSIX set (git, rsync, awk, mktemp) before creating the workspace, so a broken host fails fast instead of midway through a deploy script; `FlyDeploy`/`VercelDeploy` document it as the recommended preflight for their CLIs.
- **awk filter input validation.** `buildSandboxFileFilter` now rejects an `excludePaths` entry containing a single quote or a newline with a clear error — such an entry would break out of the single-quoted awk program (`escapeAwkRegex` escapes ERE metacharacters only), and paths like that are pathological, not a real use case.
- **Test-coverage wave.** Unit tests for the Fly provider lifecycle (`FlyApp`, `FlySecret`, `FlyCertificate`, `FlyIp`, plus `FlyVolume` create paths) and for batch variable upserts on both platforms (`RailwayVariable`, `VercelVariable`): adopt-vs-create, read/refresh drift behavior as implemented, delete idempotence, and diff replace keys.
