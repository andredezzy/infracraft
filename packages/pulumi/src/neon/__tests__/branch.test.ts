import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiNotFoundError } from "../../errors/api-not-found-error";
import { BranchResourceProvider } from "../branch";
import { Client } from "../client";

describe("neon.BranchResourceProvider", () => {
	let mockGet: ReturnType<typeof vi.fn>;
	let mockPost: ReturnType<typeof vi.fn>;

	let mockPatch: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		mockGet = vi.fn();
		mockPost = vi.fn();
		mockPatch = vi.fn();
		vi.spyOn(Client.prototype, "get").mockImplementation(mockGet);
		vi.spyOn(Client.prototype, "post").mockImplementation(mockPost);
		vi.spyOn(Client.prototype, "patch").mockImplementation(mockPatch);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe("create without parent", () => {
		it("creates branch at project root when parentName is omitted", async () => {
			mockGet.mockResolvedValue({ branches: [] });
			mockPost.mockResolvedValue({ branch: { id: "br-new" } });

			const provider = new BranchResourceProvider();

			const result = await provider.create({
				apiKey: "key",
				projectId: "proj-abc",
				name: "production",
			});

			expect(mockPost).toHaveBeenCalledWith("/projects/proj-abc/branches", {
				branch: { name: "production" },
			});

			expect(result.id).toBe("br-new");
		});
	});

	describe("create with parent", () => {
		it("resolves parent branch name to ID and passes parent_id to POST", async () => {
			mockGet
				.mockResolvedValueOnce({ branches: [] }) // adopt check: staging not found
				.mockResolvedValueOnce({
					branches: [{ name: "production", id: "br-prod" }],
				}); // parent lookup

			mockPost.mockResolvedValue({ branch: { id: "br-staging" } });

			const provider = new BranchResourceProvider();

			const result = await provider.create({
				apiKey: "key",
				projectId: "proj-abc",
				name: "staging",
				parentName: "production",
			});

			expect(mockPost).toHaveBeenCalledWith("/projects/proj-abc/branches", {
				branch: { name: "staging", parent_id: "br-prod" },
			});

			expect(result.id).toBe("br-staging");
			expect(result.outs.parentName).toBe("production");
		});

		it("throws when parent branch name cannot be resolved", async () => {
			mockGet
				.mockResolvedValueOnce({ branches: [] }) // adopt check
				.mockResolvedValueOnce({ branches: [] }); // parent lookup returns nothing

			const provider = new BranchResourceProvider();

			await expect(
				provider.create({
					apiKey: "key",
					projectId: "proj-abc",
					name: "staging",
					parentName: "nonexistent",
				}),
			).rejects.toThrow('Neon parent branch "nonexistent" not found');
		});
	});

	describe("diff", () => {
		it("marks parent as replace when parentName changes", async () => {
			const provider = new BranchResourceProvider();

			const result = await provider.diff(
				"br-staging",
				{
					apiKey: "k",
					projectId: "p",
					name: "staging",
					parentName: "production",
				},
				{ apiKey: "k", projectId: "p", name: "staging", parentName: "other" },
			);

			expect(result.replaces).toContain("parentName");
		});

		it("flags an in-place change (no replace) when only name changes", async () => {
			const provider = new BranchResourceProvider();

			const result = await provider.diff(
				"br-staging",
				{ apiKey: "k", projectId: "p", name: "staging" },
				{ apiKey: "k", projectId: "p", name: "staging-renamed" },
			);

			expect(result.changes).toBe(true);
			expect(result.replaces).toEqual([]);
		});
	});

	describe("update", () => {
		it("PATCHes the branch name and agrees with diff's in-place case", async () => {
			const provider = new BranchResourceProvider();

			const result = await provider.update(
				"br-staging",
				{ apiKey: "key", projectId: "proj-abc", name: "staging" },
				{ apiKey: "key", projectId: "proj-abc", name: "staging-renamed" },
			);

			expect(mockPatch).toHaveBeenCalledWith(
				"/projects/proj-abc/branches/br-staging",
				{ branch: { name: "staging-renamed" } },
			);

			expect(result.outs?.name).toBe("staging-renamed");
		});
	});

	describe("check", () => {
		it("fails an empty branch name, naming the property", async () => {
			const invalid = { apiKey: "key", projectId: "proj-abc", name: "  " };

			const result = await new BranchResourceProvider().check(invalid, invalid);

			expect(result.failures).toHaveLength(1);
			expect(result.failures?.[0].property).toBe("name");
			expect(result.failures?.[0].reason).toContain("non-empty");
		});
	});

	describe("read", () => {
		it("returns the branch name and preserves parentName", async () => {
			mockGet.mockResolvedValue({
				branch: { id: "br-staging", name: "staging" },
			});

			const provider = new BranchResourceProvider();

			const result = await provider.read("br-staging", {
				apiKey: "key",
				projectId: "proj-abc",
				name: "staging",
				parentName: "production",
			});

			expect(result.props.name).toBe("staging");
			expect(result.props.parentName).toBe("production");
		});
	});

	describe("delete", () => {
		it("skips a default branch without attempting DELETE", async () => {
			mockGet.mockResolvedValueOnce({
				branch: {
					id: "br-main",
					name: "main",
					project_id: "proj-abc",
					default: true,
				},
			});

			const mockDelete = vi.spyOn(Client.prototype, "delete");

			await new BranchResourceProvider().delete("br-main", {
				apiKey: "key",
				projectId: "proj-abc",
				name: "main",
			});

			expect(mockDelete).not.toHaveBeenCalled();
		});

		it("deletes a non-default branch", async () => {
			mockGet.mockResolvedValueOnce({
				branch: {
					id: "br-feature",
					name: "feature",
					project_id: "proj-abc",
					default: false,
				},
			});

			const mockDelete = vi
				.spyOn(Client.prototype, "delete")
				.mockResolvedValue(undefined);

			await new BranchResourceProvider().delete("br-feature", {
				apiKey: "key",
				projectId: "proj-abc",
				name: "feature",
			});

			expect(mockDelete).toHaveBeenCalledWith(
				"/projects/proj-abc/branches/br-feature",
			);
		});

		it("tolerates an already-deleted branch (pre-delete GET 404)", async () => {
			mockGet.mockRejectedValueOnce(
				new ApiNotFoundError("neon", "/projects/proj-abc/branches/br-gone"),
			);

			const mockDelete = vi.spyOn(Client.prototype, "delete");

			await expect(
				new BranchResourceProvider().delete("br-gone", {
					apiKey: "key",
					projectId: "proj-abc",
					name: "gone",
				}),
			).resolves.toBeUndefined();

			expect(mockDelete).not.toHaveBeenCalled();
		});

		it("rethrows a real error from the pre-delete GET", async () => {
			mockGet.mockRejectedValueOnce(new Error("Neon API error (500): boom"));

			await expect(
				new BranchResourceProvider().delete("br-feature", {
					apiKey: "key",
					projectId: "proj-abc",
					name: "feature",
				}),
			).rejects.toThrow("500");
		});

		it("rethrows a real error from DELETE itself", async () => {
			mockGet.mockResolvedValueOnce({
				branch: {
					id: "br-feature",
					name: "feature",
					project_id: "proj-abc",
					default: false,
				},
			});

			vi.spyOn(Client.prototype, "delete").mockRejectedValue(
				new Error("Neon API error (403): forbidden"),
			);

			await expect(
				new BranchResourceProvider().delete("br-feature", {
					apiKey: "key",
					projectId: "proj-abc",
					name: "feature",
				}),
			).rejects.toThrow("403");
		});
	});
});
