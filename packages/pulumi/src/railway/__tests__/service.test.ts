import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RailwayClient } from "../client";
import { RailwayServiceResourceProvider } from "../service";

describe("RailwayServiceResourceProvider", () => {
	let mockQuery: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		mockQuery = vi.fn();
		vi.spyOn(RailwayClient.prototype, "query").mockImplementation(mockQuery);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe("create", () => {
		it("adopts an existing service by name without calling serviceCreate", async () => {
			mockQuery.mockResolvedValueOnce({
				project: {
					services: { edges: [{ node: { id: "svc-uuid", name: "api" } }] },
				},
			});

			const provider = new RailwayServiceResourceProvider();

			const result = await provider.create({
				token: "tok",
				projectId: "proj-123",
				environmentId: "env-staging",
				name: "api",
			});

			expect(result.id).toBe("svc-uuid");
			expect(mockQuery).toHaveBeenCalledTimes(1); // no serviceCreate
		});

		it("scopes serviceCreate to the target environment when not found", async () => {
			mockQuery
				.mockResolvedValueOnce({ project: { services: { edges: [] } } }) // find: not found
				.mockResolvedValueOnce({
					serviceCreate: { id: "svc-new-uuid", name: "api" },
				}); // create

			const provider = new RailwayServiceResourceProvider();

			const result = await provider.create({
				token: "tok",
				projectId: "proj-123",
				environmentId: "env-staging",
				name: "api",
			});

			expect(result.id).toBe("svc-new-uuid");
			const [mutation, variables] = mockQuery.mock.calls[1];
			expect(mutation).toContain("serviceCreate");
			expect(variables.input.projectId).toBe("proj-123");
			expect(variables.input.name).toBe("api");
			expect(variables.input.environmentId).toBe("env-staging");
		});
	});
});
