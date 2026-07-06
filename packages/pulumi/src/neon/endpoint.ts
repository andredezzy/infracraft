import * as pulumi from "@pulumi/pulumi";
import { resolveCredential } from "../dynamic/resolve-credential";
import { ApiNotFoundError } from "../errors/api-not-found-error";
import type { Branch } from "./branch";
import { Client } from "./client";
import type { Project } from "./project";
import type { Provider } from "./provider";

/** Resolved inputs for the Neon endpoint dynamic provider. */
interface EndpointInputs {
	/** Neon API key. Absent when `apiKeyEnvVar` is used instead. */
	apiKey?: string;

	/** Env var name resolved to the API key when `apiKey` is absent (see `ProviderArgs.apiKeyEnvVar`). */
	apiKeyEnvVar?: string;

	/** Neon project ID. */
	projectId: string;

	/** Branch ID to attach the endpoint to. */
	branchId: string;

	/** Minimum compute units (e.g. `0.25`). */
	minCu: number;

	/** Maximum compute units (e.g. `2`). */
	maxCu: number;

	/** Seconds of inactivity before suspending. `0` means use global default. */
	suspendTimeout: number;
}

/** Persisted state for the Neon endpoint. */
interface EndpointOutputs extends EndpointInputs {
	/** Endpoint hostname (e.g. `"ep-delicate-union-ah0ekn7n.us-east-1.aws.neon.tech"`). */
	host: string;
}

/** Neon API response for an endpoint. */
interface EndpointResponse {
	endpoint: {
		id: string;
		host: string;
		branch_id: string;
		autoscaling_limit_min_cu: number;
		autoscaling_limit_max_cu: number;
		suspend_timeout_seconds: number;
	};
}

/** Neon API response for listing endpoints. */
interface EndpointListResponse {
	endpoints: Array<{
		id: string;
		host: string;
		branch_id: string;
		type: string;
	}>;
}

/**
 * Finds an existing read-write endpoint for a branch.
 */
async function findEndpointByBranch(
	client: Client,
	projectId: string,
	branchId: string,
): Promise<{ id: string; host: string } | undefined> {
	const result = await client.get<EndpointListResponse>(
		`/projects/${projectId}/branches/${branchId}/endpoints`,
	);

	const match = result.endpoints.find((e) => e.type === "read_write");

	return match ? { id: match.id, host: match.host } : undefined;
}

/**
 * Dynamic provider implementing CRUD for Neon compute endpoints.
 *
 * Uses adopt-or-create on `create()`: finds an existing read-write endpoint
 * on the target branch before creating a new one.
 *
 * @internal Exported only for unit testing; not part of the public API surface.
 */
export class EndpointResourceProvider
	implements pulumi.dynamic.ResourceProvider
{
	/**
	 * Validates inputs at plan time. An inverted range would otherwise fail
	 * deep inside the Neon API call with an opaque error.
	 */
	async check(
		_olds: EndpointInputs,
		news: EndpointInputs,
	): Promise<pulumi.dynamic.CheckResult<EndpointInputs>> {
		const failures: pulumi.dynamic.CheckFailure[] = [];

		if (
			typeof news.minCu === "number" &&
			typeof news.maxCu === "number" &&
			news.maxCu < news.minCu
		) {
			failures.push({
				property: "maxCu",
				reason: `maxCu (${news.maxCu}) must be greater than or equal to minCu (${news.minCu})`,
			});
		}

		return { inputs: news, failures };
	}

	async create(inputs: EndpointInputs): Promise<pulumi.dynamic.CreateResult> {
		const client = new Client(
			resolveCredential(inputs.apiKey, inputs.apiKeyEnvVar),
		);

		const existing = await findEndpointByBranch(
			client,
			inputs.projectId,
			inputs.branchId,
		);

		if (existing) {
			pulumi.log.info(`Adopting existing Neon endpoint (${existing.id})`);

			await client.patch(
				`/projects/${inputs.projectId}/endpoints/${existing.id}`,
				{
					endpoint: {
						autoscaling_limit_min_cu: inputs.minCu,
						autoscaling_limit_max_cu: inputs.maxCu,
						suspend_timeout_seconds: inputs.suspendTimeout,
					},
				},
			);

			return {
				id: existing.id,
				outs: { ...inputs, host: existing.host },
			};
		}

		// Create the compute endpoint via the project-level endpoints collection with
		// branch_id in the body. The branch-scoped path (/branches/{id}/endpoints) is
		// GET-only and returns 405 on POST.
		const result = await client.post<EndpointResponse>(
			`/projects/${inputs.projectId}/endpoints`,
			{
				endpoint: {
					branch_id: inputs.branchId,
					type: "read_write",
					autoscaling_limit_min_cu: inputs.minCu,
					autoscaling_limit_max_cu: inputs.maxCu,
					suspend_timeout_seconds: inputs.suspendTimeout,
				},
			},
		);

		return {
			id: result.endpoint.id,
			outs: { ...inputs, host: result.endpoint.host },
		};
	}

	async update(
		id: string,
		_olds: EndpointOutputs,
		news: EndpointInputs,
	): Promise<pulumi.dynamic.UpdateResult> {
		const client = new Client(
			resolveCredential(news.apiKey, news.apiKeyEnvVar),
		);

		const result = await client.patch<EndpointResponse>(
			`/projects/${news.projectId}/endpoints/${id}`,
			{
				endpoint: {
					autoscaling_limit_min_cu: news.minCu,
					autoscaling_limit_max_cu: news.maxCu,
					suspend_timeout_seconds: news.suspendTimeout,
				},
			},
		);

		return { outs: { ...news, host: result.endpoint.host } };
	}

	async read(
		id: string,
		props: EndpointOutputs,
	): Promise<pulumi.dynamic.ReadResult> {
		const client = new Client(
			resolveCredential(props.apiKey, props.apiKeyEnvVar),
		);

		try {
			const result = await client.get<EndpointResponse>(
				`/projects/${props.projectId}/endpoints/${id}`,
			);

			return {
				id: result.endpoint.id,
				props: {
					...props,
					host: result.endpoint.host,
					minCu: result.endpoint.autoscaling_limit_min_cu,
					maxCu: result.endpoint.autoscaling_limit_max_cu,
					suspendTimeout: result.endpoint.suspend_timeout_seconds,
				},
			};
		} catch (error) {
			// Resource gone → blank id lets refresh reconcile the deletion.
			if (error instanceof ApiNotFoundError) {
				return {};
			}

			throw error;
		}
	}

	async delete(id: string, props: EndpointOutputs): Promise<void> {
		const client = new Client(
			resolveCredential(props.apiKey, props.apiKeyEnvVar),
		);

		try {
			await client.delete(`/projects/${props.projectId}/endpoints/${id}`);
		} catch (error) {
			// Already gone — deletion is idempotent.
			if (error instanceof ApiNotFoundError) {
				pulumi.log.warn(`Neon endpoint "${id}" already deleted`);

				return;
			}

			throw error;
		}
	}

	async diff(
		_id: string,
		olds: EndpointOutputs,
		news: EndpointInputs,
	): Promise<pulumi.dynamic.DiffResult> {
		const replaces: string[] = [];

		if (olds.projectId !== news.projectId) {
			replaces.push("projectId");
		}

		if (olds.branchId !== news.branchId) {
			replaces.push("branchId");
		}

		const hasChanges =
			replaces.length > 0 ||
			olds.minCu !== news.minCu ||
			olds.maxCu !== news.maxCu ||
			olds.suspendTimeout !== news.suspendTimeout;

		return {
			changes: hasChanges,
			replaces,
			// The endpoint keeps its hostname across in-place updates (autoscaling /
			// suspend PATCHes); only a branchId/projectId replace mints a new host.
			// Declaring it stable keeps connection strings known during preview.
			stables: replaces.length === 0 ? ["host"] : [],
			deleteBeforeReplace: true,
		};
	}
}

