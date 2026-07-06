import { ApiNotFoundError } from "../errors/api-not-found-error";
import { resilientFetch } from "../http/resilient-fetch";

const VERCEL_API_URL = "https://api.vercel.com";

/**
 * REST client for the Vercel API.
 *
 * When constructed with a `teamId`, every request is scoped to that team by
 * appending the `teamId` query parameter.
 *
 * @example
 * ```typescript
 * const client = new VercelClient(token, teamId);
 * const project = await client.tryGet<{ id: string }>("/v9/projects/my-app");
 * ```
 */
export class VercelClient {
	/** Vercel API bearer token. */
	private readonly token: string;

	/** Vercel team/org ID appended to every request when set. */
	private readonly teamId?: string;

	/**
	 * @param token Vercel API bearer token
	 * @param teamId Vercel team/org ID to scope every request to
	 */
	constructor(token: string, teamId?: string) {
		this.token = token;
		this.teamId = teamId;
	}

	/**
	 * Performs a GET request against the Vercel API.
	 *
	 * @param path API path (e.g. `/v9/projects/my-app`)
	 * @returns Typed JSON response body
	 * @throws {ApiNotFoundError} On 404
	 * @throws {Error} On any other non-2xx HTTP status
	 */
	async get<T>(path: string): Promise<T> {
		return this.request<T>("GET", path);
	}

	/**
	 * Performs a GET request, returning `null` when the resource does not
	 * exist (404). Used by adopt-or-create resources to detect existence.
	 *
	 * @param path API path
	 * @returns Typed JSON response body, or `null` on 404
	 * @throws {Error} On non-2xx HTTP statuses other than 404
	 */
	async tryGet<T>(path: string): Promise<T | null> {
		try {
			return await this.request<T>("GET", path);
		} catch (error) {
			if (error instanceof ApiNotFoundError) {
				return null;
			}

			throw error;
		}
	}

	/**
	 * Performs a POST request against the Vercel API.
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

	private url(path: string): string {
		if (!this.teamId) {
			return `${VERCEL_API_URL}${path}`;
		}

		const separator = path.includes("?") ? "&" : "?";

		return `${VERCEL_API_URL}${path}${separator}teamId=${encodeURIComponent(this.teamId)}`;
	}

	private async request<T>(
		method: string,
		path: string,
		body?: unknown,
	): Promise<T> {
		const response = await resilientFetch(this.url(path), {
			method,
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${this.token}`,
			},
			body: body ? JSON.stringify(body) : undefined,
		});

		if (response.status === 404) {
			throw new ApiNotFoundError("vercel", path);
		}

		if (!response.ok) {
			const errorText = await response.text();

			throw new Error(`Vercel API error (${response.status}): ${errorText}`);
		}

		return (await response.json()) as T;
	}
}
