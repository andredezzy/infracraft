import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiNotFoundError } from "../../errors/api-not-found-error";
import { FlyCertificateResourceProvider } from "../certificate";
import { FlyClient } from "../client";

describe("FlyCertificateResourceProvider", () => {
	let mockTryGet: ReturnType<typeof vi.fn>;
	let mockPost: ReturnType<typeof vi.fn>;
	let mockDelete: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		mockTryGet = vi.fn();
		mockPost = vi.fn();
		mockDelete = vi.fn();
		vi.spyOn(FlyClient.prototype, "tryGet").mockImplementation(mockTryGet);
		vi.spyOn(FlyClient.prototype, "post").mockImplementation(mockPost);
		vi.spyOn(FlyClient.prototype, "delete").mockImplementation(mockDelete);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	const dnsRequirements = {
		cname: "my-app.fly.dev",
		acme_challenge: { name: "_acme-challenge.api", target: "api.z.flydns.net" },
	};

	const props = {
		token: "tok",
		appName: "my-app",
		hostname: "api.example.com",
		configured: true,
		dnsRequirements,
	};

	describe("create", () => {
		const inputs = {
			token: "tok",
			appName: "my-app",
			hostname: "api.example.com",
		};

		it("adopts an existing certificate without requesting a new one", async () => {
			mockTryGet.mockResolvedValueOnce({
				hostname: "api.example.com",
				configured: true,
				dns_requirements: dnsRequirements,
			});

			const result = await new FlyCertificateResourceProvider().create(inputs);

			expect(result.id).toBe("api.example.com");
			expect(result.outs.configured).toBe(true);
			expect(result.outs.dnsRequirements).toEqual(dnsRequirements);
			expect(mockPost).not.toHaveBeenCalled();
		});

		it("requests an ACME certificate when none exists", async () => {
			mockTryGet.mockResolvedValueOnce(null);

			mockPost.mockResolvedValueOnce({
				hostname: "api.example.com",
				configured: false,
				dns_requirements: dnsRequirements,
			});

			const result = await new FlyCertificateResourceProvider().create(inputs);

			expect(result.id).toBe("api.example.com");
			expect(result.outs.configured).toBe(false);

			expect(mockPost).toHaveBeenCalledWith(
				"/v1/apps/my-app/certificates/acme",
				{ hostname: "api.example.com" },
			);
		});

		it("defaults configured/dnsRequirements when the API omits them", async () => {
			mockTryGet.mockResolvedValueOnce(null);
			mockPost.mockResolvedValueOnce({ hostname: "api.example.com" });

			const result = await new FlyCertificateResourceProvider().create(inputs);

			expect(result.outs.configured).toBe(false);
			expect(result.outs.dnsRequirements).toEqual({});
		});
	});

	describe("read", () => {
		it("returns a blank ReadResult when the certificate is gone (deleted out of band)", async () => {
			mockTryGet.mockResolvedValueOnce(null);

			const result = await new FlyCertificateResourceProvider().read(
				"api.example.com",
				props,
			);

			expect(result).toEqual({});
		});

		it("refreshes configured and dnsRequirements when it still exists", async () => {
			mockTryGet.mockResolvedValueOnce({
				hostname: "api.example.com",
				configured: false,
				dns_requirements: dnsRequirements,
			});

			const result = await new FlyCertificateResourceProvider().read(
				"api.example.com",
				props,
			);

			expect(result.id).toBe("api.example.com");
			expect(result.props?.configured).toBe(false);
			expect(result.props?.dnsRequirements).toEqual(dnsRequirements);
		});
	});

	describe("delete", () => {
		it("deletes the certificate via the certificates API (hostname URL-encoded)", async () => {
			mockDelete.mockResolvedValueOnce(undefined);

			await new FlyCertificateResourceProvider().delete(
				"api.example.com",
				props,
			);

			expect(mockDelete).toHaveBeenCalledWith(
				"/v1/apps/my-app/certificates/api.example.com",
			);
		});

		it("tolerates an already-deleted certificate (404)", async () => {
			mockDelete.mockRejectedValueOnce(
				new ApiNotFoundError("fly", "/v1/apps/my-app/certificates/x"),
			);

			await expect(
				new FlyCertificateResourceProvider().delete("api.example.com", props),
			).resolves.toBeUndefined();
		});

		it("rethrows errors other than not-found", async () => {
			mockDelete.mockRejectedValueOnce(
				new Error("Fly API error (403): forbidden"),
			);

			await expect(
				new FlyCertificateResourceProvider().delete("api.example.com", props),
			).rejects.toThrow("403");
		});
	});

	describe("diff", () => {
		it("replaces on an appName change (delete-before-replace)", async () => {
			const diff = await new FlyCertificateResourceProvider().diff(
				"api.example.com",
				props,
				{ ...props, appName: "other-app" },
			);

			expect(diff.changes).toBe(true);
			expect(diff.replaces).toEqual(["appName"]);
			expect(diff.deleteBeforeReplace).toBe(true);
		});

		it("replaces on a hostname change", async () => {
			const diff = await new FlyCertificateResourceProvider().diff(
				"api.example.com",
				props,
				{ ...props, hostname: "www.example.com" },
			);

			expect(diff.replaces).toEqual(["hostname"]);
		});

		it("reports no changes when inputs are identical", async () => {
			const diff = await new FlyCertificateResourceProvider().diff(
				"api.example.com",
				props,
				props,
			);

			expect(diff.changes).toBe(false);
			expect(diff.replaces).toEqual([]);
		});
	});
});
