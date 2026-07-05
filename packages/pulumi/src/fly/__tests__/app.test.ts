import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FlyAppResourceProvider } from "../app";
import { FlyClient } from "../client";

describe("FlyAppResourceProvider", () => {
	let mockTryGet: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		mockTryGet = vi.fn();
		vi.spyOn(FlyClient.prototype, "tryGet").mockImplementation(mockTryGet);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	const props = {
		token: "tok",
		name: "my-app",
		appId: "my-app",
	};

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
});
