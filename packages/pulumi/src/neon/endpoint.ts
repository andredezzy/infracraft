import * as pulumi from "@pulumi/pulumi";
import { ApiNotFoundError } from "../errors/api-not-found-error";
import type { NeonBranch } from "./branch";
import { NeonClient } from "./client";
import type { NeonProject } from "./project";
import type { NeonProvider } from "./provider";

/** Resolved inputs for the Neon endpoint dynamic provider. */
interface NeonEndpointInputs {
	/** Neon API key. */
	apiKey: string;

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
interface NeonEndpointOutputs extends NeonEndpointInputs {
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
	client: NeonClient,
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
 */
class NeonEndpointResourceProvider implements pulumi.dynamic.ResourceProvider {
	async create(
		inputs: NeonEndpointInputs,
	): Promise<pulumi.dynamic.CreateResult> {
		const client = new NeonClient(inputs.apiKey);

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
		_olds: NeonEndpointOutputs,
		news: NeonEndpointInputs,
	): Promise<pulumi.dynamic.UpdateResult> {
		const client = new NeonClient(news.apiKey);

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
		props: NeonEndpointOutputs,
	): Promise<pulumi.dynamic.ReadResult> {
		const client = new NeonClient(props.apiKey);

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

	async delete(id: string, props: NeonEndpointOutputs): Promise<void> {
		const client = new NeonClient(props.apiKey);

		try {
			await client.delete(`/projects/${props.projectId}/endpoints/${id}`);
		} catch {
			pulumi.log.warn(
				`Failed to delete Neon endpoint (may already be deleted)`,
			);
		}
	}

	async diff(
		_id: string,
		olds: NeonEndpointOutputs,
		news: NeonEndpointInputs,
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

		return { changes: hasChanges, replaces, deleteBeforeReplace: true };
	}
}

/** Internal dynamic resource — not part of the public API. */
class NeonEndpointResource extends pulumi.dynamic.Resource {
	public declare readonly host: pulumi.Output<string>;

	constructor(
		name: string,
		args: {
			apiKey: pulumi.Input<string>;
			projectId: pulumi.Input<string>;
			branchId: pulumi.Input<string>;
			minCu: pulumi.Input<number>;
			maxCu: pulumi.Input<number>;
			suspendTimeout: pulumi.Input<number>;
		},
		opts?: pulumi.CustomResourceOptions,
	) {
		super(
			new NeonEndpointResourceProvider(),
			name,
			{ ...args, host: undefined },
			// The API key flows into dynamic-provider state with the outputs — mark it secret there.
			{ ...opts, additionalSecretOutputs: ["apiKey"] },
		);
	}
}

/** Options type for NeonEndpoint — replaces Pulumi's native `provider` field. */
type NeonEndpointOptions = Omit<pulumi.ComponentResourceOptions, "provider"> & {
	/** Neon authentication context. */
	provider: NeonProvider;

	/** Neon project context. */
	project: NeonProject;

	/** Neon branch context. */
	branch: NeonBranch;
};

/** Args for NeonEndpoint. */
export interface NeonEndpointArgs {
	/** Minimum compute units. */
	minCu: pulumi.Input<number>;

	/** Maximum compute units. */
	maxCu: pulumi.Input<number>;

	/** Seconds of inactivity before suspending. */
	suspendTimeout: pulumi.Input<number>;
}

/**
 * Manages a Neon compute endpoint with adopt-or-create semantics.
 * Exposes `host` as an output for connection string composition.
 *
 * @example
 * ```typescript
 * const endpoint = new NeonEndpoint("production", {
 *   minCu: 0.25,
 *   maxCu: 1,
 *   suspendTimeout: 0,
 * }, { provider, project, branch });
 * ```
 */
export class NeonEndpoint extends pulumi.ComponentResource {
	/** Endpoint hostname for connection strings. */
	public readonly host: pulumi.Output<string>;

	constructor(name: string, args: NeonEndpointArgs, opts: NeonEndpointOptions) {
		const { provider, project, branch, ...pulumiOpts } = opts;

		super("infracraft:neon:Endpoint", name, {}, pulumiOpts);

		const resource = new NeonEndpointResource(
			`${name}-resource`,
			{
				apiKey: provider.apiKey,
				projectId: project.id,
				branchId: branch.id,
				...args,
			},
			{ parent: this },
		);

		this.host = resource.host;

		this.registerOutputs({ host: this.host });
	}
}
