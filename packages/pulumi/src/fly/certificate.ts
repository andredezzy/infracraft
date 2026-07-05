import * as pulumi from "@pulumi/pulumi";

import { ApiNotFoundError } from "../errors/api-not-found-error";
import type { FlyApp } from "./app";
import { FlyClient } from "./client";
import type { FlyProvider } from "./provider";

/** DNS records the consumer must create for certificate validation. */
export interface FlyDnsRequirements {
	/** ACME challenge CNAME record. */
	acme_challenge?: { name: string; target: string };

	/** `_fly-ownership` TXT record. */
	ownership?: { name: string; app_value: string };

	/** CNAME target for the hostname itself. */
	cname?: string;
}

/** Resolved inputs for the Fly certificate dynamic provider. */
interface FlyCertificateInputs {
	/** Fly API token. */
	token: string;

	/** App name the certificate belongs to. */
	appName: string;

	/** Hostname to issue an ACME certificate for. Used as the resource key. */
	hostname: string;
}

/** Persisted state for the Fly certificate. */
interface FlyCertificateOutputs extends FlyCertificateInputs {
	/** Whether the certificate is fully provisioned (DNS correct). */
	configured: boolean;

	/** DNS records required for validation. */
	dnsRequirements: FlyDnsRequirements;
}

/** Certificate response (only the fields we read). */
interface FlyCertificateResponse {
	hostname: string;
	configured: boolean;
	dns_requirements?: FlyDnsRequirements;
}

/**
 * Dynamic provider for Fly ACME (Let's Encrypt) certificates. `create()` checks
 * for an existing cert by hostname and adopts it, otherwise it requests one via
 * `POST /v1/apps/{app}/certificates/acme`. The Machines API returns no `id` —
 * the hostname is the resource key.
 *
 * @internal Exported only for unit testing; not part of the public API surface.
 */
export class FlyCertificateResourceProvider
	implements pulumi.dynamic.ResourceProvider
{
	async create(
		inputs: FlyCertificateInputs,
	): Promise<pulumi.dynamic.CreateResult> {
		const client = new FlyClient(inputs.token);
		const path = `/v1/apps/${inputs.appName}/certificates/${encodeURIComponent(inputs.hostname)}`;

		let cert = await client.tryGet<FlyCertificateResponse>(path);

		if (cert) {
			pulumi.log.info(`Adopting existing Fly certificate "${inputs.hostname}"`);
		} else {
			cert = await client.post<FlyCertificateResponse>(
				`/v1/apps/${inputs.appName}/certificates/acme`,
				{ hostname: inputs.hostname },
			);
		}

		const outs: FlyCertificateOutputs = {
			...inputs,
			configured: cert.configured ?? false,
			dnsRequirements: cert.dns_requirements ?? {},
		};

		return { id: inputs.hostname, outs };
	}

	async read(
		id: string,
		props: FlyCertificateOutputs,
	): Promise<pulumi.dynamic.ReadResult> {
		const client = new FlyClient(props.token);

		const cert = await client.tryGet<FlyCertificateResponse>(
			`/v1/apps/${props.appName}/certificates/${encodeURIComponent(id)}`,
		);

		if (!cert) {
			// Resource gone → blank id lets refresh reconcile the deletion.
			return {};
		}

		return {
			id,
			props: {
				...props,
				configured: cert.configured ?? false,
				dnsRequirements: cert.dns_requirements ?? {},
			},
		};
	}

	async update(
		_id: string,
		_olds: FlyCertificateOutputs,
		news: FlyCertificateInputs,
	): Promise<pulumi.dynamic.UpdateResult> {
		// Hostname/app changes force replacement (see diff); nothing else is updatable.
		return {
			outs: { ...news, configured: false, dnsRequirements: {} },
		};
	}

	async delete(id: string, props: FlyCertificateOutputs): Promise<void> {
		const client = new FlyClient(props.token);

		try {
			await client.delete(
				`/v1/apps/${props.appName}/certificates/${encodeURIComponent(id)}`,
			);
		} catch (error) {
			// Already gone — deletion is idempotent.
			if (error instanceof ApiNotFoundError) {
				pulumi.log.warn(`Fly certificate "${id}" already deleted`);

				return;
			}

			throw error;
		}
	}

	async diff(
		_id: string,
		olds: FlyCertificateOutputs,
		news: FlyCertificateInputs,
	): Promise<pulumi.dynamic.DiffResult> {
		const replaces: string[] = [];

		if (olds.appName !== news.appName) {
			replaces.push("appName");
		}

		if (olds.hostname !== news.hostname) {
			replaces.push("hostname");
		}

		return {
			changes: replaces.length > 0,
			replaces,
			deleteBeforeReplace: true,
		};
	}
}

/** Internal dynamic resource — not part of the public API. */
class FlyCertificateResource extends pulumi.dynamic.Resource {
	public declare readonly configured: pulumi.Output<boolean>;
	public declare readonly dnsRequirements: pulumi.Output<FlyDnsRequirements>;

	constructor(
		name: string,
		args: {
			token: pulumi.Input<string>;
			appName: pulumi.Input<string>;
			hostname: pulumi.Input<string>;
		},
		opts?: pulumi.CustomResourceOptions,
	) {
		super(
			new FlyCertificateResourceProvider(),
			name,
			{ ...args, configured: undefined, dnsRequirements: undefined },
			// The API token flows into dynamic-provider state with the outputs — mark it secret there.
			{ ...opts, additionalSecretOutputs: ["token"] },
		);
	}
}

/** Options type for FlyCertificate. */
type FlyCertificateOptions = Omit<
	pulumi.ComponentResourceOptions,
	"provider"
> & {
	/** Fly authentication context. */
	provider: FlyProvider;

	/** App the certificate belongs to. */
	app: FlyApp;
};

/** Args for FlyCertificate. */
export interface FlyCertificateArgs {
	/** Hostname to issue an ACME certificate for (e.g. `"api.example.com"`). */
	hostname: pulumi.Input<string>;
}

/**
 * Manages a Fly ACME certificate for a custom hostname.
 *
 * Exposes `.configured` and `.dnsRequirements` so the consumer can wire up the
 * required DNS records.
 *
 * @example
 * ```typescript
 * const cert = new FlyCertificate("api-cert", {
 *   hostname: "api.example.com",
 * }, { provider, app });
 * ```
 */
export class FlyCertificate extends pulumi.ComponentResource {
	/** Certificate identifier (equals the hostname). */
	public readonly id: pulumi.Output<string>;

	/** Whether the certificate is fully provisioned. */
	public readonly configured: pulumi.Output<boolean>;

	/** DNS records required for validation. */
	public readonly dnsRequirements: pulumi.Output<FlyDnsRequirements>;

	constructor(
		name: string,
		args: FlyCertificateArgs,
		opts: FlyCertificateOptions,
	) {
		const { provider, app, ...pulumiOpts } = opts;

		super("infracraft:fly:Certificate", name, {}, pulumiOpts);

		const resource = new FlyCertificateResource(
			`${name}-resource`,
			{
				token: provider.token,
				appName: app.id,
				hostname: args.hostname,
			},
			{ parent: this },
		);

		this.id = pulumi.output(args.hostname);
		this.configured = resource.configured;
		this.dnsRequirements = resource.dnsRequirements;

		this.registerOutputs({
			id: this.id,
			configured: this.configured,
			dnsRequirements: this.dnsRequirements,
		});
	}
}
