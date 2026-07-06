import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "../client";
import { ProjectTokenResourceProvider } from "../project-token";

describe("railway.ProjectTokenResourceProvider", () => {
	let mockQuery: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		mockQuery = vi.fn();
		vi.spyOn(Client.prototype, "query").mockImplementation(mockQuery);
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

		const provider = new ProjectTokenResourceProvider();

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

		const provider = new ProjectTokenResourceProvider();

		await expect(
			provider.create({
				token: "tok",
				projectId: "proj-1",
				environmentId: "env-staging",
				name: "pulumi-staging",
			}),
		).rejects.toThrow(/Could not resolve token id/);
	});

	describe("delete", () => {
		const props = {
			token: "provider-tok",
			projectId: "proj-1",
			environmentId: "env-staging",
			name: "pulumi-staging",
			value: "minted-tok",
			tokenId: "tok-id-1",
		};

		it("revokes the token by its stored id", async () => {
			mockQuery.mockResolvedValueOnce({ projectTokenDelete: true });

			await new ProjectTokenResourceProvider().delete(
				"proj-1:pulumi-staging",
				props,
			);

			const [mutation, vars] = mockQuery.mock.calls[0];
			expect(mutation).toContain("projectTokenDelete");
			expect(vars).toEqual({ id: "tok-id-1" });
		});

		it("resolves when the token is already revoked (rotation cleanup deleted it first)", async () => {
			mockQuery.mockRejectedValueOnce(
				new Error("Railway API error: ProjectToken not found"),
			);

			await expect(
				new ProjectTokenResourceProvider().delete(
					"proj-1:pulumi-staging",
					props,
				),
			).resolves.toBeUndefined();
		});

		it("rethrows errors other than not-found", async () => {
			mockQuery.mockRejectedValueOnce(
				new Error("Railway API error: Not authorized"),
			);

			await expect(
				new ProjectTokenResourceProvider().delete(
					"proj-1:pulumi-staging",
					props,
				),
			).rejects.toThrow("Not authorized");
		});
	});

	describe("read", () => {
		const props = {
			token: "provider-tok",
			projectId: "proj-1",
			environmentId: "env-staging",
			name: "pulumi-staging",
			value: "minted-tok",
			tokenId: "tok-id-1",
		};

		it("keeps the stored state when the token still exists in the list", async () => {
			mockQuery.mockResolvedValueOnce({
				projectTokens: {
					edges: [{ node: { id: "tok-id-1", name: "pulumi-staging" } }],
				},
			});

			const result = await new ProjectTokenResourceProvider().read(
				"proj-1:pulumi-staging",
				props,
			);

			expect(result).toEqual({ id: "proj-1:pulumi-staging", props });

			const [query, vars] = mockQuery.mock.calls[0];
			expect(query).toContain("projectTokens");
			expect(vars).toEqual({ projectId: "proj-1" });
		});

		it("returns blank state when the tokenId is absent from the list (revoked via dashboard)", async () => {
			mockQuery.mockResolvedValueOnce({
				projectTokens: {
					edges: [{ node: { id: "tok-other", name: "pulumi-production" } }],
				},
			});

			const result = await new ProjectTokenResourceProvider().read(
				"proj-1:pulumi-staging",
				props,
			);

			expect(result).toEqual({});
		});
	});

	describe("diff (rotation)", () => {
		const olds = {
			token: "provider-tok",
			projectId: "proj-1",
			environmentId: "env-staging",
			name: "pulumi-staging",
			value: "minted-tok",
			tokenId: "tok-id-1",
		};

		it("reports a tokenVersion bump as a create-before-delete replace", async () => {
			const provider = new ProjectTokenResourceProvider();

			const diff = await provider.diff("env-staging/pulumi-staging", olds, {
				...olds,
				tokenVersion: 1,
			});

			expect(diff.changes).toBe(true);
			expect(diff.replaces).toEqual(["tokenVersion"]);
			// The new token must exist before the old one is revoked — no
			// tokenless window during rotation.
			expect(diff.deleteBeforeReplace).toBe(false);
		});

		it("keeps delete-before-replace for identity changes", async () => {
			const provider = new ProjectTokenResourceProvider();

			const diff = await provider.diff("env-staging/pulumi-staging", olds, {
				...olds,
				name: "pulumi-staging-renamed",
			});

			expect(diff.replaces).toEqual(["name"]);
			expect(diff.deleteBeforeReplace).toBe(true);
		});

		it("reports no change when tokenVersion is stable", async () => {
			const provider = new ProjectTokenResourceProvider();

			const diff = await provider.diff(
				"env-staging/pulumi-staging",
				{ ...olds, tokenVersion: 1 },
				{ ...olds, tokenVersion: 1 },
			);

			expect(diff.changes).toBe(false);
		});
	});
});
