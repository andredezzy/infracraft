/**
 * API-authoritative Railway deploy monitor.
 *
 * `railway up` is used ONLY to upload + trigger (run it `--detach` so it never holds the
 * flaky build-log stream). This module then treats the Railway GraphQL API — not the CLI's
 * exit code — as the source of truth: it polls the deployment to a terminal status, fails on
 * FAILED/CRASHED/REMOVED, and on failure pulls the full build + deploy logs so the operator
 * sees exactly why it broke.
 *
 * Pure and dependency-injected (`fetch`/`sleep`/`log`) so every decision is unit-tested. The
 * runnable wrapper that wires real IO lives in `./bin/monitor-deployment.ts`.
 */

/** Tunable knobs, named here so the timing/limits are discoverable in one place. */
const DEFAULTS = {
	apiUrl: "https://backboard.railway.app/graphql/v2",
	/** Attempts × interval to resolve the deployment id before giving up. */
	resolveAttempts: 12,
	resolveIntervalMs: 5_000,
	/** Attempts × interval to poll a resolved deployment to a terminal status. */
	pollAttempts: 120,
	pollIntervalMs: 10_000,
	/** Per-request abort timeout so a hung connection can't stall the loop. */
	requestTimeoutMs: 15_000,
	/** Build + deploy log lines surfaced on failure. */
	failureLogLimit: 250,
	/** Clock-skew buffer so the createdAt filter never drops the just-created deployment. */
	skewMs: 120_000,
	/** Attempts × interval to apply the post-deploy healthcheck config (absorbs transient blips). */
	healthcheckApplyAttempts: 3,
	healthcheckApplyIntervalMs: 5_000,
} as const;

/** Railway GraphQL operations, named so each query is readable at its call site. */
const QUERIES = {
	resolveDeployments:
		"query($p:String!,$e:String!,$s:String!){deployments(first:10,input:{projectId:$p,environmentId:$e,serviceId:$s}){edges{node{id status createdAt}}}}",
	deploymentStatus: "query($d:String!){deployment(id:$d){status}}",
	buildLogs:
		"query($d:String!,$n:Int!){buildLogs(deploymentId:$d,limit:$n){message severity timestamp}}",
	deploymentLogs:
		"query($d:String!,$n:Int!){deploymentLogs(deploymentId:$d,limit:$n){message severity timestamp}}",
	updateHealthcheck:
		"mutation($s:String!,$e:String!,$i:ServiceInstanceUpdateInput!){serviceInstanceUpdate(serviceId:$s,environmentId:$e,input:$i)}",
} as const;

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** What a Railway deployment status means for the monitor's control flow. */
enum DeploymentDisposition {
	/** Live release — SUCCESS, or SLEEPING (deployed then scaled to zero). */
	LIVE = "LIVE",
	/** Terminal failure that must fail the Pulumi resource. */
	FAILED = "FAILED",
	/** Superseded by a newer deployment — non-blocking. */
	SUPERSEDED = "SUPERSEDED",
	/** Still in flight (BUILDING, DEPLOYING, …) — keep polling. */
	PENDING = "PENDING",
}

/** Status → disposition; index directly, defaulting unknown/in-flight statuses to PENDING. */
const DISPOSITION_BY_STATUS: Readonly<Record<string, DeploymentDisposition>> = {
	SUCCESS: DeploymentDisposition.LIVE,
	SLEEPING: DeploymentDisposition.LIVE,
	FAILED: DeploymentDisposition.FAILED,
	CRASHED: DeploymentDisposition.FAILED,
	REMOVED: DeploymentDisposition.FAILED,
	SKIPPED: DeploymentDisposition.SUPERSEDED,
};

/** The terminal classification of a monitor run. */
export enum MonitorOutcome {
	SUCCESS = "SUCCESS",
	SKIPPED = "SKIPPED",
	FAILED = "FAILED",
	TIMED_OUT = "TIMED_OUT",
	NO_DEPLOYMENT = "NO_DEPLOYMENT",
}

/** What the monitor observed and whether the Pulumi resource should fail. */
export interface MonitorResult {
	outcome: MonitorOutcome;
	/** True iff the deploy command should exit non-zero (fail the Pulumi resource). */
	failed: boolean;
	deploymentId?: string;
	status?: string;
}

