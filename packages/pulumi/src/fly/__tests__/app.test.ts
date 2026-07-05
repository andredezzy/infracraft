import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FlyAppResourceProvider } from "../app";
import { FlyClient } from "../client";

describe("FlyAppResourceProvider", () => {
	let mockTryGet: ReturnType<typeof vi.fn>;
	let mockPost: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		mockTryGet = vi.fn();
		mockPost = vi.fn();
		vi.spyOn(FlyClient.prototype, "tryGet").mockImplementation(mockTryGet);
		vi.spyOn(FlyClient.prototype, "post").mockImplementation(mockPost);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	const props = {
		token: "tok",
		name: "my-app",
		appId: "my-app",
	};

	describe("create", () => {
		it("adopts an existing app without creating", async () => {
			mockTryGet.mockResolvedValueOnce({ id: "app-internal", name: "my-app" });

			const result = await new FlyAppResourceProvider().create({
				token: "tok",
				name: "my-app",
			});

			expect(result.id).toBe("my-app");
			expect(result.outs.appId).toBe("my-app");
			expect(mockPost).not.toHaveBeenCalled();
		});

		it("creates the app when not found, passing app_name and org_slug", async () => {
			mockTryGet.mockResolvedValueOnce(null);
			mockPost.mockResolvedValueOnce({});

			const result = await new FlyAppResourceProvider().create({
				token: "tok",
				name: "my-app",
				organization: "my-org",
			});

			expect(result.id).toBe("my-app");

			expect(mockPost).toHaveBeenCalledWith("/v1/apps", {
				app_name: "my-app",
				org_slug: "my-org",
			});
		});

		it("throws when creating without an organization", async () => {
			mockTryGet.mockResolvedValueOnce(null);

			await expect(
				new FlyAppResourceProvider().create({ token: "tok", name: "my-app" }),
			).rejects.toThrow("organization is required");

			expect(mockPost).not.toHaveBeenCalled();
		});
	});

	describe("read", () => {
		it("returns a blank ReadResult when the app is gone (deleted out of band)", async () => {
			mockTryGet.mockResolvedValueOnce(null);

			const result = await new FlyAppResourceProvider().read("my-app", props);

			expect(result).toEqual({});
		});

		it("refreshes props when the app still exists", async () => {
			mockTryGet.mockResolvedValueOnce({ id: "app-internal", name: "my-app" });

			const result = await new FlyAppResourceProvider().read("my-app", props);

			expect(result.id).toBe("my-app");
			expect(result.props?.name).toBe("my-app");
			expect(result.props?.appId).toBe("my-app");
		});
	});

	describe("delete", () => {
		it("is a deliberate no-op (deleting an app would destroy everything in it)", async () => {
			await expect(
				new FlyAppResourceProvider().delete(),
			).resolves.toBeUndefined();

			expect(mockTryGet).not.toHaveBeenCalled();
			expect(mockPost).not.toHaveBeenCalled();
		});
	});

	describe("diff", () => {
		it("replaces on a name change (delete-before-replace)", async () => {
			const diff = await new FlyAppResourceProvider().diff("my-app", props, {
				...props,
				name: "renamed",
			});

			expect(diff.changes).toBe(true);
			expect(diff.replaces).toEqual(["name"]);
			expect(diff.deleteBeforeReplace).toBe(true);
		});

		it("replaces on an organization change", async () => {
			const diff = await new FlyAppResourceProvider().diff(
				"my-app",
				{ ...props, organization: "org-a" },
				{ ...props, organization: "org-b" },
			);

			expect(diff.replaces).toEqual(["organization"]);
		});

		it("reports no changes when inputs are identical", async () => {
			const diff = await new FlyAppResourceProvider().diff(
				"my-app",
				props,
				props,
			);

			expect(diff.changes).toBe(false);
			expect(diff.replaces).toEqual([]);
		});
	});
});
