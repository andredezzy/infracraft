import * as pulumi from "@pulumi/pulumi";
import { MockMonitor } from "@pulumi/pulumi/runtime/mocks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiNotFoundError } from "../../errors/api-not-found-error";
import { App } from "../app";
import { Client } from "../client";
import { Provider } from "../provider";
import { Secret, SecretResourceProvider } from "../secret";

describe("fly.SecretResourceProvider", () => {
	let mockPost: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		mockPost = vi.fn();
		vi.spyOn(Client.prototype, "post").mockImplementation(mockPost);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	const props = {
		token: "tok",
		appName: "my-app",
		secrets: { JWT_SECRET: "abc", DATABASE_URL: "postgres://db" },
		version: "7",
	};

	describe("create", () => {
		it("sets all secrets via the bulk endpoint and stores the returned version", async () => {
			mockPost.mockResolvedValueOnce({ version: 3 });

			const result = await new SecretResourceProvider().create({
				token: "tok",
				appName: "my-app",
				secrets: { JWT_SECRET: "abc" },
			});

			expect(result.id).toBe("my-app-secrets");
			expect(result.outs.version).toBe("3");

			expect(mockPost).toHaveBeenCalledWith("/v1/apps/my-app/secrets", {
				values: { JWT_SECRET: "abc" },
			});
		});
	});

	describe("read", () => {
		it("passes persisted state through (values are write-only in the Fly API)", async () => {
			const result = await new SecretResourceProvider().read(
				"my-app-secrets",
				props,
			);

			expect(result).toEqual({ id: "my-app-secrets", props });
			expect(mockPost).not.toHaveBeenCalled();
		});
	});

	describe("update", () => {
		it("nulls removed keys and upserts the rest in one bulk call", async () => {
			mockPost.mockResolvedValueOnce({ version: 8 });

			const result = await new SecretResourceProvider().update(
				"my-app-secrets",
				props,
				{
					token: "tok",
					appName: "my-app",
					secrets: { JWT_SECRET: "rotated" },
				},
			);

			expect(result.outs?.version).toBe("8");

			expect(mockPost).toHaveBeenCalledWith("/v1/apps/my-app/secrets", {
				values: { JWT_SECRET: "rotated", DATABASE_URL: null },
			});
		});
	});

	describe("delete", () => {
		it("unsets every key via the bulk endpoint", async () => {
			mockPost.mockResolvedValueOnce({ version: 9 });

			await new SecretResourceProvider().delete("my-app-secrets", props);

			expect(mockPost).toHaveBeenCalledWith("/v1/apps/my-app/secrets", {
				values: { JWT_SECRET: null, DATABASE_URL: null },
			});
		});

		it("tolerates an already-deleted app (404)", async () => {
			mockPost.mockRejectedValueOnce(
				new ApiNotFoundError("fly", "/v1/apps/my-app/secrets"),
			);

			await expect(
				new SecretResourceProvider().delete("my-app-secrets", props),
			).resolves.toBeUndefined();
		});

		it("rethrows errors other than not-found", async () => {
			mockPost.mockRejectedValueOnce(
				new Error("Fly API error (403): forbidden"),
			);

			await expect(
				new SecretResourceProvider().delete("my-app-secrets", props),
			).rejects.toThrow("403");
		});
	});

	describe("diff", () => {
		it("replaces on an appName change (delete-before-replace)", async () => {
			const diff = await new SecretResourceProvider().diff(
				"my-app-secrets",
				props,
				{ ...props, appName: "other-app" },
			);

			expect(diff.changes).toBe(true);
			expect(diff.replaces).toEqual(["appName"]);
			expect(diff.deleteBeforeReplace).toBe(true);
		});

		it("flags an in-place change when a value rotates", async () => {
			const diff = await new SecretResourceProvider().diff(
				"my-app-secrets",
				props,
				{ ...props, secrets: { ...props.secrets, JWT_SECRET: "rotated" } },
			);

			expect(diff.changes).toBe(true);
			expect(diff.replaces).toEqual([]);
		});

		it("flags an in-place change when the key set changes", async () => {
			const diff = await new SecretResourceProvider().diff(
				"my-app-secrets",
				props,
				{ ...props, secrets: { JWT_SECRET: "abc" } },
			);

			expect(diff.changes).toBe(true);
			expect(diff.replaces).toEqual([]);
		});

		it("reports no changes when the secret set is identical", async () => {
			const diff = await new SecretResourceProvider().diff(
				"my-app-secrets",
				props,
				props,
			);

			expect(diff.changes).toBe(false);
		});
	});
});

describe("fly.Secret component", () => {
	let capturedAdditionalSecretOutputs: Map<string, string[]>;
	let originalRegisterResource: typeof MockMonitor.prototype.registerResource;

	beforeEach(async () => {
		capturedAdditionalSecretOutputs = new Map();
		originalRegisterResource = MockMonitor.prototype.registerResource;

		MockMonitor.prototype.registerResource = function (req, callback) {
			if (req.getType() === "pulumi-nodejs:dynamic:Resource") {
				capturedAdditionalSecretOutputs.set(
					req.getName(),
					req.getAdditionalsecretoutputsList(),
				);
			}

			return originalRegisterResource.call(this, req, callback);
		};

		await pulumi.runtime.setMocks({
			newResource: (args) => ({ id: `${args.name}-id`, state: args.inputs }),
			call: (args) => args.inputs,
		});
	});

	afterEach(() => {
		MockMonitor.prototype.registerResource = originalRegisterResource;
	});

	it("marks both token and secrets as additionalSecretOutputs on the underlying dynamic resource", async () => {
		const provider = new Provider("fly", { tokenEnvVar: "FLY_API_TOKEN" });
		const app = new App("app", { name: "my-app" }, { provider });

		new Secret(
			"api-secrets",
			{ secrets: { JWT_SECRET: "abc" } },
			{ provider, app },
		);

		await new Promise((resolve) => setImmediate(resolve));

		expect(capturedAdditionalSecretOutputs.get("api-secrets-resource")).toEqual(
			expect.arrayContaining(["token", "secrets"]),
		);
	});
});
