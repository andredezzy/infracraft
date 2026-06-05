import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as command from "@pulumi/command";
import { runtime } from "@pulumi/pulumi";

/**
 * Name of the directory the real `.git` is moved to while deploys run.
 *
 * This value changed from `.git-infrakit-pulumi-guard` to
 * `.git-infracraft-pulumi-guard`. A guard dir left under the old name by a crash
 * under a previous release is still recovered automatically (see
 * {@link LEGACY_GUARD_DIRS} and {@link recoverStaleGuard}), so the rename needs no
 * manual migration. Consumers that imported this constant to locate the guard dir
 * themselves should also account for {@link LEGACY_GUARD_DIRS}.
 */
export const GUARD_DIR = ".git-infracraft-pulumi-guard";

/**
 * Guard-dir names written by older releases. They are recovered on startup so a
 * repository left in a hidden state by a crash under a previous version of this
 * package self-heals on the next run.
 */
export const LEGACY_GUARD_DIRS = [".git-infrakit-pulumi-guard"];

interface GitGuardResult {
	hide: command.local.Command;
}

/** Absolute monorepo roots already hidden in this process — keeps `gitGuard` idempotent. */
const guardedRoots = new Set<string>();

/**
 * Hides the real `.git` so deploy tools (e.g. `vercel deploy`) do not ingest the
 * full git history during a `pulumi up`, then restores it once every dependent
 * deploy has finished.
 *
 * Hiding is performed **synchronously, in-process, on every invocation** — not
 * through a state-tracked `command.local.Command`. A command's `create` only
 * runs on first creation or when its `triggers` change, so a stack that had
 * already recorded the hide command would skip it on every subsequent `up`,
 * leaving the real `.git` exposed during deploys. Hiding is a host-side,
 * run-scoped side effect, not desired-state infrastructure, so it belongs in the
 * program lifecycle rather than the resource graph.
 *
 * Guarantees:
 * - `.git` is hidden before any resource is registered (and therefore before any
 *   dependent deploy command runs), on every `up`.
 * - `.git` is restored on success and on failure. On success the language host
 *   stays alive until every resource operation completes, so the `exit` handler
 *   fires after the deploys; on failure it may fire as soon as the event loop
 *   drains, but a failed deploy has already invalidated the update and restore
 *   only renames a local directory, so restoring early is harmless.
 * - A guard dir left behind by a hard-killed run (`kill -9`, OOM) is recovered on
 *   the next invocation, with no loss of real history.
 * - `pulumi preview` (dry run) moves nothing: it executes no deploy commands.
 *
 * @param monorepoRoot - Absolute path to the repository root containing `.git`
 * @returns `{ hide }` — a backward-compatible dependency anchor for `dependsOn`
 */
export function gitGuard(monorepoRoot: string): GitGuardResult {
	ensureGitignore(path.join(monorepoRoot, ".gitignore"));

	const root = path.resolve(monorepoRoot);

	// Guard each root at most once per process. `pulumi preview` (dry run) runs the
	// program but executes no deploy commands, so it skips the move entirely —
	// preview never touches `.git`.
	if (!guardedRoots.has(root) && !runtime.isDryRun()) {
		// Self-heal first: a guard dir present at startup is the fingerprint of a
		// previous run that was killed before it could restore. Doing this only on
		// `up` (not preview) keeps preview side-effect free; skipping it on a repeat
		// call avoids treating the guard this process just created as a stale one.
		recoverStaleGuard(monorepoRoot);

		hideGit(monorepoRoot);
		guardedRoots.add(root);

		const restore = (): void => restoreGit(monorepoRoot);

		process.on("exit", restore);

		process.on("SIGINT", () => {
			restore();
			process.exit(0);
		});

		process.on("SIGTERM", () => {
			restore();
			process.exit(0);
		});
	}

	// Backward-compatible dependency anchor. The real hide already ran
	// synchronously above — before any resource was registered — so consumers'
	// existing `dependsOn: [hide]` keeps compiling and still orders deploys after
	// the guard, without depending on a command whose static trigger skipped
	// re-runs.
	//
	// Upgrade note: the previous release built this resource with
	// `triggers: [stableDir(...)]`. Dropping `triggers` makes the first `pulumi up`
	// after upgrading REPLACE `git-guard-hide` once. The replace is harmless — there
	// is no delete step and the new create is a bare echo.
	const hide = new command.local.Command("git-guard-hide", {
		create: 'echo "[git-guard] .git hidden in-process by @infracraft/pulumi"',
	});

	return { hide };
}

