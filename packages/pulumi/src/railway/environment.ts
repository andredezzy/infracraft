import * as pulumi from "@pulumi/pulumi";
import { RailwayClient } from "./client";
import type { RailwayProject } from "./project";
import type { RailwayProvider } from "./provider";

/** Resolved inputs for the Railway environment dynamic provider. */
interface RailwayEnvironmentInputs {
	/** Railway API bearer token. */
	token: string;

	/** Railway project UUID. */
	projectId: string;

	/** Environment display name (e.g. `"production"`, `"staging"`). */
	name: string;
}

/** Persisted state for the Railway environment. */
interface RailwayEnvironmentOutputs extends RailwayEnvironmentInputs {
	/** Railway-assigned environment UUID. */
	environmentId: string;
}

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
	client: RailwayClient,
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
 * Dynamic provider that resolves a Railway environment UUID by name from a project.
 */
class RailwayEnvironmentResourceProvider
	implements pulumi.dynamic.ResourceProvider
{
	async create(
		inputs: RailwayEnvironmentInputs,
	): Promise<pulumi.dynamic.CreateResult> {
		const client = new RailwayClient(inputs.token);

		const environmentId = await findEnvironmentId(
			client,
			inputs.projectId,
			inputs.name,
		);

		if (!environmentId) {
			throw new Error(
				`Railway environment "${inputs.name}" not found in project ${inputs.projectId}`,
			);
		}

		const outs: RailwayEnvironmentOutputs = { ...inputs, environmentId };

		return { id: environmentId, outs };
	}

	async read(
		_id: string,
		props: RailwayEnvironmentOutputs,
	): Promise<pulumi.dynamic.ReadResult> {
		const client = new RailwayClient(props.token);

		const environmentId = await findEnvironmentId(
			client,
			props.projectId,
			props.name,
		);

		if (!environmentId) {
			throw new Error(
				`Railway environment "${props.name}" not found during refresh`,
			);
		}

		return { id: environmentId, props: { ...props, environmentId } };
	}

	async update(
		_id: string,
		_olds: RailwayEnvironmentOutputs,
		news: RailwayEnvironmentInputs,
	): Promise<pulumi.dynamic.UpdateResult> {
		const client = new RailwayClient(news.token);

		const environmentId = await findEnvironmentId(
			client,
			news.projectId,
			news.name,
		);

		if (!environmentId) {
			throw new Error(
				`Railway environment "${news.name}" not found in project ${news.projectId}`,
			);
		}

		return { outs: { ...news, environmentId } };
	}

	async delete(): Promise<void> {
		pulumi.log.warn(
			"Railway environment deletion skipped — environments are not deleted by Pulumi",
		);
	}

	async diff(
		_id: string,
		olds: RailwayEnvironmentOutputs,
		news: RailwayEnvironmentInputs,
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
class RailwayEnvironmentResource extends pulumi.dynamic.Resource {
	public declare readonly environmentId: pulumi.Output<string>;

	constructor(
		name: string,
		args: {
			token: pulumi.Input<string>;
			projectId: pulumi.Input<string>;
			name: pulumi.Input<string>;
		},
		opts?: pulumi.CustomResourceOptions,
	) {
		super(
			new RailwayEnvironmentResourceProvider(),
			name,
			{
				...args,
				environmentId: undefined,
			},
			opts,
		);
	}
}

/** Options type for RailwayEnvironment — replaces Pulumi's native `provider` field. */
type RailwayEnvironmentOptions = Omit<
	pulumi.ComponentResourceOptions,
	"provider"
> & {
	/** Railway authentication context. */
	provider: RailwayProvider;

	/** Railway project context to resolve the environment from. */
	project: RailwayProject;
};

/** Args for RailwayEnvironment. */
export interface RailwayEnvironmentArgs {
	/** Environment display name (e.g. `"production"`, `"staging"`). */
	name: pulumi.Input<string>;
}

/**
 * Resolves a Railway environment UUID by name from a project.
 *
 * @example
 * ```typescript
 * const environment = new RailwayEnvironment("production", {
 *   name: "production",
 * }, { provider, project });
 *
 * // Use environmentId downstream
 * const service = new RailwayService("api", { name: "api" }, {
 *   provider, project, environment,
 * });
 * ```
 */
export class RailwayEnvironment extends pulumi.ComponentResource {
	/** Railway environment UUID. */
	public readonly id: pulumi.Output<string>;

	constructor(
		name: string,
		args: RailwayEnvironmentArgs,
		opts: RailwayEnvironmentOptions,
	) {
		const { provider, project, ...pulumiOpts } = opts;

		super("infracraft:railway:Environment", name, {}, pulumiOpts);

		const resource = new RailwayEnvironmentResource(
			`${name}-resource`,
			{
				token: provider.token,
				projectId: project.id,
				name: args.name,
			},
			{ parent: this },
		);

		this.id = resource.environmentId;

		this.registerOutputs({ id: this.id });
	}
}
