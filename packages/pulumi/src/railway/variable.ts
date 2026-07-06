import * as pulumi from "@pulumi/pulumi";
import { resolveCredential } from "../dynamic/resolve-credential";
import { isGraphqlNotFoundError } from "../http/is-graphql-not-found-error";
import { Client } from "./client";
import type { Environment } from "./environment";
import type { Project } from "./project";
import type { Provider } from "./provider";
import type { Service } from "./service";

/** Resolved inputs for the Railway variable dynamic provider. */
interface VariableInputs {
	/** Railway API bearer token. Absent when `tokenEnvVar` is used instead. */
	token?: string;

	/** Env var name resolved to the token when `token` is absent (see `ProviderArgs.tokenEnvVar`). */
	tokenEnvVar?: string;

	/** Railway project UUID. */
	projectId: string;

	/** Railway service UUID that owns these variables. */
	serviceId: string;

	/** Railway environment UUID (e.g. production). */
	environmentId: string;

	/** Key-value map of environment variable names to their values. */
	variables: Record<string, string>;
}

/** Persisted state for Railway variables (identical to inputs). */
interface VariableOutputs extends VariableInputs {}

const VARIABLE_UPSERT = `
  mutation($input: VariableCollectionUpsertInput!) {
    variableCollectionUpsert(input: $input)
  }
`;

const VARIABLE_DELETE = `
  mutation($input: VariableDeleteInput!) {
    variableDelete(input: $input)
  }
`;

const VARIABLES_QUERY = `
  query($projectId: String!, $environmentId: String!, $serviceId: String) {
    variables(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId)
  }
`;

/** Railway API response from the `variables` query — a flat key-value map. */
interface VariablesResponse {
	variables: Record<string, string>;
}

/**
 * Dynamic provider implementing CRUD for Railway service environment variables.
 *
 * Uses `skipDeploys: true` on all upsert operations to prevent
 * "Cannot redeploy without snapshot" errors on newly created services.
 *
 * @internal Exported only for unit testing; not part of the public API surface.
 */