/** Everything the monitor needs to identify and watch one deployment. */
export interface MonitorInput {
	/** Railway GraphQL endpoint (override in tests). */
	apiUrl?: string;
	/** Project-scoped access token (sent as the `Project-Access-Token` header). */
	projectToken: string;
	projectId: string;
	environmentId: string;
	serviceId: string;
	/** Deployment id captured from `railway up --detach --json` (preferred, exact). */
	deploymentId?: string;
	/** Raw `railway up` output, parsed for the id when `deploymentId` is absent. */
	uploadOutput?: string;
	/** `railway up` exit code: decides pass/fail only when no deployment can be resolved. */
	uploadExitCode: number;
	/** Epoch ms captured just before `railway up` (createdAt fallback for id resolution). */
	since: number;
	/**
	 * Healthcheck path applied via `serviceInstanceUpdate` once the deployment
	 * is live. Railway rejects healthcheck fields on a fresh instance with no
	 * deployment ("Invalid input"), so a code service's healthcheck can only
	 * land post-deploy — the monitor is the component that knows when that is.
	 */
	healthcheckPath?: string;
	/** Healthcheck timeout (seconds) applied alongside `healthcheckPath`. */
	healthcheckTimeout?: number;
	resolveAttempts?: number;
	resolveIntervalMs?: number;
	pollAttempts?: number;
	pollIntervalMs?: number;
	requestTimeoutMs?: number;
	failureLogLimit?: number;
}

/** Injected side-effecting collaborators (real impls in the bin, fakes in tests). */
export interface MonitorDeps {
	fetch: typeof fetch;
	sleep: (ms: number) => Promise<void>;
	log: (line: string) => void;
}

/** Result of {@link parseDeploymentId}: the id and how confidently it was extracted. */
export interface ParsedDeploymentId {
	id: string;
	/**
	 * True when `id` came from the last-resort bare-UUID scan — no structural
	 * signal (a JSON key, a `?id=` query param) ties it to a deployment id, so
	 * it could be any other UUID that happens to appear in the output (e.g. a
	 * project or environment id). Callers should sanity-check it via the API
	 * before committing to a long poll loop.
	 */
	isBareUuidFallback: boolean;
}

/**
 * Best-effort extraction of a deployment id from `railway up`'s output. Tries, in order:
 * the JSON trigger payload (whole or per-line), a `?id=<uuid>` Build-Logs URL, then any bare
 * UUID. Returns undefined so the caller can fall back to createdAt resolution.
 */
export function parseDeploymentId(
	output: string | undefined,
): ParsedDeploymentId | undefined {
	if (!output) {
		return undefined;
	}

	const fromObject = (value: unknown): string | undefined => {
		if (!value || typeof value !== "object") {
			return undefined;
		}

		const record = value as Record<string, unknown>;

		if (typeof record.deploymentId === "string") {
			return record.deploymentId;
		}

		if (typeof record.id === "string" && UUID.test(record.id)) {
			return record.id;
		}

		const nested = record.deployment as Record<string, unknown> | undefined;

		return nested && typeof nested.id === "string" ? nested.id : undefined;
	};

	const tryJson = (text: string): string | undefined => {
		try {
			return fromObject(JSON.parse(text));
		} catch {
			return undefined;
		}
	};

	const whole = tryJson(output);

	if (whole) {
		return { id: whole, isBareUuidFallback: false };
	}

	for (const line of output.split("\n")) {
		const fromLine = tryJson(line.trim());

		if (fromLine) {
			return { id: fromLine, isBareUuidFallback: false };
		}
	}

	const fromUrl = output.match(new RegExp(`[?&]id=(${UUID.source})`, "i"));

	if (fromUrl) {
		return { id: fromUrl[1], isBareUuidFallback: false };
	}

	const bare = output.match(UUID);

	return bare ? { id: bare[0], isBareUuidFallback: true } : undefined;
}

interface DeploymentNode {
	id: string;
	status: string;
	createdAt: string;
}

/** The healthcheck subset of `ServiceInstanceUpdateInput` the monitor applies post-deploy. */
interface HealthcheckFields {
	healthcheckPath?: string;
	healthcheckTimeout?: number;
}

interface LogLine {
	message: string;
	severity?: string;
}

/**
 * A fault-tolerant Railway GraphQL caller bound to one deployment context. Every method
 * swallows transient transport/timeout errors (returning undefined/empty) so the monitor's
 * loops own the retry cadence — the network blips that broke the old CLI path are absorbed here.
 */