/** Internal dynamic resource — not part of the public API. */
class EndpointResource extends pulumi.dynamic.Resource {
	public declare readonly host: pulumi.Output<string>;

	constructor(
		name: string,
		args: {
			apiKey?: pulumi.Input<string>;
			apiKeyEnvVar?: pulumi.Input<string>;
			projectId: pulumi.Input<string>;
			branchId: pulumi.Input<string>;
			minCu: pulumi.Input<number>;
			maxCu: pulumi.Input<number>;
			suspendTimeout: pulumi.Input<number>;
		},
		opts?: pulumi.CustomResourceOptions,
	) {
		super(
			new EndpointResourceProvider(),
			name,
			{ ...args, host: undefined },
			// The API key flows into dynamic-provider state with the outputs — mark it secret there.
			{ ...opts, additionalSecretOutputs: ["apiKey"] },
		);
	}
}

/** Options type for Endpoint — replaces Pulumi's native `provider` field. */
type EndpointOptions = Omit<pulumi.ComponentResourceOptions, "provider"> & {
	/** Neon authentication context. */
	provider: Provider;

	/** Neon project context. */
	project: Project;

	/** Neon branch context. */
	branch: Branch;
};

/** Args for Endpoint. */
export interface EndpointArgs {
	/** Minimum compute units. Maps to the Neon API field `endpoint.autoscaling_limit_min_cu`. */
	minCu: pulumi.Input<number>;

	/** Maximum compute units. Maps to the Neon API field `endpoint.autoscaling_limit_max_cu`. */
	maxCu: pulumi.Input<number>;

	/** Seconds of inactivity before suspending. Maps to the Neon API field `endpoint.suspend_timeout_seconds`. */
	suspendTimeout: pulumi.Input<number>;
}

/**
 * Manages a Neon compute endpoint with adopt-or-create semantics.
 * Exposes `host` as an output for connection string composition.
 *
 * @example
 * ```typescript
 * const endpoint = new neon.Endpoint("production", {
 *   minCu: 0.25,
 *   maxCu: 1,
 *   suspendTimeout: 0,
 * }, { provider, project, branch });
 * ```
 */
export class Endpoint extends pulumi.ComponentResource {
	/** Endpoint hostname for connection strings. */
	public readonly host: pulumi.Output<string>;

	constructor(name: string, args: EndpointArgs, opts: EndpointOptions) {
		const { provider, project, branch, ...pulumiOpts } = opts;

		super("infracraft:neon:Endpoint", name, {}, pulumiOpts);

		const resource = new EndpointResource(
			`${name}-resource`,
			{
				apiKey: provider.apiKey,
				apiKeyEnvVar: provider.apiKeyEnvVar,
				projectId: project.id,
				branchId: branch.id,
				...args,
			},
			// Forward the consumer's resource options (e.g. `retainOnDelete`) to the
			// underlying resource — Pulumi auto-inherits provider/protect from the
			// parent component, but not everything else.
			pulumi.mergeOptions(pulumiOpts, { parent: this }),
		);

		this.host = resource.host;

		this.registerOutputs({ host: this.host });
	}
}
