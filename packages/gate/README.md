<p align="center">
  <b>@infracraft/gate</b>
  <br />
  <i>Run any Vercel, Railway, or Fly.io CLI command as any account. Per-invocation credential injection, real native-session switching, and sandboxed deploys.</i>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@infracraft/gate"><img src="https://img.shields.io/npm/v/@infracraft/gate?style=flat&colorA=18181b&colorB=18181b" alt="npm" /></a>
  <a href="https://www.npmjs.com/package/@infracraft/gate"><img src="https://img.shields.io/npm/dm/@infracraft/gate?style=flat&colorA=18181b&colorB=18181b" alt="downloads" /></a>
  <a href="https://github.com/andredezzy/infracraft/blob/main/LICENSE"><img src="https://img.shields.io/github/license/andredezzy/infracraft?style=flat&colorA=18181b&colorB=18181b" alt="license" /></a>
</p>

---

Native CLIs (`vercel`, `railway`, `fly`) hold one account at a time. gate stores as many accounts as you need per provider and lets every native command run as any of them: `gate <provider> <anything>` passes through to the native CLI with that account's credentials injected per-invocation. `gate … auth switch` really switches the native CLI session, and deploys run from an isolated sandbox copy of the repo's tracked files by default.

## Install

```bash
bun add -g @infracraft/gate
```

