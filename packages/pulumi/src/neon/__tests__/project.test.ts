import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NeonClient } from "../client";
import { NeonProjectResourceProvider } from "../project";

describe("NeonProjectResourceProvider", () => {
	let mockGet: ReturnType<typeof vi.fn>;
	let mockPost: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		mockGet = vi.fn();
		mockPost = vi.fn();
		vi.spyOn(NeonClient.prototype, "get").mockImplementation(mockGet);
		vi.spyOn(NeonClient.prototype, "post").mockImplementation(mockPost);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe("check", () => {
		it("fails an empty project name, naming the property", async () => {
			const invalid = { apiKey: "key", name: "  " };

			const result = await new NeonProjectResourceProvider().check(
				invalid,
				invalid,
			);

			expect(result.failures).toHaveLength(1);
			expect(result.failures?.[0].property).toBe("name");
			expect(result.failures?.[0].reason).toContain("non-empty");
		});
	});

	describe("create", () => {
		it("adopts an existing project by exact name match", async () => {
			mockGet.mockResolvedValue({
				projects: [{ id: "proj-existing", name: "my-app" }],
			});

			const result = await new NeonProjectResourceProvider().create({
				apiKey: "key",
				name: "my-app",
			});

			expect(result.id).toBe("proj-existing");
			expect(mockPost).not.toHaveBeenCalled();
		});

		it("creates a new project when no name matches", async () => {
			mockGet.mockResolvedValue({ projects: [] });

			mockPost.mockResolvedValue({
				project: { id: "proj-new", name: "my-app" },
			});

			const result = await new NeonProjectResourceProvider().create({
				apiKey: "key",
				name: "my-app",
			});

			expect(result.id).toBe("proj-new");

			expect(mockPost).toHaveBeenCalledWith("/projects", {
				project: { name: "my-app" },
			});
		});
	});

	describe("update", () => {
		it("PATCHes the project name", async () => {
			const mockPatch = vi
				.spyOn(NeonClient.prototype, "patch")
				.mockResolvedValue({});

			const result = await new NeonProjectResourceProvider().update(
				"proj-abc",
				{ apiKey: "key", name: "old-name", projectId: "proj-abc" },
				{ apiKey: "key", name: "new-name" },
			);

			expect(mockPatch).toHaveBeenCalledWith("/projects/proj-abc", {
				project: { name: "new-name" },
			});

			expect(result.outs?.projectId).toBe("proj-abc");
		});
	});

	describe("delete", () => {
		it("is a no-op — projects are not deleted by Pulumi", async () => {
			await expect(
				new NeonProjectResourceProvider().delete(),
			).resolves.toBeUndefined();

			expect(mockGet).not.toHaveBeenCalled();
		});
	});

	describe("diff", () => {
		it("flags an in-place change (no replace) when the name changes", async () => {
			const result = await new NeonProjectResourceProvider().diff(
				"proj-abc",
				{ apiKey: "key", name: "old-name", projectId: "proj-abc" },
				{ apiKey: "key", name: "new-name" },
			);

			expect(result.changes).toBe(true);
			expect(result.replaces).toEqual([]);
		});

		it("marks orgId as replace", async () => {
			const result = await new NeonProjectResourceProvider().diff(
				"proj-abc",
				{
					apiKey: "key",
					name: "my-app",
					orgId: "org-1",
					projectId: "proj-abc",
				},
				{ apiKey: "key", name: "my-app", orgId: "org-2" },
			);

			expect(result.replaces).toEqual(["orgId"]);
		});
	});
});
