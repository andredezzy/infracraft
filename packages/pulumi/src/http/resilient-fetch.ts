/** Options for {@link resilientFetch}. */
export interface ResilientFetchOptions {
	/** Per-attempt timeout in milliseconds. Defaults to 15000. */
	timeoutMs?: number;

	/** Total attempts (first request + retries). Defaults to 3. */
	maxAttempts?: number;
}

/** Tunable transport knobs, named here so the timing/limits are discoverable in one place. */
const DEFAULTS = {
	/** Per-attempt abort timeout so a hung connection can't stall a run. */
	timeoutMs: 15_000,
	/** Total attempts (first request + retries). */
	maxAttempts: 3,
	/** First backoff wait; doubles on every retry (1s → 2s → 4s → …). */
	backoffBaseMs: 1_000,
	/** Ceiling for the exponential backoff wait. */
	backoffCapMs: 20_000,
	/** Ceiling for a server-provided Retry-After wait. */
	retryAfterCapMs: 30_000,
} as const;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Reads a numeric `Retry-After` header (seconds) off a 429 response and returns
 * the capped wait in milliseconds, or `undefined` when the header is missing or
 * not numeric (HTTP-date values fall back to exponential backoff).
 */
function retryAfterWaitMs(response: Response): number | undefined {
	const header = response.headers.get("retry-after");

	if (header === null || header.trim() === "") {
		return undefined;
	}

	const seconds = Number(header);

	if (!Number.isFinite(seconds) || seconds < 0) {
		return undefined;
	}

	return Math.min(seconds * 1_000, DEFAULTS.retryAfterCapMs);
}

/**
 * `fetch` with a per-attempt timeout and bounded retries — the single resilient
 * transport every provider client routes through.
 *
 * Retries only what is plausibly transient: network errors (fetch rejections,
 * including per-attempt timeouts), HTTP 5xx, and HTTP 429 — honoring a numeric
 * `Retry-After` header on 429 (capped at 30s), otherwise backing off
 * exponentially 1s/2s/4s… capped at 20s. Every other response — 2xx, 3xx, and
 * non-429 4xx — is returned as-is, and so is the final 5xx/429 once attempts
 * are exhausted: the caller owns envelope semantics and error messages. Only an
 * exhausted run of rejections throws (the last rejection).
 *
 * @param url Request URL
 * @param init Request init; its `signal` is replaced by the per-attempt timeout signal
 * @param options Timeout/attempt overrides
 * @returns The last HTTP response received
 * @throws The last fetch rejection when every attempt failed at the network level
 */
export async function resilientFetch(
	url: string,
	init: RequestInit,
	options?: ResilientFetchOptions,
): Promise<Response> {
	const timeoutMs = options?.timeoutMs ?? DEFAULTS.timeoutMs;
	const maxAttempts = Math.max(1, options?.maxAttempts ?? DEFAULTS.maxAttempts);

	for (let attempt = 1; ; attempt++) {
		const backoffMs = Math.min(
			DEFAULTS.backoffBaseMs * 2 ** (attempt - 1),
			DEFAULTS.backoffCapMs,
		);

		try {
			const response = await fetch(url, {
				...init,
				signal: AbortSignal.timeout(timeoutMs),
			});

			const retryable = response.status >= 500 || response.status === 429;

			if (!retryable || attempt === maxAttempts) {
				return response;
			}

			await sleep(
				response.status === 429
					? (retryAfterWaitMs(response) ?? backoffMs)
					: backoffMs,
			);
		} catch (error) {
			if (attempt === maxAttempts) {
				throw error;
			}

			await sleep(backoffMs);
		}
	}
}
