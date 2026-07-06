import * as pulumi from "@pulumi/pulumi";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RailwayClient } from "../client";
import { RailwayVolumeResourceProvider } from "../volume";

const props = {
	token: "tok",
	projectId: "proj-1",
	serviceId: "svc-redis",
	environmentId: "env-staging",
	mountPath: "/data",
	volumeId: "vol-existing",
};

describe("RailwayVolumeResourceProvider.check", () => {
	const { volumeId: _ignored, ...inputs } = props;

	it("passes an absolute mountPath through untouched", async () => {
		const result = await new RailwayVolumeResourceProvider().check(
			inputs,
			inputs,
		);

		expect(result.inputs).toEqual(inputs);
		expect(result.failures).toEqual([]);
	});

	it("fails a relative mountPath, naming the property", async () => {
		const invalid = { ...inputs, mountPath: "data" };

		const result = await new RailwayVolumeResourceProvider().check(
			invalid,
			invalid,
		);

		expect(result.failures).toHaveLength(1);
		expect(result.failures?.[0].property).toBe("mountPath");
		expect(result.failures?.[0].reason).toContain("absolute path");
	});

	it("skips validation for a preview-unknown mountPath", async () => {
		// During preview, an input fed by another resource's output arrives as
		// Pulumi's unknown sentinel — check() must not fail on it.
		const unresolved = { ...inputs, mountPath: pulumi.runtime.unknownValue };

		const result = await new RailwayVolumeResourceProvider().check(
			unresolved,
			unresolved,
		);

		expect(result.failures).toEqual([]);
	});
});

describe("RailwayVolumeResourceProvider.create", () => {
	let mockQuery: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		mockQuery = vi.fn();
		vi.spyOn(RailwayClient.prototype, "query").mockImplementation(mockQuery);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("redeploys the service instance after attaching a new volume", async () => {
		// The mount only lands on the NEXT deployment — attach alone changes
		// nothing for a running service.
		mockQuery.mockResolvedValue({
			project: { volumes: { edges: [] } },
			volumeCreate: { id: "vol-new" },
			serviceInstanceDeployV2: "dep-3",
		});

		const provider = new RailwayVolumeResourceProvider();
		const { volumeId: _ignored, ...inputs } = props;

		await provider.create(inputs);

		const deploy = mockQuery.mock.calls.find(([mutation]) =>
			mutation.includes("serviceInstanceDeployV2"),
		);

		expect(deploy).toBeDefined();

		expect(deploy?.[1]).toEqual({
			serviceId: "svc-redis",
			environmentId: "env-staging",
		});
	});

	it("does not redeploy when adopting an already-attached volume", async () => {
		mockQuery.mockResolvedValue({
			project: {
				volumes: {
					edges: [
						{
							node: {
								id: "vol-existing",
								volumeInstances: {
									edges: [
										{
											node: {
												serviceId: "svc-redis",
												environmentId: "env-staging",
											},
										},
									],
								},
							},
						},
					],
				},
			},
		});

		const provider = new RailwayVolumeResourceProvider();
		const { volumeId: _ignored, ...inputs } = props;

		await provider.create(inputs);

		const deploy = mockQuery.mock.calls.find(([mutation]) =>
			mutation.includes("serviceInstanceDeployV2"),
		);

		expect(deploy).toBeUndefined();
	});

	it("does NOT adopt a sibling environment's volume for the shared service", async () => {
		// Regression (live incident): services are project-level, so matching by
		// service alone made the production stack adopt STAGING's volume — either
		// data mixing or no persistence at all. A volume instance must match BOTH
		// serviceId and environmentId; otherwise create a fresh volume.
		mockQuery.mockImplementation(async (mutation: string) => {
			if (mutation.includes("volumeCreate")) {
				return { volumeCreate: { id: "vol-production" } };
			}

			if (mutation.includes("serviceInstanceDeployV2")) {
				return { serviceInstanceDeployV2: "dep-4" };
			}

			return {
				project: {
					volumes: {
						edges: [
							{
								node: {
									id: "vol-staging",
									volumeInstances: {
										edges: [
											{
												node: {
													serviceId: "svc-redis",
													environmentId: "env-staging",
												},
											},
										],
									},
								},
							},
						],
					},
				},
			};
		});

		const provider = new RailwayVolumeResourceProvider();
		const { volumeId: _ignored, ...inputs } = props;

		const result = await provider.create({
			...inputs,
			environmentId: "env-production",
		});

		expect(result.id).toBe("vol-production");

		const create = mockQuery.mock.calls.find(([mutation]) =>
			mutation.includes("volumeCreate"),
		);

		expect(create?.[1].input.environmentId).toBe("env-production");
	});

	it("tolerates a failing post-attach redeploy (service not deployable yet)", async () => {
		mockQuery.mockImplementation(async (mutation: string) => {
			if (mutation.includes("serviceInstanceDeployV2")) {
				throw new Error("no deployable source");
			}

			return {
				project: { volumes: { edges: [] } },
				volumeCreate: { id: "vol-new" },
			};
		});

		const provider = new RailwayVolumeResourceProvider();
		const { volumeId: _ignored, ...inputs } = props;

		await expect(provider.create(inputs)).resolves.toMatchObject({
			id: "vol-new",
		});
	});
});

