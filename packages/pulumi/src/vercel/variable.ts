import * as pulumi from "@pulumi/pulumi";

const VERCEL_API_URL = "https://api.vercel.com";

/** Resolved inputs for the Vercel variable dynamic provider. */
export interface VercelVariableInputs {
	/** Vercel API bearer token. */
	token: string;

	/** Vercel team/org ID. */
	teamId: string;

	/** Vercel project ID. */
	projectId: string;

	/** Key-value map of environment variable names to their values. */
	variables: Record<string, string>;
}

/** Persisted state for Vercel variables. */
interface VercelVariableOutputs extends VercelVariableInputs {
	/** Map of env var keys to their Vercel-assigned IDs (for updates and deletes). */
	envIds: Record<string, string>;

	/** SHA-256 hash of all key-value pairs. Changes when any value is modified (including drift fixes). */
	contentHash: string;
}

/**
 * Computes a deterministic content hash of a variables map.
 * Uses dynamic import to avoid capturing `crypto` in the provider closure.
 *
 * @param variables Key-value map of environment variables
 * @returns Hex-encoded SHA-256 hash
 */
async function hashVariables(
	variables: Record<string, string>,
): Promise<string> {
	const crypto = await import("node:crypto");
	const hash = crypto.createHash("sha256");

	const sorted = Object.entries(variables).sort(([a], [b]) =>
		a.localeCompare(b),
	);

	for (const [key, value] of sorted) {
		hash.update(key);
		hash.update(value);
	}

	return hash.digest("hex");
}

/** Vercel API response for a single env var. */
interface VercelEnvVar {
	id: string;
	key: string;
	value: string;
	type: string;
	target: string[];
}

/**
 * Fetches all environment variables for a Vercel project with decrypted values.
 *
 * @param token Vercel API token
 * @param teamId Vercel team ID
 * @param projectId Vercel project ID
 * @returns Array of env vars with decrypted values
 */
async function fetchEnvVars(
	token: string,
	teamId: string,
	projectId: string,
): Promise<VercelEnvVar[]> {
	const listResponse = await fetch(
		`${VERCEL_API_URL}/v9/projects/${projectId}/env?teamId=${teamId}`,
		{ headers: { Authorization: `Bearer ${token}` } },
	);

	if (!listResponse.ok) {
		throw new Error(
			`Vercel API error (${listResponse.status}): ${await listResponse.text()}`,
		);
	}

	const list = (await listResponse.json()) as { envs: VercelEnvVar[] };

	const decrypted: VercelEnvVar[] = [];

	for (const env of list.envs) {
		const response = await fetch(
			`${VERCEL_API_URL}/v9/projects/${projectId}/env/${env.id}?teamId=${teamId}&decrypt=true`,
			{ headers: { Authorization: `Bearer ${token}` } },
		);

		if (response.ok) {
			decrypted.push((await response.json()) as VercelEnvVar);
		}
	}

	return decrypted;
}

/**
 * Creates a single Vercel env var targeting all environments.
 *
 * @param token Vercel API token
 * @param teamId Vercel team ID
 * @param projectId Vercel project ID
 * @param key Env var name
 * @param value Env var value
 * @returns The created env var with its Vercel-assigned ID
 */
async function createEnvVar(
	token: string,
	teamId: string,
	projectId: string,
	key: string,
	value: string,
): Promise<VercelEnvVar> {
	const response = await fetch(
		`${VERCEL_API_URL}/v10/projects/${projectId}/env?teamId=${teamId}`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				key,
				value,
				type: "encrypted",
				target: ["production", "preview", "development"],
			}),
		},
	);

	if (!response.ok) {
		const errorText = await response.text();

		if (errorText.includes("ENV_CONFLICT")) {
			pulumi.log.info(
				`Vercel env var "${key}" already exists, will update instead`,
			);

			const existing = await fetchEnvVars(token, teamId, projectId);
			const match = existing.find((e) => e.key === key);

			if (match) {
				await updateEnvVar(token, teamId, projectId, match.id, value);

				return { ...match, value };
			}
		}

		throw new Error(
			`Vercel API error creating "${key}" (${response.status}): ${errorText}`,
		);
	}

	return (await response.json()) as VercelEnvVar;
}

