import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RailwayClient } from "../client";
import { RailwayProjectTokenResourceProvider } from "../project-token";

describe("RailwayProjectTokenResourceProvider", () => {
	let mockQuery: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		mockQuery = vi.fn();
		vi.spyOn(RailwayClient.prototype, "query").mockImplementation(mockQuery);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("deletes only same-named tokens, mints one scoped to the environment, returns value + id", async () => {
		mockQuery
			.mockResolvedValueOnce({
				projectTokens: {
					edges: [
						{ node: { id: "tok-prod", name: "pulumi-production" } }, // different name → must NOT be deleted
						{ node: { id: "tok-stale", name: "pulumi-staging" } }, // same name → deleted
					],
				},
			})
			.mockResolvedValueOnce({ projectTokenDelete: true })
			.mockResolvedValueOnce({ projectTokenCreate: "new-token-value" })
			.mockResolvedValueOnce({
				projectTokens: {
					edges: [
						{ node: { id: "tok-new", name: "pulumi-staging" } },
						{ node: { id: "tok-prod", name: "pulumi-production" } },
					],
				},
			});

		const provider = new RailwayProjectTokenResourceProvider();

		const result = await provider.create({
			token: "tok",
			projectId: "proj-1",
			environmentId: "env-staging",
			name: "pulumi-staging",
		});

		const deleteCalls = mockQuery.mock.calls.filter(([q]) =>
			String(q).includes("projectTokenDelete"),
		);

		expect(deleteCalls).toHaveLength(1);
		expect(deleteCalls[0][1]).toEqual({ id: "tok-stale" });

		const createCall = mockQuery.mock.calls.find(([q]) =>
			String(q).includes("projectTokenCreate"),
		);

		expect(createCall?.[1]).toEqual({
			input: {
				projectId: "proj-1",
				environmentId: "env-staging",
				name: "pulumi-staging",
			},
		});

		expect(result.outs.value).toBe("new-token-value");
		expect(result.outs.tokenId).toBe("tok-new");
	});

	it("throws when the newly created token id cannot be resolved", async () => {
		mockQuery
			.mockResolvedValueOnce({ projectTokens: { edges: [] } }) // initial list (nothing to delete)
			.mockResolvedValueOnce({ projectTokenCreate: "new-token-value" }) // create
			.mockResolvedValueOnce({ projectTokens: { edges: [] } }); // re-list: token not found

		const provider = new RailwayProjectTokenResourceProvider();

		await expect(
			provider.create({
				token: "tok",
				projectId: "proj-1",
				environmentId: "env-staging",
				name: "pulumi-staging",
			}),
		).rejects.toThrow(/Could not resolve token id/);
	});
});
