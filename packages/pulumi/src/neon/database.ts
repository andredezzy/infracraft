import * as pulumi from "@pulumi/pulumi";
import type { NeonBranch } from "./branch";
import { NeonClient } from "./client";
import type { NeonProject } from "./project";
import type { NeonProvider } from "./provider";

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
class NeonDatabaseResourceProvider implements pulumi.dynamic.ResourceProvider {
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

/** Internal dynamic resource — not part of the public API. */
class NeonDatabaseResource extends pulumi.dynamic.Resource {
	constructor(
		name: string,
		args: {
			apiKey: pulumi.Input<string>;
			projectId: pulumi.Input<string>;
			branchId: pulumi.Input<string>;
			name: pulumi.Input<string>;
			ownerName: pulumi.Input<string>;
		},
		opts?: pulumi.CustomResourceOptions,
	) {
		super(new NeonDatabaseResourceProvider(), name, { ...args }, opts);
	}
}

/** Options type for NeonDatabase — replaces Pulumi's native `provider` field. */
type NeonDatabaseOptions = Omit<pulumi.ComponentResourceOptions, "provider"> & {
	/** Neon authentication context. */
	provider: NeonProvider;

	/** Neon project context. */
	project: NeonProject;

	/** Neon branch context. */
	branch: NeonBranch;
};

/** Args for NeonDatabase. */
export interface NeonDatabaseArgs {
	/** Database name. */
	name: pulumi.Input<string>;

	/** Owner role name. */
	ownerName: pulumi.Input<string>;
}

/**
 * Manages a Neon database with adopt-or-create semantics.
 *
 * @example
 * ```typescript
 * new NeonDatabase("main", {
 *   name: "neondb",
 *   ownerName: "neondb_owner",
 * }, { provider, project, branch });
 * ```
 */
export class NeonDatabase extends pulumi.ComponentResource {
	constructor(name: string, args: NeonDatabaseArgs, opts: NeonDatabaseOptions) {
		const { provider, project, branch, ...pulumiOpts } = opts;

		super("infracraft:neon:Database", name, {}, pulumiOpts);

		new NeonDatabaseResource(
			`${name}-resource`,
			{
				apiKey: provider.apiKey,
				projectId: project.id,
				branchId: branch.id,
				name: args.name,
				ownerName: args.ownerName,
			},
			{ parent: this },
		);

		this.registerOutputs({});
	}
}
