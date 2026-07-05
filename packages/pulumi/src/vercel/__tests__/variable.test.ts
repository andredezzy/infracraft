import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiNotFoundError } from "../../errors/api-not-found-error";
import { VercelClient } from "../client";
import { VercelVariableResourceProvider } from "../variable";

describe("VercelVariableResourceProvider", () => {
	let mockGet: ReturnType<typeof vi.fn>;
	let mockTryGet: ReturnType<typeof vi.fn>;
	let mockPost: ReturnType<typeof vi.fn>;
	let mockPatch: ReturnType<typeof vi.fn>;
	let mockDelete: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		mockGet = vi.fn();
		mockTryGet = vi.fn();
		mockPost = vi.fn();
		mockPatch = vi.fn();
		mockDelete = vi.fn();
		vi.spyOn(VercelClient.prototype, "get").mockImplementation(mockGet);
		vi.spyOn(VercelClient.prototype, "tryGet").mockImplementation(mockTryGet);
		vi.spyOn(VercelClient.prototype, "post").mockImplementation(mockPost);
		vi.spyOn(VercelClient.prototype, "patch").mockImplementation(mockPatch);
		vi.spyOn(VercelClient.prototype, "delete").mockImplementation(mockDelete);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	const inputs = {
		token: "tok",
		teamId: "team_1",
		projectId: "prj_1",
		variables: { API_URL: "https://api", NODE_ENV: "production" },
	};

	const props = {
		...inputs,
		envIds: { API_URL: "env_a", NODE_ENV: "env_b" },
		contentHash: "hash-old",
	};

	describe("create", () => {
		it("creates each variable (encrypted, all targets) and records its env ID", async () => {
			mockPost
				.mockResolvedValueOnce({ id: "env_a", key: "API_URL" })
				.mockResolvedValueOnce({ id: "env_b", key: "NODE_ENV" });

			const result = await new VercelVariableResourceProvider().create(inputs);

			expect(result.id).toBe("prj_1:variables");

			expect(result.outs.envIds).toEqual({
				API_URL: "env_a",
				NODE_ENV: "env_b",
			});

			expect(result.outs.contentHash).toMatch(/^[0-9a-f]{64}$/);

			expect(mockPost).toHaveBeenCalledWith("/v10/projects/prj_1/env", {
				key: "API_URL",
				value: "https://api",
				type: "encrypted",
				target: ["production", "preview", "development"],
			});
		});

		it("updates in place when a key already exists (ENV_CONFLICT)", async () => {
			mockPost.mockRejectedValueOnce(
				new Error("Vercel API error (400): ENV_CONFLICT"),
			);

			mockGet.mockResolvedValueOnce({
				envs: [{ id: "env_x", key: "API_URL" }],
			});

			mockTryGet.mockResolvedValueOnce({
				id: "env_x",
				key: "API_URL",
				value: "stale",
			});

			mockPatch.mockResolvedValueOnce({});

			const result = await new VercelVariableResourceProvider().create({
				...inputs,
				variables: { API_URL: "https://api" },
			});

			expect(result.outs.envIds).toEqual({ API_URL: "env_x" });

			expect(mockPatch).toHaveBeenCalledWith("/v9/projects/prj_1/env/env_x", {
				value: "https://api",
			});
		});
	});

	describe("update", () => {
		it("deletes removed keys, patches changed values, and creates new keys", async () => {
			mockDelete.mockResolvedValueOnce(undefined); // NODE_ENV removed
			mockPatch.mockResolvedValueOnce({}); // API_URL changed
			mockPost.mockResolvedValueOnce({ id: "env_c", key: "NEW_KEY" });

			const result = await new VercelVariableResourceProvider().update(
				"prj_1:variables",
				props,
				{
					...inputs,
					variables: { API_URL: "https://api-v2", NEW_KEY: "x" },
				},
			);

			expect(mockDelete).toHaveBeenCalledWith("/v9/projects/prj_1/env/env_b");

			expect(mockPatch).toHaveBeenCalledWith("/v9/projects/prj_1/env/env_a", {
				value: "https://api-v2",
			});

			expect(result.outs?.envIds).toEqual({
				API_URL: "env_a",
				NEW_KEY: "env_c",
			});

			expect(result.outs?.contentHash).not.toBe(props.contentHash);
		});

		it("touches nothing when values are unchanged", async () => {
			const result = await new VercelVariableResourceProvider().update(
				"prj_1:variables",
				props,
				inputs,
			);

			expect(mockDelete).not.toHaveBeenCalled();
			expect(mockPatch).not.toHaveBeenCalled();
			expect(mockPost).not.toHaveBeenCalled();
			expect(result.outs?.envIds).toEqual(props.envIds);
		});
	});

	describe("read", () => {
		it("reflects the live API state so refresh surfaces drift", async () => {
			mockGet.mockResolvedValueOnce({
				envs: [
					{ id: "env_a", key: "API_URL" },
					{ id: "env_b", key: "NODE_ENV" },
				],
			});

			mockTryGet
				.mockResolvedValueOnce({
					id: "env_a",
					key: "API_URL",
					value: "https://drifted",
				})
				.mockResolvedValueOnce({
					id: "env_b",
					key: "NODE_ENV",
					value: "production",
				});

			const result = await new VercelVariableResourceProvider().read(
				"prj_1:variables",
				props,
			);

			expect(result.props?.variables).toEqual({
				API_URL: "https://drifted",
				NODE_ENV: "production",
			});

			expect(result.props?.envIds).toEqual(props.envIds);
			expect(result.props?.contentHash).not.toBe(props.contentHash);
		});

		it("drops a variable deleted out of band from the refreshed state", async () => {
			mockGet.mockResolvedValueOnce({
				envs: [{ id: "env_a", key: "API_URL" }],
			});

			mockTryGet.mockResolvedValueOnce({
				id: "env_a",
				key: "API_URL",
				value: "https://api",
			});

			const result = await new VercelVariableResourceProvider().read(
				"prj_1:variables",
				props,
			);

			expect(result.props?.variables).toEqual({ API_URL: "https://api" });
			expect(result.props?.envIds).toEqual({ API_URL: "env_a" });
		});
	});

	describe("delete", () => {
		it("deletes every recorded env ID", async () => {
			mockDelete.mockResolvedValue(undefined);

			await new VercelVariableResourceProvider().delete(
				"prj_1:variables",
				props,
			);

			expect(mockDelete).toHaveBeenCalledWith("/v9/projects/prj_1/env/env_a");
			expect(mockDelete).toHaveBeenCalledWith("/v9/projects/prj_1/env/env_b");
		});

		it("tolerates an already-deleted variable (404)", async () => {
			mockDelete.mockRejectedValue(
				new ApiNotFoundError("vercel", "/v9/projects/prj_1/env/env_a"),
			);

			await expect(
				new VercelVariableResourceProvider().delete("prj_1:variables", props),
			).resolves.toBeUndefined();
		});

		it("keeps deleting the remaining keys when one deletion fails", async () => {
			mockDelete
				.mockRejectedValueOnce(new Error("Vercel API error (500): boom"))
				.mockResolvedValueOnce(undefined);

			await expect(
				new VercelVariableResourceProvider().delete("prj_1:variables", props),
			).resolves.toBeUndefined();

			expect(mockDelete).toHaveBeenCalledTimes(2);
		});
	});

	describe("diff", () => {
		it("flags a change when a value differs", async () => {
			const diff = await new VercelVariableResourceProvider().diff(
				"prj_1:variables",
				props,
				{
					...inputs,
					variables: { ...inputs.variables, API_URL: "https://api-v2" },
				},
			);

			expect(diff.changes).toBe(true);
		});

		it("reports no changes when the map is identical", async () => {
			const diff = await new VercelVariableResourceProvider().diff(
				"prj_1:variables",
				props,
				inputs,
			);

			expect(diff.changes).toBe(false);
		});
	});
});
