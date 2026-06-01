import * as pulumi from "@pulumi/pulumi";
import { RailwayClient } from "./client";
import type { RailwayEnvironment } from "./environment";
import type { RailwayProject } from "./project";
import type { RailwayProvider } from "./provider";

/** Resolved inputs for the Railway project token dynamic provider. */
interface RailwayProjectTokenInputs {
	/** Railway API bearer token (account-scoped, used for API calls). */
	token: string;

	/** Railway project UUID. */
	projectId: string;

	/** Railway environment UUID this deploy token is scoped to. */
	environmentId: string;

	/** Distinct token name, e.g. `"pulumi-staging"`. Must be unique per environment. */
	name: string;
}

/** Persisted state for the Railway project token. */
interface RailwayProjectTokenOutputs extends RailwayProjectTokenInputs {
	/** Minted deploy token secret value. */
	value: string;

	/** Railway-assigned token UUID (used for clean teardown on delete). */
	tokenId: string;
}

const PROJECT_TOKENS_QUERY = `
  query($projectId: String!) {
    projectTokens(projectId: $projectId) {
      edges { node { id name } }
    }
  }
`;

const PROJECT_TOKEN_CREATE = `
  mutation($input: ProjectTokenCreateInput!) {
    projectTokenCreate(input: $input)
  }
`;

const PROJECT_TOKEN_DELETE = `
  mutation($id: String!) { projectTokenDelete(id: $id) }
`;

/**
 * Dynamic provider that mints a Railway environment-scoped deploy token.
 *
 * On create, it deletes any existing tokens with the same name (stale tokens
 * from previous runs), mints a fresh one scoped to the target environment, then
 * re-lists tokens to capture the Railway-assigned ID for later teardown.
 *
 * @internal Exported only for unit testing; not part of the public API surface.
 */
