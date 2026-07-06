import { afterAll, describe, expect, it } from "vitest";
import { RailwayClient } from "../client";
import { RailwayServiceResourceProvider } from "../service";

/**
 * LIVE integration test for the Railway service provider. Runs the real
 * adopt-or-create / instance-materialization / deploy code paths against
 * Railway's GraphQL API, creating and tearing down throwaway services.
 *
 * Encodes the live-API-only truths that mocked unit tests cannot catch:
 *  - adopt-or-create is idempotent (a second create by name adopts, no duplicate);
 *  - `ensureServiceInstance` materializes a service instance in a NON-default
 *    environment via the config-patch commit (serviceCreate skips it there);
 *  - an image service actually deploys via `serviceInstanceDeployV2`;
 *  - `environmentUnskipService` is rejected in a named environment — which is
 *    WHY the patch-commit path exists instead of a simple unskip.
 *
 * INERT WITHOUT CREDENTIALS: the whole suite self-skips unless
 * `INFRACRAFT_LIVE_TEST=1` and RAILWAY_TOKEN + RAILWAY_TEST_PROJECT_ID +
 * RAILWAY_TEST_ENV_ID are all set. Run with: bun run test:live
 */

/** Fully-resolved live-test configuration; only present when the tier is enabled. */
interface RailwayLiveConfig {
	/** Railway account/team API token. */
	token: string;

	/** Throwaway Railway project UUID the test may freely mutate. */
	projectId: string;

