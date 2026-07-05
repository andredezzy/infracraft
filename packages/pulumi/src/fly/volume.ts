import * as pulumi from "@pulumi/pulumi";

import { ApiNotFoundError } from "../errors/api-not-found-error";
import type { FlyApp } from "./app";
import { FlyClient } from "./client";
import type { FlyProvider } from "./provider";

/** Resolved inputs for the Fly volume dynamic provider. */
interface FlyVolumeInputs {
	/** Fly API token. */
	token: string;

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
interface FlyVolumeOutputs extends FlyVolumeInputs {
	/** Fly-assigned volume ID (`vol_…`). */
	volumeId: string;
}

/** Volume response (only the fields we read). */
interface FlyVolumeResponse {
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
export class FlyVolumeResourceProvider
	implements pulumi.dynamic.ResourceProvider
{
	/**
	 * Validates inputs at plan time. A non-positive or fractional `sizeGb`
	 * would otherwise fail deep inside the volumes API with an opaque error.
	 * A preview-unknown value arrives as Pulumi's string sentinel, so the
	 * `typeof` guard skips it.
	 */
	async check(
		_olds: FlyVolumeInputs,
		news: FlyVolumeInputs,
	): Promise<pulumi.dynamic.CheckResult<FlyVolumeInputs>> {
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

	async create(inputs: FlyVolumeInputs): Promise<pulumi.dynamic.CreateResult> {
		const client = new FlyClient(inputs.token);

		const volumes = await client.get<FlyVolumeResponse[]>(
			`/v1/apps/${inputs.appName}/volumes`,
		);

		const existing = volumes.find(
			(volume) => volume.name === inputs.name && volume.state !== "destroyed",
		);

		let volumeId: string;

		if (existing) {
			pulumi.log.info(
				`Adopting existing Fly volume "${inputs.name}" (${existing.id})`,
			);

			volumeId = existing.id;
		} else {
			const created = await client.post<FlyVolumeResponse>(
				`/v1/apps/${inputs.appName}/volumes`,
				{
					name: inputs.name,
					region: inputs.region,
					size_gb: inputs.sizeGb,
					encrypted: true,
				},
			);

			volumeId = created.id;
		}

		const outs: FlyVolumeOutputs = { ...inputs, volumeId };

		return { id: volumeId, outs };
	}

	async read(
		id: string,
		props: FlyVolumeOutputs,
	): Promise<pulumi.dynamic.ReadResult> {
		const client = new FlyClient(props.token);

		const volume = await client.tryGet<FlyVolumeResponse>(
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
		olds: FlyVolumeOutputs,
		news: FlyVolumeInputs,
	): Promise<pulumi.dynamic.UpdateResult> {
		if (news.sizeGb > olds.sizeGb) {
			const client = new FlyClient(news.token);

			await client.put(`/v1/apps/${news.appName}/volumes/${id}/extend`, {
				size_gb: news.sizeGb,
			});
		}

		return { outs: { ...news, volumeId: id } };
	}

	async delete(id: string, props: FlyVolumeOutputs): Promise<void> {
		const client = new FlyClient(props.token);

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
		olds: FlyVolumeOutputs,
		news: FlyVolumeInputs,
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
class FlyVolumeResource extends pulumi.dynamic.Resource {
	public declare readonly volumeId: pulumi.Output<string>;

	constructor(
		name: string,
		args: {
			token: pulumi.Input<string>;
			appName: pulumi.Input<string>;
			name: pulumi.Input<string>;
			region: pulumi.Input<string>;
			sizeGb: pulumi.Input<number>;
		},
		opts?: pulumi.CustomResourceOptions,
	) {
		super(
			new FlyVolumeResourceProvider(),
			name,
			{ ...args, volumeId: undefined },
			// The API token flows into dynamic-provider state with the outputs — mark it secret there.
			{ ...opts, additionalSecretOutputs: ["token"] },
		);
	}
}

/** Options type for FlyVolume. */
type FlyVolumeOptions = Omit<pulumi.ComponentResourceOptions, "provider"> & {
	/** Fly authentication context. */
	provider: FlyProvider;

	/** App the volume belongs to. */
	app: FlyApp;
};

/** Args for FlyVolume. */
export interface FlyVolumeArgs {
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
 * const volume = new FlyVolume("api-data", {
 *   name: "data",
 *   region: "iad",
 *   sizeGb: 10,
 * }, { provider, app });
 * ```
 */
export class FlyVolume extends pulumi.ComponentResource {
	/** Fly-assigned volume ID. */
	public readonly id: pulumi.Output<string>;

	constructor(name: string, args: FlyVolumeArgs, opts: FlyVolumeOptions) {
		const { provider, app, ...pulumiOpts } = opts;

		super("infracraft:fly:Volume", name, {}, pulumiOpts);

		const resource = new FlyVolumeResource(
			`${name}-resource`,
			{
				token: provider.token,
				appName: app.id,
				...args,
			},
			{ parent: this },
		);

		this.id = resource.volumeId;

		this.registerOutputs({ id: this.id });
	}
}
