import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NeonBranchResourceProvider } from "../branch";
import { NeonClient } from "../client";
import { NeonRoleResourceProvider } from "../role";

/**
 * LIVE integration test for the Neon role provider, on a throwaway copy-on-write
 * branch. Encodes two live-API-only truths:
 *  - adopt-or-create is idempotent (a second create by name adopts, no duplicate);
 *  - a `passwordVersion` bump rotates the password IN PLACE via `reset_password`
 *    — an UPDATE that returns a fresh password, NOT a replace. Replacing a
 *    default role would try to delete it (which Neon refuses) and drop real
 *    grants; so `diff()` must report no `replaces` and `update()` must return
 *    the new secret.
 *
 * INERT WITHOUT CREDENTIALS: self-skips unless `INFRACRAFT_LIVE_TEST=1` and
 * NEON_API_KEY + NEON_TEST_PROJECT_ID are set. Run with: bun run test:live
 */

/** Fully-resolved live-test configuration; only present when the tier is enabled. */
interface NeonLiveConfig {
	/** Neon API key (account- or project-scoped). */
	apiKey: string;

	/** Throwaway Neon project ID the test may freely mutate. */
	projectId: string;
}

/** Reads the live-test config, or `null` when the tier is disabled or any credential is missing. */
function readLiveConfig(): NeonLiveConfig | null {
	if (process.env.INFRACRAFT_LIVE_TEST !== "1") {
		return null;
	}

	const apiKey = process.env.NEON_API_KEY;
	const projectId = process.env.NEON_TEST_PROJECT_ID;

	if (!apiKey || !projectId) {
		return null;
	}

	return { apiKey, projectId };
}

/** Shape of the persisted role outputs this test reads back from the provider. */
interface RoleOutputs {
	/** The role's password, revealed or freshly rotated. */
	password: string;
}

interface RoleListResponse {
	roles: Array<{ name: string }>;
}

const config = readLiveConfig();

describe.skipIf(!config)("NeonRole (live integration)", () => {
	// Guarded by skipIf: whenever a hook or test body below runs, `config` is non-null.
	const live = config as NeonLiveConfig;

	const client = new NeonClient(config?.apiKey ?? "");
	const branchProvider = new NeonBranchResourceProvider();
	const roleProvider = new NeonRoleResourceProvider();

	/** A throwaway branch that carries every role created here; deleted in afterAll. */
	let branchId = "";

	function uniqueRoleName(): string {
		return `ic_live_role_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
	}

	beforeAll(async () => {
		if (!config) {
			return;
		}

		const branch = await branchProvider.create({
			apiKey: live.apiKey,
			projectId: live.projectId,
			name: `ic-live-role-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
		});

		branchId = branch.id;
	});

	afterAll(async () => {
		if (!config || !branchId) {
			return;
		}

		// Deleting the branch cascades its roles — no per-role teardown needed.
		try {
			await client.delete(`/projects/${live.projectId}/branches/${branchId}`);
		} catch (error) {
			console.warn(
				`[live cleanup] failed to delete Neon branch ${branchId} — delete it manually: ${String(error)}`,
			);
		}
	});

	it("adopts an existing role by name on a second create — same id, no duplicate", async () => {
		const name = uniqueRoleName();

		const first = await roleProvider.create({
			apiKey: live.apiKey,
			projectId: live.projectId,
			branchId,
			name,
			resetPassword: false,
		});

		const second = await roleProvider.create({
			apiKey: live.apiKey,
			projectId: live.projectId,
			branchId,
			name,
			resetPassword: false,
		});

		expect(second.id).toBe(first.id);

		const roles = await client.get<RoleListResponse>(
			`/projects/${live.projectId}/branches/${branchId}/roles`,
		);

		const matches = roles.roles.filter((role) => role.name === name);

		expect(matches).toHaveLength(1);
	});

	it("rotates the password in place on a passwordVersion bump — new secret, no replace", async () => {
		const name = uniqueRoleName();

		const created = await roleProvider.create({
			apiKey: live.apiKey,
			projectId: live.projectId,
			branchId,
			name,
			resetPassword: false,
		});

		// `create().outs` is the provider's full persisted state (typed `any` by
		// Pulumi); pass it straight into diff/update, and read only `password`.
		const oldOutputs = created.outs;
		const oldPassword = (oldOutputs as RoleOutputs).password;

		const news = {
			apiKey: live.apiKey,
			projectId: live.projectId,
			branchId,
			name,
			resetPassword: false,
			passwordVersion: 1,
		};

		const diff = await roleProvider.diff(created.id, oldOutputs, news);

		expect(diff.changes).toBe(true);

		expect(
			diff.replaces ?? [],
			"a passwordVersion bump must rotate in place, never replace the role",
		).toEqual([]);

		const updated = await roleProvider.update(created.id, oldOutputs, news);
		const newPassword = (updated.outs as RoleOutputs).password;

		expect(typeof newPassword).toBe("string");
		expect(newPassword.length).toBeGreaterThan(0);

		expect(
			newPassword,
			"reset_password must return a genuinely NEW password",
		).not.toBe(oldPassword);
	});
});
