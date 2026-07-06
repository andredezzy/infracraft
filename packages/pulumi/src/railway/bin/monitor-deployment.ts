/**
 * Runnable entry for the Railway deploy monitor — invoked by `Deploy` as
 * `node <dist>/railway/bin/monitor-deployment.mjs` after `railway up --detach`.
 *
 * Reads the deploy context from `IC_*` env vars, wires the real `fetch`/`setTimeout`/stderr
 * collaborators, and exits non-zero iff the Railway API reports a failed (or never-resolved-
 * after-failed-upload) deployment. All decision logic lives in the unit-tested
 * `deployment-monitor` module; this file is only IO + process glue.
 */
import { monitorRailwayDeployment } from "../deployment-monitor";

async function main(): Promise<void> {
	const result = await monitorRailwayDeployment(
		{
			// Defaults to Railway's public API; override only to point at a proxy or a test server.
			apiUrl: process.env.IC_API_URL || undefined,
			projectToken: process.env.IC_TOK ?? "",
			projectId: process.env.IC_PROJ ?? "",
			environmentId: process.env.IC_ENV ?? "",
			serviceId: process.env.IC_SVC ?? "",
			deploymentId: process.env.IC_DEPLOY_ID || undefined,
			uploadOutput: process.env.IC_UP_OUT,
			uploadExitCode: Number(process.env.IC_UP_EXIT ?? "0"),
			since: Number(process.env.IC_SINCE ?? "0"),
			// Healthcheck config applied post-deploy (fresh instances reject it
			// pre-deploy); set by Deploy only when the consumer configured it.
			healthcheckPath: process.env.IC_HC_PATH || undefined,
			healthcheckTimeout: process.env.IC_HC_TIMEOUT
				? Number(process.env.IC_HC_TIMEOUT)
				: undefined,
		},
		{
			fetch: globalThis.fetch,
			sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
			log: (line) => process.stderr.write(`${line}\n`),
		},
	);

	process.exit(result.failed ? 1 : 0);
}

main().catch((error) => {
	process.stderr.write(
		`[infracraft] deploy monitor crashed: ${error instanceof Error ? error.message : String(error)}\n`,
	);

	process.exit(1);
});
