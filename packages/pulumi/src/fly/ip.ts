import * as pulumi from "@pulumi/pulumi";

import { resolveCredential } from "../dynamic/resolve-credential";
import { isGraphqlNotFoundError } from "../http/is-graphql-not-found-error";
import type { App } from "./app";
import { Client } from "./client";
import type { Provider } from "./provider";

/**
 * Fly IP address type. Enum keys UPPERCASE; values are Fly's GraphQL enum
 * literals (lowercase wire format).
 */
export enum IpType {
	V4 = "v4",
	V6 = "v6",
	SHARED_V4 = "shared_v4",
	PRIVATE_V6 = "private_v6",
}

/** Resolved inputs for the Fly IP dynamic provider. */
interface IpInputs {
	/** Fly API token. Absent when `tokenEnvVar` is used instead. */
	token?: string;

	/** Env var name resolved to the token when `token` is absent (see `ProviderArgs.tokenEnvVar`). */
	tokenEnvVar?: string;

	/** App name (used as GraphQL appId). */
	appName: string;

	/** IP address type. */
	type: IpType;

	/** Region (IATA code); omit for global. */
	region?: string;
}

/** Persisted state for the Fly IP. */
interface IpOutputs extends IpInputs {
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
 *
 * @internal Exported only for unit testing; not part of the public API surface.
 */
export class IpResourceProvider implements pulumi.dynamic.ResourceProvider {
	async create(inputs: IpInputs): Promise<pulumi.dynamic.CreateResult> {
		const client = new Client(
			resolveCredential(inputs.token, inputs.tokenEnvVar),
		);

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
			inputs.type === IpType.SHARED_V4
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
		_id: string,
		props: IpOutputs,
	): Promise<pulumi.dynamic.ReadResult> {
		const client = new Client(
			resolveCredential(props.token, props.tokenEnvVar),
		);

		const existing = await this.findExisting(client, props);

		if (!existing) {
			// Resource gone → blank id lets refresh reconcile the deletion.
			return {};
		}

		return {
			id: existing.address,
			props: {
				...props,
				address: existing.address,
				ipAddressId: existing.ipAddressId,
			},
		};
	}

	async delete(_id: string, props: IpOutputs): Promise<void> {
		const client = new Client(
			resolveCredential(props.token, props.tokenEnvVar),
		);

		const input: Record<string, string> = { appId: props.appName };

		if (props.ipAddressId) {
			input.ipAddressId = props.ipAddressId;
		} else {
			input.ip = props.address;
		}

		try {
			await client.graphql(RELEASE_IP, { input });
		} catch (error) {
			// Fly reports an already-released IP as a GraphQL "not found" error —
			// deletion is idempotent, so tolerate it.
			if (isGraphqlNotFoundError(error)) {
				pulumi.log.warn(`Fly IP "${props.address}" already released`);

				return;
			}

			throw error;
		}
	}

	async diff(
		_id: string,
		olds: IpOutputs,
		news: IpInputs,
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
		client: Client,
		inputs: IpInputs,
	): Promise<{ address: string; ipAddressId?: string } | null> {
		const result = await client.graphql<ListIpsResult>(LIST_IPS, {
			appName: inputs.appName,
		});

		if (inputs.type === IpType.SHARED_V4) {
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
class IpResource extends pulumi.dynamic.Resource {
	public declare readonly address: pulumi.Output<string>;

	constructor(
		name: string,
		args: {
			token?: pulumi.Input<string>;
			tokenEnvVar?: pulumi.Input<string>;
			appName: pulumi.Input<string>;
			type: pulumi.Input<IpType>;
			region?: pulumi.Input<string>;
		},
		opts?: pulumi.CustomResourceOptions,
	) {
		super(
			new IpResourceProvider(),
			name,
			{ ...args, address: undefined, ipAddressId: undefined },
			// The API token flows into dynamic-provider state with the outputs — mark it secret there.
			{ ...opts, additionalSecretOutputs: ["token"] },
		);
	}
}

/** Options type for Ip. */
type IpOptions = Omit<pulumi.ComponentResourceOptions, "provider"> & {
	/** Fly authentication context. */
	provider: Provider;

	/** App the IP belongs to. */
	app: App;
};

/** Args for Ip. */
export interface IpArgs {
	/** IP address type. */
	type: pulumi.Input<IpType>;

	/** Region (IATA code); omit for a global address. */
	region?: pulumi.Input<string>;
}

/**
 * Allocates a Fly IP address (dedicated or shared) via the Fly GraphQL API.
 *
 * @example
 * ```typescript
 * const ip = new fly.Ip("api-ip", { type: fly.IpType.SHARED_V4 }, { provider, app });
 * ```
 */
export class Ip extends pulumi.ComponentResource {
	/** Allocated IP address. */
	public readonly id: pulumi.Output<string>;

	constructor(name: string, args: IpArgs, opts: IpOptions) {
		const { provider, app, ...pulumiOpts } = opts;

		super("infracraft:fly:Ip", name, {}, pulumiOpts);

		const resource = new IpResource(
			`${name}-resource`,
			{
				token: provider.token,
				tokenEnvVar: provider.tokenEnvVar,
				appName: app.id,
				type: args.type,
				region: args.region,
			},
			// Forward the consumer's resource options (e.g. `retainOnDelete`) to the
			// underlying resource — Pulumi auto-inherits provider/protect from the
			// parent component, but not everything else.
			pulumi.mergeOptions(pulumiOpts, { parent: this }),
		);

		this.id = resource.address;

		this.registerOutputs({ id: this.id });
	}
}
