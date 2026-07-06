import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RailwayClient } from "../client";
import { RailwayVariableResourceProvider } from "../variable";

describe("RailwayVariableResourceProvider", () => {
	let mockQuery: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		mockQuery = vi.fn();
		vi.spyOn(RailwayClient.prototype, "query").mockImplementation(mockQuery);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	const props = {
		token: "tok",
		projectId: "proj-1",
		serviceId: "svc-1",
		environmentId: "env-1",
		variables: { DATABASE_URL: "postgres://db", NODE_ENV: "production" },
	};

	describe("create", () => {
		it("upserts all variables in one batch with skipDeploys", async () => {
			mockQuery.mockResolvedValueOnce({ variableCollectionUpsert: true });

			const result = await new RailwayVariableResourceProvider().create(props);

			expect(result.id).toBe("svc-1:variables");
			expect(result.outs).toEqual(props);
			expect(mockQuery).toHaveBeenCalledTimes(1);

			const [mutation, variables] = mockQuery.mock.calls[0];
			expect(mutation).toContain("variableCollectionUpsert");

			expect(variables.input).toEqual({
				projectId: "proj-1",
				serviceId: "svc-1",
				environmentId: "env-1",
				variables: props.variables,
				skipDeploys: true,
			});
		});
	});

	describe("update", () => {
		it("deletes removed keys individually, then batch-upserts the rest", async () => {
			mockQuery.mockResolvedValue({});

			const news = { ...props, variables: { DATABASE_URL: "postgres://new" } };

			const result = await new RailwayVariableResourceProvider().update(
				"svc-1:variables",
				props,
				news,
			);

			expect(result.outs).toEqual(news);
			expect(mockQuery).toHaveBeenCalledTimes(2);

			const [deleteMutation, deleteVars] = mockQuery.mock.calls[0];
			expect(deleteMutation).toContain("variableDelete");
			expect(deleteVars.input.name).toBe("NODE_ENV");

			const [upsertMutation, upsertVars] = mockQuery.mock.calls[1];
			expect(upsertMutation).toContain("variableCollectionUpsert");
			expect(upsertVars.input.variables).toEqual(news.variables);
			expect(upsertVars.input.skipDeploys).toBe(true);
		});

		it("skips the upsert entirely when the new map is empty", async () => {
			mockQuery.mockResolvedValue({});

			await new RailwayVariableResourceProvider().update(
				"svc-1:variables",
				props,
				{ ...props, variables: {} },
			);

			expect(mockQuery).toHaveBeenCalledTimes(2); // one delete per old key
			for (const [mutation] of mockQuery.mock.calls) {
				expect(mutation).toContain("variableDelete");
			}
		});
	});

	describe("read", () => {
		it("passes persisted state through (Railway has no single-call variable read API)", async () => {
			const result = await new RailwayVariableResourceProvider().read(
				"svc-1:variables",
				props,
			);

			expect(result).toEqual({ id: "svc-1:variables", props });
			expect(mockQuery).not.toHaveBeenCalled();
		});
	});

	describe("delete", () => {
		it("deletes every variable individually", async () => {
			mockQuery.mockResolvedValue({});

			await new RailwayVariableResourceProvider().delete(
				"svc-1:variables",
				props,
			);

			expect(mockQuery).toHaveBeenCalledTimes(2);

			const deletedNames = mockQuery.mock.calls.map(
				([, variables]) => variables.input.name,
			);

			expect(deletedNames).toEqual(["DATABASE_URL", "NODE_ENV"]);
		});

		it("keeps deleting the remaining keys when one is already deleted (not-found)", async () => {
			mockQuery
				.mockRejectedValueOnce(new Error("Variable not found"))
				.mockResolvedValueOnce({});

			await expect(
				new RailwayVariableResourceProvider().delete("svc-1:variables", props),
			).resolves.toBeUndefined();

			expect(mockQuery).toHaveBeenCalledTimes(2);
		});

		it("rethrows a real error and stops deleting the remaining keys", async () => {
			mockQuery.mockRejectedValueOnce(new Error("forbidden"));

			await expect(
				new RailwayVariableResourceProvider().delete("svc-1:variables", props),
			).rejects.toThrow("forbidden");

			expect(mockQuery).toHaveBeenCalledTimes(1);
		});
	});

	describe("diff", () => {
		it("flags a change when a value differs", async () => {
			const diff = await new RailwayVariableResourceProvider().diff(
				"svc-1:variables",
				props,
				{
					...props,
					variables: { ...props.variables, NODE_ENV: "staging" },
				},
			);

			expect(diff.changes).toBe(true);
		});

		it("flags a change when the key set differs", async () => {
			const diff = await new RailwayVariableResourceProvider().diff(
				"svc-1:variables",
				props,
				{ ...props, variables: { DATABASE_URL: "postgres://db" } },
			);

			expect(diff.changes).toBe(true);
		});

		it("reports no changes when the map is identical", async () => {
			const diff = await new RailwayVariableResourceProvider().diff(
				"svc-1:variables",
				props,
				props,
			);

			expect(diff.changes).toBe(false);
		});
	});
});
