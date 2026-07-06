import * as pulumi from "@pulumi/pulumi";

import { resolveCredential } from "../dynamic/resolve-credential";
import { ApiNotFoundError } from "../errors/api-not-found-error";
import type { App } from "./app";
import { Client } from "./client";
import type { Provider } from "./provider";

/** Resolved inputs for the Fly volume dynamic provider. */
interface VolumeInputs {
	/** Fly API token. Absent when `tokenEnvVar` is used instead. */
	token?: string;

	/** Env var name resolved to the token when `token` is absent (see `ProviderArgs.tokenEnvVar`). */
	tokenEnvVar?: string;

	/** App name the volume belongs to. */
	appName: string;

	/** Volume name (used for adoption lookup). */
	name: string;

	/** Region (IATA code). */
	region: string;

	/** Volume size in GB. */
	sizeGb: number;
}

/** Persisted state for the Fly volume. */
interface VolumeOutputs extends VolumeInputs {
	/** Fly-assigned volume ID (`vol_…`). */
	volumeId: string;
}

/** Volume response (only the fields we read). */
interface VolumeResponse {
	id: string;
	name: string;
	state: string;
	size_gb: number;
	region: string;
}

/**
 * Dynamic provider for Fly volumes. `create()` lists volumes and adopts one
 * matching the name (volume names are not unique, so it adopts the first
 * non-destroyed match); otherwise it creates a new encrypted volume. Growing
 * `sizeGb` extends in place; shrinking is not supported by Fly.
 *
 * @internal Exported only for unit testing; not part of the public API surface.
 */
export class VolumeResourceProvider implements pulumi.dynamic.ResourceProvider {
	/**
	 * Validates inputs at plan time. A non-positive or fractional `sizeGb`
	 * would otherwise fail deep inside the volumes API with an opaque error.
	 * A preview-unknown value arrives as Pulumi's string sentinel, so the
	 * `typeof` guard skips it.
	 */
	async check(
		_olds: VolumeInputs,
		news: VolumeInputs,
	): Promise<pulumi.dynamic.CheckResult<VolumeInputs>> {
		const failures: pulumi.dynamic.CheckFailure[] = [];

		if (
			typeof news.sizeGb === "number" &&
			(!Number.isInteger(news.sizeGb) || news.sizeGb <= 0)
		) {
			failures.push({
				property: "sizeGb",
				reason: `sizeGb must be a positive integer (whole GB), got ${news.sizeGb}`,
			});
		}

		return { inputs: news, failures };
	}

	async create(inputs: VolumeInputs): Promise<pulumi.dynamic.CreateResult> {
		const client = new Client(
			resolveCredential(inputs.token, inputs.tokenEnvVar),
		);

		const volumes = await client.get<VolumeResponse[]>(
			`/v1/apps/${inputs.appName}/volumes`,
		);

		const existing = volumes.find(
			(volume) => volume.name === inputs.name && volume.state !== "destroyed",
		);

		if (existing) {
			pulumi.log.info(
				`Adopting existing Fly volume "${inputs.name}" (${existing.id})`,
			);

			// Record the LIVE region/size, not the desired ones: adopting never
			// moves or resizes the volume, so writing the desired values here
			// would make Pulumi believe an unapplied change already landed,
			// masking real drift on the very next diff.
			const outs: VolumeOutputs = {
				...inputs,
				region: existing.region,
				sizeGb: existing.size_gb,
				volumeId: existing.id,
			};

			return { id: existing.id, outs };
		}

		const created = await client.post<VolumeResponse>(
			`/v1/apps/${inputs.appName}/volumes`,
			{
				name: inputs.name,
				region: inputs.region,
				size_gb: inputs.sizeGb,
				encrypted: true,
			},
		);

		const outs: VolumeOutputs = { ...inputs, volumeId: created.id };

		return { id: created.id, outs };
	}

	async read(
		id: string,
		props: VolumeOutputs,
	): Promise<pulumi.dynamic.ReadResult> {
		const client = new Client(
			resolveCredential(props.token, props.tokenEnvVar),
		);

		const volume = await client.tryGet<VolumeResponse>(
			`/v1/apps/${props.appName}/volumes/${id}`,
		);

		if (!volume) {
			// Resource gone → blank id lets refresh reconcile the deletion.
			return {};
		}

		return {
			id,
			props: {
				...props,
				name: volume.name,
				region: volume.region,
				sizeGb: volume.size_gb,
			},
		};
	}