describe("RailwayVolumeResourceProvider.read (refresh)", () => {
	let mockQuery: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		mockQuery = vi.fn();
		vi.spyOn(RailwayClient.prototype, "query").mockImplementation(mockQuery);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("returns the resolved id when the volume is found by service", async () => {
		mockQuery.mockResolvedValueOnce({
			project: {
				volumes: {
					edges: [
						{
							node: {
								id: "vol-found",
								volumeInstances: {
									edges: [
										{
											node: {
												serviceId: "svc-redis",
												environmentId: "env-staging",
											},
										},
									],
								},
							},
						},
					],
				},
			},
		});

		const result = await new RailwayVolumeResourceProvider().read(
			"vol-x",
			props,
		);

		expect(result.id).toBe("vol-found");
		expect(result.props?.volumeId).toBe("vol-found");
	});

	it("does NOT throw on an inconclusive lookup — falls back to the stored id", async () => {
		// Volume physically present but the project query returns no matching
		// instance (eventual consistency / environment-scoped instances).
		mockQuery.mockResolvedValueOnce({ project: { volumes: { edges: [] } } });

		const result = await new RailwayVolumeResourceProvider().read(
			"vol-x",
			props,
		);

		expect(result.id).toBe("vol-existing"); // stored volumeId, not a throw
		expect(result.props?.volumeId).toBe("vol-existing");
	});

	it("does NOT throw when the lookup itself errors — keeps existing state", async () => {
		mockQuery.mockRejectedValueOnce(new Error("Railway API 500"));

		const result = await new RailwayVolumeResourceProvider().read(
			"vol-x",
			props,
		);

		expect(result.id).toBe("vol-existing");
		expect(result.props?.volumeId).toBe("vol-existing");
	});
});

describe("RailwayVolumeResourceProvider.delete", () => {
	let mockQuery: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		mockQuery = vi.fn();
		vi.spyOn(RailwayClient.prototype, "query").mockImplementation(mockQuery);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("tolerates an already-deleted volume (not-found)", async () => {
		mockQuery.mockRejectedValueOnce(new Error("Volume not found"));

		await expect(
			new RailwayVolumeResourceProvider().delete("vol-existing", props),
		).resolves.toBeUndefined();
	});

	it("rethrows a real error", async () => {
		mockQuery.mockRejectedValueOnce(new Error("forbidden"));

		await expect(
			new RailwayVolumeResourceProvider().delete("vol-existing", props),
		).rejects.toThrow("forbidden");
	});
});
