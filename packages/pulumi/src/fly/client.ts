import { ApiNotFoundError } from "../errors/api-not-found-error";
import { resilientFetch } from "../http/resilient-fetch";

const FLY_MACHINES_API_URL = "https://api.machines.dev";
const FLY_GRAPHQL_API_URL = "https://api.fly.io/graphql";

/** Shape of a Fly GraphQL response envelope. */
interface GraphQLResponse<T> {
	data?: T;
	errors?: Array<{ message: string }>;
}

/**
 * Typed client for the Fly.io Machines REST API and the Fly GraphQL API.
 *
 * REST calls target `https://api.machines.dev`; `graphql()` targets
 * `https://api.fly.io/graphql`. Both authenticate with the same bearer token.
 *
 * @example
 * ```typescript
 * const client = new fly.Client(token);
 * const app = await client.tryGet<{ name: string }>("/v1/apps/my-app");
 * ```
 */
export class Client {
	/** Fly API token used for both REST and GraphQL auth. */
	private readonly token: string;

	/**
	 * @param token Fly API token (e.g. from `fly tokens create deploy`)
	 */
	constructor(token: string) {
		this.token = token;
	}

	/**
	 * GET a Machines API resource.
	 * @throws {ApiNotFoundError} On 404.
	 * @throws {Error} On any other non-2xx status.
	 */
	async get<T>(path: string): Promise<T> {
		return this.request<T>("GET", path);
	}

	/**
	 * GET a Machines API resource, returning `null` on 404.
	 * Used by adopt-or-create resources to detect existence.
	 * @throws {Error} On non-2xx statuses other than 404.
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

	/** POST to a Machines API resource. */
	async post<T>(path: string, body?: unknown): Promise<T> {
		return this.request<T>("POST", path, body);
	}

	/** PUT to a Machines API resource. */
	async put<T>(path: string, body?: unknown): Promise<T> {
		return this.request<T>("PUT", path, body);
	}

	/**
	 * DELETE a Machines API resource. Returns the parsed body when present
	 * (some Fly deletes return the deleted object), or `undefined` for
	 * empty 202/204 responses.
	 */
	async delete<T = void>(path: string): Promise<T> {
		return this.request<T>("DELETE", path);
	}

	/**
	 * Execute a Fly GraphQL query/mutation.
	 * @throws {Error} On transport errors or a non-empty `errors` array.
	 */
	async graphql<T>(
		query: string,
		variables: Record<string, unknown> = {},
	): Promise<T> {
		const response = await resilientFetch(FLY_GRAPHQL_API_URL, {
			method: "POST",
			headers: this.headers(),
			body: JSON.stringify({ query, variables }),
		});

		if (!response.ok) {
			throw new Error(
				`Fly GraphQL error (${response.status}): ${await response.text()}`,
			);
		}

		const text = await response.text();
		const json = (text ? JSON.parse(text) : {}) as GraphQLResponse<T>;

		if (json.errors && json.errors.length > 0) {
			throw new Error(
				`Fly GraphQL error: ${json.errors.map((error) => error.message).join("; ")}`,
			);
		}

		return json.data as T;
	}

	private headers(): Record<string, string> {
		return {
			"Content-Type": "application/json",
			Authorization: `Bearer ${this.token}`,
		};
	}

	private async request<T>(
		method: string,
		path: string,
		body?: unknown,
	): Promise<T> {
		const response = await resilientFetch(`${FLY_MACHINES_API_URL}${path}`, {
			method,
			headers: this.headers(),
			body: body ? JSON.stringify(body) : undefined,
		});

		if (response.status === 404) {
			throw new ApiNotFoundError("fly", path);
		}

		if (!response.ok) {
			throw new Error(
				`Fly API error (${response.status}): ${await response.text()}`,
			);
		}

		const text = await response.text();

		return (text ? JSON.parse(text) : undefined) as T;
	}
}
