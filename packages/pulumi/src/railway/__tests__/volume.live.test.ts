import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RailwayClient } from "../client";
import { RailwayEnvironmentResourceProvider } from "../environment";
import { RailwayServiceResourceProvider } from "../service";
import { RailwayVolumeResourceProvider } from "../volume";

/**
 * LIVE integration test for the Railway volume provider's ENVIRONMENT-SCOPED
 * adoption. Services are project-level and shared across environments, so
 * adoption keyed on the service alone once made a new stack adopt a SIBLING
 * environment's volume (production adopted staging's — live incident). This
 * asserts the fix against the real API: a volume attached to a service in
 * environment A is NOT adopted for the same service in environment B; each
 * environment gets its own volume, and re-creating within the same environment
 * adopts the existing one.
 *
 * INERT WITHOUT CREDENTIALS: self-skips unless `INFRACRAFT_LIVE_TEST=1` and
 * RAILWAY_TOKEN + RAILWAY_TEST_PROJECT_ID + RAILWAY_TEST_ENV_ID are all set.
 * A throwaway second environment is created and torn down by the test itself.
 * Run with: bun run test:live
 */

/** Fully-resolved live-test configuration; only present when the tier is enabled. */
interface RailwayLiveConfig {
	/** Railway account/team API token. */
	token: string;

	/** Throwaway Railway project UUID the test may freely mutate. */
	projectId: string;

	/** Environment A: a NON-default environment UUID inside that project. */
	envId: string;
}

/** Reads the live-test config, or `null` when the tier is disabled or any credential is missing. */
function readLiveConfig(): RailwayLiveConfig | null {
	if (process.env.INFRACRAFT_LIVE_TEST !== "1") {
		return null;
	}

	const token = process.env.RAILWAY_TOKEN;
	const projectId = process.env.RAILWAY_TEST_PROJECT_ID;
	const envId = process.env.RAILWAY_TEST_ENV_ID;

	if (!token || !projectId || !envId) {
		return null;
	}

	return { token, projectId, envId };
}

const VOLUME_DELETE = `
  mutation($volumeId: String!) { volumeDelete(volumeId: $volumeId) }
`;

const SERVICE_DELETE = `
  mutation($id: String!) { serviceDelete(id: $id) }
`;

const ENVIRONMENT_DELETE = `
  mutation($id: String!) { environmentDelete(id: $id) }
`;

const config = readLiveConfig();

describe.skipIf(!config)(
	"RailwayVolume environment-scoped adoption (live)",
	() => {
		// Guarded by skipIf: whenever a hook or test body below runs, `config` is non-null.
		const live = config as RailwayLiveConfig;

		const client = new RailwayClient(config?.token ?? "");
		const serviceProvider = new RailwayServiceResourceProvider();
		const environmentProvider = new RailwayEnvironmentResourceProvider();
		const volumeProvider = new RailwayVolumeResourceProvider();

		const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
		const serviceName = `ic-live-vol-${suffix}`;

		let serviceId = "";
		/** Environment B: a throwaway second environment created for the cross-env assertion. */
		let envBId = "";
		const createdVolumeIds = new Set<string>();

		beforeAll(async () => {
			if (!config) {
				return;
			}

			// A project-level service, materialized in environment A (the test env).
			const service = await serviceProvider.create({
				token: live.token,
				projectId: live.projectId,
				environmentId: live.envId,
				name: serviceName,
			});

			serviceId = service.id;

			// A throwaway environment B; adopt the same service into it so it has an
			// instance in both environments (volumes attach per service instance).
			const environment = await environmentProvider.create({
				token: live.token,
				projectId: live.projectId,
				name: `ic-live-env-${suffix}`,
			});

			envBId = environment.id;

			await serviceProvider.create({
				token: live.token,
				projectId: live.projectId,
				environmentId: envBId,
				name: serviceName,
			});
		});

		afterAll(async () => {
			if (!config) {
				return;
			}

			for (const volumeId of createdVolumeIds) {
				try {
					await client.query(VOLUME_DELETE, { volumeId });
				} catch (error) {
					console.warn(
						`[live cleanup] failed to delete Railway volume ${volumeId}: ${String(error)}`,
					);
				}
			}

			if (envBId) {
				try {
					await client.query(ENVIRONMENT_DELETE, { id: envBId });
				} catch (error) {
					console.warn(
						`[live cleanup] failed to delete Railway environment ${envBId}: ${String(error)}`,
					);
				}
			}

			if (serviceId) {
				try {
					await client.query(SERVICE_DELETE, { id: serviceId });
				} catch (error) {
					console.warn(
						`[live cleanup] failed to delete Railway service ${serviceId}: ${String(error)}`,
					);
				}
			}
		});

		it("does not adopt environment A's volume for the same service in environment B", async () => {
			const volumeInA = await volumeProvider.create({
				token: live.token,
				projectId: live.projectId,
				serviceId,
				environmentId: live.envId,
				mountPath: "/data",
			});

			createdVolumeIds.add(volumeInA.id);

			const volumeInB = await volumeProvider.create({
				token: live.token,
				projectId: live.projectId,
				serviceId,
				environmentId: envBId,
				mountPath: "/data",
			});

			createdVolumeIds.add(volumeInB.id);

			expect(
				volumeInB.id,
				"environment B must get its OWN volume, not adopt environment A's",
			).not.toBe(volumeInA.id);

			// Re-creating within environment A adopts the existing volume — adoption is
			// scoped to the environment, present within it and absent across it.
			const readoptedInA = await volumeProvider.create({
				token: live.token,
				projectId: live.projectId,
				serviceId,
				environmentId: live.envId,
				mountPath: "/data",
			});

			expect(readoptedInA.id).toBe(volumeInA.id);
		});
	},
);
