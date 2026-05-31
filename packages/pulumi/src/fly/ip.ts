import * as pulumi from "@pulumi/pulumi";

import type { FlyApp } from "./app";
import { FlyClient } from "./client";
import type { FlyProvider } from "./provider";

/**
 * Fly IP address type. Enum keys UPPERCASE; values are Fly's GraphQL enum
 * literals (lowercase wire format).
 */
export enum FlyIpType {
	V4 = "v4",
	V6 = "v6",
	SHARED_V4 = "shared_v4",
	PRIVATE_V6 = "private_v6",
}

/** Resolved inputs for the Fly IP dynamic provider. */
export interface FlyIpInputs {
	/** Fly API token. */
	token: string;

	/** App name (used as GraphQL appId). */
	appName: string;

	/** IP address type. */
	type: FlyIpType;

	/** Region (IATA code); omit for global. */
	region?: string;
}

/** Persisted state for the Fly IP. */
interface FlyIpOutputs extends FlyIpInputs {
	/** Allocated IP address (also the `.id`). */
	address: string;

	/** GraphQL node ID, when present (absent for `shared_v4`). */
	ipAddressId?: string;
}

const LIST_IPS = `
	query ($appName: String!) {
		app(name: $appName) {
			sharedIpAddress
			ipAddresses {
				nodes { id address type region }
			}
		}
	}
`;

const ALLOCATE_IP = `
	mutation ($input: AllocateIPAddressInput!) {
		allocateIpAddress(input: $input) {
			ipAddress { id address type region }
			app { sharedIpAddress }
		}
	}
`;

const RELEASE_IP = `
	mutation ($input: ReleaseIPAddressInput!) {
		releaseIpAddress(input: $input) { clientMutationId }
	}
`;

interface IpNode {
	id: string;
	address: string;
	type: string;
	region: string | null;
}

interface ListIpsResult {
	app: {
		sharedIpAddress: string | null;
		ipAddresses: { nodes: IpNode[] };
	};
}

interface AllocateResult {
	allocateIpAddress: {
		ipAddress: IpNode | null;
		app: { sharedIpAddress: string | null };
	};
}

/**
 * Dynamic provider for Fly dedicated/shared IP allocation via the Fly GraphQL
 * API. `create()` queries existing IPs and adopts a matching one, otherwise it
 * allocates. `shared_v4` allocations return a null `ipAddress` in the payload —
 * the address is read from `app.sharedIpAddress`.
 */
class FlyIpResourceProvider implements pulumi.dynamic.ResourceProvider {
	async create(inputs: FlyIpInputs): Promise<pulumi.dynamic.CreateResult> {
		const client = new FlyClient(inputs.token);

		const existing = await this.findExisting(client, inputs);

		if (existing) {
			pulumi.log.info(
				`Adopting existing Fly ${inputs.type} IP "${existing.address}"`,
			);

			return {
				id: existing.address,
				outs: {
					...inputs,
					address: existing.address,
					ipAddressId: existing.ipAddressId,
				},
			};
		}

		const result = await client.graphql<AllocateResult>(ALLOCATE_IP, {
			input: {
				appId: inputs.appName,
				type: inputs.type,
				region: inputs.region,
			},
		});

		const node = result.allocateIpAddress.ipAddress;

		const address =
			inputs.type === FlyIpType.SHARED_V4
				? (result.allocateIpAddress.app.sharedIpAddress ?? "")
				: (node?.address ?? "");

		if (!address) {
			throw new Error(
				`Fly IP allocation for app "${inputs.appName}" (${inputs.type}) returned no address`,
			);
		}

		return {
			id: address,
			outs: { ...inputs, address, ipAddressId: node?.id },
		};
	}

	async read(
		id: string,
		props: FlyIpOutputs,
	): Promise<pulumi.dynamic.ReadResult> {
		return { id, props };
	}

	async delete(_id: string, props: FlyIpOutputs): Promise<void> {
		const client = new FlyClient(props.token);

		const input: Record<string, string> = { appId: props.appName };

		if (props.ipAddressId) {
			input.ipAddressId = props.ipAddressId;
		} else {
			input.ip = props.address;
		}

		await client.graphql(RELEASE_IP, { input });
	}

	async diff(
		_id: string,
		olds: FlyIpOutputs,
		news: FlyIpInputs,
	): Promise<pulumi.dynamic.DiffResult> {
		const replaces: string[] = [];

		if (olds.appName !== news.appName) {
			replaces.push("appName");
		}

		if (olds.type !== news.type) {
			replaces.push("type");
		}

		if (olds.region !== news.region) {
			replaces.push("region");
		}

		return {
			changes: replaces.length > 0,
			replaces,
			deleteBeforeReplace: true,
		};
	}

	private async findExisting(
		client: FlyClient,
		inputs: FlyIpInputs,
	): Promise<{ address: string; ipAddressId?: string } | null> {
		const result = await client.graphql<ListIpsResult>(LIST_IPS, {
			appName: inputs.appName,
		});

		if (inputs.type === FlyIpType.SHARED_V4) {
			const shared = result.app.sharedIpAddress;

			return shared ? { address: shared } : null;
		}

		const match = result.app.ipAddresses.nodes.find(
			(node) =>
				node.type === inputs.type &&
				(inputs.region === undefined || node.region === inputs.region),
		);

		return match ? { address: match.address, ipAddressId: match.id } : null;
	}
}

/** Internal dynamic resource — not part of the public API. */
class FlyIpResource extends pulumi.dynamic.Resource {
	public declare readonly address: pulumi.Output<string>;

	constructor(
		name: string,
		args: {
			token: pulumi.Input<string>;
			appName: pulumi.Input<string>;
			type: pulumi.Input<FlyIpType>;
			region?: pulumi.Input<string>;
		},
		opts?: pulumi.CustomResourceOptions,
	) {
		super(
			new FlyIpResourceProvider(),
			name,
			{ ...args, address: undefined, ipAddressId: undefined },
			opts,
		);
	}
}

/** Options type for FlyIp. */
type FlyIpOptions = Omit<pulumi.ComponentResourceOptions, "provider"> & {
	/** Fly authentication context. */
	provider: FlyProvider;

	/** App the IP belongs to. */
	app: FlyApp;
};

/** Args for FlyIp. */
export interface FlyIpArgs {
	/** IP address type. */
	type: pulumi.Input<FlyIpType>;

	/** Region (IATA code); omit for a global address. */
	region?: pulumi.Input<string>;
}

/**
 * Allocates a Fly IP address (dedicated or shared) via the Fly GraphQL API.
 *
 * @example
 * ```typescript
 * const ip = new FlyIp("api-ip", { type: FlyIpType.SHARED_V4 }, { provider, app });
 * ```
 */
export class FlyIp extends pulumi.ComponentResource {
	/** Allocated IP address. */
	public readonly id: pulumi.Output<string>;

	constructor(name: string, args: FlyIpArgs, opts: FlyIpOptions) {
		const { provider, app, ...pulumiOpts } = opts;

		super("infracraft:fly:Ip", name, {}, pulumiOpts);

		const resource = new FlyIpResource(
			`${name}-resource`,
			{
				token: provider.token,
				appName: app.id,
				type: args.type,
				region: args.region,
			},
			{ parent: this },
		);

		this.id = resource.address;

		this.registerOutputs({ id: this.id });
	}
}
