/**
 * Thrown when a provider API responds 404 for a resource path.
 *
 * Clients throw this instead of a generic error so callers can distinguish
 * "gone" from "failed" via `instanceof`: adopt-or-create lookups turn it into
 * `null`, and `read()` implementations turn it into a blank `ReadResult` so
 * `pulumi refresh` reconciles out-of-band deletions.
 */
export class ApiNotFoundError extends Error {
	/** Provider whose API returned the 404 (e.g. `"neon"`, `"vercel"`, `"fly"`). */
	readonly provider: string;

	/** API path (or URL) that was not found. */
	readonly path: string;

	/**
	 * @param provider Provider whose API returned the 404
	 * @param path API path (or URL) that was not found
	 */
	constructor(provider: string, path: string) {
		super(`${provider} API returned 404 for ${path}`);

		this.name = "ApiNotFoundError";
		this.provider = provider;
		this.path = path;
	}
}