/**
 * Updates a single Vercel env var value.
 *
 * @param token Vercel API token
 * @param teamId Vercel team ID
 * @param projectId Vercel project ID
 * @param envId Vercel-assigned env var ID
 * @param value New value
 */
async function updateEnvVar(
	token: string,
	teamId: string,
	projectId: string,
	envId: string,
	value: string,
): Promise<void> {
	const response = await fetch(
		`${VERCEL_API_URL}/v9/projects/${projectId}/env/${envId}?teamId=${teamId}`,
		{
			method: "PATCH",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ value }),
		},
	);

	if (!response.ok) {
		throw new Error(
			`Vercel API error updating env var (${response.status}): ${await response.text()}`,
		);
	}
}

/**
 * Deletes a single Vercel env var.
 *
 * @param token Vercel API token
 * @param teamId Vercel team ID
 * @param projectId Vercel project ID
 * @param envId Vercel-assigned env var ID
 */
async function deleteEnvVar(
	token: string,
	teamId: string,
	projectId: string,
	envId: string,
): Promise<void> {
	const response = await fetch(
		`${VERCEL_API_URL}/v9/projects/${projectId}/env/${envId}?teamId=${teamId}`,
		{
			method: "DELETE",
			headers: { Authorization: `Bearer ${token}` },
		},
	);

	if (!response.ok && response.status !== 404) {
		throw new Error(
			`Vercel API error deleting env var (${response.status}): ${await response.text()}`,
		);
	}
}

/**
 * Dynamic provider implementing CRUD for Vercel project environment variables.
 *
 * Manages all env vars for a project as a batch (like RailwayVariable).
 * The `read()` method fetches decrypted values from Vercel's API,
 * enabling drift detection during `pulumi refresh`.
 */
class VercelVariableProvider implements pulumi.dynamic.ResourceProvider {
	/**
	 * Creates all env vars on the target Vercel project.
	 * Handles ENV_CONFLICT by updating existing vars instead of failing.
	 *
	 * @param inputs Resolved variable configuration
	 * @returns Composite ID in the form `{projectId}:variables`
	 */
	async create(
		inputs: VercelVariableInputs,
	): Promise<pulumi.dynamic.CreateResult> {
		const envIds: Record<string, string> = {};

		for (const [key, value] of Object.entries(inputs.variables)) {
			const result = await createEnvVar(
				inputs.token,
				inputs.teamId,
				inputs.projectId,
				key,
				value,
			);

			envIds[key] = result.id;
		}

		return {
			id: `${inputs.projectId}:variables`,
			outs: {
				...inputs,
				envIds,
				contentHash: await hashVariables(inputs.variables),
			},
		};
	}

	/**
	 * Updates variables by deleting removed keys, creating new keys,
	 * and patching changed values.
	 *
	 * @param _id Current resource ID
	 * @param olds Previous persisted state
	 * @param news New desired configuration
	 * @returns Updated outputs with current envIds
	 */
	async update(
		_id: string,
		olds: VercelVariableOutputs,
		news: VercelVariableInputs,
	): Promise<pulumi.dynamic.UpdateResult> {
		const envIds = { ...olds.envIds };

		const removedKeys = Object.keys(olds.variables).filter(
			(key) => !(key in news.variables),
		);

		for (const key of removedKeys) {
			const envId = envIds[key];

			if (envId) {
				try {
					await deleteEnvVar(news.token, news.teamId, news.projectId, envId);
				} catch {
					pulumi.log.warn(
						`Failed to delete Vercel env var "${key}" (may already be deleted)`,
					);
				}

				delete envIds[key];
			}
		}

		for (const [key, value] of Object.entries(news.variables)) {
			const existingId = envIds[key];

			if (existingId && olds.variables[key] !== value) {
				await updateEnvVar(
					news.token,
					news.teamId,
					news.projectId,
					existingId,
					value,
				);
			} else if (!existingId) {
				const result = await createEnvVar(
					news.token,
					news.teamId,
					news.projectId,
					key,
					value,
				);

				envIds[key] = result.id;
			}
		}

		return {
			outs: {
				...news,
				envIds,
				contentHash: await hashVariables(news.variables),
			},
		};
	}

