import * as pulumi from "@pulumi/pulumi";
import { RailwayClient } from "./client";
import type { RailwayEnvironment } from "./environment";
import type { RailwayProject } from "./project";
import type { RailwayProvider } from "./provider";
import type { RailwayService } from "./service";

/** Resolved inputs for the Railway variable dynamic provider. */
interface RailwayVariableInputs {
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
 *
 * @internal Exported only for unit testing; not part of the public API surface.
 */
export class RailwayVariableResourceProvider
	implements pulumi.dynamic.ResourceProvider
{
	/**
	 * Creates all variables on the target service via batch upsert.
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
	 */
	async read(
		id: string,
		props: RailwayVariableOutputs,
	): Promise<pulumi.dynamic.ReadResult> {
		return { id, props };
	}

	/**
	 * Deletes all variables one by one. Silently succeeds if already deleted.
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

/** Internal dynamic resource — not part of the public API. */
class RailwayVariableResource extends pulumi.dynamic.Resource {
	constructor(
		name: string,
		args: {
			token: pulumi.Input<string>;
			projectId: pulumi.Input<string>;
			serviceId: pulumi.Input<string>;
			environmentId: pulumi.Input<string>;
			variables: pulumi.Input<Record<string, pulumi.Input<string>>>;
		},
		opts?: pulumi.CustomResourceOptions,
	) {
		super(
			new RailwayVariableResourceProvider(),
			name,
			{ ...args },
			// The API token flows into dynamic-provider state with the outputs — mark it secret there.
			{ ...opts, additionalSecretOutputs: ["token"] },
		);
	}
}

/** Options type for RailwayVariable — replaces Pulumi's native `provider` field. */
type RailwayVariableOptions = Omit<
	pulumi.ComponentResourceOptions,
	"provider"
> & {
	/** Railway authentication context. */
	provider: RailwayProvider;

	/** Railway project context. */
	project: RailwayProject;

	/** Railway environment context. */
	environment: RailwayEnvironment;

	/** Railway service context. */
	service: RailwayService;
};

/** Args for RailwayVariable. */
export interface RailwayVariableArgs {
	/** Key-value map of environment variable names to their values. */
	variables: pulumi.Input<Record<string, pulumi.Input<string>>>;
}

/**
 * Manages Railway service environment variables with `skipDeploys` to prevent snapshot errors.
 *
 * @example
 * ```typescript
 * new RailwayVariable("api-vars", {
 *   variables: { DATABASE_URL: databaseUrl, NODE_ENV: "production" },
 * }, { provider, project, environment, service });
 * ```
 */
export class RailwayVariable extends pulumi.ComponentResource {
	constructor(
		name: string,
		args: RailwayVariableArgs,
		opts: RailwayVariableOptions,
	) {
		const { provider, project, environment, service, ...pulumiOpts } = opts;

		super("infracraft:railway:Variable", name, {}, pulumiOpts);

		new RailwayVariableResource(
			`${name}-resource`,
			{
				token: provider.token,
				projectId: project.id,
				serviceId: service.id,
				environmentId: environment.id,
				variables: args.variables,
			},
			{ parent: this },
		);

		this.registerOutputs({});
	}
}
