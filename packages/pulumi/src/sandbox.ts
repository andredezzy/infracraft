import * as fs from "node:fs";
import * as path from "node:path";
import * as pulumi from "@pulumi/pulumi";

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
	/** Resource-derived name, used in the sandbox dir prefix. */
	appName: string;
	/** Stack/environment name, prefixed to the sandbox dir so leftovers and
	 * concurrent deploys are identifiable (e.g. `staging-vercel-deploy-nexus.XXXX`). */
	env?: string;
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
	const { sandbox, gitGuard, appName, env, excludePaths, setup, cli } = options;

	const head = `REPO=$(git rev-parse --show-toplevel)`;
	const runSetupAndCli = [setup, cli].filter(Boolean).join("; ");

	if (!sandbox) {
		return `${head}; cd "$REPO"; ${runSetupAndCli}`;
	}

	// Prefix the dir with the env so leftovers/concurrent deploys are identifiable.
	const dirPrefix = env ? `${env}-${appName}` : appName;

	// Group a repo's sandboxes under a per-project dir (named after the repo
	// folder) so concurrent deploys of different repos never mix. The project dir
	// is removed only once empty — `rmdir` fails on a non-empty dir, so it
	// survives until the project's last deploy has cleaned up its own sandbox.
	const makeSandbox = [
		`PROJECT_DIR="${SANDBOX_ROOT}/$(basename "$REPO")"`,
		`mkdir -p "$PROJECT_DIR"`,
		`SANDBOX=$(mktemp -d "$PROJECT_DIR/${dirPrefix}.XXXXXX")`,
		`trap 'rm -rf "$SANDBOX"; rmdir "$PROJECT_DIR" 2>/dev/null || true' EXIT`,
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

/** Cross-bundle brand: `instanceof` is unreliable when the seam and the resource
 * come from different built entries, so the seam detects sandboxes by this. */
const DEPLOY_SANDBOX_BRAND = Symbol.for("@infracraft/pulumi/DeploySandbox");

/** Sweep sandboxes orphaned by a hard-killed run (older than this). */
const STALE_SANDBOX_MS = 24 * 60 * 60 * 1000;

/**
 * Isolation marker + workspace lifecycle. Listing it in a deploy's `dependsOn`
 * makes that deploy run in an isolated `/tmp/infracraft` copy. Carries no config;
 * the repo root is derived at runtime by the deploy command.
 */
export class DeploySandbox extends pulumi.ComponentResource {
	constructor(name: string, opts?: pulumi.ComponentResourceOptions) {
		super("infracraft:sandbox:DeploySandbox", name, {}, opts);

		(this as Record<symbol, unknown>)[DEPLOY_SANDBOX_BRAND] = true;

		if (!pulumi.runtime.isDryRun()) {
			this.prepareWorkspace();
		}

		this.registerOutputs({});
	}

	/**
	 * mkdir the workspace root and GC stale sandboxes (best-effort). Sandboxes are
	 * nested one level under a per-project dir (`/tmp/infracraft/<project>/<sandbox>`),
	 * so this sweeps individual stale sandboxes and then drops any now-empty project
	 * dir (`rmdir` is a no-op on a project dir with live deploys).
	 */
	private prepareWorkspace(): void {
		fs.mkdirSync(SANDBOX_ROOT, { recursive: true });

		const now = Date.now();

		let projects: string[] = [];

		try {
			projects = fs.readdirSync(SANDBOX_ROOT) as string[];
		} catch {
			return;
		}

		for (const project of projects) {
			const projectDir = path.join(SANDBOX_ROOT, project);

			let sandboxes: string[] = [];

			try {
				sandboxes = fs.readdirSync(projectDir) as string[];
			} catch {
				// Not a directory (e.g. a stray file) — skip.
				continue;
			}

			for (const sandbox of sandboxes) {
				const full = path.join(projectDir, sandbox);

				try {
					if (now - fs.statSync(full).mtimeMs > STALE_SANDBOX_MS) {
						fs.rmSync(full, { recursive: true, force: true });
					}
				} catch {
					// Racing with an in-flight deploy's cleanup — ignore.
				}
			}

			// Drop the project dir only if the sweep left it empty (best-effort).
			try {
				fs.rmdirSync(projectDir);
			} catch {
				// Non-empty (live deploys) or already gone — ignore.
			}
		}
	}
}

/** Bundle-safe check for a `DeploySandbox` in a `dependsOn` array. */
export function isDeploySandbox(value: unknown): value is DeploySandbox {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as Record<symbol, unknown>)[DEPLOY_SANDBOX_BRAND] === true
	);
}
