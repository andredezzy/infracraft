import * as pulumi from "@pulumi/pulumi";
import { resolveCredential } from "../dynamic/resolve-credential";
import { ApiNotFoundError } from "../errors/api-not-found-error";
import { VercelClient } from "./client";
import type { VercelProject } from "./project";
import type { VercelProvider } from "./provider";

/** Resolved inputs for the Vercel variable dynamic provider. */
interface VercelVariableInputs {
	/** Vercel API bearer token. Absent when `tokenEnvVar` is used instead. */
	token?: string;

	/** Env var name resolved to the token when `token` is absent (see `VercelProviderArgs.tokenEnvVar`). */
	tokenEnvVar?: string;

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
 * Creates a single Vercel env var targeting all environments.
 * An already-existing key (ENV_CONFLICT) is updated in place instead.
 */
async function createEnvVar(
	client: VercelClient,
	projectId: string,
	key: string,
	value: string,
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
			pulumi.log.info(
				`Vercel env var "${key}" already exists, will update instead`,
			);

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

/**
 * Deletes a single Vercel env var. Tolerates 404 (already gone) —
 * deletion is idempotent.
 */
async function deleteEnvVar(
	client: VercelClient,
	projectId: string,
	envId: string,
): Promise<void> {
	try {
		await client.delete(`/v9/projects/${projectId}/env/${envId}`);
	} catch (error) {
		if (!(error instanceof ApiNotFoundError)) {
			throw error;
		}
	}
}

/**
 * Dynamic provider implementing CRUD for Vercel project environment variables.
 *
 * @internal Exported only for unit testing; not part of the public API surface.
 */
export class VercelVariableResourceProvider
	implements pulumi.dynamic.ResourceProvider
{
	async create(
		inputs: VercelVariableInputs,
	): Promise<pulumi.dynamic.CreateResult> {
		const client = new VercelClient(
			resolveCredential(inputs.token, inputs.tokenEnvVar),
			inputs.teamId,
		);

		const envIds: Record<string, string> = {};

		for (const [key, value] of Object.entries(inputs.variables)) {
			const result = await createEnvVar(client, inputs.projectId, key, value);

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
		const client = new VercelClient(
			resolveCredential(news.token, news.tokenEnvVar),
			news.teamId,
		);

		const envIds = { ...olds.envIds };

		const removedKeys = Object.keys(olds.variables).filter(
			(key) => !(key in news.variables),
		);

		for (const key of removedKeys) {
			const envId = envIds[key];

			if (envId) {
				try {
					await deleteEnvVar(client, news.projectId, envId);
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
				await updateEnvVar(client, news.projectId, existingId, value);
			} else if (!existingId) {
				const result = await createEnvVar(client, news.projectId, key, value);

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
		const client = new VercelClient(
			resolveCredential(props.token, props.tokenEnvVar),
			props.teamId,
		);

		const actual = await fetchEnvVars(client, props.projectId);

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
		const client = new VercelClient(
			resolveCredential(props.token, props.tokenEnvVar),
			props.teamId,
		);

		for (const [key, envId] of Object.entries(props.envIds)) {
			try {
				await deleteEnvVar(client, props.projectId, envId);
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
			token?: pulumi.Input<string>;
			tokenEnvVar?: pulumi.Input<string>;
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
			// The API token flows into dynamic-provider state with the outputs — mark it secret there.
			{ ...opts, additionalSecretOutputs: ["token"] },
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
				tokenEnvVar: provider.tokenEnvVar,
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
