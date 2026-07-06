import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RailwayClient } from "../client";
import { RailwayEnvironmentResourceProvider } from "../environment";

describe("RailwayEnvironmentResourceProvider", () => {
	let mockQuery: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		mockQuery = vi.fn();
		vi.spyOn(RailwayClient.prototype, "query").mockImplementation(mockQuery);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe("check", () => {
		it("fails an empty environment name, naming the property", async () => {
			const invalid = { token: "tok", projectId: "proj-abc", name: "  " };

			const result = await new RailwayEnvironmentResourceProvider().check(
				invalid,
				invalid,
			);

			expect(result.failures).toHaveLength(1);
			expect(result.failures?.[0].property).toBe("name");
			expect(result.failures?.[0].reason).toContain("non-empty");
		});

		it("passes a non-empty name through untouched", async () => {
			const valid = { token: "tok", projectId: "proj-abc", name: "production" };

			const result = await new RailwayEnvironmentResourceProvider().check(
				valid,
				valid,
			);

			expect(result.failures).toEqual([]);
		});
	});

	describe("create", () => {
		it("adopts an existing environment when found by name", async () => {
			mockQuery.mockResolvedValue({
				project: {
					environments: {
						edges: [{ node: { id: "env-prod-uuid", name: "production" } }],
					},
				},
			});

			const provider = new RailwayEnvironmentResourceProvider();

			const result = await provider.create({
				token: "tok",
				projectId: "proj-123",
				name: "production",
			});

			expect(result.id).toBe("env-prod-uuid");
			expect(mockQuery).toHaveBeenCalledTimes(1); // no environmentCreate
		});

		it("creates a plain environment when not found and no source given", async () => {
			mockQuery
				.mockResolvedValueOnce({ project: { environments: { edges: [] } } }) // find: not found
				.mockResolvedValueOnce({
					environmentCreate: { id: "env-new-uuid", name: "staging" },
				}); // create

			const provider = new RailwayEnvironmentResourceProvider();

			const result = await provider.create({
				token: "tok",
				projectId: "proj-123",
				name: "staging",
			});

			expect(result.id).toBe("env-new-uuid");
			expect(mockQuery).toHaveBeenCalledTimes(2);
			const [mutation, variables] = mockQuery.mock.calls[1];
			expect(mutation).toContain("environmentCreate");
			expect(variables.input.name).toBe("staging");
			expect(variables.input.projectId).toBe("proj-123");
			expect(variables.input.sourceEnvironmentId).toBeUndefined();
			expect(variables.input.skipInitialDeploys).toBe(true);
		});

		it("creates a forked environment (sourceEnvironmentId) when source is provided", async () => {
			mockQuery
				.mockResolvedValueOnce({ project: { environments: { edges: [] } } }) // find staging: not found
				.mockResolvedValueOnce({
					project: {
						environments: {
							edges: [{ node: { id: "env-prod-uuid", name: "production" } }],
						},
					},
				}) // resolve source
				.mockResolvedValueOnce({
					environmentCreate: { id: "env-staging-uuid", name: "staging" },
				}); // create forked

			const provider = new RailwayEnvironmentResourceProvider();

			const result = await provider.create({
				token: "tok",
				projectId: "proj-123",
				name: "staging",
				source: "production",
			});

			expect(result.id).toBe("env-staging-uuid");
			const [mutation, variables] = mockQuery.mock.calls[2];
			expect(mutation).toContain("environmentCreate");
			expect(variables.input.sourceEnvironmentId).toBe("env-prod-uuid");
			expect(variables.input.skipInitialDeploys).toBe(true);
		});

		it("throws when the source environment name cannot be resolved", async () => {
			mockQuery
				.mockResolvedValueOnce({ project: { environments: { edges: [] } } }) // staging not found
				.mockResolvedValueOnce({ project: { environments: { edges: [] } } }); // source lookup: not found

			const provider = new RailwayEnvironmentResourceProvider();

			await expect(
				provider.create({
					token: "tok",
					projectId: "proj-123",
					name: "staging",
					source: "nonexistent",
				}),
			).rejects.toThrow('Railway source environment "nonexistent" not found');
		});
	});

	describe("read", () => {
		it("returns a blank ReadResult when the environment is gone (deleted out of band)", async () => {
			mockQuery.mockResolvedValue({ project: { environments: { edges: [] } } });

			const result = await new RailwayEnvironmentResourceProvider().read(
				"env-staging-uuid",
				{
					token: "tok",
					projectId: "proj-123",
					name: "staging",
					environmentId: "env-staging-uuid",
				},
			);

			expect(result).toEqual({});
		});

		it("refreshes the environment id when it still exists", async () => {
			mockQuery.mockResolvedValue({
				project: {
					environments: {
						edges: [{ node: { id: "env-staging-uuid", name: "staging" } }],
					},
				},
			});

			const result = await new RailwayEnvironmentResourceProvider().read(
				"env-staging-uuid",
				{
					token: "tok",
					projectId: "proj-123",
					name: "staging",
					environmentId: "env-staging-uuid",
				},
			);

			expect(result.id).toBe("env-staging-uuid");
		});
	});

	describe("delete", () => {
		it("deletes the environment via environmentDelete", async () => {
			mockQuery.mockResolvedValue({});

			await new RailwayEnvironmentResourceProvider().delete("env-feature", {
				token: "tok",
				projectId: "proj-123",
				name: "feature",
				environmentId: "env-feature",
			});

			expect(mockQuery).toHaveBeenCalledTimes(1);
			const [mutation, vars] = mockQuery.mock.calls[0];
			expect(mutation).toContain("environmentDelete");
			expect(vars).toEqual({ id: "env-feature" });
		});

		it("tolerates an already-deleted environment (not-found)", async () => {
			mockQuery.mockRejectedValue(new Error("Environment not found"));

			await expect(
				new RailwayEnvironmentResourceProvider().delete("env-feature", {
					token: "tok",
					projectId: "proj-123",
					name: "feature",
					environmentId: "env-feature",
				}),
			).resolves.toBeUndefined();
		});

		it("rethrows a real error", async () => {
			mockQuery.mockRejectedValue(new Error("forbidden"));

			await expect(
				new RailwayEnvironmentResourceProvider().delete("env-feature", {
					token: "tok",
					projectId: "proj-123",
					name: "feature",
					environmentId: "env-feature",
				}),
			).rejects.toThrow("forbidden");
		});
	});
});
