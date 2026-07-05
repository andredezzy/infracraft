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

		it("applies source to the target environment's instance and deploys an adopted image service", async () => {
			// Regression: source only lands on the DEFAULT environment via
			// ServiceCreateInput; an adopted image service in another environment
			// has source=null and stays undeployed forever (private DNS never
			// registers) unless the provider applies source per instance and
			// triggers the deploy itself.
			mockQuery.mockResolvedValue({
				project: {
					services: { edges: [{ node: { id: "svc-redis", name: "Redis" } }] },
				},
				serviceInstanceUpdate: true,
				serviceInstanceDeployV2: "dep-1",
			});

			const provider = new RailwayServiceResourceProvider();

			await provider.create({
				token: "tok",
				projectId: "proj-123",
				environmentId: "env-staging",
				name: "Redis",
				source: { image: "redis:8-alpine" },
				startCommand: "redis-server --requirepass hunter2",
			});

			const instanceUpdate = mockQuery.mock.calls.find(([mutation]) =>
				mutation.includes("serviceInstanceUpdate"),
			);

			expect(instanceUpdate).toBeDefined();
			expect(instanceUpdate?.[1].environmentId).toBe("env-staging");

			expect(instanceUpdate?.[1].input.source).toEqual({
				image: "redis:8-alpine",
			});

			expect(instanceUpdate?.[1].input.startCommand).toBe(
				"redis-server --requirepass hunter2",
			);

			const deploy = mockQuery.mock.calls.find(([mutation]) =>
				mutation.includes("serviceInstanceDeployV2"),
			);

			expect(deploy).toBeDefined();

			expect(deploy?.[1]).toEqual({
				serviceId: "svc-redis",
				environmentId: "env-staging",
			});
		});

		it("does not trigger a deploy for code-sourced services", async () => {
			// Code services deploy via RailwayDeploy (`railway up`); the provider
			// deploying them here would ship an empty build.
			mockQuery.mockResolvedValue({
				project: {
					services: { edges: [{ node: { id: "svc-api", name: "api" } }] },
				},
				serviceInstanceUpdate: true,
			});

			const provider = new RailwayServiceResourceProvider();

			await provider.create({
				token: "tok",
				projectId: "proj-123",
				environmentId: "env-staging",
				name: "api",
				startCommand: "bun start",
			});

			const deploy = mockQuery.mock.calls.find(([mutation]) =>
				mutation.includes("serviceInstanceDeployV2"),
			);

			expect(deploy).toBeUndefined();
		});
	});

	describe("update", () => {
		it("re-applies instance config and redeploys an image service", async () => {
			mockQuery.mockResolvedValue({
				serviceInstanceUpdate: true,
				serviceInstanceDeployV2: "dep-2",
			});

			const provider = new RailwayServiceResourceProvider();

			await provider.update(
				"svc-redis",
				{
					token: "tok",
					projectId: "proj-123",
					environmentId: "env-staging",
					name: "Redis",
					serviceId: "svc-redis",
				},
				{
					token: "tok",
					projectId: "proj-123",
					environmentId: "env-staging",
					name: "Redis",
					source: { image: "redis:8-alpine" },
					startCommand: "redis-server --requirepass hunter2",
				},
			);

			const instanceUpdate = mockQuery.mock.calls.find(([mutation]) =>
				mutation.includes("serviceInstanceUpdate"),
			);

			expect(instanceUpdate?.[1].input.source).toEqual({
				image: "redis:8-alpine",
			});

			const deploy = mockQuery.mock.calls.find(([mutation]) =>
				mutation.includes("serviceInstanceDeployV2"),
			);

			expect(deploy).toBeDefined();
		});
	});
});
