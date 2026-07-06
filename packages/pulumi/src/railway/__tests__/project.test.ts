import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RailwayClient } from "../client";
import { RailwayProjectResourceProvider } from "../project";

describe("RailwayProjectResourceProvider", () => {
	let mockQuery: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		mockQuery = vi.fn();
		vi.spyOn(RailwayClient.prototype, "query").mockImplementation(mockQuery);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe("check", () => {
		it("fails an empty project name, naming the property", async () => {
			const invalid = { token: "tok", name: "  " };

			const result = await new RailwayProjectResourceProvider().check(
				invalid,
				invalid,
			);

			expect(result.failures).toHaveLength(1);
			expect(result.failures?.[0].property).toBe("name");
			expect(result.failures?.[0].reason).toContain("non-empty");
		});

		it("passes a non-empty name through untouched", async () => {
			const valid = { token: "tok", name: "my-app" };

			const result = await new RailwayProjectResourceProvider().check(
				valid,
				valid,
			);

			expect(result.failures).toEqual([]);
		});
	});

	describe("create", () => {
		it("adopts an existing project by name and resolves its production environment", async () => {
			mockQuery.mockImplementation(async (query: string) => {
				if (query.includes("workspaces")) {
					return {
						me: {
							workspaces: [
								{
									id: "ws-1",
									name: "my-workspace",
									projects: {
										edges: [{ node: { id: "proj-abc", name: "my-app" } }],
									},
								},
							],
						},
					};
				}

				return {
					project: {
						environments: {
							edges: [{ node: { id: "env-prod", name: "production" } }],
						},
					},
				};
			});

			const result = await new RailwayProjectResourceProvider().create({
				token: "tok",
				name: "my-app",
			});

			expect(result.id).toBe("proj-abc");
			expect(result.outs.productionEnvironmentId).toBe("env-prod");
		});

		it("creates a new project when no workspace has a matching name", async () => {
			mockQuery.mockImplementation(async (query: string) => {
				if (query.includes("workspaces")) {
					return {
						me: {
							workspaces: [
								{ id: "ws-1", name: "my-workspace", projects: { edges: [] } },
							],
						},
					};
				}

				if (query.includes("projectCreate")) {
					return { projectCreate: { id: "proj-new", name: "my-app" } };
				}

				return { project: { environments: { edges: [] } } };
			});

			const result = await new RailwayProjectResourceProvider().create({
				token: "tok",
				name: "my-app",
			});

			expect(result.id).toBe("proj-new");
			expect(result.outs.productionEnvironmentId).toBe("");
		});

		it("throws when no Railway workspace exists", async () => {
			mockQuery.mockResolvedValue({ me: { workspaces: [] } });

			await expect(
				new RailwayProjectResourceProvider().create({
					token: "tok",
					name: "my-app",
				}),
			).rejects.toThrow("No Railway workspace found");
		});
	});

	describe("update", () => {
		it("PATCHes name and description and re-resolves the production environment", async () => {
			mockQuery.mockImplementation(async (query: string) => {
				if (query.includes("projectUpdate")) {
					return { projectUpdate: { id: "proj-abc", name: "renamed" } };
				}

				return {
					project: {
						environments: {
							edges: [{ node: { id: "env-prod", name: "production" } }],
						},
					},
				};
			});

			const result = await new RailwayProjectResourceProvider().update(
				"proj-abc",
				{
					token: "tok",
					name: "my-app",
					projectId: "proj-abc",
					productionEnvironmentId: "env-prod",
				},
				{ token: "tok", name: "renamed" },
			);

			expect(result.outs?.name).toBe("renamed");
			expect(result.outs?.productionEnvironmentId).toBe("env-prod");
		});
	});

	describe("delete", () => {
		it("is a no-op — projects are not deleted by Pulumi", async () => {
			await expect(
				new RailwayProjectResourceProvider().delete(),
			).resolves.toBeUndefined();

			expect(mockQuery).not.toHaveBeenCalled();
		});
	});

	describe("diff", () => {
		it("flags an in-place change (no replace) when the name changes", async () => {
			const result = await new RailwayProjectResourceProvider().diff(
				"proj-abc",
				{
					token: "tok",
					name: "my-app",
					projectId: "proj-abc",
					productionEnvironmentId: "env-prod",
				},
				{ token: "tok", name: "renamed" },
			);

			expect(result.changes).toBe(true);
			expect(result.replaces).toEqual([]);
		});

		it("declares projectId stable across in-place updates", async () => {
			const result = await new RailwayProjectResourceProvider().diff(
				"proj-abc",
				{
					token: "tok",
					name: "my-app",
					projectId: "proj-abc",
					productionEnvironmentId: "env-prod",
				},
				{ token: "tok", name: "my-app" },
			);

			expect(result.stables).toEqual(["projectId"]);
		});
	});
});
