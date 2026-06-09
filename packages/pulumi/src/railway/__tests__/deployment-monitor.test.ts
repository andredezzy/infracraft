import { describe, expect, it, vi } from "vitest";

import {
	MonitorOutcome,
	monitorRailwayDeployment,
	parseDeploymentId,
} from "../deployment-monitor";

/**
 * A fetch double that routes Railway GraphQL calls by the operation in the body
 * and lets each operation return a scripted sequence of payloads (one per call).
 */
function makeFetch(routes: {
	deployment?: Array<{ status: string } | null>;
	deployments?: Array<Array<{ id: string; status: string; createdAt: string }>>;
	buildLogs?: Array<{ message: string }>;
	deploymentLogs?: Array<{ message: string }>;
	/** Calls that should reject before resolving (transient network errors). */
	rejectFirst?: number;
}) {
	const cursors = { deployment: 0, deployments: 0 };
	let rejectsLeft = routes.rejectFirst ?? 0;

	const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
		if (rejectsLeft > 0) {
			rejectsLeft--;
			throw new Error("network down");
		}

		const body = String(init.body);

		const data = (() => {
			if (body.includes("deploymentLogs")) {
				return { deploymentLogs: routes.deploymentLogs ?? [] };
			}

			if (body.includes("buildLogs")) {
				return { buildLogs: routes.buildLogs ?? [] };
			}

			if (body.includes("deployment(")) {
				const seq = routes.deployment ?? [];
				const node = seq[Math.min(cursors.deployment, seq.length - 1)];
				cursors.deployment++;

				return { deployment: node };
			}

			if (body.includes("deployments(")) {
				const seq = routes.deployments ?? [];
				const nodes = seq[Math.min(cursors.deployments, seq.length - 1)] ?? [];
				cursors.deployments++;

				return { deployments: { edges: nodes.map((node) => ({ node })) } };
			}

			return {};
		})();

		return { ok: true, json: async () => ({ data }) };
	});

	return fetchMock as unknown as typeof fetch;
}

function makeDeps(fetchMock: typeof fetch) {
	const lines: string[] = [];

	return {
		deps: {
			fetch: fetchMock,
			sleep: async () => {},
			log: (line: string) => {
				lines.push(line);
			},
		},
		lines,
	};
}

const baseInput = {
	projectToken: "tok",
	projectId: "proj",
	environmentId: "env",
	serviceId: "svc",
	since: 1000,
	uploadExitCode: 0,
	deploymentId: "dep-1",
	resolveIntervalMs: 0,
	pollIntervalMs: 0,
};

describe("parseDeploymentId", () => {
	it("reads the id from `railway up --json` object output", () => {
		expect(parseDeploymentId('{"deploymentId":"abc-123"}')).toBe("abc-123");
	});

	it("reads a nested deployment.id", () => {
		expect(parseDeploymentId('{"deployment":{"id":"nested-9"}}')).toBe(
			"nested-9",
		);
	});

	it("extracts the id from a Build Logs URL query param", () => {
		const out =
			"Build Logs: https://railway.com/project/p/service/s?id=11111111-2222-3333-4444-555555555555&";
		expect(parseDeploymentId(out)).toBe("11111111-2222-3333-4444-555555555555");
	});

	it("returns undefined when no id is present", () => {
		expect(parseDeploymentId("Indexing...\nUploading...")).toBeUndefined();
	});
});