	/**
	 * Reads current state from Vercel API with decrypted values.
	 * Enables drift detection during `pulumi refresh`.
	 *
	 * @param id Current resource ID
	 * @param props Last known persisted state
	 * @returns Refreshed properties with actual values from Vercel
	 */
	async read(
		id: string,
		props: VercelVariableOutputs,
	): Promise<pulumi.dynamic.ReadResult> {
		const actual = await fetchEnvVars(
			props.token,
			props.teamId,
			props.projectId,
		);

		const actualVariables: Record<string, string> = {};
		const actualEnvIds: Record<string, string> = {};

		for (const [key] of Object.entries(props.variables)) {
			const match = actual.find((e) => e.key === key);

			if (match) {
				actualVariables[key] = match.value;
				actualEnvIds[key] = match.id;
			}
		}

		return {
			id,
			props: {
				...props,
				variables: actualVariables,
				envIds: actualEnvIds,
				contentHash: await hashVariables(actualVariables),
			},
		};
	}

	/**
	 * Deletes all managed env vars from Vercel.
	 *
	 * @param _id Current resource ID
	 * @param props Last known persisted state
	 */
	async delete(_id: string, props: VercelVariableOutputs): Promise<void> {
		for (const [key, envId] of Object.entries(props.envIds)) {
			try {
				await deleteEnvVar(props.token, props.teamId, props.projectId, envId);
			} catch {
				pulumi.log.warn(
					`Failed to delete Vercel env var "${key}" (may already be deleted)`,
				);
			}
		}
	}

	/**
	 * Compares old and new variable maps by key set and value equality.
	 *
	 * @param _id Current resource ID
	 * @param olds Previous persisted state
	 * @param news New desired configuration
	 * @returns Whether any keys or values changed
	 */
	async diff(
		_id: string,
		olds: VercelVariableOutputs,
		news: VercelVariableInputs,
	): Promise<pulumi.dynamic.DiffResult> {
		const oldKeys = Object.keys(olds.variables).sort().join(",");
		const newKeys = Object.keys(news.variables).sort().join(",");

		const valuesChanged = Object.entries(news.variables).some(
			([key, value]) => olds.variables[key] !== value,
		);

		return {
			changes: oldKeys !== newKeys || valuesChanged,
		};
	}
}

/**
 * Manages Vercel project environment variables as a batch with drift detection.
 *
 * Unlike `@pulumiverse/vercel`'s `ProjectEnvironmentVariable`, this provider
 * reads decrypted values from Vercel's API during `pulumi refresh`, enabling
 * detection of manually changed env var values.
 *
 * All variables target production, preview, and development environments.
 *
 * @example
 * ```typescript
 * new VercelVariable("vercel-variable-nexus", {
 *   token: vercelConfig.token,
 *   teamId: vercelConfig.teamId,
 *   projectId: project.id,
 *   variables: {
 *     NEXT_PUBLIC_API_URL: meshUrl,
 *     NEXTAUTH_SECRET: config.requireSecret("nextauthSecret"),
 *   },
 * });
 * ```
 */
export class VercelVariable extends pulumi.dynamic.Resource {
	/** SHA-256 hash of all key-value pairs. Use as a deploy trigger for drift-aware redeployment. */
	public declare readonly contentHash: pulumi.Output<string>;

	/**
	 * @param name Pulumi resource name
	 * @param args Variable configuration inputs
	 * @param opts Standard Pulumi resource options
	 */
	constructor(
		name: string,
		args: {
			/** Vercel API bearer token. */
			token: pulumi.Input<string>;

			/** Vercel team/org ID. */
			teamId: pulumi.Input<string>;

			/** Vercel project ID. */
			projectId: pulumi.Input<string>;

			/** Key-value map of environment variable names to their values. */
			variables: pulumi.Input<Record<string, pulumi.Input<string>>>;
		},
		opts?: pulumi.CustomResourceOptions,
	) {
		super(
			new VercelVariableProvider(),
			name,
			{ ...args, envIds: undefined, contentHash: undefined },
			opts,
		);
	}
}