function createRailwayApi(
	deps: MonitorDeps,
	config: {
		apiUrl: string;
		projectToken: string;
		projectId: string;
		environmentId: string;
		serviceId: string;
		requestTimeoutMs: number;
	},
) {
	const call = async <T>(
		query: string,
		variables: Record<string, unknown>,
	): Promise<T | undefined> => {
		try {
			const signal =
				config.requestTimeoutMs > 0 &&
				typeof AbortSignal?.timeout === "function"
					? AbortSignal.timeout(config.requestTimeoutMs)
					: undefined;

			const response = await deps.fetch(config.apiUrl, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Project-Access-Token": config.projectToken,
				},
				body: JSON.stringify({ query, variables }),
				signal,
			});

			if (!response.ok) {
				return undefined;
			}

			return ((await response.json()) as { data?: T }).data;
		} catch {
			return undefined;
		}
	};

	return {
		/** Newest deployment created at/after `since` (skew-buffered), or undefined. */
		async resolveLatestDeployment(since: number): Promise<string | undefined> {
			const data = await call<{
				deployments: { edges: { node: DeploymentNode }[] };
			}>(QUERIES.resolveDeployments, {
				p: config.projectId,
				e: config.environmentId,
				s: config.serviceId,
			});

			const [newest] = (data?.deployments?.edges ?? [])
				.map((edge) => edge.node)
				.filter(
					(node) => node?.createdAt && Date.parse(node.createdAt) >= since,
				)
				.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

			return newest?.id;
		},

		async deploymentStatus(id: string): Promise<string | undefined> {
			const data = await call<{ deployment: { status: string } | null }>(
				QUERIES.deploymentStatus,
				{ d: id },
			);

			return data?.deployment?.status;
		},

		/** Applies healthcheck fields via `serviceInstanceUpdate`; false on any failure. */
		async applyHealthcheck(fields: HealthcheckFields): Promise<boolean> {
			const data = await call<{ serviceInstanceUpdate: boolean }>(
				QUERIES.updateHealthcheck,
				{ s: config.serviceId, e: config.environmentId, i: fields },
			);

			return data?.serviceInstanceUpdate === true;
		},

		async failureLogs(
			id: string,
			limit: number,
		): Promise<{ build: string[]; deploy: string[] }> {
			const read = async (query: string, field: string): Promise<string[]> => {
				const data = await call<Record<string, LogLine[]>>(query, {
					d: id,
					n: limit,
				});

				return (data?.[field] ?? []).map((line) => line.message ?? "");
			};

			return {
				build: await read(QUERIES.buildLogs, "buildLogs"),
				deploy: await read(QUERIES.deploymentLogs, "deploymentLogs"),
			};
		},
	};
}

/**
 * Watches a Railway deployment to a terminal state. The Railway API is authoritative: the
 * CLI's exit code only matters when NO deployment was ever created.
 */
