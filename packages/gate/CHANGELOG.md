# @infracraft/gate

## 0.8.4

### Patch Changes

- Bundle @infracraft/sandbox instead of depending on it at runtime (matches @infracraft/pulumi), so gate is self-contained and carries no workspace runtime dependency.

## 0.8.3

### Patch Changes

- Updated dependencies [0f3d40b]
  - @infracraft/sandbox@0.2.1

## 0.8.2

### Patch Changes

- Updated dependencies [50edf13]
  - @infracraft/sandbox@0.2.0

## 0.8.1

### Patch Changes

- Updated dependencies [ba9e44e]
  - @infracraft/sandbox@0.1.3

## 0.8.0

### Minor Changes

- a80eb12: `--project <name>` now works on EVERY vercel command through the passthrough: `gate vercel env ls --project hat-rec` resolves the project via the API and injects `VERCEL_PROJECT_ID`/`VERCEL_ORG_ID` (the CLI's official link substitute) — no `.vercel` link needed, team projects included. Resolution failures abort the command (never silently falls back to the linked project). Gate's deploy verb keeps forwarding `--project` natively with its create-preflight.

## 0.7.0

### Minor Changes

- db518e4: Universal native passthrough: `gate <provider> <anything>` now runs ANY native CLI command with the selected account's credentials injected per-invocation (`gate vercel env ls --account work`, `gate fly -a work status -a my-app`). Gate's six account verbs move under a uniform `auth` namespace — BREAKING: `gate vercel login` is now the NATIVE vercel login (a stderr tip points at `gate vercel auth login`); top-level `switch`/`list`/etc. reach the native commands. Also breaking: `gate fly deploy -a <app>` now sends `-a` to fly (use `--account`); library API drops `ProviderCommandLayout`, `deployCli`, `DeployCliContext`, and the citty dependency in favor of `nativeCli()`, `routeCommand()`, `runPassthrough()`, and `InteractionMode`. Non-interactive runs never prompt — they fail fast with actionable hints.

## 0.6.1

### Patch Changes

- 93b6d30: Docs: reword the sandbox and Git Guard READMEs around deploy isolation — a clean copy of the repo's tracked files instead of the live working tree. The gate deploy log line now reads "stub .git" to match.
- Updated dependencies [93b6d30]
  - @infracraft/sandbox@0.1.2

## 0.6.0

### Minor Changes

- 2f3678e: Deploy-target preflight: `gate vercel deploy --project <name>` now verifies the project exists before spawning the native CLI. A missing project triggers a create prompt — or is auto-created with the new gate-owned `--create-project` flag — and the deploy continues in the same run; non-interactive misses fail fast with an actionable hint instead of relaying the native error.

## 0.5.1

### Patch Changes

- b2fc0a3: Every published package now ships its own README: sandbox gains one, pulumi's gets its own package identity, and the root README becomes a general overview that points into each package. npm descriptions added/tightened.
- Updated dependencies [b2fc0a3]
  - @infracraft/sandbox@0.1.1

## 0.5.0

### Minor Changes

- 7339f3e: Unique identities: a provider account can no longer appear twice in gate's store. Existing duplicates trigger a mandatory merge prompt (pick the surviving label); `login` and `import` now offer update-or-rename when the identity is already stored.

## 0.4.1

### Patch Changes

- cf0ec60: Active accounts in `list` and the account picker now render as a green line ending with a circle, instead of the appended "active" label.

## 0.4.0

### Minor Changes

- d3c10c3: Self-healing sessions: when the native CLI holds a valid session for an identity gate already stores (a re-login or auto-refreshed token), the stored entries silently adopt the fresh session. The active marker now compares tokens per entry, so duplicate-identity entries all show as active when they hold the live session.

### Patch Changes

- ee1f49f: `gate --version` now reports the package version (it previously printed "No version specified").

## 0.3.0

### Minor Changes

- 74109c4: Refresh-aware discovery: an expired-but-refreshable native session (Vercel) is now silently refreshed during discovery and `import` instead of classifying as invalid, so a stale `auth.json` no longer hides the import offer. The refreshed tokens are written back to the native auth file immediately (OAuth refresh rotates the refresh token), which also revives the native CLI session.

### Patch Changes

- 3db05b3: Reword user-facing CLI messages and README to drop em dashes.

## 0.2.0

### Minor Changes

- d8d8805: Native-session discovery: interactive commands now notice when the native CLI is logged into an account gate doesn't know and offer to import it. Declining is remembered per identity (`gate <provider> import` always works manually and un-declines). The empty-store error now mentions `import` alongside `login`.

## 0.1.0

### Minor Changes

- 00b9131: Initial release: multi-account switcher for Vercel, Railway, and Fly.io with real native-CLI switching (`gate vercel switch`, `gate railway switch`, `gate fly auth switch`) and sandboxed deploys (`gate vercel deploy`, `gate railway up`, `gate fly deploy`). Supersedes vergate.

### Patch Changes

- Updated dependencies [00b9131]
  - @infracraft/sandbox@0.1.0
