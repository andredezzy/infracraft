import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
});
