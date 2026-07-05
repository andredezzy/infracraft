import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RailwayClient } from "../client";
import { RailwayServiceResourceProvider } from "../service";

describe("RailwayServiceResourceProvider", () => {
	let mockQuery: ReturnType<typeof vi.fn>;

	/**
	 * Routes the instance-existence probe (serviceInstance query) to `exists`
	 * while delegating everything else to `rest` — every create/update path now
	 * runs ensureServiceInstance before touching instance config.
	 */
	function mockWithInstance(
		exists: boolean,
		rest: (mutation: string) => unknown,
	) {
		mockQuery.mockImplementation(async (mutation: string) => {
			if (mutation.includes("serviceInstance(")) {
				return { serviceInstance: exists ? { id: "si-1" } : null };
			}

			return rest(mutation);
		});
	}

	beforeEach(() => {
		mockQuery = vi.fn();
		vi.spyOn(RailwayClient.prototype, "query").mockImplementation(mockQuery);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe("create", () => {
		it("adopts an existing service by name without calling serviceCreate", async () => {
			mockWithInstance(true, () => ({
				project: {
					services: { edges: [{ node: { id: "svc-uuid", name: "api" } }] },
				},
			}));

			const provider = new RailwayServiceResourceProvider();

			const result = await provider.create({
				token: "tok",
				projectId: "proj-123",
				environmentId: "env-staging",
				name: "api",
			});

			expect(result.id).toBe("svc-uuid");

			const create = mockQuery.mock.calls.find(([mutation]) =>
				mutation.includes("serviceCreate"),
			);

			expect(create).toBeUndefined();
		});

		it("scopes serviceCreate to the target environment when not found", async () => {
			mockWithInstance(true, (mutation) =>
				mutation.includes("serviceCreate")
					? { serviceCreate: { id: "svc-new-uuid", name: "api" } }
					: { project: { services: { edges: [] } } },
			);

			const provider = new RailwayServiceResourceProvider();

			const result = await provider.create({
				token: "tok",
				projectId: "proj-123",
				environmentId: "env-staging",
				name: "api",
			});

			expect(result.id).toBe("svc-new-uuid");

			const createCall = mockQuery.mock.calls.find(([mutation]) =>
				mutation.includes("serviceCreate"),
			);

			expect(createCall?.[1].input.projectId).toBe("proj-123");
			expect(createCall?.[1].input.name).toBe("api");
			expect(createCall?.[1].input.environmentId).toBe("env-staging");
		});

		it("unskips the service when the target environment has no instance", async () => {
			// Regression (live incident): serviceCreate materializes an instance
			// only in its own environment; elsewhere the service is "skipped" —
			// serviceInstanceUpdate returns true as a silent no-op and `railway up`
			// fails with UPLOAD_FAILED 404. The provider must unskip first.
			let unskipped = false;

			mockQuery.mockImplementation(async (mutation: string) => {
				if (mutation.includes("serviceInstance(")) {
					return { serviceInstance: unskipped ? { id: "si-new" } : null };
				}

				if (mutation.includes("environmentUnskipService")) {
					unskipped = true;

					return { environmentUnskipService: true };
				}

				return {
					project: {
						services: { edges: [{ node: { id: "svc-mesh", name: "api" } }] },
					},
					serviceInstanceUpdate: true,
				};
			});

			const provider = new RailwayServiceResourceProvider();

			await provider.create({
				token: "tok",
				projectId: "proj-123",
				environmentId: "env-production",
				name: "api",
				startCommand: "bun start",
			});

			const unskip = mockQuery.mock.calls.find(([mutation]) =>
				mutation.includes("environmentUnskipService"),
			);

			expect(unskip?.[1]).toEqual({
				serviceId: "svc-mesh",
				environmentId: "env-production",
			});
		});

		it("throws loudly when the instance is still missing after unskip", async () => {
			mockQuery.mockImplementation(async (mutation: string) => {
				if (mutation.includes("serviceInstance(")) {
					return { serviceInstance: null };
				}

				if (mutation.includes("environmentUnskipService")) {
					return { environmentUnskipService: true };
				}

				return {
					project: {
						services: { edges: [{ node: { id: "svc-mesh", name: "api" } }] },
					},
				};
			});

			const provider = new RailwayServiceResourceProvider();

			await expect(
				provider.create({
					token: "tok",
					projectId: "proj-123",
					environmentId: "env-production",
					name: "api",
				}),
			).rejects.toThrow(/still has no instance/);
		});

		it("applies source to the target environment's instance and deploys an adopted image service", async () => {
			// Regression: source only lands on the DEFAULT environment via
			// ServiceCreateInput; an adopted image service in another environment
			// has source=null and stays undeployed forever (private DNS never
			// registers) unless the provider applies source per instance and
			// triggers the deploy itself.
			mockWithInstance(true, () => ({
				project: {
					services: { edges: [{ node: { id: "svc-redis", name: "Redis" } }] },
				},
				serviceInstanceUpdate: true,
				serviceInstanceDeployV2: "dep-1",
			}));

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
			mockWithInstance(true, () => ({
				project: {
					services: { edges: [{ node: { id: "svc-api", name: "api" } }] },
				},
				serviceInstanceUpdate: true,
			}));

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

	describe("check", () => {
		it("passes valid inputs through untouched", async () => {
			const provider = new RailwayServiceResourceProvider();

			const inputs = {
				token: "tok",
				projectId: "proj-123",
				environmentId: "env-staging",
				name: "Redis",
				source: { image: "redis:8-alpine" },
			};

			const result = await provider.check(inputs, inputs);

			expect(result.inputs).toEqual(inputs);
			expect(result.failures).toEqual([]);
		});

		it("fails an empty source.image, naming the property", async () => {
			const provider = new RailwayServiceResourceProvider();

			const inputs = {
				token: "tok",
				projectId: "proj-123",
				environmentId: "env-staging",
				name: "Redis",
				source: { image: "  " },
			};

			const result = await provider.check(inputs, inputs);

			expect(result.failures).toHaveLength(1);
			expect(result.failures?.[0].property).toBe("source.image");
			expect(result.failures?.[0].reason).toContain("non-empty");
		});
	});

	describe("diff", () => {
		const olds = {
			token: "tok",
			projectId: "proj-123",
			environmentId: "env-staging",
			name: "api",
			serviceId: "svc-uuid",
		};

		it("declares serviceId stable on in-place updates", async () => {
			// The live pain: without stables, a startCommand tweak made dependents
			// (RailwayVolume) see serviceId as unknown during preview and show a
			// phantom replace.
			const provider = new RailwayServiceResourceProvider();

			const diff = await provider.diff("svc-uuid", olds, {
				...olds,
				startCommand: "bun start",
			});

			expect(diff.changes).toBe(true);
			expect(diff.replaces).toEqual([]);
			expect(diff.stables).toEqual(["serviceId"]);
		});

		it("declares no stables when an identity change forces a replace", async () => {
			const provider = new RailwayServiceResourceProvider();

			const diff = await provider.diff("svc-uuid", olds, {
				...olds,
				environmentId: "env-production",
			});

			expect(diff.replaces).toEqual(["environmentId"]);
			expect(diff.stables).toEqual([]);
		});
	});

	describe("update", () => {
		it("re-applies instance config and redeploys an image service", async () => {
			mockWithInstance(true, () => ({
				serviceInstanceUpdate: true,
				serviceInstanceDeployV2: "dep-2",
			}));

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