export class RailwayProjectTokenResourceProvider
	implements pulumi.dynamic.ResourceProvider
{
	/**
	 * Deletes stale same-named tokens, mints a new environment-scoped token,
	 * and captures its ID via a follow-up list query.
	 *
	 * @param inputs Resolved provider inputs.
	 * @returns Pulumi dynamic create result with `value` (secret) and `tokenId`.
	 */
	async create(
		inputs: RailwayProjectTokenInputs,
	): Promise<pulumi.dynamic.CreateResult> {
		const client = new RailwayClient(inputs.token);

		const tokensResult = await client.query<{
			projectTokens: {
				edges: Array<{ node: { id: string; name: string } }>;
			};
		}>(PROJECT_TOKENS_QUERY, { projectId: inputs.projectId });

		const stale = tokensResult.projectTokens.edges.filter(
			(edge) => edge.node.name === inputs.name,
		);

		for (const entry of stale) {
			await client.query(PROJECT_TOKEN_DELETE, { id: entry.node.id });
		}

		const createResult = await client.query<{ projectTokenCreate: string }>(
			PROJECT_TOKEN_CREATE,
			{
				input: {
					projectId: inputs.projectId,
					environmentId: inputs.environmentId,
					name: inputs.name,
				},
			},
		);

		const value = createResult.projectTokenCreate;

		// Re-list tokens to capture the Railway-assigned ID: the create mutation
		// returns only the token value, not its UUID.
		const refreshResult = await client.query<{
			projectTokens: {
				edges: Array<{ node: { id: string; name: string } }>;
			};
		}>(PROJECT_TOKENS_QUERY, { projectId: inputs.projectId });

		// After the delete sweep above, exactly one token with this name exists (the one we just
		// created). Resolve its id from the re-list so delete() can revoke it later.
		const found = refreshResult.projectTokens.edges.find(
			(edge) => edge.node.name === inputs.name,
		);

		if (!found) {
			throw new Error(
				`Could not resolve token id for newly created token "${inputs.name}" in project ${inputs.projectId}`,
			);
		}

		const tokenId = found.node.id;

		const outs: RailwayProjectTokenOutputs = {
			...inputs,
			value,
			tokenId,
		};

		return { id: `${inputs.projectId}:${inputs.name}`, outs };
	}

	/**
	 * Pass-through read — the token value is a write-once secret that Railway
	 * never re-exposes via API, so the stored state is the only source of truth.
	 *
	 * @param id Resource ID.
	 * @param props Currently stored outputs.
	 */
	async read(
		id: string,
		props: RailwayProjectTokenOutputs,
	): Promise<pulumi.dynamic.ReadResult> {
		return { id, props };
	}

	/**
	 * Deletes the Railway token by its stored UUID for clean teardown.
	 *
	 * @param _id Resource ID (unused).
	 * @param props Currently stored outputs containing the tokenId.
	 */
	async delete(_id: string, props: RailwayProjectTokenOutputs): Promise<void> {
		if (props.tokenId) {
			const client = new RailwayClient(props.token);

			await client.query(PROJECT_TOKEN_DELETE, { id: props.tokenId });
		}
	}

	/**
	 * Triggers replacement when the project, environment, or token name changes.
	 *
	 * @param _id Resource ID (unused).
	 * @param olds Previously stored outputs.
	 * @param news Newly resolved inputs.
	 */
	async diff(
		_id: string,
		olds: RailwayProjectTokenOutputs,
		news: RailwayProjectTokenInputs,
	): Promise<pulumi.dynamic.DiffResult> {
		const replaces: string[] = [];

		if (olds.projectId !== news.projectId) {
			replaces.push("projectId");
		}

		if (olds.environmentId !== news.environmentId) {
			replaces.push("environmentId");
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
class RailwayProjectTokenResource extends pulumi.dynamic.Resource {
	public declare readonly value: pulumi.Output<string>;
	public declare readonly tokenId: pulumi.Output<string>;

	constructor(
		name: string,
		args: {
			token: pulumi.Input<string>;
			projectId: pulumi.Input<string>;
			environmentId: pulumi.Input<string>;
			name: pulumi.Input<string>;
		},
		opts?: pulumi.CustomResourceOptions,
	) {
		super(
			new RailwayProjectTokenResourceProvider(),
			name,
			{
				...args,
				value: pulumi.secret(undefined as unknown as string),
				tokenId: undefined,
			},
			opts,
		);
	}
}

/** Options type for RailwayProjectToken — replaces Pulumi's native `provider` field. */
type RailwayProjectTokenOptions = Omit<
	pulumi.ComponentResourceOptions,
	"provider"
> & {
	/** Railway authentication context. */
	provider: RailwayProvider;

	/** Railway project this token belongs to. */
	project: RailwayProject;

	/** Railway environment this deploy token is scoped to. */
	environment: RailwayEnvironment;
};

/** Args for RailwayProjectToken. */
export interface RailwayProjectTokenArgs {
	/**
	 * Distinct token name, e.g. `"pulumi-staging"`.
	 * Each environment should use a unique name so multiple stacks sharing
	 * a project never collide on token ownership.
	 */
	name: pulumi.Input<string>;
}

/**
 * Provisions an environment-scoped Railway deploy token.
 *
 * Each environment gets its own correctly-scoped token with a distinct name,
 * so multiple stacks sharing the same Railway project never collide.
 * The token value is exposed as a secret output for use in {@link RailwayDeploy}.
 *
 * @example
 * ```typescript
 * const project = new RailwayProject("my-project", { name: "my-app" }, { provider });
 * const staging = new RailwayEnvironment("staging", { name: "staging" }, { provider, project });
 *
 * const stagingToken = new RailwayProjectToken("staging-token", {
 *   name: "pulumi-staging",
 * }, { provider, project, environment: staging });
 *
 * new RailwayDeploy("api-deploy", {
 *   directory: monorepoRoot,
 *   triggers: [sourceHash],
 * }, { provider, project, environment: staging, service, projectToken: stagingToken.token });
 * ```
 */
export class RailwayProjectToken extends pulumi.ComponentResource {
	/**
	 * Environment-scoped Railway deploy token value (secret).
	 * Pass this to `RailwayDeployOptions.projectToken`.
	 */
	public readonly token: pulumi.Output<string>;

	constructor(
		name: string,
		args: RailwayProjectTokenArgs,
		opts: RailwayProjectTokenOptions,
	) {
		const { provider, project, environment, ...pulumiOpts } = opts;

		super("infracraft:railway:ProjectToken", name, {}, pulumiOpts);

		const resource = new RailwayProjectTokenResource(
			`${name}-resource`,
			{
				token: provider.token,
				projectId: project.id,
				environmentId: environment.id,
				name: args.name,
			},
			{ parent: this },
		);

		this.token = resource.value;

		this.registerOutputs({ token: this.token });
	}
}
