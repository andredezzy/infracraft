import * as pulumi from "@pulumi/pulumi";
import { NeonClient } from "./client.js";

/** Resolved inputs for the Neon branch dynamic provider. */
export interface NeonBranchInputs {
	/** Neon API key. */
	apiKey: string;

	/** Neon project ID (e.g. `"quiet-forest-69719462"`). */
	projectId: string;

	/** Branch display name (e.g. `"production"`, `"development"`). */
	name: string;
}

/** Persisted state for the Neon branch. */
interface NeonBranchOutputs extends NeonBranchInputs {}

/** Neon API response for a branch. */
interface BranchResponse {
	branch: {
		id: string;
		name: string;
		project_id: string;
	};
}

/** Neon API response for branch creation. */
interface BranchCreateResponse {
	branch: {
		id: string;
		name: string;
		project_id: string;
	};
}

/** Neon API response for listing branches. */
interface BranchListResponse {
	branches: Array<{
		id: string;
		name: string;
	}>;
}

/**
 * Finds an existing Neon branch by name within a project.
 *
 * @param client Authenticated Neon API client
 * @param projectId Neon project ID
 * @param name Exact branch name to match
 * @returns The branch ID if found, `undefined` otherwise
 */
async function findBranchByName(
	client: NeonClient,
	projectId: string,
	name: string,
): Promise<string | undefined> {
	const result = await client.get<BranchListResponse>(
		`/projects/${projectId}/branches`,
	);

	const match = result.branches.find((b) => b.name === name);

	return match?.id;
}

/**
 * Dynamic provider implementing CRUD for Neon branches.
 *
 * Uses adopt-or-create on `create()`: finds an existing branch by name
 * before creating a new one, making `pulumi up` idempotent from zero.
 */
class NeonBranchProvider implements pulumi.dynamic.ResourceProvider {
	/**
	 * Creates or adopts a Neon branch by name.
	 *
	 * @param inputs Resolved branch configuration
	 * @returns The Neon branch ID as the resource ID
	 */
	async create(inputs: NeonBranchInputs): Promise<pulumi.dynamic.CreateResult> {
		const client = new NeonClient(inputs.apiKey);

		let branchId = await findBranchByName(
			client,
			inputs.projectId,
			inputs.name,
		);

		if (branchId) {
			pulumi.log.info(
				`Adopting existing Neon branch "${inputs.name}" (${branchId})`,
			);
		} else {
			const result = await client.post<BranchCreateResponse>(
				`/projects/${inputs.projectId}/branches`,
				{ branch: { name: inputs.name } },
			);

			branchId = result.branch.id;
		}

		return { id: branchId, outs: inputs };
	}

	/**
	 * Reads current state for `pulumi refresh`.
	 *
	 * @param id Current Neon branch ID
	 * @param props Last known persisted state
	 * @returns Refreshed resource ID and properties
	 * @throws {Error} If the branch no longer exists
	 */
	async read(
		id: string,
		props: NeonBranchOutputs,
	): Promise<pulumi.dynamic.ReadResult> {
		const client = new NeonClient(props.apiKey);

		const result = await client.get<BranchResponse>(
			`/projects/${props.projectId}/branches/${id}`,
		);

		return {
			id: result.branch.id,
			props: { ...props, name: result.branch.name },
		};
	}

	/**
	 * Deletes the Neon branch. Silently succeeds if already deleted.
	 *
	 * @param id Neon branch ID to delete
	 * @param props Last known persisted state
	 */
	async delete(id: string, props: NeonBranchOutputs): Promise<void> {
		const client = new NeonClient(props.apiKey);

		try {
			await client.delete(`/projects/${props.projectId}/branches/${id}`);
		} catch {
			pulumi.log.warn(`Failed to delete Neon branch (may already be deleted)`);
		}
	}

	/**
	 * Compares old and new inputs to detect changes.
	 * Changing `projectId` triggers replacement.
	 */
	async diff(
		_id: string,
		olds: NeonBranchOutputs,
		news: NeonBranchInputs,
	): Promise<pulumi.dynamic.DiffResult> {
		const replaces: string[] = [];

		if (olds.projectId !== news.projectId) {
			replaces.push("projectId");
		}

		return {
			changes: replaces.length > 0 || olds.name !== news.name,
			replaces,
			deleteBeforeReplace: true,
		};
	}
}

/**
 * Manages a Neon branch with adopt-or-create semantics.
 *
 * @example
 * ```typescript
 * const branch = new NeonBranch("neon-branch-production", {
 *   apiKey: config.requireSecret("neonApiKey"),
 *   projectId: "quiet-forest-69719462",
 *   name: "production",
 * });
 * ```
 */
export class NeonBranch extends pulumi.dynamic.Resource {
	/**
	 * @param name Pulumi resource name
	 * @param args Branch configuration inputs
	 * @param opts Standard Pulumi resource options
	 */
	constructor(
		name: string,
		args: {
			/** Neon API key. */
			apiKey: pulumi.Input<string>;

			/** Neon project ID. */
			projectId: pulumi.Input<string>;

			/** Branch display name. */
			name: pulumi.Input<string>;
		},
		opts?: pulumi.CustomResourceOptions,
	) {
		super(new NeonBranchProvider(), name, { ...args }, opts);
	}
}
