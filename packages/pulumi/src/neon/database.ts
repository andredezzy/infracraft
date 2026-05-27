import * as pulumi from "@pulumi/pulumi";
import { NeonClient } from "./client.js";

/** Resolved inputs for the Neon database dynamic provider. */
export interface NeonDatabaseInputs {
	/** Neon API key. */
	apiKey: string;

	/** Neon project ID. */
	projectId: string;

	/** Branch ID the database belongs to. */
	branchId: string;

	/** Database name (e.g. `"neondb"`). */
	name: string;

	/** Owner role name (e.g. `"neondb_owner"`). */
	ownerName: string;
}

/** Persisted state for the Neon database. */
interface NeonDatabaseOutputs extends NeonDatabaseInputs {}

/** Neon API response for a database. */
interface DatabaseResponse {
	database: {
		id: number;
		name: string;
		owner_name: string;
		branch_id: string;
	};
}

/** Neon API response for listing databases. */
interface DatabaseListResponse {
	databases: Array<{
		id: number;
		name: string;
		owner_name: string;
	}>;
}

/**
 * Finds an existing database by name on a branch.
 *
 * @param client Authenticated Neon API client
 * @param projectId Neon project ID
 * @param branchId Branch ID to search within
 * @param name Exact database name to match
 * @returns `true` if found, `false` otherwise
 */
async function findDatabaseByName(
	client: NeonClient,
	projectId: string,
	branchId: string,
	name: string,
): Promise<boolean> {
	const result = await client.get<DatabaseListResponse>(
		`/projects/${projectId}/branches/${branchId}/databases`,
	);

	return result.databases.some((d) => d.name === name);
}

/**
 * Dynamic provider implementing CRUD for Neon databases.
 *
 * Uses adopt-or-create on `create()`: checks if the database already exists
 * before creating a new one.
 */
class NeonDatabaseProvider implements pulumi.dynamic.ResourceProvider {
	/**
	 * Creates or adopts a Neon database by name.
	 *
	 * @param inputs Resolved database configuration
	 * @returns Composite ID `{branchId}/{databaseName}` as the resource ID
	 */
	async create(
		inputs: NeonDatabaseInputs,
	): Promise<pulumi.dynamic.CreateResult> {
		const client = new NeonClient(inputs.apiKey);

		const exists = await findDatabaseByName(
			client,
			inputs.projectId,
			inputs.branchId,
			inputs.name,
		);

		if (exists) {
			pulumi.log.info(`Adopting existing Neon database "${inputs.name}"`);
		} else {
			await client.post(
				`/projects/${inputs.projectId}/branches/${inputs.branchId}/databases`,
				{ database: { name: inputs.name, owner_name: inputs.ownerName } },
			);
		}

		return {
			id: `${inputs.branchId}/${inputs.name}`,
			outs: inputs,
		};
	}

	/**
	 * Reads current state for `pulumi refresh`.
	 *
	 * @param id Current composite database ID
	 * @param props Last known persisted state
	 * @returns Refreshed resource ID and properties
	 * @throws {Error} If the database no longer exists
	 */
	async read(
		id: string,
		props: NeonDatabaseOutputs,
	): Promise<pulumi.dynamic.ReadResult> {
		const client = new NeonClient(props.apiKey);

		const result = await client.get<DatabaseResponse>(
			`/projects/${props.projectId}/branches/${props.branchId}/databases/${props.name}`,
		);

		return {
			id,
			props: { ...props, ownerName: result.database.owner_name },
		};
	}

	/**
	 * Deletes the Neon database. Silently succeeds if already deleted.
	 */
	async delete(_id: string, props: NeonDatabaseOutputs): Promise<void> {
		const client = new NeonClient(props.apiKey);

		try {
			await client.delete(
				`/projects/${props.projectId}/branches/${props.branchId}/databases/${props.name}`,
			);
		} catch {
			pulumi.log.warn(
				`Failed to delete Neon database "${props.name}" (may already be deleted)`,
			);
		}
	}

	/**
	 * Compares old and new inputs. All fields trigger replacement
	 * since databases cannot be renamed or moved.
	 */
	async diff(
		_id: string,
		olds: NeonDatabaseOutputs,
		news: NeonDatabaseInputs,
	): Promise<pulumi.dynamic.DiffResult> {
		const replaces: string[] = [];

		if (olds.projectId !== news.projectId) {
			replaces.push("projectId");
		}

		if (olds.branchId !== news.branchId) {
			replaces.push("branchId");
		}

		if (olds.name !== news.name) {
			replaces.push("name");
		}

		return {
			changes: replaces.length > 0 || olds.ownerName !== news.ownerName,
			replaces,
			deleteBeforeReplace: true,
		};
	}
}

/**
 * Manages a Neon database with adopt-or-create semantics.
 *
 * @example
 * ```typescript
 * new NeonDatabase("neon-database", {
 *   apiKey: config.requireSecret("neonApiKey"),
 *   projectId: "quiet-forest-69719462",
 *   branchId: branch.id,
 *   name: "neondb",
 *   ownerName: "neondb_owner",
 * });
 * ```
 */
export class NeonDatabase extends pulumi.dynamic.Resource {
	/**
	 * @param name Pulumi resource name
	 * @param args Database configuration inputs
	 * @param opts Standard Pulumi resource options
	 */
	constructor(
		name: string,
		args: {
			/** Neon API key. */
			apiKey: pulumi.Input<string>;

			/** Neon project ID. */
			projectId: pulumi.Input<string>;

			/** Branch ID the database belongs to. */
			branchId: pulumi.Input<string>;

			/** Database name. */
			name: pulumi.Input<string>;

			/** Owner role name. */
			ownerName: pulumi.Input<string>;
		},
		opts?: pulumi.CustomResourceOptions,
	) {
		super(new NeonDatabaseProvider(), name, { ...args }, opts);
	}
}
