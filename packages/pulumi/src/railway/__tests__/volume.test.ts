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
