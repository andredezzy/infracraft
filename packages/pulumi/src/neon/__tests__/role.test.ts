import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiNotFoundError } from "../../errors/api-not-found-error";
import { NeonClient } from "../client";
import { NeonRoleResourceProvider } from "../role";

describe("NeonRoleResourceProvider", () => {
	let mockGet: ReturnType<typeof vi.fn>;
	let mockPost: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		mockGet = vi.fn();
		mockPost = vi.fn();
		vi.spyOn(NeonClient.prototype, "get").mockImplementation(mockGet);
		vi.spyOn(NeonClient.prototype, "post").mockImplementation(mockPost);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	describe("provider credentials", () => {
		it("resolves the API key from the env var named by apiKeyEnvVar", async () => {
			vi.stubEnv("INFRACRAFT_TEST_NEON_API_KEY", "env-key");

			const seenKeys: string[] = [];

			mockGet.mockImplementation(async function (this: unknown) {
				seenKeys.push((this as { apiKey: string }).apiKey);

				return { roles: [{ name: "neondb_owner" }] };
			});

			mockPost.mockResolvedValueOnce({ role: { password: "fresh-pw" } });

			const provider = new NeonRoleResourceProvider();

			await provider.create({
				apiKeyEnvVar: "INFRACRAFT_TEST_NEON_API_KEY",
				projectId: "proj",
				branchId: "br-staging",
				name: "neondb_owner",
				resetPassword: true,
			});

			expect(seenKeys[0]).toBe("env-key");
		});

		it("throws a loud error naming the env var when it is not set", async () => {
			const provider = new NeonRoleResourceProvider();

			await expect(
				provider.create({
					apiKeyEnvVar: "INFRACRAFT_TEST_NEON_API_KEY_UNSET",
					projectId: "proj",
					branchId: "br-staging",
					name: "neondb_owner",
					resetPassword: true,
				}),
			).rejects.toThrow(
				"provider credential env var INFRACRAFT_TEST_NEON_API_KEY_UNSET is not set in the Pulumi execution environment",
			);
		});
	});

	describe("create", () => {
		it("resets the password of an adopted role when resetPassword is true", async () => {
			mockGet.mockResolvedValueOnce({ roles: [{ name: "neondb_owner" }] }); // role exists
			mockPost.mockResolvedValueOnce({ role: { password: "fresh-pw" } }); // reset_password

			const provider = new NeonRoleResourceProvider();

			const result = await provider.create({
				apiKey: "key",
				projectId: "proj",
				branchId: "br-staging",
				name: "neondb_owner",
				resetPassword: true,
			});

			expect(mockPost).toHaveBeenCalledWith(
				"/projects/proj/branches/br-staging/roles/neondb_owner/reset_password",
				{},
			);

			// reveal_password (GET) must not be used when resetting.
			expect(mockGet).toHaveBeenCalledTimes(1); // only the roles-list check
			expect(result.outs.password).toBe("fresh-pw");
		});

		it("reveals the inherited password of an adopted role when resetPassword is false", async () => {
			mockGet
				.mockResolvedValueOnce({ roles: [{ name: "neondb_owner" }] }) // role exists
				.mockResolvedValueOnce({ password: "inherited-pw" }); // reveal_password

			const provider = new NeonRoleResourceProvider();

			const result = await provider.create({
				apiKey: "key",
				projectId: "proj",
				branchId: "br-staging",
				name: "neondb_owner",
				resetPassword: false,
			});

			expect(mockPost).not.toHaveBeenCalled();

			expect(mockGet).toHaveBeenCalledWith(
				"/projects/proj/branches/br-staging/roles/neondb_owner/reveal_password",
			);

			expect(result.outs.password).toBe("inherited-pw");
		});

		it("creates a new role and reveals its password when it does not exist (resetPassword ignored)", async () => {
			mockGet
				.mockResolvedValueOnce({ roles: [] }) // role does not exist
				.mockResolvedValueOnce({ password: "generated-pw" }); // reveal_password

			mockPost.mockResolvedValueOnce({}); // create role

			const provider = new NeonRoleResourceProvider();

			const result = await provider.create({
				apiKey: "key",
				projectId: "proj",
				branchId: "br-new",
				name: "neondb_owner",
				resetPassword: true,
			});

			expect(mockPost).toHaveBeenCalledWith(
				"/projects/proj/branches/br-new/roles",
				{ role: { name: "neondb_owner" } },
			);

			// A freshly created role already has its own password — no reset.
			expect(mockPost).not.toHaveBeenCalledWith(
				expect.stringContaining("reset_password"),
				expect.anything(),
			);

			expect(result.outs.password).toBe("generated-pw");
		});
	});

	describe("read", () => {
		const props = {
			apiKey: "key",
			projectId: "proj",
			branchId: "br-staging",
			name: "neondb_owner",
			resetPassword: false,
			password: "old-pw",
		};

		it("returns a blank ReadResult when the role is gone (deleted out of band)", async () => {
			mockGet.mockRejectedValueOnce(
				new ApiNotFoundError(
					"neon",
					"/projects/proj/branches/br-staging/roles/neondb_owner/reveal_password",
				),
			);

			const result = await new NeonRoleResourceProvider().read(
				"br-staging/neondb_owner",
				props,
			);

			expect(result).toEqual({});
		});

		it("rethrows non-404 errors", async () => {
			mockGet.mockRejectedValueOnce(new Error("Neon API error (500): boom"));

			await expect(
				new NeonRoleResourceProvider().read("br-staging/neondb_owner", props),
			).rejects.toThrow("500");
		});
	});

	describe("update (password rotation)", () => {
		const olds = {
			apiKey: "key",
			projectId: "proj",
			branchId: "br-staging",
			name: "neondb_owner",
			resetPassword: false,
			password: "old-pw",
		};

		it("rotates the password in place when passwordVersion changes", async () => {
			mockPost.mockResolvedValueOnce({ role: { password: "rotated-pw" } });

			const provider = new NeonRoleResourceProvider();

			const result = await provider.update("br-staging/neondb_owner", olds, {
				...olds,
				passwordVersion: 1,
			});

			expect(mockPost).toHaveBeenCalledWith(
				"/projects/proj/branches/br-staging/roles/neondb_owner/reset_password",
				{},
			);

			expect(result.outs?.password).toBe("rotated-pw");
		});

		it("keeps the password when passwordVersion is unchanged", async () => {
			const provider = new NeonRoleResourceProvider();

			const result = await provider.update(
				"br-staging/neondb_owner",
				{ ...olds, passwordVersion: 1 },
				{ ...olds, passwordVersion: 1 },
			);

			expect(mockPost).not.toHaveBeenCalled();
			expect(result.outs?.password).toBe("old-pw");
		});

		it("reports a rotation as an update, never a replace", async () => {
			const provider = new NeonRoleResourceProvider();

			const diff = await provider.diff("br-staging/neondb_owner", olds, {
				...olds,
				passwordVersion: 1,
			});

			expect(diff.changes).toBe(true);
			expect(diff.replaces).toEqual([]);
		});
	});

	describe("check", () => {
		const inputs = {
			apiKey: "key",
			projectId: "proj",
			branchId: "br-staging",
			name: "neondb_owner",
			resetPassword: false,
		};

		it("passes a valid role name through untouched", async () => {
			const result = await new NeonRoleResourceProvider().check(inputs, inputs);

			expect(result.inputs).toEqual(inputs);
			expect(result.failures).toEqual([]);
		});

		it("fails an empty role name, naming the property", async () => {
			const invalid = { ...inputs, name: "" };

			const result = await new NeonRoleResourceProvider().check(
				invalid,
				invalid,
			);

			expect(result.failures).toHaveLength(1);
			expect(result.failures?.[0].property).toBe("name");
			expect(result.failures?.[0].reason).toContain("non-empty");
		});
	});

	describe("diff (stables)", () => {
		const olds = {
			apiKey: "key",
			projectId: "proj",
			branchId: "br-staging",
			name: "neondb_owner",
			resetPassword: false,
			password: "old-pw",
		};

		it("declares identity fields stable on rotation — but never the password", async () => {
			const provider = new NeonRoleResourceProvider();

			const diff = await provider.diff("br-staging/neondb_owner", olds, {
				...olds,
				passwordVersion: 1,
			});

			expect(diff.stables).toEqual(["projectId", "branchId", "name"]);
			expect(diff.stables).not.toContain("password");
		});

		it("declares no stables when an identity change forces a replace", async () => {
			const provider = new NeonRoleResourceProvider();

			const diff = await provider.diff("br-staging/neondb_owner", olds, {
				...olds,
				branchId: "br-other",
			});

			expect(diff.replaces).toEqual(["branchId"]);
			expect(diff.stables).toEqual([]);
		});
	});
});