export async function monitorRailwayDeployment(
	input: MonitorInput,
	deps: MonitorDeps,
): Promise<MonitorResult> {
	const resolveAttempts = input.resolveAttempts ?? DEFAULTS.resolveAttempts;

	const resolveIntervalMs =
		input.resolveIntervalMs ?? DEFAULTS.resolveIntervalMs;

	const pollAttempts = input.pollAttempts ?? DEFAULTS.pollAttempts;
	const pollIntervalMs = input.pollIntervalMs ?? DEFAULTS.pollIntervalMs;
	const failureLogLimit = input.failureLogLimit ?? DEFAULTS.failureLogLimit;

	const api = createRailwayApi(deps, {
		apiUrl: input.apiUrl ?? DEFAULTS.apiUrl,
		projectToken: input.projectToken,
		projectId: input.projectId,
		environmentId: input.environmentId,
		serviceId: input.serviceId,
		requestTimeoutMs: input.requestTimeoutMs ?? DEFAULTS.requestTimeoutMs,
	});

	// Applies the healthcheck config once the deployment is live (see
	// MonitorInput.healthcheckPath). Retries absorb transient blips — the same
	// network flakiness the rest of the monitor tolerates — but a config that
	// still won't apply fails the deploy loudly: silently dropping it is how
	// the healthcheck got lost forever before this existed.
	const applyHealthcheckConfig = async (): Promise<boolean> => {
		const fields: HealthcheckFields = {};

		if (input.healthcheckPath !== undefined) {
			fields.healthcheckPath = input.healthcheckPath;
		}

		if (input.healthcheckTimeout !== undefined) {
			fields.healthcheckTimeout = input.healthcheckTimeout;
		}

		if (Object.keys(fields).length === 0) {
			return true;
		}

		for (
			let attempt = 0;
			attempt < DEFAULTS.healthcheckApplyAttempts;
			attempt++
		) {
			if (await api.applyHealthcheck(fields)) {
				deps.log(
					`[infracraft] applied healthcheck config ${JSON.stringify(fields)} to service ${input.serviceId}`,
				);

				return true;
			}

			await deps.sleep(DEFAULTS.healthcheckApplyIntervalMs);
		}

		deps.log(
			`[infracraft] FAILED to apply healthcheck config ${JSON.stringify(fields)} to service ${input.serviceId} — failing the deploy so the config is not silently dropped`,
		);

		return false;
	};

	const dumpFailureLogs = async (id: string): Promise<void> => {
		const logs = await api.failureLogs(id, failureLogLimit);

		for (const [label, lines] of [
			["build logs", logs.build],
			["deploy logs", logs.deploy],
		] as const) {
			deps.log(`[infracraft] ───── railway ${label} (deployment ${id}) ─────`);

			if (lines.length === 0) {
				deps.log("    (no log lines returned)");

				continue;
			}

			for (const line of lines) {
				deps.log(`    ${line}`);
			}
		}
	};

	// 1. Identify the deployment: prefer the captured id, then parse the upload output,
	//    then resolve the newest deployment created after this run started.
	let deploymentId: string | undefined;
	let isBareUuidFallback = false;

	if (input.deploymentId) {
		deploymentId = input.deploymentId;
	} else {
		const parsed = parseDeploymentId(input.uploadOutput);

		deploymentId = parsed?.id;
		isBareUuidFallback = parsed?.isBareUuidFallback ?? false;
	}

	if (!deploymentId) {
		const threshold = input.since - DEFAULTS.skewMs;

		for (
			let attempt = 0;
			attempt < resolveAttempts && !deploymentId;
			attempt++
		) {
			deploymentId = await api.resolveLatestDeployment(threshold);

			if (!deploymentId) {
				await deps.sleep(resolveIntervalMs);
			}
		}
	}

	if (!deploymentId) {
		const failed = input.uploadExitCode !== 0;

		deps.log(
			failed
				? "[infracraft] railway up failed and no deployment was created — failing the resource"
				: "[infracraft] no deployment resolved but railway up succeeded — not blocking the release",
		);

		return { outcome: MonitorOutcome.NO_DEPLOYMENT, failed };
	}

	deps.log(`[infracraft] monitoring railway deployment ${deploymentId}`);

	// 1b. A bare-UUID match has no structural signal tying it to a deployment id —
	// it could be a project/environment id that coincidentally appears in the
	// upload output. Probe it once before committing to the ~20-minute poll loop
	// below, so a wrong guess fails fast instead of polling a nonexistent
	// deployment all the way to a timeout.
	if (isBareUuidFallback && !(await api.deploymentStatus(deploymentId))) {
		deps.log(
			`[infracraft] railway deployment ${deploymentId} (parsed as a bare UUID from upload output) does not resolve via the API — failing fast instead of polling a nonexistent deployment`,
		);

		return {
			outcome: MonitorOutcome.NO_DEPLOYMENT,
			failed: true,
			deploymentId,
		};
	}

	// 2. Poll the API to a terminal status — this, not the CLI, decides pass/fail.
	let lastStatus: string | undefined;

	for (let attempt = 0; attempt < pollAttempts; attempt++) {
		const status = await api.deploymentStatus(deploymentId);

		if (status) {
			lastStatus = status;

			deps.log(
				`[infracraft] railway deployment ${deploymentId} status=${status}`,
			);

			const disposition =
				DISPOSITION_BY_STATUS[status] ?? DeploymentDisposition.PENDING;

			if (disposition === DeploymentDisposition.LIVE) {
				if (!(await applyHealthcheckConfig())) {
					return {
						outcome: MonitorOutcome.FAILED,
						failed: true,
						deploymentId,
						status,
					};
				}

				return {
					outcome: MonitorOutcome.SUCCESS,
					failed: false,
					deploymentId,
					status,
				};
			}

			if (disposition === DeploymentDisposition.SUPERSEDED) {
				deps.log(
					`[infracraft] railway deployment ${deploymentId} SKIPPED (superseded) — not blocking`,
				);

				return {
					outcome: MonitorOutcome.SKIPPED,
					failed: false,
					deploymentId,
					status,
				};
			}

			if (disposition === DeploymentDisposition.FAILED) {
				await dumpFailureLogs(deploymentId);

				return {
					outcome: MonitorOutcome.FAILED,
					failed: true,
					deploymentId,
					status,
				};
			}
		}

		await deps.sleep(pollIntervalMs);
	}

	deps.log(
		`[infracraft] timed out waiting for railway deployment ${deploymentId} (last status=${lastStatus ?? "unknown"})`,
	);

	await dumpFailureLogs(deploymentId);

	return {
		outcome: MonitorOutcome.TIMED_OUT,
		failed: true,
		deploymentId,
		status: lastStatus,
	};
}
