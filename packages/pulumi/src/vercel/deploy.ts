import * as command from "@pulumi/command";
import * as pulumi from "@pulumi/pulumi";
import { GUARD_DIR, LEGACY_GUARD_DIRS } from "../git-guard";
import { stableDir } from "../stable-dir";
import type { VercelProject } from "./project";
import type { VercelProvider } from "./provider";

/** Options type for VercelDeploy — replaces Pulumi's native `provider` field. */
type VercelDeployOptions = Omit<pulumi.ComponentResourceOptions, "provider"> & {
	/** Vercel authentication context. */
	provider: VercelProvider;

	/**
	 * VercelProject resource to source the project ID from.
	 * When provided, `args.projectId` is optional and ignored if both are given.
	 */
	project?: VercelProject;
};

/** Args for VercelDeploy. */
export interface VercelDeployArgs {
	/**
	 * Vercel project ID.
	 * Required when `opts.project` is not provided.
	 */
	projectId?: pulumi.Input<string>;

	/**
	 * Absolute path to the monorepo root (working directory for `vercel deploy`).
	 * Stored relative to the Pulumi program directory so the command stays stable
	 * across machines and CI (see {@link stableDir}).
	 */
	monorepoRoot: string;

	/** Values that trigger a redeploy when changed (e.g. source hashes, env hashes). */
	triggers: pulumi.Input<pulumi.Input<string>[]>;

	/**
	 * Paths to exclude from the upload via a generated `.vercelignore`, mirroring
	 * `RailwayDeployArgs.excludePaths`. An `apps/<name>` entry excludes that app's
	 * code but keeps its `package.json`, so the workspace graph still resolves during
	 * the monorepo build. The gitGuard guard dir is always excluded regardless of this
	 * list — see {@link buildVercelIgnore}.
	 */
	excludePaths?: string[];
}

/** mkdir-based lock serializing the brief window when `.vercelignore` is written. */
const LOCK_DIR = "/tmp/.vercel-upload-lock";

/** Where a committed `.vercelignore` is parked while the engine owns the file. */
const IGNORE_BACKUP = ".vercelignore.infracraft-bak";

/**
 * Patterns the engine ALWAYS writes to `.vercelignore`, independent of `excludePaths`.
 *
 * `gitGuard` hides the real `.git` by renaming it to {@link GUARD_DIR} (or a
 * {@link LEGACY_GUARD_DIRS} name) for the duration of a deploy, leaving a stub `.git`.
 * Vercel default-ignores `.git` but NOT the renamed guard dir, and — unlike the Railway
 * CLI — Vercel never reads `.gitignore` (where gitGuard also records the guard dir).
 * Without this exclusion the renamed real `.git`, with its 100MB+ pack files, is
 * uploaded and trips Vercel's 100MB-per-file limit. The transient `.vercelignore*` (the
 * generated file and its {@link IGNORE_BACKUP}) is excluded too, so the engine's own
 * scratch files never ship.
 */
const ALWAYS_IGNORE: readonly string[] = [
	GUARD_DIR,
	...LEGACY_GUARD_DIRS,
	".vercelignore*",
];

/**
 * Builds the newline-joined `.vercelignore` body for the deploy.
 *
 * Prepends {@link ALWAYS_IGNORE} (the guard dir and scratch files) to the consumer's
 * `excludePaths`, applying the workspace-preserving `apps/<name>` rule so other apps'
 * code is dropped while their `package.json` stays for the build's dependency graph.
 *
 * @param excludePaths Consumer-supplied paths to exclude (optional)
 * @returns The ignore body, one pattern per line
 * @example
 * ```typescript
 * buildVercelIgnore(["apps/mesh", "docs"]);
 * // ".git-infracraft-pulumi-guard\n…\napps/mesh/**\n!apps/mesh/package.json\ndocs"
 * ```
 */
export function buildVercelIgnore(excludePaths?: string[]): string {
	const excludeLines = (excludePaths ?? []).map((entry) =>
		entry.startsWith("apps/") ? `${entry}/**\n!${entry}/package.json` : entry,
	);

	return [...ALWAYS_IGNORE, ...excludeLines].join("\n");
}

