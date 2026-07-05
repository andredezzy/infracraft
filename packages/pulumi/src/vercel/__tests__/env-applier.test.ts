import { afterEach, describe, expect, it, vi } from "vitest";

import { applyVercelEnv } from "../env-applier";

/** A recorded HTTP call the fetch double received. */
interface RecordedCall {
	method: string;
	url: string;
	body?: unknown;
}

/**
 * A fetch double that routes Vercel REST calls by method + path and records
 * every call. Non-retryable statuses (2xx/4xx) keep the resilient transport
 * from sleeping, so tests stay instant.
 */
function makeFetch(routes: {
	/** Scripted POST /env results (one per call; last one repeats). */
	post?: Array<{ status: number; body: unknown }>;
	/** GET /env list payload (the ENV_CONFLICT lookup). */
	list?: { envs: Array<{ id: string; key: string }> };
	/** GET /env/:id?decrypt=true payloads by env ID. */
	decrypted?: Record<string, { id: string; key: string; value: string }>;
}) {
	const calls: RecordedCall[] = [];
	let postCursor = 0;

	const respond = (status: number, body: unknown) =>
		({
			ok: status >= 200 && status < 300,
			status,
			headers: new Headers(),
			json: async () => body,
			text: async () => JSON.stringify(body),
		}) as Response;

	const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
		const method = init.method ?? "GET";

		calls.push({
			method,
			url,
			body: init.body ? JSON.parse(String(init.body)) : undefined,
		});

		if (method === "POST") {
			const seq = routes.post ?? [];
			const scripted = seq[Math.min(postCursor, seq.length - 1)];

			postCursor++;

			return respond(scripted.status, scripted.body);
		}

		if (method === "PATCH") {
			return respond(200, {});
		}

		if (url.includes("decrypt=true")) {
			const envId = url.match(/\/env\/([^?]+)/)?.[1] ?? "";

			return respond(200, routes.decrypted?.[envId] ?? null);
		}

		return respond(200, routes.list ?? { envs: [] });
	});

	vi.stubGlobal("fetch", fetchMock);

	return { calls };
}

function makeLog() {
	const lines: string[] = [];

	return { log: (line: string) => lines.push(line), lines };
}

const input = {
	token: "tok",
	teamId: "team_1",
	projectId: "prj_1",
	variables: { API_URL: "https://api.internal", NODE_ENV: "production" },
};

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("applyVercelEnv", () => {
	it("creates each variable (encrypted, all targets) and logs one line per key", async () => {
		const { calls } = makeFetch({
			post: [{ status: 200, body: { id: "env_a", key: "API_URL" } }],
		});

		const { log, lines } = makeLog();

		await applyVercelEnv(input, { log });

		const posts = calls.filter((call) => call.method === "POST");

		expect(posts).toHaveLength(2);
		expect(posts[0].url).toContain("/v10/projects/prj_1/env");
		expect(posts[0].url).toContain("teamId=team_1");

		expect(posts[0].body).toEqual({
			key: "API_URL",
			value: "https://api.internal",
			type: "encrypted",
			target: ["production", "preview", "development"],
		});

		expect(lines).toEqual([
			'applied Vercel env var "API_URL"',
			'applied Vercel env var "NODE_ENV"',
		]);
	});

	it("updates in place when a key already exists (ENV_CONFLICT)", async () => {
		const { calls } = makeFetch({
			post: [
				{ status: 400, body: { error: { code: "ENV_CONFLICT" } } },
				{ status: 200, body: { id: "env_b", key: "NODE_ENV" } },
			],
			list: { envs: [{ id: "env_x", key: "API_URL" }] },
			decrypted: {
				env_x: { id: "env_x", key: "API_URL", value: "stale" },
			},
		});

		const { log, lines } = makeLog();

		await applyVercelEnv(input, { log });

		const patches = calls.filter((call) => call.method === "PATCH");

		expect(patches).toHaveLength(1);
		expect(patches[0].url).toContain("/v9/projects/prj_1/env/env_x");
		expect(patches[0].body).toEqual({ value: "https://api.internal" });

		expect(lines).toContain(
			'Vercel env var "API_URL" already exists, will update instead',
		);

		expect(lines).toContain('applied Vercel env var "API_URL"');
	});

	it("fails loudly on the first failed key and stops applying", async () => {
		const { calls } = makeFetch({
			post: [{ status: 400, body: { error: { code: "BAD_REQUEST" } } }],
		});

		await expect(applyVercelEnv(input, makeLog())).rejects.toThrow(
			/failed to apply Vercel env var "API_URL"/,
		);

		// The second key is never attempted — the deploy must not proceed
		// against a half-applied environment.
		expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
	});

	it("logs variable names, never values", async () => {
		makeFetch({
			post: [{ status: 200, body: { id: "env_a", key: "API_URL" } }],
		});

		const { log, lines } = makeLog();

		await applyVercelEnv(
			{ ...input, variables: { SECRET_KEY: "super-secret-value" } },
			{ log },
		);

		expect(lines.some((line) => line.includes("SECRET_KEY"))).toBe(true);

		expect(lines.every((line) => !line.includes("super-secret-value"))).toBe(
			true,
		);
	});
});