	/** A NON-default environment UUID inside that project. */
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

const SERVICE_CREATE = `
  mutation($input: ServiceCreateInput!) {
    serviceCreate(input: $input) { id name }
  }
`;

const SERVICES_BY_PROJECT = `
  query($projectId: String!) {
    project(id: $projectId) {
      services { edges { node { id name } } }
    }
  }
`;

const SERVICE_INSTANCE = `
  query($serviceId: String!, $environmentId: String!) {
    serviceInstance(serviceId: $serviceId, environmentId: $environmentId) { id }
  }
`;

const SERVICE_INSTANCE_DEPLOY = `
  mutation($serviceId: String!, $environmentId: String!) {
    serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId)
  }
`;

const SERVICE_DELETE = `
  mutation($id: String!) { serviceDelete(id: $id) }
`;

/**
 * Attempts to unskip a service in a named environment. Railway rejects this
 * outside PR environments; the test asserts the rejection. The exact argument
 * shape mirrors the sibling `serviceInstanceDeployV2(serviceId, environmentId)`
 * mutation (this field is absent from Railway's public introspection subset, so
 * the signature is unverifiable offline — a schema-shaped error here means it
 * has drifted and must be re-checked against the live API).
 */
const ENVIRONMENT_UNSKIP_SERVICE = `
  mutation($serviceId: String!, $environmentId: String!) {
    environmentUnskipService(serviceId: $serviceId, environmentId: $environmentId)
  }
`;

interface ServicesByProject {
	project: {
		services: { edges: Array<{ node: { id: string; name: string } }> };
	};
}

interface ServiceInstanceProbe {
	serviceInstance: { id: string } | null;
}

const config = readLiveConfig();

describe.skipIf(!config)("RailwayService (live integration)", () => {
	// Guarded by skipIf: whenever a test body below runs, `config` is non-null.
	const live = config as RailwayLiveConfig;

	const client = new RailwayClient(config?.token ?? "");
	const provider = new RailwayServiceResourceProvider();

	/** Service IDs created by this file, swept in afterAll regardless of per-test outcome. */
	const createdServiceIds = new Set<string>();

	/** Generates a collision-resistant throwaway service name. */
	function uniqueServiceName(): string {
		return `ic-live-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
	}

	async function serviceInstanceExists(
		serviceId: string,
		environmentId: string,
	): Promise<boolean> {
		const result = await client.query<ServiceInstanceProbe>(SERVICE_INSTANCE, {
			serviceId,
			environmentId,
		});

		return Boolean(result.serviceInstance);
	}

	afterAll(async () => {
		if (!config) {
			return;
		}

		for (const serviceId of createdServiceIds) {
			try {
				await client.query(SERVICE_DELETE, { id: serviceId });
			} catch (error) {
				console.warn(
					`[live cleanup] failed to delete Railway service ${serviceId} — delete it manually: ${String(error)}`,
				);
			}
		}
	});

	it("adopts an existing service by name on a second create — same id, no duplicate", async () => {
		const name = uniqueServiceName();

		const first = await provider.create({
			token: live.token,
			projectId: live.projectId,
			environmentId: live.envId,
			name,
		});

		createdServiceIds.add(first.id);

		const second = await provider.create({
			token: live.token,
			projectId: live.projectId,
			environmentId: live.envId,
			name,
		});

		expect(second.id).toBe(first.id);

		const services = await client.query<ServicesByProject>(
			SERVICES_BY_PROJECT,
			{
				projectId: live.projectId,
			},
		);

		const matches = services.project.services.edges.filter(
			(edge) => edge.node.name === name,
		);

		expect(matches).toHaveLength(1);
	});

	it("materializes an instance in a non-default environment via the config-patch commit", async () => {
		const name = uniqueServiceName();

		// Create the service WITHOUT an environmentId: Railway materializes its
		// instance only in the project's default environment, so the test
		// environment is left in the silent-skip state that ensureServiceInstance
		// must repair.
		const created = await client.query<{ serviceCreate: { id: string } }>(
			SERVICE_CREATE,
			{ input: { projectId: live.projectId, name } },
		);

		const serviceId = created.serviceCreate.id;
		createdServiceIds.add(serviceId);

		expect(
			await serviceInstanceExists(serviceId, live.envId),
			"precondition: the service must start with no instance in the test environment",
		).toBe(false);

		// Adopting the same service through the provider runs ensureServiceInstance,
		// which commits a config patch to materialize the missing instance.
		const adopted = await provider.create({
			token: live.token,
			projectId: live.projectId,
			environmentId: live.envId,
			name,
		});

		expect(adopted.id).toBe(serviceId);

		expect(
			await serviceInstanceExists(serviceId, live.envId),
			"the config-patch commit must materialize the instance in the test environment",
		).toBe(true);
	});

	it("deploys an image service via serviceInstanceDeployV2", async () => {
		const name = uniqueServiceName();

		const created = await provider.create({
			token: live.token,
			projectId: live.projectId,
			environmentId: live.envId,
			name,
			source: { image: "redis:8-alpine" },
		});

		createdServiceIds.add(created.id);

		const result = await client.query<{ serviceInstanceDeployV2: string }>(
			SERVICE_INSTANCE_DEPLOY,
			{ serviceId: created.id, environmentId: live.envId },
		);

		expect(typeof result.serviceInstanceDeployV2).toBe("string");
		expect(result.serviceInstanceDeployV2.length).toBeGreaterThan(0);
	});

	it("rejects environmentUnskipService in a named environment (why patch-commit exists)", async () => {
		const name = uniqueServiceName();

		const created = await provider.create({
			token: live.token,
			projectId: live.projectId,
			environmentId: live.envId,
			name,
		});

		createdServiceIds.add(created.id);

		let rejection: unknown;

		try {
			await client.query(ENVIRONMENT_UNSKIP_SERVICE, {
				serviceId: created.id,
				environmentId: live.envId,
			});
		} catch (error) {
			rejection = error;
		}

		expect(
			rejection,
			"environmentUnskipService unexpectedly SUCCEEDED in a named environment — the patch-commit workaround may no longer be needed; re-verify the materialization strategy",
		).toBeInstanceOf(Error);

		const message = (rejection as Error).message;

		expect(
			/unskip|pr environment|pull request/i.test(message),
			`Expected a "can only unskip in PR environments" rejection, got: ${message}. A schema-shaped error means the mutation signature drifted — re-verify environmentUnskipService against Railway's live API.`,
		).toBe(true);
	});
});
