import * as command from "@pulumi/command";
import * as pulumi from "@pulumi/pulumi";
import type { RailwayEnvironment } from "./environment.js";
import type { RailwayProject } from "./project.js";
import type { RailwayProvider } from "./provider.js";
import type { RailwayService } from "./service.js";

/** Build and deploy configuration for a Railway service. */
export interface RailwayDeployConfig {
	/** Build system: `"RAILPACK"`, `"NIXPACKS"`, or `"DOCKERFILE"`. */
	builder?: string;

	/** Shell command executed to start the service at runtime. */
	startCommand?: string;

	/** Shell command executed before the main deploy (e.g. migrations). */
	preDeployCommand?: string;
}

/** Args for RailwayDeploy. */
export interface RailwayDeployArgs {
	/** Absolute path to the monorepo root (working directory for `railway up`). */
	directory: string;

	/** SHA-256 hash of the app source directory, used as a deploy trigger. */
	sourceHash: string;

	/** Env var map used as deploy trigger. */
	env: Record<string, pulumi.Input<string>>;

	/** Directories to exclude via `.railwayignore`. */
	excludePaths?: string[];

	/** Railpack configuration written to `railpack.json` before deploy. */
	railpackConfig?: Record<string, unknown>;
}

/** Options type for RailwayDeploy — replaces Pulumi's native `provider` field. */
type RailwayDeployOptions = Omit<
	pulumi.ComponentResourceOptions,
	"provider"
> & {
	/** Railway authentication context. */
	provider: RailwayProvider;

	/** Railway project context. */
	project: RailwayProject;

	/** Railway environment context. */
	environment: RailwayEnvironment;

	/** Railway service context. */
	service: RailwayService;
};

const LOCK_DIR = "/tmp/.railway-upload-lock";

/**
 * Deploys a Railway service and waits for the build to complete.
 *
 * Uses `railway up --ci` which blocks until the build finishes.
 * Multiple deploys run in parallel — a mkdir lock serializes only the
 * brief upload phase (~5s) when `.railwayignore` must be consistent,
 * then releases so builds stream concurrently.
 *
 * @example
 * ```typescript
 * new RailwayDeploy("api-deploy", {
 *   directory: monorepoRoot,
 *   sourceHash,
 *   env: { DATABASE_URL: dbUrl },
 * }, { provider, project, environment, service });
 * ```
 */
export class RailwayDeploy extends pulumi.ComponentResource {
	constructor(
		name: string,
		args: RailwayDeployArgs,
		opts: RailwayDeployOptions,
	) {
		const { provider, project, environment, service, ...pulumiOpts } = opts;

		super("infracraft:railway:Deploy", name, {}, pulumiOpts);

		const ignorePatterns = (args.excludePaths ?? [])
			.map((dir) => {
				if (dir.startsWith("apps/")) {
					return `${dir}/**\\n!${dir}/package.json`;
				}

				return dir;
			})
			.join("\\n");

		const writeIgnore = ignorePatterns
			? `printf '${ignorePatterns}\\n' > .railwayignore`
			: "";

		const writeRailpack = args.railpackConfig
			? `printf '${JSON.stringify(args.railpackConfig).replace(/'/g, "\\'")}' > railpack.json`
			: "";

		const setupLines = [writeIgnore, writeRailpack].filter(Boolean).join("; ");

		const envHash = pulumi
			.all(
				Object.entries(args.env)
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([k, v]) => pulumi.output(v).apply((val) => `${k}=${val}`)),
			)
			.apply((parts) => parts.join(","));

		// Parallel-safe upload: multiple stacks deploy concurrently, but each writes
		// .railwayignore and railpack.json to the same monorepo root before calling
		// `railway up`. The mkdir lock serializes that brief window (~5s upload phase).
		// After upload, the background job releases the lock so builds stream in parallel.
		//
		// Flow: acquire lock → write config files → release lock after 5s (background) →
		//       railway up --ci (blocks through upload, then streams build logs) →
		//       cleanup on exit
		const deployCmd = pulumi.interpolate`while ! mkdir ${LOCK_DIR} 2>/dev/null; do sleep 1; done; ${setupLines}; { sleep 5; rm -f .railwayignore railpack.json; rmdir ${LOCK_DIR} 2>/dev/null; } & railway up --ci --project ${project.projectId} --service ${service.serviceId} --environment ${environment.environmentId}; EXIT=$?; rm -f .railwayignore railpack.json; rmdir ${LOCK_DIR} 2>/dev/null; wait; exit $EXIT`;

		new command.local.Command(
			`${name}-deploy`,
			{
				create: deployCmd,
				triggers: [args.sourceHash, envHash],
				dir: args.directory,
				environment: {
					RAILWAY_TOKEN: project.projectToken,
				},
			},
			{ parent: this },
		);

		this.registerOutputs({});
	}
}
