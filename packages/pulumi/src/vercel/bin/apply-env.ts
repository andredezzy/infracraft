/**
 * Runnable entry for the Vercel env applier — invoked by `VercelDeploy` as
 * `node <dist>/vercel/bin/apply-env.mjs` right before `vercel deploy` when
 * `variables` are configured.
 *
 * Reads the deploy context from the command environment (`VERCEL_TOKEN`,
 * `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` — the same names the deploy CLI already
 * receives — plus `IC_VC_ENV_JSON`, the JSON key→value payload), applies the
 * variables via the Vercel REST API, and exits non-zero on the first failure.
 * All upsert logic lives in the unit-tested `env-applier` module; this file is
 * only IO + process glue.
 */
import { applyVercelEnv } from "../env-applier";

/** Reads a required env var, failing loudly — naming it — when unset. */
function requireEnv(name: string): string {
	const value = process.env[name];

	if (!value) {
		throw new Error(`${name} is not set in the deploy command environment`);
	}

	return value;
}

async function main(): Promise<void> {
	await applyVercelEnv(
		{
			token: requireEnv("VERCEL_TOKEN"),
			teamId: requireEnv("VERCEL_ORG_ID"),
			projectId: requireEnv("VERCEL_PROJECT_ID"),
			variables: JSON.parse(requireEnv("IC_VC_ENV_JSON")) as Record<
				string,
				string
			>,
		},
		{ log: (line) => process.stderr.write(`[infracraft] ${line}\n`) },
	);
}

main().catch((error) => {
	process.stderr.write(
		`[infracraft] vercel env applier failed: ${error instanceof Error ? error.message : String(error)}\n`,
	);

	process.exit(1);
});
