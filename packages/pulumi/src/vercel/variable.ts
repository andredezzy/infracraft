import * as pulumi from "@pulumi/pulumi";
import type { VercelProject } from "./project";
import type { VercelProvider } from "./provider";

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
 */
class VercelVariableResourceProvider
	implements pulumi.dynamic.ResourceProvider
{
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

/** Internal dynamic resource — not part of the public API. */
class VercelVariableResource extends pulumi.dynamic.Resource {
	public declare readonly contentHash: pulumi.Output<string>;

	constructor(
		name: string,
		args: {
			token: pulumi.Input<string>;
			teamId: pulumi.Input<string>;
			projectId: pulumi.Input<string>;
			variables: pulumi.Input<Record<string, pulumi.Input<string>>>;
		},
		opts?: pulumi.CustomResourceOptions,
	) {
		super(
			new VercelVariableResourceProvider(),
			name,
			{ ...args, envIds: undefined, contentHash: undefined },
			opts,
		);
	}
}

/** Options type for VercelVariable — replaces Pulumi's native `provider` field. */
type VercelVariableOptions = Omit<
	pulumi.ComponentResourceOptions,
	"provider"
> & {
	/** Vercel authentication context. */
	provider: VercelProvider;

	/**
	 * VercelProject resource to source the project ID from.
	 * When provided, `args.projectId` is optional and ignored if both are given.
	 */
	project?: VercelProject;
};

/** Args for VercelVariable. */
export interface VercelVariableArgs {
	/**
	 * Vercel project ID.
	 * Required when `opts.project` is not provided.
	 */
	projectId?: pulumi.Input<string>;

	/** Key-value map of environment variable names to their values. */
	variables: pulumi.Input<Record<string, pulumi.Input<string>>>;
}

/**
 * Manages Vercel project environment variables as a batch with drift detection.
 *
 * @example
 * ```typescript
 * new VercelVariable("nexus-vars", {
 *   projectId: vercelProject.id,
 *   variables: {
 *     NEXT_PUBLIC_API_URL: meshUrl,
 *   },
 * }, { provider });
 * ```
 */
export class VercelVariable extends pulumi.ComponentResource {
	/** SHA-256 hash of all key-value pairs. Use as a deploy trigger for drift-aware redeployment. */
	public readonly contentHash: pulumi.Output<string>;

	constructor(
		name: string,
		args: VercelVariableArgs,
		opts: VercelVariableOptions,
	) {
		const { provider, project, ...pulumiOpts } = opts;

		super("infracraft:vercel:Variable", name, {}, pulumiOpts);

		const projectId = project
			? project.id
			: (args.projectId as pulumi.Input<string>);

		if (!projectId) {
			throw new Error(
				"VercelVariable: either `args.projectId` or `opts.project` must be provided",
			);
		}

		const resource = new VercelVariableResource(
			`${name}-resource`,
			{
				token: provider.token,
				teamId: provider.teamId,
				projectId,
				variables: args.variables,
			},
			{ parent: this },
		);

		this.contentHash = resource.contentHash;

		this.registerOutputs({ contentHash: this.contentHash });
	}
}
