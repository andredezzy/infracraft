<p align="center">
  <b>gate</b>
  <br />
  <i>Switch Vercel, Railway, and Fly.io accounts. Deploy without leaking git metadata.</i>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@infracraft/gate"><img src="https://img.shields.io/npm/v/@infracraft/gate?style=flat&colorA=18181b&colorB=18181b" alt="npm" /></a>
  <a href="https://www.npmjs.com/package/@infracraft/gate"><img src="https://img.shields.io/npm/dm/@infracraft/gate?style=flat&colorA=18181b&colorB=18181b" alt="downloads" /></a>
  <a href="https://github.com/andredezzy/infracraft/blob/main/LICENSE"><img src="https://img.shields.io/github/license/andredezzy/infracraft?style=flat&colorA=18181b&colorB=18181b" alt="license" /></a>
</p>

---

Native CLIs (`vercel`, `railway`, `fly`) hold one account at a time. gate stores as many accounts as you need per provider, really switches the native CLI session when you run `gate … switch`, and wraps deploys in an isolated metadata-free sandbox by default — so no commit SHA or author email leaves the machine unless you explicitly opt in.

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

### Vercel

```
gate vercel login            # add account via Vercel's browser login
gate vercel logout [label]   # remove stored account
gate vercel switch [label]   # write account session into the native vercel CLI
gate vercel whoami [label]   # show + validate account (defaults to active)
gate vercel list             # stored accounts with active marker
gate vercel import           # adopt current native vercel session
gate vercel deploy [...]     # sandboxed deploy (passes flags through to vercel deploy)
```

### Railway

```
gate railway login           # add account via Railway's browser login
gate railway logout [label]  # remove stored account
gate railway switch [label]  # write account session into the native railway CLI
gate railway whoami [label]  # show + validate account (defaults to active)
gate railway list            # stored accounts with active marker
gate railway import          # adopt current native railway session
gate railway up [...]        # sandboxed deploy (passes flags through to railway up)
```

### Fly.io

```
gate fly auth login          # add account via flyctl's browser login
gate fly auth logout [label] # remove stored account
gate fly auth switch [label] # write account session into the native fly CLI
gate fly auth whoami [label] # show + validate account (defaults to active)
gate fly auth list           # stored accounts with active marker
gate fly auth import         # adopt current native fly session
gate fly deploy [...]        # sandboxed deploy (passes flags through to fly deploy)
```

### Auth verb reference

| Verb | Description |
|---|---|
| `login` | Add an account by opening the provider's own browser login flow |
| `logout [label]` | Remove a stored account; prompts for selection if no label given |
| `switch [label]` | Write that account's session into the native CLI auth file — THE real switch |
| `whoami [label]` | Show and validate the account; defaults to the currently active account |
| `list` | List all stored accounts with an active marker |
| `import` | Adopt the current native CLI session as a named account |

## Deploys

Sandbox is on by default. Every `gate … deploy` / `gate railway up` runs from an isolated `/tmp` copy of the repo's tracked files (`git ls-files`) with a stub `.git` (a fresh `git init` + `git add -A` with an unborn HEAD). No commit SHA, author email, or branch name reaches the platform.

### Deploy flags

| Flag | Description |
|---|---|
| `--account <label>`, `-a <label>`, `--account=<label>` | Use a specific stored account for this deploy |
| `--no-sandbox` | Deploy from the live working tree — native CLI behavior, no isolation |
| `--git-metadata` | Isolated `/tmp` copy but with the real `.git` — platform sees actual commit data |

Everything else passes through verbatim to the native CLI. For example:

```bash
gate railway up --detach --service api
gate vercel deploy --prod --scope my-team
gate fly deploy --remote-only --strategy rolling
```

The command exits with the native CLI's exit code. Outside a git repo the sandbox is skipped automatically (there are no tracked files to copy) and the deploy runs natively.

## How switching works

`gate … switch` merges the stored session into the native CLI's auth file and writes it atomically with `0600` permissions. The native CLI then runs as that account with no further gate involvement. The active account is always read directly from the native file — gate never stores which account is "active" separately.

| Provider | Native auth file |
|---|---|
| Vercel | `~/Library/Application Support/com.vercel.cli/auth.json` (macOS) · `~/.local/share/com.vercel.cli/auth.json` (Linux) |
| Railway | `~/.railway/config.json` |
| Fly.io | `~/.fly/config.yml` |

Writes are merge-not-clobber: other keys in the native file are preserved. Vercel tokens are OAuth-based and auto-refresh; the refreshed token writes through to the native file whenever the active account is used.

## Migrating from vergate

The first interactive Vercel command (login, switch, deploy without an explicit account) checks whether you have vergate accounts stored. If gate has no Vercel accounts yet and vergate does, gate offers to migrate them automatically. vergate is deprecated in favor of gate.

## Library

```typescript
import {
  AccountStore,
  PROVIDERS,
  vercelProvider,
  railwayProvider,
  flyProvider,
  ensureValidSession,
  runDeploy,
  SandboxMode,
} from "@infracraft/gate"

const store = new AccountStore()
const accounts = store.list(vercelProvider.id)

// Validate + optionally refresh the stored session
const valid = await ensureValidSession(vercelProvider, store, accounts[0])

// Run a sandboxed deploy
const result = await runDeploy({
  provider: vercelProvider,
  token: valid.session.token,
  passthroughArgs: ["--prod"],
  mode: SandboxMode.STUB,   // STUB = metadata-free, ORIGINAL = real .git, NONE = no sandbox
})

console.log(result.url, result.exitCode)
```

Key exports: `AccountStore`, `PROVIDERS`, `vercelProvider`, `railwayProvider`, `flyProvider`, `ensureValidSession`, `detectActiveAccount`, `runDeploy`, `SandboxMode`, `GateProvider`, `GateAccount`, `DeployRunOptions`, `DeployRunResult`, `DeploySpawner`, `SpawnedDeploy`.

## License

MIT