describe("monitorRailwayDeployment", () => {
	it("passes when the deployment reaches SUCCESS", async () => {
		const { deps } = makeDeps(
			makeFetch({ deployment: [{ status: "SUCCESS" }] }),
		);

		const result = await monitorRailwayDeployment(baseInput, deps);

		expect(result.outcome).toBe(MonitorOutcome.SUCCESS);
		expect(result.failed).toBe(false);
	});

	it("treats SLEEPING (scaled-to-zero) as success", async () => {
		const { deps } = makeDeps(
			makeFetch({ deployment: [{ status: "SLEEPING" }] }),
		);

		const result = await monitorRailwayDeployment(baseInput, deps);

		expect(result.failed).toBe(false);
	});

	it("treats SKIPPED (superseded) as non-blocking", async () => {
		const { deps } = makeDeps(
			makeFetch({ deployment: [{ status: "SKIPPED" }] }),
		);

		const result = await monitorRailwayDeployment(baseInput, deps);

		expect(result.outcome).toBe(MonitorOutcome.SKIPPED);
		expect(result.failed).toBe(false);
	});

	it("polls through non-terminal states until SUCCESS", async () => {
		const { deps } = makeDeps(
			makeFetch({
				deployment: [
					{ status: "BUILDING" },
					{ status: "DEPLOYING" },
					{ status: "SUCCESS" },
				],
			}),
		);

		const result = await monitorRailwayDeployment(baseInput, deps);

		expect(result.failed).toBe(false);
	});

	it("FAILS the resource and surfaces detailed build + deploy logs on FAILED", async () => {
		const { deps, lines } = makeDeps(
			makeFetch({
				deployment: [{ status: "FAILED" }],
				buildLogs: [{ message: "npm ERR! build broke" }],
				deploymentLogs: [{ message: "Error: boom on boot" }],
			}),
		);

		const result = await monitorRailwayDeployment(baseInput, deps);

		expect(result.outcome).toBe(MonitorOutcome.FAILED);
		expect(result.failed).toBe(true);

		const dump = lines.join("\n");
		expect(dump).toContain("npm ERR! build broke");
		expect(dump).toContain("Error: boom on boot");
	});

	it("treats CRASHED as a failure", async () => {
		const { deps } = makeDeps(
			makeFetch({ deployment: [{ status: "CRASHED" }] }),
		);

		const result = await monitorRailwayDeployment(baseInput, deps);

		expect(result.failed).toBe(true);
	});

	it("is resilient to transient network errors while polling", async () => {
		const { deps } = makeDeps(
			makeFetch({ deployment: [{ status: "SUCCESS" }], rejectFirst: 3 }),
		);

		const result = await monitorRailwayDeployment(baseInput, deps);

		expect(result.failed).toBe(false);
	});

	it("resolves the deployment id by createdAt when none was captured", async () => {
		const { deps } = makeDeps(
			makeFetch({
				deployments: [
					[
						{ id: "old", status: "SUCCESS", createdAt: "1970-01-01T00:00:00Z" },
						{
							id: "new",
							status: "BUILDING",
							createdAt: "2026-06-09T02:00:00Z",
						},
					],
				],
				deployment: [{ status: "SUCCESS" }],
			}),
		);

		const result = await monitorRailwayDeployment(
			{ ...baseInput, deploymentId: undefined, since: 2000 },
			deps,
		);

		expect(result.deploymentId).toBe("new");
		expect(result.failed).toBe(false);
	});

	it("FAILS when no deployment can be resolved AND the upload itself failed", async () => {
		const { deps } = makeDeps(makeFetch({ deployments: [[]] }));

		const result = await monitorRailwayDeployment(
			{
				...baseInput,
				deploymentId: undefined,
				uploadExitCode: 1,
				resolveAttempts: 1,
			},
			deps,
		);

		expect(result.outcome).toBe(MonitorOutcome.NO_DEPLOYMENT);
		expect(result.failed).toBe(true);
	});

	it("does NOT fail when no deployment resolves but the upload succeeded (benign race)", async () => {
		const { deps } = makeDeps(makeFetch({ deployments: [[]] }));

		const result = await monitorRailwayDeployment(
			{
				...baseInput,
				deploymentId: undefined,
				uploadExitCode: 0,
				resolveAttempts: 1,
			},
			deps,
		);

		expect(result.failed).toBe(false);
	});

	it("times out (and fails) if the deployment never reaches a terminal state", async () => {
		const { deps } = makeDeps(
			makeFetch({ deployment: [{ status: "BUILDING" }] }),
		);

		const result = await monitorRailwayDeployment(
			{ ...baseInput, pollAttempts: 3 },
			deps,
		);

		expect(result.outcome).toBe(MonitorOutcome.TIMED_OUT);
		expect(result.failed).toBe(true);
	});
});
