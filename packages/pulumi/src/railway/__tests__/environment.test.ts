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

	describe("delete", () => {
		it("deletes an environment it created", async () => {
			mockQuery.mockResolvedValue({});

			await new RailwayEnvironmentResourceProvider().delete("env-feature", {
				token: "tok",
				projectId: "proj-123",
				name: "feature",
				environmentId: "env-feature",
				wasAdopted: false,
			});

			expect(mockQuery).toHaveBeenCalledTimes(1);
			const [mutation, vars] = mockQuery.mock.calls[0];
			expect(mutation).toContain("environmentDelete");
			expect(vars).toEqual({ id: "env-feature" });
		});

		it("skips deletion for an adopted environment", async () => {
			await new RailwayEnvironmentResourceProvider().delete("env-prod", {
				token: "tok",
				projectId: "proj-123",
				name: "production",
				environmentId: "env-prod",
				wasAdopted: true,
			});

			expect(mockQuery).not.toHaveBeenCalled();
		});

		it("skips deletion for legacy state without wasAdopted (safe default)", async () => {
			await new RailwayEnvironmentResourceProvider().delete("env-prod", {
				token: "tok",
				projectId: "proj-123",
				name: "production",
				environmentId: "env-prod",
			});

			expect(mockQuery).not.toHaveBeenCalled();
		});
	});
});
