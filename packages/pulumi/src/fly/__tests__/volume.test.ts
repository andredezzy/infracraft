import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiNotFoundError } from "../../errors/api-not-found-error";
import { FlyClient } from "../client";
import { FlyVolumeResourceProvider } from "../volume";

describe("FlyVolumeResourceProvider", () => {
	let mockTryGet: ReturnType<typeof vi.fn>;
	let mockDelete: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		mockTryGet = vi.fn();
		mockDelete = vi.fn();
		vi.spyOn(FlyClient.prototype, "tryGet").mockImplementation(mockTryGet);
		vi.spyOn(FlyClient.prototype, "delete").mockImplementation(mockDelete);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	const props = {
		token: "tok",
		appName: "my-app",
		name: "data",
		region: "iad",
		sizeGb: 10,
		volumeId: "vol_123",
	};

	describe("read", () => {
		it("returns a blank ReadResult when the volume is gone (deleted out of band)", async () => {
			mockTryGet.mockResolvedValueOnce(null);

			const result = await new FlyVolumeResourceProvider().read(
				"vol_123",
				props,
			);

			expect(result).toEqual({});
		});
	});

	describe("delete", () => {
		it("deletes the volume via the volumes API", async () => {
			mockDelete.mockResolvedValueOnce(undefined);

			await new FlyVolumeResourceProvider().delete("vol_123", props);

			expect(mockDelete).toHaveBeenCalledWith(
				"/v1/apps/my-app/volumes/vol_123",
			);
		});

		it("tolerates an already-deleted volume (404)", async () => {
			mockDelete.mockRejectedValueOnce(
				new ApiNotFoundError("fly", "/v1/apps/my-app/volumes/vol_123"),
			);

			await expect(
				new FlyVolumeResourceProvider().delete("vol_123", props),
			).resolves.toBeUndefined();
		});

		it("rethrows errors other than not-found", async () => {
			mockDelete.mockRejectedValueOnce(
				new Error("Fly API error (403): forbidden"),
			);

			await expect(
				new FlyVolumeResourceProvider().delete("vol_123", props),
			).rejects.toThrow("403");
		});
	});

	describe("check", () => {
		const { volumeId: _ignored, ...inputs } = props;

		it("passes a positive integer sizeGb through untouched", async () => {
			const result = await new FlyVolumeResourceProvider().check(
				inputs,
				inputs,
			);

			expect(result.inputs).toEqual(inputs);
			expect(result.failures).toEqual([]);
		});

		it("fails a non-positive sizeGb, naming the property", async () => {
			const invalid = { ...inputs, sizeGb: 0 };

			const result = await new FlyVolumeResourceProvider().check(
				invalid,
				invalid,
			);

			expect(result.failures).toHaveLength(1);
			expect(result.failures?.[0].property).toBe("sizeGb");
			expect(result.failures?.[0].reason).toContain("positive integer");
		});

		it("fails a fractional sizeGb", async () => {
			const invalid = { ...inputs, sizeGb: 1.5 };

			const result = await new FlyVolumeResourceProvider().check(
				invalid,
				invalid,
			);

			expect(result.failures).toHaveLength(1);
			expect(result.failures?.[0].property).toBe("sizeGb");
		});
	});

	describe("diff (stables)", () => {
		it("declares volumeId stable on an in-place extend", async () => {
			const diff = await new FlyVolumeResourceProvider().diff(
				"vol_123",
				props,
				{ ...props, sizeGb: 20 },
			);

			expect(diff.changes).toBe(true);
			expect(diff.replaces).toEqual([]);
			expect(diff.stables).toEqual(["volumeId"]);
		});

		it("declares no stables when a region change forces a replace", async () => {
			const diff = await new FlyVolumeResourceProvider().diff(
				"vol_123",
				props,
				{ ...props, region: "fra" },
			);

			expect(diff.replaces).toEqual(["region"]);
			expect(diff.stables).toEqual([]);
		});
	});
});
