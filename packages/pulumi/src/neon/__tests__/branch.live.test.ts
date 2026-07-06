import { afterAll, describe, expect, it } from "vitest";
import { BranchResourceProvider } from "../branch";
import { Client } from "../client";

/**
 * LIVE integration test for the Neon branch provider's copy-on-write fork.
 * Creating a branch with a `parent` resolves that parent's name to a
 * `parent_id` and forks from it (copy-on-write) rather than from the project
 * root. This asserts against the real API that the created branch's
 * `parent_id` is exactly the resolved parent branch — a fact the mocked unit
 * tests cannot observe.
 *
 * INERT WITHOUT CREDENTIALS: self-skips unless `INFRACRAFT_LIVE_TEST=1` and
 * NEON_API_KEY + NEON_TEST_PROJECT_ID are set. Run with: bun run test:live
 */

/** Fully-resolved live-test configuration; only present when the tier is enabled. */
interface LiveConfig {
	/** Neon API key (account- or project-scoped). */
	apiKey: string;

	/** Throwaway Neon project ID the test may freely mutate. */
	projectId: string;
}

/** Reads the live-test config, or `null` when the tier is disabled or any credential is missing. */
function readLiveConfig(): LiveConfig | null {
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

/** A Neon branch as returned by the list and get endpoints (subset this test reads). */
interface Branch {
	/** Branch ID (e.g. `"br-dawn-scene-747675"`). */
	id: string;

	/** Branch display name. */
	name: string;

	/** ID of the branch this one was forked from; absent on the project root branch. */
	parent_id?: string;
}

interface BranchListResponse {
	branches: Branch[];
}

interface BranchGetResponse {
	branch: Branch;
}

const config = readLiveConfig();

describe.skipIf(!config)("neon.Branch copy-on-write fork (live)", () => {
	// Guarded by skipIf: whenever a hook or test body below runs, `config` is non-null.
	const live = config as LiveConfig;

	const client = new Client(config?.apiKey ?? "");
	const branchProvider = new BranchResourceProvider();

	/** The forked child branch, deleted in afterAll. */
	let childBranchId = "";

	afterAll(async () => {
		if (!config || !childBranchId) {
			return;
		}

		try {
			await client.delete(
				`/projects/${live.projectId}/branches/${childBranchId}`,
			);
		} catch (error) {
			console.warn(
				`[live cleanup] failed to delete Neon branch ${childBranchId} — delete it manually: ${String(error)}`,
			);
		}
	});

	it("forks a copy-on-write child from the named parent branch", async () => {
		const branches = await client.get<BranchListResponse>(
			`/projects/${live.projectId}/branches`,
		);

		// The project root is the only branch without a parent; fork from it.
		const root = branches.branches.find((branch) => !branch.parent_id);

		expect(
			root,
			"expected a root branch (one without a parent_id) in the test project",
		).toBeDefined();

		const parent = root as Branch;

		const child = await branchProvider.create({
			apiKey: live.apiKey,
			projectId: live.projectId,
			name: `ic-live-fork-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
			parentName: parent.name,
		});

		childBranchId = child.id;

		const created = await client.get<BranchGetResponse>(
			`/projects/${live.projectId}/branches/${child.id}`,
		);

		expect(
			created.branch.parent_id,
			"the forked branch must point at the resolved parent (copy-on-write), not the project root implicitly",
		).toBe(parent.id);
	});
});
