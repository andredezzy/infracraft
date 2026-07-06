import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiNotFoundError } from "../../errors/api-not-found-error";
import { Client } from "../client";
import { DatabaseResourceProvider } from "../database";

describe("neon.DatabaseResourceProvider", () => {
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

	describe("check", () => {
		it("fails an empty database name, naming the property", async () => {
			const invalid = {
				apiKey: "key",
				projectId: "proj-abc",
				branchId: "br-main",
				name: "  ",
				ownerName: "neondb_owner",
			};

			const result = await new DatabaseResourceProvider().check(
				invalid,
				invalid,
			);

			expect(result.failures).toHaveLength(1);
			expect(result.failures?.[0].property).toBe("name");
			expect(result.failures?.[0].reason).toContain("non-empty");
		});
	});

	describe("create", () => {
		it("creates the database when it doesn't already exist", async () => {
			mockGet.mockResolvedValue({ databases: [] });

			const provider = new DatabaseResourceProvider();

			const result = await provider.create({
				apiKey: "key",
				projectId: "proj-abc",
				branchId: "br-main",
				name: "neondb",
				ownerName: "neondb_owner",
			});

			expect(mockPost).toHaveBeenCalledWith(
				"/projects/proj-abc/branches/br-main/databases",
				{ database: { name: "neondb", owner_name: "neondb_owner" } },
			);

			expect(result.id).toBe("br-main/neondb");
		});

		it("adopts an existing database without POSTing and records its LIVE ownerName, not the desired one", async () => {
			mockGet
				.mockResolvedValueOnce({
					databases: [{ id: 1, name: "neondb", owner_name: "live_owner" }],
				})
				.mockResolvedValueOnce({
					database: {
						id: 1,
						name: "neondb",
						owner_name: "live_owner",
						branch_id: "br-main",
					},
				});

			const provider = new DatabaseResourceProvider();

			const result = await provider.create({
				apiKey: "key",
				projectId: "proj-abc",
				branchId: "br-main",
				name: "neondb",
				ownerName: "desired_owner",
			});

			expect(mockPost).not.toHaveBeenCalled();
			expect(result.outs.ownerName).toBe("live_owner");
		});
	});

	describe("diff", () => {
		it("marks name as replace when the database name changes", async () => {
			const provider = new DatabaseResourceProvider();

			const result = await provider.diff(
				"br-main/neondb",
				{
					apiKey: "k",
					projectId: "p",
					branchId: "br-main",
					name: "neondb",
					ownerName: "neondb_owner",
				},
				{
					apiKey: "k",
					projectId: "p",
					branchId: "br-main",
					name: "other",
					ownerName: "neondb_owner",
				},
			);

			expect(result.replaces).toContain("name");
		});

		it("flags an in-place change (no replace) when only ownerName changes", async () => {
			const provider = new DatabaseResourceProvider();

			const result = await provider.diff(
				"br-main/neondb",
				{
					apiKey: "k",
					projectId: "p",
					branchId: "br-main",
					name: "neondb",
					ownerName: "neondb_owner",
				},
				{
					apiKey: "k",
					projectId: "p",
					branchId: "br-main",
					name: "neondb",
					ownerName: "other_owner",
				},
			);

			expect(result.changes).toBe(true);
			expect(result.replaces).toEqual([]);
		});
	});

	describe("update", () => {
		it("PATCHes the owner name and agrees with diff's in-place case", async () => {
			const provider = new DatabaseResourceProvider();

			const result = await provider.update(
				"br-main/neondb",
				{
					apiKey: "key",
					projectId: "proj-abc",
					branchId: "br-main",
					name: "neondb",
					ownerName: "neondb_owner",
				},
				{
					apiKey: "key",
					projectId: "proj-abc",
					branchId: "br-main",
					name: "neondb",
					ownerName: "other_owner",
				},
			);

			expect(mockPatch).toHaveBeenCalledWith(
				"/projects/proj-abc/branches/br-main/databases/neondb",
				{ database: { owner_name: "other_owner" } },
			);

			expect(result.outs?.ownerName).toBe("other_owner");
		});
	});

	describe("delete", () => {
		it("deletes the database", async () => {
			const mockDelete = vi
				.spyOn(Client.prototype, "delete")
				.mockResolvedValue(undefined);

			await new DatabaseResourceProvider().delete("br-main/neondb", {
				apiKey: "key",
				projectId: "proj-abc",
				branchId: "br-main",
				name: "neondb",
				ownerName: "neondb_owner",
			});

			expect(mockDelete).toHaveBeenCalledWith(
				"/projects/proj-abc/branches/br-main/databases/neondb",
			);
		});

		it("tolerates an already-deleted database (not-found)", async () => {
			vi.spyOn(Client.prototype, "delete").mockRejectedValue(
				new ApiNotFoundError(
					"neon",
					"/projects/proj-abc/branches/br-main/databases/neondb",
				),
			);

			await expect(
				new DatabaseResourceProvider().delete("br-main/neondb", {
					apiKey: "key",
					projectId: "proj-abc",
					branchId: "br-main",
					name: "neondb",
					ownerName: "neondb_owner",
				}),
			).resolves.toBeUndefined();
		});

		it("rethrows a real error", async () => {
			vi.spyOn(Client.prototype, "delete").mockRejectedValue(
				new Error("Neon API error (403): forbidden"),
			);

			await expect(
				new DatabaseResourceProvider().delete("br-main/neondb", {
					apiKey: "key",
					projectId: "proj-abc",
					branchId: "br-main",
					name: "neondb",
					ownerName: "neondb_owner",
				}),
			).rejects.toThrow("403");
		});
	});
});
