import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NeonBranchResourceProvider } from "../branch";
import { NeonClient } from "../client";

describe("NeonBranchResourceProvider", () => {
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

	describe("create without parent", () => {
		it("creates branch at project root when parentName is omitted", async () => {
			mockGet.mockResolvedValue({ branches: [] });
			mockPost.mockResolvedValue({ branch: { id: "br-new" } });

			const provider = new NeonBranchResourceProvider();

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

			const provider = new NeonBranchResourceProvider();

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

			const provider = new NeonBranchResourceProvider();

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
			const provider = new NeonBranchResourceProvider();

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
	});

	describe("read", () => {
		it("returns the branch name and preserves parentName", async () => {
			mockGet.mockResolvedValue({
				branch: { id: "br-staging", name: "staging" },
			});

			const provider = new NeonBranchResourceProvider();

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
		it("deletes the branch", async () => {
			const mockDelete = vi
				.spyOn(NeonClient.prototype, "delete")
				.mockResolvedValue(undefined);

			await new NeonBranchResourceProvider().delete("br-feature", {
				apiKey: "key",
				projectId: "proj-abc",
				name: "feature",
			});

			expect(mockDelete).toHaveBeenCalledWith(
				"/projects/proj-abc/branches/br-feature",
			);
		});
	});
});
