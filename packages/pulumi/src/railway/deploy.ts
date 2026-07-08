import { fileURLToPath } from "node:url";

import * as pulumi from "@pulumi/pulumi";

import { createDeployCommand } from "../commands/deploy";
import type { Environment } from "./environment";
import type { Project } from "./project";
import type { Provider } from "./provider";
import { Builder, type Service } from "./service";

/**
 * `railway up`'s upload REQUEST occasionally fails at the transport level
 * ("error sending request for url …/up"). Usually the request never reached
 * Railway (no deployment created), so re-running is safe. A rarer post-send
 * response timeout renders the SAME error yet MAY have created a deployment, so a
 * retry can duplicate it — but the monitor watches the NEWEST deployment and a new
 * `railway up` supersedes the older, bounding the worst case to a wasted build.
 * A flaky post-upload CLI exit is a DIFFERENT error and is deliberately NOT retried.
 */
const UPLOAD_ATTEMPTS = 3;
/** Seconds between upload retries. */
const UPLOAD_BACKOFF_SECONDS = 5;

export interface DeployConfig {
	builder?: Builder;
	startCommand?: string;
	preDeployCommand?: string;
}

export interface DeployArgs {
	/** Redeploy triggers (e.g. source hashes, env hashes). */
	triggers: pulumi.Input<pulumi.Input<string>[]>;
	/** Paths excluded from the upload when running with `DeploySandbox` + `GitGuard`. */
	excludePaths?: string[];
	/** Railpack configuration written to `railpack.json` before deploy. */
	railpackConfig?: Record<string, unknown>;
	/**
	 * HTTP path polled for health checks (e.g. `"/healthcheck"`), applied by
	 * the deploy monitor once the deployment is live. Railway rejects
	 * healthcheck fields on a fresh instance with no deployment ("Invalid
	 * input"), so a code service's healthcheck can only land post-deploy —
	 * pass it here (mirroring `ServiceArgs.healthcheckPath`) and the
	 * monitor applies it via `serviceInstanceUpdate`, failing loudly instead
	 * of silently dropping it.
	 *
	 * This is the SAME Railway field `ServiceArgs.healthcheckPath`
	 * validates, just applied later (post-first-deploy): Railway rejects ANY
	 * hyphen in the value with "Invalid input" (undocumented; proven by live
	 * probe matrix 2026-07-06). A hyphenated value throws here at preview time.
	 */
	healthcheckPath?: pulumi.Input<string>;
	/** Seconds to wait for a healthy response; applied alongside `healthcheckPath`. */
	healthcheckTimeout?: pulumi.Input<number>;
	/** Explicit opt-in to deploy without a `DeploySandbox` in `dependsOn`. Defaults to `false`. */
	allowUnsandboxed?: boolean;
}

type DeployOptions = Omit<pulumi.ComponentResourceOptions, "provider"> & {
	provider: Provider;
	project: Project;
	environment: Environment;
	service: Service;
	/** Environment-scoped Railway deploy token (provision via ProjectToken). */
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
 * Recommended preflight: `assertHostBinaries(["railway"])` (from
 * `@infracraft/pulumi/sandbox`) at program start, so a missing CLI fails fast
 * with an install hint instead of mid-deploy.
 *
 * @example
 * ```typescript
 * new railway.Deploy("api", { triggers: [sourceHash], railpackConfig: { apt: ["libatomic1"] } },
 *   { provider, project, environment, service, projectToken: token.token, dependsOn: [sandbox, gitGuard] });
 * ```
 */
export class Deploy extends pulumi.ComponentResource {
	/** The last http(s) URL token found in the deploy CLI's stdout (Railway service URL when emitted). */
	public readonly deploymentUrl: pulumi.Output<string>;

	constructor(name: string, args: DeployArgs, opts: DeployOptions) {
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
		//
		// A transport-level upload failure ("error sending request …/up") is retried up
		// to UPLOAD_ATTEMPTS times with backoff — usually the request never reached
		// Railway (no deployment); a rare post-send timeout could duplicate, but the
		// monitor watches the newest deployment and Railway supersedes the older. Any
		// other non-zero exit is left to the monitor (a flaky exit can mean the deploy
		// DID start).
		//
		// IC_HC_PATH / IC_HC_TIMEOUT ride into the monitor only when the consumer
		// configured them — the monitor applies the healthcheck post-deploy (a
		// fresh instance rejects it pre-deploy) and fails loudly if that errors.
		// The path is single-quote-escaped the POSIX way (' -> '\'').
		const healthcheckBindings = pulumi
			.all([args.healthcheckPath, args.healthcheckTimeout])
			.apply(([path, timeout]) => {
				const bindings: string[] = [];

				if (path) {
					// Same field service.ts's check() validates — the monitor applies
					// this via serviceInstanceUpdate, so a hyphenated value would 403
					// mid-deploy just as it would at initial creation. Caught here at
					// preview time instead.
					if (path.includes("-")) {
						throw new Error(
							'Railway rejects any healthcheckPath containing a hyphen with "Invalid input" (undocumented; proven by live probe matrix 2026-07-06) — use a hyphen-free path like "/healthcheck"',
						);
					}

					bindings.push(`IC_HC_PATH='${path.replace(/'/g, "'\\''")}'`);
				}

				if (timeout !== undefined) {
					bindings.push(`IC_HC_TIMEOUT=${timeout}`);
				}

				return bindings.length > 0 ? `${bindings.join(" ")} ` : "";
			});

		const cli = pulumi.interpolate`IFS= read -r IC_TOK || true; IC_SINCE=$(node -e "process.stdout.write(String(Date.now()))"); IC_UP_EXIT=0; IC_TRY=1; while [ "$IC_TRY" -le ${UPLOAD_ATTEMPTS} ]; do if IC_UP_OUT=$(RAILWAY_TOKEN="$IC_TOK" railway up --detach --json --project ${project.id} --service ${service.id} --environment ${environment.id} 2>&1); then IC_UP_EXIT=0; break; else IC_UP_EXIT=$?; fi; case "$IC_UP_OUT" in *"error sending request"*) if [ "$IC_TRY" -lt ${UPLOAD_ATTEMPTS} ]; then IC_TRY=$((IC_TRY+1)); sleep ${UPLOAD_BACKOFF_SECONDS}; continue; fi;; esac; break; done; printf '%s\\n' "$IC_UP_OUT"; if [ -n "$INFRACRAFT_SKIP_DEPLOY_WAIT" ]; then exit "$IC_UP_EXIT"; fi; IC_UP_OUT="$IC_UP_OUT" IC_UP_EXIT=$IC_UP_EXIT IC_TOK="$IC_TOK" IC_PROJ=${project.id} IC_ENV=${environment.id} IC_SVC=${service.id} IC_SINCE=$IC_SINCE ${healthcheckBindings}node "${MONITOR_BIN}"`;

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
				allowUnsandboxed: args.allowUnsandboxed,
			},
			{ parent: this, ...pulumiOpts },
		);

		this.deploymentUrl = deploymentUrl;

		this.registerOutputs({ deploymentUrl: this.deploymentUrl });
	}
}
