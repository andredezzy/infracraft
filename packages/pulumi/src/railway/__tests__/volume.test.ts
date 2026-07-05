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
									edges: [{ node: { serviceId: "svc-redis" } }],
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
									edges: [{ node: { serviceId: "svc-redis" } }],
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
