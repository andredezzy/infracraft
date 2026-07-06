import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Client } from "../client";
import { IpResourceProvider, IpType } from "../ip";

describe("fly.IpResourceProvider", () => {
	let mockGraphql: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		mockGraphql = vi.fn();
		vi.spyOn(Client.prototype, "graphql").mockImplementation(mockGraphql);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	const listResult = (
		nodes: unknown[],
		sharedIpAddress: string | null = null,
	) => ({
		app: { sharedIpAddress, ipAddresses: { nodes } },
	});

	const inputs = {
		token: "tok",
		appName: "my-app",
		type: IpType.V4,
	};

	const props = {
		...inputs,
		address: "1.2.3.4",
		ipAddressId: "ip_1",
	};

	describe("create", () => {
		it("adopts an existing dedicated IP matching the type", async () => {
			mockGraphql.mockResolvedValueOnce(
				listResult([
					{ id: "ip_v6", address: "::1", type: "v6", region: null },
					{ id: "ip_1", address: "1.2.3.4", type: "v4", region: "global" },
				]),
			);

			const result = await new IpResourceProvider().create(inputs);

			expect(result.id).toBe("1.2.3.4");
			expect(result.outs.ipAddressId).toBe("ip_1");
			expect(mockGraphql).toHaveBeenCalledTimes(1); // no allocation
		});

		it("adopts the app's shared IPv4 when one is already assigned", async () => {
			mockGraphql.mockResolvedValueOnce(listResult([], "66.241.1.1"));

			const result = await new IpResourceProvider().create({
				...inputs,
				type: IpType.SHARED_V4,
			});

			expect(result.id).toBe("66.241.1.1");
			expect(result.outs.ipAddressId).toBeUndefined();
			expect(mockGraphql).toHaveBeenCalledTimes(1);
		});

		it("allocates a dedicated IP when none exists", async () => {
			mockGraphql
				.mockResolvedValueOnce(listResult([])) // nothing to adopt
				.mockResolvedValueOnce({
					allocateIpAddress: {
						ipAddress: {
							id: "ip_new",
							address: "5.6.7.8",
							type: "v4",
							region: "iad",
						},
						app: { sharedIpAddress: null },
					},
				});

			const result = await new IpResourceProvider().create({
				...inputs,
				region: "iad",
			});

			expect(result.id).toBe("5.6.7.8");
			expect(result.outs.ipAddressId).toBe("ip_new");

			const [, variables] = mockGraphql.mock.calls[1];

			expect(variables.input).toEqual({
				appId: "my-app",
				type: "v4",
				region: "iad",
			});
		});

		it("reads a shared_v4 allocation's address from app.sharedIpAddress (null ipAddress payload)", async () => {
			mockGraphql.mockResolvedValueOnce(listResult([])).mockResolvedValueOnce({
				allocateIpAddress: {
					ipAddress: null,
					app: { sharedIpAddress: "66.241.2.2" },
				},
			});

			const result = await new IpResourceProvider().create({
				...inputs,
				type: IpType.SHARED_V4,
			});

			expect(result.id).toBe("66.241.2.2");
			expect(result.outs.ipAddressId).toBeUndefined();
		});

		it("throws when the allocation returns no address", async () => {
			mockGraphql.mockResolvedValueOnce(listResult([])).mockResolvedValueOnce({
				allocateIpAddress: {
					ipAddress: null,
					app: { sharedIpAddress: null },
				},
			});

			await expect(new IpResourceProvider().create(inputs)).rejects.toThrow(
				"returned no address",
			);
		});
	});

	describe("read", () => {
		it("returns the current state when the IP is still allocated", async () => {
			mockGraphql.mockResolvedValueOnce(
				listResult([
					{ id: "ip_1", address: "1.2.3.4", type: "v4", region: "global" },
				]),
			);

			const result = await new IpResourceProvider().read("1.2.3.4", props);

			expect(result.id).toBe("1.2.3.4");
			expect(result.props?.ipAddressId).toBe("ip_1");
		});

		it("returns a blank result when the IP is gone (drift reconciled on refresh)", async () => {
			mockGraphql.mockResolvedValueOnce(listResult([]));

			const result = await new IpResourceProvider().read("1.2.3.4", props);

			expect(result).toEqual({});
		});
	});

	describe("delete", () => {
		it("releases by ipAddressId when present", async () => {
			mockGraphql.mockResolvedValueOnce({});

			await new IpResourceProvider().delete("1.2.3.4", props);

			const [, variables] = mockGraphql.mock.calls[0];

			expect(variables.input).toEqual({
				appId: "my-app",
				ipAddressId: "ip_1",
			});
		});

		it("releases by address when the node ID is absent (shared_v4)", async () => {
			mockGraphql.mockResolvedValueOnce({});

			await new IpResourceProvider().delete("66.241.1.1", {
				...inputs,
				type: IpType.SHARED_V4,
				address: "66.241.1.1",
			});

			const [, variables] = mockGraphql.mock.calls[0];
			expect(variables.input).toEqual({ appId: "my-app", ip: "66.241.1.1" });
		});

		it("tolerates an already-released IP (GraphQL not-found error)", async () => {
			mockGraphql.mockRejectedValueOnce(
				new Error("Fly GraphQL error: Could not find IP address"),
			);

			await expect(
				new IpResourceProvider().delete("1.2.3.4", props),
			).resolves.toBeUndefined();
		});

		it("rethrows errors other than not-found", async () => {
			mockGraphql.mockRejectedValueOnce(
				new Error("Fly GraphQL error: rate limited"),
			);

			await expect(
				new IpResourceProvider().delete("1.2.3.4", props),
			).rejects.toThrow("rate limited");
		});
	});

	describe("diff", () => {
		it("replaces on an appName change (delete-before-replace)", async () => {
			const diff = await new IpResourceProvider().diff("1.2.3.4", props, {
				...props,
				appName: "other-app",
			});

			expect(diff.changes).toBe(true);
			expect(diff.replaces).toEqual(["appName"]);
			expect(diff.deleteBeforeReplace).toBe(true);
		});

		it("replaces on a type change", async () => {
			const diff = await new IpResourceProvider().diff("1.2.3.4", props, {
				...props,
				type: IpType.V6,
			});

			expect(diff.replaces).toEqual(["type"]);
		});

		it("replaces on a region change", async () => {
			const diff = await new IpResourceProvider().diff("1.2.3.4", props, {
				...props,
				region: "fra",
			});

			expect(diff.replaces).toEqual(["region"]);
		});

		it("reports no changes when inputs are identical", async () => {
			const diff = await new IpResourceProvider().diff("1.2.3.4", props, props);

			expect(diff.changes).toBe(false);
			expect(diff.replaces).toEqual([]);
		});
	});
});
