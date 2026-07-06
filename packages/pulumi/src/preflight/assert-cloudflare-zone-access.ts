import { resilientFetch } from "../http/resilient-fetch";

/** Cloudflare's zone-read endpoint, scoped to the single zone being verified. */
function zoneUrl(zoneId: string): string {
	return `https://api.cloudflare.com/client/v4/zones/${zoneId}`;
}

/** Where to mint a token or adjust its zone scope. */
const TOKEN_DASHBOARD_URL = "https://dash.cloudflare.com/profile/api-tokens";

/** Options for {@link assertCloudflareZoneAccess}. */
export interface CloudflareZoneAccessOptions {
	/**
	 * The Cloudflare API token to verify — its secret VALUE, not the name of the
	 * env var holding it. Resolve the env var before calling.
	 */
	token: string;

	/** The zone ID the program is about to mutate DNS records/settings on. */
	zoneId: string;
}

/**
 * Asserts that a Cloudflare API token can read the target zone before a
 * Pulumi run relies on it to mutate DNS records or zone settings within it.
 *
 * Calls `GET /zones/{zone_id}` — NOT the token self-verify endpoint
 * (`/user/tokens/verify`) — through the shared resilient transport.
 *
 * WHY NOT `/user/tokens/verify`: that endpoint only accepts USER-owned
 * tokens. An ACCOUNT-owned token (the kind minted for a scoped
 * automation/service) gets a 401 there even when perfectly valid — proven
 * live 2026-07-06: the same token returned 200 on `GET /zones/{zone_id}` and
 * 401 on `/user/tokens/verify`. The prior version of this preflight used the
 * verify endpoint and false-failed on exactly this token shape.
 *
 * A zone read is also the more relevant probe regardless of token ownership:
 * it proves the token can reach the SPECIFIC zone this program is about to
 * mutate, not merely that the token is valid somewhere on the account.
 *
 * LIMITATION — read access, not the mutation this program needs. A
 * successful zone read proves `Zone:Read` but does NOT prove `Zone
 * Settings:Edit` or `DNS:Edit` — Cloudflare has no read-only endpoint that
 * exercises those without performing a real mutation. A token scoped to
 * read-only access could still 403 mid-`up` on an actual DNS/settings write;
 * this check narrows that failure mode, it does not eliminate it.
 *
 * Opt-in — call it near the top of a Pulumi program; it is not invoked
 * automatically by any deploy path.
 *
 * @param options Token value and the target zone ID.
 * @throws {Error} When the token is empty, or the zone read returns
 *   401 (invalid token), 403 (token lacks access to this zone), 404 (zone
 *   not found or not visible to the token), or any other non-2xx status.
 * @example
 * ```typescript
 * import { assertCloudflareZoneAccess } from "@infracraft/pulumi/preflight";
 *
 * await assertCloudflareZoneAccess({
 *   token: process.env.CLOUDFLARE_API_TOKEN ?? "",
 *   zoneId: "023e105f4ecef8ad9ca31a8372d0c353",
 * });
 * ```
 */
export async function assertCloudflareZoneAccess(
	options: CloudflareZoneAccessOptions,
): Promise<void> {
	const { token, zoneId } = options;

	if (token.trim() === "") {
		throw new Error(
			"Cloudflare zone-access preflight: the provided token is empty — pass the token's secret value (resolve it from its env var before calling).",
		);
	}

	const response = await resilientFetch(zoneUrl(zoneId), {
		method: "GET",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
		},
	});

	if (response.ok) {
		return;
	}

	if (response.status === 401) {
		throw new Error(
			`Cloudflare zone-access preflight: verification returned HTTP 401 — the token is invalid or revoked. Mint a new token at ${TOKEN_DASHBOARD_URL} and retry.`,
		);
	}

	if (response.status === 403) {
		throw new Error(
			`Cloudflare zone-access preflight: verification returned HTTP 403 — the token is valid but lacks read access to zone "${zoneId}". Grant it that zone in its scope at ${TOKEN_DASHBOARD_URL} and retry.`,
		);
	}

	if (response.status === 404) {
		throw new Error(
			`Cloudflare zone-access preflight: verification returned HTTP 404 — zone "${zoneId}" does not exist, or the token cannot see it. Confirm the zone ID and the token's zone scope at ${TOKEN_DASHBOARD_URL} and retry.`,
		);
	}

	const body = await response.text();

	throw new Error(
		`Cloudflare zone-access preflight: unexpected HTTP ${response.status} from the zone-read endpoint: ${body}`,
	);
}
