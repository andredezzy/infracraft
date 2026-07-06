import { resilientFetch } from "../http/resilient-fetch";

/** Cloudflare's token self-verification endpoint. */
const VERIFY_URL = "https://api.cloudflare.com/client/v4/user/tokens/verify";

/** Where to mint or rotate an API token. */
const TOKEN_DASHBOARD_URL = "https://dash.cloudflare.com/profile/api-tokens";

/** Token condition as reported by the verify endpoint (wire casing). */
type CloudflareTokenStatus = "active" | "disabled" | "expired";

/** A Cloudflare API error/message entry (`errors[]` / `messages[]`). */
interface CloudflareMessage {
	code: number;
	message: string;
}

/** Shape of the verify endpoint's response envelope. */
interface CloudflareVerifyResponse {
	success: boolean;
	errors: CloudflareMessage[];
	messages: CloudflareMessage[];
	result?: {
		id: string;
		status: CloudflareTokenStatus;
	};
}

/** Options for {@link assertCloudflareTokenScopes}. */
export interface CloudflareTokenScopesOptions {
	/**
	 * The Cloudflare API token to verify — its secret VALUE, not the name of the
	 * env var holding it. Resolve the env var before calling.
	 */
	token: string;

	/**
	 * Permission groups the token is EXPECTED to carry (e.g.
	 * `"Zone Settings Write"`, `"DNS Write"`). Advisory only: see the limitation
	 * note on {@link assertCloudflareTokenScopes}. When provided, they are echoed
	 * back as a reminder to confirm manually — they are NOT enforced.
	 */
	requiredPermissionGroups?: string[];
}

/**
 * Asserts that a Cloudflare API token is valid and active before a Pulumi run
 * relies on it.
 *
 * Calls Cloudflare's token self-verify endpoint (`GET /user/tokens/verify`)
 * through the shared resilient transport and throws when the token is missing,
 * rejected (401/403), or in any non-`active` state. This session, a DNS-only
 * token silently lacked `Zone Settings:Edit`, so an SSL-mode change 403'd
 * mid-`up` — verifying the token up front turns a mid-apply 403 into a
 * plan-time error.
 *
 * LIMITATION — validity, not scope. The verify endpoint confirms a token is
 * valid and active but does NOT enumerate its per-permission-group grants
 * (Cloudflare returns only `{ id, status }`; reading the grants needs the
 * token's id and a separate account-scoped `GET /user/tokens/{id}` call). This
 * check therefore verifies active-status only. `requiredPermissionGroups`, when
 * supplied, is echoed as a manual-confirmation reminder rather than enforced —
 * it deliberately does not claim to verify a scope it cannot. A future
 * follow-up could probe a specific setting write (e.g. attempt a no-op
 * `Zone Settings` PATCH) to prove a concrete permission.
 *
 * Opt-in — call it near the top of a Pulumi program; it is not invoked
 * automatically by any deploy path.
 *
 * @param options Token value and (advisory) expected permission groups.
 * @throws {Error} When the token is empty, rejected (401/403), returns an
 *   unexpected status, or is not `active`.
 * @example
 * ```typescript
 * import { assertCloudflareTokenScopes } from "@infracraft/pulumi/preflight";
 *
 * await assertCloudflareTokenScopes({
 *   token: process.env.CLOUDFLARE_API_TOKEN ?? "",
 *   requiredPermissionGroups: ["Zone Settings Write", "DNS Write"],
 * });
 * ```
 */
export async function assertCloudflareTokenScopes(
	options: CloudflareTokenScopesOptions,
): Promise<void> {
	const { token, requiredPermissionGroups } = options;

	if (token.trim() === "") {
		throw new Error(
			"Cloudflare token preflight: the provided token is empty — pass the token's secret value (resolve it from its env var before calling).",
		);
	}

	const response = await resilientFetch(VERIFY_URL, {
		method: "GET",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
		},
	});

	if (response.status === 401 || response.status === 403) {
		throw new Error(
			`Cloudflare token preflight: verification returned HTTP ${response.status} — the token is invalid, revoked, or lacks access to the verify endpoint. Mint a new token at ${TOKEN_DASHBOARD_URL} and retry.`,
		);
	}

	if (!response.ok) {
		const body = await response.text();

		throw new Error(
			`Cloudflare token preflight: unexpected HTTP ${response.status} from the verify endpoint: ${body}`,
		);
	}

	const payload = (await response.json()) as CloudflareVerifyResponse;
	const status = payload.result?.status;

	if (!payload.success || status !== "active") {
		const reason = status ? `status "${status}"` : "no result returned";

		throw new Error(
			`Cloudflare token preflight: token is not active (${reason}). A disabled or expired token cannot apply changes — rotate it at ${TOKEN_DASHBOARD_URL}.`,
		);
	}

	if (requiredPermissionGroups && requiredPermissionGroups.length > 0) {
		console.warn(
			`[infracraft] Cloudflare token is valid and active, but its per-permission-group grants (${requiredPermissionGroups.join(", ")}) could NOT be verified: the token-verify endpoint returns only validity/status, not scopes. Confirm the token carries these permissions at ${TOKEN_DASHBOARD_URL}.`,
		);
	}
}
