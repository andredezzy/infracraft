import * as pulumi from "@pulumi/pulumi";
import { isResolvedString } from "../dynamic/is-resolved-string";
import { resolveCredential } from "../dynamic/resolve-credential";
import { isGraphqlNotFoundError } from "../http/is-graphql-not-found-error";
import { Client } from "./client";
import type { Project } from "./project";
import type { Provider } from "./provider";

/** Resolved inputs for the Railway environment dynamic provider. */
interface EnvironmentInputs {
	/** Railway API bearer token. Absent when `tokenEnvVar` is used instead. */
	token?: string;

	/** Env var name resolved to the token when `token` is absent (see `ProviderArgs.tokenEnvVar`). */
	tokenEnvVar?: string;

	/** Railway project UUID. */
	projectId: string;

	/** Environment display name (e.g. `"production"`, `"staging"`). */
	name: string;

	/** Name of an existing environment to fork from when creating a new one. */
	source?: string;
}

/** Persisted state for the Railway environment. */
interface EnvironmentOutputs extends EnvironmentInputs {
	/** Railway-assigned environment UUID. */
	environmentId: string;
}

const ENVIRONMENT_CREATE_MUTATION = `
  mutation EnvironmentCreate($input: EnvironmentCreateInput!) {
    environmentCreate(input: $input) {
      id
      name
    }
  }
`;

const ENVIRONMENT_DELETE_MUTATION = `
  mutation($id: String!) { environmentDelete(id: $id) }
`;

const PROJECT_ENVIRONMENTS_QUERY = `
  query($projectId: String!) {
    project(id: $projectId) {
      environments {
        edges {
          node {
            id
            name
          }
        }
      }
    }
  }
`;

/**
 * Queries a project's environments and resolves the ID for the given name.
 */
async function findEnvironmentId(
	client: Client,
	projectId: string,
	name: string,
): Promise<string | undefined> {
	const result = await client.query<{
		project: {
			environments: {
				edges: Array<{ node: { id: string; name: string } }>;
			};
		};
	}>(PROJECT_ENVIRONMENTS_QUERY, { projectId });

	const match = result.project.environments.edges.find(
		(edge) => edge.node.name === name,
	);

	return match?.node.id;
}

/**
 * Dynamic provider that resolves or creates a Railway environment by name.
 *
 * @internal Exported only for unit testing; not part of the public API surface.
 */
export class EnvironmentResourceProvider
	implements pulumi.dynamic.ResourceProvider
{
	/**
	 * Validates inputs at plan time. An empty environment name would otherwise
	 * fail deep inside the Railway API call — and never match on the adopt lookup.
	 */
	async check(
		_olds: EnvironmentInputs,
		news: EnvironmentInputs,
	): Promise<pulumi.dynamic.CheckResult<EnvironmentInputs>> {
		const failures: pulumi.dynamic.CheckFailure[] = [];

		if (isResolvedString(news.name) && news.name.trim().length === 0) {
			failures.push({
				property: "name",
				reason: 'name must be a non-empty environment name (e.g. "production")',
			});
		}

		return { inputs: news, failures };
	}

	/**
	 * Adopts an existing Railway environment when found by name, or creates a new
	 * one (optionally forked from a source environment) when not found.
	 *
	 * @param inputs Resolved provider inputs including token, projectId, name, and optional source.
	 * @returns Pulumi dynamic create result with the environment UUID as the resource ID.
	 * @throws {Error} When `source` is provided but cannot be resolved to an environment ID.
	 */
	async create(
		inputs: EnvironmentInputs,
	): Promise<pulumi.dynamic.CreateResult> {
		const client = new Client(
			resolveCredential(inputs.token, inputs.tokenEnvVar),
		);

		let environmentId = await findEnvironmentId(
			client,
			inputs.projectId,
			inputs.name,
		);

		if (environmentId) {
			pulumi.log.info(
				`Adopting existing Railway environment "${inputs.name}" (${environmentId})`,
			);
		} else {
			let sourceEnvironmentId: string | undefined;

			if (inputs.source) {
				sourceEnvironmentId = await findEnvironmentId(
					client,
					inputs.projectId,
					inputs.source,
				);

				if (!sourceEnvironmentId) {
					throw new Error(
						`Railway source environment "${inputs.source}" not found in project ${inputs.projectId}`,
					);
				}
			}

			const result = await client.query<{
				environmentCreate: { id: string; name: string };
			}>(ENVIRONMENT_CREATE_MUTATION, {
				input: {
					projectId: inputs.projectId,
					name: inputs.name,
					// skipInitialDeploys: hold deploys so a forked env doesn't run with inherited
					// source/production variables before our Variable resources overwrite them.
					skipInitialDeploys: true,
					...(sourceEnvironmentId ? { sourceEnvironmentId } : {}),
				},
			});

			environmentId = result.environmentCreate.id;

			pulumi.log.info(
				`Created Railway environment "${inputs.name}" (${environmentId})`,
			);
		}

		const outs: EnvironmentOutputs = { ...inputs, environmentId };

		return { id: environmentId, outs };
	}

	async read(
		_id: string,
		props: EnvironmentOutputs,
	): Promise<pulumi.dynamic.ReadResult> {
		const client = new Client(
			resolveCredential(props.token, props.tokenEnvVar),
		);

		const environmentId = await findEnvironmentId(
			client,
			props.projectId,
			props.name,
		);

		if (!environmentId) {
			// Resource gone → blank id lets refresh reconcile the deletion.
			return {};
		}

		return { id: environmentId, props: { ...props, environmentId } };
	}

	/**
	 * Deletes the environment (which cascades its per-environment service instances).
	 * Protection of the shared production environment is the consumer's responsibility
	 * via the `protect` resource option, not provider logic.
	 */
	async delete(_id: string, props: EnvironmentOutputs): Promise<void> {
		const client = new Client(
			resolveCredential(props.token, props.tokenEnvVar),
		);

		try {
			await client.query(ENVIRONMENT_DELETE_MUTATION, {
				id: props.environmentId,
			});

			pulumi.log.info(
				`Deleted Railway environment "${props.name}" (${props.environmentId})`,
			);
		} catch (error) {
			// Already gone — deletion is idempotent.
			if (isGraphqlNotFoundError(error)) {
				pulumi.log.warn(`Railway environment "${props.name}" already deleted`);

				return;
			}

			throw error;
		}
	}

	async diff(
		_id: string,
		olds: EnvironmentOutputs,
		news: EnvironmentInputs,
	): Promise<pulumi.dynamic.DiffResult> {
		const replaces: string[] = [];

		if (olds.projectId !== news.projectId) {
			replaces.push("projectId");
		}

		if (olds.name !== news.name) {
			replaces.push("name");
		}

		return {
			changes: replaces.length > 0,
			replaces,
			deleteBeforeReplace: true,
		};
	}
}

