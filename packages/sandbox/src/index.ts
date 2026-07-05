import * as fs from "node:fs";
import * as path from "node:path";

/** Escapes a path literal for embedding inside an awk ERE. */
function escapeAwkRegex(path: string): string {
	return path.replace(/[.[\]{}()*+?^$|\\/]/g, "\\$&");
}

/**
 * Builds the shell filter applied to the `git ls-files` list before
 * `rsync --files-from`. Every excluded entry drops the path and its subtree
 * but keeps the entry's own `package.json`: an excluded directory may be a
 * workspace member, and the package manager fails the whole install when the
 * root manifest names a workspace whose manifest is missing from the copy
 * (a kept manifest for a non-member is inert). Returns `cat` (passthrough)
 * when nothing is excluded. Uses awk so it is portable across macOS and Linux.
 */
export function buildSandboxFileFilter(excludePaths: string[] = []): string {
	if (excludePaths.length === 0) {
		return "cat";
	}

	const clauses = excludePaths.map((entry) => {
		const escaped = escapeAwkRegex(entry);

		return `!(/^${escaped}(\\/|$)/ && !/^${escaped}\\/package\\.json$/)`;
	});

	return `awk '${clauses.join(" && ")}'`;
}

/** Root of the per-deploy sandbox tree. The DeploySandbox resource GCs this. */
const SANDBOX_ROOT = "/tmp/infracraft";

/**
 * How a deploy's working copy is isolated. A closed set, so it is an enum rather
 * than a pair of booleans: the seam derives it from `dependsOn` presence
 * (DeploySandbox / GitGuard), which makes the impossible "git-guard without a
 * sandbox" state unrepresentable here.
 */
export enum SandboxMode {
	/** No isolation — run the CLI in the live working tree. */
	NONE = "NONE",
	/** Isolated copy carrying the repo's REAL `.git` (real commit/author exposed). */
	ORIGINAL = "ORIGINAL",
	/** Isolated copy with a metadata-free stub `.git` (no commit SHA / author). */
	STUB = "STUB",
}

export interface SandboxScriptOptions {
	/** How to isolate the working copy (see {@link SandboxMode}). */
	mode: SandboxMode;
	/** Resource-derived name, used in the sandbox dir prefix. */
	appName: string;
	/** Stack/environment name, prefixed to the sandbox dir so leftovers and
	 * concurrent deploys are identifiable (e.g. `acme-staging-worker.XXXX`). */
	env?: string;
	/** Upload-scoping excludes; applied only in STUB mode (see design spec). */
	excludePaths?: string[];
	/** Shell run in the working dir before `cli` (e.g. write railpack.json). */
	setup?: string;
	/** Fully-formed platform deploy command (its exit code becomes the script's). */
	cli: string;
}

/**
 * Builds the shell for a deploy's `command.local.Command.create`. See
 * docs/superpowers/specs/2026-06-05-deploy-sandbox-design.md for the modes.
 *
 * Hardening: every script runs under POSIX `set -e` so any failed step aborts
 * instead of silently letting the platform CLI run against partial state.
 * `pipefail` is intentionally NOT used — the command runs under `/bin/sh`, which
 * may be `dash` (pipefail is a bash/ksh/zsh extension). To still catch a failing
 * `git ls-files` (a pipe would mask it, since an `rsync` of an empty list exits
 * 0), the copy is staged through intermediate list files rather than a pipe. The
 * `REPO` and `SANDBOX` command substitutions are explicitly guarded with clear
 * error messages.
 */
export function buildSandboxScript(options: SandboxScriptOptions): string {
	const { mode, appName, env, excludePaths, setup, cli } = options;

	const head = `set -e; REPO=$(git rev-parse --show-toplevel) || { echo "[infracraft] not inside a git repository" >&2; exit 1; }`;
	const runSetupAndCli = [setup, cli].filter(Boolean).join("; ");

	if (mode === SandboxMode.NONE) {
		return `${head}; cd "$REPO"; ${runSetupAndCli}`;
	}

	// Prefix the dir with the project (repo folder name) and env so leftovers and
	// concurrent deploys — even across repos and stacks — are identifiable at a
	// glance (e.g. `acme-production-railway-deploy-api.XXXX`).
	const dirPrefix = env ? `${env}-${appName}` : appName;

	const makeSandbox = [
		`PROJECT=$(basename "$REPO")`,
		`SANDBOX=$(mktemp -d "${SANDBOX_ROOT}/$PROJECT-${dirPrefix}.XXXXXX") || { echo "[infracraft] mktemp failed" >&2; exit 1; }`,
		`trap 'rm -rf "$SANDBOX"' EXIT`,
	].join("; ");

	// Copy tracked files via intermediate list files (no pipe — see hardening note).
	// STUB filters by excludePaths; ORIGINAL copies the full tracked tree (`cat`).
	const filter =
		mode === SandboxMode.STUB ? buildSandboxFileFilter(excludePaths) : "cat";

	const copy = [
		`git -C "$REPO" ls-files > "$SANDBOX/.ic-ls"`,
		`${filter} "$SANDBOX/.ic-ls" > "$SANDBOX/.ic-lsf"`,
		`rsync -a --files-from="$SANDBOX/.ic-lsf" "$REPO"/ "$SANDBOX"/`,
		`rm -f "$SANDBOX/.ic-ls" "$SANDBOX/.ic-lsf"`,
	].join("; ");

	if (mode === SandboxMode.STUB) {
		// Metadata-free stub: unborn HEAD, no commit SHA / author reaches the platform.
		const stubGit = `cd "$SANDBOX"; git init -q && git add -A`;

		return `${head}; ${makeSandbox}; ${copy}; ${stubGit}; ${runSetupAndCli}`;
	}

	// ORIGINAL: real `.git`, CoW-copied (plain-copy fallback on non-CoW filesystems).
	const copyGit =
		`cp -c -R "$REPO/.git" "$SANDBOX/.git" 2>/dev/null || ` +
		`cp -R "$REPO/.git" "$SANDBOX/.git"`;

	return `${head}; ${makeSandbox}; ${copy}; ${copyGit}; cd "$SANDBOX"; ${runSetupAndCli}`;
}

/** Sweep sandboxes orphaned by a hard-killed run (older than this). Kept well
 * above the worst-case deploy time (~30 min) but low enough that a SIGKILL
 * orphan does not linger for a day accumulating in /tmp. */
const STALE_SANDBOX_MS = 3 * 60 * 60 * 1000;

/** mkdir the workspace root and GC stale sandboxes (best-effort). Sandboxes are
 * flat under the root (`/tmp/infracraft/<project>-<env>-<app>.XXXX`), so this
 * sweeps any entry older than the stale threshold. */
export function prepareSandboxWorkspace(): void {
	fs.mkdirSync(SANDBOX_ROOT, { recursive: true });

	let entries: string[] = [];

	try {
		entries = fs.readdirSync(SANDBOX_ROOT) as string[];
	} catch {
		return;
	}

	const now = Date.now();

	for (const entry of entries) {
		const full = path.join(SANDBOX_ROOT, entry);

		try {
			if (now - fs.statSync(full).mtimeMs > STALE_SANDBOX_MS) {
				fs.rmSync(full, { recursive: true, force: true });
			}
		} catch {
			// Racing with an in-flight deploy's cleanup — ignore.
		}
	}
}
