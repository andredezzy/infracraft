/**
 * Deploy-integrated Vercel env var applier.
 *
 * Applies a key→value map to a Vercel project (production + preview +
 * development) through the plain REST API, inside the deploy COMMAND flow —
 * never as a Pulumi dynamic resource. The dynamic-resource path
 * (`VercelVariable`) hits a Pulumi engine-internal stateful bug on clean-slate
 * first creates ("Unexpected struct type", strictly alternating pass/fail
 * across identical from-zero runs, reproduced with plain-literal inputs — zero
 * Outputs/secrets — on matched CLI/SDK versions; four structural theories
 * falsified by bisection). The fix is architectural: run the env upserts as an
 * imperative step of the deploy command — the same pattern as the Railway
 * deploy monitor owning imperative deploy steps — off the dynamic-provider
 * marshal path entirely.
 *
 * Dependency-injected (`log`) so the behavior is unit-tested. The runnable
 * wrapper that wires real IO lives in `./bin/apply-env.ts`.
 */
import { VercelClient } from "./client";
import { upsertEnvVar } from "./env-var-api";

/** Everything the applier needs to upsert one project's env vars. */
export interface ApplyVercelEnvInput {
	/** Vercel API bearer token. */
	token: string;

	/** Vercel team/org ID. */
	teamId: string;

	/** Vercel project ID. */
	projectId: string;

	/** Key-value map of environment variable names to their values. */
	variables: Record<string, string>;
}

/** Injected side-effecting collaborators (real impl in the bin, fakes in tests). */
export interface ApplyVercelEnvDeps {
	log: (line: string) => void;
}

/**
 * Upserts every entry of `variables` for the project, targeting production +
 * preview + development (create, or update in place on ENV_CONFLICT — the
 * exact semantics `VercelVariable` uses, via the shared `env-var-api`).
 *
 * Logs one line per applied key — names only, never values. Throws on the
 * first failure with the offending key named, so the bin exits non-zero and
 * the deploy never runs against a half-applied environment.
 */
export async function applyVercelEnv(
	input: ApplyVercelEnvInput,
	deps: ApplyVercelEnvDeps,
): Promise<void> {
	const client = new VercelClient(input.token, input.teamId);

	for (const [key, value] of Object.entries(input.variables)) {
		try {
			await upsertEnvVar(client, input.projectId, key, value, deps.log);
		} catch (error) {
			throw new Error(
				`failed to apply Vercel env var "${key}": ${error instanceof Error ? error.message : String(error)}`,
			);
		}

		deps.log(`applied Vercel env var "${key}"`);
	}
}