/**
 * Restores a guard dir left behind by a previously killed run.
 *
 * A guard dir only exists if a prior run moved the real `.git` aside and never
 * restored it. The current `.git` — if present — is the throwaway stub that
 * `git init` created and is safe to discard; the real history lives in the guard
 * dir and is moved back into place. Legacy guard names are recovered too, which
 * migrates a crashed older stack onto the current layout.
 *
 * @returns `true` if a stale guard dir was recovered, otherwise `false`
 */
export function recoverStaleGuard(monorepoRoot: string): boolean {
	const gitPath = path.join(monorepoRoot, ".git");

	for (const dirName of [GUARD_DIR, ...LEGACY_GUARD_DIRS]) {
		const guardPath = path.join(monorepoRoot, dirName);

		if (!fs.existsSync(guardPath)) {
			continue;
		}

		// A crashed run may have left the guard dir immutable; lift the lock so the
		// recovery rename can proceed.
		setGuardImmutable(guardPath, false);

		if (fs.existsSync(gitPath)) {
			fs.rmSync(gitPath, { recursive: true, force: true });
		}

		fs.renameSync(guardPath, gitPath);

		return true;
	}

	return false;
}

/**
 * Moves the real `.git` to the guard dir and leaves a lightweight stub in its
 * place. The stub is a fresh `git init` whose index is copied from the real
 * repository, so `git ls-files` still reports the tracked files (deploy tools
 * enumerate them) while none of the history is exposed.
 *
 * On success it also writes an agent-facing `README.md` and an
 * `infracraft.lock` into the stub (so a coding agent that stumbles onto
 * the unusual state leaves it alone instead of "fixing" it), and best-effort
 * marks the moved-aside real history immutable via {@link setGuardImmutable} so
 * it cannot be accidentally restored while the deploy is in progress.
 *
 * Idempotent and safe to call on every `up`: it no-ops when there is no `.git`
 * to hide, and refuses to overwrite an existing guard dir (which would destroy
 * the real history captured by an earlier run).
 */
export function hideGit(monorepoRoot: string): void {
	const gitPath = path.join(monorepoRoot, ".git");
	const guardPath = path.join(monorepoRoot, GUARD_DIR);

	if (!fs.existsSync(gitPath) || fs.existsSync(guardPath)) {
		return;
	}

	fs.renameSync(gitPath, guardPath);

	try {
		execFileSync("git", ["init", "--quiet"], {
			cwd: monorepoRoot,
			stdio: "ignore",
		});

		const realIndex = path.join(guardPath, "index");

		if (fs.existsSync(realIndex)) {
			fs.copyFileSync(realIndex, path.join(gitPath, "index"));
		}
	} catch (error) {
		// Re-expose the real `.git` so a failed stub creation never leaves the
		// repository without git metadata.
		fs.rmSync(gitPath, { recursive: true, force: true });
		fs.renameSync(guardPath, gitPath);

		throw new Error(
			`[git-guard] Failed to create stub .git in ${monorepoRoot}: ${String(error)}`,
		);
	}

	writeStubMetadata(gitPath, GUARD_DIR);

	setGuardImmutable(guardPath, true);
}

/**
 * Moves the real `.git` back from the guard dir, discarding the stub. No-ops when
 * there is nothing hidden. Failures are reported, not thrown, so a restore on
 * process exit can never crash the host — the manual recovery command is logged.
 */
export function restoreGit(monorepoRoot: string): void {
	const guardPath = path.join(monorepoRoot, GUARD_DIR);

	if (!fs.existsSync(guardPath)) {
		return;
	}

	const gitPath = path.join(monorepoRoot, ".git");

	try {
		// Lift the immutability lock before moving the real history back, otherwise
		// the rename fails on a guard dir that hideGit marked immutable.
		setGuardImmutable(guardPath, false);

		if (fs.existsSync(gitPath)) {
			fs.rmSync(gitPath, { recursive: true, force: true });
		}

		fs.renameSync(guardPath, gitPath);
	} catch {
		console.error(
			`[git-guard] Failed to restore .git. Run manually: rm -rf ${gitPath} && mv ${guardPath} ${gitPath}`,
		);
	}
}

export function ensureGitignore(gitignorePath: string): void {
	const content = fs.existsSync(gitignorePath)
		? fs.readFileSync(gitignorePath, "utf-8")
		: "";

	if (content.includes(GUARD_DIR)) {
		return;
	}

	const newline = content.length > 0 && !content.endsWith("\n") ? "\n" : "";

	fs.appendFileSync(gitignorePath, `${newline}${GUARD_DIR}\n`);
}

/**
 * Basename of the human/agent-facing explainer written into the stub `.git`.
 */
export const STUB_README_NAME = "README.md";

