import { resilientFetch } from "../http/resilient-fetch";

const RAILWAY_API_URL = "https://backboard.railway.app/graphql/v2";

/** Standard GraphQL response envelope from Railway's API. */
interface GraphQLResponse<T> {
	/** The resolved data payload, present on success. */
	data?: T;

	/** Array of GraphQL-level errors, present on partial or full failure. */
	errors?: Array<{ message: string }>;
}

/**
 * Typed GraphQL client for Railway's API.
 *
 * Wraps the resilient transport with auth headers, JSON serialization, and
 * error extraction so callers only deal with typed response data.
 *
 * @example
 * ```typescript
 * const client = new RailwayClient(token);
 * const result = await client.query<{ project: { id: string } }>(
 *   `query { project(id: "abc") { id name } }`
 * );
 * ```
 */
export class RailwayClient {
	/** Railway API token sent as `Authorization: Bearer` (account/team-scoped). */
	private readonly token: string;

	/**
	 * @param token Railway **account- or team-scoped** API token. This client sends
	 *   `Authorization: Bearer <token>`, which Railway's GraphQL v2 API accepts for
	 *   account/team tokens. Railway **project** tokens are NOT accepted as Bearer here —
	 *   they require the `Project-Access-Token` header — so do not pass a project token.
	 */
	constructor(token: string) {
		this.token = token;
	}

	/**
	 * Executes a GraphQL query or mutation against Railway's API.
	 *
	 * @param query The GraphQL query or mutation string
	 * @param variables Optional variables for parameterized queries
	 * @returns The typed data payload from the response
	 * @throws {Error} On HTTP transport errors (non-2xx status)
	 * @throws {Error} On GraphQL-level errors (errors array in response)
	 * @throws {Error} When the response contains no data payload
	 */
	async query<T>(
		query: string,
		variables?: Record<string, unknown>,
	): Promise<T> {
		const response = await resilientFetch(RAILWAY_API_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${this.token}`,
			},
			body: JSON.stringify({ query, variables }),
		});

		if (!response.ok) {
			const body = await response.text();

			throw new Error(
				`Railway API HTTP error: ${response.status} ${response.statusText}\n${body}`,
			);
		}

		const json = (await response.json()) as GraphQLResponse<T>;

		if (json.errors && json.errors.length > 0) {
			throw new Error(`Railway API error: ${json.errors[0].message}`);
		}

		if (!json.data) {
			throw new Error("Railway API returned no data");
		}

		return json.data;
	}
}