export class VariableResourceProvider
	implements pulumi.dynamic.ResourceProvider
{
	/**
	 * Creates all variables on the target service via batch upsert.
	 */
	async create(inputs: VariableInputs): Promise<pulumi.dynamic.CreateResult> {
		const client = new Client(
			resolveCredential(inputs.token, inputs.tokenEnvVar),
		);

		await client.query(VARIABLE_UPSERT, {
			input: {
				projectId: inputs.projectId,
				serviceId: inputs.serviceId,
				environmentId: inputs.environmentId,
				variables: inputs.variables,
				skipDeploys: true,
			},
		});

		const id = `${inputs.serviceId}:variables`;

		return { id, outs: inputs };
	}

	/**
	 * Updates variables by deleting removed keys individually, then upserting the rest.
	 */
	async update(
		_id: string,
		olds: VariableOutputs,
		news: VariableInputs,
	): Promise<pulumi.dynamic.UpdateResult> {
		const client = new Client(resolveCredential(news.token, news.tokenEnvVar));

		const removedKeys = Object.keys(olds.variables).filter(
			(key) => !(key in news.variables),
		);

		for (const key of removedKeys) {
			await client.query(VARIABLE_DELETE, {
				input: {
					projectId: news.projectId,
					serviceId: news.serviceId,
					environmentId: news.environmentId,
					name: key,
				},
			});
		}

		if (Object.keys(news.variables).length > 0) {
			await client.query(VARIABLE_UPSERT, {
				input: {
					projectId: news.projectId,
					serviceId: news.serviceId,
					environmentId: news.environmentId,
					variables: news.variables,
					skipDeploys: true,
				},
			});
		}

		return { outs: news };
	}

	/**
	 * Reads current state for `pulumi refresh` via Railway's `variables` query
	 * (scoped by projectId/environmentId/serviceId, returning a flat key-value map).
	 */
	async read(
		id: string,
		props: VariableOutputs,
	): Promise<pulumi.dynamic.ReadResult> {
		const client = new Client(
			resolveCredential(props.token, props.tokenEnvVar),
		);

		try {
			const result = await client.query<VariablesResponse>(VARIABLES_QUERY, {
				projectId: props.projectId,
				environmentId: props.environmentId,
				serviceId: props.serviceId,
			});

			return {
				id,
				props: { ...props, variables: result.variables },
			};
		} catch (error) {
			// Resource (service/environment/project) gone → blank id lets refresh reconcile the deletion.
			if (isGraphqlNotFoundError(error)) {
				return {};
			}

			throw error;
		}
	}

	/**
	 * Deletes all variables one by one. Silently succeeds if already deleted.
	 */
	async delete(_id: string, props: VariableOutputs): Promise<void> {
		const client = new Client(
			resolveCredential(props.token, props.tokenEnvVar),
		);

		for (const key of Object.keys(props.variables)) {
			try {
				await client.query(VARIABLE_DELETE, {
					input: {
						projectId: props.projectId,
						serviceId: props.serviceId,
						environmentId: props.environmentId,
						name: key,
					},
				});
			} catch (error) {
				// Already gone — deletion is idempotent.
				if (isGraphqlNotFoundError(error)) {
					pulumi.log.warn(`Railway variable "${key}" already deleted`);

					continue;
				}

				throw error;
			}
		}
	}

	/**
	 * Compares old and new variable maps by key set and value equality.
	 */
	async diff(
		_id: string,
		olds: VariableOutputs,
		news: VariableInputs,
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
class VariableResource extends pulumi.dynamic.Resource {
	constructor(
		name: string,
		args: {
			token?: pulumi.Input<string>;
			tokenEnvVar?: pulumi.Input<string>;
			projectId: pulumi.Input<string>;
			serviceId: pulumi.Input<string>;
			environmentId: pulumi.Input<string>;
			variables: pulumi.Input<Record<string, pulumi.Input<string>>>;
		},
		opts?: pulumi.CustomResourceOptions,
	) {
		super(
			new VariableResourceProvider(),
			name,
			{ ...args },
			// The API token AND the variable values themselves flow into
			// dynamic-provider state with the outputs — mark both secret there.
			{ ...opts, additionalSecretOutputs: ["token", "variables"] },
		);
	}
}

/** Options type for Variable — replaces Pulumi's native `provider` field. */
type VariableOptions = Omit<pulumi.ComponentResourceOptions, "provider"> & {
	/** Railway authentication context. */
	provider: Provider;

	/** Railway project context. */
	project: Project;

	/** Railway environment context. */
	environment: Environment;

	/** Railway service context. */
	service: Service;
};

/** Args for Variable. */
export interface VariableArgs {
	/** Key-value map of environment variable names to their values. */
	variables: pulumi.Input<Record<string, pulumi.Input<string>>>;
}

/**
 * Manages Railway service environment variables with `skipDeploys` to prevent snapshot errors.
 *
 * @example
 * ```typescript
 * new railway.Variable("api-vars", {
 *   variables: { DATABASE_URL: databaseUrl, NODE_ENV: "production" },
 * }, { provider, project, environment, service });
 * ```
 */
export class Variable extends pulumi.ComponentResource {
	constructor(name: string, args: VariableArgs, opts: VariableOptions) {
		const { provider, project, environment, service, ...pulumiOpts } = opts;

		super("infracraft:railway:Variable", name, {}, pulumiOpts);

		new VariableResource(
			`${name}-resource`,
			{
				token: provider.token,
				tokenEnvVar: provider.tokenEnvVar,
				projectId: project.id,
				serviceId: service.id,
				environmentId: environment.id,
				variables: args.variables,
			},
			// Forward the consumer's resource options (e.g. `retainOnDelete`) to the
			// underlying resource — Pulumi auto-inherits provider/protect from the
			// parent component, but not everything else.
			pulumi.mergeOptions(pulumiOpts, { parent: this }),
		);

		this.registerOutputs({});
	}
}
