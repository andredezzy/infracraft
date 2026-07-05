// src/railway/deploy.ts  (replace entire file)
import { fileURLToPath } from "node:url";

import * as pulumi from "@pulumi/pulumi";

import { createDeployCommand } from "../commands/deploy";
import type { RailwayEnvironment } from "./environment";
import type { RailwayProject } from "./project";
import type { RailwayProvider } from "./provider";
import { RailwayBuilder, type RailwayService } from "./service";

export interface RailwayDeployConfig {
	builder?: RailwayBuilder;
	startCommand?: string;
	preDeployCommand?: string;
}

export interface RailwayDeployArgs {
	/** Redeploy triggers (e.g. source hashes, env hashes). */
	triggers: pulumi.Input<pulumi.Input<string>[]>;
	/** Paths excluded from the upload when running with `DeploySandbox` + `GitGuard`. */
	excludePaths?: string[];
	/** Railpack configuration written to `railpack.json` before deploy. */
	railpackConfig?: Record<string, unknown>;
}

type RailwayDeployOptions = Omit<
	pulumi.ComponentResourceOptions,
	"provider"
> & {
	provider: RailwayProvider;
	project: RailwayProject;
	environment: RailwayEnvironment;
	service: RailwayService;
	/** Environment-scoped Railway deploy token (provision via RailwayProjectToken). */
	projectToken: pulumi.Input<string>;
};

/**
 * Absolute path to the runnable deploy monitor, resolved next to this module in `dist`.
 * `railway up` only uploads + triggers; this bin makes the Railway GraphQL API — not the
 * CLI's exit code — the source of truth for pass/fail, and dumps build + deploy logs on
 * failure. Its logic lives in the unit-tested `deployment-monitor` module.
 */
const MONITOR_BIN = fileURLToPath(
	new URL("./bin/monitor-deployment.mjs", import.meta.url),
);

/**
 * Deploys a Railway service and waits for a terminal status. Isolation/git are the
 * seam's job (list a `DeploySandbox` and optionally a `GitGuard` in `dependsOn`).
 *
 * @example
 * ```typescript
 * new RailwayDeploy("mesh", { triggers: [sourceHash], railpackConfig: { apt: ["libatomic1"] } },
 *   { provider, project, environment, service, projectToken: token.token, dependsOn: [sandbox, gitGuard] });
 * ```
 */
export class RailwayDeploy extends pulumi.ComponentResource {
	/** The deploy CLI's final stdout line (Railway service URL when emitted). */
	public readonly deploymentUrl: pulumi.Output<string>;

	constructor(
		name: string,
		args: RailwayDeployArgs,
		opts: RailwayDeployOptions,
	) {
		const {
			provider,
			project,
			environment,
			service,
			projectToken,
			...pulumiOpts
		} = opts;

		super("infracraft:railway:Deploy", name, {}, pulumiOpts);

		// `railway up --detach` uploads + triggers WITHOUT attaching to the build-log
		// stream — that long-lived stream is what intermittently times out and makes the
		// CLI exit non-zero even when the deploy actually succeeds. We capture its `--json`
		// output (for the exact deployment id) and exit code, re-emit it for visibility,
		// then hand off to the monitor bin which polls the Railway API to a terminal status.
		// The API — not the CLI exit code — decides pass/fail.
		//
		// The token travels via the command's STDIN, never in the script text: on failure
		// pulumi-command embeds the executed command verbatim in its error message, and
		// Pulumi does not scrub secrets from provider diagnostics — an inlined token prints
		// in plaintext exactly when a deploy fails. The `environment` map is no alternative:
		// an unknown secret there makes `pulumi preview` fail (the token is a resource
		// output, unknown on first preview). `|| true` keeps `set -e` alive when the stdin
		// payload has no trailing newline (read then exits 1 but still fills IC_TOK).
		// IC_SINCE is captured just before `railway up` as a createdAt fallback for id
		// resolution.
		// The capture is guarded with if/else because the whole script runs under
		// `set -e`: a bare `VAR=$(cmd); EXIT=$?` DIES AT THE ASSIGNMENT when cmd
		// fails, before the exit code is saved and before the output is re-emitted
		// — swallowing the CLI's error entirely (live incident: a failed production
		// `railway up` left zero diagnostics).
		const cli = pulumi.interpolate`IFS= read -r IC_TOK || true; IC_SINCE=$(node -e "process.stdout.write(String(Date.now()))"); if IC_UP_OUT=$(RAILWAY_TOKEN="$IC_TOK" railway up --detach --json --project ${project.id} --service ${service.id} --environment ${environment.id} 2>&1); then IC_UP_EXIT=0; else IC_UP_EXIT=$?; fi; printf '%s\\n' "$IC_UP_OUT"; if [ -n "$INFRACRAFT_SKIP_DEPLOY_WAIT" ]; then exit "$IC_UP_EXIT"; fi; IC_UP_OUT="$IC_UP_OUT" IC_UP_EXIT=$IC_UP_EXIT IC_TOK="$IC_TOK" IC_PROJ=${project.id} IC_ENV=${environment.id} IC_SVC=${service.id} IC_SINCE=$IC_SINCE node "${MONITOR_BIN}"`;

		// `printf '%s'` (not a bare format string) so railpack values containing %
		// are literal; the JSON is single-quote-escaped the POSIX way (' -> '\'').
		const setup = args.railpackConfig
			? `printf '%s' '${JSON.stringify(args.railpackConfig).replace(/'/g, "'\\''")}' > railpack.json`
			: undefined;

		const { deploymentUrl } = createDeployCommand(
			{
				name,
				cli,
				triggers: args.triggers,
				excludePaths: args.excludePaths,
				setup,
				stdin: projectToken,
			},
			{ parent: this, ...pulumiOpts },
		);

		this.deploymentUrl = deploymentUrl;

		this.registerOutputs({ deploymentUrl: this.deploymentUrl });
	}
}
