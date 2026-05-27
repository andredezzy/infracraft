import * as pulumi from "@pulumi/pulumi";
import { NeonClient } from "./client.js";

/** Resolved inputs for the Neon endpoint dynamic provider. */
export interface NeonEndpointInputs {
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
 *
 * @param client Authenticated Neon API client
 * @param projectId Neon project ID
 * @param branchId Branch ID to search within
 * @returns The endpoint ID and host if found, `undefined` otherwise
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
class NeonEndpointProvider implements pulumi.dynamic.ResourceProvider {
	/**
	 * Creates or adopts a Neon endpoint on the target branch.
	 *
	 * @param inputs Resolved endpoint configuration
	 * @returns The Neon endpoint ID as the resource ID
	 */
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

		const result = await client.post<EndpointResponse>(
			`/projects/${inputs.projectId}/branches/${inputs.branchId}/endpoints`,
			{
				endpoint: {
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

	/**
	 * Updates endpoint compute settings in place.
	 *
	 * @param id Current Neon endpoint ID
	 * @param _olds Previous persisted state
	 * @param news New desired configuration
	 * @returns Updated outputs with current host
	 */
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

	/**
	 * Reads current state for `pulumi refresh`.
	 *
	 * @param id Current Neon endpoint ID
	 * @param props Last known persisted state
	 * @returns Refreshed resource ID and properties
	 * @throws {Error} If the endpoint no longer exists
	 */
	async read(
		id: string,
		props: NeonEndpointOutputs,
	): Promise<pulumi.dynamic.ReadResult> {
		const client = new NeonClient(props.apiKey);

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
	}

	/**
	 * Deletes the Neon endpoint. Silently succeeds if already deleted.
	 */
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

	/**
	 * Compares old and new inputs. Changing `projectId` or `branchId` triggers replacement.
	 */
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

/**
 * Manages a Neon compute endpoint with adopt-or-create semantics.
 * Exposes `host` as an output for connection string composition.
 *
 * @example
 * ```typescript
 * const endpoint = new NeonEndpoint("neon-endpoint-production", {
 *   apiKey: config.requireSecret("neonApiKey"),
 *   projectId: "quiet-forest-69719462",
 *   branchId: branch.id,
 *   minCu: 0.25,
 *   maxCu: 2,
 *   suspendTimeout: 0,
 * });
 *
 * const host = endpoint.host;
 * ```
 */
export class NeonEndpoint extends pulumi.dynamic.Resource {
	/** Endpoint hostname for connection strings. */
	public declare readonly host: pulumi.Output<string>;

	/**
	 * @param name Pulumi resource name
	 * @param args Endpoint configuration inputs
	 * @param opts Standard Pulumi resource options
	 */
	constructor(
		name: string,
		args: {
			/** Neon API key. */
			apiKey: pulumi.Input<string>;

			/** Neon project ID. */
			projectId: pulumi.Input<string>;

			/** Branch ID to attach the endpoint to. */
			branchId: pulumi.Input<string>;

			/** Minimum compute units. */
			minCu: pulumi.Input<number>;

			/** Maximum compute units. */
			maxCu: pulumi.Input<number>;

			/** Seconds of inactivity before suspending. */
			suspendTimeout: pulumi.Input<number>;
		},
		opts?: pulumi.CustomResourceOptions,
	) {
		super(new NeonEndpointProvider(), name, { ...args, host: undefined }, opts);
	}
}