/** Internal dynamic resource — not part of the public API. */
class EnvironmentResource extends pulumi.dynamic.Resource {
	public declare readonly environmentId: pulumi.Output<string>;

	constructor(
		name: string,
		args: {
			token?: pulumi.Input<string>;
			tokenEnvVar?: pulumi.Input<string>;
			projectId: pulumi.Input<string>;
			name: pulumi.Input<string>;
			source?: pulumi.Input<string>;
		},
		opts?: pulumi.CustomResourceOptions,
	) {
		super(
			new EnvironmentResourceProvider(),
			name,
			{
				...args,
				environmentId: undefined,
			},
			// The API token flows into dynamic-provider state with the outputs — mark it secret there.
			{ ...opts, additionalSecretOutputs: ["token"] },
		);
	}
}

/** Options type for Environment — replaces Pulumi's native `provider` field. */
type EnvironmentOptions = Omit<pulumi.ComponentResourceOptions, "provider"> & {
	/** Railway authentication context. */
	provider: Provider;

	/** Railway project context to resolve the environment from. */
	project: Project;
};

/** Args for Environment. */
export interface EnvironmentArgs {
	/** Environment display name (e.g. `"production"`, `"staging"`). */
	name: pulumi.Input<string>;

	/**
	 * Name of an existing environment to fork from when this environment is created.
	 * Evaluated only at creation time — changing `source` after the environment exists
	 * has no effect (an existing environment is never re-forked).
	 * Maps to `EnvironmentCreateInput.sourceEnvironmentId` after name → ID resolution.
	 */
	source?: pulumi.Input<string>;
}

/**
 * Resolves or creates a Railway environment by name within a project.
 *
 * When the named environment already exists it is adopted (no mutation).
 * When it does not exist it is created — optionally forked from a source
 * environment so the new env inherits service instances and variables.
 *
 * @example
 * ```typescript
 * // Adopt or create "production" (no source)
 * const production = new railway.Environment("production", {
 *   name: "production",
 * }, { provider, project });
 *
 * // Adopt or create "staging", forked from "production"
 * const staging = new railway.Environment("staging", {
 *   name: "staging",
 *   source: "production",
 * }, { provider, project });
 *
 * // Use environmentId downstream
 * const service = new railway.Service("api", { name: "api" }, {
 *   provider, project, environment: staging,
 * });
 * ```
 */
export class Environment extends pulumi.ComponentResource {
	/** Railway environment UUID. */
	public readonly id: pulumi.Output<string>;

	constructor(name: string, args: EnvironmentArgs, opts: EnvironmentOptions) {
		const { provider, project, ...pulumiOpts } = opts;

		super("infracraft:railway:Environment", name, {}, pulumiOpts);

		const resource = new EnvironmentResource(
			`${name}-resource`,
			{
				token: provider.token,
				tokenEnvVar: provider.tokenEnvVar,
				projectId: project.id,
				name: args.name,
				source: args.source,
			},
			// Forward the consumer's resource options (e.g. `retainOnDelete`) to the
			// underlying resource — Pulumi auto-inherits provider/protect from the
			// parent component, but not everything else.
			pulumi.mergeOptions(pulumiOpts, { parent: this }),
		);

		this.id = resource.environmentId;

		this.registerOutputs({ id: this.id });
	}
}