/**
 * Builds the `create` shell command that wraps `vercel deploy` in the ignore engine.
 *
 * The engine acquires a mkdir lock, parks any committed `.vercelignore` at
 * {@link IGNORE_BACKUP}, writes the generated body (`printf` expands the encoded `\n`
 * sequences), runs the deploy, and — in a background timer so a slow remote build does
 * not block sibling deploys — restores the parked file and releases the lock. The
 * deploy's exit status is captured into `EXIT` before `wait`, so the Pulumi resource
 * fails when the deploy fails.
 *
 * @param excludePaths Consumer-supplied paths to exclude (optional)
 * @returns A single-line shell command (no raw newlines)
 */
export function buildVercelDeployCommand(excludePaths?: string[]): string {
	const ignoreBody = buildVercelIgnore(excludePaths).replace(/\n/g, "\\n");

	const restore = `rm -f .vercelignore; [ -f ${IGNORE_BACKUP} ] && mv ${IGNORE_BACKUP} .vercelignore`;

	return (
		`while ! mkdir ${LOCK_DIR} 2>/dev/null; do sleep 1; done; ` +
		`if [ -f .vercelignore ]; then mv .vercelignore ${IGNORE_BACKUP}; fi; ` +
		`printf '${ignoreBody}\\n' > .vercelignore; ` +
		`{ sleep 8; ${restore}; rmdir ${LOCK_DIR} 2>/dev/null; } & ` +
		`vercel deploy --prod --yes; EXIT=$?; wait; exit $EXIT`
	);
}

/**
 * Deploys a Vercel project via `vercel deploy --prod --yes`, generating a
 * `.vercelignore` around the upload — the same exclude engine as `RailwayDeploy`.
 *
 * Triggers on source hash (computed from the app directory) and env content hash
 * (from `VercelVariable.contentHash`). When an env value changes — whether from
 * code, a new mesh URL, or a drift fix after `pulumi refresh` — the hash changes
 * and a redeploy is triggered.
 *
 * The upload is wrapped in an ignore engine mirroring Railway's: a mkdir lock
 * serializes the brief window in which `.vercelignore` must be consistent, the file is
 * written (gitGuard guard dir + {@link VercelDeployArgs.excludePaths}), then a
 * background timer restores the repository and releases the lock so concurrent deploys
 * stream. Any committed `.vercelignore` is parked at {@link IGNORE_BACKUP} and restored
 * afterward, so this never destroys a consumer's file — and because a committed
 * `.vercelignore` is git-tracked, a hard-killed run is recoverable with
 * `git checkout .vercelignore`.
 *
 * @example
 * ```typescript
 * new VercelDeploy("nexus-deploy", {
 *   projectId: vercelProject.id,
 *   monorepoRoot,
 *   triggers: [sourceHash, envHash],
 *   excludePaths: ["apps/mesh", "docs"],
 * }, { provider });
 * ```
 */
export class VercelDeploy extends pulumi.ComponentResource {
	/**
	 * The production deployment URL printed by `vercel deploy` (its final stdout line).
	 * Surfaces the deployed link in stack outputs after `pulumi up` without visiting the dashboard.
	 */
	public readonly deploymentUrl: pulumi.Output<string>;

	constructor(name: string, args: VercelDeployArgs, opts: VercelDeployOptions) {
		const { provider, project, ...pulumiOpts } = opts;

		super("infracraft:vercel:Deploy", name, {}, pulumiOpts);

		const projectId = project
			? project.id
			: (args.projectId as pulumi.Input<string>);

		if (!projectId) {
			throw new Error(
				"VercelDeploy: either `args.projectId` or `opts.project` must be provided",
			);
		}

		const deployCmd = new command.local.Command(
			`${name}-deploy`,
			{
				create: buildVercelDeployCommand(args.excludePaths),
				triggers: args.triggers,
				dir: stableDir(args.monorepoRoot),
				environment: {
					VERCEL_TOKEN: provider.token,
					VERCEL_ORG_ID: provider.teamId,
					VERCEL_PROJECT_ID: projectId,
				},
			},
			{ parent: this },
		);

		this.deploymentUrl = deployCmd.stdout.apply(
			(out) => out.trim().split("\n").pop() ?? "",
		);

		this.registerOutputs({ deploymentUrl: this.deploymentUrl });
	}
}
