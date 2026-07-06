/**
 * Detects a GraphQL API's "not found" error message.
 *
 * A GraphQL mutation/query reports a missing resource as an error message on
 * an otherwise-200 response, not an HTTP 404 — so there is no status code to
 * branch on the way `ApiNotFoundError` does for REST. This is the
 * GraphQL-transport equivalent, used to distinguish an already-deleted
 * resource (tolerable during an idempotent `delete()`) from a real failure
 * (which must propagate).
 */
export function isGraphqlNotFoundError(error: unknown): boolean {
	return (
		error instanceof Error && /not found|could not find/i.test(error.message)
	);
}
