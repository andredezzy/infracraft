/** Escapes a path literal for embedding inside an awk ERE. */
function escapeAwkRegex(path: string): string {
	return path.replace(/[.[\]{}()*+?^$|\\/]/g, "\\$&");
}

/**
 * Builds the shell filter applied to newline-delimited `git ls-files` output
 * before `rsync --files-from`. For `apps/<x>` it drops the app's files but keeps
 * `apps/<x>/package.json` (the monorepo workspace graph needs it during build);
 * any other entry drops the path and its subtree. Returns `cat` (passthrough)
 * when nothing is excluded. Uses awk so it is portable across macOS and Linux.
 */
export function buildSandboxFileFilter(excludePaths: string[] = []): string {
	if (excludePaths.length === 0) {
		return "cat";
	}

	const clauses = excludePaths.map((entry) => {
		const escaped = escapeAwkRegex(entry);

		if (entry.startsWith("apps/")) {
			return `!(/^${escaped}\\// && !/^${escaped}\\/package\\.json$/)`;
		}

		return `!/^${escaped}(\\/|$)/`;
	});

	return `awk '${clauses.join(" && ")}'`;
}

/** Root of the per-deploy sandbox tree. The DeploySandbox resource GCs this. */
const SANDBOX_ROOT = "/tmp/infracraft";

interface SandboxScriptOptions {
	/** Whether to isolate into a /tmp copy (false → run in the live tree). */
	sandbox: boolean;
	/** Whether the sandbox `.git` is a metadata-free stub (true) or the real one. */
	gitGuard: boolean;
	/** Resource-derived name, used only for the sandbox dir prefix. */
	appName: string;
	/** Upload-scoping excludes; applied only in stub mode (see design spec). */
	excludePaths?: string[];
	/** Shell run in the working dir before `cli` (e.g. write railpack.json). */
	setup?: string;
	/** Fully-formed platform deploy command (its exit code becomes the script's). */
	cli: string;
}

/**
 * Builds the shell for a deploy's `command.local.Command.create`. See
 * docs/superpowers/specs/2026-06-05-deploy-sandbox-design.md for the modes.
 */
export function buildSandboxScript(options: SandboxScriptOptions): string {
	const { sandbox, gitGuard, appName, excludePaths, setup, cli } = options;

	const head = `REPO=$(git rev-parse --show-toplevel)`;
	const runSetupAndCli = [setup, cli].filter(Boolean).join("; ");

	if (!sandbox) {
		return `${head}; cd "$REPO"; ${runSetupAndCli}`;
	}

	const makeSandbox = [
		`SANDBOX=$(mktemp -d ${SANDBOX_ROOT}/${appName}.XXXXXX)`,
		`trap 'rm -rf "$SANDBOX"' EXIT`,
	].join("; ");

	if (gitGuard) {
		const filter = buildSandboxFileFilter(excludePaths);

		const copy =
			`git -C "$REPO" ls-files | ${filter} | ` +
			`rsync -a --files-from=- "$REPO"/ "$SANDBOX"/`;

		const stubGit = `cd "$SANDBOX" && git init -q && git add -A`;

		return `${head}; ${makeSandbox}; ${copy}; ${stubGit}; ${runSetupAndCli}`;
	}

	// Original `.git`, full clean tree (no filter, no reconciliation needed).
	const copy = `git -C "$REPO" ls-files | rsync -a --files-from=- "$REPO"/ "$SANDBOX"/`;

	const copyGit =
		`cp -c -R "$REPO/.git" "$SANDBOX/.git" 2>/dev/null || ` +
		`cp -R "$REPO/.git" "$SANDBOX/.git"`;

	return `${head}; ${makeSandbox}; ${copy}; ${copyGit}; cd "$SANDBOX"; ${runSetupAndCli}`;
}