Requires [Bun](https://bun.sh). Also install whichever native CLIs you intend to use:

```bash
bun add -g vercel          # Vercel
bun add -g @railway/cli    # Railway
brew install flyctl         # Fly.io
```

## Commands

One uniform tree for every provider (`vercel`, `railway`, `fly`):

```
gate <provider> auth <verb>        # gate account management (table below)
gate <provider> deploy [...]       # sandboxed deploy (railway: `gate railway up`)
gate <provider> <anything else>    # passthrough: the native CLI runs with the
                                   # selected account's credentials injected
gate <provider> -- <args...>       # escape hatch: verbatim native args
```

### Account management (`auth`)

| Verb | Description |
|---|---|
| `auth login` | Add an account by opening the provider's own browser login flow |
| `auth logout [label]` | Remove a stored account; prompts for selection if no label given |
| `auth switch [label]` | Write that account's session into the native CLI auth file. THE real switch |
| `auth whoami [label]` | Show and validate the account; defaults to the currently active account |
| `auth list` | List all stored accounts with an active marker |
| `auth import` | Adopt the current native CLI session as a named account |

### Passthrough

Anything that isn't `auth` or the deploy verb runs natively, with credentials injected per-invocation (Vercel: the global `--token` flag; Railway/Fly: env vars). The native session is never touched — only `auth switch` rewrites it.

```bash
gate vercel env ls                    # native `vercel env ls` as the active account
gate vercel env ls --project hat-rec  # any project, no .vercel link needed
gate vercel switch my-team            # vercel's own team switch (native)
gate railway logs --account work      # one-shot account selection
gate fly -a work status -a my-app     # gate account "work"; fly app "my-app"
gate vercel env ls --json | jq        # stdout is byte-for-byte native
```

Interactive runs print one dim account badge to stderr (`● work (worker@email)`), so you always see who ran the command — pipes and `--json` output stay clean. If you pass your own `--token` (Vercel), gate steps aside and says so. The command exits with the native CLI's exit code.

### Gate flags

| Flag | Where it's recognized |
|---|---|
| `--account <label>`, `--account=<label>` | Anywhere in the command |
| `-a <label>` | Anywhere — except on Fly, where `-a` natively means the app name: there it's only read between the provider name and the first native token (`gate fly -a work status -a my-app`), and never inside deploy args |
| `--project <name>`, `--project=<name>` | Vercel passthrough only — gate resolves the project via the API and injects `VERCEL_PROJECT_ID`/`VERCEL_ORG_ID`, so it works on every command (`env`, `logs`, …). A missing project aborts the command — it never silently falls back to the linked project. Deploy is unaffected (`--project` stays native there). Native flag reachable via `--` |
| `--` (first token) | Escape hatch — everything after is verbatim native; gate flags must come before it |

Anything after any `--` is never interpreted by gate.

## Deploys

Sandbox is on by default. Every `gate … deploy` / `gate railway up` runs from an isolated `/tmp` copy of the repo's tracked files (`git ls-files`) with a stub `.git` (a fresh `git init` + `git add -A` with an unborn HEAD), so the deploy sees a clean copy of exactly what git tracks — never untracked local files.

### Deploy flags

| Flag | Description |
|---|---|
| `--account <label>`, `-a <label>`, `--account=<label>` | Use a specific stored account for this deploy (on Fly, use the long form — `-a` belongs to fly) |
| `--no-sandbox` | Deploy from the live working tree (native CLI behavior, no isolation) |
| `--git-metadata` | Isolated `/tmp` copy but with the real `.git`. The platform sees actual commit data |
| `--create-project` | Create the project when it does not exist, without prompting (the interactive default asks first; this is the CI-friendly opt-in) |

Everything else passes through verbatim to the native CLI. For example:

```bash
gate railway up --detach --service api
gate vercel deploy --prod --scope my-team
gate fly deploy --remote-only --strategy rolling
```

The command exits with the native CLI's exit code. Outside a git repo the sandbox is skipped automatically (there are no tracked files to copy) and the deploy runs natively.

## How switching works

`gate … switch` merges the stored session into the native CLI's auth file and writes it atomically with `0600` permissions. The native CLI then runs as that account with no further gate involvement. The active account is always read directly from the native file; gate never stores which account is "active" separately.

**Switching vs passthrough:** `auth switch` persistently rewrites the native auth file — the native CLI then runs as that account even without gate. Passthrough injects credentials per-invocation and leaves the native session untouched. Both coexist; the stderr badge always shows which account ran the command.

| Provider | Native auth file |
|---|---|
| Vercel | `~/Library/Application Support/com.vercel.cli/auth.json` (macOS) · `~/.local/share/com.vercel.cli/auth.json` (Linux) |
| Railway | `~/.railway/config.json` |
| Fly.io | `~/.fly/config.yml` |

Writes are merge-not-clobber: other keys in the native file are preserved. Vercel tokens are OAuth-based and auto-refresh; the refreshed token writes through to the native file whenever the active account is used.

## Non-interactive use (CI)

Off-TTY, gate never prompts. An unresolvable account fails fast with `No active <provider> account. Pass --account <label> or run "gate <provider> auth switch".`, and an expired session fails with a hint instead of opening a browser. `--create-project` remains the promptless opt-in for deploy target creation.

## Migrating to 0.7

| Before (0.6.x) | After (0.7.0) |
|---|---|
| `gate vercel login` (and the other 5 verbs; railway too) | `gate <provider> auth <verb>` — the old spelling now runs the NATIVE command, with a stderr tip |
| `gate vercel switch` | `gate vercel auth switch` (top-level `switch` is vercel's native team switch) |
| `gate fly auth token` (errored) | passes through to the native `fly auth token` |
| `gate fly deploy -a my-app` (gate ate `-a`) | `-a my-app` goes to fly; use `--account` for the gate account |
| Library: `ProviderCommandLayout`, `deployCli`, `DeployCliContext` | removed — `deployVerb` is a direct provider field; injection lives in `nativeCli()` |

Running native `login`/`logout` through the passthrough modifies the native session outside gate; gate's discovery offers to import the new session on the next run.

## Migrating from vergate

The first interactive Vercel command (switch, list, whoami, or deploy without an explicit account) checks whether you have vergate accounts stored. If gate has no Vercel accounts yet and vergate does, gate offers to migrate them automatically. vergate is deprecated in favor of gate.

## Library

```typescript
import {
  AccountStore,
  vercelProvider,
  ensureValidSession,
  runDeploy,
  runPassthrough,
  SandboxMode,
} from "@infracraft/gate"

const store = new AccountStore()
const accounts = store.list(vercelProvider.id)

// Validate + optionally refresh the stored session
const valid = await ensureValidSession(vercelProvider, store, accounts[0])

// Run any native command with injected credentials
await runPassthrough({
  provider: vercelProvider,
  token: valid.session.token,
  nativeArgs: ["env", "ls"],
})

// Run a sandboxed deploy (compose the argv through the provider)
const command = vercelProvider.nativeCli({
  token: valid.session.token,
  args: [vercelProvider.deployVerb, ...vercelProvider.deployDefaultFlags, "--prod"],
})

const result = await runDeploy({
  command,
  urlPattern: vercelProvider.deployUrlPattern,
  mode: SandboxMode.STUB,   // STUB = fresh stub .git, ORIGINAL = real .git, NONE = no sandbox
})

console.log(result.url, result.exitCode)
```

Key exports: `AccountStore`, `PROVIDERS`, `Provider`, `vercelProvider`, `railwayProvider`, `flyProvider`, `ensureValidSession`, `EnsureValidSessionOptions`, `detectActiveAccount`, `runDeploy`, `runPassthrough`, `routeCommand`, `splitGateFlags`, `SplitGateFlags`, `SandboxMode`, `InteractionMode`, `CommandRoute`, `GateAuthVerb`, `GateFlagRegion`, `CommandContext`, `RoutedCommand`, `GateTreeRoute`, `PassthroughRoute`, `InvalidRoute`, `GateProvider`, `GateAccount`, `ProviderSession`, `NativeCliContext`, `NativeCliCommand`, `PassthroughTargetCapability`, `DeployRunOptions`, `DeployRunResult`, `DeploySpawner`, `SpawnedDeploy`, `PassthroughRunOptions`, `PassthroughRunResult`, `PassthroughSpawner`, `SpawnedPassthrough`.

## License

MIT