/**
 * Basename of the lock file written into the stub `.git`. Its presence — with a
 * live `pid` — marks an in-progress deploy that owns the guard.
 */
export const LOCK_FILE_NAME = "infracraft.lock";

/**
 * Builds the agent-facing explainer placed at `.git/README.md` inside the stub.
 *
 * An automated coding agent that trips over the unusual git state (an unborn
 * `main`; `git ls-files` works but `git log` fails with `unable to read <sha>`)
 * should read this and leave the repository alone instead of "fixing" it
 * mid-deploy.
 *
 * @param guardDir - Basename of the sibling dir holding the real, locked history
 */
export function buildStubReadme(guardDir: string): string {
	return `# Managed STUB \`.git\` — do not modify or restore it

This is **not** the real repository. It is a lightweight stub created
automatically by [\`@infracraft/pulumi\`](https://github.com/andredezzy/infracraft)
(the \`git-guard\`) while a deploy (\`pulumi up\` / \`vercel deploy\`) is in progress.

## Why it exists
Deploy tools would otherwise ingest the full git history. The guard moves the real
\`.git\` aside to \`../${guardDir}\` and leaves this stub, copying only the index so
\`git ls-files\` still lists tracked files for the deploy tool.

## It restores itself — automatically
When the deploy finishes (success or failure) the guard discards this stub and
moves the real \`.git\` back. **You do not need to do anything.**

## DO NOT try to "fix" this
While the deploy runs, the real history in \`../${guardDir}\` is **locked**
(filesystem-immutable, best-effort). Do not run \`git init\` / \`reset\` / \`checkout\`
here, do not \`rm -rf .git\`, and do not \`mv ../${guardDir} .git\` — the move is
intentionally blocked and will fail.

Symptoms you can safely ignore: an unborn \`main\` branch; \`git ls-files\` works but
\`git log\` / \`git diff\` fail with \`unable to read <sha>\` (the objects live in the
locked guard dir).

## If a deploy crashed and this looks stuck
The guard self-heals on the next deploy. Only if you are certain no deploy is
running, recover manually from the repo root:

\`\`\`sh
chflags -R nouchg "../${guardDir}" 2>/dev/null || chattr -R -i "../${guardDir}" 2>/dev/null || true
rm -rf .git && mv "../${guardDir}" .git
\`\`\`

See \`./${LOCK_FILE_NAME}\` for the owning process id and start time.
`;
}

/**
 * Writes the stub explainer and the deploy lock into the freshly created stub
 * `.git`. Best-effort: the stub already satisfies deploy tools without these
 * files, so a write failure here must never abort an otherwise-successful hide.
 */
function writeStubMetadata(gitPath: string, guardDir: string): void {
	try {
		fs.writeFileSync(
			path.join(gitPath, STUB_README_NAME),
			buildStubReadme(guardDir),
		);

		const lock = {
			tool: "@infracraft/pulumi git-guard",
			pid: process.pid,
			startedAt: new Date().toISOString(),
			host: os.hostname(),
			guardDir,
			note: "Deploy in progress. The real .git is moved aside and locked. Do not restore it manually; it restores automatically when the deploy finishes.",
		};

		fs.writeFileSync(
			path.join(gitPath, LOCK_FILE_NAME),
			`${JSON.stringify(lock, null, 2)}\n`,
		);
	} catch (error) {
		console.error(
			`[git-guard] Failed to write stub metadata: ${String(error)}`,
		);
	}
}

/**
 * Best-effort filesystem lock on the moved-aside real history so it cannot be
 * accidentally restored mid-deploy (e.g. a manual `mv` fails on an immutable
 * dir). Uses `chflags uchg` on macOS and `chattr +i` on Linux, and silently
 * no-ops where the flag is unsupported or not permitted (e.g. unprivileged CI) —
 * the lock is a guard rail, never a deploy blocker. The legitimate restore and
 * recover paths call this with `immutable = false` before moving the dir back.
 *
 * @param guardPath - Absolute path to the guard dir holding the real history
 * @param immutable - `true` to lock, `false` to unlock
 */
export function setGuardImmutable(guardPath: string, immutable: boolean): void {
	if (!fs.existsSync(guardPath)) {
		return;
	}

	try {
		if (process.platform === "darwin") {
			execFileSync(
				"chflags",
				["-R", immutable ? "uchg" : "nouchg", guardPath],
				{ stdio: "ignore" },
			);
		} else if (process.platform === "linux") {
			execFileSync("chattr", ["-R", immutable ? "+i" : "-i", guardPath], {
				stdio: "ignore",
			});
		}
	} catch {
		// Lacking the privilege to set the flag (common in CI) must never break the
		// guard — the lock is best-effort hardening, not a hard dependency.
	}
}
