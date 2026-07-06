import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiNotFoundError } from "../../errors/api-not-found-error";
import { NeonClient } from "../client";
import { NeonEndpointResourceProvider } from "../endpoint";

describe("NeonEndpointResourceProvider", () => {
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

	describe("create", () => {
		it("creates a read-write endpoint when none exists", async () => {
			mockGet.mockResolvedValue({ endpoints: [] });

			mockPost.mockResolvedValue({
				endpoint: { id: "ep-new", host: "ep-new.neon.tech" },
			});

			const result = await new NeonEndpointResourceProvider().create({
				apiKey: "key",
				projectId: "proj-abc",
				branchId: "br-main",
				minCu: 0.25,
				maxCu: 1,
				suspendTimeout: 0,
			});

			expect(result.id).toBe("ep-new");
			expect(result.outs.host).toBe("ep-new.neon.tech");
		});
	});

	describe("delete", () => {
		it("deletes the endpoint", async () => {
			const mockDelete = vi
				.spyOn(NeonClient.prototype, "delete")
				.mockResolvedValue(undefined);

			await new NeonEndpointResourceProvider().delete("ep-main", {
				apiKey: "key",
				projectId: "proj-abc",
				branchId: "br-main",
				minCu: 0.25,
				maxCu: 1,
				suspendTimeout: 0,
				host: "ep-main.neon.tech",
			});

			expect(mockDelete).toHaveBeenCalledWith(
				"/projects/proj-abc/endpoints/ep-main",
			);
		});

		it("tolerates an already-deleted endpoint (not-found)", async () => {
			vi.spyOn(NeonClient.prototype, "delete").mockRejectedValue(
				new ApiNotFoundError("neon", "/projects/proj-abc/endpoints/ep-gone"),
			);

			await expect(
				new NeonEndpointResourceProvider().delete("ep-gone", {
					apiKey: "key",
					projectId: "proj-abc",
					branchId: "br-main",
					minCu: 0.25,
					maxCu: 1,
					suspendTimeout: 0,
					host: "ep-gone.neon.tech",
				}),
			).resolves.toBeUndefined();
		});

		it("rethrows a real error", async () => {
			vi.spyOn(NeonClient.prototype, "delete").mockRejectedValue(
				new Error("Neon API error (403): forbidden"),
			);

			await expect(
				new NeonEndpointResourceProvider().delete("ep-main", {
					apiKey: "key",
					projectId: "proj-abc",
					branchId: "br-main",
					minCu: 0.25,
					maxCu: 1,
					suspendTimeout: 0,
					host: "ep-main.neon.tech",
				}),
			).rejects.toThrow("403");
		});
	});

	describe("diff", () => {
		it("flags an in-place change (no replace) when only maxCu changes", async () => {
			const olds = {
				apiKey: "k",
				projectId: "p",
				branchId: "b",
				minCu: 0.25,
				maxCu: 1,
				suspendTimeout: 0,
				host: "ep.neon.tech",
			};

			const result = await new NeonEndpointResourceProvider().diff(
				"ep-main",
				olds,
				{ ...olds, maxCu: 2 },
			);

			expect(result.changes).toBe(true);
			expect(result.replaces).toEqual([]);
		});
	});
});
