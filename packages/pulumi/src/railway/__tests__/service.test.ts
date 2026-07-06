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
		vi.unstubAllEnvs();
	});

	describe("provider credentials", () => {
		it("resolves the API token from the env var named by tokenEnvVar", async () => {
			vi.stubEnv("INFRACRAFT_TEST_RAILWAY_TOKEN", "env-tok");

			const seenTokens: string[] = [];

			mockQuery.mockImplementation(async function (
				this: unknown,
				mutation: string,
			) {
				seenTokens.push((this as { token: string }).token);

				if (mutation.includes("serviceInstance(")) {
					return { serviceInstance: { id: "si-1" } };
				}

				return {
					project: {
						services: { edges: [{ node: { id: "svc-uuid", name: "api" } }] },
					},
				};
			});

			const provider = new RailwayServiceResourceProvider();

			await provider.create({
				tokenEnvVar: "INFRACRAFT_TEST_RAILWAY_TOKEN",
				projectId: "proj-123",
				environmentId: "env-staging",
				name: "api",
			});

			expect(seenTokens[0]).toBe("env-tok");
		});

		it("throws a loud error naming the env var when it is not set", async () => {
			const provider = new RailwayServiceResourceProvider();

			await expect(
				provider.create({
					tokenEnvVar: "INFRACRAFT_TEST_RAILWAY_TOKEN_UNSET",
					projectId: "proj-123",
					environmentId: "env-staging",
					name: "api",
				}),
			).rejects.toThrow(
				"provider credential env var INFRACRAFT_TEST_RAILWAY_TOKEN_UNSET is not set in the Pulumi execution environment",
			);
		});
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

		it("materializes the instance via a config-patch commit when the target environment lacks one", async () => {
			// Regression (live incident): serviceCreate materializes an instance
			// only in its own environment; elsewhere the service is "skipped" —
			// serviceInstanceUpdate returns true as a silent no-op and `railway up`
			// fails with UPLOAD_FAILED 404. environmentUnskipService is rejected for
			// named environments, so materialization is a staged config-patch commit.
			let materialized = false;

			mockQuery.mockImplementation(async (mutation: string) => {
				if (mutation.includes("serviceInstance(")) {
					return { serviceInstance: materialized ? { id: "si-new" } : null };
				}

				if (mutation.includes("environmentPatchCommit")) {
					materialized = true;

					return { environmentPatchCommit: "commit-1" };
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

			const patch = mockQuery.mock.calls.find(([mutation]) =>
				mutation.includes("environmentPatchCommit"),
			);

			expect(patch?.[1].environmentId).toBe("env-production");
			expect(patch?.[1].patch).toEqual({ services: { "svc-mesh": {} } });
		});

		it("throws loudly when the instance is still missing after the patch commit", async () => {
			mockQuery.mockImplementation(async (mutation: string) => {
				if (mutation.includes("serviceInstance(")) {
					return { serviceInstance: null };
				}

				if (mutation.includes("environmentPatchCommit")) {
					return { environmentPatchCommit: "commit-1" };
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

		it("re-applies dropped healthcheck fields after deploying an image service", async () => {
			// Live drill finding: a FRESH instance with no deployment rejects
			// healthcheckPath with "Invalid input". The first attempt still carries
			// the fields (steady-state instances accept them); on rejection they are
			// dropped, the deploy runs, and ONLY the healthcheck fields are
			// re-applied — never silently lost.
			const instanceUpdates: Array<Record<string, unknown>> = [];

			mockQuery.mockImplementation(
				async (mutation: string, variables?: Record<string, unknown>) => {
					if (mutation.includes("serviceInstance(")) {
						return { serviceInstance: { id: "si-1" } };
					}

					if (mutation.includes("serviceInstanceUpdate")) {
						// Copy — the provider mutates the same input object when it
						// drops the healthcheck fields for the retry.
						instanceUpdates.push({
							...(variables as { input: Record<string, unknown> }).input,
						});

						if (instanceUpdates.length === 1) {
							throw new Error("Invalid input");
						}

						return { serviceInstanceUpdate: true };
					}

					if (mutation.includes("serviceInstanceDeployV2")) {
						return { serviceInstanceDeployV2: "dep-1" };
					}

					return {
						project: {
							services: {
								edges: [{ node: { id: "svc-redis", name: "Redis" } }],
							},
						},
					};
				},
			);

			const provider = new RailwayServiceResourceProvider();

			await provider.create({
				token: "tok",
				projectId: "proj-123",
				environmentId: "env-staging",
				name: "Redis",
				source: { image: "redis:8-alpine" },
				healthcheckPath: "/health",
				healthcheckTimeout: 300,
			});

			// First attempt carries the healthcheck fields (steady-state must not regress).
			expect(instanceUpdates[0].healthcheckPath).toBe("/health");

			// The retry drops them so the rest of the config lands.
			expect(instanceUpdates[1].healthcheckPath).toBeUndefined();

			// Post-deploy re-apply carries ONLY the healthcheck fields.
			expect(instanceUpdates[2]).toEqual({
				healthcheckPath: "/health",
				healthcheckTimeout: 300,
			});

			// The re-apply happens AFTER the deploy exists.
			const mutations = mockQuery.mock.calls.map(([mutation]) => mutation);

			const deployIndex = mutations.findIndex((mutation: string) =>
				mutation.includes("serviceInstanceDeployV2"),
			);

			const lastUpdateIndex = mutations.findLastIndex((mutation: string) =>
				mutation.includes("serviceInstanceUpdate"),
			);

			expect(deployIndex).toBeGreaterThan(-1);
			expect(lastUpdateIndex).toBeGreaterThan(deployIndex);
		});

		it("throws loudly when the post-deploy healthcheck re-apply also fails", async () => {
			let updateCalls = 0;

			mockQuery.mockImplementation(async (mutation: string) => {
				if (mutation.includes("serviceInstance(")) {
					return { serviceInstance: { id: "si-1" } };
				}

				if (mutation.includes("serviceInstanceUpdate")) {
					updateCalls++;

					// Call 2 is the retry without healthcheck fields — it succeeds;
					// calls 1 (with healthcheck) and 3 (healthcheck-only) reject.
					if (updateCalls === 2) {
						return { serviceInstanceUpdate: true };
					}

					throw new Error("Invalid input");
				}

				if (mutation.includes("serviceInstanceDeployV2")) {
					return { serviceInstanceDeployV2: "dep-1" };
				}

				return {
					project: {
						services: {
							edges: [{ node: { id: "svc-redis", name: "Redis" } }],
						},
					},
				};
			});

			const provider = new RailwayServiceResourceProvider();

			await expect(
				provider.create({
					token: "tok",
					projectId: "proj-123",
					environmentId: "env-staging",
					name: "Redis",
					source: { image: "redis:8-alpine" },
					healthcheckPath: "/health",
				}),
			).rejects.toThrow(/healthcheck config .* could not be applied/);
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

	describe("check (healthcheckPath)", () => {
		it("rejects a hyphenated healthcheckPath at plan time", async () => {
			const provider = new RailwayServiceResourceProvider();

			const inputs = {
				token: "tok",
				projectId: "proj-123",
				environmentId: "env-staging",
				name: "api",
				healthcheckPath: "/health-check",
			};

			const result = await provider.check(inputs, inputs);

			expect(result.failures).toHaveLength(1);
			expect(result.failures?.[0].property).toBe("healthcheckPath");
			expect(result.failures?.[0].reason).toContain("hyphen");
		});

		it("passes a hyphen-free healthcheckPath", async () => {
			const provider = new RailwayServiceResourceProvider();

			const inputs = {
				token: "tok",
				projectId: "proj-123",
				environmentId: "env-staging",
				name: "api",
				healthcheckPath: "/healthcheck",
			};

			const result = await provider.check(inputs, inputs);

			expect(result.failures).toEqual([]);
		});
	});

	describe("read", () => {
		const props = {
			token: "tok",
			projectId: "proj-123",
			environmentId: "env-staging",
			name: "api",
			serviceId: "svc-uuid",
		};

		it("returns a blank result when the service is gone (not-found)", async () => {
			mockQuery.mockRejectedValueOnce(new Error("Service not found"));

			const result = await new RailwayServiceResourceProvider().read(
				"svc-uuid",
				props,
			);

			expect(result).toEqual({});
		});

		it("rethrows a real error instead of dropping the service from state", async () => {
			mockQuery.mockRejectedValueOnce(
				new Error("Railway API error (401): unauthorized"),
			);

			await expect(
				new RailwayServiceResourceProvider().read("svc-uuid", props),
			).rejects.toThrow("401");
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

		it("flags an in-place change (no replace) when the image source bumps", async () => {
			const provider = new RailwayServiceResourceProvider();

			const diff = await provider.diff(
				"svc-uuid",
				{ ...olds, source: { image: "redis:8-alpine" } },
				{ ...olds, source: { image: "redis:8-alpine-slim" } },
			);

			expect(diff.changes).toBe(true);
			expect(diff.replaces).toEqual([]);
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
