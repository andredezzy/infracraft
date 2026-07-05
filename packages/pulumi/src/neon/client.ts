import * as pulumi from "@pulumi/pulumi";
import { ApiNotFoundError } from "../errors/api-not-found-error";
import { resilientFetch } from "../http/resilient-fetch";

const NEON_API_URL = "https://console.neon.tech/api/v2";

/**
 * Neon runs project mutations as ASYNC operations and answers 423 ("project
 * already has running conflicting operations, scheduling of new ones is
 * prohibited") while earlier ones settle — its docs prescribe waiting for
 * completion before the next request. A destroy immediately followed by an
 * `up` on the same project hits this deterministically (live: branch/endpoint
 * deletion still settling 30s later). Waiting until the lock clears is the
 * documented protocol, bounded so a genuinely wedged project still fails.
 */
const OPERATION_LOCK_WAIT = {
	/** Delay between lock probes. */
	intervalMs: 5_000,
	/** Upper bound on probes (~2 minutes total). */
	maxAttempts: 24,
} as const;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * REST client for the Neon API.
 *
 * @example
 * ```typescript
 * const client = new NeonClient(apiKey);
 * const branch = await client.get<{ branch: { id: string } }>(
 *   `/projects/abc/branches/br-xyz`
 * );
 * ```
 */
export class NeonClient {
	/** Neon API key for authentication. */
	private readonly apiKey: string;

	/**
	 * @param apiKey Neon API key (project-scoped or account-scoped)
	 */
	constructor(apiKey: string) {
		this.apiKey = apiKey;
	}

	/**
	 * Performs a GET request against the Neon API.
	 *
	 * @param path API path (e.g. `/projects/abc/branches`)
	 * @returns Typed JSON response body
	 * @throws {ApiNotFoundError} On 404
	 * @throws {Error} On any other non-2xx HTTP status
	 */
	async get<T>(path: string): Promise<T> {
		return this.request<T>("GET", path);
	}

	/**
	 * Performs a POST request against the Neon API.
	 *
	 * @param path API path
	 * @param body Request body (will be JSON-serialized)
	 * @returns Typed JSON response body
	 * @throws {ApiNotFoundError} On 404
	 * @throws {Error} On any other non-2xx HTTP status
	 */
	async post<T>(path: string, body?: unknown): Promise<T> {
		return this.request<T>("POST", path, body);
	}

	/**
	 * Performs a PATCH request against the Neon API.
	 *
	 * @param path API path
	 * @param body Request body (will be JSON-serialized)
	 * @returns Typed JSON response body
	 * @throws {ApiNotFoundError} On 404
	 * @throws {Error} On any other non-2xx HTTP status
	 */
	async patch<T>(path: string, body?: unknown): Promise<T> {
		return this.request<T>("PATCH", path, body);
	}

	/**
	 * Performs a DELETE request against the Neon API.
	 *
	 * @param path API path
	 * @throws {ApiNotFoundError} On 404
	 * @throws {Error} On any other non-2xx HTTP status
	 */
	async delete(path: string): Promise<void> {
		await this.request<void>("DELETE", path);
	}

	private async request<T>(
		method: string,
		path: string,
		body?: unknown,
	): Promise<T> {
		let response: Response;

		for (let attempt = 1; ; attempt++) {
			response = await resilientFetch(`${NEON_API_URL}${path}`, {
				method,
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${this.apiKey}`,
				},
				body: body ? JSON.stringify(body) : undefined,
			});

			if (
				response.status !== 423 ||
				attempt >= OPERATION_LOCK_WAIT.maxAttempts
			) {
				break;
			}

			pulumi.log.info(
				`[infracraft] Neon project operations still settling (423) — waiting ${OPERATION_LOCK_WAIT.intervalMs / 1000}s (attempt ${attempt}/${OPERATION_LOCK_WAIT.maxAttempts})`,
			);

			await sleep(OPERATION_LOCK_WAIT.intervalMs);
		}

		if (response.status === 404) {
			throw new ApiNotFoundError("neon", path);
		}

		if (!response.ok) {
			const errorText = await response.text();

			throw new Error(`Neon API error (${response.status}): ${errorText}`);
		}

		if (method === "DELETE") {
			return undefined as T;
		}

		return (await response.json()) as T;
	}
}
