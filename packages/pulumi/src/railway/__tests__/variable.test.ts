import * as pulumi from "@pulumi/pulumi";
import { MockMonitor } from "@pulumi/pulumi/runtime/mocks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RailwayClient } from "../client";
import type { RailwayEnvironment } from "../environment";
import type { RailwayProject } from "../project";
import type { RailwayProvider } from "../provider";
import type { RailwayService } from "../service";
import { RailwayVariable, RailwayVariableResourceProvider } from "../variable";

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
		it("reads current values via the variables query", async () => {
			const liveVariables = { DATABASE_URL: "postgres://db-live" };
			mockQuery.mockResolvedValueOnce({ variables: liveVariables });

			const result = await new RailwayVariableResourceProvider().read(
				"svc-1:variables",
				props,
			);

			expect(result).toEqual({
				id: "svc-1:variables",
				props: { ...props, variables: liveVariables },
			});

			const [query, variables] = mockQuery.mock.calls[0];
			expect(query).toContain("variables(");

			expect(variables).toEqual({
				projectId: "proj-1",
				environmentId: "env-1",
				serviceId: "svc-1",
			});
		});

		it("returns blank state when the service/environment/project is gone (not-found)", async () => {
			mockQuery.mockRejectedValueOnce(new Error("Service not found"));

			const result = await new RailwayVariableResourceProvider().read(
				"svc-1:variables",
				props,
			);

			expect(result).toEqual({});
		});

		it("rethrows a real error", async () => {
			mockQuery.mockRejectedValueOnce(new Error("forbidden"));

			await expect(
				new RailwayVariableResourceProvider().read("svc-1:variables", props),
			).rejects.toThrow("forbidden");
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

describe("RailwayVariable component", () => {
	let capturedAdditionalSecretOutputs: string[];
	let originalRegisterResource: typeof MockMonitor.prototype.registerResource;

	beforeEach(async () => {
		capturedAdditionalSecretOutputs = [];
		originalRegisterResource = MockMonitor.prototype.registerResource;

		MockMonitor.prototype.registerResource = function (req, callback) {
			if (req.getType() === "pulumi-nodejs:dynamic:Resource") {
				capturedAdditionalSecretOutputs = req.getAdditionalsecretoutputsList();
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

	it("marks both token and variables as additionalSecretOutputs on the underlying dynamic resource", async () => {
		const provider = {
			token: pulumi.output("tok"),
			tokenEnvVar: undefined,
		} as unknown as RailwayProvider;

		const project = {
			id: pulumi.output("proj-1"),
		} as unknown as RailwayProject;

		const environment = {
			id: pulumi.output("env-1"),
		} as unknown as RailwayEnvironment;

		const service = { id: pulumi.output("svc-1") } as unknown as RailwayService;

		new RailwayVariable(
			"api-vars",
			{ variables: { DATABASE_URL: "postgres://db" } },
			{ provider, project, environment, service },
		);

		await new Promise((resolve) => setImmediate(resolve));

		expect(capturedAdditionalSecretOutputs).toEqual(
			expect.arrayContaining(["token", "variables"]),
		);
	});
});
