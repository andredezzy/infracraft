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
	/** Scripted `serviceInstanceUpdate` results (one per call; last one repeats). */
	serviceInstanceUpdate?: Array<boolean | null>;
	/** Scripted `deploymentRedeploy` results (one per call; last one repeats). */
	deploymentRedeploy?: Array<{ id: string } | null>;
	/** Calls that should reject before resolving (transient network errors). */
	rejectFirst?: number;
}) {
	const cursors = {
		deployment: 0,
		deployments: 0,
		serviceInstanceUpdate: 0,
		deploymentRedeploy: 0,
	};

	let rejectsLeft = routes.rejectFirst ?? 0;

	const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
		if (rejectsLeft > 0) {
			rejectsLeft--;

			throw new Error("network down");
		}

		const body = String(init.body);

		const data = (() => {
			if (body.includes("serviceInstanceUpdate")) {
				const seq = routes.serviceInstanceUpdate ?? [];

				const result =
					seq[Math.min(cursors.serviceInstanceUpdate, seq.length - 1)];

				cursors.serviceInstanceUpdate++;

				return { serviceInstanceUpdate: result };
			}

			if (body.includes("deploymentRedeploy")) {
				const seq = routes.deploymentRedeploy ?? [];
				const node = seq[Math.min(cursors.deploymentRedeploy, seq.length - 1)];
				cursors.deploymentRedeploy++;

				return { deploymentRedeploy: node ?? null };
			}

			if (body.includes("deploymentCancel")) {
				return { deploymentCancel: true };
			}

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
		expect(parseDeploymentId('{"deploymentId":"abc-123"}')).toEqual({
			id: "abc-123",
			isBareUuidFallback: false,
		});
	});

	it("reads a nested deployment.id", () => {
		expect(parseDeploymentId('{"deployment":{"id":"nested-9"}}')).toEqual({
			id: "nested-9",
			isBareUuidFallback: false,
		});
	});

	it("extracts the id from a Build Logs URL query param", () => {
		const out =
			"Build Logs: https://railway.com/project/p/service/s?id=11111111-2222-3333-4444-555555555555&";

		expect(parseDeploymentId(out)).toEqual({
			id: "11111111-2222-3333-4444-555555555555",
			isBareUuidFallback: false,
		});
	});

	it("flags a bare UUID scan match as a fallback, unlike the other extraction paths", () => {
		const out =
			"Some unrelated log line mentioning 11111111-2222-3333-4444-555555555555 in passing";

		expect(parseDeploymentId(out)).toEqual({
			id: "11111111-2222-3333-4444-555555555555",
			isBareUuidFallback: true,
		});
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

	it("fails fast (without polling) when a bare-UUID fallback id does not resolve via the API", async () => {
		const fetchMock = makeFetch({ deployment: [null] });
		const { deps } = makeDeps(fetchMock);

		const result = await monitorRailwayDeployment(
			{
				...baseInput,
				deploymentId: undefined,
				uploadOutput:
					"Some unrelated log line mentioning 11111111-2222-3333-4444-555555555555 in passing",
				pollAttempts: 5,
			},
			deps,
		);

		expect(result.outcome).toBe(MonitorOutcome.NO_DEPLOYMENT);
		expect(result.failed).toBe(true);

		const deploymentStatusCalls = (
			fetchMock as unknown as {
				mock: { calls: Array<[string, { body: string }]> };
			}
		).mock.calls.filter(([, init]) =>
			String(init.body).includes("deployment("),
		);

		// Probe only — never entered the ~20-minute poll loop for a guessed id.
		expect(deploymentStatusCalls).toHaveLength(1);
	});

	it("probes a bare-UUID fallback id once, then proceeds to poll normally when it resolves", async () => {
		const fetchMock = makeFetch({
			deployment: [{ status: "BUILDING" }, { status: "SUCCESS" }],
		});

		const { deps } = makeDeps(fetchMock);

		const result = await monitorRailwayDeployment(
			{
				...baseInput,
				deploymentId: undefined,
				uploadOutput:
					"Some unrelated log line mentioning 11111111-2222-3333-4444-555555555555 in passing",
			},
			deps,
		);

		expect(result.outcome).toBe(MonitorOutcome.SUCCESS);
		expect(result.failed).toBe(false);
	});

	it("does NOT add an extra probe call when the deployment id was captured directly (not a bare-UUID fallback)", async () => {
		const fetchMock = makeFetch({ deployment: [{ status: "SUCCESS" }] });
		const { deps } = makeDeps(fetchMock);

		await monitorRailwayDeployment(baseInput, deps);

		const deploymentStatusCalls = (
			fetchMock as unknown as {
				mock: { calls: Array<[string, { body: string }]> };
			}
		).mock.calls.filter(([, init]) =>
			String(init.body).includes("deployment("),
		);

		expect(deploymentStatusCalls).toHaveLength(1);
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

	it("applies the healthcheck config via serviceInstanceUpdate once the deployment is live", async () => {
		const fetchMock = makeFetch({
			deployment: [{ status: "SUCCESS" }],
			serviceInstanceUpdate: [true],
		});

		const { deps, lines } = makeDeps(fetchMock);

		const result = await monitorRailwayDeployment(
			{
				...baseInput,
				healthcheckPath: "/health-check",
				healthcheckTimeout: 300,
			},
			deps,
		);

		expect(result.outcome).toBe(MonitorOutcome.SUCCESS);
		expect(result.failed).toBe(false);

		const updateCall = (
			fetchMock as unknown as {
				mock: { calls: Array<[string, { body: string }]> };
			}
		).mock.calls.find(([, init]) =>
			String(init.body).includes("serviceInstanceUpdate"),
		);

		expect(updateCall).toBeDefined();

		const { variables } = JSON.parse(String(updateCall?.[1].body));

		expect(variables).toEqual({
			s: "svc",
			e: "env",
			i: { healthcheckPath: "/health-check", healthcheckTimeout: 300 },
		});

		expect(lines.join("\n")).toContain("applied healthcheck config");
	});

	it("skips the healthcheck apply cleanly when no healthcheck bindings are present", async () => {
		const fetchMock = makeFetch({ deployment: [{ status: "SUCCESS" }] });
		const { deps } = makeDeps(fetchMock);

		const result = await monitorRailwayDeployment(baseInput, deps);

		expect(result.outcome).toBe(MonitorOutcome.SUCCESS);

		const updateCall = (
			fetchMock as unknown as {
				mock: { calls: Array<[string, { body: string }]> };
			}
		).mock.calls.find(([, init]) =>
			String(init.body).includes("serviceInstanceUpdate"),
		);

		expect(updateCall).toBeUndefined();
	});

	it("FAILS the deploy loudly when the healthcheck apply keeps erroring", async () => {
		// null models a rejected update (GraphQL error → no data); the monitor
		// retries to absorb transient blips, then fails rather than silently
		// dropping the healthcheck config.
		const fetchMock = makeFetch({
			deployment: [{ status: "SUCCESS" }],
			serviceInstanceUpdate: [null],
		});

		const { deps, lines } = makeDeps(fetchMock);

		const result = await monitorRailwayDeployment(
			{ ...baseInput, healthcheckPath: "/health-check" },
			deps,
		);

		expect(result.outcome).toBe(MonitorOutcome.FAILED);
		expect(result.failed).toBe(true);

		const updateCalls = (
			fetchMock as unknown as {
				mock: { calls: Array<[string, { body: string }]> };
			}
		).mock.calls.filter(([, init]) =>
			String(init.body).includes("serviceInstanceUpdate"),
		);

		expect(updateCalls).toHaveLength(3); // retried before giving up

		expect(lines.join("\n")).toContain("FAILED to apply healthcheck config");
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

describe("monitorRailwayDeployment — stuck-INITIALIZING recovery", () => {
	// pollIntervalMs feeds the streak accumulator; 3 INITIALIZING polls (10×3)
	// reach the 30ms stuck threshold and trigger a redeploy.
	const stuckInput = {
		...baseInput,
		pollIntervalMs: 10,
		stuckInitializingMs: 30,
	};

	const bodiesOf = (fetchMock: typeof fetch): string[] =>
		(fetchMock as unknown as { mock: { calls: unknown[][] } }).mock.calls.map(
			(call) => String((call[1] as { body: string }).body),
		);

	it("redeploys a deployment wedged in INITIALIZING, cancels that one, and watches the fresh one", async () => {
		const fetchMock = makeFetch({
			deployment: [
				{ status: "INITIALIZING" },
				{ status: "INITIALIZING" },
				{ status: "INITIALIZING" },
				{ status: "SUCCESS" },
			],
			deploymentRedeploy: [{ id: "dep-2" }],
		});

		const { deps, lines } = makeDeps(fetchMock);

		const result = await monitorRailwayDeployment(
			{ ...stuckInput, maxRedeploys: 1 },
			deps,
		);

		expect(result.outcome).toBe(MonitorOutcome.SUCCESS);
		expect(result.deploymentId).toBe("dep-2");

		expect(lines.some((line) => line.includes("stuck in INITIALIZING"))).toBe(
			true,
		);

		expect(
			lines.some((line) => line.includes("redeployed dep-1 → dep-2")),
		).toBe(true);

		// The cancel targets the WEDGED deployment (dep-1), not the fresh one.
		expect(
			bodiesOf(fetchMock).some(
				(body) => body.includes("deploymentCancel") && body.includes("dep-1"),
			),
		).toBe(true);
	});

	it("resets the streak when INITIALIZING is interrupted by BUILDING (no redeploy)", async () => {
		const fetchMock = makeFetch({
			deployment: [
				{ status: "INITIALIZING" },
				{ status: "INITIALIZING" },
				{ status: "BUILDING" },
				{ status: "INITIALIZING" },
				{ status: "INITIALIZING" },
				{ status: "SUCCESS" },
			],
			deploymentRedeploy: [{ id: "dep-2" }],
		});

		const { deps, lines } = makeDeps(fetchMock);

		const result = await monitorRailwayDeployment(
			{ ...stuckInput, maxRedeploys: 1 },
			deps,
		);

		expect(result.outcome).toBe(MonitorOutcome.SUCCESS);
		expect(result.deploymentId).toBe("dep-1");

		expect(lines.some((line) => line.includes("stuck in INITIALIZING"))).toBe(
			false,
		);

		expect(
			bodiesOf(fetchMock).some((body) => body.includes("deploymentRedeploy")),
		).toBe(false);
	});

	it("does not cancel or switch when the redeploy call fails", async () => {
		const fetchMock = makeFetch({
			deployment: [
				{ status: "INITIALIZING" },
				{ status: "INITIALIZING" },
				{ status: "INITIALIZING" },
				{ status: "SUCCESS" },
			],
			deploymentRedeploy: [null],
		});

		const { deps, lines } = makeDeps(fetchMock);

		const result = await monitorRailwayDeployment(
			{ ...stuckInput, maxRedeploys: 1 },
			deps,
		);

		expect(result.outcome).toBe(MonitorOutcome.SUCCESS);
		expect(result.deploymentId).toBe("dep-1");

		expect(
			lines.some((line) => line.includes("redeploy of stuck deployment")),
		).toBe(true);

		// A failed redeploy must not cancel the deployment it couldn't replace.
		expect(
			bodiesOf(fetchMock).some((body) => body.includes("deploymentCancel")),
		).toBe(false);
	});

	it("does not spend the budget on a transient redeploy failure — it retries the next window", async () => {
		const { deps, lines } = makeDeps(
			makeFetch({
				deployment: [
					{ status: "INITIALIZING" },
					{ status: "INITIALIZING" },
					{ status: "INITIALIZING" },
					{ status: "INITIALIZING" },
					{ status: "INITIALIZING" },
					{ status: "INITIALIZING" },
					{ status: "SUCCESS" },
				],
				// First redeploy call fails (transient); the second succeeds.
				deploymentRedeploy: [null, { id: "dep-2" }],
			}),
		);

		const result = await monitorRailwayDeployment(
			{ ...stuckInput, maxRedeploys: 1 },
			deps,
		);

		// maxRedeploys is 1, yet the transient failure did NOT burn it: the second
		// stuck window still recovers onto dep-2.
		expect(result.outcome).toBe(MonitorOutcome.SUCCESS);
		expect(result.deploymentId).toBe("dep-2");

		expect(
			lines.filter((line) => line.includes("stuck in INITIALIZING")),
		).toHaveLength(2);

		expect(lines.some((line) => line.includes("will retry"))).toBe(true);
	});

	it("redeploys at most maxRedeploys times, then times out", async () => {
		const { deps, lines } = makeDeps(
			makeFetch({
				deployment: [{ status: "INITIALIZING" }],
				deploymentRedeploy: [{ id: "dep-2" }],
			}),
		);

		const result = await monitorRailwayDeployment(
			{ ...stuckInput, maxRedeploys: 1, pollAttempts: 8 },
			deps,
		);

		expect(result.outcome).toBe(MonitorOutcome.TIMED_OUT);

		expect(
			lines.filter((line) => line.includes("stuck in INITIALIZING")),
		).toHaveLength(1);
	});
});
