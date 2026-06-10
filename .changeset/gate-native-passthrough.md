---
"@infracraft/gate": minor
---

Universal native passthrough: `gate <provider> <anything>` now runs ANY native CLI command with the selected account's credentials injected per-invocation (`gate vercel env ls --account work`, `gate fly -a work status -a my-app`). Gate's six account verbs move under a uniform `auth` namespace — BREAKING: `gate vercel login` is now the NATIVE vercel login (a stderr tip points at `gate vercel auth login`); top-level `switch`/`list`/etc. reach the native commands. Also breaking: `gate fly deploy -a <app>` now sends `-a` to fly (use `--account`); library API drops `ProviderCommandLayout`, `deployCli`, `DeployCliContext`, and the citty dependency in favor of `nativeCli()`, `routeCommand()`, `runPassthrough()`, and `InteractionMode`. Non-interactive runs never prompt — they fail fast with actionable hints.
