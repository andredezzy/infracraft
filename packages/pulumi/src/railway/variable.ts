import * as pulumi from "@pulumi/pulumi";
import { RailwayClient } from "./client.js";

/** Resolved inputs for the Railway variable dynamic provider. */
export interface RailwayVariableInputs {
	/** Railway API bearer token. */
	token: string;

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
interface RailwayVariableOutputs extends RailwayVariableInputs {}

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

/**
 * Dynamic provider implementing CRUD for Railway service environment variables.
 *
 * Uses `skipDeploys: true` on all upsert operations to prevent
 * "Cannot redeploy without snapshot" errors on newly created services.
 */
class RailwayVariableProvider implements pulumi.dynamic.ResourceProvider {
	/**
	 * Creates all variables on the target service via batch upsert.
	 *
	 * @param inputs Resolved variable configuration
	 * @returns Composite ID in the form `{serviceId}:variables`
	 */
	async create(
		inputs: RailwayVariableInputs,
	): Promise<pulumi.dynamic.CreateResult> {
		const client = new RailwayClient(inputs.token);

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
	 *
	 * @param _id Current resource ID (unused)
	 * @param olds Previous persisted variable state
	 * @param news New desired variable configuration
	 * @returns Updated outputs
	 */
	async update(
		_id: string,
		olds: RailwayVariableOutputs,
		news: RailwayVariableInputs,
	): Promise<pulumi.dynamic.UpdateResult> {
		const client = new RailwayClient(news.token);

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
	 * Reads current state for `pulumi refresh`.
	 * Returns persisted props since Railway has no single-call variable read API.
	 *
	 * @param id Current resource ID
	 * @param props Last known persisted state
	 * @returns Unchanged resource ID and properties
	 */
	async read(
		id: string,
		props: RailwayVariableOutputs,
	): Promise<pulumi.dynamic.ReadResult> {
		return { id, props };
	}

	/**
	 * Deletes all variables one by one. Silently succeeds if already deleted.
	 *
	 * @param _id Current resource ID (unused)
	 * @param props Last known persisted state
	 */
	async delete(_id: string, props: RailwayVariableOutputs): Promise<void> {
		const client = new RailwayClient(props.token);

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
			} catch {
				pulumi.log.warn(
					`Failed to delete Railway variable "${key}" (may already be deleted)`,
				);
			}
		}
	}

	/**
	 * Compares old and new variable maps by key set and value equality.
	 *
	 * @param _id Current resource ID (unused)
	 * @param olds Previous persisted state
	 * @param news New desired configuration
	 * @returns Whether any keys or values changed
	 */
	async diff(
		_id: string,
		olds: RailwayVariableOutputs,
		news: RailwayVariableInputs,
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
 * Manages Railway service environment variables with `skipDeploys` to prevent snapshot errors.
 *
 * Handles batch upsert on create/update and per-key deletion when variables are removed.
 * All mutations use `skipDeploys: true` to avoid triggering deploys before the service
 * has a build snapshot.
 *
 * @example
 * ```typescript
 * new RailwayVariable("railway-variable-api", {
 *   token: project.projectToken,
 *   projectId: project.projectId,
 *   serviceId: service.serviceId,
 *   environmentId: project.productionEnvironmentId,
 *   variables: { DATABASE_URL: databaseUrl, NODE_ENV: "production" },
 * });
 * ```
 */
export class RailwayVariable extends pulumi.dynamic.Resource {
	/**
	 * @param name Pulumi resource name (logical identifier in state)
	 * @param args Variable configuration inputs
	 * @param opts Standard Pulumi resource options (e.g. `dependsOn`, `parent`)
	 */
	constructor(
		name: string,
		args: {
			/** Railway API bearer token. */
			token: pulumi.Input<string>;

			/** Railway project UUID. */
			projectId: pulumi.Input<string>;

			/** Railway service UUID that owns these variables. */
			serviceId: pulumi.Input<string>;

			/** Railway environment UUID (e.g. production). */
			environmentId: pulumi.Input<string>;

			/** Key-value map of environment variable names to their values. */
			variables: pulumi.Input<Record<string, pulumi.Input<string>>>;
		},
		opts?: pulumi.CustomResourceOptions,
	) {
		super(new RailwayVariableProvider(), name, { ...args }, opts);
	}
}
