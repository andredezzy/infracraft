import type { VercelClient } from "./client";

/** Vercel API response for a single env var. */
export interface VercelEnvVar {
	id: string;
	key: string;
	value: string;
	type: string;
	target: string[];
}

/**
 * Fetches all environment variables for a Vercel project with decrypted values.
 * A variable that vanishes between the list and its decrypt read is skipped.
 */
async function fetchEnvVars(
	client: VercelClient,
	projectId: string,
): Promise<VercelEnvVar[]> {
	const list = await client.get<{ envs: VercelEnvVar[] }>(
		`/v9/projects/${projectId}/env`,
	);

	const decrypted: VercelEnvVar[] = [];

	for (const env of list.envs) {
		const decryptedVar = await client.tryGet<VercelEnvVar>(
			`/v9/projects/${projectId}/env/${env.id}?decrypt=true`,
		);

		if (decryptedVar) {
			decrypted.push(decryptedVar);
		}
	}

	return decrypted;
}

/**
 * Upserts a single Vercel env var targeting all environments: creates it, and
 * when the key already exists (ENV_CONFLICT) updates it in place instead.
 */
export async function upsertEnvVar(
	client: VercelClient,
	projectId: string,
	key: string,
	value: string,
	log: (line: string) => void,
): Promise<VercelEnvVar> {
	try {
		return await client.post<VercelEnvVar>(`/v10/projects/${projectId}/env`, {
			key,
			value,
			type: "encrypted",
			target: ["production", "preview", "development"],
		});
	} catch (error) {
		// ENV_CONFLICT is Vercel's error code for "key already exists"; the client
		// surfaces the API error body in the message, so it is matched there.
		if (error instanceof Error && error.message.includes("ENV_CONFLICT")) {
			log(`Vercel env var "${key}" already exists, will update instead`);

			const existing = await fetchEnvVars(client, projectId);
			const match = existing.find((e) => e.key === key);

			if (match) {
				await updateEnvVar(client, projectId, match.id, value);

				return { ...match, value };
			}
		}

		throw error;
	}
}

/**
 * Updates a single Vercel env var value.
 */
async function updateEnvVar(
	client: VercelClient,
	projectId: string,
	envId: string,
	value: string,
): Promise<void> {
	await client.patch(`/v9/projects/${projectId}/env/${envId}`, { value });
}