	async update(
		id: string,
		olds: VolumeOutputs,
		news: VolumeInputs,
	): Promise<pulumi.dynamic.UpdateResult> {
		if (news.sizeGb > olds.sizeGb) {
			const client = new Client(
				resolveCredential(news.token, news.tokenEnvVar),
			);

			await client.put(`/v1/apps/${news.appName}/volumes/${id}/extend`, {
				size_gb: news.sizeGb,
			});
		}

		return { outs: { ...news, volumeId: id } };
	}

	async delete(id: string, props: VolumeOutputs): Promise<void> {
		const client = new Client(
			resolveCredential(props.token, props.tokenEnvVar),
		);

		try {
			await client.delete(`/v1/apps/${props.appName}/volumes/${id}`);
		} catch (error) {
			// Already gone — deletion is idempotent.
			if (error instanceof ApiNotFoundError) {
				pulumi.log.warn(`Fly volume "${id}" already deleted`);

				return;
			}

			throw error;
		}
	}

	async diff(
		_id: string,
		olds: VolumeOutputs,
		news: VolumeInputs,
	): Promise<pulumi.dynamic.DiffResult> {
		const replaces: string[] = [];

		if (olds.appName !== news.appName) {
			replaces.push("appName");
		}

		if (olds.name !== news.name) {
			replaces.push("name");
		}

		if (olds.region !== news.region) {
			replaces.push("region");
		}

		if (news.sizeGb < olds.sizeGb) {
			replaces.push("sizeGb");
		}

		const sizeGrew = news.sizeGb > olds.sizeGb;

		return {
			changes: replaces.length > 0 || sizeGrew,
			replaces,
			// volumeId survives an in-place extend (only appName/name/region/shrink
			// replace), so dependents keep a known volumeId during preview.
			stables: replaces.length === 0 ? ["volumeId"] : [],
			deleteBeforeReplace: true,
		};
	}
}

/** Internal dynamic resource — not part of the public API. */
class VolumeResource extends pulumi.dynamic.Resource {
	public declare readonly volumeId: pulumi.Output<string>;

	constructor(
		name: string,
		args: {
			token?: pulumi.Input<string>;
			tokenEnvVar?: pulumi.Input<string>;
			appName: pulumi.Input<string>;
			name: pulumi.Input<string>;
			region: pulumi.Input<string>;
			sizeGb: pulumi.Input<number>;
		},
		opts?: pulumi.CustomResourceOptions,
	) {
		super(
			new VolumeResourceProvider(),
			name,
			{ ...args, volumeId: undefined },
			// The API token flows into dynamic-provider state with the outputs — mark it secret there.
			{ ...opts, additionalSecretOutputs: ["token"] },
		);
	}
}

/** Options type for Volume. */
type VolumeOptions = Omit<pulumi.ComponentResourceOptions, "provider"> & {
	/** Fly authentication context. */
	provider: Provider;

	/** App the volume belongs to. */
	app: App;
};

/** Args for Volume. */
export interface VolumeArgs {
	/** Volume name. */
	name: pulumi.Input<string>;

	/** Region (IATA code, e.g. `"iad"`). */
	region: pulumi.Input<string>;

	/**
	 * Volume size in GB. Can be grown (extended) but not shrunk.
	 * Maps to the Fly Machines API field `size_gb`.
	 */
	sizeGb: pulumi.Input<number>;
}

/**
 * Manages a Fly volume with adopt-or-create semantics.
 *
 * @example
 * ```typescript
 * const volume = new fly.Volume("api-data", {
 *   name: "data",
 *   region: "iad",
 *   sizeGb: 10,
 * }, { provider, app });
 * ```
 */
export class Volume extends pulumi.ComponentResource {
	/** Fly-assigned volume ID. */
	public readonly id: pulumi.Output<string>;

	constructor(name: string, args: VolumeArgs, opts: VolumeOptions) {
		const { provider, app, ...pulumiOpts } = opts;

		super("infracraft:fly:Volume", name, {}, pulumiOpts);

		const resource = new VolumeResource(
			`${name}-resource`,
			{
				token: provider.token,
				tokenEnvVar: provider.tokenEnvVar,
				appName: app.id,
				...args,
			},
			// Forward the consumer's resource options (e.g. `retainOnDelete`) to the
			// underlying resource — Pulumi auto-inherits provider/protect from the
			// parent component, but not everything else.
			pulumi.mergeOptions(pulumiOpts, { parent: this }),
		);

		this.id = resource.volumeId;

		this.registerOutputs({ id: this.id });
	}
}
